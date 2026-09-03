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

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  SegmentedControl,
  SegmentedControlItem,
  Tab,
  TabList,
  Tooltip,
} from '@astryxdesign/core';
import { uiLocaleToIntlLocale } from '@maka/core/ui-locale';
import { parseDesktopSessionKey } from '../../../../shared/runtime-host-identity.js';
import type { UsageRange, UsageSettings, UsageStats } from '@maka/core/settings';
import { estimatedUsageCost, hasUnavailableUsage } from '@maka/core/usage-ledger-merge';
import { Button, TextInput, Selector, Switch, useToast, useUiLocale, Banner } from '@maka/ui';
import { ICON_SIZE, Activity, BarChart3, Cpu, Database, RefreshCcw, Search } from '@maka/ui/icons';
import {
  getUsageSettingsCopy,
  type UsageSettingsCopy,
} from '../../../locales/settings-usage-copy.js';
import { MetricCard } from './metric-card.js';
import { UsageStatsTable } from './usage-stats-table.js';
import { useActionGuard } from '../controller/action-guard.js';
import { useOptimisticSettingsDraft } from '../controller/optimistic-settings-draft.js';
import { useUsageServices, useUsageStats } from '../services-context.js';

type UsageActiveTab = UsageSettings['activeTab'];

/**
 * The Usage settings surface (issue #4425). A disposable view: it unmounts when
 * the user leaves the Usage section. The loaded stats snapshot lives in the
 * persistent `UsageFeatureScope` (read via `useUsageStats`), so leaving and
 * returning re-displays the last snapshot immediately while a background reload
 * refreshes it. Copy comes straight from the locale catalog (a feature import of
 * a validated catalog is closure-exempt); only the legacy error-message helper
 * is injected via `describeError`.
 */
export function UsageSettingsView(props: {
  settings: UsageSettings;
  describeError(error: unknown): string;
  onOpenSession?(sessionId: string): void;
}) {
  const services = useUsageServices();
  const locale = useUiLocale();
  const copy = getUsageSettingsCopy(locale);
  const toast = useToast();
  const persistedUsage = props.settings;
  // The stats snapshot lives in the persistent `UsageFeatureScope` (keyed by the
  // selected Host generation), so it survives this view unmounting on a section
  // switch. `stats` is non-null only when the scope's snapshot was loaded for the
  // persisted range — during a range switch (or after a late/failed load) the
  // panels read `null` (loading/empty) rather than the previous range's numbers.
  const { stats, reload, targetKey } = useUsageStats(persistedUsage.range);
  const [refreshing, setRefreshing] = useState(false);
  const usageRefreshGuard = useActionGuard<'refresh'>();
  const {
    draft: usageDraft,
    draftRef: usageDraftRef,
    mountedRef: usagePageMountedRef,
    update,
  } = useOptimisticSettingsDraft<UsageSettings>(
    persistedUsage,
    (patch) => services.updateUsageSettings(patch),
    { onError: (error) => toast.error(copy.saveFailed, props.describeError(error)) },
  );

  // Usage records are Host-owned; display preferences are client-owned. Trigger a
  // background reload on mount, whenever the persisted range changes, and whenever
  // the Host generation changes (`targetKey`) — the last mirrors the previous
  // surface's reload-on-epoch. The first frame already shows the scope's existing
  // snapshot (stale-while-revalidate); the reload itself (ticket, unmount
  // isolation, target invalidation) lives in the scope, so a load in flight when
  // this view unmounts still lands and is visible on return.
  useEffect(() => {
    void reload(persistedUsage.range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedUsage.range, targetKey]);

  const normalizedModelFilter = usageDraft.modelFilter.trim().toLowerCase();
  const hasRequestFilters = usageDraft.status !== 'all' || normalizedModelFilter.length > 0;
  const showRequestDetails = usageDraft.activeTab === 'requests' && usageDraft.showDetails;
  const filteredLogs = useMemo(() => {
    const logs = stats?.logs ?? [];
    return logs
      .filter((log) => usageDraft.status === 'all' || log.status === usageDraft.status)
      .filter((log) =>
        normalizedModelFilter.length === 0 ||
        log.model.toLowerCase().includes(normalizedModelFilter) ||
        log.provider.toLowerCase().includes(normalizedModelFilter) ||
        (log.toolName ?? '').toLowerCase().includes(normalizedModelFilter)
      );
  }, [stats, usageDraft.status, normalizedModelFilter]);

  const tabCounts: Record<UsageActiveTab, number> = {
    requests: stats?.logs.length ?? 0,
    providers: stats?.byProvider.length ?? 0,
    models: stats?.byModel.length ?? 0,
    tools: stats?.byTool.length ?? 0,
    pricing: stats?.pricing.length ?? 0,
  };

  function updateUsage(patch: Partial<UsageSettings>): Promise<boolean> {
    return update(patch);
  }

  async function setRange(range: UsageRange) {
    // Persist only: the surface refetches when the persisted range lands.
    await updateUsage({ range });
  }

  async function refresh() {
    if (!usageRefreshGuard.begin('refresh')) return;
    setRefreshing(true);
    try {
      await reload(usageDraftRef.current.range);
    } finally {
      usageRefreshGuard.finish();
      if (usagePageMountedRef.current) setRefreshing(false);
    }
  }

  function clearRequestFilters() {
    void updateUsage({ status: 'all', modelFilter: '' });
  }

  const usageIncomplete =
    stats != null && (hasUnavailableUsage(stats.provenance) || stats.logsTruncated === true);
  const totalCostDisplay = stats
    ? (() => {
        const cost = estimatedUsageCost(stats.provenance, stats.summary.totalCostUsd);
        if (cost !== undefined) return `$${cost.toFixed(2)}`;
        return stats.summary.totalRequests === 0 ? '$0.00' : copy.costUnavailable;
      })()
    : '—';

  return (
    <>
      {usageIncomplete ? (
        <Banner
          status="warning"
          role="status"
          title={copy.incompleteTitle}
          description={copy.incompleteBody}
        />
      ) : null}
      <div className="settingsUsageOverview">
        <div className="settingsUsageToolbar" role="group" aria-label={copy.toolbarAria}>
          <SegmentedControl
            value={usageDraft.range}
            label={copy.rangeAria}
            onChange={(value) => void setRange(value as UsageRange)}
          >
            {(['24h', '7d', '30d', 'all'] as const).map((value, index) => (
              <SegmentedControlItem key={value} value={value} label={copy.ranges[index]} />
            ))}
          </SegmentedControl>
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            isLoading={refreshing}
            label={copy.refreshAria}
            tooltip={copy.refreshAria}
            onClick={() => void refresh()}
            icon={<RefreshCcw size={ICON_SIZE.control} aria-hidden="true" />}
          />
        </div>

        <div className="settingsUsageSummary" role="group" aria-label={copy.summaryAria}>
          <MetricCard title={copy.totalRequests} value={stats ? String(stats.summary.totalRequests) : '—'} />
          <MetricCard title={copy.totalCost} value={totalCostDisplay} detail={copy.costHelp} />
          <MetricCard title={copy.totalTokens} value={stats ? String(stats.summary.totalTokens) : '—'} detail={stats ? copy.tokenDetail(stats.summary.inputTokens, stats.summary.outputTokens) : undefined} />
          <MetricCard title={copy.cacheTokens} value={stats ? String(stats.summary.cacheTokens) : '—'} detail={stats ? copy.cacheDetail(stats.summary.cacheMiss, stats.summary.cacheRead, stats.summary.cacheCreation) : undefined} />
        </div>
      </div>

      <div className="settingsUsageBreakdown">
        <div className="settingsUsageTabsBar">
          <TabList
            value={usageDraft.activeTab}
            onChange={(activeTab) => void updateUsage({ activeTab: activeTab as UsageActiveTab })}
            hasDivider
            aria-label={copy.viewAria}
          >
            <Tab value="requests" label={copy.tabs[0]} endContent={<span>{tabCounts.requests}</span>} />
            <Tab value="providers" label={copy.tabs[1]} endContent={<span>{tabCounts.providers}</span>} />
            <Tab value="models" label={copy.tabs[2]} endContent={<span>{tabCounts.models}</span>} />
            <Tab value="tools" label={copy.tabs[3]} endContent={<span>{tabCounts.tools}</span>} />
            <Tab value="pricing" label={copy.tabs[4]} endContent={<span>{tabCounts.pricing}</span>} />
          </TabList>
        </div>

        {usageDraft.activeTab === 'requests' ? (
          <div className="settingsUsageTabPanel">
            <UsageRequestsPanel
              logs={showRequestDetails ? filteredLogs : []}
              showDetails={usageDraft.showDetails}
              modelFilter={usageDraft.modelFilter}
              status={usageDraft.status}
              recordCount={filteredLogs.length}
              hasRequestFilters={hasRequestFilters}
              requestEmpty={hasRequestFilters ? copy.filteredEmpty : copy.requestEmpty}
              copy={copy}
              locale={locale}
              onOpenSession={props.onOpenSession}
              onEnableDetails={() => void updateUsage({ showDetails: true })}
              onModelFilterChange={(modelFilter) => void updateUsage({ modelFilter })}
              onStatusChange={(status) => void updateUsage({ status })}
              onToggleDetails={(showDetails) => void updateUsage({ showDetails })}
              onClearFilters={clearRequestFilters}
            />
          </div>
        ) : null}

        {usageDraft.activeTab === 'providers' ? (
          <div className="settingsUsageTabPanel">
            <UsageProvidersPanel stats={stats} copy={copy} />
          </div>
        ) : null}

        {usageDraft.activeTab === 'models' ? (
          <div className="settingsUsageTabPanel">
            <UsageModelsPanel stats={stats} copy={copy} />
          </div>
        ) : null}

        {usageDraft.activeTab === 'tools' ? (
          <div className="settingsUsageTabPanel">
            <UsageToolsPanel stats={stats} copy={copy} />
          </div>
        ) : null}

        {usageDraft.activeTab === 'pricing' ? (
          <div className="settingsUsageTabPanel">
            <UsagePricingPanel stats={stats} copy={copy} />
          </div>
        ) : null}
      </div>
    </>
  );
}

// ── Per-tab panels ─────────────────────────────────────────────────────────

function UsageRequestsPanel(props: {
  logs: UsageStats['logs'];
  showDetails: boolean;
  modelFilter: string;
  status: UsageSettings['status'];
  recordCount: number;
  hasRequestFilters: boolean;
  requestEmpty: string;
  copy: UsageSettingsCopy;
  locale: ReturnType<typeof useUiLocale>;
  onOpenSession?(sessionId: string): void;
  onEnableDetails(): void;
  onModelFilterChange(value: string): void;
  onStatusChange(status: UsageSettings['status']): void;
  onToggleDetails(showDetails: boolean): void;
  onClearFilters(): void;
}) {
  if (!props.showDetails) {
    return (
      <Banner
        status="info"
        title={props.copy.summaryOnly}
        endContent={<Button variant="secondary" size="sm" onClick={props.onEnableDetails} label={props.copy.showDetails} />} />
    );
  }
  return (
    <>
      <div className="settingsUsageFilters" role="group" aria-label={props.copy.filtersAria}>
        <div className="settingsUsageModelFilter">
          <TextInput
            value={props.modelFilter}
            onChange={(value) => props.onModelFilterChange(value)}
            placeholder={props.copy.filterPlaceholder}
            label={props.copy.filterAria}
            isLabelHidden
            width="100%"
          />
        </div>
        <Selector
          value={props.status}
          label={props.copy.statusAria}
          isLabelHidden
          options={[
            { value: 'all', label: props.copy.statuses[0] },
            { value: 'success', label: props.copy.statuses[1] },
            { value: 'error', label: props.copy.statuses[2] },
            { value: 'aborted', label: props.copy.statuses[3] },
          ]}
          width={320}
          onChange={(value) => props.onStatusChange(value as UsageSettings['status'])}
        />
        <div className="settingsUsageDetailToggle">
          <span>{props.copy.details}</span>
          <Switch
            label={props.copy.detailsAria}
            isLabelHidden
            value={props.showDetails}
            onChange={props.onToggleDetails}
          />
        </div>
        <small className="settingsUsageRecordCount">{props.copy.recordCount(props.recordCount)}</small>
        <Button
          className="settingsUsageClearFilter"
          variant="ghost"
          size="sm"
          isDisabled={!props.hasRequestFilters}
          aria-hidden={!props.hasRequestFilters ? 'true' : undefined}
          tabIndex={!props.hasRequestFilters ? -1 : undefined}
          onClick={props.hasRequestFilters ? props.onClearFilters : undefined}
          label={props.copy.clearFilters}
        />
      </div>
      <UsageStatsTable
        ariaLabel={props.copy.tables.requestsAria}
        columns={[
          { header: props.copy.tables.requestHeaders[0], width: 168 },
          { header: props.copy.tables.requestHeaders[1], width: 72 },
          { header: props.copy.tables.requestHeaders[2], grow: true },
          { header: props.copy.tables.requestHeaders[3], width: 168 },
          { header: props.copy.tables.requestHeaders[4], numeric: true },
          { header: props.copy.tables.requestHeaders[5], numeric: true },
          { header: props.copy.tables.requestHeaders[6], numeric: true },
          { header: props.copy.tables.requestHeaders[7], width: 72 },
        ]}
        rows={props.logs.map((row) => [
          new Date(row.ts).toLocaleString(uiLocaleToIntlLocale(props.locale)),
          usageRequestKindLabel(row.kind, props.copy),
          usageRequestTarget(row),
          usageRequestSessionCell(row, props.copy, props.onOpenSession),
          row.inputTokens + row.outputTokens,
          row.kind === 'model' && row.costUsd !== undefined ? `$${row.costUsd.toFixed(2)}` : '-',
          row.latencyMs !== undefined ? `${row.latencyMs}ms` : '-',
          usageRequestStatusLabel(row.status, props.copy),
        ])}
        empty={{
          Icon: props.hasRequestFilters ? Search : Activity,
          title: props.requestEmpty,
          body: props.hasRequestFilters ? props.copy.filteredEmptyHelp : undefined,
          action: props.hasRequestFilters ? (
            <Button
              variant="ghost"
              size="sm"
              label={props.copy.clearFilters}
              onClick={props.onClearFilters}
            />
          ) : undefined,
        }}
      />
    </>
  );
}

function UsageProvidersPanel(props: { stats: UsageStats | null; copy: UsageSettingsCopy }) {
  return (
    <UsageStatsTable
      ariaLabel={props.copy.tables.providersAria}
      columns={[
        { header: props.copy.tables.providerHeaders[0], grow: true },
        { header: props.copy.tables.providerHeaders[1], numeric: true },
        { header: props.copy.tables.providerHeaders[2], numeric: true },
        { header: props.copy.tables.providerHeaders[3], numeric: true },
      ]}
      rows={(props.stats?.byProvider ?? []).map((row) => [row.provider, row.requests, row.tokens, `$${row.costUsd.toFixed(2)}`])}
      empty={{ Icon: Database, title: props.copy.tables.providerEmptyTitle, body: props.copy.tables.providerEmptyBody }}
    />
  );
}

function UsageModelsPanel(props: { stats: UsageStats | null; copy: UsageSettingsCopy }) {
  return (
    <UsageStatsTable
      ariaLabel={props.copy.tables.modelsAria}
      columns={[
        { header: props.copy.tables.modelHeaders[0], grow: true },
        { header: props.copy.tables.modelHeaders[1], numeric: true },
        { header: props.copy.tables.modelHeaders[2], numeric: true },
        { header: props.copy.tables.modelHeaders[3], numeric: true },
      ]}
      rows={(props.stats?.byModel ?? []).map((row) => [row.model, row.requests, row.tokens, `$${row.costUsd.toFixed(2)}`])}
      empty={{ Icon: Cpu, title: props.copy.tables.modelEmptyTitle, body: props.copy.tables.modelEmptyBody }}
    />
  );
}

function UsageToolsPanel(props: { stats: UsageStats | null; copy: UsageSettingsCopy }) {
  return (
    <UsageStatsTable
      ariaLabel={props.copy.tables.toolsAria}
      columns={[
        { header: props.copy.tables.toolHeaders[0], grow: true },
        { header: props.copy.tables.toolHeaders[1], numeric: true },
        { header: props.copy.tables.toolHeaders[2], numeric: true },
        { header: props.copy.tables.toolHeaders[3], numeric: true },
        { header: props.copy.tables.toolHeaders[4], numeric: true },
      ]}
      rows={(props.stats?.byTool ?? []).map((row) => [row.tool, row.calls, row.success, row.errors, `${row.avgDurationMs}ms`])}
      empty={{ Icon: Activity, title: props.copy.tables.toolEmptyTitle, body: props.copy.tables.toolEmptyBody }}
    />
  );
}

function UsagePricingPanel(props: { stats: UsageStats | null; copy: UsageSettingsCopy }) {
  return (
    <UsageStatsTable
      ariaLabel={props.copy.tables.pricingAria}
      columns={[
        { header: props.copy.tables.pricingHeaders[0], grow: true },
        { header: props.copy.tables.pricingHeaders[1] },
        { header: props.copy.tables.pricingHeaders[2], numeric: true },
        { header: props.copy.tables.pricingHeaders[3], numeric: true },
      ]}
      rows={(props.stats?.pricing ?? []).map((row) => [row.provider, row.model, `$${row.inputPerMTokUsd}`, `$${row.outputPerMTokUsd}`])}
      empty={{ Icon: BarChart3, title: props.copy.tables.noPricing, body: props.copy.tables.pricingEmptyBody }}
    />
  );
}

// ── Request-log cell helpers ────────────────────────────────────────────────

function usageRequestKindLabel(kind: UsageStats['logs'][number]['kind'], copy: UsageSettingsCopy) {
  switch (kind) {
    case 'model': return copy.tables.modelKind;
    case 'tool': return copy.tables.toolKind;
  }
}

function usageRequestTarget(row: UsageStats['logs'][number]) {
  const target = row.kind === 'tool' ? row.toolName || row.model || row.provider || '-' : row.model || row.provider || '-';
  return (
    <Tooltip content={target}>
      <span className="settingsUsageTargetCell" title={target}>{target}</span>
    </Tooltip>
  );
}

function usageRequestSessionCell(row: UsageStats['logs'][number], copy: UsageSettingsCopy, onOpenSession?: (sessionId: string) => void) {
  if (!row.sessionId) return copy.tables.unknown;
  const sessionId = row.sessionId;
  const label = usageSessionDisplayLabel(row, copy);
  if (!onOpenSession) return label;
  return (
    <Button
      className="settingsUsageSessionCell"
      variant="ghost"
      size="sm"
      onClick={() => onOpenSession(sessionId)}
      label={label}
      tooltip={copy.tables.openSession(label)}
    />
  );
}

function usageSessionDisplayLabel(row: UsageStats['logs'][number], copy: UsageSettingsCopy) {
  const name = row.sessionName?.trim();
  if (name) return name;
  return `${copy.tables.untitledSession} · ${shortRealSessionId(row.sessionId ?? '')}`;
}

function shortRealSessionId(sessionKey: string) {
  try {
    return shortUsageSessionId(parseDesktopSessionKey(sessionKey).sessionId);
  } catch {
    return shortUsageSessionId(sessionKey);
  }
}

function shortUsageSessionId(sessionId: string) {
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}

function usageRequestStatusLabel(status: UsageStats['logs'][number]['status'], copy: UsageSettingsCopy) {
  switch (status) {
    case 'success': return copy.tables.success;
    case 'error': return copy.tables.error;
    case 'aborted': return copy.tables.aborted;
  }
}
