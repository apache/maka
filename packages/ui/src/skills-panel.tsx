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
  Plus,
  Search,
  Trash2,
} from './icons.js';
import type { CapabilityAuditReport } from '@maka/core';
import { deriveCapabilityAuditReport } from '@maka/core';
import { Button as UiButton, Switch, TabsRoot, TabsList, TabsTrigger, TabsPanel } from './ui.js';
import { Chip, type ChipProps } from './primitives/chip.js';
import { PageHeader } from './primitives/page-header.js';
import { Input } from './primitives/input.js';
import { SettingsSelect, type SettingsSelectOption } from './primitives/settings-select.js';
import { EmptyState } from './empty-state.js';
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
  onCreateSkillTemplate?(): void | Promise<void>;
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
  createPending?: boolean;
  openingSkillId?: string | null;
  installingSourceId?: string | null;
  updatingSkillId?: string | null;
  togglingSkillId?: string | null;
  deletingSkillId?: string | null;
  searchQuery?: string;
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
  const skillListEmptyBody: ReactNode = normalizedSkillQuery ? copy.installed.emptySearchBody : (
    <>
      {copy.installed.emptyBodyBeforeCode} <code className="maka-empty-state-code">SKILL.md</code>{' '}
      {copy.installed.emptyBodyAfterCode}
    </>
  );
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

  const categoryOptions: ReadonlyArray<SettingsSelectOption<ManagedSkillCategory | typeof MARKET_CATEGORY_ALL>> = [
    [MARKET_CATEGORY_ALL, copy.market.categoryAll],
    ...marketCategories.map((category) => [category, copy.categories[category]] as const),
  ];
  const sortOptions: ReadonlyArray<SettingsSelectOption<MarketSort>> = [
    ['name', copy.market.sortName],
    ['recent', copy.market.sortRecent],
  ];
  const marketControls = activeSkillTab === 'market' && allManagedSources.length > 0 ? (
    <div className="maka-skill-market-controls" role="group" aria-label={copy.market.controls}>
      <SettingsSelect<ManagedSkillCategory | typeof MARKET_CATEGORY_ALL>
        value={marketCategory}
        options={categoryOptions}
        onChange={(value) => setMarketCategory(value)}
        ariaLabel={copy.market.categoryFilter}
        width="full"
        className="maka-skill-market-select"
      />
      <SettingsSelect<MarketSort>
        value={marketSort}
        options={sortOptions}
        onChange={(value) => setMarketSort(value)}
        ariaLabel={copy.market.sortAriaLabel}
        width="full"
        className="maka-skill-market-select"
      />
    </div>
  ) : null;

  const tabs = (
    <div className="maka-skill-tabs-bar">
      <TabsList variant="underline" className="maka-skill-tabs" aria-label={copy.tabs.ariaLabel}>
        {([
          ['market', copy.tabs.market, allManagedSources.length],
          ['builtin', copy.tabs.builtin, bundledCatalog.length],
          ['installed', copy.tabs.installed, installedSkills.length],
        ] as const).map(([tab, label, count]) => (
          <TabsTrigger
            key={tab}
            className="maka-skill-tab"
            value={tab}
          >
            {label}
            <span>{count}</span>
          </TabsTrigger>
        ))}
      </TabsList>
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
              type="button"
              variant="secondary"
              size="sm"
              onClick={props.onImportManagedSkillSource}
              disabled={!props.onImportManagedSkillSource || props.actionBusy}
            >
              {copy.market.importLocal}
            </UiButton>
          </div>
        }
      />
      {allManagedSources.length === 0 ? (
        <EmptyState
          Icon={BookOpen}
          title={normalizedSkillQuery ? copy.market.emptySearchTitle : copy.market.emptyTitle}
          body={normalizedSkillQuery
            ? copy.market.emptySearchBody
            : copy.market.emptyBody}
          extraClassName="maka-skill-installed-empty"
        />
      ) : marketSources.length === 0 ? (
        <EmptyState
          Icon={Search}
          title={copy.market.emptySearchTitle}
          body={copy.market.emptyFilterBody}
          extraClassName="maka-skill-installed-empty"
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
                    <small>{source.id}</small>
                  </div>
                  {/* + install acts; the card itself is inert (honest
                      affordance). Disabled once the source is in the
                      workspace, so it reads as a real state, not a toggle. */}
                  <UiButton
                    type="button"
                    variant="secondary"
                    size="icon-sm"
                    onClick={() => props.onInstallManagedSkill?.(source.id)}
                    disabled={installed || props.actionBusy || !props.onInstallManagedSkill}
                    aria-label={copy.install.action(source.name)}
                    title={installed ? copy.install.installedTitle : copy.install.action(source.name)}
                  >
                    {installing ? <Loader2 size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
                  </UiButton>
                </div>
                <p>{description}</p>
                <div className="maka-skill-market-card-foot">
                  <Chip size="sm" variant="neutral" className="maka-skill-market-category">{copy.categories[source.category]}</Chip>
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
          Icon={Blocks}
          title={copy.builtin.emptyTitle}
          body={copy.builtin.emptyBody}
          extraClassName="maka-skill-installed-empty"
        />
      ) : bundledCatalogFiltered.length === 0 ? (
        <EmptyState
          Icon={Search}
          title={copy.builtin.noMatchTitle}
          body={copy.builtin.noMatchBody}
          extraClassName="maka-skill-installed-empty"
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
                    <small>{entry.id}</small>
                  </div>
                  {/* Install copies the shipped body into the workspace. Disabled
                      once installed, so the button reads as a state, not a toggle. */}
                  <UiButton
                    type="button"
                    variant="secondary"
                    size="icon-sm"
                    onClick={() => props.onInstallBundledSkill?.(entry.id)}
                    disabled={entry.installed || props.actionBusy || !props.onInstallBundledSkill}
                    aria-label={copy.install.action(entry.name)}
                    title={entry.installed ? copy.install.installedTitle : copy.install.action(entry.name)}
                  >
                    {installing ? <Loader2 size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
                  </UiButton>
                </div>
                <p>{description}</p>
                <div className="maka-skill-market-card-foot">
                  <Chip size="sm" variant="neutral" className="maka-skill-market-category">{copy.categories[entry.category]}</Chip>
                  <span>{entry.installed ? copy.install.installed : copy.install.notInstalled}</span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );

  const skillList = (list: SkillEntry[], emptyTitle: string, emptyBody: ReactNode, label: string) => (
    <section className="maka-skill-installed" aria-label={label}>
      {list.length === 0 ? (
        <EmptyState
          Icon={Blocks}
          title={emptyTitle}
          body={emptyBody}
          cta={props.onCreateSkillTemplate ? {
            label: props.createPending ? copy.installed.createPending : copy.installed.createExample,
            onClick: props.onCreateSkillTemplate,
            disabled: props.actionBusy,
          } : undefined}
          secondaryCta={props.onRefreshSkills ? {
            label: props.refreshPending ? copy.installed.refreshPending : copy.installed.refresh,
            onClick: props.onRefreshSkills,
            disabled: props.actionBusy,
          } : undefined}
          extraClassName="maka-skill-installed-empty"
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
                          <span className="maka-skill-library-slug">{skill.id}</span>
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
                        <Chip size="sm" variant="warning" className="maka-skill-library-runtime-label" data-status={skill.runtimeStatus}>{runtimeLabel}</Chip>
                      )}
                      {skill.scope && (
                        <Chip size="sm" variant="neutral" className="maka-skill-library-scope-label" data-scope={skill.scope}>
                          {copy.context.scope[skill.scope]}
                        </Chip>
                      )}
                      {skill.needsReview && (
                        <Chip
                          size="sm"
                          variant="warning"
                          className="maka-skill-library-review-label"
                          title={copy.context.needsReviewTitle}
                        >
                          {copy.context.needsReview}
                        </Chip>
                      )}
                      <Chip
                        size="sm"
                        variant={contextStatus === 'advertised' ? 'neutral' : 'warning'}
                        className="maka-skill-library-context-label"
                        data-status={contextStatus}
                      >
                        {isDiscoveryDiagnostic && skill.discoveryDiagnosticReason
                          ? copy.context.discoveryDiagnostic[skill.discoveryDiagnosticReason]
                          : copy.context.decision[contextStatus]}
                        {!isDiscoveryDiagnostic && skill.contextRank ? ` #${skill.contextRank}` : ''}
                      </Chip>
                      {!isDiscoveryDiagnostic && (
                        <Chip size="sm" variant={skillStatusChipTone(skill)} className="maka-skill-library-status-label" data-status={skill.managedUpdateStatus ?? skill.validationStatus ?? skill.sourceType ?? 'workspace'}>{statusLabel}</Chip>
                      )}
                      {opening && <span>{copy.row.opening}</span>}
                      {updating && <span>{copy.row.updating}</span>}
                      {toggling && <span>{copy.row.toggling}</span>}
                      {reviewing && <span>{copy.row.reviewing}</span>}
                    </span>
                  </div>
                  {!isDiscoveryDiagnostic && props.onUseSkill && skill.enabled && contextStatus !== 'shadowed' && (
                    <UiButton
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="maka-skill-library-use-button"
                      onClick={() => props.onUseSkill?.(skill.id, skill.name)}
                      disabled={props.actionBusy}
                      aria-label={copy.row.useAriaLabel(skill.name)}
                    >
                      {copy.row.use}
                    </UiButton>
                  )}
                  {!isDiscoveryDiagnostic && (
                    <>
                      <UiButton
                        type="button"
                        variant="secondary"
                        size="icon-sm"
                        className="maka-skill-library-open-button"
                        onClick={() => props.onOpenSkill?.(skillRef)}
                        disabled={props.actionBusy || !props.onOpenSkill}
                        aria-label={copy.row.openAriaLabel(skill.name)}
                        title={copy.row.openTitle}
                      >
                        {opening ? <Loader2 size={15} aria-hidden="true" /> : <FileEdit size={15} aria-hidden="true" />}
                      </UiButton>
                      <Switch
                        className="maka-skill-library-runtime-switch"
                        checked={skill.enabled}
                        disabled={props.actionBusy || !canToggleSkill}
                        aria-label={skill.enabled ? copy.row.disableAriaLabel(skill.name) : copy.row.enableAriaLabel(skill.name)}
                        title={skill.runtimeStatus === 'state_error' ? copy.row.stateErrorTitle : skill.enabled ? copy.row.enabledTitle : copy.row.disabledTitle}
                        onCheckedChange={(next) => props.onSetSkillEnabled?.(skillRef, next === true)}
                      />
                    </>
                  )}
                  {!isDiscoveryDiagnostic && props.onSetSkillPinned && (
                    <UiButton
                      type="button"
                      variant="secondary"
                      size="icon-sm"
                      className="maka-skill-library-pin-button"
                      onClick={() => props.onSetSkillPinned?.(skillRef, !skill.pinned)}
                      disabled={
                        props.actionBusy ||
                        skill.runtimeStatus === 'state_error' ||
                        contextStatus === 'invalid'
                      }
                      aria-label={skill.pinned ? copy.row.unpinAriaLabel(skill.name) : copy.row.pinAriaLabel(skill.name)}
                      title={skill.pinned ? copy.row.unpinTitle : copy.row.pinTitle}
                    >
                      {skill.pinned ? <PinOff size={15} aria-hidden="true" /> : <Pin size={15} aria-hidden="true" />}
                    </UiButton>
                  )}
                  {!isDiscoveryDiagnostic && reviewableManagedUpdate && props.onPreviewManagedSkillUpdate && (
                    <UiButton
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void reviewManagedSkillUpdate(skill)}
                      disabled={props.actionBusy || reviewingSkillId !== null}
                    >
                      {reviewing ? copy.row.reviewing : skill.managedUpdateStatus === 'local_modified' ? copy.row.viewDiff : copy.row.viewUpdate}
                    </UiButton>
                  )}
                  {!isDiscoveryDiagnostic && props.onDeleteSkill && skill.manageable !== false && (
                    <UiButton
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="maka-skill-library-delete-button"
                      data-confirming={confirmingDelete ? 'true' : undefined}
                      onClick={() => requestDeleteSkill(skill)}
                      disabled={props.actionBusy && !deleting}
                      aria-label={confirmingDelete ? copy.row.confirmDeleteAriaLabel(skill.name) : copy.row.deleteAriaLabel(skill.name)}
                    >
                      {deleting ? <Loader2 size={15} aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
                      {confirmingDelete ? copy.row.confirmDelete : copy.row.delete}
                    </UiButton>
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
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setUpdatePreview(null)}
          disabled={props.actionBusy}
        >
          {copy.review.cancel}
        </UiButton>
        <UiButton
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void applyManagedSkillUpdate(updatePreview)}
          disabled={props.actionBusy || !props.onUpdateManagedSkill}
        >
          {updatePreview.skill.managedUpdateStatus === 'local_modified' ? copy.review.overwrite : copy.review.update}
        </UiButton>
      </div>
    </section>
  ) : null;

  return (
    <div className="maka-skill-library" aria-busy={props.actionBusy ? 'true' : undefined}>
      {banner}
      <TabsRoot value={activeSkillTab} onValueChange={(v) => setActiveSkillTab(v as 'market' | 'builtin' | 'installed')}>
        {tabs}
        <TabsPanel value="market">{market}</TabsPanel>
        <TabsPanel value="builtin">{builtinCatalog}</TabsPanel>
        <TabsPanel value="installed">
          {skillList(installedSkills, skillListEmptyTitle, skillListEmptyBody, copy.installed.sectionLabel)}
          {updateReview}
        </TabsPanel>
      </TabsRoot>
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

// Derive the source-status Chip tone from the same data-status the retired
// .maka-skill-library-status-label CSS keyed off. Exception-only: 内置 / 本地
// (expected states) stay neutral; only genuine attention states carry a tone.
//   metadata_error / local_modified → warning (needs the user's attention)
//   受管理 (managed base) → info (managed but nothing wrong)
//   bundled / workspace default → neutral
function skillStatusChipTone(skill: SkillEntry): ChipProps['variant'] {
  if (skill.validationStatus === 'metadata_error') return 'warning';
  if (skill.sourceType === 'managed') {
    if (skill.managedUpdateStatus === 'local_modified' || skill.managedUpdateStatus === 'metadata_error') return 'warning';
    return 'info';
  }
  return 'neutral';
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
  onCreateSkillTemplate?(): void | Promise<void>;
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
  const skillCreateLegacyLabel = pendingSkillAction === 'create' ? copy.page.creating : copy.page.createExample;
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
          <label className="maka-skill-search" aria-label={copy.page.search}>
            <Search size={15} aria-hidden="true" />
            <Input
              unstyled
              value={skillSearchQuery}
              onChange={(event) => setSkillSearchQuery(event.currentTarget.value)}
              maxLength={120}
              placeholder={copy.page.search}
            />
          </label>
          <UiButton
            className="maka-skill-header-utility"
            variant="secondary"
            type="button"
            onClick={() => void runSkillAction('folder', props.onOpenSkillsFolder)}
            disabled={!props.onOpenSkillsFolder || skillActionBusy}
          >
            {copy.page.openFolder}
          </UiButton>
          {/* Detail round 6: the page CTA is a REAL primary (variant default,
              same recipe as daily-review's 生成每日回顾) — previously a ghost
              re-skinned by CSS into a hardcoded black-gradient pill (theme-leak
              literals + off-family radius). */}
          <UiButton
            variant="default"
            type="button"
            onClick={() => void runSkillAction('create', props.onCreateSkillTemplate)}
            disabled={!props.onCreateSkillTemplate || skillActionBusy}
          >
            <Plus size={15} aria-hidden="true" />
            {pendingSkillAction === 'create' ? copy.page.creating : copy.page.add}
            <span className="maka-visually-hidden">{skillCreateLegacyLabel}</span>
          </UiButton>
          <UiButton
            className="maka-skill-header-utility"
            variant="secondary"
            type="button"
            onClick={() => void runSkillAction('refresh', props.onRefreshSkills)}
            disabled={!props.onRefreshSkills || skillActionBusy}
          >
            {pendingSkillAction === 'refresh' ? copy.page.refreshing : copy.page.refresh}
          </UiButton>
        </div>
        }
      />
      <CapabilityAuditStrip report={auditReport} />
      <SkillLibraryPanel
        skills={props.skills}
        managedSkillSources={props.managedSkillSources}
        bundledSkillCatalog={props.bundledSkillCatalog}
        onRefreshSkills={props.onRefreshSkills ? () => runSkillAction('refresh', props.onRefreshSkills) : undefined}
        onCreateSkillTemplate={props.onCreateSkillTemplate ? () => runSkillAction('create', props.onCreateSkillTemplate) : undefined}
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
        createPending={pendingSkillAction === 'create'}
        openingSkillId={pendingSkillAction?.startsWith('open:') ? pendingSkillAction.slice('open:'.length) : null}
        installingSourceId={pendingSkillAction?.startsWith('source:install:') ? pendingSkillAction.slice('source:install:'.length) : null}
        installingBundledId={pendingSkillAction?.startsWith('bundled:install:') ? pendingSkillAction.slice('bundled:install:'.length) : null}
        updatingSkillId={pendingSkillAction?.startsWith('managed:update:') ? pendingSkillAction.slice('managed:update:'.length) : null}
        togglingSkillId={pendingSkillAction?.startsWith('runtime:set:') ? pendingSkillAction.slice('runtime:set:'.length) : null}
        deletingSkillId={pendingSkillAction?.startsWith('delete:') ? pendingSkillAction.slice('delete:'.length) : null}
        searchQuery={skillSearchQuery}
      />
    </main>
  );
}
