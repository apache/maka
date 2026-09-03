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

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import type { ProjectRecord } from '@maka/core/project';
import type { SessionSummary } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  ICON_SIZE,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  FolderOpen,
  Pencil,
  Pin,
  PinOff,
  Plug,
  SquarePen,
} from './icons.js';
import { RelativeTime } from './relative-time.js';
import { formatAbsoluteTimestamp } from '@maka/core/relative-time';
import { Badge } from '@astryxdesign/core/Badge';
import { useHoverCard, type HoverCardReturn } from '@astryxdesign/core/HoverCard';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import {
  SideNavItem,
  SideNavSection,
} from '@astryxdesign/core/SideNav';
import { VStack } from '@astryxdesign/core/Stack';
import { StatusDot, type StatusDotVariant } from '@astryxdesign/core/StatusDot';
import { describeBlockedReason, presentSessionStatus } from './session-status-presentation.js';
import { dotForStatus } from './status-vocabulary.js';
import { SessionRenameDialog, type SessionRenameTarget } from './session-rename-dialog.js';
import {
  type SessionRailData,
  useSessionRailData,
  useSessionRailSelection,
  type SessionRailSelectionCommands,
  type SessionRowPick,
} from './session-rail-context.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';
import { getSessionHoverCardCopy } from './session-hover-card-copy.js';

type SessionRowActionId = 'flag' | 'archive' | 'rename';
type ProjectRowActionId = 'new' | 'relink' | 'rename' | 'archive' | 'restore';
type SessionHistoryGroupVariant = 'conversation' | 'project';

const SIDEBAR_HOVER_CARD_DELAY_MS = 300;
const SIDEBAR_HOVER_CARD_HIDE_DELAY_MS = 120;

/**
 * Attach a hover card without feeding its positioning ref through SideNavItem.
 *
 * SideNavItem merges the consumer ref with an internal popover ref. The latter
 * changes on selection renders, which makes React detach and reattach every
 * merged ref and churns the CSS anchor name. Positioning is immutable for a
 * mounted row, while interaction listeners may follow the hook's latest
 * callbacks, so keep those two lifecycles separate here.
 */
function useSidebarHoverCardTrigger(
  containerRef: RefObject<HTMLElement | null>,
  hoverCard: Pick<HoverCardReturn, 'positionRef' | 'interactionRef'>,
): void {
  const positionRef = useRef(hoverCard.positionRef).current;
  const interactionRef = hoverCard.interactionRef;

  useEffect(() => {
    const trigger = containerRef.current?.querySelector<HTMLElement>(
      'button.astryx-side-nav-item',
    ) ?? null;
    positionRef(trigger);
    return () => {
      positionRef(null);
    };
  }, [containerRef, positionRef]);

  useEffect(() => {
    const trigger = containerRef.current?.querySelector<HTMLElement>(
      'button.astryx-side-nav-item',
    ) ?? null;
    interactionRef(trigger);
    return () => {
      interactionRef(null);
    };
  }, [containerRef, interactionRef]);
}

export interface SessionRowActions {
  onToggleFlag(sessionId: string, next: boolean): void | Promise<void>;
  onArchive(sessionId: string): void | Promise<void>;
  onUnarchive(sessionId: string): void | Promise<void>;
  onRename(sessionId: string, name: string): void | Promise<void>;
}

export interface ProjectRowActions {
  onNew(projectId: string): void | Promise<void>;
  onRename(projectId: string, name: string): void | Promise<void>;
  onArchive(projectId: string): void | Promise<void>;
  onRestore(projectId: string): void | Promise<void>;
  onRelink?(projectId: string): void | Promise<void>;
}

export interface SessionHistoryGroup {
  id: string;
  label: string;
  sessions: SessionSummary[];
  project?: ProjectRecord;
}

/**
 * The nearest ancestor of an event's target matching `selector`.
 *
 * Duck-typed rather than `instanceof Element`: this module is also rendered
 * against linkedom, whose Element is not the ambient global, and the check
 * would throw there rather than answer.
 */
function closestFrom(target: EventTarget | null, selector: string): HTMLElement | null {
  const node = target as { closest?: (selector: string) => HTMLElement | null } | null;
  return typeof node?.closest === 'function' ? node.closest(selector) : null;
}

/**
 * Whether a gesture may pick this row.
 *
 * The one place that answers it, because answering it twice is how a range
 * comes to disagree with what the user sees. Two rows are rendered but not
 * pickable: a row inside a collapsed project, which keeps its DOM node —
 * `SideNavItem` collapses by grid track, not by unmounting — and a shared row
 * projected from someone else's Host, which is handed no actions because
 * there is nothing this window may do to it. Neither may be swept into a set,
 * so neither may sit in the order a range is measured against.
 */
function isPickableRow(row: HTMLElement): boolean {
  return row.dataset.actionable === 'true' && row.closest('[inert]') === null;
}

/** The row a pointer event landed in, if it landed in a pickable one. */
function pickableRowOf(target: EventTarget | null): HTMLElement | null {
  const row = closestFrom(target, '.maka-session-row[data-session-id]');
  return row && isPickableRow(row) ? row : null;
}

/**
 * What a click on a row is asking for.
 *
 * Read in two places — the list picks the set, the row decides whether to
 * navigate — so that "a modifier is a selection gesture, not navigation" is
 * one sentence of code rather than a capture handler silencing a bubble one.
 */
function pickFor(event: Pick<MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>): SessionRowPick {
  if (event.shiftKey) return 'range';
  return event.metaKey || event.ctrlKey ? 'toggle' : 'replace';
}

export function SessionHistoryList() {
  const rail = useSessionRailData();
  const selection = useSessionRailSelection();
  const locale = useUiLocale();
  const listRef = useRef<HTMLDivElement>(null);
  const commands = selection?.commands;

  /**
   * The rail's rendered order, read from the DOM at the moment of a click.
   *
   * A Shift range needs to know how far it may reach, and that is a property of
   * the LIST. #4365's first revision handed each row its group's id array so a
   * range could be computed inside the row; that array gets a fresh identity per
   * render, which is a changed prop on every memoised row, and it turned a
   * two-row session switch into a twelve-row one (#4109). Asked for here it
   * costs one query per click and nothing per render — and it is the true order
   * across groups, rather than a reconstruction of it.
   *
   * Rendered is not the same as reachable, so it is the pickable rows in that
   * order: a range may only cross what the user can see and act on.
   */
  function orderedSessionIds(): string[] {
    const node = listRef.current;
    if (!node) return [];
    return [...node.querySelectorAll<HTMLElement>('.maka-session-row[data-session-id]')]
      .filter(isPickableRow)
      .map((row) => row.dataset.sessionId)
      .filter((sessionId): sessionId is string => sessionId !== undefined);
  }

  /**
   * A menu is about a set, so opening one on a row outside the set replaces it
   * — the way a file list answers a right-click on an unselected file.
   *
   * A row already in the set keeps the set: a run built by dragging must
   * survive the gesture that asks what to do with it. But the set is narrowed
   * to what is pickable at this instant, because the menu is the only entrance
   * to a sweep and a sweep may act only on rows the user can see and act on. A
   * pick does not have to leave the rail to stop being visible — its project
   * collapses, or its session becomes a shared projection with no actions — and
   * a set holding one of those would let a menu opened here archive a row that
   * is not on screen.
   *
   * So the menu means the set it names: opening one FIXES the set at what is on
   * screen, and a pick that was folded away is out of it for good, dismissed
   * menu included. Folding does not narrow the set on its own — collapse lives
   * as uncontrolled state inside `SideNavItem` and is only readable from the
   * DOM, and this is the one moment that holds the set and the DOM together.
   */
  function adoptForMenu(sessionId: string) {
    if (!commands) return;
    if (selection?.selectedIds.has(sessionId)) {
      commands.retain(orderedSessionIds());
      return;
    }
    commands.pick({ sessionId, pick: 'replace', orderedSessionIds: [] });
  }

  function handleListClickCapture(event: MouseEvent<HTMLDivElement>) {
    if (!commands) return;
    const row = pickableRowOf(event.target);
    const sessionId = row?.dataset.sessionId;
    if (!row || !sessionId) return;
    if (closestFrom(event.target, '.maka-session-row-action')) {
      adoptForMenu(sessionId);
      return;
    }
    // The row's own button, not its hover card or any other descendant.
    if (!closestFrom(event.target, 'button.astryx-side-nav-item')) return;
    const pick = pickFor(event);
    commands.pick({
      sessionId,
      pick,
      orderedSessionIds: pick === 'range' ? orderedSessionIds() : [],
      openSessionId: rail.activeId,
    });
  }

  /**
   * Right-click opens the row's own ⋯ menu.
   *
   * Not a second menu mounted beside it. "⋯ and right-click agree" is then a
   * fact rather than a promise kept by two lists of items that have to be
   * maintained together — #4365 let them disagree, offering to act on one row
   * from a ⋯ while twelve were marked.
   *
   * A row with no ⋯ has no menu to open, so this press is not ours: claiming it
   * would take the native menu away and leave nothing in its place.
   */
  function handleListContextMenu(event: MouseEvent<HTMLDivElement>) {
    if (!commands) return;
    const row = pickableRowOf(event.target);
    const sessionId = row?.dataset.sessionId;
    if (!row || !sessionId) return;
    const trigger = row.querySelector<HTMLElement>('.maka-session-row-action button');
    event.preventDefault();
    adoptForMenu(sessionId);
    // Opening the menu re-enters `handleListClickCapture` with a synthetic
    // click, so the adoption is dispatched twice — harmless only because both
    // of its branches are idempotent: `replace` sets the same one row, and
    // `retain` intersects with the same list. Anything else here needs a guard.
    trigger?.click();
  }

  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape') return;
    // Escape belongs to whatever is on top. A rename dialog or an open menu is
    // above the rail and owns the press; Astryx's layer stack listens on
    // `document`, below this handler in the bubble, and stands down on a press
    // that is already defaultPrevented — so claiming one here would clear the
    // set AND leave the dialog with no way to close.
    const active = document.activeElement as HTMLElement | null;
    // The rail's only text field is the rename dialog's, so `dialog` already
    // covers it and there is nothing else here for `input`/`textarea` to name.
    if (!active || active.closest('dialog, [role="menu"]')) return;
    // Escape drops the picks. The open task stays open and stays painted, so
    // what the user sees is the selection collapsing back onto it.
    if (!commands || selection.selectedIds.size === 0) return;
    event.preventDefault();
    commands.clear();
  }

  // Memoized on what it derives from. Rebuilt per render it would give
  // `SessionListGroups` a new `props.groups` every time, which defeats the
  // per-group memo below it — and this component re-renders on every session
  // switch, because `rail.activeId` is part of the value it reads.
  const groups = useMemo(
    () =>
      rail.groups
        ? rail.groups.map((g) => ({
            key: g.id,
            label: g.label,
            sessions: g.sessions,
            project: g.project,
          }))
        : groupSessionsForHistory(rail.sessions, locale).map((g) => ({
            key: g.id,
            label: g.label,
            sessions: g.sessions,
          })),
    [locale, rail.groups, rail.sessions],
  );

  // Outer SideNav is the sole navigation landmark and it already carries this
  // panel's name; naming this element too put "任务列表" inside "任务列表",
  // which is one ambiguous match for anything selecting by that name and no
  // extra information for anyone hearing it. It is scroll content and a key
  // handler, nothing an assistive tech user needs to be told about separately.
  return (
    <div
      ref={listRef}
      className="maka-session-list"
      onKeyDown={handleListKeyDown}
      onClickCapture={handleListClickCapture}
      onContextMenu={handleListContextMenu}
    >
      <SessionListGroups groups={groups} />
    </div>
  );
}

function SessionListGroups(props: {
  groups: ReadonlyArray<{
    key: string;
    label: string;
    sessions: SessionSummary[];
    project?: ProjectRecord;
  }>;
}) {
  const rail = useSessionRailData();
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).sessions;
  const [renameTarget, setRenameTarget] = useState<SessionRenameTarget | null>(null);
  /**
   * The control the rename was started from, so focus can go back to it.
   *
   * Astryx's Dialog restores focus on its own — to whatever was focused when it
   * opened — and that is exactly what fails here. A menu-launched dialog opens
   * one frame AFTER the menu closed, and the two race: measured frame by frame,
   * the dialog's capture lands on the menu item (frames 1-3) while the menu
   * hands focus back to the trigger on frame 4. Restoring to a node that has
   * since been unmounted is a no-op, so the edit ended on <body> and the next
   * Tab started at the top of the window — while the delete confirm one item
   * below in the same menu returns the trigger.
   *
   * The opener is passed in rather than captured here, because the component
   * that renders the menu is the only one that can name it without racing.
   */
  const renameOpenerRef = useRef<HTMLElement | null>(null);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  // Read HERE and handed down as props, not read by the rows themselves. A
  // context consumer re-renders on any change to the value it subscribes to,
  // and the picked set now changes on an ordinary session switch — every row
  // would redraw for a switch that changed two of them (#4109). This component
  // is one fiber; the rows below it are ~1,000.
  const selection = useSessionRailSelection();
  const selectedIds = selection?.selectedIds;
  const pickedCount = selectedIds?.size ?? 0;
  // Whether a set-wide pin should read 置顶 or 取消置顶. Every row already
  // pinned means the verb unpins; a mixed set pins, which is the one rule that
  // keeps a set-wide toggle from being ambiguous.
  const allPickedPinned = useMemo(() => {
    if (!selectedIds || selectedIds.size === 0) return false;
    const pinned = new Set(
      rail.sessions.filter((session) => session.isFlagged).map((session) => session.id),
    );
    return [...selectedIds].every((sessionId) => pinned.has(sessionId));
  }, [rail.sessions, selectedIds]);

  const startRename = useCallback((target: SessionRenameTarget, opener: HTMLElement | null) => {
    renameOpenerRef.current = opener;
    setRenameTarget(target);
  }, []);

  function closeRename() {
    setRenameTarget(null);
    const opener = renameOpenerRef.current;
    renameOpenerRef.current = null;
    // After the dialog has left the DOM, not before: while it is still open it
    // is a native modal, everything outside it is inert, and a `focus()` there
    // is refused outright — measured, the call ran and the row's trigger stayed
    // unfocused.
    if (opener) window.requestAnimationFrame(() => opener.focus());
  }

  function commitRename(target: SessionRenameTarget, name: string) {
    const rename =
      target.kind === 'project' ? rail.projectActions?.onRename : rail.rowActions?.onRename;
    if (!rename) return;
    void Promise.resolve(rename(target.id, name)).catch(() => {
      // AppShell owns visible rename failure feedback.
    });
  }

  // Linked subagent sessions open in the main chat column, not as nested
  // sidebar rows. The host passes only root/user sessions here.
  //
  // Two dependencies, not eight. The eight were one value — everything a row is
  // drawn from — spelled out because it arrived as eight separate props, and
  // any one of them changing identity upstream rebuilt every row. It arrives as
  // `rail` now, so this array says what it always meant (#4109).
  const renderSessionRow = useCallback(
    (session: SessionSummary): ReactNode => {
      const picked = selectedIds?.has(session.id) ?? false;
      // Scoped to picked rows on purpose. A count handed to every row would be
      // a changed prop on every row each time the set grows; this way a plain
      // click — which picks the row it opens — changes exactly two.
      const bulk = picked && pickedCount > 1;
      return (
        <SessionNavRow
          key={session.id}
          session={session}
          active={session.id === rail.activeId}
          picked={picked}
          bulkCount={bulk ? pickedCount : 0}
          bulkAllPinned={bulk ? allPickedPinned : false}
          selectionCommands={selection?.commands}
          streaming={rail.streamingSessionIds?.has(session.id) ?? false}
          stale={rail.staleSessionIds?.has(session.id) ?? false}
          worktree={rail.worktreeSessionIds?.has(session.id) ?? false}
          meta={rail.sessionMeta?.(session)}
          sessionBadge={rail.sessionBadge}
          onSelectSession={rail.onSelectSession}
          actions={(session as SessionSummary & { readonly shared?: true }).shared
            ? undefined
            : rail.rowActions}
          onStartRename={startRename}
        />
      );
    },
    [allPickedPinned, pickedCount, rail, selectedIds, selection?.commands, startRename],
  );

  // Keyed per target so the field seeds from the name that row carries now,
  // with nothing to synchronise while the dialog is open.
  const renameDialog = renameTarget ? (
    <SessionRenameDialog
      key={renameTarget.id}
      target={renameTarget}
      onOpenChange={(open) => {
        if (!open) closeRename();
      }}
      onRename={commitRename}
    />
  ) : null;

  if (rail.groupVariant === 'project') {
    const activeGroups = props.groups.filter((group) => group.project?.archivedAt === undefined);
    const archivedGroups = props.groups.filter((group) => group.project?.archivedAt !== undefined);
    const pinnedGroup = groupSessionsForHistory(
      activeGroups.flatMap((group) => group.sessions),
      locale,
    ).find((group) => group.id === 'pinned');

    function renderProjectGroup(
      group: (typeof props.groups)[number],
      includePinned = false,
    ): ReactNode {
      const project = group.project;
      const sessions = includePinned
        ? group.sessions
        : group.sessions.filter((session) => !session.isFlagged);
      return (
        <ProjectNavRow
          key={group.key}
          groupKey={group.key}
          label={group.label}
          project={project}
          sessions={sessions}
          streamingSessionIds={rail.streamingSessionIds}
          projectActions={rail.projectActions}
          onStartRename={(opener) => {
            if (project) {
              startRename({ kind: 'project', id: project.id, name: project.name }, opener);
            }
          }}
          renderSession={renderSessionRow}
        />
      );
    }

    // Two sibling sections, the same shape the time view has. A section groups
    // items; it is not one of them. Putting the pinned section next to bare
    // project rows would make the same level hold both a group heading and
    // navigation items, and the pinned zone would be the only one there without
    // a folder icon, a disclosure or a row menu.
    return (
      <>
        {renameDialog}
        {pinnedGroup && (
          <SideNavSection title={pinnedGroup.label} className="maka-session-group">
            {pinnedGroup.sessions.map((session) => renderSessionRow(session))}
          </SideNavSection>
        )}
        {(activeGroups.length > 0 || archivedGroups.length > 0) && (
          <SideNavSection title={copy.projects} className="maka-session-group">
            {activeGroups.map((group) => renderProjectGroup(group))}
            {archivedGroups.length > 0 && (
              <SideNavItem
                label={copy.archivedProjects}
                collapsible={{
                  isCollapsed: !archivedExpanded,
                  onCollapsedChange: (collapsed) => setArchivedExpanded(!collapsed),
                }}
              >
                {/* Always mount children: Astryx derives collapsible chrome from
                    !!children. Nulling on collapse removes the chevron and makes
                    the controlled isCollapsed prop a no-op. */}
                {archivedGroups.map((group) => renderProjectGroup(group, true))}
              </SideNavItem>
            )}
          </SideNavSection>
        )}
      </>
    );
  }

  return (
    <>
      {renameDialog}
      {props.groups.map((group) => {
        // Once per group, never per row: a fresh array for each row would hand
        // every `SessionNavRow` a new prop identity and defeat its memo.
        const items = group.sessions.map((session) => renderSessionRow(session));
        if (!group.label) {
          return (
            <div key={group.key} className="maka-session-group">
              {items}
            </div>
          );
        }
        return (
          <SideNavSection key={group.key} title={group.label} className="maka-session-group">
            {items}
          </SideNavSection>
        );
      })}
    </>
  );
}

function ProjectNavRow(props: {
  groupKey: string;
  label: string;
  project?: ProjectRecord;
  sessions: SessionSummary[];
  streamingSessionIds?: ReadonlySet<string>;
  projectActions?: ProjectRowActions;
  onStartRename(opener: HTMLElement | null): void;
  renderSession(session: SessionSummary): ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hoverDescriptionId = useId();
  // The same list the row draws its subtree from. A summary counting rows that
  // were hoisted into the pinned section describes a project row that has no
  // disclosure and no children, and puts its menu somewhere else than the count
  // implies.
  const hoverSummary = useMemo(
    () =>
      createProjectHoverCardSummary(
        props.project,
        props.sessions,
        props.streamingSessionIds,
      ),
    [props.project, props.sessions, props.streamingSessionIds],
  );
  // Collapsible only when there is a real session subtree. An empty VStack is
  // still truthy children for Astryx (!!children) and fabricates a disclosure.
  const hasSessions = props.sessions.length > 0;
  const hasActions = props.project !== undefined && props.projectActions !== undefined;
  const hasMeta = (props.project !== undefined && !props.project.available) || hasActions;
  return (
    <div ref={containerRef} data-project-id={props.groupKey} className="maka-project-row">
      <SideNavItem
        key="navigation"
        label={props.label}
        aria-describedby={hoverDescriptionId}
        icon={FolderOpen}
        collapsible={hasSessions ? { defaultIsCollapsed: false } : undefined}
        endContent={hasMeta ? (
          <ProjectItemMeta
            project={props.project}
            reserveAction={hasActions}
          />
        ) : undefined}
        trailingAction={
          props.project && props.projectActions ? (
            <ProjectItemActions
              project={props.project}
              actions={props.projectActions}
              onStartRename={props.onStartRename}
              position={hasSessions ? 'before-disclosure' : 'trailing'}
            />
          ) : undefined
        }
      >
        {/* sidebar.css keeps an 8px nest so session titles share the project x. */}
        {hasSessions ? (
          <VStack gap={0.5}>
            {props.sessions.map((session) => props.renderSession(session))}
          </VStack>
        ) : undefined}
      </SideNavItem>
      <ProjectHoverCardDescription
        id={hoverDescriptionId}
        summary={hoverSummary}
      />
      <ProjectHoverCardLayer
        containerRef={containerRef}
        label={props.label}
        project={props.project}
        summary={hoverSummary}
      />
    </div>
  );
}

const ProjectHoverCardLayer = memo(function ProjectHoverCardLayer(props: {
  containerRef: RefObject<HTMLElement | null>;
  label: string;
  project?: ProjectRecord;
  summary: ProjectHoverCardSummary;
}) {
  const locale = useUiLocale();
  const copy = getSessionHoverCardCopy(locale);
  const hoverCard = useHoverCard({
    placement: 'end',
    alignment: 'start',
    delay: SIDEBAR_HOVER_CARD_DELAY_MS,
    hideDelay: SIDEBAR_HOVER_CARD_HIDE_DELAY_MS,
    focusTrigger: 'always',
    label: props.project
      ? copy.projectDetailsLabel(props.label)
      : copy.groupDetailsLabel(props.label),
  });
  useSidebarHoverCardTrigger(props.containerRef, hoverCard);

  return hoverCard.renderHoverCard(
    <ProjectHoverCardContent
      label={props.label}
      summary={props.summary}
      locale={locale}
    />,
  );
});

const SessionNavRow = memo(function SessionNavRow(props: {
  session: SessionSummary;
  active: boolean;
  /** Part of the picked set. The open row is painted the same way. */
  picked: boolean;
  /** How many rows a menu opened here would act on; 0 when it is this row alone. */
  bulkCount: number;
  bulkAllPinned: boolean;
  selectionCommands?: SessionRailSelectionCommands;
  streaming: boolean;
  stale: boolean;
  worktree: boolean;
  meta?: string;
  sessionBadge?: SessionRailData['sessionBadge'];
  onSelectSession(sessionId: string): void;
  actions?: SessionRowActions;
  onStartRename(target: SessionRenameTarget, opener: HTMLElement | null): void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hoverDescriptionId = useId();
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).sessions;
  const signals = sessionRowSignals(
    props.session,
    { streaming: props.streaming, stale: props.stale, active: props.active },
    locale,
  );
  const signal = signals[0];
  const previewStatus = signal?.tooltip ?? signal?.label ?? presentSessionStatus(
    props.session.status === 'running' && props.session.runningTurnIds !== undefined
      ? 'active'
      : props.session.status,
    locale,
  ).label;
  // What the row communicates without text and the dot does NOT already say,
  // inside the button so it lands in the accessible name. `signals[0]` is
  // skipped because `StatusDot` carries it; the rest of the list, the worktree
  // attribute, and the timestamp reached assistive tech nowhere else — the
  // timestamp renders `aria-hidden` and swaps out for the ⋯ menu, and worktree
  // is an attribute of the row rather than a signal, so it never competes for
  // the dot.
  const rowDescription = [
    ...signals.slice(1).map((entry) => entry.tooltip ?? entry.label),
    // Being picked is a fact about the row that the ground alone carries. It is
    // NOT `aria-current`: that names the one current page, and a set of picked
    // rows is not a set of current pages.
    //
    // The open row is exempt only while it is the whole set — the state a plain
    // click leaves, where "selected" would say nothing `isSelected` has not.
    // Inside a real run it is one of several, and `bulkCount` is how the row
    // already knows: nonzero on picked rows alone, and above 1 only when the
    // menu would offer a sweep.
    props.picked && (!props.active || props.bulkCount > 1) ? copy.pickedAriaLabel : undefined,
    props.worktree ? copy.worktreeAriaLabel : undefined,
    props.meta,
    props.session.lastMessageAt
      ? formatAbsoluteTimestamp(props.session.lastMessageAt, locale)
      : undefined,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(' · ');

  return (
    <div
      ref={containerRef}
      className="maka-session-row"
      data-maka-contract="session-row"
      data-session-id={props.session.id}
      data-stale={props.stale ? 'true' : undefined}
      data-worktree={props.worktree ? 'true' : undefined}
      data-picked={props.picked ? 'true' : undefined}
      // What the list reads to know this row can be picked. Having actions is
      // the same fact as being ours to act on, so the two cannot drift: a
      // shared row gets none, and is a plain navigation item all the way down.
      data-actionable={props.actions ? 'true' : undefined}
    >
      <SideNavItem
        label={props.session.name}
        aria-describedby={hoverDescriptionId}
        size="md"
        isSelected={props.active}
        // Slot 1, the row's leading edge. A fixed gutter every row pays for,
        // whether or not it has a dot, so state reads as one column down the
        // rail instead of a mark that drifts with each title's length.
        icon={
          signal ? (
            <StatusDot
              variant={signal.variant}
              label={signal.label}
              isPulsing={signal.isPulsing}
              tooltip={signal.tooltip}
              data-session-status={props.session.status}
            />
          ) : (
            <span className="maka-session-row-signal-empty" aria-hidden="true" />
          )
        }
        onClick={(event) => {
          // Shift- and ⌘-clicks are answered by the list, which has already
          // moved the set by the time this runs. Opening the task as well
          // would move the main pane away from the run being built. Where
          // nothing listens for picks — or this row cannot be picked at all —
          // the modifier means nothing, and the row is a plain navigation item
          // again rather than a dead click.
          if (props.actions && props.selectionCommands && pickFor(event) !== 'replace') return;
          if (event.detail > 1 && props.actions) {
            props.onStartRename(
              {
                kind: 'session',
                id: props.session.id,
                name: props.session.name,
              },
              // The row's own button: a double-click starts the rename from
              // the row itself, not from the actions menu.
              event.currentTarget as HTMLElement,
            );
            return;
          }
          props.onSelectSession(props.session.id);
        }}
        endContent={
          // Slot 2. The timestamp is what the row shows at rest; the ⋯ menu
          // below is absolutely positioned over this box and sidebar.css swaps
          // the two on hover or keyboard focus. The span is rendered even with
          // no timestamp so the column exists on every row.
          <span className="maka-session-row-end">
            {props.sessionBadge ? (
              <span className="maka-session-row-attention-badge">
                {props.sessionBadge(props.session)}
              </span>
            ) : null}
            {props.meta ? (
              <span className="maka-session-row-host-badge" title={props.meta}>
                <Badge variant="neutral" label={props.meta} />
              </span>
            ) : null}
            <span className="maka-session-row-time">
              {props.session.lastMessageAt ? (
                <RelativeTime
                  ts={props.session.lastMessageAt}
                  variant="sidebar"
                  className="maka-session-row-time-label"
                  suppressTitle
                />
              ) : null}
            </span>
            {rowDescription ? (
              <span className="maka-visually-hidden">{rowDescription}</span>
            ) : null}
          </span>
        }
      />
      <SessionHoverCardDescription
        id={hoverDescriptionId}
        session={props.session}
        status={previewStatus}
        locale={locale}
      />
      <SessionHoverCardLayer
        containerRef={containerRef}
        session={props.session}
        status={previewStatus}
        locale={locale}
      />
      {props.actions && (
        <SessionItemActions
          session={props.session}
          actions={props.actions}
          bulkCount={props.bulkCount}
          bulkAllPinned={props.bulkAllPinned}
          selectionCommands={props.selectionCommands}
          onStartRename={props.onStartRename}
        />
      )}
    </div>
  );
});

const SessionHoverCardLayer = memo(function SessionHoverCardLayer(props: {
  containerRef: RefObject<HTMLElement | null>;
  session: SessionSummary;
  status: string;
  locale: UiLocale;
}) {
  const copy = getSessionHoverCardCopy(props.locale);
  const hoverCard = useHoverCard({
    placement: 'end',
    alignment: 'start',
    delay: SIDEBAR_HOVER_CARD_DELAY_MS,
    hideDelay: SIDEBAR_HOVER_CARD_HIDE_DELAY_MS,
    focusTrigger: 'always',
    label: copy.sessionDetailsLabel(props.session.name),
  });
  useSidebarHoverCardTrigger(props.containerRef, hoverCard);

  return hoverCard.renderHoverCard(
    <SessionHoverCardContent
      session={props.session}
      status={props.status}
      locale={props.locale}
    />,
  );
});

function SessionHoverCardDescription(props: {
  id: string;
  session: SessionSummary;
  status: string;
  locale: UiLocale;
}) {
  const conversationCopy = getConversationCopy(props.locale);
  const copy = getSessionHoverCardCopy(props.locale);
  const session = props.session;
  const permission = conversationCopy.permissions.mode[session.permissionMode].label;
  const description = [
    props.status,
    session.lastMessagePreview || copy.noMessages,
    session.model,
    permission,
    session.cwd,
    session.lastMessageAt
      ? `${copy.updated} ${formatAbsoluteTimestamp(session.lastMessageAt, props.locale)}`
      : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');

  return <span id={props.id} className="maka-visually-hidden" aria-label={description} />;
}

function SessionHoverCardContent(props: {
  session: SessionSummary;
  status: string;
  locale: UiLocale;
}) {
  const conversationCopy = getConversationCopy(props.locale);
  const copy = getSessionHoverCardCopy(props.locale);
  const session = props.session;
  const permission = conversationCopy.permissions.mode[session.permissionMode].label;

  return (
    <span className="maka-sidebar-hover-card" data-kind="session">
      <span className="maka-sidebar-hover-card-title">{session.name}</span>
      <span
        className="maka-sidebar-hover-card-preview"
        data-empty={session.lastMessagePreview ? undefined : 'true'}
      >
        {session.lastMessagePreview || copy.noMessages}
      </span>
      <span className="maka-sidebar-hover-card-meta">
        <span>{props.status}</span>
        <span aria-hidden="true">·</span>
        <span>{session.model}</span>
        <span aria-hidden="true">·</span>
        <span>{permission}</span>
      </span>
      {session.cwd ? (
        <span className="maka-sidebar-hover-card-path" title={session.cwd}>
          {session.cwd}
        </span>
      ) : null}
      {session.lastMessageAt ? (
        <span className="maka-sidebar-hover-card-updated">
          {copy.updated}{' '}
          <RelativeTime ts={session.lastMessageAt} />
          <span className="maka-visually-hidden">
            {formatAbsoluteTimestamp(session.lastMessageAt, props.locale)}
          </span>
        </span>
      ) : null}
    </span>
  );
}

function ProjectHoverCardDescription(props: {
  id: string;
  summary: ProjectHoverCardSummary;
}) {
  const locale = useUiLocale();
  const copy = getSessionHoverCardCopy(locale);
  const summary = props.summary;
  const description = [
    summary.path,
    copy.taskCount(summary.taskCount),
    summary.runningCount > 0 ? copy.runningTaskCount(summary.runningCount) : undefined,
    summary.available !== undefined
      ? summary.available
        ? copy.projectAvailable
        : copy.projectUnavailable
      : undefined,
    summary.locationCount > 1
      ? copy.locationCount(summary.locationCount)
      : undefined,
    summary.latestActivity
      ? `${copy.updated} ${formatAbsoluteTimestamp(summary.latestActivity, locale)}`
      : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');

  return <span id={props.id} className="maka-visually-hidden" aria-label={description} />;
}

function ProjectHoverCardContent(props: {
  label: string;
  summary: ProjectHoverCardSummary;
  locale: UiLocale;
}) {
  const copy = getSessionHoverCardCopy(props.locale);
  const summary = props.summary;

  return (
    <span className="maka-sidebar-hover-card" data-kind="project">
      <span className="maka-sidebar-hover-card-title">{props.label}</span>
      {summary.path ? (
        <span className="maka-sidebar-hover-card-path" title={summary.path}>
          {summary.path}
        </span>
      ) : null}
      <span className="maka-sidebar-hover-card-meta">
        <span>{copy.taskCount(summary.taskCount)}</span>
        {summary.runningCount > 0 ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{copy.runningTaskCount(summary.runningCount)}</span>
          </>
        ) : null}
        {summary.available !== undefined ? (
          <>
            <span aria-hidden="true">·</span>
            <span>
              {summary.available ? copy.projectAvailable : copy.projectUnavailable}
            </span>
          </>
        ) : null}
        {summary.locationCount > 1 ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{copy.locationCount(summary.locationCount)}</span>
          </>
        ) : null}
      </span>
      {summary.latestActivity ? (
        <span className="maka-sidebar-hover-card-updated">
          {copy.updated}{' '}
          <RelativeTime ts={summary.latestActivity} />
          <span className="maka-visually-hidden">
            {formatAbsoluteTimestamp(summary.latestActivity, props.locale)}
          </span>
        </span>
      ) : null}
    </span>
  );
}

interface ProjectHoverCardSummary {
  path?: string;
  taskCount: number;
  runningCount: number;
  available?: boolean;
  locationCount: number;
  latestActivity?: number;
}

function createProjectHoverCardSummary(
  project: ProjectRecord | undefined,
  sessions: readonly SessionSummary[],
  streamingSessionIds: ReadonlySet<string> | undefined,
): ProjectHoverCardSummary {
  return {
    path: preferredProjectPath(project),
    taskCount: sessions.length,
    runningCount: sessions.filter(
      (session) =>
        resolveSessionRunningState(
          session,
          streamingSessionIds?.has(session.id) ?? false,
        ).running,
    ).length,
    available: project?.available,
    locationCount: project?.locations.length ?? 0,
    latestActivity: sessions.reduce<number | undefined>(
      (latest, session) => Math.max(latest ?? 0, session.lastMessageAt ?? 0) || undefined,
      undefined,
    ),
  };
}

function preferredProjectPath(project: ProjectRecord | undefined): string | undefined {
  if (!project) return undefined;
  return (
    project.preferredPath ??
    project.locations.find((location) => !location.isWorktree)?.path ??
    project.locations[0]?.path
  );
}

function ProjectItemMeta(props: {
  project?: ProjectRecord;
  reserveAction: boolean;
}) {
  const copy = getConversationCopy(useUiLocale()).sessions;
  return (
    <span className="maka-session-row-end maka-project-item-end">
      {props.project && !props.project.available && (
        <AlertTriangle size={ICON_SIZE.meta} aria-label={copy.projectUnavailable} />
      )}
      {props.reserveAction ? (
        <span className="maka-session-row-trailing" aria-hidden="true" />
      ) : null}
    </span>
  );
}

function ProjectItemActions(props: {
  project: ProjectRecord;
  actions: ProjectRowActions;
  onStartRename(opener: HTMLElement | null): void;
  position: 'before-disclosure' | 'trailing';
}) {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const trailingRef = useRef<HTMLSpanElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<ProjectRowActionId | null>(null);
  const mountedRef = useMountedRef();
  const pendingActionRef = useRef<ProjectRowActionId | null>(null);
  const pendingMenuIntentRef = useRef<(() => void) | null>(null);
  const project = props.project;
  const actions = props.actions;

  useEffect(
    () => () => {
      pendingActionRef.current = null;
    },
    [],
  );

  function runProjectAction(actionId: ProjectRowActionId, action: () => void | Promise<void>) {
    if (pendingActionRef.current) return;
    pendingActionRef.current = actionId;
    setPendingAction(actionId);
    void (async () => {
      try {
        await action();
      } catch {
        // AppShell owns visible project-action failure feedback.
      } finally {
        pendingActionRef.current = null;
        if (mountedRef.current) setPendingAction(null);
      }
    })();
  }

  // Projects keep a permanent MoreMenu. SideNavItem's trailingAction slot puts
  // it after the collapse button and before the nested tasks, so visual and
  // keyboard order agree without nesting either interactive control.
  const menuItems = project.archivedAt !== undefined
    ? [
        {
          label: copy.projectRestore,
          icon: ArchiveRestore,
          onClick: () => runProjectAction('restore', () => actions.onRestore(project.id)),
        },
      ]
    : [
        ...(project.available
          ? [
              {
                label: copy.projectNewTask,
                icon: SquarePen,
                onClick: () => runProjectAction('new', () => actions.onNew(project.id)),
              },
            ]
          : actions.onRelink
            ? [
              {
                label: copy.projectRelink,
                icon: Plug,
                onClick: () => runProjectAction('relink', () => actions.onRelink!(project.id)),
              },
            ]
            : []),
        {
          label: copy.projectRename,
          icon: Pencil,
          onClick: () => {
            // Read now, while the trigger is still the thing the user is on:
            // by the time the intent runs the menu has closed and focus is
            // mid-handover.
            const opener = trailingRef.current?.querySelector<HTMLElement>('button') ?? null;
            pendingMenuIntentRef.current = () => props.onStartRename(opener);
          },
        },
        {
          label: copy.projectArchive,
          icon: Archive,
          onClick: () => runProjectAction('archive', () => actions.onArchive(project.id)),
        },
      ];

  return (
    <span className="maka-session-row-action" data-position={props.position} ref={trailingRef}>
      <MoreMenu
        size="sm"
        label={copy.projectActionsAriaLabel(project.name)}
        isDisabled={pendingAction !== null}
        isMenuOpen={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open) return;
          const intent = pendingMenuIntentRef.current;
          pendingMenuIntentRef.current = null;
          if (intent) window.requestAnimationFrame(intent);
        }}
        items={menuItems}
      />
    </span>
  );
}

/**
 * The row's ⋯ menu, and the menu right-click opens — one implementation, so
 * they cannot disagree.
 *
 * Its verbs count the set: with seven rows picked and the menu opened on one of
 * them it offers 归档 7 项, because acting on the one row under the cursor while
 * six others are visibly picked is the shape of a surprise. `bulkCount` is 0
 * whenever the menu is about this row alone, which is both "nothing is picked"
 * and "only this row is".
 */
function SessionItemActions(props: {
  session: SessionSummary;
  actions: SessionRowActions;
  bulkCount: number;
  bulkAllPinned: boolean;
  selectionCommands?: SessionRailSelectionCommands;
  onStartRename(target: SessionRenameTarget, opener: HTMLElement | null): void;
}) {
  const trailingRef = useRef<HTMLSpanElement>(null);
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).sessions;
  const actionContext = [
    props.session.name,
    props.session.lastMessageAt
      ? formatAbsoluteTimestamp(props.session.lastMessageAt, locale)
      : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<SessionRowActionId | null>(null);
  const mountedRef = useMountedRef();
  const pendingActionRef = useRef<SessionRowActionId | null>(null);
  const pendingMenuIntentRef = useRef<(() => void) | null>(null);
  const actions = props.actions;

  useEffect(
    () => () => {
      pendingActionRef.current = null;
    },
    [],
  );

  function runRowAction(actionId: SessionRowActionId, action: () => void | Promise<void>) {
    if (pendingActionRef.current) return;
    pendingActionRef.current = actionId;
    setPendingAction(actionId);
    void (async () => {
      try {
        await action();
      } catch {
        // AppShell owns visible session-action failure feedback.
      } finally {
        pendingActionRef.current = null;
        if (mountedRef.current) setPendingAction(null);
      }
    })();
  }

  return (
    <span
      className="maka-session-row-action"
      data-menu-open={menuOpen ? 'true' : undefined}
      ref={trailingRef}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <MoreMenu
        size="sm"
        label={copy.actionsAriaLabel(actionContext)}
        isDisabled={pendingAction !== null}
        isMenuOpen={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open) return;
          const intent = pendingMenuIntentRef.current;
          pendingMenuIntentRef.current = null;
          if (intent) window.requestAnimationFrame(intent);
        }}
        items={
          props.bulkCount > 1 && props.selectionCommands
            ? [
                {
                  label: props.bulkAllPinned
                    ? copy.unpinCount(props.bulkCount)
                    : copy.pinCount(props.bulkCount),
                  icon: props.bulkAllPinned ? PinOff : Pin,
                  onClick: () =>
                    void props.selectionCommands?.flagSelected(!props.bulkAllPinned),
                },
                // No 重命名: renaming names ONE task, and there is no honest
                // way to ask a dialog for seven names at once.
                {
                  label: copy.archiveCount(props.bulkCount),
                  icon: Archive,
                  onClick: () => void props.selectionCommands?.archiveSelected(),
                },
              ]
            : [
                {
                  label: props.session.isFlagged ? copy.unpin : copy.pin,
                  icon: props.session.isFlagged ? PinOff : Pin,
                  onClick: () =>
                    runRowAction('flag', () =>
                      actions.onToggleFlag(props.session.id, !props.session.isFlagged),
                    ),
                },
                {
                  label: copy.rename,
                  icon: Pencil,
                  onClick: () => {
                    // Read now, while the trigger is still the thing the user
                    // is on: by the time the intent runs the menu has closed
                    // and focus is mid-handover.
                    const opener =
                      trailingRef.current?.querySelector<HTMLElement>('button') ?? null;
                    pendingMenuIntentRef.current = () =>
                      props.onStartRename(
                        {
                          kind: 'session',
                          id: props.session.id,
                          name: props.session.name,
                        },
                        opener,
                      );
                  },
                },
                // Archive is where the rail stops. Deleting is the one row
                // action that cannot be undone, and the rail is where a
                // mis-click is likeliest: rows are dense, the menu is one hover
                // away, and the row under the cursor moves as the catalog
                // refreshes. It lives in Settings › 已归档任务 instead —
                // reachable only for a task already archived, which is the step
                // that makes the intent deliberate.
                {
                  label: props.session.isArchived ? copy.unarchive : copy.archive,
                  icon: props.session.isArchived ? ArchiveRestore : Archive,
                  onClick: () =>
                    runRowAction('archive', () =>
                      props.session.isArchived
                        ? actions.onUnarchive(props.session.id)
                        : actions.onArchive(props.session.id),
                    ),
                },
              ]
        }
      />
    </span>
  );
}

interface SessionRowSignal {
  variant: StatusDotVariant;
  label: string;
  isPulsing?: boolean;
  tooltip?: string;
}

/**
 * Everything true about the session that is worth saying, in priority order.
 *
 * The row draws ONE dot — `signals[0]` — but it says all of them. Keeping the
 * list is what lets the two visible slots stay two while the row still reaches
 * a screen reader with the same facts a sighted user gets from the dot's
 * colour, the row's dimming, and the tooltip. Collapsing to a single signal
 * inside this function is what previously made the trailing `Badge` the only
 * carrier of "stale", so removing the Badge removed the fact.
 *
 * It also stops signals from eating each other. `aborted` used to resolve to no
 * dot at all, which dropped the row into the unread branch: an aborted task
 * with unread text drew the same accent dot as one that is running. Now it
 * draws its own neutral dot and unread is still in the list behind it.
 *
 * Runtime Host live-run state and renderer-local streaming are deliberately
 * ORed. Host state covers bot channels and other windows; local streaming
 * covers the short synchronization window before a catalog refresh arrives.
 */
function sessionRowSignals(
  session: SessionSummary,
  options: { streaming: boolean; stale: boolean; active: boolean },
  locale: UiLocale,
): SessionRowSignal[] {
  const copy = getConversationCopy(locale).sessions;
  const signals: SessionRowSignal[] = [];
  const runningState = resolveSessionRunningState(session, options.streaming);

  // `active`, through the same vocabulary as everything else here: streaming is
  // the system working on it right now, which is what that semantic names.
  // Writing `accent` directly would resolve to the identical colour and reopen
  // the drift this change closed — half the row's dots deciding for themselves.
  if (runningState.responding) {
    signals.push({
      variant: dotForStatus('active'),
      label: copy.respondingAriaLabel,
      isPulsing: true,
      tooltip: copy.respondingTitle,
    });
  }

  const { label, variant } = presentSessionStatus(session.status, locale);
  if (variant && !runningState.liveStateOwnsRunningStatus) {
    const blockedDetail =
      session.status === 'blocked' && session.blockedReason
        ? describeBlockedReason(session.blockedReason, locale)
        : null;
    signals.push({
      variant,
      label,
      // Persisted `running` is a fallback only when live state is unknown.
      isPulsing: session.status === 'running',
      tooltip: blockedDetail ? `${label} · ${blockedDetail}` : label,
    });
  }

  // Unread ranks under both because it is the weakest claim on attention: a
  // task that is running or holding a question already says something more
  // specific about the same unread text. `active` and not `attention`: unread
  // text is "something happened here", not a question waiting on the user —
  // that distinction is the whole point of the two semantics.
  if (!options.active && session.hasUnread) {
    signals.push({ variant: dotForStatus('active'), label: copy.unreadAriaLabel });
  }

  // Stale is a renderer-derived fact, not a persisted status, which is why it
  // is resolved here rather than in `presentSessionStatus`. `attention`, not
  // `error`: the connection is gone but the task still sends, on the default
  // connection. It used to be a trailing `Badge`; the row's dimming is the
  // visual now, and dimming is cancelled on the selected row and says nothing
  // to assistive tech, so it needs to be in this list either way.
  if (options.stale) {
    signals.push({
      variant: dotForStatus('attention'),
      label: copy.staleAriaLabel,
      tooltip: copy.staleTitle,
    });
  }

  return signals;
}

interface SessionRunningState {
  responding: boolean;
  running: boolean;
  liveStateOwnsRunningStatus: boolean;
}

/**
 * One live-state authority for both task rows and their project summary.
 *
 * Renderer-local streaming covers the send-to-catalog synchronization window;
 * Runtime Host turn ids cover other windows and bot channels. A persisted
 * `running` status remains the fallback only while Host live state is unknown.
 */
function resolveSessionRunningState(
  session: SessionSummary,
  rendererStreaming: boolean,
): SessionRunningState {
  const requiresUserAttention =
    session.status === 'waiting_for_user' || session.status === 'blocked';
  const liveStateOwnsRunningStatus =
    session.status === 'running' && session.runningTurnIds !== undefined;
  const responding =
    !requiresUserAttention &&
    (rendererStreaming || (session.runningTurnIds?.length ?? 0) > 0);
  return {
    responding,
    running:
      responding ||
      (!requiresUserAttention &&
        session.status === 'running' &&
        !liveStateOwnsRunningStatus),
    liveStateOwnsRunningStatus,
  };
}

interface SessionGroup {
  id: 'pinned' | 'unpinned';
  label: string;
  sessions: SessionSummary[];
}

function groupSessionsForHistory(
  sessions: readonly SessionSummary[],
  locale: UiLocale,
): SessionGroup[] {
  const copy = getConversationCopy(locale).sessions;
  const ordered = [...sessions].sort((a, b) => {
    const timestampDelta = (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
    return timestampDelta || a.id.localeCompare(b.id);
  });
  const pinned = ordered.filter((session) => session.isFlagged);
  const unpinned = ordered.filter((session) => !session.isFlagged);
  const groups: SessionGroup[] = [];
  if (pinned.length > 0) {
    groups.push({ id: 'pinned', label: copy.pinned, sessions: pinned });
  }
  if (unpinned.length > 0) {
    // Visible SideNavSection title so pinned / recent read as two zones
    // (empty label used to drop the section chrome and blur the boundary).
    groups.push({ id: 'unpinned', label: copy.recent, sessions: unpinned });
  }
  return groups;
}
