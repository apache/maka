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

// packages/ui/src/skills-panel.tsx
//
// The Skills module page, on the shared ModulePage shell (Astryx Layout,
// the vendor's incident-console archetype) — the same surface as 定时任务:
//
// - header: title, a live count line, and one overflow menu of page actions;
// - toolbar (the header's last row, fixed): the hub switch, the 市场 / 内置 /
//   已安装 SegmentedControl, search, and the market's category/sort filters;
// - content: dense Astryx List rows, not cards;
// - inspector: selecting an installed row opens it, and every per-skill
//   action lives there (skill-inspector.tsx).
//
// Layout owns scroll containment, so the view switch can never scroll away
// with the list — the bug this page used to ship (#2236) is unrepresentable
// in this structure.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import { useRovingRowFocus } from './use-roving-row-focus.js';
import {
  ICON_SIZE,
  Blocks,
  BookOpen,
  Download,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  RefreshCcw,
  Search,
} from './icons.js';
import type { CapabilityAuditReport } from '@maka/core/capability-audit';
import { deriveCapabilityAuditReport } from '@maka/core/capability-audit';
import {
  Button as UiButton,
  EmptyState,
  IconButton,
  List,
  ListItem,
  SegmentedControl,
  SegmentedControlItem,
  Selector,
  StatusDot,
  Text,
  TextInput,
  Toolbar,
} from '@astryxdesign/core';
import type { SelectorOptionData } from '@astryxdesign/core/Selector';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@astryxdesign/core/DropdownMenu';
import { ModulePage } from './primitives/module-page.js';
import { CapabilityAuditStrip, capabilityAuditIssues } from './capability-audit-strip.js';
import { SkillInspector } from './skill-inspector.js';
import {
  formatSkillLibraryDescription,
  formatSkillStatusLabel,
  skillExceptionalStateLabel,
  skillStatusDotLabel,
  skillStatusDotVariant,
} from './skill-status.js';
import type { ModuleHubHeader } from './module-hub-selector.js';
import type { BundledSkillCatalogEntry, ManagedSkillCategory, ManagedSkillSourceEntry, ManagedSkillUpdatePreview, SkillEntry } from './module-panel-types.js';
import { getSkillsCopy } from './skills-copy.js';
import { useUiLocale } from './locale-context.js';
import { useToast } from './toast.js';

const MARKET_CATEGORY_ALL = '__all__';
type MarketSort = 'name' | 'recent';
type SkillTab = 'market' | 'builtin' | 'installed';

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
  const locale = useUiLocale();
  const copy = getSkillsCopy(locale);
  const toast = useToast();
  const mountedRef = useMountedRef();
  const skills = props.skills ?? [];

  // Designer audit P1-5: land on skills the user can actually run, not the
  // marketplace — every market card is still 即将上线, and leading with
  // things you can't install undermines trust in the whole page.
  const [activeSkillTab, setActiveSkillTab] = useState<SkillTab>(() => (
    skills.length > 0 ? 'installed' : 'builtin'
  ));
  const [skillSearchQuery, setSkillSearchQuery] = useState('');
  const [marketCategory, setMarketCategory] = useState<ManagedSkillCategory | typeof MARKET_CATEGORY_ALL>(MARKET_CATEGORY_ALL);
  const [marketSort, setMarketSort] = useState<MarketSort>('name');
  const [selectedSkillRef, setSelectedSkillRef] = useState<string | null>(null);
  const [updatePreview, setUpdatePreview] = useState<ManagedSkillUpdatePreview | null>(null);
  const [pendingSkillAction, setPendingSkillAction] = useState<string | null>(null);
  const pendingSkillActionRef = useRef<string | null>(null);
  // Set when a delete starts, consumed once the row has actually left the
  // list — which only happens when the main process pushes the new set back.
  const rowsContainerRef = useRef<HTMLDivElement | null>(null);
  const focusRowAfterRemovalRef = useRef<number | null>(null);
  // One tab stop for the whole installed list: without it, reaching the
  // inspector from row k of N costs N−k presses, because the inspector
  // renders after the list and every row is its own stop.
  const rovingRows = useRovingRowFocus(rowsContainerRef);

  useEffect(() => {
    return () => {
      pendingSkillActionRef.current = null;
    };
  }, []);

  // Synchronising focus with the DOM once the list it points into has been
  // re-rendered — an external system, which is what an Effect is for.
  useEffect(() => {
    const index = focusRowAfterRemovalRef.current;
    if (index == null) return;
    focusRowAfterRemovalRef.current = null;
    // A frame later, not now: the confirm dialog is still closing, and Astryx
    // restores focus to ITS trigger — the 删除 button being removed — on the
    // way out. Claiming focus before that lands means losing it again.
    const frame = requestAnimationFrame(() => {
      const rows = rowsContainerRef.current?.querySelectorAll<HTMLElement>('li button');
      if (!rows?.length) return;
      rows[Math.min(index, rows.length - 1)]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [props.skills]);

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
        if (mountedRef.current) setPendingSkillAction(null);
      }
    }
  }

  async function refreshSkillData() {
    await Promise.all([
      props.onRefreshSkills?.(),
      props.onRefreshManagedSkillSources?.(),
      props.onRefreshBundledSkillCatalog?.(),
    ]);
  }

  function runPageActionAfterMenuClose(
    actionKey: string,
    action: (() => void | Promise<void>) | undefined,
  ) {
    window.requestAnimationFrame(() => {
      if (mountedRef.current) void runSkillAction(actionKey, action);
    });
  }

  async function requestDeleteSkill(skill: SkillEntry) {
    if (!props.onDeleteSkill) return;
    const ref = skill.ref ?? skill.id;
    const confirmed = await toast.confirm({
      title: copy.row.confirmDeleteAriaLabel(skill.name),
      description: copy.row.deleteDescription,
      confirmLabel: copy.row.delete,
      cancelLabel: copy.row.cancel,
      destructive: true,
    });
    if (!confirmed || !mountedRef.current) return;
    // The 删除 button is about to unmount with the whole inspector, and
    // nothing else would claim focus — it would fall to `body`, dropping a
    // keyboard user at the top of the document. Hand it to the row that
    // takes the deleted one's place.
    focusRowAfterRemovalRef.current = filteredSkills.findIndex(
      (entry) => (entry.ref ?? entry.id) === ref,
    );
    await runSkillAction(`delete:${ref}`, () => props.onDeleteSkill?.(ref));
    // Drop the selection too — keeping it would reopen the inspector if a
    // skill with the same ref is installed again later, unasked.
    if (mountedRef.current) {
      setSelectedSkillRef((current) => (current === ref ? null : current));
    }
  }

  async function reviewManagedSkillUpdate(skill: SkillEntry) {
    if (!props.onPreviewManagedSkillUpdate) return;
    const preview = await runSkillAction(`managed:review:${skill.id}`, () => props.onPreviewManagedSkillUpdate?.(skill.id));
    if (preview) setUpdatePreview(preview);
  }

  async function applyManagedSkillUpdate(preview: ManagedSkillUpdatePreview) {
    if (!props.onUpdateManagedSkill) return;
    const force = preview.skill.managedUpdateStatus === 'local_modified';
    const updated = await runSkillAction(`managed:update:${preview.skill.id}`, () => props.onUpdateManagedSkill?.(preview.skill.id, {
      ...(force ? { force: true } : {}),
      expectedCurrentSha256: preview.expectedCurrentSha256,
      expectedSourceSha256: preview.expectedSourceSha256,
    }));
    if (updated) setUpdatePreview(null);
  }

  // ── Derived views ────────────────────────────────────────────────────
  const normalizedSkillQuery = skillSearchQuery.trim().toLowerCase();
  const filteredSkills = skills.filter((skill) => {
    if (!normalizedSkillQuery) return true;
    return `${skill.id} ${skill.name} ${skill.description ?? ''} ${skill.path}`.toLowerCase().includes(normalizedSkillQuery);
  });
  const bundledCatalog = props.bundledSkillCatalog ?? [];
  const bundledCatalogFiltered = bundledCatalog.filter((entry) => {
    if (!normalizedSkillQuery) return true;
    return `${entry.id} ${entry.name} ${entry.description} ${entry.category}`.toLowerCase().includes(normalizedSkillQuery);
  });
  /**
   * Built-in skills grouped by category.
   *
   * Structure, not colour, is how a browse surface gets richer: a reader
   * scanning for "something that writes docs" is served by a heading, and no
   * amount of tinting substitutes for one.
   *
   * Guarded twice, because grouping can make a list WORSE. With one category
   * the headings are pure overhead, and while searching the user has already
   * said what they want — splitting the few hits across headings buries them.
   */
  const bundledCatalogGroups = useMemo(() => {
    const byCategory = new Map<ManagedSkillCategory, BundledSkillCatalogEntry[]>();
    for (const entry of bundledCatalogFiltered) {
      const group = byCategory.get(entry.category);
      if (group) group.push(entry);
      else byCategory.set(entry.category, [entry]);
    }
    return [...byCategory.entries()];
  }, [bundledCatalogFiltered]);
  const showBundledGroups = normalizedSkillQuery === '' && bundledCatalogGroups.length > 1;

  const allManagedSources = props.managedSkillSources ?? [];
  // Distinct ids across both catalogs: a skill offered by the marketplace and
  // shipped built-in is one thing you can install, not two.
  const availableToInstallCount = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of bundledCatalog) if (!entry.installed) ids.add(entry.id);
    for (const source of allManagedSources) {
      if (!skills.some((skill) => skill.id === source.id)) ids.add(source.id);
    }
    return ids.size;
  }, [bundledCatalog, allManagedSources, skills]);
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

  // Derived, not stored: whatever hides the row — deletion, a filter, a
  // view switch — closes the inspector without a reconciliation step, and
  // the panel always reads the freshest copy of the skill.
  const selectedSkill = activeSkillTab === 'installed'
    ? filteredSkills.find((skill) => (skill.ref ?? skill.id) === selectedSkillRef) ?? null
    : null;

  // Collision-only slug reveal: when two visible skills share a display name
  // the rows become indistinguishable — surface the slug inline exactly for
  // those rows.
  const skillNameCounts = new Map<string, number>();
  for (const skill of filteredSkills) {
    if (skill.kind === 'discovery_diagnostic') continue;
    skillNameCounts.set(skill.name, (skillNameCounts.get(skill.name) ?? 0) + 1);
  }

  const updateAvailableCount = skills.filter(
    (skill) => skill.managedUpdateStatus === 'update_available' || skill.managedUpdateStatus === 'local_modified',
  ).length;
  const auditReport = props.auditReport ?? deriveCapabilityAuditReport({ skills });
  const skillActionBusy = pendingSkillAction !== null;
  const canRefreshSkillData = Boolean(
    props.onRefreshSkills
    || props.onRefreshManagedSkillSources
    || props.onRefreshBundledSkillCatalog,
  );

  const categoryOptions: SelectorOptionData[] = [
    { value: MARKET_CATEGORY_ALL, label: copy.market.categoryAll },
    ...(Object.keys(copy.categories) as ManagedSkillCategory[]).map((category) => ({
      value: category,
      label: copy.categories[category],
    })),
  ];
  const sortOptions: SelectorOptionData[] = [
    { value: 'name', label: copy.market.sortName },
    { value: 'recent', label: copy.market.sortRecent },
  ];

  // ── Catalog rows (市场 / 内置): one job each — install. ──────────────
  function catalogInstallButton(key: string, name: string, installing: boolean, installed: boolean, onInstall?: () => void) {
    return (
      <IconButton
        key={key}
        variant="secondary"
        size="sm"
        onClick={onInstall}
        isDisabled={installed || skillActionBusy || !onInstall}
        label={copy.install.action(name)}
        tooltip={installed ? copy.install.installedTitle : copy.install.action(name)}
        icon={installing ? <Loader2 size={ICON_SIZE.chrome} aria-hidden="true" /> : <Download size={ICON_SIZE.chrome} aria-hidden="true" />}
      />
    );
  }

  const searchSummary = normalizedSkillQuery ? (
    <div className="maka-module-search-summary" role="status" aria-live="polite">
      <span>{copy.page.searchMatches(
        activeSkillTab === 'market'
          ? marketSources.length
          : activeSkillTab === 'builtin'
            ? bundledCatalogFiltered.length
            : filteredSkills.length,
      )}</span>
      <UiButton variant="ghost" size="sm" onClick={() => setSkillSearchQuery('')} label={copy.market.clearSearch} />
    </div>
  ) : null;

  const marketPanel = (
    <div className="maka-module-page-panel">
      {searchSummary}
      {allManagedSources.length === 0 ? (
        /* With a query in play this is a search empty, so it carries the clear
           action (DESIGN.md §10); without one it stays a plain panel empty. */
        (<EmptyState
          icon={<BookOpen size={ICON_SIZE.empty} />}
          title={normalizedSkillQuery ? copy.market.emptySearchTitle : copy.market.emptyTitle}
          description={normalizedSkillQuery ? copy.market.emptySearchBody : copy.market.emptyBody}
          actions={normalizedSkillQuery ? (
            <UiButton variant="ghost" size="sm" label={copy.market.clearSearch} onClick={() => setSkillSearchQuery('')} />
          ) : undefined}
        />)
      ) : marketSources.length === 0 ? (
        <EmptyState
          icon={<Search size={ICON_SIZE.empty} />}
          title={copy.market.emptySearchTitle}
          description={copy.market.emptyFilterBody}
          actions={(
            <UiButton
              variant="ghost"
              size="sm"
              label={copy.market.clearFilters}
              onClick={() => {
                setMarketCategory(MARKET_CATEGORY_ALL);
                setSkillSearchQuery('');
              }}
            />
          )}
        />
      ) : (
        <List density="balanced" hasDividers className="maka-module-page-rows" aria-label={copy.market.ariaLabel}>
          {marketSources.map((source) => {
            const installed = skills.some((skill) => skill.id === source.id);
            return (
              <ListItem
                key={source.id}
                label={source.name}
                description={[
                  copy.categories[source.category],
                  installed ? copy.install.installed : null,
                  source.description || copy.market.sourceFallback,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                startContent={(
                  <span className="maka-module-market-icon" aria-hidden="true">
                    <Blocks size={ICON_SIZE.empty} />
                  </span>
                )}
                endContent={catalogInstallButton(
                  source.id,
                  source.name,
                  pendingSkillAction === `source:install:${source.id}`,
                  installed,
                  props.onInstallManagedSkill ? () => void runSkillAction(`source:install:${source.id}`, () => props.onInstallManagedSkill?.(source.id)) : undefined,
                )}
              />
            );
          })}
        </List>
      )}
    </div>
  );

  const builtinPanel = (
    <div className="maka-module-page-panel">
      {searchSummary}
      {bundledCatalog.length === 0 ? (
        <EmptyState
          icon={<Blocks size={ICON_SIZE.empty} />}
          title={copy.builtin.emptyTitle}
          description={copy.builtin.emptyBody}
        />
      ) : bundledCatalogFiltered.length === 0 ? (
        <EmptyState
          icon={<Search size={ICON_SIZE.empty} />}
          title={copy.builtin.noMatchTitle}
          description={copy.builtin.noMatchBody}
          actions={<UiButton variant="ghost" size="sm" label={copy.market.clearSearch} onClick={() => setSkillSearchQuery('')} />}
        />
      ) : (
        // One List per category when grouping is on, each carrying its own
        // heading; a single flat List otherwise. `header` is List's own slot,
        // so the heading is associated with its rows rather than floating
        // above them as loose text.
        ((showBundledGroups ? bundledCatalogGroups : [[null, bundledCatalogFiltered] as const]).map(([category, entries]) => (
      <List
        key={category ?? 'all'}
        density="balanced"
        hasDividers
        className="maka-module-page-rows"
        aria-label={category ? copy.categories[category] : copy.builtin.ariaLabel}
        header={category ? <Text type="label" size="sm" color="secondary">{copy.categories[category]}</Text> : undefined}
      >
        {entries.map((entry) => (
          <ListItem
            key={entry.id}
            label={entry.name}
            description={[
              // The category is the group heading when grouping is on;
              // repeating it on every row under that heading is the
              // duplicate-count noise we removed from this page before.
              showBundledGroups ? null : copy.categories[entry.category],
              entry.declaredTools.length > 0
                ? copy.builtin.toolCount(entry.declaredTools.length)
                : null,
              entry.description || copy.builtin.fallback,
            ]
              .filter(Boolean)
              .join(' · ')}
            startContent={(
              <span className="maka-module-market-icon" aria-hidden="true">
                <Blocks size={ICON_SIZE.empty} />
              </span>
            )}
            endContent={catalogInstallButton(
              entry.id,
              entry.name,
              pendingSkillAction === `bundled:install:${entry.id}`,
              entry.installed,
              props.onInstallBundledSkill ? () => void runSkillAction(`bundled:install:${entry.id}`, () => props.onInstallBundledSkill?.(entry.id)) : undefined,
            )}
          />
        ))}
      </List>
        )))
      )}
    </div>
  );

  const installedEmptyBody = `${copy.installed.emptyBodyBeforeCode} SKILL.md ${copy.installed.emptyBodyAfterCode}`;
  const installedPanel = (
    <div className="maka-module-page-panel" ref={rowsContainerRef} {...rovingRows}>
      {/* Selecting a row moves no focus — a mouse user did not ask to leave
          the list — so nothing else would tell a screen reader that the
          details opened. This says so, politely, after whatever the
          activation itself announced. */}
      <p className="maka-visually-hidden" role="status" aria-live="polite">
        {selectedSkill ? copy.detail.inspectorOpened(selectedSkill.name) : ''}
      </p>
      {searchSummary}
      {skills.length === 0 ? (
        <EmptyState
          icon={<Blocks size={ICON_SIZE.empty} />}
          title={normalizedSkillQuery ? copy.installed.emptySearchTitle : copy.installed.emptyTitle}
          description={normalizedSkillQuery ? copy.installed.emptySearchBody : installedEmptyBody}
          actions={(
            // A search that matched nothing exits through clear (DESIGN.md
            // §10); only the true first-run empty offers the refresh.
            (normalizedSkillQuery ? <UiButton variant="ghost" size="sm" label={copy.market.clearSearch} onClick={() => setSkillSearchQuery('')} /> : props.onRefreshSkills
                ? <UiButton variant="ghost" size="sm" label={pendingSkillAction === 'refresh' ? copy.installed.refreshPending : copy.installed.refresh} onClick={() => void runSkillAction('refresh', refreshSkillData)} isDisabled={skillActionBusy} />
                : undefined)
          )}
        />
      ) : filteredSkills.length === 0 ? (
        <EmptyState
          icon={<Search size={ICON_SIZE.empty} />}
          title={copy.installed.emptySearchTitle}
          description={copy.installed.emptySearchBody}
          actions={<UiButton variant="ghost" size="sm" label={copy.market.clearSearch} onClick={() => setSkillSearchQuery('')} />}
        />
      ) : (
        /* Selectable, otherwise inert rows: every control that used to ride
           the row now lives in the inspector — no interactive elements
           inside an interactive list item. */
        (<List density="balanced" hasDividers className="maka-module-page-rows" aria-label={copy.installed.listAriaLabel}>
          {filteredSkills.map((skill) => {
            const isDiscoveryDiagnostic = skill.kind === 'discovery_diagnostic';
            const skillRef = skill.ref ?? skill.id;
            if (isDiscoveryDiagnostic) {
              return (
                <ListItem
                  key={skillRef}
                  label={copy.context.discoverySource(skill.scope ?? 'custom', skill.source ?? 'custom')}
                  description={skill.discoveryDiagnosticReason
                    ? copy.context.discoveryDiagnostic[skill.discoveryDiagnosticReason]
                    : undefined}
                  startContent={(
                    <StatusDot
                      variant="warning"
                      label={skill.discoveryDiagnosticReason
                        ? copy.context.discoveryDiagnostic[skill.discoveryDiagnosticReason]
                        : copy.context.needsReview}
                    />
                  )}
                />
              );
            }
            const exceptional = skillExceptionalStateLabel(skill, copy);
            const description = [
              exceptional,
              formatSkillLibraryDescription(skill, copy),
              skill.scope ? copy.context.scope[skill.scope] : null,
              // The leading label already carries an exceptional source
              // state; repeating it as trailing meta would say it twice.
              exceptional ? null : formatSkillStatusLabel(skill, copy),
            ].filter((value): value is string => Boolean(value)).join(' · ');
            return (
              <ListItem
                key={skillRef}
                label={(
                  <span className="maka-skill-row-label">
                    {skill.name}
                    {(skillNameCounts.get(skill.name) ?? 0) > 1 && (
                      <code className="maka-skill-row-slug">{skill.id}</code>
                    )}
                  </span>
                )}
                description={description}
                startContent={(
                  <StatusDot
                    variant={skillStatusDotVariant(skill)}
                    label={skillStatusDotLabel(skill, copy)}
                  />
                )}
                isSelected={selectedSkillRef === skillRef}
                onClick={() => setSelectedSkillRef(
                  selectedSkillRef === skillRef ? null : skillRef,
                )}
              />
            );
          })}
        </List>)
      )}
    </div>
  );

  return (
    <section className="maka-main detailPane maka-module-main agents-chat-panel" data-page-shell="layout" data-module="skills" aria-label={props.hubHeader?.title ?? copy.page.title}>
      <ModulePage
        title={props.hubHeader?.title ?? copy.page.title}
        // The page header said only how many skills are installed, which made
        // a page whose other two tabs are catalogs look like it had nothing in
        // them. Counting what is available to install is the number a browser
        // is actually looking for.
        meta={[
          copy.page.metaInstalled(skills.length),
          updateAvailableCount > 0 ? copy.page.metaUpdates(updateAvailableCount) : null,
          availableToInstallCount > 0 ? copy.page.metaAvailable(availableToInstallCount) : null,
        ].filter(Boolean).join(' · ')}
        inspectorLabel={copy.detail.label}
        inspectorAutoSaveId="maka-skill-inspector"
        onInspectorDismiss={() => setSelectedSkillRef(null)}
        inspector={selectedSkill ? (
          <SkillInspector
            skill={selectedSkill}
            busy={skillActionBusy}
            opening={pendingSkillAction === `open:${selectedSkill.ref ?? selectedSkill.id}`}
            reviewing={pendingSkillAction === `managed:review:${selectedSkill.id}`}
            updatePreview={updatePreview && updatePreview.skill.id === selectedSkill.id ? updatePreview : null}
            onUse={props.onUseSkill ? () => props.onUseSkill?.(selectedSkill.id, selectedSkill.name) : undefined}
            onSetEnabled={props.onSetSkillEnabled
              ? (enabled) => void runSkillAction(`runtime:set:${selectedSkill.ref ?? selectedSkill.id}`, () => props.onSetSkillEnabled?.(selectedSkill.ref ?? selectedSkill.id, enabled))
              : undefined}
            onTogglePinned={props.onSetSkillPinned
              ? () => void runSkillAction(`runtime:pin:${selectedSkill.ref ?? selectedSkill.id}`, () => props.onSetSkillPinned?.(selectedSkill.ref ?? selectedSkill.id, !selectedSkill.pinned))
              : undefined}
            onOpen={props.onOpenSkill
              ? () => void runSkillAction(`open:${selectedSkill.ref ?? selectedSkill.id}`, () => props.onOpenSkill?.(selectedSkill.ref ?? selectedSkill.id))
              : undefined}
            onPreviewUpdate={props.onPreviewManagedSkillUpdate ? () => void reviewManagedSkillUpdate(selectedSkill) : undefined}
            onApplyUpdate={props.onUpdateManagedSkill && updatePreview ? () => void applyManagedSkillUpdate(updatePreview) : undefined}
            onCancelUpdate={() => setUpdatePreview(null)}
            onDelete={props.onDeleteSkill && selectedSkill.manageable !== false
              ? () => void requestDeleteSkill(selectedSkill)
              : undefined}
          />
        ) : undefined}
        actions={
          props.onOpenSkillsFolder || props.onImportManagedSkillSource || canRefreshSkillData ? (
            <DropdownMenu
              button={{
                label: copy.page.moreActions,
                icon: <MoreHorizontal size={ICON_SIZE.chrome} aria-hidden="true" />,
                isIconOnly: true,
                variant: 'ghost',
                isDisabled: skillActionBusy,
              }}
            >
              {props.onOpenSkillsFolder ? (
                <DropdownMenuItem
                  icon={<FolderOpen size={ICON_SIZE.control} aria-hidden="true" />}
                  label={copy.page.openFolder}
                  onClick={() => runPageActionAfterMenuClose('folder', props.onOpenSkillsFolder)}
                />
              ) : null}
              {props.onImportManagedSkillSource ? (
                <DropdownMenuItem
                  icon={<Download size={ICON_SIZE.control} aria-hidden="true" />}
                  label={copy.market.importLocal}
                  onClick={() => runPageActionAfterMenuClose('source:import', props.onImportManagedSkillSource)}
                />
              ) : null}
              {canRefreshSkillData ? (
                <DropdownMenuItem
                  icon={<RefreshCcw size={ICON_SIZE.control} aria-hidden="true" />}
                  label={pendingSkillAction === 'refresh' ? copy.page.refreshing : copy.page.refresh}
                  onClick={() => runPageActionAfterMenuClose('refresh', refreshSkillData)}
                />
              ) : null}
            </DropdownMenu>
          ) : undefined
        }
        toolbar={(
          <div className="maka-module-page-bar">
            {props.hubHeader?.badge}
            <Toolbar
              size="sm"
              label={copy.page.toolbarAria}
              startContent={(
                <SegmentedControl
                  value={activeSkillTab}
                  onChange={(value) => {
                    if (value !== 'market' && value !== 'builtin' && value !== 'installed') return;
                    // The selection belongs to the view it was made in;
                    // carrying it across would reopen the inspector without
                    // a user action on return.
                    setSelectedSkillRef(null);
                    setActiveSkillTab(value);
                  }}
                  label={copy.tabs.ariaLabel}
                  size="sm"
                >
                  <SegmentedControlItem value="market" label={copy.tabs.market} />
                  <SegmentedControlItem value="builtin" label={copy.tabs.builtin} />
                  <SegmentedControlItem value="installed" label={copy.tabs.installed} />
                </SegmentedControl>
              )}
              endContent={(
                <>
                  <TextInput
                    label={copy.page.search}
                    isLabelHidden
                    width={220}
                    value={skillSearchQuery}
                    onChange={(value) => setSkillSearchQuery(value.slice(0, 120))}
                    placeholder={copy.page.search}
                  />
                  {activeSkillTab === 'market' && allManagedSources.length > 0 ? (
                    <>
                      <Selector
                        value={marketCategory}
                        options={categoryOptions}
                        onChange={(value) => setMarketCategory(value as ManagedSkillCategory | typeof MARKET_CATEGORY_ALL)}
                        label={copy.market.categoryFilter}
                        isLabelHidden
                        width={172}
                      />
                      <Selector
                        value={marketSort}
                        options={sortOptions}
                        onChange={(value) => setMarketSort(value as MarketSort)}
                        label={copy.market.sortAriaLabel}
                        isLabelHidden
                        width={148}
                      />
                    </>
                  ) : null}
                </>
              )}
            />
          </div>
        )}
      >
        {/* The audit strip reports by exception (null when healthy), so its
            panel only exists when it has something to say. */}
        {capabilityAuditIssues(auditReport, locale).length > 0 ? (
          <div className="maka-module-page-panel">
            <CapabilityAuditStrip report={auditReport} />
          </div>
        ) : null}
        {activeSkillTab === 'market' ? marketPanel : null}
        {activeSkillTab === 'builtin' ? builtinPanel : null}
        {activeSkillTab === 'installed' ? installedPanel : null}
      </ModulePage>
    </section>
  );
}
