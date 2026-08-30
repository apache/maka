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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScheduledTask } from '@maka/core/scheduled-task';
import { uiLocaleToIntlLocale } from '@maka/core/ui-locale';
import {
  Button as UiButton,
  EmptyState,
  Heading,
  IconButton,
  List,
  ListItem,
  SegmentedControl,
  SegmentedControlItem,
  Spinner,
  StatusDot,
  Text,
} from '@astryxdesign/core';
import { getDailyReviewCopy } from './daily-review-copy.js';
import type { DailyReviewProjectionBridge } from './module-panel-types.js';
import type { ModuleHubHeader } from './module-hub-selector.js';
import { formatScheduledTaskRecurrence } from './scheduled-task-helpers.js';
import { useUiLocale } from './locale-context.js';
import { ChevronLeft, ChevronRight, ICON_SIZE, RefreshCcw, Sun } from './icons.js';
import { ModulePage } from './primitives/module-page.js';
import {
  dailyReviewRangeBounds,
  dailyReviewManualIntent,
  type DailyReviewRange,
  type DailyReviewViewState,
} from './daily-review-view-state.js';

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; value: DailyReviewViewState };

export function DailyReviewPanel(props: {
  bridge: DailyReviewProjectionBridge;
  revision?: number;
  task?: ScheduledTask;
  hubHeader?: ModuleHubHeader;
  canSetUp: boolean;
  onSetUp?(): void;
  onManageSchedule?(): void;
  onRunNow?(intentBody: string): Promise<void> | void;
  onSelectSession?(sessionId: string): void;
}) {
  const locale = useUiLocale();
  const copy = getDailyReviewCopy(locale);
  const [range, setRange] = useState<DailyReviewRange>(1);
  const [offsetDays, setOffsetDays] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  const [runPending, setRunPending] = useState(false);
  const loadGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    setLoadState({ status: 'loading' });
    try {
      const value = await props.bridge.load(range, offsetDays);
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setLoadState({ status: 'ready', value });
      }
    } catch {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setLoadState({ status: 'error' });
      }
    }
  }, [offsetDays, props.bridge, range]);

  useEffect(() => {
    void load();
  }, [load, props.revision, props.task?.updatedAt]);

  async function runNow() {
    if (!props.onRunNow || runPending) return;
    setRunPending(true);
    try {
      await props.onRunNow(dailyReviewManualIntent(range, Date.now(), offsetDays));
      if (mountedRef.current) await load();
    } finally {
      if (mountedRef.current) setRunPending(false);
    }
  }

  const view = loadState.status === 'ready' ? loadState.value : undefined;
  const reportSessionIds = new Set(view?.reports.map((report) => report.sessionId));
  const activitySessions = view?.sessions.filter(
    (session) => !reportSessionIds.has(session.sessionId),
  ) ?? [];
  const formatter = new Intl.NumberFormat(uiLocaleToIntlLocale(locale));
  const costFormatter = new Intl.NumberFormat(uiLocaleToIntlLocale(locale), {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
  });
  const dateFormatter = new Intl.DateTimeFormat(uiLocaleToIntlLocale(locale), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const rangeDateFormatter = new Intl.DateTimeFormat(uiLocaleToIntlLocale(locale), {
    month: 'short',
    day: 'numeric',
  });
  const displayedBounds = dailyReviewRangeBounds(range, Date.now(), offsetDays);
  const displayedRange = range === 1
    ? rangeDateFormatter.format(displayedBounds.from)
    : `${rangeDateFormatter.format(displayedBounds.from)} – ${rangeDateFormatter.format(displayedBounds.to - 1)}`;

  const primaryAction = props.task &&
    (props.task.status === 'active' || props.task.status === 'paused') ? (
    <UiButton
      variant="primary"
      label={runPending ? copy.page.running : copy.page.runNow}
      isDisabled={runPending || !props.onRunNow}
      isLoading={runPending}
      onClick={() => void runNow()}
    />
  ) : !props.task && props.canSetUp && props.onSetUp ? (
    <UiButton variant="primary" label={copy.page.setup} onClick={props.onSetUp} />
  ) : undefined;

  return (
    <ModulePage
      title={props.hubHeader?.title ?? copy.page.title}
      actions={(
        <>
          {primaryAction}
          <UiButton
            variant="ghost"
            label={copy.page.refresh}
            icon={<RefreshCcw size={ICON_SIZE.control} aria-hidden="true" />}
            onClick={() => void load()}
          />
        </>
      )}
      toolbar={(
        <div className="maka-module-page-bar maka-daily-review-toolbar">
          {props.hubHeader?.badge}
          <div
            className="maka-daily-review-period-controls"
            aria-controls="maka-daily-review-activity"
          >
            <SegmentedControl
              value={String(range)}
              label={copy.range.label}
              size="sm"
              onChange={(value) => {
                setRange(Number(value) as DailyReviewRange);
                setOffsetDays(0);
              }}
            >
              {copy.range.options.map(([value, label]) => (
                <SegmentedControlItem key={value} value={String(value)} label={label} />
              ))}
            </SegmentedControl>
            <div className="maka-daily-review-range-navigation">
              <IconButton
                variant="ghost"
                size="sm"
                label={copy.range.earlier}
                tooltip={copy.range.earlier}
                icon={<ChevronLeft size={ICON_SIZE.control} aria-hidden="true" />}
                onClick={() => setOffsetDays((value) => value - 1)}
              />
              <Text type="supporting" color="secondary">{displayedRange}</Text>
              <IconButton
                variant="ghost"
                size="sm"
                label={offsetDays === 0 ? copy.range.current : copy.range.later}
                tooltip={offsetDays === 0 ? copy.range.current : copy.range.later}
                icon={<ChevronRight size={ICON_SIZE.control} aria-hidden="true" />}
                isDisabled={offsetDays === 0}
                onClick={() => setOffsetDays((value) => Math.min(0, value + 1))}
              />
            </div>
          </div>
        </div>
      )}
    >
      <div className="maka-module-page-panel maka-daily-review-content">
        {loadState.status === 'loading' && !view ? (
          <Spinner label={copy.page.loading} />
        ) : loadState.status === 'error' ? (
          <EmptyState
            icon={<Sun size={ICON_SIZE.empty} aria-hidden="true" />}
            title={copy.page.loadFailed}
            actions={<UiButton variant="ghost" label={copy.page.retry} onClick={() => void load()} />}
          />
        ) : view ? (
          <>
            {props.task ? (
              <div className="maka-daily-review-schedule">
                <div className="maka-daily-review-schedule-summary">
                  <Text type="supporting" color="secondary">
                    {copy.schedule[props.task.status]}
                  </Text>
                  <span className="maka-daily-review-separator" aria-hidden="true">·</span>
                  <Text type="supporting" color="secondary">
                    {formatScheduledTaskRecurrence(props.task, locale)}
                  </Text>
                </div>
                {props.onManageSchedule ? (
                  <UiButton variant="ghost" size="sm" label={copy.page.manage} onClick={props.onManageSchedule} />
                ) : null}
              </div>
            ) : null}

            <section
              id="maka-daily-review-activity"
              className="maka-daily-review-activity"
              aria-label={`${displayedRange} · ${copy.activity.title}`}
            >
              <dl className="maka-daily-review-metrics" aria-label={copy.range.label}>
                {([
                  [view.totals.sessionCount, copy.overview.tasks],
                  [view.totals.totalRequests, copy.overview.modelCalls],
                  [formatter.format(view.totals.totalTokens), copy.overview.tokens],
                  [costFormatter.format(view.totals.totalCostUsd), copy.overview.cost],
                ] as const).map(([value, label]) => (
                  <div key={label}>
                    <dd>{value}</dd>
                    <dt>{label}</dt>
                  </div>
                ))}
              </dl>

              <div className="maka-daily-review-section-heading">
                <Heading level={2} id="maka-daily-review-activity-title">{copy.activity.title}</Heading>
                <Text type="supporting" color="secondary">{copy.activity.count(activitySessions.length)}</Text>
              </div>
              {activitySessions.length === 0 ? (
                <EmptyState isCompact title={copy.activity.emptyTitle} />
              ) : (
                <List density="balanced" hasDividers className="maka-module-page-rows" aria-label={copy.activity.title}>
                  {activitySessions.map((session) => (
                    <ListItem
                      key={session.sessionId}
                      label={session.title}
                      description={session.preview}
                      endContent={(
                        <Text type="supporting" color="secondary">
                          {dateFormatter.format(session.activityAt)}
                        </Text>
                      )}
                      onClick={props.onSelectSession
                        ? () => props.onSelectSession?.(session.sessionId)
                        : undefined}
                    />
                  ))}
                </List>
              )}
            </section>

            {view.reports.length > 0 ? (
              <section className="maka-daily-review-history" aria-labelledby="maka-daily-review-history-title">
                <div className="maka-daily-review-section-heading">
                  <div>
                    <Heading level={2} id="maka-daily-review-history-title">{copy.history.title}</Heading>
                    {view.hasMigratedReports ? (
                      <Text type="supporting" color="secondary">{copy.history.migrationNote}</Text>
                    ) : null}
                  </div>
                  <Text type="supporting" color="secondary">{copy.history.count(view.reports.length)}</Text>
                </div>
                <List density="balanced" hasDividers className="maka-module-page-rows" aria-label={copy.history.title}>
                  {view.reports.map((report) => (
                    <ListItem
                      key={report.sessionId}
                      label={report.title}
                      description={report.preview ?? (report.migrated ? copy.history.migrated : undefined)}
                      startContent={<StatusDot variant="neutral" label={copy.history.open} />}
                      endContent={(
                        <Text type="supporting" color="secondary">
                          {dateFormatter.format(report.generatedAt)}
                        </Text>
                      )}
                      onClick={props.onSelectSession
                        ? () => props.onSelectSession?.(report.sessionId)
                        : undefined}
                    />
                  ))}
                </List>
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </ModulePage>
  );
}
