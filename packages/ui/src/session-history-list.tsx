import {
  memo,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
} from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import type { ProjectRecord, SessionSummary, UiLocale } from '@maka/core';
import { formatCompactTimestamp } from '@maka/core';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Ban,
  Bot,
  CircleCheckBig,
  Eye,
  FolderGit2,
  FolderOpen,
  Hourglass,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  ShieldAlert,
  Trash2,
} from './icons.js';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@astryxdesign/core/DropdownMenu';
import { Divider } from '@astryxdesign/core/Divider';
import { List, ListItem } from '@astryxdesign/core/List';
import { TreeList, type TreeListItemData } from '@astryxdesign/core/TreeList';
import { describeBlockedReason, presentSessionStatus } from './session-status-presentation.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

type SessionRowActionId = 'flag' | 'archive' | 'rename' | 'delete';
type SessionHistoryGroupVariant = 'conversation' | 'project';

export interface SessionRowActions {
  /** Flag (pin) state toggle. */
  onToggleFlag(sessionId: string, next: boolean): void | Promise<void>;
  /** Move to / out of the archive bucket. */
  onArchive(sessionId: string): void | Promise<void>;
  onUnarchive(sessionId: string): void | Promise<void>;
  /** Rename via inline prompt. Receives the new (trimmed) name. */
  onRename(sessionId: string, name: string): void | Promise<void>;
  /** Permanent removal — caller is responsible for the confirm gate. */
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
  /**
   * Per-session-id boolean flag: true when the session has a live streaming
   * delta in flight. Rendered as a small pulsing accent dot on the row.
   * Caller derives this from the live-turn projection so the sidebar
   * shows live activity without subscribing to the stream itself.
   */
  streamingSessionIds?: Set<string>;
  /**
   * Per-session-id boolean flag: true when the session's backend / connection
   * is stale (`backend='fake'` or `llmConnectionSlug` no longer resolves).
   * The row dims + shows a small "已过期" pill so users notice in the list
   * before clicking in and seeing the chat header banner. Caller derives this
   * by joining `sessions` against `connections` — keeps SessionListPanel
   * unaware of the connection store.
   */
  staleSessionIds?: Set<string>;
  /** Pre-computed groups used by the project view. */
  groups?: ReadonlyArray<SessionHistoryGroup>;
  worktreeSessionIds?: ReadonlySet<string>;
  projectActions?: ProjectRowActions;
  /** Linked subagent Sessions keyed by their durable parent Session id. */
  childSessionsByParentId?: ReadonlyMap<string, readonly SessionSummary[]>;
  groupVariant?: SessionHistoryGroupVariant;
  onSelectSession(sessionId: string): void;
  rowActions?: SessionRowActions;
}) {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).sessions;
  // 参考实现 keeps the lower sidebar region as stable chat history
  // even when Skills / Scheduled Tasks are open in the main pane.
  const sessionListTitle = copy.title;
  // PR-UX-POLISH-1 commit 4 (WAWQAQ msg `e0dbad11` + kenji msg
  // `2844f64f`): in-list `筛选会话` filter input removed. All search
  // capability lives in the top-level `搜索` modal (PR-SEARCH-MODAL-
  // REAL-0 wires it to the desktop preload's thread search in the same PR).
  // The previous `searchQuery` state + `searchInputRef` + ⌘F/Ctrl+F
  // focus binding are gone with it; ⌘F is freed for future use.
  // `filteredSessions` collapses to a direct passthrough of
  // `props.sessions` — group rendering downstream still partitions
  // by status / time / filter.

  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    const active = document.activeElement as HTMLElement | null;
    if (!active || active.matches('input, textarea, [contenteditable="true"]')) return;
    const row = active.closest<HTMLElement>(
      '[role="treeitem"], [data-maka-contract="list-row"], [data-session-id]',
    );
    const sessionId = row?.dataset.sessionId ?? row?.querySelector<HTMLElement>('[data-session-id]')?.dataset.sessionId;
    if (sessionId && props.rowActions) {
      event.preventDefault();
      void props.rowActions.onDelete(sessionId);
    }
  }

  return (
    <section className="maka-session-list" aria-label={sessionListTitle} onKeyDown={handleListKeyDown}>
      {props.sessions.length === 0 &&
      !(props.groupVariant === 'project' && (props.groups?.length ?? 0) > 0) ? (
        // WAWQAQ msg `f56f38c1` (2026-06-20): the create-session CTA
        // belongs in the sidebar header / nav rail, never in the
        // bottom session-history empty state. The empty state here is
        // pure "no sessions yet" copy — no inline CTA. The top-of-
        // sidebar `+ 新任务` button is the only create-session entry.
        <EmptyState
          icon={<MessageSquare />}
          title={copy.emptyTitle}
          description={copy.emptyBody}
          className="maka-session-empty-state"
        />
      ) : (
        <div className="maka-list-stackContent">
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
        </div>
      )}
    </section>
  );
}

/** Render either the flat conversation groups or project disclosures. */
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

  function commitSessionRename(session: SessionSummary, name: string) {
    setEditingSessionId(null);
    if (!props.rowActions || !name || name === session.name) return;
    void Promise.resolve(props.rowActions.onRename(session.id, name)).catch(() => {
      // AppShell owns visible session-action failure feedback.
    });
  }

  function commitProjectRename(project: ProjectRecord, name: string) {
    setEditingProjectId(null);
    if (!props.projectActions || !name || name === project.name) return;
    void Promise.resolve(props.projectActions.onRename(project.id, name)).catch(() => {
      // AppShell owns visible project-action failure feedback.
    });
  }

  if (props.groupVariant === 'project') {
    const activeGroups = props.groups.filter((group) => group.project?.archivedAt === undefined);
    const archivedGroups = props.groups.filter((group) => group.project?.archivedAt !== undefined);
    function sessionItem(session: SessionSummary): TreeListItemData {
      const isEditing = editingSessionId === session.id;
      const nested = true;
      return {
        id: session.id,
        label: (
          <SessionItemLabel
            session={session}
            stale={props.staleSessionIds?.has(session.id) ?? false}
            editing={isEditing}
            onCommit={(name) => commitSessionRename(session, name)}
            onCancel={() => setEditingSessionId(null)}
          />
        ),
        startContent: (
          <SessionItemStartContent
            session={session}
            nested={nested}
            streaming={props.streamingSessionIds?.has(session.id) ?? false}
            worktree={props.worktreeSessionIds?.has(session.id) ?? false}
          />
        ),
        endContent: (
          <SessionItemEndContent
            session={session}
            active={session.id === props.activeId}
            streaming={props.streamingSessionIds?.has(session.id) ?? false}
            editing={isEditing}
            actions={props.rowActions}
            setEditingSessionId={setEditingSessionId}
          />
        ),
        onClick: isEditing
          ? undefined
          : (event) => {
              if (event.detail > 1 && props.rowActions) {
                setEditingSessionId(session.id);
                return;
              }
              props.onSelectSession(session.id);
            },
        isSelected: session.id === props.activeId,
        children: (props.childSessionsByParentId?.get(session.id) ?? []).map(sessionItem),
      };
    }
    const projectItem = (group: (typeof props.groups)[number]): TreeListItemData => {
      const project = group.project;
      const isEditing = Boolean(project && editingProjectId === project.id);
      return {
        id: group.key,
        label: (
          <ProjectItemLabel
            label={group.label}
            project={project}
            editing={isEditing}
            onCommit={(name) => {
              if (project) commitProjectRename(project, name);
            }}
            onCancel={() => setEditingProjectId(null)}
          />
        ),
        startContent: <FolderOpen size={14} aria-hidden="true" />,
        endContent: (
          <ProjectItemEndContent
            project={project}
            sessionCount={group.sessions.length}
            editing={isEditing}
            actions={props.projectActions}
            onStartRename={() => {
              if (project) setEditingProjectId(project.id);
            }}
          />
        ),
        isExpanded: group.sessions.length > 0,
        children: group.sessions.map(sessionItem),
      };
    };
    const items = activeGroups.map(projectItem);
    if (archivedGroups.length > 0) {
      items.push({
        id: 'archived-projects',
        label: copy.archivedProjects,
        children: archivedGroups.map(projectItem),
      });
    }
    return (
      <TreeList items={items} density="compact" variant="lineGuides" />
    );
  }

  return (
    <>
      {props.groups.map((group) => {
        const sessions = group.sessions.flatMap((session) =>
          flattenSessionBranch(session, props.childSessionsByParentId),
        );
        return (
          <List
            key={group.key}
            className="maka-list-group"
            density="compact"
            header={group.label ? (
              <div className="maka-list-group-label">
                <span>{group.label}</span>
              </div>
            ) : undefined}
          >
            {sessions.map(({ session, nested }) => {
              const isEditing = editingSessionId === session.id;
              return (
                <ListItem
                  key={session.id}
                  className="maka-session-list-item"
                  data-maka-contract="list-row"
                  data-subagent={nested ? 'true' : undefined}
                  isSelected={session.id === props.activeId}
                  onClick={isEditing ? undefined : (event) => {
                    if (event.detail > 1 && props.rowActions) {
                      setEditingSessionId(session.id);
                      return;
                    }
                    props.onSelectSession(session.id);
                  }}
                  startContent={
                    <SessionItemStartContent
                      session={session}
                      nested={nested}
                      streaming={props.streamingSessionIds?.has(session.id) ?? false}
                      worktree={props.worktreeSessionIds?.has(session.id) ?? false}
                    />
                  }
                  label={
                    <SessionItemLabel
                      session={session}
                      stale={props.staleSessionIds?.has(session.id) ?? false}
                      editing={isEditing}
                      onCommit={(name) => commitSessionRename(session, name)}
                      onCancel={() => setEditingSessionId(null)}
                    />
                  }
                  endContent={
                    <SessionItemEndContent
                      session={session}
                      active={session.id === props.activeId}
                      streaming={props.streamingSessionIds?.has(session.id) ?? false}
                      editing={isEditing}
                      actions={props.rowActions}
                      setEditingSessionId={setEditingSessionId}
                    />
                  }
                />
              );
            })}
          </List>
        );
      })}
    </>
  );
}

function ProjectItemLabel(props: {
  label: string;
  project?: ProjectRecord;
  editing: boolean;
  onCommit(name: string): void;
  onCancel(): void;
}) {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const inputRef = useRef<HTMLInputElement>(null);
  const escapeCancelledRef = useRef(false);

  useEffect(() => {
    if (!props.editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [props.editing]);

  if (props.editing) {
    return (
      <input
        ref={inputRef}
        className="maka-list-project-rename"
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
    );
  }

  return (
    <span
      className="maka-list-project-heading"
      data-variant="project"
      data-unavailable={props.project && !props.project.available ? 'true' : undefined}
    >
      <span className="maka-list-project-name">{props.label}</span>
      {props.project && !props.project.available && (
        <AlertTriangle size={12} aria-label={copy.projectUnavailable} />
      )}
    </span>
  );
}

function ProjectItemEndContent(props: {
  project?: ProjectRecord;
  sessionCount: number;
  editing: boolean;
  actions?: ProjectRowActions;
  onStartRename(): void;
}) {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const mountedRef = useMountedRef();
  const pendingActionRef = useRef<string | null>(null);
  const pendingMenuIntentRef = useRef<(() => void) | null>(null);
  const project = props.project;
  const actions = props.actions;

  useEffect(() => () => {
    pendingActionRef.current = null;
  }, []);

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

  return (
    <span className="maka-project-item-end">
      <span className="maka-list-project-count">{props.sessionCount}</span>
      {project && actions && !props.editing && (
        <DropdownMenu
          isMenuOpen={menuOpen}
          onOpenChange={(open) => {
            setMenuOpen(open);
            if (open) return;
            const intent = pendingMenuIntentRef.current;
            pendingMenuIntentRef.current = null;
            if (intent) window.requestAnimationFrame(intent);
          }}
          button={{
            label: copy.projectActionsAriaLabel(project.name),
            icon: pendingAction
              ? <Loader2 size={14} aria-hidden="true" />
              : <MoreHorizontal size={14} aria-hidden="true" />,
            isIconOnly: true,
            variant: 'ghost',
            size: 'sm',
            isDisabled: pendingAction !== null,
          }}
        >
          {project.archivedAt !== undefined ? (
            <DropdownMenuItem
              onClick={() => runProjectAction('restore', () => actions.onRestore(project.id))}
              icon={<ArchiveRestore size={15} aria-hidden="true" />}
              label={copy.projectRestore}
            />
          ) : (
            <>
              {project.available ? (
                <DropdownMenuItem
                  onClick={() => runProjectAction('new', () => actions.onNew(project.id))}
                  icon={<Plus size={15} aria-hidden="true" />}
                  label={copy.projectNewTask}
                />
              ) : (
                <DropdownMenuItem
                  onClick={() => runProjectAction('relink', () => actions.onRelink(project.id))}
                  icon={<FolderOpen size={15} aria-hidden="true" />}
                  label={copy.projectRelink}
                />
              )}
              <Divider orientation="horizontal" />
              <DropdownMenuItem
                onClick={() => {
                  pendingMenuIntentRef.current = props.onStartRename;
                }}
                icon={<Pencil size={15} aria-hidden="true" />}
                label={copy.projectRename}
              />
              <DropdownMenuItem
                onClick={() => runProjectAction('archive', () => actions.onArchive(project.id))}
                icon={<Archive size={15} aria-hidden="true" />}
                label={copy.projectArchive}
              />
            </>
          )}
        </DropdownMenu>
      )}
    </span>
  );
}

function flattenSessionBranch(
  session: SessionSummary,
  childrenByParentId?: ReadonlyMap<string, readonly SessionSummary[]>,
  nested = false,
): Array<{ session: SessionSummary; nested: boolean }> {
  return [
    { session, nested },
    ...(childrenByParentId?.get(session.id) ?? []).flatMap((child) =>
      flattenSessionBranch(child, childrenByParentId, true),
    ),
  ];
}

/**
 * Small inline icon next to the session name representing its
 * lifecycle status. Hidden for `active`
 * since that's the default and would add visual noise to most rows.
 *
 * `aborted` is rendered as muted history: not an error, not active,
 * and not silently swallowed.
 *
 * Caller is expected to pass a session with a SessionStatus from
 * `@maka/core` — typed as the SessionSummary from props avoids
 * pulling the core type into this file's import list.
 */
function SessionStatusIcon(props: { session: SessionSummary }) {
  const locale = useUiLocale();
  const { session } = props;
  const status = session.status;
  // Active is the default; no icon to reduce noise. Aborted retains a
  // muted icon (per @kenji review on PR109b — aborted is dormant
  // history that must remain visible, not silently swallowed as active).
  if (status === 'active') return null;
  const Icon = STATUS_ICON_BY_STATUS[status as keyof typeof STATUS_ICON_BY_STATUS];
  if (!Icon) return null;
  const { label, tone } = presentSessionStatus(status, locale);
  // `blocked` may attach a reason; we surface the generalized text in
  // the tooltip without exposing the raw enum identifier (per @kenji
  // i18n contract). The shared presentation module owns the mapping so
  // sidebar and renderer surfaces cannot drift.
  const blockedDetail = status === 'blocked' && session.blockedReason
    ? describeBlockedReason(session.blockedReason, locale)
    : null;
  const title = blockedDetail ? `${label} · ${blockedDetail}` : label;
  return (
    <span
      className="maka-list-row-status-icon"
      data-tone={tone}
      data-status={status}
      aria-label={title}
      title={title}
    >
      <Icon size={12} aria-hidden="true" />
    </span>
  );
}

/**
 * PawWork-style sidebar attention priority: asking/busy/error outrank unread,
 * and unread outranks plain time. The status icon beside the name already
 * carries asking/busy/error in Maka, so the right slot only shows the unread
 * dot when no higher-priority row state is active.
 */
function shouldShowSessionUnreadDot(session: SessionSummary, streaming: boolean, active: boolean): boolean {
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

const STATUS_ICON_BY_STATUS = {
  running: Loader2,
  waiting_for_user: Hourglass,
  blocked: ShieldAlert,
  review: Eye,
  done: CircleCheckBig,
  archived: Archive,
  aborted: Ban,
} as const;

function SessionItemLabel(props: {
  session: SessionSummary;
  stale: boolean;
  editing: boolean;
  onCommit(name: string): void;
  onCancel(): void;
}) {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const inputRef = useRef<HTMLInputElement>(null);
  const escapeCancelledRef = useRef(false);

  useEffect(() => {
    if (!props.editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [props.editing]);

  if (props.editing) {
    return (
      <input
        ref={inputRef}
        className="maka-list-row-rename-input"
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
    );
  }

  return (
    <span
      className="maka-session-item-label"
      data-session-id={props.session.id}
      data-stale={props.stale ? 'true' : undefined}
      title={props.session.name}
    >
      <span>{props.session.name}</span>
      {props.stale && (
        <span
          className="maka-list-row-stale-pill"
          title={copy.staleTitle}
          aria-label={copy.staleAriaLabel}
        >
          {copy.stale}
        </span>
      )}
    </span>
  );
}

function SessionItemStartContent(props: {
  session: SessionSummary;
  nested: boolean;
  streaming: boolean;
  worktree: boolean;
}) {
  const copy = getConversationCopy(useUiLocale()).sessions;
  return (
    <span className="maka-session-item-start">
      {props.nested && <Bot size={12} aria-hidden="true" className="maka-list-row-subagent-icon" />}
      {props.worktree && (
        <FolderGit2
          size={12}
          aria-label={copy.worktreeAriaLabel}
          className="maka-list-row-worktree-icon"
        />
      )}
      {props.streaming && (
        <span
          className="maka-list-row-streaming-dot"
          aria-label={copy.respondingAriaLabel}
          title={copy.respondingTitle}
        />
      )}
      <SessionStatusIcon session={props.session} />
    </span>
  );
}

const SessionItemEndContent = memo(function SessionItemEndContent(props: {
  session: SessionSummary;
  active: boolean;
  streaming: boolean;
  editing: boolean;
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
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const actions = props.actions;

  useEffect(() => () => {
    pendingActionRef.current = null;
  }, []);

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
    <span className="maka-session-item-end">
      {shouldShowSessionUnreadDot(props.session, props.streaming, props.active) ? (
        <span className="maka-list-row-unread" aria-label={copy.unreadAriaLabel} />
      ) : (
        <span className="maka-list-row-meta" data-maka-contract="list-row-meta">
          {formatSessionMeta(props.session, locale)}
        </span>
      )}
      {actions && !props.editing && (
        <DropdownMenu
          isMenuOpen={menuOpen}
          onOpenChange={(open) => {
            setMenuOpen(open);
            if (open) return;
            const intent = pendingMenuIntentRef.current;
            pendingMenuIntentRef.current = null;
            if (intent) {
              window.requestAnimationFrame(() => {
                menuTriggerRef.current?.focus();
                intent();
              });
            }
          }}
          button={{
            label: copy.actionsAriaLabel,
            ref: menuTriggerRef,
            icon: <MoreHorizontal size={16} aria-hidden="true" />,
            isIconOnly: true,
            variant: 'ghost',
            size: 'sm',
            className: 'maka-list-row-menu-trigger',
          }}
        >
          <DropdownMenuItem
            isDisabled={pendingAction !== null}
            onClick={() => runRowAction('flag', () => actions.onToggleFlag(props.session.id, !props.session.isFlagged))}
            icon={props.session.isFlagged
              ? <PinOff size={16} aria-hidden="true" />
              : <Pin size={16} aria-hidden="true" />}
            label={props.session.isFlagged ? copy.unpin : copy.pin}
          />
          <DropdownMenuItem
            isDisabled={pendingAction !== null}
            onClick={() => {
              pendingMenuIntentRef.current = () => props.setEditingSessionId(props.session.id);
            }}
            icon={<Pencil size={16} aria-hidden="true" />}
            label={copy.rename}
          />
          <DropdownMenuItem
            isDisabled={pendingAction !== null}
            onClick={() => runRowAction('archive', () => (
              props.session.isArchived
                ? actions.onUnarchive(props.session.id)
                : actions.onArchive(props.session.id)
            ))}
            icon={props.session.isArchived
              ? <ArchiveRestore size={16} aria-hidden="true" />
              : <Archive size={16} aria-hidden="true" />}
            label={props.session.isArchived ? copy.unarchive : copy.archive}
          />
          <Divider orientation="horizontal" />
          <DropdownMenuItem
            isDisabled={pendingAction !== null}
            onClick={() => {
              pendingMenuIntentRef.current = () => runRowAction('delete', () => actions.onDelete(props.session.id));
            }}
            icon={<Trash2 size={16} aria-hidden="true" />}
            label={copy.delete}
            style={{ color: 'var(--destructive-text)' }}
          />
        </DropdownMenu>
      )}
    </span>
  );
});

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
    groups.push({ id: 'unpinned', label: '', sessions: unpinned });
  }
  return groups;
}

function formatSessionMeta(session: SessionSummary, locale: UiLocale): string {
  if (!session.lastMessageAt) return getConversationCopy(locale).chat.noMessages;
  return formatCompactTimestamp(session.lastMessageAt, Date.now(), locale);
}
