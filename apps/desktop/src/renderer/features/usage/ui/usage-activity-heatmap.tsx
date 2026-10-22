/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { EmptyState, Skeleton, Tooltip, VisuallyHidden } from '@astryxdesign/core';
import { resolveUsageHeatmapRange } from '@maka/core/settings';
import { uiLocaleToIntlLocale } from '@maka/core/ui-locale';
import { Banner, Button, useUiLocale } from '@maka/ui';
import type { UsageHeatmapState } from '../services-context.js';
import { getUsageSettingsCopy } from '../../../locales/settings-usage-copy.js';
import {
  buildUsageActivityWeeks,
  mondayIndex,
  usageActivityFocusIndex,
  usageActivityLevel,
  usageActivityThresholds,
} from './usage-activity-model.js';

export function UsageActivityHeatmap({ state, onRefresh, refreshing }: {
  state: UsageHeatmapState;
  onRefresh?(): void;
  refreshing?: boolean;
}) {
  const heatmap = state.status === 'ready' ? state.value : null;
  const locale = useUiLocale();
  const copy = getUsageSettingsCopy(locale).heatmap;
  const [focusedStart, setFocusedStart] = useState<number | null>(null);
  const [loadingWeekCount] = useState(() => {
    const range = resolveUsageHeatmapRange(Date.now());
    return Math.ceil((range.dayStarts.length + mondayIndex(range.dayStarts[0]!)) / 7);
  });
  const chartRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const helpId = useId();
  const weeks = useMemo(() => buildUsageActivityWeeks(heatmap?.days ?? []), [heatmap]);
  const thresholds = useMemo(() => usageActivityThresholds(heatmap?.days ?? []), [heatmap]);
  const formatters = useMemo(() => {
    const intlLocale = uiLocaleToIntlLocale(locale);
    return {
      date: new Intl.DateTimeFormat(intlLocale, { year: 'numeric', month: 'short', day: 'numeric' }),
      month: new Intl.DateTimeFormat(intlLocale, { month: 'short' }),
      number: new Intl.NumberFormat(intlLocale),
    };
  }, [locale]);
  const items = heatmap?.days ?? [];
  const savedFocusIndex = items.findIndex((item) => item.start === focusedStart);
  const focusIndex = savedFocusIndex < 0 ? items.length - 1 : savedFocusIndex;
  const weekCount = weeks.length || loadingWeekCount;
  const chartStyle = { '--usage-activity-weeks': weekCount } as CSSProperties;
  const firstDay = heatmap?.days[0];
  const lastDay = heatmap?.days.at(-1);
  const period = firstDay && lastDay
    ? formatters.date.formatRange(firstDay.start, lastDay.start)
    : null;
  const months = weeks.flatMap((week, index) => {
    const monthStart = week.days.find((day) => new Date(day.start).getDate() === 1);
    if (!monthStart && index !== 0) return [];
    return [{ column: index, start: monthStart?.start ?? week.start }];
  }).filter((month, index, all) => {
    // A very short fragment at the left edge must not collide with the next label.
    return index !== 0 || !all[1] || all[1].column - month.column >= 3;
  });

  function moveFocus(event: KeyboardEvent<HTMLElement>, index: number) {
    const next = usageActivityFocusIndex(event.key, index, items.length);
    if (next === null) return;
    event.preventDefault();
    chartRef.current?.querySelector<HTMLElement>(`[data-activity-index="${next}"]`)?.focus();
  }

  function detail(start: number, tokens: number, successfulRequests: number) {
    const date = formatters.date.format(start);
    const tokenValue = formatters.number.format(tokens);
    const requestValue = formatters.number.format(successfulRequests);
    return {
      label: `${date}; ${copy.tokens}: ${tokenValue}; ${copy.requests}: ${requestValue}`,
      content: (
        <div className="settingsUsageActivityTooltip">
          <div>{date}</div>
          <dl className="settingsUsageTokenTooltip">
            <div><dt>{copy.tokens}</dt><dd>{tokenValue}</dd></div>
            <div><dt>{copy.requests}</dt><dd>{requestValue}</dd></div>
          </dl>
        </div>
      ),
    };
  }

  return (
    <section className="settingsUsageActivity" aria-labelledby={headingId}>
      <div className="settingsUsageActivityHeading">
          <h3 id={headingId}>{copy.title}</h3>
          {period ? (
            <Tooltip content={period} hasHoverIndication={false}>
              <span className="settingsUsageActivityPeriod">{copy.period}</span>
            </Tooltip>
          ) : <span className="settingsUsageActivityPeriod">{copy.period}</span>}
      </div>
      <VisuallyHidden id={helpId}>{copy.keyboardHelp}</VisuallyHidden>
      <div className="settingsUsageActivityScroll">
        {state.status === 'error' || state.status === 'stale' ? (
          <Banner
            status={state.status === 'stale' ? 'info' : 'warning'}
            role="status"
            title={state.status === 'stale' ? copy.stale : copy.loadFailed}
            description={state.status === 'error' && state.message ? state.message : copy.refreshHelp}
            endContent={onRefresh ? <Button variant="secondary" size="sm" label={getUsageSettingsCopy(locale).refreshAria} onClick={onRefresh} isLoading={refreshing} /> : undefined}
          />
        ) : !heatmap ? (
          <div className="settingsUsageActivityCanvas" style={chartStyle} role="status" aria-label={copy.loading}>
            <div className="settingsUsageActivityGrid" aria-hidden="true">
              {Array.from({ length: loadingWeekCount }, (_, column) => (
                <div className="settingsUsageActivityWeek" key={column}>
                  {Array.from({ length: 7 }, (_, row) => (
                    <span className="settingsUsageActivityCell" key={row}><Skeleton radius="rounded" /></span>
                  ))}
                </div>
              ))}
            </div>
            <div className="settingsUsageActivityMonths" aria-hidden="true"><span style={{gridColumn: '1 / -1'}}>{copy.loading}</span></div>
          </div>
        ) : weeks.length === 0 ? <EmptyState title={copy.unavailable} isCompact /> : (
          <div className="settingsUsageActivityCanvas" style={chartStyle}>
            <div className="settingsUsageActivityGrid" role="group" aria-label={`${copy.tokens} · ${copy.daily} · ${period}`} aria-describedby={helpId} ref={chartRef}>
              {weeks.map((week, weekIndex) => {
                return (
                  <div className="settingsUsageActivityWeek" key={`days-${week.start}`}>
                    {Array.from({ length: 7 }, (_, row) => {
                      const day = week.days.find((item) => mondayIndex(item.start) === row);
                      if (!day) return <span className="settingsUsageActivityCell" aria-hidden="true" key={`padding-${row}`} />;
                      const index = weekIndex * 7 + row - mondayIndex(firstDay!.start);
                      const tooltip = detail(day.start, day.tokens, day.successfulRequests);
                      return (
                        <Tooltip key={`day-${day.start}`} content={tooltip.content} placement="below" focusTrigger="always" touchTrigger="tap" hasHoverIndication={false}>
                          <span className="settingsUsageActivityCell settingsUsageActivityPoint" role="img" aria-label={tooltip.label}
                            data-level={usageActivityLevel(day.tokens, thresholds)} data-activity-index={index}
                            tabIndex={index === focusIndex ? 0 : -1} onFocus={() => setFocusedStart(day.start)}
                            onKeyDown={(event) => moveFocus(event, index)} />
                        </Tooltip>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <div className="settingsUsageActivityMonths" aria-hidden="true">
              {months.map((month, index) => (
                <span key={month.start} style={{ gridColumn: `${month.column + 1} / ${months[index + 1] ? months[index + 1]!.column + 1 : -1}` }}>
                  {formatters.month.format(month.start)}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="settingsUsageActivityFooter">
        <div className="settingsUsageActivityLegend">
            <span>{copy.less}</span>
            {[0, 1, 2, 3, 4].map((level) => <span className="settingsUsageActivityCell" data-level={level} aria-hidden="true" key={level} />)}
            <span>{copy.more}</span>
        </div>
      </div>
      {heatmap?.hasIncompleteUsage ? <p className="settingsUsageActivityNotice">{copy.incomplete}</p> : null}
    </section>
  );
}
