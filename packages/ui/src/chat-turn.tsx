import { memo, useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import { AlertOctagon, Ban, Check, Copy, GitBranch, Info, Loader2, Pencil, RefreshCcw, Timer } from './icons.js';
import { type ClipboardCopyPhase, useClipboardCopyFeedback } from './clipboard-feedback.js';
import { Markdown } from './markdown.js';
import { formatAbsoluteTimestamp, formatClockTime, turnAbortMarkerLabel } from './chat-display-helpers.js';
import { redactSecrets } from './redact.js';
import { isProgressiveStreamingEnabled } from './streaming-presentation.js';
import {
  Badge,
  Button as UiButton,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageMetadata,
  ChatSystemMessage,
  ChatTokenizedText,
  HStack,
  IconButton as UiIconButton,
  Thumbnail,
  Token,
  useLightbox,
} from '@astryxdesign/core';
import { useStreamingText } from '@astryxdesign/core/hooks';
import { ChatReasoning } from './astryx-chat-reasoning.js';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import {
  isInFlightToolStatus,
  SKILL_INVOCATION_TOKEN_SOURCE,
  type AttachmentRef,
  type InlineReference,
  type ProviderRetryEvent,
  type QuoteRef,
} from '@maka/core';
import type { TurnTimelineItem, TurnViewModel } from './materialize.js';
import { foldTimeline, type FoldedTimelineChild } from './timeline-fold.js';
import { AttachmentKindIcon } from './attachment-kinds.js';
import { QuoteRefChip } from './quote-ref-chip.js';
import { Marker, markerVariants, TextShimmer } from './primitives/chat.js';
import { ToolTrow } from './tool-activity.js';
import { formatBytes } from './tool-activity/preview-utils.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';
import { AstryxLocaleProvider } from './astryx-i18n.js';
import { InlineReferenceText } from './inline-reference.js';

export function LocalizedChatMessage({
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

function legacySentSkillTokens(text: string) {
  const values = new Set(
    [...text.matchAll(new RegExp(SKILL_INVOCATION_TOKEN_SOURCE, 'g'))].map((match) => match[0]),
  );
  return [...values].map((value) => ({ value, label: value, variant: 'neutral' as const }));
}

/**
 * One chat message body: user verbatim; assistant/system via Markdown.
 * Memoized so streaming list re-renders do not re-parse settled bubbles.
 */
function AttachmentImage(props: { attachment: AttachmentRef; onReadAttachmentBytes?: ReadAttachmentBytes }) {
  const [src, setSrc] = useState<string | undefined>(undefined);
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
      <Thumbnail
        className="maka-user-attachment-thumbnail"
        alt={props.attachment.name}
        label={props.attachment.name}
        isLoading
      />
    );
  }
  return <LoadedAttachmentImage src={src} name={props.attachment.name} />;
}

function LoadedAttachmentImage(props: { src: string; name: string }) {
  const lightbox = useLightbox({
    media: { src: props.src, alt: props.name },
    hasZoom: true,
  });
  return (
    <>
      <Thumbnail
        className="maka-user-attachment-thumbnail"
        src={props.src}
        alt={props.name}
        label={props.name}
        onClick={() => lightbox.open()}
      />
      {lightbox.element}
    </>
  );
}

const MessageBody = memo(function MessageBody(props: {
  role: string;
  text: string;
  ts?: number;
  attachments?: readonly AttachmentRef[];
  quotes?: readonly QuoteRef[];
  inlineReferences?: readonly InlineReference[];
  onReadAttachmentBytes?: ReadAttachmentBytes;
  /** When set on a user message, show an edit affordance that starts a revision draft. */
  onEditUserMessage?: () => void;
  editDisabled?: boolean;
  editDisabledReason?: string;
}) {
  const locale = useUiLocale();
  const copyText = getConversationCopy(locale).messages;
  if (props.role === 'user') {
    const nonImageAttachments = props.attachments?.filter((attachment) => attachment.kind !== 'image') ?? [];
    const imageAttachments = props.attachments?.filter((attachment) => attachment.kind === 'image') ?? [];
    const editActionLabel = props.editDisabled
      ? (props.editDisabledReason ?? copyText.editMessageDisabledRunning)
      : copyText.editMessage;
    const userMetadata = (
      <ChatMessageMetadata
        className="maka-message-meta"
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
      <>
        {nonImageAttachments.length > 0 ? (
          <HStack gap={1} wrap="wrap" maxWidth="100%" className="maka-user-attachment-tokens">
            {nonImageAttachments.map((attachment, index) => (
              <Token
                key={`${attachment.name}-${index}`}
                size="sm"
                label={attachment.name}
                icon={<AttachmentKindIcon kind={attachment.kind} />}
                description={attachment.bytes !== undefined ? formatBytes(attachment.bytes) : undefined}
              />
            ))}
          </HStack>
        ) : null}
        {props.quotes && props.quotes.length > 0 ? (
          <div className="maka-user-quotes">
            {props.quotes.map((quote, index) => (
              <QuoteRefChip key={`${quote.sourceTurnId ?? 'quote'}-${index}`} quote={quote} />
            ))}
          </div>
        ) : null}
        {imageAttachments.length > 0 ? (
          <HStack gap={1} wrap="wrap" maxWidth="100%" className="maka-user-attachments">
            {imageAttachments.map((attachment, index) => (
              <AttachmentImage
                key={`${attachment.name}-${index}`}
                attachment={attachment}
                onReadAttachmentBytes={props.onReadAttachmentBytes}
              />
            ))}
          </HStack>
        ) : null}
        <ChatMessageBubble
          className="maka-chat-message-bubble maka-chat-message-bubble-user"
          metadata={userMetadata}
        >
          {props.inlineReferences ? (
            <InlineReferenceText text={props.text} references={props.inlineReferences} />
          ) : (
            <ChatTokenizedText tokens={legacySentSkillTokens(props.text)}>
              {props.text}
            </ChatTokenizedText>
          )}
        </ChatMessageBubble>
      </>
    );
  }
  return (
    <ChatMessageBubble variant="ghost" className="maka-chat-message-bubble maka-chat-message-bubble-assistant">
      <Markdown text={props.text} density="compact" />
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
  /**
   * #2224: this turn's height as measured on a previous visit under the
   * current layout. Seeds contain-intrinsic-size so the placeholder equals
   * the real size, and marks the turn for the warm-up to skip.
   */
  seededHeight?: number;
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
        : item.items.some((tool) => isInFlightToolStatus(tool.status)),
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
      data-size-seeded={props.seededHeight !== undefined ? 'true' : undefined}
      style={
        props.seededHeight !== undefined
          ? { containIntrinsicSize: `auto ${props.seededHeight}px` }
          : undefined
      }
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
      {/* Host provenance keeps non-user prompts from impersonating the user.
          Durable ids stay in tooltips instead of the transcript body. */}
      {turn.user?.hostOrigin?.kind === 'automation' && (
        <Marker
          variant="automation-origin"
          role="note"
          title={copy.automationTitle(turn.user.hostOrigin.automationId)}
        >
          <Timer size={12} aria-hidden="true" />
          <span>{copy.automationTriggered}</span>
        </Marker>
      )}
      {turn.user?.hostOrigin?.kind === 'goal' && (
        <Marker
          variant="automation-origin"
          role="note"
          title={copy.goalTitle(turn.user.hostOrigin.goalId)}
        >
          <RefreshCcw size={12} aria-hidden="true" />
          <span>{copy.goalContinued}</span>
        </Marker>
      )}
      {turn.user?.hostOrigin?.kind === 'agent_graph' && (
        <Marker
          variant="automation-origin"
          role="note"
          title={copy.agentGraphTitle(turn.user.hostOrigin.graphId)}
        >
          <GitBranch size={12} aria-hidden="true" />
          <span>{copy.agentGraphTriggered}</span>
        </Marker>
      )}
      {turn.user && (
        <LocalizedChatMessage
          accessibleLabel={copy.userAriaLabel}
          sender="user"
          className="maka-chat-message maka-user-message"
        >
          <MessageBody
            role="user"
            text={turn.user.text}
            ts={turn.user.ts}
            attachments={turn.user.attachments}
            quotes={turn.user.quotes}
            inlineReferences={turn.user.inlineReferences}
            onReadAttachmentBytes={props.onReadAttachmentBytes}
            onEditUserMessage={
              props.onEditUserMessage && !turn.user.hostOrigin
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
          className="maka-chat-message maka-assistant-answer"
        >
          <div className="maka-assistant-answer-content">
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
                and Astryx tool group in the order the model produced them.
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
            <div aria-hidden="true" className="maka-live-turn-footer-placeholder" />
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

/**
 * Everything a consumer derives per turn and hands back for rendering. Each
 * map is keyed by `turnId`; a turn absent from a map simply has nothing there.
 */
export interface TurnPresentation {
  footerActionsByTurn: Record<string, ReadonlyArray<TurnFooterActionMeta>>;
  failedReasonLabels: Record<string, string>;
  failedRecoveryLabels: Record<string, string>;
  lineageBadgesByTurn: Record<string, TurnLineageBadge[]>;
  /** The turn a safe resume would restart, when the shell offers one. */
  resumeCandidateTurnId?: string;
}

export type TurnPresentationDeriver = (turns: readonly TurnViewModel[]) => TurnPresentation;

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
    <div className="maka-turn-processing" role="status" aria-live="polite">
      <Loader2
        size={16}
        aria-hidden="true"
        className="maka-turn-processing-spinner"
      />
      <TextShimmer active className="maka-turn-indicator-text">{copy.processing}</TextShimmer>
    </div>
  );
}

export function ModelContinuingIndicator() {
  const copy = getConversationCopy(useUiLocale()).messages;
  return (
    <div
      className="maka-turn-continuing"
      role="status"
      aria-live="polite"
    >
      <span className="maka-turn-indicator-text">{copy.continuing}</span>
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
      className="maka-turn-status"
      role="status"
      aria-live="polite"
    >
      <RefreshCcw size={16} aria-hidden="true" className="maka-turn-status-icon" />
      <span className="maka-turn-indicator-text">{text}</span>
    </div>
  );
}

function StreamingAssistantBubble(props: { text: string; live: boolean; truncated?: boolean; onSettled?: () => void }) {
  const copy = getConversationCopy(useUiLocale()).messages;
  const settledRef = useRef(false);

  useEffect(() => {
    settledRef.current = false;
  }, [props.text, props.live]);

  useEffect(() => {
    if (props.live || settledRef.current) return;
    settledRef.current = true;
    props.onSettled?.();
  }, [props.live, props.onSettled]);

  return (
    <ChatMessageBubble variant="ghost" className="maka-chat-message-bubble maka-chat-message-bubble-assistant maka-bubble-streaming">
      <Markdown text={props.text} streaming={props.live} density="compact" />
      {props.truncated && (
        <Tooltip content={copy.outputTruncatedTitle}>
          {/* Colour-name archive, not the semantic one: Astryx paints
              `warning` as a solid dark-mode-invariant fill and `yellow` as a
              tint. This note replaced a 5% wash with a hairline; a solid block
              inside the message body would outweigh the message. */}
          <Badge
            variant="yellow"
            label={copy.truncated}
            className="maka-turn-truncation-badge"
            role="status"
            aria-live="polite"
            /* Same reason as the stale pill: the Tooltip's popover is
               `display: none` until hovered, so `aria-describedby` computes to
               nothing and the `title` this replaced was the only description
               this badge ever had. Announced with the reason attached. */
            aria-label={`${copy.truncated}. ${copy.outputTruncatedTitle}`}
          />
        </Tooltip>
      )}
    </ChatMessageBubble>
  );
}

// Semantic keys (no index) so mid-timeline inserts do not remount/collapse disclosures.
function timelineEntryKey(item: TurnTimelineItem, index: number): string {
  if (item.kind === 'tools') return `tools-${item.items[0]?.toolUseId ?? index}`;
  return `${item.kind}-${item.messageId}`;
}

/** Render one timeline entry: reasoning disclosure / answer bubble / tool group. */
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
  const safeText = redactSecrets(props.text);
  const displayed = useStreamingText(safeText, isProgressiveStreamingEnabled(props.live));
  const label = props.truncated ? `${copy.thinking} · ${copy.truncated}` : copy.thinking;
  return (
    <ChatReasoning
      className="maka-deep-thinking"
      label={label}
      isStreaming={props.live}
      title={props.truncated ? copy.thinkingTruncatedTitle : undefined}
      data-deep-thinking={props.live ? 'live' : undefined}
    >
      {displayed}
    </ChatReasoning>
  );
}
