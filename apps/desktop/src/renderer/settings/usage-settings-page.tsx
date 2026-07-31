import { useMemo, useState, type ReactNode } from 'react';
import {
  uiLocaleToIntlLocale,
  type AppSettings,
  type UpdateAppSettingsResult,
  type UsageRange,
  type UsageStats,
} from '@maka/core';
import {
  Alert,
  AlertAction,
  AlertDescription,
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  IconButton,
  TextInput,
  Segmented,
  SettingsSelect,
  Switch,
  TabsList,
  TabsPanel,
  TabsRoot,
  TabsTrigger,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { Activity, BarChart3, Cpu, Database, RefreshCcw, Search } from '@maka/ui/icons';
import {
  getUsageSettingsCopy,
  type UsageSettingsCopy,
} from '../locales/settings-usage-copy';
import { MetricCard } from './settings-metric-card';
import { settingsActionErrorMessage } from './settings-error-copy';
import { useActionGuard } from './use-action-guard';
import { useOptimisticSettingsDraft } from './use-optimistic-settings-draft';

type UsageActiveTab = AppSettings['usage']['activeTab'];

export function UsageSettingsPage(props: {
  settings: AppSettings;
  stats: UsageStats | null;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onReload(range?: UsageRange): Promise<void>;
  onOpenSession?(sessionId: string): void;
}) {
  const locale = useUiLocale();
  const copy = getUsageSettingsCopy(locale);
  const persistedUsage = props.settings.usage;
  const [refreshing, setRefreshing] = useState(false);
  const usageRefreshGuard = useActionGuard<'refresh'>();
  const stats = props.stats;
  const toast = useToast();
  const {
    draft: usageDraft,
    draftRef: usageDraftRef,
    mountedRef: usagePageMountedRef,
    update,
  } = useOptimisticSettingsDraft<AppSettings['usage']>(
    persistedUsage,
    (patch) => props.onUpdate({ usage: patch }).then((result) => result.settings.usage),
    { onError: (error) => toast.error(copy.saveFailed, settingsActionErrorMessage(error, locale)) },
  );

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

  async function setRange(range: UsageRange) {
    const saved = await updateUsage({ range });
    if (!saved || !usagePageMountedRef.current) return;
    await props.onReload(range);
  }

  function updateUsage(patch: Partial<AppSettings['usage']>): Promise<boolean> {
    return update(patch);
  }

  async function refresh() {
    if (!usageRefreshGuard.begin('refresh')) return;
    setRefreshing(true);
    try {
      await props.onReload(usageDraftRef.current.range);
    } finally {
      usageRefreshGuard.finish();
      if (usagePageMountedRef.current) {
        setRefreshing(false);
      }
    }
  }

  function clearRequestFilters() {
    void updateUsage({ status: 'all', modelFilter: '' });
  }

  return (
    <div className="settingsUsagePage">
      <div className="settingsUsageToolbar" role="group" aria-label={copy.toolbarAria}>
        <Segmented
          value={usageDraft.range}
          ariaLabel={copy.rangeAria}
          options={[
            ['24h', copy.ranges[0]],
            ['7d', copy.ranges[1]],
            ['30d', copy.ranges[2]],
            ['all', copy.ranges[3]],
          ]}
          onChange={(value) => void setRange(value as UsageRange)}
        />
        {/* Detail audit: 刷新 was a primary --action chip glued to the
            segmented — two control styles fighting in one row for a
            low-frequency utility. Same quiet icon form as the automations
            page refresh (one action, one shape everywhere); pinned to the
            row's trailing edge so the time cluster reads as a single
            left-aligned group. */}
        <IconButton
          variant="ghost"
          size="sm"
          isDisabled={refreshing}
          aria-busy={refreshing}
          data-pending={refreshing ? 'true' : undefined}
          label={refreshing ? copy.refreshingAria : copy.refreshAria}
          tooltip={refreshing ? copy.refreshingAria : copy.refreshAria}
          onClick={() => void refresh()}
          icon={<RefreshCcw size={15} aria-hidden="true" />}
        />
      </div>

      <div className="settingsUsageSummary" role="group" aria-label={copy.summaryAria}>
        <MetricCard title={copy.totalRequests} value={String(stats?.summary.totalRequests ?? 0)} />
        <MetricCard title={copy.totalCost} value={`$${(stats?.summary.totalCostUsd ?? 0).toFixed(2)}`} detail={copy.costHelp} />
        <MetricCard title={copy.totalTokens} value={String(stats?.summary.totalTokens ?? 0)} detail={copy.tokenDetail(stats?.summary.inputTokens ?? 0, stats?.summary.outputTokens ?? 0)} />
        <MetricCard title={copy.cacheTokens} value={String(stats?.summary.cacheTokens ?? 0)} detail={copy.cacheDetail(stats?.summary.cacheMiss ?? 0, stats?.summary.cacheRead ?? 0, stats?.summary.cacheCreation ?? 0)} />
      </div>

      <TabsRoot
        value={usageDraft.activeTab}
        onValueChange={(activeTab) => void updateUsage({ activeTab: activeTab as UsageActiveTab })}
      >
        <div className="settingsUsageTabsBar">
          <TabsList variant="underline" className="settingsUsageTabs" aria-label={copy.viewAria}>
            <TabsTrigger className="settingsUsageTab" value="requests">{copy.tabs[0]} <span>{tabCounts.requests}</span></TabsTrigger>
            <TabsTrigger className="settingsUsageTab" value="providers">{copy.tabs[1]} <span>{tabCounts.providers}</span></TabsTrigger>
            <TabsTrigger className="settingsUsageTab" value="models">{copy.tabs[2]} <span>{tabCounts.models}</span></TabsTrigger>
            <TabsTrigger className="settingsUsageTab" value="tools">{copy.tabs[3]} <span>{tabCounts.tools}</span></TabsTrigger>
            <TabsTrigger className="settingsUsageTab" value="pricing">{copy.tabs[4]} <span>{tabCounts.pricing}</span></TabsTrigger>
          </TabsList>
        </div>

        <TabsPanel className="settingsUsageTabPanel" value="requests">
          <UsageRequestsPanel
            stats={stats}
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
        </TabsPanel>

        <TabsPanel className="settingsUsageTabPanel" value="providers">
          <UsageProvidersPanel stats={stats} copy={copy} />
        </TabsPanel>

        <TabsPanel className="settingsUsageTabPanel" value="models">
          <UsageModelsPanel stats={stats} copy={copy} />
        </TabsPanel>

        <TabsPanel className="settingsUsageTabPanel" value="tools">
          <UsageToolsPanel stats={stats} copy={copy} />
        </TabsPanel>

        <TabsPanel className="settingsUsageTabPanel" value="pricing">
          <UsagePricingPanel stats={stats} copy={copy} />
        </TabsPanel>
      </TabsRoot>
    </div>
  );
}

// ── Per-tab panels ─────────────────────────────────────────────────────────
// Each tab owns its own component so the panel structure (filters, tables,
// empty states) reads top-to-bottom instead of hiding inside one switch.
// They all funnel their rows through the shared UsageStatsTable so every tab
// inherits the same hairline / column-rhythm / tabular-nums recipe.

function UsageRequestsPanel(props: {
  stats: UsageStats | null;
  logs: UsageStats['logs'];
  showDetails: boolean;
  modelFilter: string;
  status: AppSettings['usage']['status'];
  recordCount: number;
  hasRequestFilters: boolean;
  requestEmpty: string;
  copy: UsageSettingsCopy;
  locale: ReturnType<typeof useUiLocale>;
  onOpenSession?(sessionId: string): void;
  onEnableDetails(): void;
  onModelFilterChange(value: string): void;
  onStatusChange(status: AppSettings['usage']['status']): void;
  onToggleDetails(showDetails: boolean): void;
  onClearFilters(): void;
}) {
  if (!props.showDetails) {
    return (
      <Alert variant="info">
        <AlertDescription>{props.copy.summaryOnly}</AlertDescription>
        <AlertAction>
          <Button variant="secondary" size="sm" onClick={props.onEnableDetails} label={props.copy.showDetails} />
        </AlertAction>
      </Alert>
    );
  }
  return (
    <>
      <div className="settingsUsageFilters" role="group" aria-label={props.copy.filtersAria}>
        <TextInput
          value={props.modelFilter}
          onChange={(value) => props.onModelFilterChange(value)}
          placeholder={props.copy.filterPlaceholder}
          label={props.copy.filterAria}
          isLabelHidden
        />
        <SettingsSelect
          value={props.status}
          ariaLabel={props.copy.statusAria}
          options={[
            ['all', props.copy.statuses[0]],
            ['success', props.copy.statuses[1]],
            ['error', props.copy.statuses[2]],
          ] satisfies Array<readonly [AppSettings['usage']['status'], string]>}
          onChange={props.onStatusChange}
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
          { header: props.copy.tables.requestHeaders[0] },
          { header: props.copy.tables.requestHeaders[1] },
          { header: props.copy.tables.requestHeaders[2], grow: true },
          { header: props.copy.tables.requestHeaders[3] },
          { header: props.copy.tables.requestHeaders[4], numeric: true },
          { header: props.copy.tables.requestHeaders[5], numeric: true },
          { header: props.copy.tables.requestHeaders[6], numeric: true },
          { header: props.copy.tables.requestHeaders[7] },
        ]}
        rows={props.logs.map((row) => [
          new Date(row.ts).toLocaleString(uiLocaleToIntlLocale(props.locale)),
          usageRequestKindLabel(row.kind, props.copy),
          usageRequestTarget(row),
          usageRequestSessionCell(row, props.copy, props.onOpenSession),
          row.inputTokens + row.outputTokens,
          row.kind === 'model' ? `$${(row.costUsd ?? 0).toFixed(2)}` : '-',
          row.latencyMs ? `${row.latencyMs}ms` : '-',
          usageRequestStatusLabel(row.status, props.copy),
        ])}
        empty={{ Icon: props.hasRequestFilters ? Search : Activity, title: props.requestEmpty }}
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
  return row.kind === 'tool' ? row.toolName ?? row.model : row.model;
}

function usageRequestSessionCell(row: UsageStats['logs'][number], copy: UsageSettingsCopy, onOpenSession?: (sessionId: string) => void) {
  const label = shortUsageSessionId(row.sessionId);
  if (!onOpenSession) return label;
  return (
    <Button variant="ghost" size="sm" onClick={() => onOpenSession(row.sessionId)} label={copy.tables.openSession(label)} />
  );
}

function shortUsageSessionId(sessionId: string) {
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}

function usageRequestStatusLabel(status: UsageStats['logs'][number]['status'], copy: UsageSettingsCopy) {
  switch (status) {
    case 'success': return copy.tables.success;
    case 'error': return copy.tables.error;
  }
}

// ── Shared table wrapper ────────────────────────────────────────────────────
// The hairline/column-rhythm/tabular-nums recipe now lives in the shared
// `DataTable` primitive (@maka/ui) — the #1252 table grew health + permission
// consumers, so it was promoted. This thin wrapper keeps the usage-local
// concern the primitive deliberately omits: routing an empty tab to the shared
// EmptyState (icon + copy) instead of a bare header row. All five tabs funnel
// through it, so every tab inherits the same table and the same empty surface.

interface UsageColumn extends DataTableColumn {
  header: string;
}

interface UsageEmpty {
  /** A lucide icon (same shape EmptyState accepts). */
  Icon: typeof Search;
  title: string;
  body?: string;
}

function UsageStatsTable(props: {
  ariaLabel: string;
  columns: UsageColumn[];
  rows: Array<Array<ReactNode>>;
  empty: UsageEmpty;
}) {
  if (props.rows.length === 0) {
    return (
      <EmptyState
        Icon={props.empty.Icon}
        title={props.empty.title}
        body={props.empty.body ?? ''}
        extraClassName="settingsUsageEmpty"
      />
    );
  }
  return (
    <DataTable
      ariaLabel={props.ariaLabel}
      columns={props.columns}
      rows={props.rows}
      className="settingsUsageTable"
    />
  );
}
