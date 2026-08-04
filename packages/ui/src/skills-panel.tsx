import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import {
  Blocks,
  BookOpen,
  Download,
  FileEdit,
  Loader2,
  Pin,
  PinOff,
  Search,
  Trash2,
} from './icons.js';
import type { CapabilityAuditReport } from '@maka/core';
import { deriveCapabilityAuditReport } from '@maka/core';
import {
  Badge,
  Button as UiButton,
  EmptyState,
  IconButton,
  Switch,
  Tab,
  TabList,
  Token,
} from '@astryxdesign/core';
import { PageHeader } from './primitives/page-header.js';
import { TextInput } from '@astryxdesign/core';
import {
  Selector,
  type SelectorOptionData,
} from '@astryxdesign/core/Selector';
import { SectionHeader } from './primitives/section-header.js';
import { CapabilityAuditStrip } from './capability-audit-strip.js';
import type { ModuleHubHeader } from './module-hub-selector.js';
import type { BundledSkillCatalogEntry, ManagedSkillCategory, ManagedSkillSourceEntry, ManagedSkillUpdatePreview, SkillEntry } from './module-panel-types.js';
import { getSkillsCopy, type SkillsCopy } from './skills-copy.js';
import { useUiLocale } from './locale-context.js';

// 市场 tab client-side filter/sort controls. Both are pure renderer
// state — the managed-source list itself is fetched once over IPC.
const MARKET_CATEGORY_ALL = '__all__';
type MarketSort = 'name' | 'recent';

const SKILL_UPDATE_PREVIEW_MAX_LINES = 80;
const DELETE_CONFIRM_TIMEOUT_MS = 4_000;

function SkillLibraryPanel(props: {
  skills?: SkillEntry[];
  onRefreshSkills?(): void | Promise<void>;
  onOpenSkill?(skillId: string): void | Promise<void>;
  onUseSkill?(skillId: string, skillName: string): void;
  onImportManagedSkillSource?(): void | Promise<void>;
  onInstallManagedSkill?(sourceId: string): void | Promise<void>;
  onPreviewManagedSkillUpdate?(skillId: string): Promise<ManagedSkillUpdatePreview | null>;
  onUpdateManagedSkill?(skillId: string, options?: { force?: boolean; expectedCurrentSha256?: string; expectedSourceSha256?: string }): boolean | Promise<boolean>;
  onSetSkillEnabled?(skillId: string, enabled: boolean): void | Promise<void>;
  onSetSkillPinned?(skillRef: string, pinned: boolean): void | Promise<void>;
  onDeleteSkill?(skillRef: string): void | Promise<void>;
  actionBusy?: boolean;
  refreshPending?: boolean;
  openingSkillId?: string | null;
  installingSourceId?: string | null;
  updatingSkillId?: string | null;
  togglingSkillId?: string | null;
  deletingSkillId?: string | null;
  searchQuery?: string;
  /** Clears the module-header search box (owned by the outer panel). */
  onClearSearch?: () => void;
  managedSkillSources?: ManagedSkillSourceEntry[];
  bundledSkillCatalog?: BundledSkillCatalogEntry[];
  onInstallBundledSkill?(id: string): void | Promise<void>;
  installingBundledId?: string | null;
}) {
  const copy = getSkillsCopy(useUiLocale());
  const marketCategories = Object.keys(copy.categories) as ManagedSkillCategory[];
  const skillCount = props.skills?.length ?? 0;
  // Designer audit P1-5: land on skills the user can actually run, not the
  // marketplace — every market card is still 即将上线, and leading with
  // things you can't install undermines trust in the whole page.
  const [activeSkillTab, setActiveSkillTab] = useState<'market' | 'builtin' | 'installed'>(() => {
    const skills = props.skills ?? [];
    // Land on 已安装 when the user already has skills in the workspace;
    // otherwise open on 内置, the always-populated shipped catalog.
    if (skills.length > 0) return 'installed';
    return 'builtin';
  });
  const [updatePreview, setUpdatePreview] = useState<ManagedSkillUpdatePreview | null>(null);
  const [reviewingSkillId, setReviewingSkillId] = useState<string | null>(null);
  // Two-step in-place delete confirm (no dialog precedent in this panel): the
  // first click arms 确认删除 on that row; a second click within the window
  // deletes. The timeout reverts the armed state so a stray first click can't
  // linger as a hot destructive control.
  const [confirmingDeleteSkillId, setConfirmingDeleteSkillId] = useState<string | null>(null);
  const deleteConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (deleteConfirmTimerRef.current) clearTimeout(deleteConfirmTimerRef.current);
  }, []);
  function clearDeleteConfirmTimer() {
    if (deleteConfirmTimerRef.current) {
      clearTimeout(deleteConfirmTimerRef.current);
      deleteConfirmTimerRef.current = null;
    }
  }
  // Keyed by ref, not id: the same skill id can be discovered in more than one
  // scope, and an id-keyed confirm would arm the delete on every copy at once.
  function requestDeleteSkill(skill: SkillEntry) {
    if (!props.onDeleteSkill) return;
    const ref = skill.ref ?? skill.id;
    if (confirmingDeleteSkillId !== ref) {
      clearDeleteConfirmTimer();
      setConfirmingDeleteSkillId(ref);
      deleteConfirmTimerRef.current = setTimeout(() => setConfirmingDeleteSkillId(null), DELETE_CONFIRM_TIMEOUT_MS);
      return;
    }
    clearDeleteConfirmTimer();
    setConfirmingDeleteSkillId(null);
    void props.onDeleteSkill(ref);
  }
  const [marketCategory, setMarketCategory] = useState<ManagedSkillCategory | typeof MARKET_CATEGORY_ALL>(MARKET_CATEGORY_ALL);
  const [marketSort, setMarketSort] = useState<MarketSort>('name');
  const normalizedSkillQuery = props.searchQuery?.trim().toLowerCase() ?? '';
  const filteredSkills = (props.skills ?? []).filter((skill) => {
    if (!normalizedSkillQuery) return true;
    return `${skill.id} ${skill.name} ${skill.description ?? ''} ${skill.path}`.toLowerCase().includes(normalizedSkillQuery);
  });
  // 内置 = the shipped catalog (install-on-demand cards); 已安装 = everything
  // actually present in the workspace, regardless of source. A skill installed
  // from the 内置 catalog therefore shows as 已安装 on its catalog card AND as a
  // manageable (toggle/open) row under 已安装 — the same dual surface the 市场
  // install flow already has.
  const bundledCatalog = props.bundledSkillCatalog ?? [];
  const bundledCatalogFiltered = bundledCatalog.filter((entry) => {
    if (!normalizedSkillQuery) return true;
    return `${entry.id} ${entry.name} ${entry.description} ${entry.category}`.toLowerCase().includes(normalizedSkillQuery);
  });
  const installedSkills = filteredSkills;
  const contextCounts = (props.skills ?? []).reduce(
    (counts, skill) => {
      if (skill.kind === 'discovery_diagnostic') return counts;
      counts.discovered += 1;
      const status = skill.contextStatus ?? (skill.enabled ? 'advertised' : 'disabled');
      if (status === 'advertised') counts.advertised += 1;
      if (status === 'budget') counts.omitted += 1;
      if (status === 'shadowed') counts.shadowed += 1;
      return counts;
    },
    { discovered: 0, advertised: 0, omitted: 0, shadowed: 0 },
  );
  // Collision-only slug reveal: the slug normally lives in the row tooltip,
  // but when two visible skills share a display name (e.g. repeated starter
  // templates from old builds) the rows become indistinguishable — surface
  // the slug inline exactly for those rows.
  const skillNameCounts = new Map<string, number>();
  for (const skill of filteredSkills) {
    if (skill.kind === 'discovery_diagnostic') continue;
    skillNameCounts.set(skill.name, (skillNameCounts.get(skill.name) ?? 0) + 1);
  }
  const allManagedSources = props.managedSkillSources ?? [];
  // 市场 tab: managed sources are the marketplace catalog. Search (shared
  // header field), category dropdown, and sort are all pure client-side —
  // the list is fetched once over IPC. Sort 最近 (order preserved from the
  // IPC list, which main already sorts by name) vs 名称 (explicit A→Z).
  const marketSources = useMemo(() => {
    const filtered = allManagedSources.filter((source) => {
      if (marketCategory !== MARKET_CATEGORY_ALL && source.category !== marketCategory) return false;
      if (!normalizedSkillQuery) return true;
      return `${source.id} ${source.name} ${source.description} ${source.category}`.toLowerCase().includes(normalizedSkillQuery);
    });
    if (marketSort === 'name') {
      return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    }
    return filtered;
  }, [allManagedSources, marketCategory, marketSort, normalizedSkillQuery]);
  const skillListEmptyTitle = normalizedSkillQuery ? copy.installed.emptySearchTitle : copy.installed.emptyTitle;
  const skillListEmptyBody = normalizedSkillQuery
    ? copy.installed.emptySearchBody
    : `${copy.installed.emptyBodyBeforeCode} SKILL.md ${copy.installed.emptyBodyAfterCode}`;
  async function reviewManagedSkillUpdate(skill: SkillEntry) {
    if (!props.onPreviewManagedSkillUpdate || reviewingSkillId !== null) return;
    setReviewingSkillId(skill.id);
    try {
      const preview = await props.onPreviewManagedSkillUpdate(skill.id);
      if (preview) setUpdatePreview(preview);
    } finally {
      setReviewingSkillId(null);
    }
  }

  async function applyManagedSkillUpdate(preview: ManagedSkillUpdatePreview) {
    if (!props.onUpdateManagedSkill) return;
    const force = preview.skill.managedUpdateStatus === 'local_modified';
    const updated = await props.onUpdateManagedSkill(preview.skill.id, {
      ...(force ? { force: true } : {}),
      expectedCurrentSha256: preview.expectedCurrentSha256,
      expectedSourceSha256: preview.expectedSourceSha256,
    });
    if (updated) setUpdatePreview(null);
  }

  const categoryOptions: SelectorOptionData[] = [
    { value: MARKET_CATEGORY_ALL, label: copy.market.categoryAll },
    ...marketCategories.map((category) => ({
      value: category,
      label: copy.categories[category],
    })),
  ];
  const sortOptions: SelectorOptionData[] = [
    { value: 'name', label: copy.market.sortName },
    { value: 'recent', label: copy.market.sortRecent },
  ];
  const marketControls = activeSkillTab === 'market' && allManagedSources.length > 0 ? (
    <div className="maka-skill-market-controls" role="group" aria-label={copy.market.controls}>
      <div className="maka-skill-market-select">
        <Selector
          value={marketCategory}
          options={categoryOptions}
          onChange={(value) => setMarketCategory(value as ManagedSkillCategory | typeof MARKET_CATEGORY_ALL)}
          label={copy.market.categoryFilter}
          isLabelHidden
          width="100%"
        />
      </div>
      <div className="maka-skill-market-select">
        <Selector
          value={marketSort}
          options={sortOptions}
          onChange={(value) => setMarketSort(value as MarketSort)}
          label={copy.market.sortAriaLabel}
          isLabelHidden
          width="100%"
        />
      </div>
    </div>
  ) : null;

  const tabs = (
    <div className="maka-skill-tabs-bar">
      <TabList
        value={activeSkillTab}
        onChange={(value) => setActiveSkillTab(value as typeof activeSkillTab)}
        hasDivider
        aria-label={copy.tabs.ariaLabel}
      >
        {([
          ['market', copy.tabs.market, allManagedSources.length],
          ['builtin', copy.tabs.builtin, bundledCatalog.length],
          ['installed', copy.tabs.installed, installedSkills.length],
        ] as const).map(([tab, label, count]) => (
          <Tab
            key={tab}
            value={tab}
            label={label}
            endContent={<span>{count}</span>}
          />
        ))}
      </TabList>
      {/* Marketplace launch: real client-side category + sort controls on
          the tab row's right side (market tab only). The old static 全部 /
          排序：热门 pills were dead chrome; these drive marketSources. */}
      {marketControls}
    </div>
  );

  const banner = (
    <section className="maka-skill-featured-banner" data-skills-banner aria-label={copy.banner.ariaLabel}>
      <div>
        <h3>{copy.banner.title}</h3>
        <p>{copy.banner.body}</p>
      </div>
      <div className="maka-skill-featured-art" aria-hidden="true">
        <span>
          <FileEdit size={22} />
          <strong>{copy.banner.review}</strong>
          <small>{copy.banner.reviewDetail}</small>
        </span>
        <span>
          <BookOpen size={22} />
          <strong>{copy.banner.documents}</strong>
          <small>{copy.banner.documentsDetail}</small>
        </span>
        <span>
          <Blocks size={22} />
          <strong>{copy.banner.publish}</strong>
          <small>{copy.banner.publishDetail}</small>
        </span>
      </div>
    </section>
  );

  const market = (
    <section className="maka-skill-market" aria-label={copy.market.ariaLabel}>
      <SectionHeader
        className="maka-skill-section-row"
        title={<span className="maka-skill-section-label">{copy.market.official}</span>}
        action={
          <div className="maka-skill-filter-actions" aria-label={copy.market.sourceActions}>
            <UiButton
              variant="secondary"
              size="sm"
              onClick={props.onImportManagedSkillSource}
              isDisabled={!props.onImportManagedSkillSource || props.actionBusy}
              label={copy.market.importLocal}
            />
          </div>
        }
      />
      {allManagedSources.length === 0 ? (
        <EmptyState
          icon={<BookOpen />}
          title={normalizedSkillQuery ? copy.market.emptySearchTitle : copy.market.emptyTitle}
          description={normalizedSkillQuery
            ? copy.market.emptySearchBody
            : copy.market.emptyBody}
          actions={normalizedSkillQuery && props.onClearSearch
            ? <UiButton variant="ghost" size="sm" label={copy.market.clearSearch} onClick={props.onClearSearch} />
            : undefined}
          className="maka-skill-installed-empty"
        />
      ) : marketSources.length === 0 ? (
        <EmptyState
          icon={<Search />}
          title={copy.market.emptySearchTitle}
          description={copy.market.emptyFilterBody}
          actions={(
            <UiButton
              variant="ghost"
              size="sm"
              label={copy.market.clearFilters}
              onClick={() => {
                setMarketCategory(MARKET_CATEGORY_ALL);
                props.onClearSearch?.();
              }}
            />
          )}
          className="maka-skill-installed-empty"
        />
      ) : (
        <div className="maka-skill-market-grid">
          {marketSources.map((source) => {
            const installed = (props.skills ?? []).some((skill) => skill.id === source.id);
            const installing = props.installingSourceId === source.id;
            const description = source.description || copy.market.sourceFallback;
            return (
              <article key={source.id} className="maka-skill-market-card">
                <div className="maka-skill-market-card-head">
                  <span className="maka-skill-market-icon" aria-hidden="true">
                    <Blocks size={18} />
                  </span>
                  <div className="maka-skill-market-card-title">
                    <h3>{source.name}</h3>
                    {/* The source id is an identifier, not an aside — and it
                        is the markup, not a call-site font-family, that puts
                        it in the code family now. */}
                    <code>{source.id}</code>
                  </div>
                  {/* + install acts; the card itself is inert (honest
                      affordance). Disabled once the source is in the
                      workspace, so it reads as a real state, not a toggle. */}
                  <IconButton
                    variant="secondary"
                    size="sm"
                    onClick={() => props.onInstallManagedSkill?.(source.id)}
                    isDisabled={installed || props.actionBusy || !props.onInstallManagedSkill}
                    label={copy.install.action(source.name)}
                    tooltip={installed ? copy.install.installedTitle : copy.install.action(source.name)}
                    icon={installing ? <Loader2 size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
                  />
                </div>
                <p>{description}</p>
                <div className="maka-skill-market-card-foot">
                  <Token size="sm" className="maka-skill-market-category" label={copy.categories[source.category]} />
                  <span>{installed ? copy.install.installed : copy.install.notInstalled}</span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );

  const builtinCatalog = (
    <section className="maka-skill-market" aria-label={copy.builtin.ariaLabel}>
      <SectionHeader
        className="maka-skill-section-row"
        title={<span className="maka-skill-section-label">{copy.builtin.title}</span>}
      />
      {bundledCatalog.length === 0 ? (
        <EmptyState
          icon={<Blocks />}
          title={copy.builtin.emptyTitle}
          description={copy.builtin.emptyBody}
          className="maka-skill-installed-empty"
        />
      ) : bundledCatalogFiltered.length === 0 ? (
        <EmptyState
          icon={<Search />}
          title={copy.builtin.noMatchTitle}
          description={copy.builtin.noMatchBody}
          actions={props.onClearSearch
            ? <UiButton variant="ghost" size="sm" label={copy.market.clearSearch} onClick={props.onClearSearch} />
            : undefined}
          className="maka-skill-installed-empty"
        />
      ) : (
        <div className="maka-skill-market-grid">
          {bundledCatalogFiltered.map((entry) => {
            const installing = props.installingBundledId === entry.id;
            const description = entry.description || copy.builtin.fallback;
            return (
              <article key={entry.id} className="maka-skill-market-card">
                <div className="maka-skill-market-card-head">
                  <span className="maka-skill-market-icon" aria-hidden="true">
                    <Blocks size={18} />
                  </span>
                  <div className="maka-skill-market-card-title">
                    <h3>{entry.name}</h3>
                    <code>{entry.id}</code>
                  </div>
                  {/* Install copies the shipped body into the workspace. Disabled
                      once installed, so the button reads as a state, not a toggle. */}
                  <IconButton
                    variant="secondary"
                    size="sm"
                    onClick={() => props.onInstallBundledSkill?.(entry.id)}
                    isDisabled={entry.installed || props.actionBusy || !props.onInstallBundledSkill}
                    label={copy.install.action(entry.name)}
                    tooltip={entry.installed ? copy.install.installedTitle : copy.install.action(entry.name)}
                    icon={installing ? <Loader2 size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
                  />
                </div>
                <p>{description}</p>
                <div className="maka-skill-market-card-foot">
                  <Token size="sm" className="maka-skill-market-category" label={copy.categories[entry.category]} />
                  <span>{entry.installed ? copy.install.installed : copy.install.notInstalled}</span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );

  const skillList = (list: SkillEntry[], emptyTitle: string, emptyBody: string, label: string) => (
    <section className="maka-skill-installed" aria-label={label}>
      {list.length === 0 ? (
        <EmptyState
          icon={<Blocks />}
          title={emptyTitle}
          description={emptyBody}
          actions={(
            props.onRefreshSkills
              ? <UiButton variant="ghost" label={props.refreshPending ? copy.installed.refreshPending : copy.installed.refresh} onClick={props.onRefreshSkills} isDisabled={props.actionBusy} />
              : undefined
          )}
          className="maka-skill-installed-empty"
        />
      ) : (
        <>
          <aside className="maka-skill-context-inspector" aria-label={copy.context.title}>
            <strong>{copy.context.title}</strong>
            <span>{copy.context.summary(
              contextCounts.discovered,
              contextCounts.advertised,
              contextCounts.omitted,
              contextCounts.shadowed,
            )}</span>
          </aside>
          <SectionHeader
            className="maka-skill-section-row"
            title={<span className="maka-skill-section-label">{label}</span>}
            count={copy.installed.count(list.length)}
          />
          <ul className="maka-skill-library-list" aria-label={copy.installed.listAriaLabel}>
            {list.map((skill) => {
              const isDiscoveryDiagnostic = skill.kind === 'discovery_diagnostic';
              const skillRef = skill.ref ?? skill.id;
              const contextStatus = skill.contextStatus ?? (skill.enabled ? 'advertised' : 'disabled');
              const tools = skill.declaredTools ?? [];
              const toolsLabel = tools.length > 0 ? tools.join(', ') : '';
              const displayName = isDiscoveryDiagnostic
                ? copy.context.discoverySource(skill.scope ?? 'custom', skill.source ?? 'custom')
                : skill.name;
              const description =
                isDiscoveryDiagnostic && skill.discoveryDiagnosticReason
                  ? copy.context.discoveryDiagnostic[skill.discoveryDiagnosticReason]
                  : formatSkillLibraryDescription(skill, copy);
              const statusLabel = formatSkillStatusLabel(skill, copy);
              const runtimeLabel = formatSkillRuntimeLabel(skill, copy);
              const contextLabel = `${isDiscoveryDiagnostic && skill.discoveryDiagnosticReason
                ? copy.context.discoveryDiagnostic[skill.discoveryDiagnosticReason]
                : copy.context.decision[contextStatus]}${!isDiscoveryDiagnostic && skill.contextRank ? ` #${skill.contextRank}` : ''}`;
              const contextNeedsAttention = isDiscoveryDiagnostic || (contextStatus !== 'advertised' && contextStatus !== 'disabled');
              const sourceStatusNeedsAttention = !isDiscoveryDiagnostic && skillSourceStatusNeedsAttention(skill);
              const supportingMeta = [
                skill.scope ? copy.context.scope[skill.scope] : null,
                contextNeedsAttention ? null : contextLabel,
                !isDiscoveryDiagnostic && !sourceStatusNeedsAttention ? statusLabel : null,
              ].filter((value): value is string => Boolean(value));
              const opening = props.openingSkillId === skillRef;
              const updating = props.updatingSkillId === skill.id;
              const toggling = props.togglingSkillId === skillRef;
              const reviewing = reviewingSkillId === skill.id;
              const deleting = props.deletingSkillId === skillRef;
              const confirmingDelete = confirmingDeleteSkillId === skillRef;
              const reviewableManagedUpdate = skill.managedUpdateStatus === 'update_available' || skill.managedUpdateStatus === 'local_modified';
              const canToggleSkill =
                !isDiscoveryDiagnostic &&
                Boolean(props.onSetSkillEnabled) &&
                skill.runtimeStatus !== 'state_error' &&
                contextStatus !== 'invalid';
              const hoverText = isDiscoveryDiagnostic
                ? `${displayName}\n\n${description}\n${skill.path}`
                : tools.length > 0
                  ? copy.row.hoverWithTools(skill.id, runtimeLabel, statusLabel, toolsLabel)
                  : copy.row.hover(skill.id, runtimeLabel, statusLabel);
              return (
                <li key={skillRef} className="maka-skill-library-item" data-runtime-status={skill.runtimeStatus} data-context-status={contextStatus}>
                  <div
                    className="maka-skill-library-row"
                    title={hoverText}
                  >
                    <span className="maka-skill-library-status" aria-hidden="true">
                      <Blocks size={16} />
                    </span>
                    <span className="maka-skill-library-copy">
                      <span className="maka-skill-library-name">
                        {displayName}
                        {!isDiscoveryDiagnostic && (skillNameCounts.get(skill.name) ?? 0) > 1 && (
                          <code className="maka-skill-library-slug">{skill.id}</code>
                        )}
                      </span>
                      {description && (
                        <span className="maka-skill-library-description">{description}</span>
                      )}
                    </span>
                    <span className="maka-skill-library-meta">
                      {/* Marketplace redesign: the slug moved into the row's
                          title tooltip (技能：${skill.id}) — the reference row
                          shows only name + description. The status chips below
                          stay (exception-only tone). */}
                      {/* Detail round 6, exception-only: the adjacent Switch
                          already says enabled/disabled — the visible chip only
                          appears for states the switch can't express
                          (state_error). 已启用/已停用 stay in the hover text. */}
                      {skill.runtimeStatus === 'state_error' && (
                        <Badge variant="warning" className="maka-skill-library-runtime-label" data-status={skill.runtimeStatus} label={runtimeLabel} />
                      )}
                      {supportingMeta.length > 0 && (
                        <span className="maka-skill-library-supporting">{supportingMeta.join(' · ')}</span>
                      )}
                      {skill.needsReview && (
                        <Badge
                          variant="warning"
                          className="maka-skill-library-review-label"
                          label={copy.context.needsReview}
                        />
                      )}
                      {contextNeedsAttention && (
                        <Badge
                          variant="warning"
                          className="maka-skill-library-context-exception"
                          data-status={contextStatus}
                          label={contextLabel}
                        />
                      )}
                      {sourceStatusNeedsAttention && (
                        <Badge variant="warning" className="maka-skill-library-status-label" data-status={skill.managedUpdateStatus ?? skill.validationStatus ?? skill.sourceType ?? 'workspace'} label={statusLabel} />
                      )}
                      {opening && <span>{copy.row.opening}</span>}
                      {updating && <span>{copy.row.updating}</span>}
                      {toggling && <span>{copy.row.toggling}</span>}
                      {reviewing && <span>{copy.row.reviewing}</span>}
                    </span>
                  </div>
                  {!isDiscoveryDiagnostic && props.onUseSkill && skill.enabled && contextStatus !== 'shadowed' && (
                    <UiButton
                      variant="secondary"
                      size="sm"
                      className="maka-skill-library-use-button"
                      onClick={() => props.onUseSkill?.(skill.id, skill.name)}
                      isDisabled={props.actionBusy}
                      aria-label={copy.row.useAriaLabel(skill.name)}
                      label={copy.row.use}
                    />
                  )}
                  {!isDiscoveryDiagnostic && (
                    <>
                      <IconButton
                        variant="secondary"
                        size="sm"
                        className="maka-skill-library-open-button"
                        onClick={() => props.onOpenSkill?.(skillRef)}
                        isDisabled={props.actionBusy || !props.onOpenSkill}
                        label={copy.row.openAriaLabel(skill.name)}
                        tooltip={copy.row.openTitle}
                        icon={opening ? <Loader2 size={15} aria-hidden="true" /> : <FileEdit size={15} aria-hidden="true" />}
                      />
                      <Switch
                        className="maka-skill-library-runtime-switch"
                        value={skill.enabled}
                        isDisabled={props.actionBusy || !canToggleSkill}
                        label={skill.enabled ? copy.row.disableAriaLabel(skill.name) : copy.row.enableAriaLabel(skill.name)}
                        isLabelHidden
                        disabledMessage={skill.runtimeStatus === 'state_error'
                          ? copy.row.stateErrorTitle
                          : undefined}
                        onChange={(next) => props.onSetSkillEnabled?.(skillRef, next)}
                      />
                    </>
                  )}
                  {!isDiscoveryDiagnostic && props.onSetSkillPinned && (
                    <IconButton
                      variant="secondary"
                      size="sm"
                      className="maka-skill-library-pin-button"
                      onClick={() => props.onSetSkillPinned?.(skillRef, !skill.pinned)}
                      isDisabled={
                        props.actionBusy ||
                        skill.runtimeStatus === 'state_error' ||
                        contextStatus === 'invalid'
                      }
                      label={skill.pinned ? copy.row.unpinAriaLabel(skill.name) : copy.row.pinAriaLabel(skill.name)}
                      tooltip={skill.pinned ? copy.row.unpinTitle : copy.row.pinTitle}
                      icon={skill.pinned ? <PinOff size={15} aria-hidden="true" /> : <Pin size={15} aria-hidden="true" />}
                    />
                  )}
                  {!isDiscoveryDiagnostic && reviewableManagedUpdate && props.onPreviewManagedSkillUpdate && (
                    <UiButton
                      variant="secondary"
                      size="sm"
                      onClick={() => void reviewManagedSkillUpdate(skill)}
                      isDisabled={props.actionBusy || reviewingSkillId !== null}
                      label={reviewing ? copy.row.reviewing : skill.managedUpdateStatus === 'local_modified' ? copy.row.viewDiff : copy.row.viewUpdate}
                    />
                  )}
                  {!isDiscoveryDiagnostic && props.onDeleteSkill && skill.manageable !== false && (
                    <UiButton
                      variant="secondary"
                      size="sm"
                      className="maka-skill-library-delete-button"
                      data-confirming={confirmingDelete ? 'true' : undefined}
                      onClick={() => requestDeleteSkill(skill)}
                      isDisabled={props.actionBusy && !deleting}
                      aria-label={confirmingDelete ? copy.row.confirmDeleteAriaLabel(skill.name) : copy.row.deleteAriaLabel(skill.name)}
                      icon={deleting ? <Loader2 size={15} aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
                      label={confirmingDelete ? copy.row.confirmDelete : copy.row.delete}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );

  const updateReview = updatePreview ? (
    <section className="maka-skill-governance-review" aria-label={copy.review.ariaLabel}>
      <SectionHeader
        className="maka-skill-section-row"
        title={<span className="maka-skill-section-label">{copy.review.title}</span>}
        count={formatSkillStatusLabel(updatePreview.skill, copy)}
      />
      <div className="maka-skill-governance-summary">
        <span>{updatePreview.skill.name}</span>
        <span>{updatePreview.skill.managedSourceId ? copy.review.source(updatePreview.skill.managedSourceId) : copy.review.managedSource}</span>
        <span>{updatePreview.skill.hasManagedBaseline ? copy.review.hasBaseline : copy.review.missingBaseline}</span>
        <span>{copy.review.lineTransition(updatePreview.summary.currentLineCount, updatePreview.summary.sourceLineCount)}</span>
        <span>{copy.review.changedLines(updatePreview.summary.changedLineCount)}</span>
      </div>
      {updatePreview.skill.managedUpdateStatus === 'local_modified' && (
        <p className="maka-skill-governance-warning">
          {copy.review.warning}
        </p>
      )}
      <div className="maka-skill-diff-grid">
        <div>
          <span>{copy.review.workspace}</span>
          <pre>{previewText(updatePreview.currentContent)}</pre>
        </div>
        <div>
          <span>{copy.review.sourceVersion}</span>
          <pre>{previewText(updatePreview.sourceContent)}</pre>
        </div>
      </div>
      <div className="maka-skill-governance-actions">
        <UiButton
          variant="ghost"
          size="sm"
          onClick={() => setUpdatePreview(null)}
          isDisabled={props.actionBusy}
          label={copy.review.cancel}
        />
        <UiButton
          variant="secondary"
          size="sm"
          onClick={() => void applyManagedSkillUpdate(updatePreview)}
          isDisabled={props.actionBusy || !props.onUpdateManagedSkill}
          label={updatePreview.skill.managedUpdateStatus === 'local_modified' ? copy.review.overwrite : copy.review.update}
        />
      </div>
    </section>
  ) : null;

  return (
    <div className="maka-skill-library" aria-busy={props.actionBusy ? 'true' : undefined}>
      {banner}
      {tabs}
      {activeSkillTab === 'market' ? market : null}
      {activeSkillTab === 'builtin' ? builtinCatalog : null}
      {activeSkillTab === 'installed' ? (
        <div>
          {skillList(installedSkills, skillListEmptyTitle, skillListEmptyBody, copy.installed.sectionLabel)}
          {updateReview}
        </div>
      ) : null}
      {props.skills && props.skills.length > 0 ? (
        <span className="maka-skill-tool-summary-hidden" aria-hidden="true">
          {copy.installed.summary(skillCount, new Set((props.skills ?? []).flatMap((skill) => skill.declaredTools ?? [])).size)}
        </span>
      ) : null}
    </div>
  );
}

function formatSkillLibraryDescription(skill: SkillEntry, copy: SkillsCopy): string | undefined {
  const raw = skill.description?.trim();
  if (!raw) return undefined;
  if (/[\u3400-\u9fff]/.test(raw)) return raw;

  const source = `${skill.id} ${skill.name} ${raw}`.toLowerCase();
  if (source.includes('docx') || source.includes('word') || source.includes('google docs')) {
    return copy.description.document;
  }
  if (source.includes('ppt') || source.includes('powerpoint') || source.includes('slide') || source.includes('presentation')) {
    return copy.description.presentation;
  }
  if (source.includes('spreadsheet') || source.includes('excel') || source.includes('csv') || source.includes('xlsx')) {
    return copy.description.spreadsheet;
  }
  if (source.includes('image') || source.includes('photo') || source.includes('bitmap')) {
    return copy.description.image;
  }
  if (source.includes('browser') || source.includes('chrome') || source.includes('web target')) {
    return copy.description.browser;
  }
  if (source.includes('macos') || source.includes('swiftui') || source.includes('appkit')) {
    return copy.description.macos;
  }
  return copy.description.fallback;
}

function formatSkillStatusLabel(skill: SkillEntry, copy: SkillsCopy): string {
  if (skill.validationStatus === 'metadata_error') return copy.status.metadataError;
  if (skill.sourceType === 'managed') {
    return copy.status.managed[skill.managedUpdateStatus ?? 'up_to_date'];
  }
  if (skill.userModified) return copy.status.modified;
  if (skill.sourceType === 'bundled') return copy.status.bundled;
  return copy.status.local;
}

function formatSkillRuntimeLabel(skill: SkillEntry, copy: SkillsCopy): string {
  if (skill.runtimeStatus === 'state_error') return copy.status.stateError;
  return skill.enabled ? copy.status.enabled : copy.status.disabled;
}

function skillSourceStatusNeedsAttention(skill: SkillEntry): boolean {
  if (skill.validationStatus && skill.validationStatus !== 'ok') return true;
  if (skill.userModified) return true;
  if (skill.sourceType !== 'managed') return false;
  return skill.managedUpdateStatus !== undefined
    && skill.managedUpdateStatus !== 'not_managed'
    && skill.managedUpdateStatus !== 'up_to_date';
}

function previewText(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const clipped = lines.slice(0, SKILL_UPDATE_PREVIEW_MAX_LINES).join('\n');
  return lines.length > SKILL_UPDATE_PREVIEW_MAX_LINES ? `${clipped}\n...` : clipped;
}



export function SkillsModuleMain(props: {
  skills?: SkillEntry[];
  hubHeader?: ModuleHubHeader;
  managedSkillSources?: ManagedSkillSourceEntry[];
  bundledSkillCatalog?: BundledSkillCatalogEntry[];
  auditReport?: CapabilityAuditReport;
  onRefreshSkills?(): void | Promise<void>;
  onOpenSkill?(skillId: string): void | Promise<void>;
  onUseSkill?(skillId: string, skillName: string): void;
  onOpenSkillsFolder?(): void | Promise<void>;
  onRefreshManagedSkillSources?(): void | Promise<void>;
  onRefreshBundledSkillCatalog?(): void | Promise<void>;
  onImportManagedSkillSource?(): void | Promise<void>;
  onInstallManagedSkill?(sourceId: string): void | Promise<void>;
  onInstallBundledSkill?(id: string): void | Promise<void>;
  onPreviewManagedSkillUpdate?(skillId: string): Promise<ManagedSkillUpdatePreview | null>;
  onUpdateManagedSkill?(skillId: string, options?: { force?: boolean; expectedCurrentSha256?: string; expectedSourceSha256?: string }): boolean | Promise<boolean>;
  onSetSkillEnabled?(skillId: string, enabled: boolean): void | Promise<void>;
  onSetSkillPinned?(skillRef: string, pinned: boolean): void | Promise<void>;
  onDeleteSkill?(skillRef: string): void | Promise<void>;
}) {
  const copy = getSkillsCopy(useUiLocale());
  const [pendingSkillAction, setPendingSkillAction] = useState<string | null>(null);
  const [skillSearchQuery, setSkillSearchQuery] = useState('');
  const skillActionMountedRef = useMountedRef();
  const pendingSkillActionRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      pendingSkillActionRef.current = null;
    };
  }, []);

  async function runSkillAction<Result>(
    actionKey: string,
    action: (() => Result | Promise<Result>) | undefined,
  ) {
    if (!action || pendingSkillActionRef.current !== null) return undefined;
    pendingSkillActionRef.current = actionKey;
    setPendingSkillAction(actionKey);
    try {
      return await action();
    } finally {
      if (pendingSkillActionRef.current === actionKey) {
        pendingSkillActionRef.current = null;
        if (skillActionMountedRef.current) setPendingSkillAction(null);
      }
    }
  }

  const skillActionBusy = pendingSkillAction !== null;
  const auditReport = props.auditReport ?? deriveCapabilityAuditReport({ skills: props.skills ?? [] });
  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" aria-label={props.hubHeader?.title ?? copy.page.title}>
      <PageHeader
        className="maka-module-main-header"
        as="h2"
        title={props.hubHeader?.title ?? copy.page.title}
        subtitle={props.hubHeader?.subtitle ?? copy.page.subtitle}
        badge={props.hubHeader?.badge}
        headingRowClassName={props.hubHeader ? 'maka-module-hub-heading' : undefined}
        actions={
        <div className="maka-module-main-actions" role="group" aria-label={copy.page.actions}>
          <div className="maka-skill-search">
            <TextInput
              label={copy.page.search}
              isLabelHidden
              width="100%"
              startIcon={<Search size={15} aria-hidden="true" />}
              value={skillSearchQuery}
              onChange={(value) => setSkillSearchQuery(value.slice(0, 120))}
              placeholder={copy.page.search}
            />
          </div>
          {/* clickAction draws the in-flight state on the button itself, so
              刷新 stops renaming itself to 刷新中… . `pendingSkillAction` stays:
              it is what tells the library below which row is busy, which is a
              pane-wide fact no single button holds. */}
          <UiButton
            className="maka-skill-header-utility"
            variant="secondary"
            clickAction={() => runSkillAction('folder', props.onOpenSkillsFolder)}
            isDisabled={!props.onOpenSkillsFolder || skillActionBusy}
            label={copy.page.openFolder}
          />
          <UiButton
            className="maka-skill-header-utility"
            variant="secondary"
            clickAction={() => runSkillAction('refresh', props.onRefreshSkills)}
            isDisabled={!props.onRefreshSkills || skillActionBusy}
            label={copy.page.refresh}
          />
        </div>
        }
      />
      <CapabilityAuditStrip report={auditReport} />
      <SkillLibraryPanel
        skills={props.skills}
        managedSkillSources={props.managedSkillSources}
        bundledSkillCatalog={props.bundledSkillCatalog}
        onRefreshSkills={props.onRefreshSkills ? () => runSkillAction('refresh', props.onRefreshSkills) : undefined}
        onOpenSkill={props.onOpenSkill ? (skillId) => runSkillAction(`open:${skillId}`, () => props.onOpenSkill?.(skillId)) : undefined}
        onImportManagedSkillSource={props.onImportManagedSkillSource ? () => runSkillAction('source:import', props.onImportManagedSkillSource) : undefined}
        onInstallManagedSkill={props.onInstallManagedSkill ? (sourceId) => runSkillAction(`source:install:${sourceId}`, () => props.onInstallManagedSkill?.(sourceId)) : undefined}
        onInstallBundledSkill={props.onInstallBundledSkill ? (id) => runSkillAction(`bundled:install:${id}`, () => props.onInstallBundledSkill?.(id)) : undefined}
        onPreviewManagedSkillUpdate={props.onPreviewManagedSkillUpdate}
        onUpdateManagedSkill={props.onUpdateManagedSkill ? async (skillId, options) =>
          (await runSkillAction(`managed:update:${skillId}`, () => props.onUpdateManagedSkill?.(skillId, options))) === true : undefined}
        onSetSkillEnabled={props.onSetSkillEnabled ? (skillId, enabled) => runSkillAction(`runtime:set:${skillId}`, () => props.onSetSkillEnabled?.(skillId, enabled)) : undefined}
        onSetSkillPinned={props.onSetSkillPinned ? (skillRef, pinned) => runSkillAction(`runtime:pin:${skillRef}`, () => props.onSetSkillPinned?.(skillRef, pinned)) : undefined}
        onDeleteSkill={props.onDeleteSkill ? (skillId) => runSkillAction(`delete:${skillId}`, () => props.onDeleteSkill?.(skillId)) : undefined}
        onUseSkill={props.onUseSkill}
        actionBusy={skillActionBusy}
        refreshPending={pendingSkillAction === 'refresh'}
        openingSkillId={pendingSkillAction?.startsWith('open:') ? pendingSkillAction.slice('open:'.length) : null}
        installingSourceId={pendingSkillAction?.startsWith('source:install:') ? pendingSkillAction.slice('source:install:'.length) : null}
        installingBundledId={pendingSkillAction?.startsWith('bundled:install:') ? pendingSkillAction.slice('bundled:install:'.length) : null}
        updatingSkillId={pendingSkillAction?.startsWith('managed:update:') ? pendingSkillAction.slice('managed:update:'.length) : null}
        togglingSkillId={pendingSkillAction?.startsWith('runtime:set:') ? pendingSkillAction.slice('runtime:set:'.length) : null}
        deletingSkillId={pendingSkillAction?.startsWith('delete:') ? pendingSkillAction.slice('delete:'.length) : null}
        searchQuery={skillSearchQuery}
        onClearSearch={() => setSkillSearchQuery('')}
      />
    </main>
  );
}
