import {
  memo,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import type { ProjectRecord, SessionSummary, UiLocale } from '@maka/core';
import { formatCompactTimestamp } from '@maka/core';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Bot,
  FolderGit2,
  FolderOpen,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Plug,
  SquarePen,
  Trash2,
} from './icons.js';
import { Badge } from '@astryxdesign/core/Badge';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import {
  SideNavItem,
  SideNavSection,
} from '@astryxdesign/core/SideNav';
import { VStack } from '@astryxdesign/core/Stack';
import { StatusDot, type StatusDotVariant } from '@astryxdesign/core/StatusDot';
import { describeBlockedReason, presentSessionStatus } from './session-status-presentation.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

type SessionRowActionId = 'flag' | 'archive' | 'rename' | 'delete';
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
  onRelink(projectId: string): void | Promise<void>;
}

export interface SessionHistoryGroup {
  id: string;
  label: string;
  sessions: SessionSummary[];
  project?: ProjectRecord;
}

export function SessionHistoryList(props: {
  sessions: SessionSummary[];
  activeId?: string;
  streamingSessionIds?: Set<string>;
  staleSessionIds?: Set<string>;
  groups?: ReadonlyArray<SessionHistoryGroup>;
  worktreeSessionIds?: ReadonlySet<string>;
  projectActions?: ProjectRowActions;
  childSessionsByParentId?: ReadonlyMap<string, readonly SessionSummary[]>;
  groupVariant?: SessionHistoryGroupVariant;
  /** Optional section chrome (title + end actions) wrapping the history. */
  heading?: string;
  headingEnd?: ReactNode;
  onSelectSession(sessionId: string): void;
  rowActions?: SessionRowActions;
}) {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).sessions;
  const sessionListTitle = props.heading ?? copy.title;

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
    if (sessionId && props.rowActions) {
      event.preventDefault();
      void props.rowActions.onDelete(sessionId);
    }
  }

  const body =
    props.sessions.length === 0 &&
    !(props.groupVariant === 'project' && (props.groups?.length ?? 0) > 0) ? (
      <EmptyState
        icon={<MessageSquare />}
        title={copy.emptyTitle}
        description={copy.emptyBody}
        className="maka-session-empty-state"
      />
    ) : (
      <SessionListGroups
        groups={
          props.groups
            ? props.groups.map((g) => ({
                key: g.id,
                label: g.label,
                sessions: g.sessions,
                project: g.project,
              }))
            : groupSessionsForHistory(props.sessions, locale).map((g) => ({
                key: g.id,
                label: g.label,
                sessions: g.sessions,
              }))
        }
        groupVariant={props.groupVariant ?? 'conversation'}
        activeId={props.activeId}
        streamingSessionIds={props.streamingSessionIds}
        staleSessionIds={props.staleSessionIds}
        childSessionsByParentId={props.childSessionsByParentId}
        worktreeSessionIds={props.worktreeSessionIds}
        onSelectSession={props.onSelectSession}
        rowActions={props.rowActions}
        projectActions={props.projectActions}
      />
    );

  // Outer SideNav is the sole navigation landmark; this is scroll content only.
  return (
    <div className="maka-session-list" aria-label={sessionListTitle} onKeyDown={handleListKeyDown}>
      {props.heading ? (
        <SideNavSection
          title={props.heading}
          endContent={props.headingEnd}
          className="maka-session-heading-section"
        >
          {body}
        </SideNavSection>
      ) : (
        body
      )}
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
  groupVariant: SessionHistoryGroupVariant;
  activeId?: string;
  streamingSessionIds?: Set<string>;
  staleSessionIds?: Set<string>;
  childSessionsByParentId?: ReadonlyMap<string, readonly SessionSummary[]>;
  worktreeSessionIds?: ReadonlySet<string>;
  onSelectSession(sessionId: string): void;
  rowActions?: SessionRowActions;
  projectActions?: ProjectRowActions;
}) {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [archivedExpanded, setArchivedExpanded] = useState(false);

  function commitProjectRename(project: ProjectRecord, name: string) {
    setEditingProjectId(null);
    if (!props.projectActions || !name || name === project.name) return;
    void Promise.resolve(props.projectActions.onRename(project.id, name)).catch(() => {
      // AppShell owns visible project-action failure feedback.
    });
  }

  function renderSessionTree(session: SessionSummary, nested: boolean): ReactNode {
    const childSessions = props.childSessionsByParentId?.get(session.id);
    const childNodes =
      childSessions && childSessions.length > 0
        ? childSessions.map((child) => renderSessionTree(child, true))
        : undefined;
    return (
      <SessionNavRow
        key={session.id}
        session={session}
        nested={nested}
        active={session.id === props.activeId}
        streaming={props.streamingSessionIds?.has(session.id) ?? false}
        stale={props.staleSessionIds?.has(session.id) ?? false}
        worktree={props.worktreeSessionIds?.has(session.id) ?? false}
        editing={editingSessionId === session.id}
        onSelectSession={props.onSelectSession}
        actions={props.rowActions}
        setEditingSessionId={setEditingSessionId}
      >
        {childNodes}
      </SessionNavRow>
    );
  }

  if (props.groupVariant === 'project') {
    const activeGroups = props.groups.filter((group) => group.project?.archivedAt === undefined);
    const archivedGroups = props.groups.filter((group) => group.project?.archivedAt !== undefined);

    function renderProjectGroup(
      group: (typeof props.groups)[number],
    ): ReactNode {
      const project = group.project;
      const isEditing = Boolean(project && editingProjectId === project.id);
      if (isEditing && project) {
        return (
          <ProjectRenameRow
            key={group.key}
            groupKey={group.key}
            label={group.label}
            onCommit={(name) => commitProjectRename(project, name)}
            onCancel={() => setEditingProjectId(null)}
          />
        );
      }
      return (
        <ProjectNavRow
          key={group.key}
          groupKey={group.key}
          label={group.label}
          project={project}
          sessions={group.sessions}
          projectActions={props.projectActions}
          onStartRename={() => {
            if (project) setEditingProjectId(project.id);
          }}
          renderSession={(session) => renderSessionTree(session, false)}
        />
      );
    }

    return (
      <>
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
      {props.groups.map((group) => {
        const items = group.sessions.map((session) => renderSessionTree(session, false));
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
  onStartRename(): void;
  renderSession(session: SessionSummary): ReactNode;
}) {
  // Collapsible only when there is a real session subtree. An empty VStack is
  // still truthy children for Astryx (!!children) and fabricates a disclosure.
  const hasSessions = props.sessions.length > 0;
  return (
    <div data-project-id={props.groupKey} className="maka-project-row">
      <SideNavItem
        label={props.label}
        icon={FolderOpen}
        collapsible={hasSessions ? { defaultIsCollapsed: false } : undefined}
        endContent={
          <ProjectItemEndContent
            project={props.project}
            sessionCount={props.sessions.length}
            actions={props.projectActions}
            onStartRename={props.onStartRename}
          />
        }
      >
        {/* Nest indent zeroed one level in sidebar.css (time-sort left edge). */}
        {hasSessions ? (
          <VStack gap={0.5}>{props.sessions.map((session) => props.renderSession(session))}</VStack>
        ) : undefined}
      </SideNavItem>
    </div>
  );
}

/** Keeps trailing controls from activating the parent SideNavItem button. */
function EndContentHitTarget(props: { children: ReactNode; className?: string }) {
  return (
    <span
      className={props.className}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {props.children}
    </span>
  );
}

const SessionNavRow = memo(function SessionNavRow(props: {
  session: SessionSummary;
  nested: boolean;
  active: boolean;
  streaming: boolean;
  stale: boolean;
  worktree: boolean;
  editing: boolean;
  onSelectSession(sessionId: string): void;
  actions?: SessionRowActions;
  setEditingSessionId: Dispatch<SetStateAction<string | null>>;
  children?: ReactNode;
}) {
  const locale = useUiLocale();
  const metaTitle = formatSessionMeta(props.session, locale);
  const childArray = props.children
    ? Array.isArray(props.children)
      ? props.children
      : [props.children]
    : [];
  const hasChildren = childArray.some(Boolean);

  if (props.editing) {
    return (
      <SessionRenameRow
        session={props.session}
        onCommit={(name) => {
          props.setEditingSessionId(null);
          if (!props.actions || !name || name === props.session.name) return;
          void Promise.resolve(props.actions.onRename(props.session.id, name)).catch(() => {
            // AppShell owns visible session-action failure feedback.
          });
        }}
        onCancel={() => props.setEditingSessionId(null)}
      />
    );
  }

  return (
    <div
      className="maka-session-row"
      data-maka-contract="session-row"
      data-session-id={props.session.id}
      data-subagent={props.nested ? 'true' : undefined}
      data-stale={props.stale ? 'true' : undefined}
      title={metaTitle}
    >
      <SideNavItem
        label={props.session.name}
        // Nested (subagent) rows: native leading Bot icon keeps hierarchy
        // readable without CSS nest-padding overrides. Parent rows stay iconless.
        icon={props.nested ? Bot : undefined}
        size="md"
        isSelected={props.active}
        collapsible={hasChildren ? { defaultIsCollapsed: false } : undefined}
        onClick={(event) => {
          if (event.detail > 1 && props.actions) {
            props.setEditingSessionId(props.session.id);
            return;
          }
          props.onSelectSession(props.session.id);
        }}
        endContent={
          <SessionItemEndContent
            session={props.session}
            active={props.active}
            streaming={props.streaming}
            stale={props.stale}
            worktree={props.worktree}
            actions={props.actions}
            setEditingSessionId={props.setEditingSessionId}
          />
        }
      >
        {hasChildren ? props.children : undefined}
      </SideNavItem>
    </div>
  );
});

function SessionRenameRow(props: {
  session: SessionSummary;
  onCommit(name: string): void;
  onCancel(): void;
}) {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const inputRef = useRef<HTMLInputElement>(null);
  const escapeCancelledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div
      className="maka-session-row maka-session-row--editing"
      data-maka-contract="session-row"
      data-session-id={props.session.id}
    >
      <input
        ref={inputRef}
        className="maka-session-rename-input"
        defaultValue={props.session.name}
        maxLength={80}
        aria-label={copy.renameAriaLabel}
        onBlur={(event) => {
          if (escapeCancelledRef.current) {
            escapeCancelledRef.current = false;
            return;
          }
          props.onCommit(event.currentTarget.value.trim());
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing || event.key === 'Process') return;
          if (event.key === 'Enter') {
            event.preventDefault();
            props.onCommit(event.currentTarget.value.trim());
          } else if (event.key === 'Escape') {
            event.preventDefault();
            escapeCancelledRef.current = true;
            props.onCancel();
          }
        }}
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  );
}

function ProjectRenameRow(props: {
  groupKey: string;
  label: string;
  onCommit(name: string): void;
  onCancel(): void;
}) {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const inputRef = useRef<HTMLInputElement>(null);
  const escapeCancelledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div
      data-project-id={props.groupKey}
      className="maka-session-row maka-session-row--editing"
    >
      <input
        ref={inputRef}
        className="maka-session-rename-input"
        defaultValue={props.label}
        maxLength={80}
        aria-label={copy.projectRename}
        onBlur={(event) => {
          if (escapeCancelledRef.current) {
            escapeCancelledRef.current = false;
            return;
          }
          props.onCommit(event.currentTarget.value.trim());
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing || event.key === 'Process') return;
          if (event.key === 'Enter') {
            event.preventDefault();
            props.onCommit(event.currentTarget.value.trim());
          } else if (event.key === 'Escape') {
            event.preventDefault();
            escapeCancelledRef.current = true;
            props.onCancel();
          }
        }}
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  );
}

function ProjectItemEndContent(props: {
  project?: ProjectRecord;
  sessionCount: number;
  actions?: ProjectRowActions;
  onStartRename(): void;
}) {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const mountedRef = useMountedRef();
  const pendingActionRef = useRef<string | null>(null);
  const pendingMenuIntentRef = useRef<(() => void) | null>(null);
  const project = props.project;
  const actions = props.actions;

  useEffect(
    () => () => {
      pendingActionRef.current = null;
    },
    [],
  );

  function runProjectAction(actionId: string, action: () => void | Promise<void>) {
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

  // Projects keep a permanent MoreMenu (SideNavEndContent pattern). Hover-only
  // would fire on nested session rows if wired to the project wrapper.
  const menuItems = project && actions
    ? project.archivedAt !== undefined
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
            : [
                {
                  label: copy.projectRelink,
                  icon: Plug,
                  onClick: () => runProjectAction('relink', () => actions.onRelink(project.id)),
                },
              ]),
          {
            label: copy.projectRename,
            icon: Pencil,
            onClick: () => {
              pendingMenuIntentRef.current = props.onStartRename;
            },
          },
          {
            label: copy.projectArchive,
            icon: Archive,
            onClick: () => runProjectAction('archive', () => actions.onArchive(project.id)),
          },
        ]
    : [];

  return (
    <EndContentHitTarget className="maka-session-row-end maka-project-item-end">
      {project && !project.available && (
        <AlertTriangle size={12} aria-label={copy.projectUnavailable} />
      )}
      <Badge variant="neutral" label={props.sessionCount} />
      {menuItems.length > 0 && (
        <MoreMenu
          size="sm"
          label={copy.projectActionsAriaLabel(project?.name ?? '')}
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
      )}
    </EndContentHitTarget>
  );
}

const SessionItemEndContent = memo(function SessionItemEndContent(props: {
  session: SessionSummary;
  active: boolean;
  streaming: boolean;
  stale: boolean;
  worktree: boolean;
  actions?: SessionRowActions;
  setEditingSessionId: Dispatch<SetStateAction<string | null>>;
}) {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).sessions;
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<SessionRowActionId | null>(null);
  const mountedRef = useMountedRef();
  const pendingActionRef = useRef<SessionRowActionId | null>(null);
  const pendingMenuIntentRef = useRef<(() => void) | null>(null);
  const actions = props.actions;
  const statusDot = resolveSessionStatusDot(props.session, props.streaming, props.active, locale);

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

  // Signal (status/unread) and action (MoreMenu) are orthogonal — same as
  // project rows (badge + menu). No hover XOR state machine.
  const signal = statusDot ? (
    <StatusDot
      variant={statusDot.variant}
      label={statusDot.label}
      isPulsing={statusDot.isPulsing}
      tooltip={statusDot.tooltip}
      data-session-status={props.session.status}
    />
  ) : shouldShowSessionUnreadDot(props.session, props.streaming, props.active) ? (
    <StatusDot variant="accent" label={copy.unreadAriaLabel} data-session-status="unread" />
  ) : null;

  return (
    <EndContentHitTarget className="maka-session-row-end">
      {props.stale && (
        <span
          className="maka-list-row-stale-pill"
          title={copy.staleTitle}
          aria-label={copy.staleAriaLabel}
        >
          {copy.stale}
        </span>
      )}
      {props.worktree && (
        <FolderGit2
          size={12}
          aria-label={copy.worktreeAriaLabel}
          className="maka-session-worktree-icon"
        />
      )}
      {signal}
      {actions ? (
        <span className="maka-session-row-trailing">
          <MoreMenu
            size="sm"
            label={copy.actionsAriaLabel}
            isDisabled={pendingAction !== null}
            isMenuOpen={menuOpen}
            onOpenChange={(open) => {
              setMenuOpen(open);
              if (open) return;
              const intent = pendingMenuIntentRef.current;
              pendingMenuIntentRef.current = null;
              if (intent) {
                window.requestAnimationFrame(() => {
                  intent();
                });
              }
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
                  pendingMenuIntentRef.current = () =>
                    props.setEditingSessionId(props.session.id);
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
      ) : (
        <span className="maka-session-row-trailing">
          {signal ? null : <span className="maka-session-row-trailing-spacer" aria-hidden="true" />}
        </span>
      )}
    </EndContentHitTarget>
  );
});

function resolveSessionStatusDot(
  session: SessionSummary,
  streaming: boolean,
  active: boolean,
  locale: UiLocale,
): { variant: StatusDotVariant; label: string; isPulsing?: boolean; tooltip?: string } | null {
  if (streaming) {
    const copy = getConversationCopy(locale).sessions;
    return {
      variant: 'accent',
      label: copy.respondingAriaLabel,
      isPulsing: true,
      tooltip: copy.respondingTitle,
    };
  }

  const status = session.status;
  if (status === 'active' && !active) {
    // Idle rows keep a quiet neutral dot (shell-side-nav pattern).
    return null;
  }
  if (status === 'active') return null;

  const { label, tone } = presentSessionStatus(status, locale);
  const blockedDetail =
    status === 'blocked' && session.blockedReason
      ? describeBlockedReason(session.blockedReason, locale)
      : null;
  return {
    variant: toneToStatusDotVariant(tone),
    label,
    isPulsing: status === 'running',
    tooltip: blockedDetail ? `${label} · ${blockedDetail}` : label,
  };
}

function toneToStatusDotVariant(
  tone: ReturnType<typeof presentSessionStatus>['tone'],
): StatusDotVariant {
  switch (tone) {
    case 'accent':
      return 'accent';
    case 'warning':
      return 'warning';
    case 'destructive':
      return 'error';
    case 'success':
      return 'success';
    case 'info':
      return 'accent';
    case 'muted':
    case 'neutral':
    default:
      return 'neutral';
  }
}

function shouldShowSessionUnreadDot(
  session: SessionSummary,
  streaming: boolean,
  active: boolean,
): boolean {
  if (active) return false;
  if (!session.hasUnread) return false;
  if (streaming) return false;
  return !SIDEBAR_UNREAD_SUPPRESSED_STATUSES.has(session.status);
}

const SIDEBAR_UNREAD_SUPPRESSED_STATUSES = new Set<string>([
  'running',
  'waiting_for_user',
  'blocked',
]);

interface SessionGroup {
  id: 'pinned' | 'unpinned';
  label: string;
  sessions: SessionSummary[];
}

function groupSessionsForHistory(sessions: SessionSummary[], locale: UiLocale): SessionGroup[] {
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

function formatSessionMeta(session: SessionSummary, locale: UiLocale): string {
  if (!session.lastMessageAt) return getConversationCopy(locale).chat.noMessages;
  return formatCompactTimestamp(session.lastMessageAt, Date.now(), locale);
}
