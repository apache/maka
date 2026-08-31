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
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
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
  Trash2,
} from './icons.js';
import { RelativeTime } from './relative-time.js';
import { formatAbsoluteTimestamp } from '@maka/core/relative-time';
import { Badge } from '@astryxdesign/core/Badge';
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
import { useSessionRailData } from './session-rail-context.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

type SessionRowActionId = 'flag' | 'archive' | 'rename' | 'delete';
type ProjectRowActionId = 'new' | 'relink' | 'rename' | 'archive' | 'restore';
type SessionHistoryGroupVariant = 'conversation' | 'project';

export interface SessionRowActions {
  onToggleFlag(sessionId: string, next: boolean): void | Promise<void>;
  onArchive(sessionId: string): void | Promise<void>;
  onUnarchive(sessionId: string): void | Promise<void>;
  onRename(sessionId: string, name: string): void | Promise<void>;
  onDelete(sessionId: string): void | Promise<void>;
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

export function SessionHistoryList() {
  const rail = useSessionRailData();
  const locale = useUiLocale();

  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    const active = document.activeElement as HTMLElement | null;
    if (!active || active.matches('input, textarea, [contenteditable="true"]')) return;
    const row = active.closest<HTMLElement>(
      '[data-maka-contract="session-row"], [data-session-id]',
    );
    const sessionId =
      row?.dataset.sessionId ??
      row?.querySelector<HTMLElement>('[data-session-id]')?.dataset.sessionId;
    if (sessionId && rail.rowActions) {
      event.preventDefault();
      void rail.rowActions.onDelete(sessionId);
    }
  }

  // Outer SideNav is the sole navigation landmark and it already carries this
  // panel's name; naming this element too put "任务列表" inside "任务列表",
  // which is one ambiguous match for anything selecting by that name and no
  // extra information for anyone hearing it. It is scroll content and a key
  // handler, nothing an assistive tech user needs to be told about separately.
  return (
    <div className="maka-session-list" onKeyDown={handleListKeyDown}>
      <SessionListGroups
        groups={
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
              }))
        }
      />
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
  const copy = getConversationCopy(useUiLocale()).sessions;
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
    (session: SessionSummary): ReactNode => (
      <SessionNavRow
        key={session.id}
        session={session}
        active={session.id === rail.activeId}
        streaming={rail.streamingSessionIds?.has(session.id) ?? false}
        stale={rail.staleSessionIds?.has(session.id) ?? false}
        worktree={rail.worktreeSessionIds?.has(session.id) ?? false}
        meta={rail.sessionMeta?.(session)}
        onSelectSession={rail.onSelectSession}
        actions={(session as SessionSummary & { readonly shared?: true }).shared
          ? undefined
          : rail.rowActions}
        onStartRename={startRename}
      />
    ),
    [rail, startRename],
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

    function renderProjectGroup(
      group: (typeof props.groups)[number],
    ): ReactNode {
      const project = group.project;
      return (
        <ProjectNavRow
          key={group.key}
          groupKey={group.key}
          label={group.label}
          project={project}
          sessions={group.sessions}
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

    return (
      <>
        {renameDialog}
        {activeGroups.map(renderProjectGroup)}
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
            {archivedGroups.map(renderProjectGroup)}
          </SideNavItem>
        )}
      </>
    );
  }

  return (
    <>
      {renameDialog}
      {props.groups.map((group) => {
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
  projectActions?: ProjectRowActions;
  onStartRename(opener: HTMLElement | null): void;
  renderSession(session: SessionSummary): ReactNode;
}) {
  // Collapsible only when there is a real session subtree. An empty VStack is
  // still truthy children for Astryx (!!children) and fabricates a disclosure.
  const hasSessions = props.sessions.length > 0;
  const hasActions = props.project !== undefined && props.projectActions !== undefined;
  return (
    <div data-project-id={props.groupKey} className="maka-project-row">
      <SideNavItem
        key="navigation"
        label={props.label}
        icon={FolderOpen}
        collapsible={hasSessions ? { defaultIsCollapsed: false } : undefined}
        endContent={
          <ProjectItemMeta
            project={props.project}
            sessionCount={props.sessions.length}
            reserveAction={hasActions}
          />
        }
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
          <VStack gap={0.5}>{props.sessions.map((session) => props.renderSession(session))}</VStack>
        ) : undefined}
      </SideNavItem>
    </div>
  );
}

const SessionNavRow = memo(function SessionNavRow(props: {
  session: SessionSummary;
  active: boolean;
  streaming: boolean;
  stale: boolean;
  worktree: boolean;
  meta?: string;
  onSelectSession(sessionId: string): void;
  actions?: SessionRowActions;
  onStartRename(target: SessionRenameTarget, opener: HTMLElement | null): void;
}) {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).sessions;
  const signals = sessionRowSignals(
    props.session,
    { streaming: props.streaming, stale: props.stale, active: props.active },
    locale,
  );
  const signal = signals[0];
  // What the row communicates without text and the dot does NOT already say,
  // inside the button so it lands in the accessible name. `signals[0]` is
  // skipped because `StatusDot` carries it; the rest of the list, the worktree
  // attribute, and the timestamp reached assistive tech nowhere else — the
  // timestamp renders `aria-hidden` and swaps out for the ⋯ menu, and worktree
  // is an attribute of the row rather than a signal, so it never competes for
  // the dot.
  const rowDescription = [
    ...signals.slice(1).map((entry) => entry.tooltip ?? entry.label),
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
      className="maka-session-row"
      data-maka-contract="session-row"
      data-session-id={props.session.id}
      data-stale={props.stale ? 'true' : undefined}
      data-worktree={props.worktree ? 'true' : undefined}
    >
      <SideNavItem
        label={props.session.name}
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
      {props.actions && (
        <SessionItemActions
          session={props.session}
          actions={props.actions}
          onStartRename={props.onStartRename}
        />
      )}
    </div>
  );
});

function ProjectItemMeta(props: {
  project?: ProjectRecord;
  sessionCount: number;
  reserveAction: boolean;
}) {
  const copy = getConversationCopy(useUiLocale()).sessions;
  return (
    <span className="maka-session-row-end maka-project-item-end">
      {props.project && !props.project.available && (
        <AlertTriangle size={ICON_SIZE.meta} aria-label={copy.projectUnavailable} />
      )}
      <Badge variant="neutral" label={props.sessionCount} />
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

function SessionItemActions(props: {
  session: SessionSummary;
  actions: SessionRowActions;
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
        items={[
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
              // Read now, while the trigger is still the thing the user is on:
              // by the time the intent runs the menu has closed and focus is
              // mid-handover.
              const opener = trailingRef.current?.querySelector<HTMLElement>('button') ?? null;
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
          { type: 'divider' },
          {
            label: copy.delete,
            icon: Trash2,
            onClick: () => {
              pendingMenuIntentRef.current = () =>
                runRowAction('delete', () => actions.onDelete(props.session.id));
            },
          },
        ]}
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
  const requiresUserAttention =
    session.status === 'waiting_for_user' || session.status === 'blocked';

  // `active`, through the same vocabulary as everything else here: streaming is
  // the system working on it right now, which is what that semantic names.
  // Writing `accent` directly would resolve to the identical colour and reopen
  // the drift this change closed — half the row's dots deciding for themselves.
  if (
    !requiresUserAttention &&
    (options.streaming || (session.runningTurnIds?.length ?? 0) > 0)
  ) {
    signals.push({
      variant: dotForStatus('active'),
      label: copy.respondingAriaLabel,
      isPulsing: true,
      tooltip: copy.respondingTitle,
    });
  }

  const { label, variant } = presentSessionStatus(session.status, locale);
  const liveStateOwnsRunningStatus =
    session.status === 'running' && session.runningTurnIds !== undefined;
  if (variant && !liveStateOwnsRunningStatus) {
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
