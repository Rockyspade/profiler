/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow

import * as React from 'react';
import memoize from 'memoize-immutable';
import { Localized } from '@fluent/react';

import explicitConnect from 'firefox-profiler/utils/connect';
import { assertExhaustiveCheck } from 'firefox-profiler/utils/flow';
import {
  selectedThreadSelectors,
  selectedNodeSelectors,
} from 'firefox-profiler/selectors/per-thread';
import { getSelectedThreadsKey } from 'firefox-profiler/selectors/url-state';
import { toggleOpenCategoryInSidebar } from 'firefox-profiler/actions/app';
import { getSidebarOpenCategories } from 'firefox-profiler/selectors/app';
import { getCategories } from 'firefox-profiler/selectors/profile';
import { getFunctionName } from 'firefox-profiler/profile-logic/function-info';
import {
  getFriendlyStackTypeName,
  shouldDisplaySubcategoryInfoForCategory,
} from 'firefox-profiler/profile-logic/profile-data';
import { CanSelectContent } from './CanSelectContent';

import type { ConnectedProps } from 'firefox-profiler/utils/connect';
import type {
  ThreadsKey,
  CategoryList,
  IndexIntoCallNodeTable,
  SelfAndTotal,
  Milliseconds,
  WeightType,
  IndexIntoCategoryList,
} from 'firefox-profiler/types';

import type {
  BreakdownByImplementation,
  BreakdownByCategory,
  StackImplementation,
  TimingsForPath,
} from 'firefox-profiler/profile-logic/profile-data';
import {
  formatMilliseconds,
  formatPercent,
  formatBytes,
  formatNumber,
  ratioToCssPercent,
} from 'firefox-profiler/utils/format-numbers';
import classNames from 'classnames';

type SidebarDetailProps = {|
  +label: React.Node,
  +color?: string,
  +indent?: boolean,
  +value: React.Node,
  +percentage?: string | number,
|};

function SidebarDetail({
  label,
  value,
  percentage,
  indent,
}: SidebarDetailProps) {
  return (
    <React.Fragment>
      <div
        className={classNames({
          'sidebar-label': true,
          'sidebar-label-indent': indent,
        })}
      >
        {label}
      </div>
      <div className="sidebar-percentage">{percentage}</div>
      <div className="sidebar-value">{value}</div>
    </React.Fragment>
  );
}

type ImplementationBreakdownProps = {|
  +breakdown: BreakdownByImplementation,
  +number: (number) => string,
|};

// This component is responsible for displaying the breakdown data specific to
// the JavaScript engine and native code implementation.
class ImplementationBreakdown extends React.PureComponent<ImplementationBreakdownProps> {
  _orderedImplementations: $ReadOnlyArray<StackImplementation> = [
    'native',
    'interpreter',
    'blinterp',
    'baseline',
    'ion',
    'unknown',
  ];

  render() {
    const { breakdown, number } = this.props;

    const data: Array<{| +group: string, +value: Milliseconds | number |}> = [];

    for (const implementation of this._orderedImplementations) {
      const value = breakdown[implementation];
      if (!value && implementation === 'unknown') {
        continue;
      }

      data.push({
        group: getFriendlyStackTypeName(implementation),
        value: value || 0,
      });
    }

    const totalTime = data.reduce<number>(
      (result, item) => result + item.value,
      0
    );

    return data
      .filter(({ value }) => value)
      .map(({ group, value }) => {
        return (
          <React.Fragment key={group}>
            <SidebarDetail
              label={group}
              value={number(value)}
              percentage={formatPercent(value / totalTime)}
            />
            {/* Draw a histogram bar. */}
            <div className="sidebar-histogram-bar">
              <div
                className="sidebar-histogram-bar-color"
                style={{
                  width: ratioToCssPercent(value / totalTime),
                  backgroundColor: 'var(--grey-50)',
                }}
              ></div>
            </div>
          </React.Fragment>
        );
      });
  }
}

type CategoryBreakdownOwnProps = {|
  /** for total or self breakdown */
  +kind: 'total' | 'self',
  +breakdown: BreakdownByCategory,
  +categoryList: CategoryList,
  +number: (number) => string,
|};

type CategoryBreakdownStateProps = {|
  +sidebarOpenCategories: Map<string, Set<IndexIntoCategoryList>>,
|};

type CategoryBreakdownDispatchProps = {|
  +toggleOpenCategoryInSidebar: typeof toggleOpenCategoryInSidebar,
|};

type CategoryBreakdownAllProps = ConnectedProps<
  CategoryBreakdownOwnProps,
  CategoryBreakdownStateProps,
  CategoryBreakdownDispatchProps,
>;

class CategoryBreakdownImpl extends React.PureComponent<CategoryBreakdownAllProps> {
  _toggleCategory = (event: SyntheticInputEvent<>) => {
    const { toggleOpenCategoryInSidebar, kind } = this.props;
    const { categoryIndex } = event.target.dataset;
    toggleOpenCategoryInSidebar(kind, parseInt(categoryIndex, 10));
  };

  render() {
    const { breakdown, categoryList, number, sidebarOpenCategories, kind } =
      this.props;

    const data = breakdown
      .map((oneCategoryBreakdown, categoryIndex) => {
        const category = categoryList[categoryIndex];
        return {
          categoryIndex,
          category,
          value: oneCategoryBreakdown.entireCategoryValue || 0,
          subcategories: category.subcategories
            .map((subcategoryName, subcategoryIndex) => ({
              index: subcategoryIndex,
              name: subcategoryName,
              value:
                oneCategoryBreakdown.subcategoryBreakdown[subcategoryIndex],
            }))
            // sort subcategories in descending order
            .sort(({ value: valueA }, { value: valueB }) => valueB - valueA)
            .filter(({ value }) => value),
        };
      })
      // sort categories in descending order
      .sort(({ value: valueA }, { value: valueB }) => valueB - valueA)
      .filter(({ value }) => value);

    // Values can be negative for diffing tracks, that's why we use the absolute
    // value to compute the total time. Indeed even if all values average out,
    // we want to display a sensible percentage.
    const totalTime = data.reduce(
      (accum, { value }) => accum + Math.abs(value),
      0
    );

    return (
      <>
        {data.map(({ category, value, subcategories, categoryIndex }) => {
          const hasSubcategory =
            shouldDisplaySubcategoryInfoForCategory(category);
          const openCats = sidebarOpenCategories.get(kind);
          const expanded =
            openCats !== undefined && openCats.has(categoryIndex);
          return (
            <React.Fragment key={`category-${categoryIndex}`}>
              <SidebarDetail
                label={
                  hasSubcategory ? (
                    <button
                      type="button"
                      data-category-index={categoryIndex}
                      onClick={this._toggleCategory}
                      className={classNames({
                        'sidebar-toggle': true,
                        expanded,
                      })}
                    >
                      {category.name}
                    </button>
                  ) : (
                    category.name
                  )
                }
                value={number(value)}
                percentage={formatPercent(value / totalTime)}
              />

              {/* Draw a histogram bar, colored by the category. */}
              <div className="sidebar-histogram-bar">
                <div
                  className={`sidebar-histogram-bar-color category-color-${category.color}`}
                  style={{ width: ratioToCssPercent(value / totalTime) }}
                ></div>
              </div>

              {hasSubcategory && expanded
                ? subcategories.map(({ index, name, value }) => (
                    <SidebarDetail
                      key={`subcategory-${index}`}
                      label={name}
                      value={number(value)}
                      percentage={formatPercent(value / totalTime)}
                      indent={true}
                    />
                  ))
                : null}
            </React.Fragment>
          );
        })}
      </>
    );
  }
}

export const CategoryBreakdown = explicitConnect<
  CategoryBreakdownOwnProps,
  CategoryBreakdownStateProps,
  CategoryBreakdownDispatchProps,
>({
  mapStateToProps: (state) => {
    return {
      sidebarOpenCategories: getSidebarOpenCategories(state),
    };
  },
  mapDispatchToProps: { toggleOpenCategoryInSidebar },
  component: CategoryBreakdownImpl,
});

type StateProps = {|
  +selectedNodeIndex: IndexIntoCallNodeTable | null,
  +selectedThreadsKey: ThreadsKey,
  +name: string,
  +lib: string,
  +timings: TimingsForPath,
  +categoryList: CategoryList,
  +weightType: WeightType,
  +selectedNodeTracedSelfAndTotal: SelfAndTotal | null,
|};

type Props = ConnectedProps<{||}, StateProps, {||}>;

type WeightDetails = {|
  +runningL10nId: string,
  +selfL10nId: string,
  +number: (n: number) => string,
|};

function getWeightTypeLabel(weightType: WeightType): string {
  switch (weightType) {
    case 'tracing-ms':
      return `milliseconds`;
    case 'samples':
      return 'sample count';
    case 'bytes':
      return 'bytes';
    default:
      throw assertExhaustiveCheck(weightType, 'Unhandled WeightType.');
  }
}

class CallTreeSidebarImpl extends React.PureComponent<Props> {
  _getWeightTypeDetails = memoize(
    (weightType: WeightType): WeightDetails => {
      switch (weightType) {
        case 'tracing-ms':
          return {
            runningL10nId: 'CallTreeSidebar--running-time',
            selfL10nId: 'CallTreeSidebar--self-time',
            number: (n) => formatMilliseconds(n, 3, 1),
          };
        case 'samples':
          return {
            runningL10nId: 'CallTreeSidebar--running-samples',
            selfL10nId: 'CallTreeSidebar--self-samples',
            number: (n) => formatNumber(n, 0),
          };
        case 'bytes':
          return {
            runningL10nId: 'CallTreeSidebar--running-size',
            selfL10nId: 'CallTreeSidebar--self-size',
            number: (n) => formatBytes(n),
          };
        default:
          throw assertExhaustiveCheck(weightType, 'Unhandled WeightType.');
      }
    },
    { cache: new Map() }
  );

  render() {
    const {
      selectedNodeIndex,
      name,
      lib,
      timings,
      categoryList,
      weightType,
      selectedNodeTracedSelfAndTotal,
    } = this.props;
    const {
      forPath: { selfTime, totalTime },
      rootTime,
    } = timings;

    if (selectedNodeIndex === null) {
      return (
        <div className="sidebar sidebar-calltree">
          <Localized id="CallTreeSidebar--select-a-node">
            <div className="sidebar-contents-wrapper">
              Select a node to display some information about it.
            </div>
          </Localized>
        </div>
      );
    }

    const { number, runningL10nId, selfL10nId } =
      this._getWeightTypeDetails(weightType);

    const totalTimePercent = Math.round((totalTime.value / rootTime) * 100);
    const selfTimePercent = Math.round((selfTime.value / rootTime) * 100);
    const totalTimeBreakdownByCategory = totalTime.breakdownByCategory;
    const selfTimeBreakdownByCategory = selfTime.breakdownByCategory;
    const totalTimeBreakdownByImplementation =
      totalTime.breakdownByImplementation;
    const selfTimeBreakdownByImplementation =
      selfTime.breakdownByImplementation;

    return (
      <aside className="sidebar sidebar-calltree">
        <div className="sidebar-contents-wrapper">
          <header className="sidebar-titlegroup">
            <CanSelectContent
              tagName="h2"
              className="sidebar-title"
              content={name}
            />
            {lib ? (
              <CanSelectContent
                tagName="p"
                className="sidebar-subtitle"
                content={lib}
              />
            ) : null}
          </header>
          <h4 className="sidebar-title3">
            <Localized id="CallTreeSidebar--call-node-details">
              <div>Call node details</div>
            </Localized>
          </h4>
          {selectedNodeTracedSelfAndTotal ? (
            <Localized
              id="CallTreeSidebar--traced-running-time"
              attrs={{ label: true }}
            >
              <SidebarDetail
                label="Traced running time"
                value={formatMilliseconds(
                  selectedNodeTracedSelfAndTotal.total,
                  3,
                  1
                )}
              ></SidebarDetail>
            </Localized>
          ) : null}
          {selectedNodeTracedSelfAndTotal ? (
            <Localized
              id="CallTreeSidebar--traced-self-time"
              attrs={{ label: true }}
            >
              <SidebarDetail
                label="Traced self time"
                value={
                  selectedNodeTracedSelfAndTotal.self === 0
                    ? '—'
                    : formatMilliseconds(
                        selectedNodeTracedSelfAndTotal.self,
                        3,
                        1
                      )
                }
              />
            </Localized>
          ) : null}
          <Localized id={runningL10nId} attrs={{ label: true }}>
            <SidebarDetail
              // The value for the label following will be replaced
              label=""
              value={totalTime.value ? `${number(totalTime.value)}` : '—'}
              percentage={totalTimePercent ? totalTimePercent + '%' : '—'}
            />
          </Localized>
          <Localized id={selfL10nId} attrs={{ label: true }}>
            <SidebarDetail
              // The value for the label following will be replaced
              label=""
              value={selfTime.value ? `${number(selfTime.value)}` : '—'}
              percentage={selfTimePercent ? selfTimePercent + '%' : '—'}
            />
          </Localized>
          {totalTimeBreakdownByCategory ? (
            <>
              <h4 className="sidebar-title3 sidebar-title-label">
                <div className="sidebar-title-label-left">Categories</div>
                <div className="sidebar-title-label-right">
                  Running {getWeightTypeLabel(weightType)}
                </div>
              </h4>
              <CategoryBreakdown
                kind="total"
                breakdown={totalTimeBreakdownByCategory}
                categoryList={categoryList}
                number={number}
              />
            </>
          ) : null}
          {selfTimeBreakdownByCategory ? (
            <>
              <h4 className="sidebar-title3 sidebar-title-label">
                <div className="sidebar-title-label-left">Categories</div>
                <div className="sidebar-title-label-right">
                  Self {getWeightTypeLabel(weightType)}
                </div>
              </h4>
              <CategoryBreakdown
                kind="self"
                breakdown={selfTimeBreakdownByCategory}
                categoryList={categoryList}
                number={number}
              />
            </>
          ) : null}
          {totalTimeBreakdownByImplementation && totalTime.value ? (
            <React.Fragment>
              <h4 className="sidebar-title3 sidebar-title-label">
                <div>Implementation</div>
                <div>Running {getWeightTypeLabel(weightType)}</div>
              </h4>
              <ImplementationBreakdown
                breakdown={totalTimeBreakdownByImplementation}
                number={number}
              />
            </React.Fragment>
          ) : null}
          {selfTimeBreakdownByImplementation && selfTime.value ? (
            <React.Fragment>
              <h4 className="sidebar-title3 sidebar-title-label">
                <div>Implementation</div>
                <div>Self {getWeightTypeLabel(weightType)}</div>
              </h4>
              <ImplementationBreakdown
                breakdown={selfTimeBreakdownByImplementation}
                number={number}
              />
            </React.Fragment>
          ) : null}
        </div>
      </aside>
    );
  }
}

export const CallTreeSidebar = explicitConnect<{||}, StateProps, {||}>({
  mapStateToProps: (state) => ({
    selectedNodeIndex: selectedThreadSelectors.getSelectedCallNodeIndex(state),
    selectedThreadsKey: getSelectedThreadsKey(state),
    name: getFunctionName(selectedNodeSelectors.getName(state)),
    lib: selectedNodeSelectors.getLib(state),
    timings: selectedNodeSelectors.getTimingsForSidebar(state),
    categoryList: getCategories(state),
    weightType: selectedThreadSelectors.getWeightTypeForCallTree(state),
    selectedNodeTracedSelfAndTotal:
      selectedThreadSelectors.getTracedSelfAndTotalForSelectedCallNode(state),
  }),
  component: CallTreeSidebarImpl,
});
