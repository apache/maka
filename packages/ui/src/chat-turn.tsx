import { memo, useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import { AlertOctagon, Ban, Check, Copy, GitBranch, Info, Loader2, Pencil, RefreshCcw, Timer } from './icons.js';
import { type ClipboardCopyPhase, useClipboardCopyFeedback } from './clipboard-feedback.js';
import { Markdown } from './markdown.js';
import { formatAbsoluteTimestamp, formatClockTime, turnAbortMarkerLabel } from './chat-display-helpers.js';
import { prepareSmoothStreamText, useSmoothStreamContent } from './smooth-stream.js';
import {
  Button as UiButton,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageMetadata,
  ChatSystemMessage,
  IconButton as UiIconButton,
} from '@astryxdesign/core';
import { ChatReasoning } from './astryx-chat-reasoning.js';
import { Dialog } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import type { AttachmentRef, ProviderRetryEvent, QuoteRef } from '@maka/core';
import type { TurnTimelineItem, TurnViewModel } from './materialize.js';
import { foldTimeline, type FoldedTimelineChild } from './timeline-fold.js';
import { AttachmentFileCard } from './attachment-file-card.js';
import { QuoteRefChip } from './quote-ref-chip.js';
import { Marker, markerVariants, TextShimmer } from './primitives/chat.js';
import { ToolTrow } from './tool-activity.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';
import { AstryxLocaleProvider } from './astryx-i18n.js';

function LocalizedChatMessage({
  accessibleLabel,
  ...props
}: Omit<ComponentPropsWithoutRef<typeof ChatMessage>, 'aria-label'> & {
  accessibleLabel: string;
}) {
  const overrides = useMemo(
    () => ({ '@astryx.chatMessage.messageFrom': accessibleLabel }),
    [accessibleLabel],
  );
  return (
    <AstryxLocaleProvider overrides={overrides}>
      <ChatMessage {...props} />
    </AstryxLocaleProvider>
  );
}

/**
 * Injected host capability that reads a session attachment's bytes. @maka/ui is
 * host-agnostic: it never reaches into the desktop preload or any other host
 * global. The desktop renderer threads its attachment reader through this prop;
 * non-desktop hosts (Storybook, tests, a future web shell) can omit it or supply
 * their own reader,
 * in which case an image attachment stays in its pending skeleton.
 */
export type ReadAttachmentBytes = (
  sessionId: string,
  relativePath: string,
) => Promise<{ ok: true; base64: string; mimeType: string } | { ok: false }>;

/**
 * One chat message body: user verbatim; assistant/system via Markdown.
 * Memoized so streaming list re-renders do not re-parse settled bubbles.
 */
function AttachmentImage(props: { attachment: AttachmentRef; onReadAttachmentBytes?: ReadAttachmentBytes }) {
  const copy = getConversationCopy(useUiLocale()).messages;
  const [src, setSrc] = useState<string | undefined>(undefined);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const { onReadAttachmentBytes } = props;
  useEffect(() => {
    if (props.attachment.ref.kind !== 'session_file') return;
    // No host reader (non-desktop host, or the capability wasn't wired): leave the
    // thumbnail in its pending skeleton rather than reaching into a host global.
    if (!onReadAttachmentBytes) return;
    let cancelled = false;
    onReadAttachmentBytes(props.attachment.ref.sessionId, props.attachment.ref.relativePath)
      .then((result) => {
        if (cancelled || !result.ok) return;
        setSrc(`data:${result.mimeType};base64,${result.base64}`);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [props.attachment, onReadAttachmentBytes]);
  if (!src) {
    return (
      <span className="maka-user-attachment-thumb-pending h-32 w-32 rounded-md border border-[var(--border)] bg-[var(--foreground-alpha-6)] grid place-items-center text-[color:var(--muted-foreground)]" aria-hidden="true">
        <Loader2 className="h-5 w-5 animate-spin" />
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className="group relative inline-flex rounded-md overflow-hidden border border-[var(--border)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        onClick={() => setLightboxOpen(true)}
        aria-label={copy.imageAriaLabel(props.attachment.name)}
      >
        <img className="h-32 w-32 object-cover transition group-hover:opacity-90" src={src} alt={props.attachment.name} />
      </button>
      <Dialog
        isOpen={lightboxOpen}
        onOpenChange={setLightboxOpen}
        padding={0}
        purpose="info"
        width="auto"
        maxHeight="90vh"
        aria-label={copy.imageAriaLabel(props.attachment.name)}
      >
        <Layout
          height="auto"
          content={
            <LayoutContent padding={0} isScrollable={false}>
              <img className="max-h-[90vh] max-w-[90vw] object-contain rounded-md shadow-2xl" src={src} alt={props.attachment.name} />
            </LayoutContent>
          }
        />
      </Dialog>
    </>
  );
}

const MessageBody = memo(function MessageBody(props: {
  role: string;
  text: string;
  ts?: number;
  attachments?: readonly AttachmentRef[];
  quotes?: readonly QuoteRef[];
  onReadAttachmentBytes?: ReadAttachmentBytes;
  /** When set on a user message, show an edit affordance that starts a revision draft. */
  onEditUserMessage?: () => void;
  editDisabled?: boolean;
  editDisabledReason?: string;
}) {
  const locale = useUiLocale();
  const copyText = getConversationCopy(locale).messages;
  if (props.role === 'user') {
    const editActionLabel = props.editDisabled
      ? (props.editDisabledReason ?? copyText.editMessageDisabledRunning)
      : copyText.editMessage;
    const userMetadata = (
      <ChatMessageMetadata
        className="maka-message-meta opacity-0 [transition:opacity_var(--duration-quick)_var(--ease-out-strong)] group-hover/usermsg:opacity-100 focus-within:opacity-100"
        timestamp={
          props.ts !== undefined ? (
            <small
              className="maka-message-time-inline tabular-nums"
              aria-hidden="true"
              title={formatAbsoluteTimestamp(props.ts, locale)}
            >
              {formatClockTime(props.ts, locale)}
            </small>
          ) : undefined
        }
        footer={
          <>
            <MessageCopyButton text={props.text} />
            {props.onEditUserMessage ? (
              <Tooltip content={editActionLabel}>
                <UiIconButton
                  label={editActionLabel}
                  icon={<Pencil size={12} aria-hidden="true" />}
                  variant="ghost"
                  size="sm"
                  className={markerVariants({ variant: 'footer-action' })}
                  aria-disabled={props.editDisabled === true ? 'true' : undefined}
                  data-action="edit"
                  onClick={() => {
                    if (props.editDisabled) return;
                    props.onEditUserMessage?.();
                  }}
                />
              </Tooltip>
            ) : null}
          </>
        }
      />
    );
    return (
      <ChatMessageBubble
        className="maka-chat-message-bubble maka-chat-message-bubble-user"
        metadata={userMetadata}
      >
        <span>{props.text}</span>
        {props.quotes && props.quotes.length > 0 ? (
          <div className="maka-user-quotes flex flex-wrap items-start gap-1 mt-1">
            {props.quotes.map((quote, index) => (
              <QuoteRefChip key={`${quote.sourceTurnId ?? 'quote'}-${index}`} quote={quote} />
            ))}
          </div>
        ) : null}
        {props.attachments && props.attachments.length > 0 ? (
          <div className="maka-user-attachments flex flex-wrap gap-1.5 mt-2">
            {props.attachments.map((attachment, index) => (
              attachment.kind === 'image' ? (
                <AttachmentImage key={`${attachment.name}-${index}`} attachment={attachment} onReadAttachmentBytes={props.onReadAttachmentBytes} />
              ) : (
                <AttachmentFileCard
                  key={`${attachment.name}-${index}`}
                  name={attachment.name}
                  kind={attachment.kind}
                  size={attachment.bytes}
                />
              )
            ))}
          </div>
        ) : null}
      </ChatMessageBubble>
    );
  }
  return (
    <ChatMessageBubble variant="ghost" className="maka-chat-message-bubble maka-chat-message-bubble-assistant">
      <Markdown text={props.text} />
    </ChatMessageBubble>
  );
});


function MessageCopyButton(props: { text: string }) {
  const copyText = getConversationCopy(useUiLocale()).messages;
  const copyFeedback = useClipboardCopyFeedback(1400, { redact: false });
  const copyPhase = copyFeedback.phaseFor('message');
  const copyPending = copyPhase === 'pending';
  const copied = copyPhase === 'copied';

  async function copy() {
    await copyFeedback.copy('message', props.text);
  }

  const baseLabel = copyText.copy;
  const actionLabel = copyPhase === 'pending'
    ? copyText.copying
    : copyPhase === 'copied'
      ? copyText.copied
      : copyPhase === 'failed'
        ? copyText.copyFailed
        : baseLabel;
  const icon = copied
    ? <Check size={12} aria-hidden="true" />
    : <Copy size={12} aria-hidden="true" />;

  return (
    <Tooltip content={actionLabel}>
      <UiIconButton
        label={baseLabel}
        icon={icon}
        variant="ghost"
        size="sm"
        className={markerVariants({ variant: 'footer-action' })}
        aria-busy={copyPending ? 'true' : undefined}
        isDisabled={copyPending}
        data-copied={copied}
        data-copy-feedback={copyPhase ?? undefined}
        data-pending={copyPending ? 'true' : undefined}
        onClick={() => void copy()}
      />
    </Tooltip>
  );
}


/**
 * Renders one conversational turn: user message → tools used → assistant
 * answer, in that order, as a single visual unit. Replaces the previous
 * "message stack + tools panel at end" layout so the user sees the
 * narrative of "ask → tools fired → answer" as one work unit.
 */
export const TurnView = memo(function TurnView(props: {
  turn: TurnViewModel;
  userLabel?: string;
  /**
   * PR109d-b: footer actions derived from `TurnStatus` + lineage map
   * by the consumer (renderer/main.tsx). Each action carries its
   * own `enabled` flag + tooltip; @maka/ui doesn't compute these
   * itself so the policy stays in the renderer where the lineage
   * map is built.
   */
  footerActions?: ReadonlyArray<TurnFooterActionMeta>;
  onFooterAction?: (turnId: string, actionId: TurnFooterActionMeta['id']) => void;
  /**
   * PR109e-d: pre-translated Chinese phrase for a failed turn's
   * `errorClass`. Caller computes via `describeTurnErrorClass()`.
   * Undefined for non-failed turns or when the runtime didn't
   * populate `errorClass`. UI never sees the raw enum identifier.
   */
  failedReasonLabel?: string;
  /**
   * PR-PawWork-run-incident-lite: pre-derived recovery guidance for a failed
   * turn. Caller computes this from error class, retained partial output, and
   * tool activity so the banner can distinguish "retry" from "inspect tool
   * output first".
   */
  failedRecoveryLabel?: string;
  safeResumeAction?: {
    pending: boolean;
    detail?: string;
    onResume(): void;
  };
  /**
   * PR109e-e: forward + reverse lineage badges. The renderer
   * computes the labels (with short turn ids) and click targets;
   * @maka/ui just renders the badge UI.
   */
  lineageBadges?: TurnLineageBadge[];
  /** PR109e-e: invoked when the user clicks a lineage badge. The
   *  renderer scrolls the target turn into view. */
  onLineageBadgeClick?: (targetTurnId: string) => void;
  /**
   * Edit-and-resend for the user message of this turn. Desktop owns the
   * revision draft (branch-before + composer refill); UI only fires the click.
   */
  onEditUserMessage?: (turnId: string) => void;
  /** True when the stored model text differs from the user-facing prompt. */
  editUserMessageTransformed?: boolean;
  /** True while the turn is still running — edit is disabled until terminal. */
  editUserMessageDisabled?: boolean;
  /** True when a search result just navigated to this turn. */
  searchHighlighted?: boolean;
  /**
   * #642 single render path: set only on the active streaming tail turn. When
   * present, the assistant `ChatMessage` renders the live 深度思考 + answer bubble as
   * the trailing entries of its timeline — the SAME node the committed turn
   * will settle into, so live→settled is a data-source swap (no unmount/mount).
   * While live the footer is a reserved-height placeholder, not the real
   * `TurnFooterActions`: the tail turn's derived status is `completed` (a live
   * turn has no `turn_state`), so rendering the real footer would offer a
   * clickable regenerate/branch on a still-streaming answer.
   */
  liveStreaming?: {
    onStreamingSettled?: (messageId?: string) => void;
    processingIndicator?: boolean;
    continuingIndicator?: boolean;
    providerRetry?: ProviderRetryEvent;
  };
  /**
   * Injected host reader for image attachment bytes. Threaded down to the user
   * message's `AttachmentImage` thumbnails; absent on non-desktop hosts, where
   * image thumbnails stay in their pending skeleton. Keeps @maka/ui from
   * reaching into the desktop preload directly.
   */
  onReadAttachmentBytes?: ReadAttachmentBytes;
}) {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).messages;
  const { turn } = props;
  const forwardBadges = props.lineageBadges?.filter((b) => b.direction === 'forward') ?? [];
  const reverseBadges = props.lineageBadges?.filter((b) => b.direction === 'reverse') ?? [];
  // The assistant `ChatMessage` mounts once the turn has any timeline content OR
  // this is the live streaming tail (a thinking-only / textless streaming turn
  // has an empty committed timeline but must still show its live answer block).
  const showAssistantMessage = turn.timeline.length > 0 || !!props.liveStreaming;
  const hasLiveTimelineContent = turn.timeline.some((item) =>
    item.kind === 'thinking'
      ? item.live === true
      : item.kind === 'text'
        ? item.live === true
        : item.items.some((tool) => tool.status === 'pending' || tool.status === 'running' || tool.status === 'waiting_permission'),
  );
  // #1307: the collapsed "Processing" fold is derived at render time from the
  // flat timeline. Settled turn identities are stable (memoized projections),
  // so this only recomputes for the turn whose timeline actually changed.
  const foldedTimeline = useMemo(() => foldTimeline(turn.timeline), [turn.timeline]);
  return (
    <section
      className="maka-turn"
      data-maka-contract="markdown-flow"
      data-turn-id={turn.turnId}
      data-live-streaming={props.liveStreaming ? 'true' : undefined}
      data-search-highlight={props.searchHighlighted ? 'true' : undefined}
      tabIndex={props.searchHighlighted ? -1 : undefined}
    >
      {forwardBadges.length > 0 && (
        <Marker variant="lineage-row" aria-label={copy.sourceAriaLabel}>
          {forwardBadges.map((badge) => (
            <UiButton
              key={badge.id}
              variant="ghost"
              size="sm"
              className={markerVariants({ variant: 'lineage-badge' })}
              data-direction="forward"
              tooltip={badge.tooltip ?? badge.label}
              onClick={() => props.onLineageBadgeClick?.(badge.targetTurnId)}
              icon={<GitBranch size={11} aria-hidden="true" />}
              label={badge.label}
            />
          ))}
        </Marker>
      )}
      {/* Automation provenance: a turn injected by a scheduled automation is
          NOT something the user typed — say so above the bubble instead of
          impersonating the user. Id stays in the tooltip (no raw ids inline). */}
      {turn.user?.automationOrigin && (
        <Marker
          variant="automation-origin"
          role="note"
          title={copy.automationTitle(turn.user.automationOrigin.automationId)}
        >
          <Timer size={12} aria-hidden="true" />
          <span>{copy.automationTriggered}</span>
        </Marker>
      )}
      {turn.user?.agentGraphOrigin && (
        <Marker
          variant="automation-origin"
          role="note"
          title={copy.agentGraphTitle(turn.user.agentGraphOrigin.graphId)}
        >
          <GitBranch size={12} aria-hidden="true" />
          <span>{copy.agentGraphTriggered}</span>
        </Marker>
      )}
      {turn.user && (
        <LocalizedChatMessage
          accessibleLabel={copy.userAriaLabel}
          sender="user"
          className="maka-chat-message group/usermsg"
        >
          <MessageBody
            role="user"
            text={turn.user.text}
            ts={turn.user.ts}
            attachments={turn.user.attachments}
            quotes={turn.user.quotes}
            onReadAttachmentBytes={props.onReadAttachmentBytes}
            onEditUserMessage={
              props.onEditUserMessage &&
              !turn.user.automationOrigin &&
              !turn.user.agentGraphOrigin
                ? () => props.onEditUserMessage?.(turn.turnId)
                : undefined
            }
            // A revision restages neither attachments nor quotes, so a turn
            // carrying either can't be edited without silently dropping the
            // reference the answer was grounded in.
            editDisabled={
              (turn.user.attachments?.length ?? 0) > 0 ||
              (turn.user.quotes?.length ?? 0) > 0 ||
              props.editUserMessageTransformed === true ||
              props.editUserMessageDisabled === true ||
              turn.status === 'running' ||
              !!props.liveStreaming
            }
            editDisabledReason={
              (turn.user.attachments?.length ?? 0) > 0
                ? copy.editMessageDisabledAttachments
                : (turn.user.quotes?.length ?? 0) > 0
                  ? copy.editMessageDisabledQuotes
                  : props.editUserMessageTransformed
                    ? copy.editMessageDisabledTransformedText
                    : copy.editMessageDisabledRunning
            }
          />

        </LocalizedChatMessage>
      )}
      {turn.notes.map((note) => (
        <ChatSystemMessage
          key={note.id}
          className="maka-chat-system-message"
          aria-label={copy.systemAriaLabel}
        >
          {note.text}
        </ChatSystemMessage>
      ))}
      {showAssistantMessage && (
        <LocalizedChatMessage
          accessibleLabel={copy.assistantAriaLabel}
          sender="assistant"
          data-turn-status={turn.status}
          className="maka-chat-message group/answer"
        >
          <div className="flex min-w-0 w-full flex-col gap-2">
            {turn.status === 'aborted' && (
              <Marker variant="aborted" role="status">
                <Ban size={12} aria-hidden="true" />
                <em>{turnAbortMarkerLabel(turn.abortSource, locale)}</em>
              </Marker>
            )}
            {turn.status === 'failed' && props.failedReasonLabel && (
              <Marker variant="failed-banner" role="alert">
                <Marker as="span" variant="failed-icon" aria-hidden="true">
                  <AlertOctagon size={14} />
                </Marker>
                <span>{props.failedReasonLabel}</span>
                {(props.safeResumeAction?.detail ?? props.failedRecoveryLabel) && (
                  <Marker as="span" variant="failed-recovery">
                    {props.safeResumeAction?.detail ?? props.failedRecoveryLabel}
                  </Marker>
                )}
                {props.safeResumeAction && (
                  <UiButton
                    variant="ghost"
                    size="sm"
                    className="maka-turn-failed-resume"
                    isDisabled={props.safeResumeAction.pending}
                    onClick={props.safeResumeAction.onResume}
                    label={props.safeResumeAction.pending ? copy.safeResumePending : copy.safeResume}
                  />
                )}
              </Marker>
            )}
            {/* The turn timeline is the rendering source of truth
                (materialize.ts): each step's 深度思考 disclosure, answer bubble,
                and Codex-style tool trow in the order the model produced them.
                #1307: runs of reasoning + tools between answer texts render
                through the derived fold as collapsed Processing blocks. */}
            {foldedTimeline.map((item, index) =>
              item.kind === 'processing' ? (
                <ProcessingBlock key={`processing-${item.id}`} entries={item.children} />
              ) : (
                <TurnTimelineEntry
                  key={timelineEntryKey(item, index)}
                  item={item}
                  onStreamingSettled={props.liveStreaming?.onStreamingSettled}
                />
              ),
            )}
            {props.liveStreaming && (
              <>
                {props.liveStreaming.providerRetry ? (
                  <ModelProviderRetryIndicator retry={props.liveStreaming.providerRetry} />
                ) : (
                  <>
                    {props.liveStreaming.processingIndicator && !hasLiveTimelineContent && <ModelProcessingIndicator />}
                    {props.liveStreaming.continuingIndicator && !props.liveStreaming.processingIndicator && !hasLiveTimelineContent && <ModelContinuingIndicator />}
                  </>
                )}
              </>
            )}
          </div>
          {reverseBadges.length > 0 && (
            <Marker variant="lineage-row-reverse" aria-label={copy.derivativesAriaLabel}>
              {reverseBadges.map((badge) => (
                <UiButton
                  key={badge.id}
                  variant="ghost"
                  size="sm"
                  className={markerVariants({ variant: 'lineage-badge' })}
                  data-direction="reverse"
                  tooltip={badge.tooltip ?? badge.label}
                  onClick={() => props.onLineageBadgeClick?.(badge.targetTurnId)}
                  icon={<GitBranch size={11} aria-hidden="true" />}
                  label={badge.label}
                />
              ))}
            </Marker>
          )}
          {props.liveStreaming ? (
            /* #642: reserved-height footer placeholder while streaming — same
               `mt-0.5 h-8` box the real footer occupies, so the live→settled
               swap is height-neutral (the footer slot never grows/shrinks). No
               actionable footer here: the live tail's derived status is
               `completed`, so a real `TurnFooterActions` would render a
               clickable regenerate/branch on a still-streaming answer. */
            <div aria-hidden="true" className="mt-0.5 h-8" />
          ) : (
            props.footerActions && props.footerActions.length > 0 && (
              <TurnFooterActions
                actions={props.footerActions}
                onAction={props.onFooterAction ? (actionId) => props.onFooterAction?.(turn.turnId, actionId) : undefined}
                assistantText={turn.assistant?.text ?? ''}
              />
            )
          )}
        </LocalizedChatMessage>
      )}
    </section>
  );
});

export interface TurnFooterActionMeta {
  id: 'regenerate' | 'branch' | 'copy' | 'info';
  label: string;
  enabled: boolean;
  tooltip?: string;
}
/**
 * Lineage badge rendered on a turn, either pointing to its origin
 * ("重新生成自 turn ${id}") or to a descendant ("已重新生成 → turn ${id}").
 * Renderer (main.tsx) computes the labels and targets from the lineage
 * map; @maka/ui renders the badge UI. PR109e-e.
 */
export interface TurnLineageBadge {
  /** Stable key for React. */
  id: string;
  /** Chinese label. UI surfaces it verbatim — caller is responsible for
   *  generalized phrasing (never expose enum identifiers). */
  label: string;
  /** Optional tooltip / aria-label override. Falls back to `label`. */
  tooltip?: string;
  /** Click target turn id. Renderer scrolls + highlights that turn. */
  targetTurnId: string;
  /**
   * Forward = "this turn was retried/regenerated from another";
   * reverse = "another turn descends from this one". UI shows them
   * in different positions (forward at top, reverse at bottom).
   */
  direction: 'forward' | 'reverse';
}

function TurnFooterActions(props: {
  actions: ReadonlyArray<TurnFooterActionMeta>;
  onAction?: (actionId: TurnFooterActionMeta['id']) => void;
  /** Assistant text used by the inline copy action. */
  assistantText?: string;
}) {
  const copy = getConversationCopy(useUiLocale()).messages;
  const [copyPhase, setCopyPhase] = useState<ClipboardCopyPhase | null>(null);
  const copyPendingRef = useRef(false);
  const copyResetTimerRef = useRef<number | null>(null);
  const copyMountedRef = useMountedRef();

  function clearCopyResetTimer() {
    if (copyResetTimerRef.current === null) return;
    window.clearTimeout(copyResetTimerRef.current);
    copyResetTimerRef.current = null;
  }

  useEffect(() => {
    return () => {
      clearCopyResetTimer();
    };
  }, []);

  function settleCopy(phase: Exclude<ClipboardCopyPhase, 'pending'>) {
    if (!copyMountedRef.current) return;
    setCopyPhase(phase);
    copyResetTimerRef.current = window.setTimeout(() => {
      if (!copyMountedRef.current) return;
      setCopyPhase(null);
      copyResetTimerRef.current = null;
    }, 1400);
  }

  async function copyAssistantText() {
    if (!props.assistantText || copyPendingRef.current) return;
    copyPendingRef.current = true;
    clearCopyResetTimer();
    setCopyPhase('pending');
    try {
      await navigator.clipboard.writeText(props.assistantText);
      settleCopy('copied');
    } catch {
      settleCopy('failed');
    } finally {
      copyPendingRef.current = false;
    }
  }

  async function handleClick(action: TurnFooterActionMeta) {
    if (!action.enabled) return;
    if (action.id === 'copy') {
      await copyAssistantText();
      return;
    }
    if (action.id === 'info') return; // tooltip-only meta display, no action
    props.onAction?.(action.id);
  }
  return (
    <ChatMessageMetadata
      className={markerVariants({ variant: 'footer' })}
      role="toolbar"
      aria-label={copy.answerActionsAriaLabel}
      footer={
        <>
          {props.actions.map((action) => {
            // Keep the action label under pending (a11y); do not swap to spinner-only.
            const isPending = action.tooltip === copy.processing;
            const isCopyAction = action.id === 'copy';
            const copyIsPending = isCopyAction && copyPhase === 'pending';
            const copyFeedbackLabel = copyPhase === 'pending'
              ? `${copy.copying}…`
              : copyPhase === 'copied'
                ? copy.copied
                : copyPhase === 'failed'
                  ? copy.copyFailed
                  : action.label;
            const isActionPending = isPending || copyIsPending;
            const tooltipText = isCopyAction
              ? (copyPhase ? copyFeedbackLabel : (action.tooltip ?? action.label))
              : (action.tooltip ?? action.label);
            const icon = isCopyAction && copyPhase === 'copied'
              ? <Check size={12} aria-hidden="true" />
              : STATUS_FOOTER_ICON[action.id];
            return (
              <Tooltip key={action.id} content={tooltipText}>
                <UiIconButton
                  label={action.label}
                  icon={icon}
                  variant="ghost"
                  size="sm"
                  className={markerVariants({ variant: 'footer-action' })}
                  data-action={action.id}
                  data-pending={isActionPending || undefined}
                  data-copy-feedback={isCopyAction && copyPhase ? copyPhase : undefined}
                  aria-disabled={!action.enabled || copyIsPending}
                  aria-busy={isActionPending || undefined}
                  onClick={() => void handleClick(action)}
                />
              </Tooltip>
            );
          })}
        </>
      }
    />
  );
}

const STATUS_FOOTER_ICON: Record<TurnFooterActionMeta['id'], ReactNode> = {
  regenerate: <RefreshCcw size={12} aria-hidden="true" />,
  branch: <GitBranch size={12} aria-hidden="true" />,
  copy: <Copy size={12} aria-hidden="true" />,
  info: <Info size={12} aria-hidden="true" />,
};

export function ModelProcessingIndicator() {
  const copy = getConversationCopy(useUiLocale()).messages;
  return (
    <div className="flex items-center gap-2 py-0.5" role="status" aria-live="polite">
      <Loader2
        size={16}
        aria-hidden="true"
        className="shrink-0 animate-spin text-[color:var(--muted-foreground)]"
      />
      <TextShimmer active className="min-w-0 truncate text-[length:var(--font-size-base)]">{copy.processing}</TextShimmer>
    </div>
  );
}

export function ModelContinuingIndicator() {
  const copy = getConversationCopy(useUiLocale()).messages;
  return (
    <div
      className="flex items-center py-0.5 text-[length:var(--font-size-base)] text-[color:var(--muted-foreground)] opacity-70 [animation:maka-stream-fade-in_var(--duration-emphasized)_var(--ease-out-strong)_both]"
      role="status"
      aria-live="polite"
    >
      <span className="min-w-0 truncate">{copy.continuing}</span>
    </div>
  );
}

export function ModelProviderRetryIndicator(props: { retry: ProviderRetryEvent }) {
  const copy = getConversationCopy(useUiLocale()).messages;
  const text =
    props.retry.phase === 'scheduled'
      ? copy.providerRetryScheduled(
          Math.max(1, Math.ceil(props.retry.delayMs / 1_000)),
          props.retry.attempt,
          props.retry.maxAttempts,
        )
      : copy.providerRetryStarted(props.retry.attempt, props.retry.maxAttempts);
  return (
    <div
      className="flex items-center gap-2 py-0.5 text-[length:var(--font-size-base)] text-[color:var(--muted-foreground)]"
      role="status"
      aria-live="polite"
    >
      <RefreshCcw size={16} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 truncate">{text}</span>
    </div>
  );
}

function StreamingAssistantBubble(props: { text: string; live: boolean; truncated?: boolean; onSettled?: () => void }) {
  const copy = getConversationCopy(useUiLocale()).messages;
  // Redact before smoother so typewriter prefixes never leak mid-token.
  const snap = useStreamSnap();
  const safeText = prepareSmoothStreamText(props.text);
  const { displayed, catchingUp } = useSmoothStreamContent(safeText, {
    streaming: props.live,
    snap,
  });
  const settledRef = useRef(false);

  useEffect(() => {
    settledRef.current = false;
  }, [safeText, props.live]);

  useEffect(() => {
    if (props.live || catchingUp || settledRef.current) return;
    settledRef.current = true;
    props.onSettled?.();
  }, [props.live, catchingUp, props.onSettled]);

  return (
    <ChatMessageBubble variant="ghost" className="maka-chat-message-bubble maka-chat-message-bubble-assistant maka-bubble-streaming">
      <Markdown text={displayed} streaming />
      {props.truncated && (
        <div
          className="mt-1.5 inline-block cursor-help rounded-[var(--radius-control)] border border-[oklch(from_var(--warning)_l_c_h_/_0.24)] bg-[oklch(from_var(--warning)_l_c_h_/_0.05)] px-1 text-xs text-[color:var(--warning-text,var(--info-text))]"
          role="status"
          aria-live="polite"
          title={copy.outputTruncatedTitle}
        >
          {copy.truncated}
        </div>
      )}
    </ChatMessageBubble>
  );
}

// Semantic keys (no index) so mid-timeline inserts do not remount/collapse disclosures.
function timelineEntryKey(item: TurnTimelineItem, index: number): string {
  if (item.kind === 'tools') return `tools-${item.items[0]?.toolUseId ?? index}`;
  return `${item.kind}-${item.messageId}`;
}

/** Render one timeline entry: reasoning disclosure / answer bubble / tool trow. */
function TurnTimelineEntry(props: {
  item: TurnTimelineItem;
  onStreamingSettled?: (messageId?: string) => void;
}) {
  const { item } = props;
  if (item.kind === 'thinking') {
    return <DeepThinking text={item.text} live={item.live === true} truncated={item.truncated === true} />;
  }
  if (item.kind === 'tools') return <ToolTrow items={item.items} />;
  if (item.kind === 'text' && item.live) {
    return (
      <StreamingAssistantBubble
        text={item.text}
        live={item.complete !== true}
        truncated={item.truncated === true}
        onSettled={() => props.onStreamingSettled?.(item.messageId)}
      />
    );
  }
  return <MessageBody role="assistant" text={item.text} ts={item.ts} />;
}

function ProcessingBlock(props: { entries: FoldedTimelineChild[] }) {
  const { entries } = props;
  return (
    <div className="maka-processing-sequence">
      {entries.map((entry, index) => (
        <TurnTimelineEntry key={timelineEntryKey(entry, index)} item={entry} />
      ))}
    </div>
  );
}

function DeepThinking(props: { text: string; live: boolean; truncated?: boolean }) {
  const copy = getConversationCopy(useUiLocale()).messages;
  const snap = useStreamSnap();
  // Defense-in-depth: redact before smoother so prefixes never leak mid-token.
  const safeText = prepareSmoothStreamText(props.text);
  const { displayed } = useSmoothStreamContent(safeText, { streaming: props.live, snap });
  const visibleText = props.live ? displayed : safeText;
  const label = props.truncated ? `${copy.thinking} · ${copy.truncated}` : copy.thinking;
  return (
    <ChatReasoning
      className="min-w-0"
      label={label}
      isStreaming={props.live}
      title={props.truncated ? copy.thinkingTruncatedTitle : undefined}
      data-deep-thinking={props.live ? 'live' : undefined}
    >
      {visibleText}
    </ChatReasoning>
  );
}

/** Snap streaming smoother under reduced-motion / e2e-fixture / OS preference. */
function useStreamSnap(): boolean {
  const [snap, setSnap] = useState(() => readStreamSnap());
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setSnap(readStreamSnap());
    setSnap(readStreamSnap());
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    return undefined;
  }, []);
  return snap;
}

function readStreamSnap(): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return true;
  const root = document.documentElement;
  if (root.dataset.makaReducedMotion === 'true') return true;
  if (root.dataset.makaE2eFixture === 'true') return true;
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  return false;
}
