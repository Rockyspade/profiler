/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// @flow

import { resourceTypes } from './data-structures';
import { SymbolsNotFoundError } from './errors';

import type {
  Profile,
  Thread,
  ThreadIndex,
  Lib,
  IndexIntoFuncTable,
  IndexIntoStringTable,
} from '../types/profile';
import type { MemoryOffset } from '../types/units';
import type {
  AbstractSymbolStore,
  AddressResult,
  LibSymbolicationRequest,
} from './symbol-store';

// Contains functions to symbolicate a profile.

/**
 * Symbolication Overview
 *
 * Symbolication is the process of looking up function names for native code and
 * assigning those function names to the functions in the profile.
 *
 * When the profiler samples call stacks for native code, it only collects
 * addresses: the address of the instruction which is currently being executed,
 * and the "return addresses" for its callers on the stack, i.e. the addresses
 * of the instructions that will be executed after each function returns.
 * To obtain a profile with function names, these addresses need to be
 * translated into library-relative offsets, looked up per library, and then
 * substituted with the corresponding function name strings in the profile.
 *
 * The actual lookup of symbols is not handled in this file; it is delegated to
 * an AbstractSymbolStore interface.
 *
 * The functions in this file perform the following tasks:
 *  - assigning addresses to their containing libraries so that they can be
 *    translated into library-relative offsets
 *  - gathering all addresses in the profile which require symbolication,
 *    grouped by library, and requesting symbols from the symbol store
 *  - once the results from the symbol store come in, performing the
 *    substutitions in the profile.
 *
 * Implementation details
 *
 * The implementation has the following constraints:
 *  - Symbolication needs to be asynchronous, and the profile needs to be fully
 *    interactive before symbols have arrived. This means that there needs to
 *    be an intact funcTable from the very start, because the call nodes for
 *    the call tree are based on funcs.
 *  - When the symbols arrive, we cannot mutate the profile in-place. Instead,
 *    we need to delegate the profile mutation to our caller so that it can go
 *    through redux actions and reducers; the profile is part of the redux state
 *    so any profile adjustment needs to follow proper procedure. This allows
 *    all derived data and UI that depends on profile contents to be notified
 *    and updated in the regular ways.
 *    It also allows multiple steps of symbolication to happen in one redux
 *    store update, which saves re-renders if symbol results for many small
 *    libraries arrive at nearly the same time.
 *  - When symbols arrive, the user shouldn't "lose their place" in the call
 *    tree UI; concretely this means that the selected call node and the set of
 *    expanded call nodes should survive symbolication-triggered adjustments of
 *    the funcTable as much as possible. More specifically, if all frames that
 *    used to be assigned to function A get reassigned to function B, we want to
 *    create an A -> B entry in an oldFuncToNewFuncMap that gets dispatched in
 *    a redux action so that the appropriate parts of the redux state can react.
 *  - Multiple processes and threads in the profile will require symbols from
 *    the same set of native libraries, and the number and size of the
 *    symbolication requests for each library should be minimized. This means
 *    that we want to gather all needed addresses across the entire profile
 *    first, rather than requesting symbols separately for each thread.
 *
 * Symbolication happens in a number of phases.
 *
 * I. Preparation during profile processing: When native code addresses initially
 * arrive in the Firefox profiler, they come in the form of hex strings in the
 * frame table of the Gecko profile. Profile processing then does the following:
 *  - It detects frames of native code based on the hex string format.
 *  - It looks up the containing library for each address.
 *  - For each native frame, it creates one funcTable entry. It can't really do
 *    any better at this point because it would need to have the symbols in
 *    order to create only one func per actual function. So, to repeat, the
 *    initial funcTable has one func per native frame.
 *  - The frame and its func both get their address field set to the
 *    library-relative offset.
 *  - The func's resource field is set to a resource of type "library" that
 *    points to the lib object in the thread's "libs" list that contained this
 *    address. The frame's and func's address fields are relative to that lib.
 *
 * II. Address gathering per library: This step goes through all threads and
 * gathers up addresses per library that need to be symbolicated. It also keeps
 * around enough per-thread information so that the per-thread substitution step
 * at the end can perform its work efficiently.
 *
 * III. Symbol lookup: Handled by the AbstractSymbolStore.
 *
 * IV. Symbol result processing: Does enough processing of the result to create
 * the oldFuncToNewFuncMap, and prepares data for the final substitution step.
 *
 * V. Profile substitution: Invoked from the redux reducer. Creates a new thread
 * object with an updated frameTable, funcTable and stringTable, with the
 * symbols substituted in the right places. This usually causes many funcs to
 * be orphaned (no frames will use them any more); these orphaned funcs remain
 * in the funcTable.
 */

export type SymbolicationStepInfo = {|
  funcToFuncAddressMap: Map<IndexIntoFuncTable, number>,
  funcAddressToSymbolMap: Map<number, string>,
  funcAddressToCanonicalFuncIndexMap: Map<number, IndexIntoFuncTable>,
|};

export type SymbolicationHandlers = {
  onSymbolicationStep: (
    threadIndex: ThreadIndex,
    oldFuncToNewFuncMap: Map<IndexIntoFuncTable, IndexIntoFuncTable>,
    symbolicationStepInfo: SymbolicationStepInfo
  ) => void,
};

type LibKey = string; // of the form ${debugName}/${breakpadId}
type Address = number;
type ThreadSymbolicationInfo = Map<LibKey, Map<Address, IndexIntoFuncTable>>;

/**
 * Return the library object that contains the address such that
 * rv.start <= address < rv.end, or null if no such lib object exists.
 * The libs array needs to be sorted in ascending address order, and the address
 * ranges of the libraries need to be non-overlapping.
 */
export function getContainingLibrary(
  libs: Lib[],
  address: MemoryOffset
): Lib | null {
  if (isNaN(address)) {
    return null;
  }

  let left = 0;
  let right = libs.length - 1;
  while (left <= right) {
    const mid = ((left + right) / 2) | 0;
    if (address >= libs[mid].end) {
      left = mid + 1;
    } else if (address < libs[mid].start) {
      right = mid - 1;
    } else {
      return libs[mid];
    }
  }
  return null;
}

/**
 * Find the functions in this thread's funcTable that we need symbols for. The map
 * that is returned is keyed off the Lib objects, and has a list of IndexIntoFuncTable
 * for the still unsymbolicated functions.
 */
function gatherFuncsInThread(thread: Thread): Map<Lib, IndexIntoFuncTable[]> {
  const { libs, funcTable, stringTable, resourceTable } = thread;
  const foundAddresses: Map<Lib, IndexIntoFuncTable[]> = new Map();
  for (let funcIndex = 0; funcIndex < funcTable.length; funcIndex++) {
    const resourceIndex = funcTable.resource[funcIndex];
    if (resourceIndex === -1) {
      continue;
    }
    const resourceType = resourceTable.type[resourceIndex];
    if (resourceType !== resourceTypes.library) {
      continue;
    }

    const name = stringTable.getString(funcTable.name[funcIndex]);
    if (!name.startsWith('0x')) {
      // Somebody already symbolicated this function for us.
      continue;
    }

    const libIndex = resourceTable.lib[resourceIndex];
    if (libIndex === null || libIndex === undefined || libIndex === -1) {
      throw new Error('libIndex must be a valid index.');
    }
    const lib = libs[libIndex];
    if (lib === undefined) {
      throw new Error('Did not find a lib.');
    }
    let libFuncs = foundAddresses.get(lib);
    if (libFuncs === undefined) {
      libFuncs = [];
      foundAddresses.set(lib, libFuncs);
    }
    libFuncs.push(funcIndex);
  }
  return foundAddresses;
}

// Gather the symbols needed in this thread into a nested map:
// libKey -> address relative to lib -> index of the func
function getThreadSymbolicationInfo(thread: Thread): ThreadSymbolicationInfo {
  const foundFuncMap = gatherFuncsInThread(thread);
  const { funcTable } = thread;
  const libKeyToAddressToFuncMap = new Map();
  for (const [lib, funcsToSymbolicate] of foundFuncMap) {
    const libKey = `${lib.debugName}/${lib.breakpadId}`;
    const addressToFuncMap = new Map();
    libKeyToAddressToFuncMap.set(libKey, addressToFuncMap);
    for (const funcIndex of funcsToSymbolicate) {
      const funcAddress = funcTable.address[funcIndex];
      addressToFuncMap.set(funcAddress, funcIndex);
    }
  }
  return libKeyToAddressToFuncMap;
}

// Go through all the threads to gather up the addresses we need to symbolicate
// for each library.
function buildLibSymbolicationRequestsForAllThreads(
  symbolicationInfo: ThreadSymbolicationInfo[]
): LibSymbolicationRequest[] {
  const libKeyToAddressesMap = new Map();
  for (const threadSymbolicationInfo of symbolicationInfo) {
    for (const [libKey, addressToFuncMap] of threadSymbolicationInfo) {
      let addressSet = libKeyToAddressesMap.get(libKey);
      if (addressSet === undefined) {
        addressSet = new Set();
        libKeyToAddressesMap.set(libKey, addressSet);
      }
      for (const funcAddress of addressToFuncMap.keys()) {
        addressSet.add(funcAddress);
      }
    }
  }
  return Array.from(libKeyToAddressesMap).map(([libKey, addresses]) => {
    const [debugName, breakpadId] = libKey.split('/');
    const lib = { debugName, breakpadId };
    return { lib, addresses };
  });
}

// With the symbolication results for the library given by libKey, call
// symbolicationHandlers.onSymbolicationStep for each thread. Those calls will
// ensure that the symbolication information eventually makes it into the thread.
// Most of the work in this function is just munging the data that we have into
// the shape that the onSymbolicationStep method expects.
function finishSymbolicationForLib(
  profile: Profile,
  symbolicationInfo: ThreadSymbolicationInfo[],
  resultsForLib: Map<number, AddressResult>,
  libKey: string,
  symbolicationHandlers: SymbolicationHandlers
): void {
  const { threads } = profile;
  for (let threadIndex = 0; threadIndex < threads.length; threadIndex++) {
    const threadSymbolicationInfo = symbolicationInfo[threadIndex];
    const addressToFuncIndexMap = threadSymbolicationInfo.get(libKey);
    if (addressToFuncIndexMap !== undefined) {
      const funcAddressToCanonicalFuncIndexMap = new Map();
      const funcAddressToSymbolMap = new Map();
      const funcToFuncAddressMap = new Map();
      const oldFuncToNewFuncMap = new Map();
      for (const [address, funcIndex] of addressToFuncIndexMap) {
        const addressResult = resultsForLib.get(address);
        if (addressResult !== undefined) {
          // |address| is the original address that we found during stackwalking,
          // as a library-relative offset.
          // |addressResult.functionOffset| is the offset between the start of
          // the function and |address|.
          // |funcAddress| is the start of the function (= the address of the symbol),
          // as a library-relative offset.
          const funcAddress = address - addressResult.functionOffset;

          funcToFuncAddressMap.set(funcIndex, funcAddress);
          funcAddressToSymbolMap.set(funcAddress, addressResult.name);

          const canonicalFuncIndexForThisFuncAddress = funcAddressToCanonicalFuncIndexMap.get(
            funcAddress
          );
          if (canonicalFuncIndexForThisFuncAddress === undefined) {
            funcAddressToCanonicalFuncIndexMap.set(funcAddress, funcIndex);
          } else {
            oldFuncToNewFuncMap.set(
              funcIndex,
              canonicalFuncIndexForThisFuncAddress
            );
          }
        }
      }
      symbolicationHandlers.onSymbolicationStep(
        threadIndex,
        oldFuncToNewFuncMap,
        {
          funcToFuncAddressMap,
          funcAddressToSymbolMap,
          funcAddressToCanonicalFuncIndexMap,
        }
      );
    }
  }
}

/**
 * Apply symbolication to the thread, based on the information that was prepared
 * in symbolicationStepInfo. This involves updating the func locations to the
 * symbol string, and updating the frameTable to assign frames to the right
 * funcs. When multiple frames are merged into one func, some funcs can become
 * orphaned; they remain in the funcTable.
 */
export function applySymbolicationStep(
  thread: Thread,
  symbolicationStepInfo: SymbolicationStepInfo
) {
  const {
    funcToFuncAddressMap,
    funcAddressToSymbolMap,
    funcAddressToCanonicalFuncIndexMap,
  } = symbolicationStepInfo;
  const {
    frameTable: oldFrameTable,
    funcTable: oldFuncTable,
    stringTable,
  } = thread;

  const frameTable = Object.assign({}, oldFrameTable, {
    func: (oldFrameTable.func.map(oldFrameFunc => {
      const funcAddressForFrame = funcToFuncAddressMap.get(oldFrameFunc);
      if (funcAddressForFrame !== undefined) {
        const newFuncIndexForFrame = funcAddressToCanonicalFuncIndexMap.get(
          funcAddressForFrame
        );
        if (newFuncIndexForFrame !== undefined) {
          return newFuncIndexForFrame;
        }
      }
      return oldFrameFunc;
    }): Array<IndexIntoFuncTable>),
  });

  const funcTable = Object.assign({}, oldFuncTable, {
    name: (oldFuncTable.name.slice(): Array<IndexIntoStringTable>),
  });
  for (const [funcAddress, symbol] of funcAddressToSymbolMap) {
    const funcIndex = funcAddressToCanonicalFuncIndexMap.get(funcAddress);
    if (funcIndex !== undefined) {
      funcTable.address[funcIndex] = funcAddress;
      funcTable.name[funcIndex] = stringTable.indexForString(symbol);
    }
  }

  return { ...thread, frameTable, funcTable, stringTable };
}

/**
 * Symbolicates the profile. Symbols are obtained from the symbolStore.
 * This function performs steps II-IV (see the comment at the beginning of
 * this file); step V is outsourced to symbolicationHandlers.onSymbolicationStep
 * which can call applySymbolicationStep to complete step V.
 */
export async function symbolicateProfile(
  profile: Profile,
  symbolStore: AbstractSymbolStore,
  symbolicationHandlers: SymbolicationHandlers
): Promise<void> {
  const symbolicationInfo = profile.threads.map(getThreadSymbolicationInfo);
  const libSymbolicationRequests = buildLibSymbolicationRequestsForAllThreads(
    symbolicationInfo
  );
  await symbolStore.getSymbols(
    libSymbolicationRequests,
    (request, results) => {
      const { debugName, breakpadId } = request.lib;
      const libKey = `${debugName}/${breakpadId}`;
      finishSymbolicationForLib(
        profile,
        symbolicationInfo,
        results,
        libKey,
        symbolicationHandlers
      );
    },
    (request, error) => {
      if (!(error instanceof SymbolsNotFoundError)) {
        // rethrow JavaScript programming error
        throw error;
      }
      // We could not find symbols for this library.
      console.warn(error);
    }
  );
}
