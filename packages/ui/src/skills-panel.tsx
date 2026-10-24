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
// The Skills module page, on the shared ModulePage shell — the same surface
// as 定时任务:
//
// - header: title, search, refresh and the 添加 menu;
// - toolbar: the hub switch;
// - content: 已安装, then 发现 (built-in and marketplace skills not yet
//   installed), both as Astryx List rows;
// - detail: selecting an installed row opens its dialog, and every per-skill
//   action lives there (skill-detail.tsx).
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
  Download,
  FolderOpen,
  Plus,
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
  Text,
  TextInput,
} from '@astryxdesign/core';
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSubMenu,
} from '@astryxdesign/core/DropdownMenu';
import { ModulePage, ModulePageSection, ModuleRow } from './primitives/module-page.js';
import { StatusLabel } from './status-label.js';
import { CapabilityAuditStrip, capabilityAuditIssues } from './capability-audit-strip.js';
import { skillDetail, skillUpdateReviewDetail, type SkillDetailActions } from './skill-detail.js';
import {
  formatSkillLibraryDescription,
  skillExceptionalStateLabel,
  skillStatusSemantic,
} from './skill-status.js';
import type { ModuleHubHeader } from './module-hub-selector.js';
import type { BundledSkillCatalogEntry, ManagedSkillCategory, ManagedSkillSourceEntry, ManagedSkillUpdatePreview, SkillEntry, SkillLocation, SkillLocationRef } from './module-panel-types.js';
import { getSkillsCopy } from './skills-copy.js';
import { useUiLocale } from './locale-context.js';
import { useToast } from './toast.js';

type DiscoverEntry = {
  id: string;
  name: string;
  description: string;
  category: ManagedSkillCategory;
  actionKey: string;
  install?: () => Promise<void> | void;
};

export function SkillsModuleMain(props: {
  skills?: SkillEntry[];
  hubHeader?: ModuleHubHeader;
  managedSkillSources?: ManagedSkillSourceEntry[];
  bundledSkillCatalog?: BundledSkillCatalogEntry[];
  auditReport?: CapabilityAuditReport;
  skillLocations?: SkillLocation[];
  onRefreshSkills?(): void | Promise<void>;
  onOpenSkill?(skillId: string): void | Promise<void>;
  onUseSkill?(skillId: string, skillName: string): void;
  onOpenSkillLocation?(ref: SkillLocationRef, createIfMissing: boolean): void | Promise<void>;
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
  const skillLocations = props.skillLocations ?? [];

  const [skillSearchQuery, setSkillSearchQuery] = useState('');
  const [selectedSkillRef, setSelectedSkillRef] = useState<string | null>(null);
  const [updatePreview, setUpdatePreview] = useState<ManagedSkillUpdatePreview | null>(null);
  const [pendingSkillAction, setPendingSkillAction] = useState<string | null>(null);
  const pendingSkillActionRef = useRef<string | null>(null);
  // Set when a delete starts, consumed once the row has actually left the
  // list — which only happens when the main process pushes the new set back.
  const rowsContainerRef = useRef<HTMLDivElement | null>(null);
  const focusRowAfterRemovalRef = useRef<number | null>(null);
  // One tab stop for the whole installed list, so tabbing past it costs one press.
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
    // The deleted row cannot take focus back from the closing dialog; the row
    // that takes its place does.
    focusRowAfterRemovalRef.current = filteredSkills.findIndex(
      (entry) => (entry.ref ?? entry.id) === ref,
    );
    await runSkillAction(`delete:${ref}`, () => props.onDeleteSkill?.(ref));
    // Drop the selection too — keeping it would reopen the detail if a
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
  const matchesQuery = (...fields: Array<string | undefined>) => (
    !normalizedSkillQuery || fields.join(' ').toLowerCase().includes(normalizedSkillQuery)
  );
  const filteredSkills = skills.filter((skill) => matchesQuery(skill.id, skill.name, skill.description, skill.path));
  const installedIds = useMemo(() => new Set(skills.map((skill) => skill.id)), [skills]);

  // Built-in and marketplace skills are both "something you can install", so
  // they are one list. An id offered by both is one skill, installed through
  // its built-in entry.
  const discoverEntries = useMemo(() => {
    const entries = new Map<string, DiscoverEntry>();
    for (const entry of props.bundledSkillCatalog ?? []) {
      if (entry.installed || installedIds.has(entry.id)) continue;
      entries.set(entry.id, {
        id: entry.id,
        name: entry.name,
        description: entry.description || copy.discover.builtinFallback,
        category: entry.category,
        actionKey: `bundled:install:${entry.id}`,
        install: props.onInstallBundledSkill ? () => props.onInstallBundledSkill?.(entry.id) : undefined,
      });
    }
    for (const source of props.managedSkillSources ?? []) {
      if (entries.has(source.id) || installedIds.has(source.id)) continue;
      entries.set(source.id, {
        id: source.id,
        name: source.name,
        description: source.description || copy.discover.sourceFallback,
        category: source.category,
        actionKey: `source:install:${source.id}`,
        install: props.onInstallManagedSkill ? () => props.onInstallManagedSkill?.(source.id) : undefined,
      });
    }
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [props.bundledSkillCatalog, props.managedSkillSources, props.onInstallBundledSkill, props.onInstallManagedSkill, installedIds, copy]);
  const filteredDiscover = discoverEntries.filter((entry) => matchesQuery(entry.id, entry.name, entry.description, entry.category));
  // Category headings only help a browse; with one category, or while a
  // search has already narrowed the set, they split a few hits apart.
  const discoverGroups = useMemo(() => {
    const byCategory = new Map<ManagedSkillCategory, DiscoverEntry[]>();
    for (const entry of filteredDiscover) {
      const group = byCategory.get(entry.category);
      if (group) group.push(entry);
      else byCategory.set(entry.category, [entry]);
    }
    return [...byCategory.entries()];
  }, [filteredDiscover]);
  const showDiscoverGroups = normalizedSkillQuery === '' && discoverGroups.length > 1;

  // Derived, not stored: whatever hides the row — deletion or a search —
  // closes the detail without a reconciliation step, and the panel always
  // reads the freshest copy of the skill.
  const selectedSkill = filteredSkills.find((skill) => (skill.ref ?? skill.id) === selectedSkillRef) ?? null;
  const selectedSkillActions: SkillDetailActions | null = selectedSkill ? {
    busy: pendingSkillAction !== null,
    opening: pendingSkillAction === `open:${selectedSkill.ref ?? selectedSkill.id}`,
    reviewing: pendingSkillAction === `managed:review:${selectedSkill.id}`,
    onUse: props.onUseSkill ? () => props.onUseSkill?.(selectedSkill.id, selectedSkill.name) : undefined,
    onSetEnabled: props.onSetSkillEnabled
      ? (enabled) => void runSkillAction(`runtime:set:${selectedSkill.ref ?? selectedSkill.id}`, () => props.onSetSkillEnabled?.(selectedSkill.ref ?? selectedSkill.id, enabled))
      : undefined,
    onTogglePinned: props.onSetSkillPinned
      ? () => void runSkillAction(`runtime:pin:${selectedSkill.ref ?? selectedSkill.id}`, () => props.onSetSkillPinned?.(selectedSkill.ref ?? selectedSkill.id, !selectedSkill.pinned))
      : undefined,
    onOpen: props.onOpenSkill
      ? () => void runSkillAction(`open:${selectedSkill.ref ?? selectedSkill.id}`, () => props.onOpenSkill?.(selectedSkill.ref ?? selectedSkill.id))
      : undefined,
    onPreviewUpdate: props.onPreviewManagedSkillUpdate ? () => void reviewManagedSkillUpdate(selectedSkill) : undefined,
    onApplyUpdate: props.onUpdateManagedSkill && updatePreview ? () => void applyManagedSkillUpdate(updatePreview) : undefined,
    onCancelUpdate: () => setUpdatePreview(null),
    onDelete: props.onDeleteSkill ? () => void requestDeleteSkill(selectedSkill) : undefined,
  } : null;
  const selectedSkillDetail = selectedSkill && selectedSkillActions
    ? updatePreview?.skill.id === selectedSkill.id
      ? skillUpdateReviewDetail(updatePreview, copy, selectedSkillActions)
      : skillDetail(selectedSkill, copy, selectedSkillActions)
    : undefined;

  // Collision-only slug reveal: when two visible skills share a display name
  // the rows become indistinguishable — surface the slug inline exactly for
  // those rows.
  const skillNameCounts = new Map<string, number>();
  for (const skill of filteredSkills) {
    if (skill.kind === 'discovery_diagnostic') continue;
    skillNameCounts.set(skill.name, (skillNameCounts.get(skill.name) ?? 0) + 1);
  }

  const auditReport = props.auditReport ?? deriveCapabilityAuditReport({ skills });
  const skillActionBusy = pendingSkillAction !== null;
  const canRefreshSkillData = Boolean(
    props.onRefreshSkills
    || props.onRefreshManagedSkillSources
    || props.onRefreshBundledSkillCatalog,
  );
  const clearSearch = <UiButton variant="ghost" size="sm" label={copy.page.clearSearch} onClick={() => setSkillSearchQuery('')} />;

  const installedEmptyBody = `${copy.installed.emptyBodyBeforeCode} SKILL.md ${copy.installed.emptyBodyAfterCode}`;
  const installedSection = normalizedSkillQuery && filteredSkills.length === 0 ? null : (
    <ModulePageSection title={copy.page.installed}>
      {skills.length === 0 ? (
        <EmptyState
          icon={<Blocks size={ICON_SIZE.empty} />}
          title={copy.installed.emptyTitle}
          description={installedEmptyBody}
          actions={props.onRefreshSkills
            ? <UiButton variant="ghost" size="sm" label={pendingSkillAction === 'refresh' ? copy.installed.refreshPending : copy.installed.refresh} onClick={() => void runSkillAction('refresh', refreshSkillData)} isDisabled={skillActionBusy} />
            : undefined}
        />
      ) : (
        /* Selectable, otherwise inert rows: every per-skill control lives in
           the detail dialog — no interactive elements inside an interactive
           list item. */
        <div ref={rowsContainerRef} {...rovingRows}>
          <List density="balanced" hasDividers aria-label={copy.installed.listAriaLabel}>
            {filteredSkills.map((skill) => {
              const skillRef = skill.ref ?? skill.id;
              if (skill.kind === 'discovery_diagnostic') {
                const reason = skill.discoveryDiagnosticReason
                  ? copy.context.discoveryDiagnostic[skill.discoveryDiagnosticReason]
                  : copy.context.needsReview;
                return (
                  <ModuleRow
                    key={skillRef}
                    label={copy.context.discoverySource(skill.scope ?? 'custom', skill.source ?? 'custom')}
                    mark={<SkillMark name={skill.source ?? skill.id} />}
                    end={<StatusLabel status="attention" label={reason} />}
                  />
                );
              }
              const exceptional = skillExceptionalStateLabel(skill, copy);
              const description = formatSkillLibraryDescription(skill, copy);
              return (
                <ModuleRow
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
                  mark={<SkillMark name={skill.name} />}
                  end={exceptional
                    ? <StatusLabel status={skillStatusSemantic(skill)} label={exceptional} />
                    : skill.enabled ? undefined : <StatusLabel status="neutral" label={copy.status.disabled} />}
                  isSelected={selectedSkillRef === skillRef}
                  onClick={() => setSelectedSkillRef(skillRef)}
                />
              );
            })}
          </List>
        </div>
      )}
    </ModulePageSection>
  );

  const discoverSection = filteredDiscover.length === 0 ? null : (
    <ModulePageSection title={copy.page.discover}>
      {(showDiscoverGroups ? discoverGroups : [[null, filteredDiscover] as const]).map(([category, entries]) => (
        <List
          key={category ?? 'all'}
          density="balanced"
          hasDividers
          aria-label={category ? copy.categories[category] : copy.page.discover}
          header={category ? <Text type="label" size="sm" color="secondary">{copy.categories[category]}</Text> : undefined}
        >
          {entries.map((entry) => (
            <ModuleRow
              key={entry.id}
              label={entry.name}
              description={entry.description}
              mark={<SkillMark name={entry.name} />}
              end={(
                <UiButton
                  variant="secondary"
                  size="sm"
                  label={copy.install.short}
                  aria-label={copy.install.action(entry.name)}
                  isLoading={pendingSkillAction === entry.actionKey}
                  isDisabled={skillActionBusy || !entry.install}
                  onClick={() => void runSkillAction(entry.actionKey, entry.install)}
                />
              )}
            />
          ))}
        </List>
      ))}
    </ModulePageSection>
  );

  const addMenu = props.onOpenSkillLocation || props.onImportManagedSkillSource ? (
    <DropdownMenu
      button={{
        label: copy.page.add,
        icon: <Plus size={ICON_SIZE.chrome} aria-hidden="true" />,
        variant: 'primary',
        isDisabled: skillActionBusy,
      }}
    >
      {props.onImportManagedSkillSource ? (
        <DropdownMenuItem
          icon={<Download size={ICON_SIZE.control} aria-hidden="true" />}
          label={copy.page.importLocal}
          onClick={() => runPageActionAfterMenuClose('source:import', props.onImportManagedSkillSource)}
        />
      ) : null}
      {props.onOpenSkillLocation && skillLocations.length > 0 ? (
        <DropdownMenuSubMenu
          icon={<FolderOpen size={ICON_SIZE.control} aria-hidden="true" />}
          label={copy.page.locations}
          menuWidth={420}
        >
          {skillLocations.map((location) => {
            const disabled = location.status === 'blocked_path' || location.status === 'read_failed';
            const endContent = location.status === 'available'
              ? copy.locations.count(location.skillCount)
              : location.status === 'missing'
                ? copy.locations.missing
                : location.status === 'blocked_path'
                  ? copy.locations.blocked
                  : copy.locations.readFailed;
            return (
              <DropdownMenuItem
                key={location.ref}
                icon={<FolderOpen size={ICON_SIZE.control} aria-hidden="true" />}
                label={copy.locations.labels[location.ref]}
                description={location.path}
                endContent={endContent}
                isDisabled={disabled}
                onClick={() => runPageActionAfterMenuClose(
                  `location:${location.ref}`,
                  () => props.onOpenSkillLocation?.(
                    location.ref,
                    location.status === 'missing',
                  ),
                )}
              />
            );
          })}
        </DropdownMenuSubMenu>
      ) : null}
    </DropdownMenu>
  ) : null;

  return (
    <section className="maka-main detailPane maka-module-main agents-chat-panel" data-page-shell="layout" data-module="skills" aria-label={props.hubHeader?.title ?? copy.page.title}>
      <ModulePage
        title={props.hubHeader?.title ?? copy.page.title}
        onDetailDismiss={() => {
          setSelectedSkillRef(null);
          setUpdatePreview(null);
        }}
        detail={selectedSkillDetail}
        actions={(
          <div className="maka-module-main-actions" role="group" aria-label={copy.page.actionsAria}>
            <TextInput
              label={copy.page.search}
              isLabelHidden
              width={220}
              startIcon={Search}
              value={skillSearchQuery}
              onChange={(value) => setSkillSearchQuery(value.slice(0, 120))}
              placeholder={copy.page.search}
            />
            {canRefreshSkillData ? (
              <IconButton
                variant="ghost"
                label={pendingSkillAction === 'refresh' ? copy.page.refreshing : copy.page.refresh}
                tooltip={copy.page.refresh}
                onClick={() => void runSkillAction('refresh', refreshSkillData)}
                isDisabled={skillActionBusy}
                icon={<RefreshCcw size={ICON_SIZE.chrome} aria-hidden="true" />}
              />
            ) : null}
            {addMenu}
          </div>
        )}
        toolbar={props.hubHeader?.badge ? <div className="maka-module-page-bar">{props.hubHeader.badge}</div> : undefined}
      >
        <div className="maka-module-page-panel">
          {/* The audit strip reports by exception (null when healthy). */}
          {capabilityAuditIssues(auditReport, locale).length > 0 ? <CapabilityAuditStrip report={auditReport} /> : null}
          {normalizedSkillQuery ? (
            <div className="maka-module-search-summary" role="status" aria-live="polite">
              <span>{copy.page.searchMatches(filteredSkills.length + filteredDiscover.length)}</span>
              {clearSearch}
            </div>
          ) : null}
          {normalizedSkillQuery && filteredSkills.length === 0 && filteredDiscover.length === 0 ? (
            <EmptyState
              icon={<Search size={ICON_SIZE.empty} />}
              title={copy.installed.emptySearchTitle}
              description={copy.installed.emptySearchBody}
              actions={clearSearch}
            />
          ) : (
            <>
              {installedSection}
              {discoverSection}
            </>
          )}
        </div>
      </ModulePage>
    </section>
  );
}

/** Skills carry no icon of their own; the initial gives each row an anchor. */
function SkillMark({ name }: { name: string }) {
  return (
    <span className="maka-module-market-icon" aria-hidden="true">
      <span>{Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?'}</span>
    </span>
  );
}
