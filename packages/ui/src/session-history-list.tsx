import { memo, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import type { SessionSummary, UiLocale } from '@maka/core';
import { formatCompactTimestamp } from '@maka/core';
import {
  Archive,
  ArchiveRestore,
  Ban,
  Bot,
  ChevronRight,
  CircleCheckBig,
  Eye,
  FolderOpen,
  Hourglass,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  ShieldAlert,
  Trash2,
} from './icons.js';
import { EmptyState } from './empty-state.js';
import { OverlayScrollArea } from './overlay-scroll-area.js';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from './primitives/menu.js';
import { Button as UiButton } from './ui.js';
import { Button as BaseButton } from '@base-ui/react/button';
import { describeBlockedReason, presentSessionStatus } from './session-status-presentation.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

type SessionRowActionId = 'flag' | 'archive' | 'rename' | 'delete';
type SessionHistoryGroupVariant = 'conversation' | 'project';
const PROJECT_GROUP_PREVIEW_LIMIT = 4;

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

export interface SessionHistoryGroup {
  id: string;
  label: string;
  sessions: SessionSummary[];
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
    // PR-SIDEBAR-IA-0 Phase 2 fixup (xuan `71687cc7`): the
    // ArrowLeft/ArrowRight filter cycle was REMOVED. Hidden state
    // without visible UI is harder for users to discover and harder
    // for review to verify. If we re-introduce Pinned/Archived
    // access in the future it will be a deliberate, visible,
    // lightweight control (per kenji `9f683ea8`).
    if (event.key === 'Delete' || event.key === 'Backspace') {
      // Delete on a focused row opens the App-level confirmation (which
      // toast.confirm()s); we do not delete silently per the lifecycle
      // contract.
      const active = document.activeElement as HTMLElement | null;
      const row = active?.closest('.maka-list-row');
      const sessionId = row?.querySelector<HTMLButtonElement>('.maka-list-row-main')?.dataset.sessionId;
      if (sessionId && props.rowActions) {
        event.preventDefault();
        void props.rowActions.onDelete(sessionId);
      }
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Home' && event.key !== 'End') {
      return;
    }
    const list = event.currentTarget;
    const focusables = Array.from(
      list.querySelectorAll<HTMLButtonElement>('.maka-list-row-main'),
    );
    if (focusables.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const currentIndex = active ? focusables.indexOf(active as HTMLButtonElement) : -1;
    let nextIndex = currentIndex;
    switch (event.key) {
      case 'ArrowDown':
        nextIndex = currentIndex < 0 ? 0 : Math.min(focusables.length - 1, currentIndex + 1);
        break;
      case 'ArrowUp':
        nextIndex = currentIndex <= 0 ? 0 : currentIndex - 1;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = focusables.length - 1;
        break;
    }
    if (nextIndex === currentIndex) return;
    event.preventDefault();
    focusables[nextIndex]?.focus({ preventScroll: false });
    focusables[nextIndex]?.scrollIntoView({ block: 'nearest' });
  }

  return (
    <section className="maka-session-list" aria-label={sessionListTitle}>
      {props.sessions.length === 0 ? (
        // WAWQAQ msg `f56f38c1` (2026-06-20): the create-session CTA
        // belongs in the sidebar header / nav rail, never in the
        // bottom session-history empty state. The empty state here is
        // pure "no sessions yet" copy — no inline CTA. The top-of-
        // sidebar `+ 新任务` button is the only create-session entry.
        <EmptyState
          Icon={MessageSquare}
          title={copy.emptyTitle}
          body={copy.emptyBody}
          extraClassName="maka-session-empty-state"
        />
      ) : (
        <OverlayScrollArea
          className="maka-list-stack"
          viewportClassName="maka-list-stackViewport"
          contentClassName="maka-list-stackContent"
          onKeyDown={handleListKeyDown}
        >
          <SessionListGroups
            groups={
              props.groups
                ? props.groups.map((g) => ({
                    key: g.id,
                    label: g.label,
                    sessions: g.sessions,
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
            onSelectSession={props.onSelectSession}
            rowActions={props.rowActions}
          />
        </OverlayScrollArea>
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
  }>;
  groupVariant: SessionHistoryGroupVariant;
  activeId?: string;
  streamingSessionIds?: Set<string>;
  staleSessionIds?: Set<string>;
  childSessionsByParentId?: ReadonlyMap<string, readonly SessionSummary[]>;
  onSelectSession(sessionId: string): void;
  rowActions?: SessionRowActions;
}) {
  return (
    <>
      {props.groups.map((group) => {
        if (props.groupVariant === 'project') {
          return (
            <ProjectSessionGroup
              key={group.key}
              groupKey={group.key}
              label={group.label}
              sessions={group.sessions}
              activeId={props.activeId}
              streamingSessionIds={props.streamingSessionIds}
              staleSessionIds={props.staleSessionIds}
              childSessionsByParentId={props.childSessionsByParentId}
              onSelectSession={props.onSelectSession}
              rowActions={props.rowActions}
            />
          );
        }
        return (
          <div key={group.key} className="maka-list-group" data-variant="conversation">
            {group.label ? (
              <div className="maka-list-group-label">
                <span>{group.label}</span>
              </div>
            ) : null}
            <div>
              {group.sessions.map((session) => (
                <SessionTreeRow
                  key={session.id}
                  session={session}
                  activeId={props.activeId}
                  streamingSessionIds={props.streamingSessionIds}
                  staleSessionIds={props.staleSessionIds}
                  childSessionsByParentId={props.childSessionsByParentId}
                  onSelectSession={props.onSelectSession}
                  rowActions={props.rowActions}
                />
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}

function ProjectSessionGroup(props: {
  groupKey: string;
  label: string;
  sessions: SessionSummary[];
  activeId?: string;
  streamingSessionIds?: Set<string>;
  staleSessionIds?: Set<string>;
  childSessionsByParentId?: ReadonlyMap<string, readonly SessionSummary[]>;
  onSelectSession(sessionId: string): void;
  rowActions?: SessionRowActions;
}) {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const [revealed, setRevealed] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const activeIsHidden = props.activeId
    ? props.sessions.findIndex((session) => session.id === props.activeId) >= PROJECT_GROUP_PREVIEW_LIMIT
    : false;
  const showAll = revealed || activeIsHidden;
  const visibleSessions = showAll
    ? props.sessions
    : props.sessions.slice(0, PROJECT_GROUP_PREVIEW_LIMIT);
  const hiddenCount = props.sessions.length - visibleSessions.length;

  return (
    <div className="maka-list-group" data-variant="project">
      <BaseButton
        type="button"
        className="maka-list-project-heading"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        aria-controls={`maka-list-group-body-${props.groupKey}`}
      >
        <FolderOpen size={14} aria-hidden="true" />
        <span>{props.label}</span>
      </BaseButton>
      {expanded && (
        <>
          <div id={`maka-list-group-body-${props.groupKey}`}>
            {visibleSessions.map((session) => (
              <SessionTreeRow
                key={session.id}
                session={session}
                activeId={props.activeId}
                streamingSessionIds={props.streamingSessionIds}
                staleSessionIds={props.staleSessionIds}
                childSessionsByParentId={props.childSessionsByParentId}
                onSelectSession={props.onSelectSession}
                rowActions={props.rowActions}
              />
            ))}
          </div>
          {hiddenCount > 0 && (
            <BaseButton
              type="button"
              className="maka-list-project-more"
              onClick={() => setRevealed(true)}
              aria-label={copy.showMoreAriaLabel(hiddenCount)}
            >
              {copy.showMore}
            </BaseButton>
          )}
        </>
      )}
    </div>
  );
}

function SessionTreeRow(props: {
  session: SessionSummary;
  activeId?: string;
  streamingSessionIds?: Set<string>;
  staleSessionIds?: Set<string>;
  childSessionsByParentId?: ReadonlyMap<string, readonly SessionSummary[]>;
  onSelectSession(sessionId: string): void;
  rowActions?: SessionRowActions;
  depth?: number;
}) {
  const depth = props.depth ?? 0;
  const children = props.childSessionsByParentId?.get(props.session.id) ?? [];
  return (
    <div
      className="maka-list-session-tree"
      data-depth={depth > 0 ? String(depth) : undefined}
    >
      <SessionRow
        session={props.session}
        active={props.session.id === props.activeId}
        streaming={props.streamingSessionIds?.has(props.session.id) ?? false}
        stale={props.staleSessionIds?.has(props.session.id) ?? false}
        nested={depth > 0}
        onSelect={props.onSelectSession}
        actions={props.rowActions}
      />
      {children.length > 0 && (
        <div className="maka-list-session-children">
          {children.map((child) => (
            <SessionTreeRow
              key={child.id}
              {...props}
              session={child}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
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

const SessionRow = memo(function SessionRow(props: {
  session: SessionSummary;
  active: boolean;
  /** This session has a live streaming delta in flight. */
  streaming?: boolean;
  /**
   * This session's backend / connection is stale (FakeBackend or a removed
   * connection slug). Dims the row + renders a small "已过期" pill so the
   * user can spot broken sessions in the list before clicking in.
   */
  stale?: boolean;
  /** Render this linked child as an indented nested Session row. */
  nested?: boolean;
  onSelect(sessionId: string): void;
  actions?: SessionRowActions;
}) {
  const { session, active, streaming, stale, nested, actions, onSelect } = props;
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).sessions;
  const [editing, setEditing] = useState(false);
  const [actionsVisible, setActionsVisible] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<SessionRowActionId | null>(null);
  const rowMountedRef = useMountedRef();
  const pendingActionRef = useRef<SessionRowActionId | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // PR-FE-BUG-HUNT-11: Escape on the rename input has to suppress the
  // blur-fires-on-unmount commit. Without this ref, the sequence
  //   type → Escape → setEditing(false) → input unmounts → blur fires
  //   with the typed value → commitRename(typed) → rename happens
  // would silently commit the user's typed value despite the cancel.
  const escapeCancelledRef = useRef(false);
  const actionBusy = pendingAction !== null;
  const actionTriggerVisible = actionsVisible || menuOpen;

  useEffect(() => {
    return () => {
      pendingActionRef.current = null;
    };
  }, []);

  // Auto-focus + select-all when the row enters edit mode so the user can
  // overwrite the current name without an extra Cmd+A.
  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [editing]);

  function startRename() {
    if (!actions || pendingActionRef.current) return;
    setEditing(true);
  }

  function runRowAction(actionId: SessionRowActionId, action: () => void | Promise<void>) {
    if (pendingActionRef.current) return;
    pendingActionRef.current = actionId;
    setPendingAction(actionId);
    void (async () => {
      try {
        await action();
      } catch {
        // The AppShell row-action owner reports the visible failure toast.
      } finally {
        pendingActionRef.current = null;
        if (rowMountedRef.current) setPendingAction(null);
      }
    })();
  }

  function commitRename(rawValue: string) {
    const trimmed = rawValue.trim();
    setEditing(false);
    if (!trimmed || trimmed === session.name) return;
    if (!actions) return;
    runRowAction('rename', () => actions.onRename(session.id, trimmed));
  }

  function handleDelete() {
    if (!actions) return;
    // Delegation: the App-level handler owns the confirmation flow via the
    // toast system (PR24), so SessionRow stays presentation-only.
    runRowAction('delete', () => actions.onDelete(session.id));
  }

  function handleRowBlur(event: FocusEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setActionsVisible(false);
  }

  return (
    <div
      className="maka-list-row"
      data-active={active}
      data-editing={editing}
      data-menu-open={menuOpen ? 'true' : undefined}
      data-streaming={streaming ? 'true' : undefined}
      data-stale={stale ? 'true' : undefined}
      data-subagent={nested ? 'true' : undefined}
      onMouseEnter={() => setActionsVisible(true)}
      onMouseLeave={(event) => {
        if (event.currentTarget.contains(document.activeElement)) return;
        setActionsVisible(false);
      }}
      onFocus={() => setActionsVisible(true)}
      onBlur={handleRowBlur}
    >
      {editing ? (
        <form
          className="maka-list-row-main"
          onSubmit={(event) => {
            event.preventDefault();
            commitRename(inputRef.current?.value ?? '');
          }}
        >
          <div>
            <input
              ref={inputRef}
              className="maka-list-row-rename-input"
              defaultValue={session.name}
              maxLength={80}
              aria-label={copy.renameAriaLabel}
              onBlur={(event) => {
                // PR-FE-BUG-HUNT-11: skip the commit when the blur was
                // caused by Escape cancelling edit mode (input unmounts
                // → blur fires with the typed value otherwise).
                if (escapeCancelledRef.current) {
                  escapeCancelledRef.current = false;
                  return;
                }
                commitRename(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                // IME guard so committing CJK characters with Enter doesn't
                // submit the rename before the user is done.
                if (event.nativeEvent.isComposing || event.key === 'Process') return;
                if (event.key === 'Escape') {
                  event.preventDefault();
                  escapeCancelledRef.current = true;
                  setEditing(false);
                }
              }}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="maka-list-row-meta">{formatSessionMeta(session, locale)}</div>
          </div>
        </form>
      ) : (
        // PR-SIDEBAR-IA-0 Phase 3 (WAWQAQ `14ed98b5` "list 很丑、很肥很
        // 臃肿"; xuan `6b28984e` Phase 2 sign-off + Phase 3 32-40px
        // target; xuan `2d4526b5` tightening: NO native title= snippet,
        // title is ONLY for name truncation): slim row.
        //
        // The button is the row's hit target. The native `title=`
        // attribute carries ONLY the session name so it serves as a
        // truncation tooltip when the name overflows the row. The
        // `lastMessagePreview` snippet is intentionally NOT exposed
        // here — per xuan `2d4526b5`, snippet visibility is a
        // separate, deliberate design (future PR), not a Phase 3
        // afterthought via native tooltip.
        //
        // `data-active` on the row controls the active-state accent
        // rail + bg tint via CSS; the row's `name` cluster also
        // recolors to accent on selected so the row reads as
        // "current" without a heavy full-bg pill.
        /* PR-SESSION-ROW-MAIN-PRIMITIVE-0 (round 14/30): the
           single most-clicked button in the app — every session
           row's main click target. This composite navigation row keeps its
           grid layout and multi-line density in the semantic row seam rather
           than masquerading as a shared Button size. */
        <BaseButton
          className="maka-list-row-main"
          type="button"
          data-session-id={session.id}
          aria-current={active ? 'true' : undefined}
          title={session.name}
          onClick={() => onSelect(session.id)}
          onDoubleClick={(event) => {
            event.stopPropagation();
            if (actions && !pendingActionRef.current) setEditing(true);
          }}
        >
          {/*
            PR-SIDEBAR-IA-0 Phase 3 layout (xuan `2d4526b5`):
              [.maka-list-row-text  (col 1: minmax(0,1fr))] [meta/unread  (col 2: auto)]
            The text container holds the name cluster (status icons +
            name + stale pill) and truncates via min-width: 0. The
            meta column sits at the inline-end with a clear gap so
            "会话 02" doesn't run into "0m ago".
          */}
          <div className="maka-list-row-text">
            <div className="maka-list-row-name">
              {nested && (
                <Bot
                  size={12}
                  aria-hidden="true"
                  className="maka-list-row-subagent-icon"
                />
              )}
              {streaming && (
                <span
                  className="maka-list-row-streaming-dot"
                  aria-label={copy.respondingAriaLabel}
                  title={copy.respondingTitle}
                />
              )}
              <SessionStatusIcon session={session} />
              <span>{session.name}</span>
              {stale && (
                <span
                  className="maka-list-row-stale-pill"
                  // The pill semantics match the chat-header banner: the
                  // session uses a backend / connection that no longer exists,
                  // but @xuan's send-path silent rebind will swap to the
                  // default on send. Tooltip explains why.
                  title={copy.staleTitle}
                  aria-label={copy.staleAriaLabel}
                >
                  {copy.stale}
                </span>
              )}
            </div>
          </div>
          {/*
            PR-SIDEBAR-IA-0 Phase 3 (xuan `2d4526b5`): snippet preview
            (`.maka-list-row-preview`) is no longer rendered in the
            default DOM AND is no longer exposed via native `title=`
            tooltip. Snippet visibility is deliberately deferred to a
            future PR with its own hover/focus detail design.
            `formatSessionMeta` shows the relative time inline in the
            row's `auto` grid column (sibling of `.maka-list-row-text`,
            not nested inside it — required for proper gap + alignment).
            The unread dot replaces the time only when no higher-priority
            row state is active. Borrowed from PawWork's sidebar priority:
            asking/busy/error outrank unread; unread outranks plain time.
          */}
          {shouldShowSessionUnreadDot(session, Boolean(streaming), active) ? (
            <span className="maka-list-row-unread" aria-label={copy.unreadAriaLabel} />
          ) : (
            <span className="maka-list-row-meta">{formatSessionMeta(session, locale)}</span>
          )}
        </BaseButton>
      )}
      {actions && !editing && (
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger
            aria-label={copy.actionsAriaLabel}
            aria-hidden={actionTriggerVisible ? undefined : 'true'}
            className="maka-list-row-menu-trigger"
            data-visible={actionTriggerVisible ? 'true' : undefined}
            disabled={actionBusy}
            tabIndex={actionTriggerVisible ? 0 : -1}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="end" side="bottom">
            <MenuItem
              disabled={actionBusy}
              onClick={() => runRowAction('flag', () => actions.onToggleFlag(session.id, !session.isFlagged))}
            >
              {session.isFlagged
                ? <PinOff size={16} aria-hidden="true" />
                : <Pin size={16} aria-hidden="true" />}
              {session.isFlagged ? copy.unpin : copy.pin}
            </MenuItem>
            <MenuItem disabled={actionBusy} onClick={startRename}>
              <Pencil size={16} aria-hidden="true" />
              {copy.rename}
            </MenuItem>
            <MenuItem
              disabled={actionBusy}
              onClick={() => runRowAction('archive', () => (
                session.isArchived
                  ? actions.onUnarchive(session.id)
                  : actions.onArchive(session.id)
              ))}
            >
              {session.isArchived
                ? <ArchiveRestore size={16} aria-hidden="true" />
                : <Archive size={16} aria-hidden="true" />}
              {session.isArchived ? copy.unarchive : copy.archive}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              disabled={actionBusy}
              onClick={handleDelete}
            >
              <Trash2 size={16} aria-hidden="true" />
              {copy.delete}
            </MenuItem>
          </MenuPopup>
        </Menu>
      )}
    </div>
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
