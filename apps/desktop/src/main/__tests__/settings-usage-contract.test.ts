import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

// The usage page splits into an orchestrator (UsageSettingsPage) plus one
// component per tab, then a shared table primitive. Contract assertions scope
// to the block that owns each concern so a regression in one tab cannot be
// masked by a matching string in another.
const usagePageBlock = (src: string) =>
  src.match(/function UsageSettingsPage\([\s\S]*?function UsageRequestsPanel/)?.[0] ?? '';
const requestsPanelBlock = (src: string) =>
  src.match(/function UsageRequestsPanel\([\s\S]*?function UsageProvidersPanel/)?.[0] ?? '';
const statsTableBlock = (src: string) =>
  src.match(/function UsageStatsTable\([\s\S]*?function MetricCard/)?.[0] ?? '';

describe('Settings usage dashboard contract', () => {
  it('keeps request filters scoped to the request log tab', async () => {
    const src = await readSettingsCombinedSource();
    const usagePage = usagePageBlock(src);
    const requestsPanel = requestsPanelBlock(src);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.ok(requestsPanel, 'Usage requests panel block must exist');
    // Only the request-log tab computes/derives detail rows; the aggregate
    // tabs never see the request filters.
    assert.match(usagePage, /const showRequestDetails = usageDraft\.activeTab === 'requests' && usageDraft\.showDetails/);
    assert.match(usagePage, /status: 'all', modelFilter: ''/);
    assert.match(usagePage, /log\.model\.toLowerCase\(\)\.includes\(normalizedModelFilter\)/);
    assert.match(usagePage, /\(log\.toolName \?\? ''\)\.toLowerCase\(\)\.includes\(normalizedModelFilter\)/);
    // The filter cluster lives in the requests panel, behind its own details
    // guard — it can never render under an aggregate tab.
    assert.match(requestsPanel, /if \(!props\.showDetails\)/);
    assert.match(requestsPanel, /<div className="settingsUsageFilters" role="group" aria-label=\{props\.copy\.filtersAria\}>/);
    assert.match(requestsPanel, /\{props\.copy\.clearFilters\}/);
    assert.match(requestsPanel, /<Input value=\{props\.modelFilter\}/);
    assert.match(requestsPanel, /placeholder=\{props\.copy\.filterPlaceholder\} aria-label=\{props\.copy\.filterAria\}/);
    assert.match(requestsPanel, /className="settingsUsageDetailToggle"/);
    assert.match(requestsPanel, /className="settingsUsageRecordCount"/);
    assert.match(requestsPanel, /className="settingsUsageClearFilter"/);
    // #1565 PR 3: Astryx Button takes `isDisabled` instead of `disabled`.
    assert.match(requestsPanel, /isDisabled=\{!props\.hasRequestFilters\}/);
    assert.match(requestsPanel, /tabIndex=\{!props\.hasRequestFilters \? -1 : undefined\}/);
    assert.doesNotMatch(
      requestsPanel,
      /<div className="settingsUsageFilters">/,
      'Usage request filters must not regress to an anonymous control cluster',
    );
  });

  it('shows a distinct empty state when request filters hide all logs', async () => {
    const src = await readSettingsCombinedSource();
    const requestsPanel = requestsPanelBlock(src);

    // The orchestrator decides the empty copy from the filter state; the panel
    // routes it into the shared table's EmptyState title.
    assert.match(src, /requestEmpty=\{hasRequestFilters \? copy\.filteredEmpty : copy\.requestEmpty\}/);
    assert.match(requestsPanel, /title: props\.requestEmpty/);
    assert.match(
      requestsPanel,
      /empty=\{\{ Icon: props\.hasRequestFilters \? Search : Activity, title: props\.requestEmpty \}\}/,
      'The empty request log must surface through the shared EmptyState (icon + copy), not a bare table row',
    );
  });

  it('makes the detail-records toggle control request log rendering', async () => {
    const src = await readSettingsCombinedSource();
    const usagePage = usagePageBlock(src);
    const requestsPanel = requestsPanelBlock(src);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(usagePage, /const showRequestDetails = usageDraft\.activeTab === 'requests' && usageDraft\.showDetails/);
    assert.match(usagePage, /logs=\{showRequestDetails \? filteredLogs : \[\]\}/);
    assert.match(usagePage, /showDetails: true/);
    // With details off the panel returns the summary-only prompt; the alert +
    // The localized details CTA lives in the requests panel now.
    assert.match(requestsPanel, /if \(!props\.showDetails\)/);
    assert.match(requestsPanel, /\{props\.copy\.summaryOnly\}/);
    assert.match(requestsPanel, /\{props\.copy\.showDetails\}/);
    assert.match(requestsPanel, /onClick=\{props\.onEnableDetails\}/);
  });

  it('names the usage range selector and tab views for assistive technology', async () => {
    const src = await readSettingsCombinedSource();
    const usagePage = usagePageBlock(src);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(
      usagePage,
      /<div className="settingsUsageToolbar" role="group" aria-label=\{copy\.toolbarAria\}>/,
      'Usage range selector and refresh action must expose a named control group',
    );
    assert.doesNotMatch(
      usagePage,
      /<div className="settingsUsageToolbar">\s*<Segmented/,
      'Usage toolbar must not regress to an anonymous range/refresh cluster',
    );
    assert.match(
      usagePage,
      /<Segmented[\s\S]*value=\{usageDraft\.range\}[\s\S]*ariaLabel=\{copy\.rangeAria\}/,
      'range segmented control must expose what the 24h/7天/30天/all group changes',
    );
    // The tab row converged to the house underline TabsList (skills / MCP
    // language) with count pills — not a second segmented toggle.
    assert.match(
      usagePage,
      /<TabsRoot[\s\S]*value=\{usageDraft\.activeTab\}/,
      'tab views must be driven by the shared TabsRoot bound to the active tab',
    );
    assert.match(
      usagePage,
      /<TabsList variant="underline" className="settingsUsageTabs" aria-label=\{copy\.viewAria\}>/,
      'the tab row must use the underline TabsList so it reads as tabs, not a toggle chip',
    );
    assert.doesNotMatch(
      // Bounded so it only fires when a single <Segmented …/> tag itself binds
      // activeTab — not when the range Segmented merely precedes the TabsRoot.
      usagePage,
      /<Segmented\b(?:(?!\/>)[\s\S])*?value=\{usageDraft\.activeTab\}/,
      'the view switcher must not regress to a segmented toggle',
    );
    for (const [value, copyIndex] of [
      ['requests', 0],
      ['providers', 1],
      ['models', 2],
      ['tools', 3],
      ['pricing', 4],
    ] as const) {
      assert.match(
        usagePage,
        new RegExp(`<TabsTrigger className="settingsUsageTab" value="${value}">\\{copy\\.tabs\\[${copyIndex}\\]\\} <span>`),
        `tab ${value} must render its localized label with a count pill`,
      );
    }
  });

  it('names the usage summary metrics group', async () => {
    const src = await readSettingsCombinedSource();
    const usagePage = usagePageBlock(src);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(
      usagePage,
      /<div className="settingsUsageSummary" role="group" aria-label=\{copy\.summaryAria\}>/,
      'Usage summary metric cards must expose a named group before the tabbed detail tables',
    );
    assert.doesNotMatch(
      usagePage,
      /<div className="settingsUsageSummary">\s*<MetricCard/,
      'Usage summary metrics must not regress to an anonymous card cluster',
    );
  });

  it('names every usage stats table and boxes it in the shared DataTable primitive', async () => {
    const src = await readSettingsCombinedSource();
    const statsTable = statsTableBlock(src);

    for (const label of [
      'requestsAria',
      'providersAria',
      'modelsAria',
      'toolsAria',
      'pricingAria',
    ]) {
      assert.match(src, new RegExp(`ariaLabel=\\{props\\.copy\\.tables\\.${label}\\}`), `A usage tab must name its ${label}`);
    }
    // Every tab funnels through the one shared wrapper so the column rhythm /
    // hairline / tabular-nums recipe stays in a single place. The wrapper keeps
    // its typed-column + EmptyState signature; the table markup itself now lives
    // in @maka/ui's DataTable primitive (pinned by packages/ui data-table.test),
    // so the wrapper delegates the non-empty branch to <DataTable/>.
    assert.match(
      statsTable,
      /function UsageStatsTable\(props: \{\s*ariaLabel: string;\s*columns: UsageColumn\[\];\s*rows: Array<Array<ReactNode>>;\s*empty: UsageEmpty;\s*\}\)/,
      'UsageStatsTable callers must provide a table-specific accessible name, typed columns, and an EmptyState config',
    );
    // Empty tabs render the shared EmptyState rather than a header-only table…
    assert.match(
      statsTable,
      /if \(props\.rows\.length === 0\) \{\s*return \(\s*<EmptyState/,
      'An empty usage tab must render the EmptyState primitive, not a bare header row',
    );
    // …and the non-empty branch delegates to the shared DataTable primitive,
    // passing the caller-provided name, typed columns, rows, and the pin class.
    assert.match(
      statsTable,
      /<DataTable\s+ariaLabel=\{props\.ariaLabel\}\s+columns=\{props\.columns\}\s+rows=\{props\.rows\}\s+className="settingsUsageTable"/,
      'The non-empty usage table must delegate to the shared DataTable primitive',
    );
    assert.doesNotMatch(
      statsTable,
      /<table\b/,
      'Usage stats tables must not hand-roll a <table> — the markup lives in the DataTable primitive',
    );
  });

  it('keeps usage filters responsive through a local draft while saves run in the background', async () => {
    const src = await readSettingsCombinedSource();
    const usagePage = usagePageBlock(src);
    const requestsPanel = requestsPanelBlock(src);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(usagePage, /const persistedUsage = props\.settings\.usage/);
    assert.match(
      usagePage,
      /useOptimisticSettingsDraft<AppSettings\['usage'\]>\([\s\S]*persistedUsage,[\s\S]*\(patch\) => props\.onUpdate\(\{ usage: patch \}\)\.then\(\(result\) => result\.settings\.usage\)/,
      'Usage controls must drive their local draft through the shared optimistic draft hook instead of waiting for settings IPC',
    );
    assert.match(
      usagePage,
      /draft: usageDraft,[\s\S]*draftRef: usageDraftRef,[\s\S]*mountedRef: usagePageMountedRef,[\s\S]*update,/,
      'Usage must read its rendered draft, synchronous draft ref, and mounted ref from the shared hook',
    );
    assert.match(
      usagePage,
      /\{ onError: \(error\) => toast\.error\(copy\.saveFailed, settingsActionErrorMessage\(error, locale\)\) \},[\s\S]*function updateUsage\(patch: Partial<AppSettings\['usage'\]>\): Promise<boolean> \{[\s\S]*return update\(patch\);/,
      'Usage settings saves must route through the shared draft update (latest-response sync + rollback owned by the hook)',
    );
    // The filter controls bind to the panel props (fed from the live draft),
    // never straight to persisted settings while typing.
    assert.match(requestsPanel, /<Input value=\{props\.modelFilter\}/);
    assert.match(requestsPanel, /<SettingsSelect[\s\S]*value=\{props\.status\}[\s\S]*ariaLabel=\{props\.copy\.statusAria\}/);
    assert.match(usagePage, /modelFilter=\{usageDraft\.modelFilter\}/);
    assert.match(usagePage, /status=\{usageDraft\.status\}/);
    assert.doesNotMatch(
      requestsPanel,
      /<(?:input|Input) value=\{usage\.modelFilter\}/,
      'Usage model filter must not bind directly to persisted settings while typing',
    );
  });

  it('surfaces usage preference save failures instead of leaving filter controls silent', async () => {
    const src = await readSettingsCombinedSource();
    const usagePage = usagePageBlock(src);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(usagePage, /function updateUsage\(patch: Partial<AppSettings\['usage'\]>\): Promise<boolean>/);
    assert.match(
      usagePage,
      /\{ onError: \(error\) => toast\.error\(copy\.saveFailed, settingsActionErrorMessage\(error, locale\)\) \},[\s\S]*function updateUsage\(patch: Partial<AppSettings\['usage'\]>\): Promise<boolean> \{[\s\S]*return update\(patch\);/,
      'Usage settings updates must surface the save failure through the shared hook (which gates on the latest mounted save) and report failure to callers',
    );
    assert.match(
      usagePage,
      /const saved = await updateUsage\(\{ range \}\);[\s\S]*if \(!saved \|\| !usagePageMountedRef\.current\) return;[\s\S]*await props\.onReload\(range\)/,
      'Changing the usage range must not reload stats after the preference save fails',
    );
    assert.doesNotMatch(
      usagePage,
      /void props\.onUpdate\(\{ usage:/,
      'Usage filter controls must not fire-and-forget raw settings updates',
    );
  });

  it('drops late usage preference and refresh UI writes after Settings is closed', async () => {
    const src = await readSettingsCombinedSource();
    const usagePage = usagePageBlock(src);

    assert.match(
      usagePage,
      /mountedRef: usagePageMountedRef,/,
      'Usage settings page must track mounted ownership (from the shared draft hook) for async preference and refresh work',
    );
    assert.match(
      usagePage,
      /const usageRefreshGuard = useActionGuard<'refresh'>\(\)/,
      'Usage settings must hold its manual refresh guard from the shared hook (which releases it on unmount and invalidates saves)',
    );
    assert.match(
      usagePage,
      /const saved = await updateUsage\(\{ range \}\);[\s\S]*if \(!saved \|\| !usagePageMountedRef\.current\) return;[\s\S]*await props\.onReload\(range\);/,
      'Usage range changes must not trigger a stats reload after an unmounted or stale save',
    );
    assert.match(
      usagePage,
      /finally \{[\s\S]*usageRefreshGuard\.finish\(\);[\s\S]*if \(usagePageMountedRef\.current\) \{[\s\S]*setRefreshing\(false\);/,
      'Manual usage refresh cleanup must not write React pending state after unmount',
    );
  });

  it('drops stale usage stats reload responses', async () => {
    const src = await readSettingsCombinedSource();
    const settingsModal = src.match(/function SettingsSurface\([\s\S]*?function SettingsPage/)?.[0];

    assert.ok(settingsModal, 'Settings surface block must exist');
    assert.match(
      settingsModal!,
      /const usageReloadTicketRef = useRef\(0\);/,
      'Usage stats reloads need a latest-response ticket so rapid range changes cannot show stale stats',
    );
    assert.match(
      settingsModal!,
      /async function reloadUsage\(range: UsageRange = settings\.usage\.range\) \{[\s\S]*const ticket = usageReloadTicketRef\.current \+ 1;[\s\S]*usageReloadTicketRef\.current = ticket;[\s\S]*const next = await window\.maka\.settings\.usageStats\(range\);[\s\S]*if \(settingsModalMountedRef\.current && ticket === usageReloadTicketRef\.current\) \{[\s\S]*setUsageStats\(next\);[\s\S]*\}/,
      'Usage stats reloads must only apply the newest response while Settings is still mounted',
    );
    assert.match(
      settingsModal!,
      /catch \(error\) \{[\s\S]*if \(settingsModalMountedRef\.current && ticket === usageReloadTicketRef\.current\) \{[\s\S]*toast\.error\(copy\.usageLoadFailed, settingsActionErrorMessage\(error, locale\)\);[\s\S]*\}/,
      'Stale or unmounted usage reload failures must not toast over a newer range',
    );
  });

  it('gates manual usage refresh and reads the latest draft range', async () => {
    const src = await readSettingsCombinedSource();
    const usagePage = usagePageBlock(src);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(
      usagePage,
      /const usageRefreshGuard = useActionGuard<'refresh'>\(\)/,
      'Manual usage refresh needs a synchronous guard so fast double-clicks cannot duplicate reloads before React disables the button',
    );
    assert.match(
      usagePage,
      /async function refresh\(\) \{\s*if \(!usageRefreshGuard\.begin\('refresh'\)\) return;[\s\S]*await props\.onReload\(usageDraftRef\.current\.range\)/,
      'Manual usage refresh must lock synchronously and read the latest local draft range',
    );
    assert.match(
      usagePage,
      /finally \{[\s\S]*usageRefreshGuard\.finish\(\);[\s\S]*setRefreshing\(false\);[\s\S]*\}/,
      'Manual usage refresh must release the guard after reload settles',
    );
    assert.doesNotMatch(
      usagePage,
      /props\.onReload\(usageDraft\.range\)/,
      'Manual usage refresh must not read stale React state after a just-clicked range change',
    );
    assert.match(usagePage, /aria-busy=\{refreshing\}/, 'Usage refresh button must expose pending state to assistive tech');
    assert.match(usagePage, /data-pending=\{refreshing \? 'true' : undefined\}/, 'Usage refresh button must expose a stable pending hook');
    assert.match(usagePage, /onClick=\{\(\) => void refresh\(\)\}/, 'Usage refresh click handler must explicitly discard the async promise');
  });

  it('does not render raw request status enums in the usage table', async () => {
    const src = await readSettingsCombinedSource();
    const requestsPanel = requestsPanelBlock(src);

    assert.ok(requestsPanel, 'Usage requests panel block must exist');
    assert.match(requestsPanel, /usageRequestStatusLabel\(row\.status, props\.copy\)/);
    assert.match(src, /function usageRequestStatusLabel/);
    assert.match(src, /case 'success': return copy\.tables\.success/);
    assert.match(src, /case 'error': return copy\.tables\.error/);
    assert.doesNotMatch(
      requestsPanel,
      /,\s*row\.status\]/,
      'Usage request table must not render raw `success` / `error` enums directly',
    );
  });

  it('labels model and tool rows without rendering raw request kind enums', async () => {
    const src = await readSettingsCombinedSource();
    const requestsPanel = requestsPanelBlock(src);

    assert.ok(requestsPanel, 'Usage requests panel block must exist');
    // Columns are objects now (per-column alignment); the request log keeps
    // all eight catalog-owned headers in order.
    for (const index of [0, 1, 3, 4, 5, 6, 7]) {
      assert.match(requestsPanel, new RegExp(`header: props\\.copy\\.tables\\.requestHeaders\\[${index}\\]`), `request log must keep header ${index}`);
    }
    assert.match(requestsPanel, /\{ header: props\.copy\.tables\.requestHeaders\[2\], grow: true \}/, 'the target column must absorb slack so numeric columns size to content');
    assert.match(requestsPanel, /usageRequestKindLabel\(row\.kind, props\.copy\)/);
    assert.match(requestsPanel, /usageRequestTarget\(row\)/);
    assert.match(requestsPanel, /usageRequestSessionCell\(row, props\.copy, props\.onOpenSession\)/);
    assert.match(requestsPanel, /row\.kind === 'model' \? `\$\$\{\(row\.costUsd \?\? 0\)\.toFixed\(2\)\}` : '-'/);
    assert.match(src, /case 'model': return copy\.tables\.modelKind/);
    assert.match(src, /case 'tool': return copy\.tables\.toolKind/);
    assert.match(src, /return row\.kind === 'tool' \? row\.toolName \?\? row\.model : row\.model/);
    assert.match(src, /function usageRequestSessionCell/);
    assert.match(src, /onClick=\{\(\) => onOpenSession\(row\.sessionId\)\}/);
    assert.match(src, /\{copy\.tables\.openSession\(label\)\}/);
    assert.match(src, /function shortUsageSessionId/);
    assert.doesNotMatch(
      requestsPanel,
      /,\s*row\.kind\s*,/,
      'Usage request table must not render raw `model` / `tool` enums directly',
    );
  });

  it('wires usage diagnostics rows back to source sessions through the shell', async () => {
    const settingsSrc = await readSettingsCombinedSource();
    const mainSrc = await readRendererShellCombinedSource();

    assert.match(settingsSrc, /onOpenSession\?\(sessionId: string\): void/);
    assert.match(settingsSrc, /onOpenSession=\{props\.onOpenSession\}/);
    assert.match(mainSrc, /onOpenSession=\{props\.onOpenSettingsSession\}/);
    assert.match(mainSrc, /onOpenSettingsSession=\{\(sessionId\) => \{/);
    assert.match(
      mainSrc,
      /closeSettings\(\);[\s\S]*openSessionInChat\(sessionId\);/,
      'opening a session from Settings must switch the shell back to the chat surface before selecting it',
    );
    assert.match(
      mainSrc,
      /function openSessionInChat\(sessionId: string, turnId\?: string\): void \{[\s\S]*setNavSelection\(\{ section: 'sessions', filter: 'chats' \}\);[\s\S]*setActiveId\(sessionId\);/,
      'openSessionInChat must own the shell route + active-session transition',
    );
  });
});
