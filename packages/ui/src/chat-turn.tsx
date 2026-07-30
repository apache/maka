import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
import { useMountedRef } from './use-mounted-ref.js';
import { AlertOctagon, Ban, Brain, Check, ChevronRight, Copy, GitBranch, Info, Loader2, Pencil, RefreshCcw, Timer } from './icons.js';
import { type ClipboardCopyPhase, useClipboardCopyFeedback } from './clipboard-feedback.js';
import { Markdown } from './markdown.js';
import { formatAbsoluteTimestamp, formatClockTime, turnAbortMarkerLabel } from './chat-display-helpers.js';
import { prepareSmoothStreamText, useSmoothStreamContent } from './smooth-stream.js';
import { tokenizeFade, useStreamFade, type StreamFade } from './stream-fade.js';
import { Button as UiButton, cn, DialogContent, DialogRoot } from './ui.js';
import type { AttachmentRef, ProviderRetryEvent, QuoteRef } from '@maka/core';
import type { TurnTimelineItem, TurnViewModel } from './materialize.js';
import { foldTimeline, type FoldedTimelineChild } from './timeline-fold.js';
import { AttachmentFileCard } from './attachment-file-card.js';
import { QuoteRefChip } from './quote-ref-chip.js';
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from './primitives/collapsible.js';
import { Bubble, Marker, markerVariants, Message, TextShimmer } from './primitives/chat.js';
import { Tooltip, TooltipTrigger, TooltipContent } from './primitives/tooltip.js';
import { SETTLE_FADE, ToolKindIcon, ToolTrow, useToolDisclosure } from './tool-activity.js';
import {
  isProcessingRunning,
  processingActivityKind,
  processingNeedsAttention,
  summarizeProcessing,
} from './tool-activity/trow-summary.js';
import { isSandboxDeniedTool } from './tool-activity/sandbox-denial.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

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
 * Renders an individual chat message body.
 *
 * - `user` messages stay verbatim (whitespace + line breaks preserved); the
 *   user's literal input shouldn't be reinterpreted as markdown.
 * - `assistant` / `system` (and anything else) flow through the markdown
 *   renderer so code fences, lists, tables, and links display natively.
 *
 * Assistant messages get a hover Copy button that yanks the raw markdown
 * source to the clipboard.
 *
 * Memoized because chat scroll re-renders the whole list on every streaming
 * delta; this keeps already-final bubbles from re-parsing markdown.
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
      <DialogRoot open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <DialogContent className="!w-auto !max-w-[90vw] !max-h-[90vh] !bg-transparent !p-0 !shadow-none !rounded-md overflow-visible">
          <img className="max-h-[90vh] max-w-[90vw] object-contain rounded-md shadow-2xl" src={src} alt={props.attachment.name} />
        </DialogContent>
      </DialogRoot>
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
    // User turn: the message sits in a tinted, width-capped block aligned to
    // the right (so the right-anchor reads even for long messages), with an
    // absolute HH:mm time + a copy affordance in a meta row beneath it. #642:
    // the whole meta row is hover-gated on the user bubble (`group/usermsg`) —
    // hidden at rest, revealed on hover / focus-within, matching the assistant
    // footer's hover reveal. Copy reuses MessageCopyButton in `footerStyle`, so
    // it's the same quiet ghost action as the assistant turn footer's copy
    // (same primitive + `markerVariants('footer-action')`).
    return (
      <>
        <Bubble variant="user">
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
        </Bubble>
        {/* #642: the whole meta row — absolute HH:mm time + copy — hides by
            default and appears when the user bubble is hovered or keyboard
            focus lands inside (keys off `group/usermsg` on the user Message).
            Absolute wall-clock time (not relative "N 小时前"); the full date
            stays on the time's `title` and the bubble's own `title`. */}
        <div className="maka-message-meta opacity-0 [transition:opacity_var(--duration-quick)_var(--ease-out-strong)] group-hover/usermsg:opacity-100 focus-within:opacity-100">
          {props.ts !== undefined && (
            <small
              className="maka-message-time-inline tabular-nums"
              aria-hidden="true"
              title={formatAbsoluteTimestamp(props.ts, locale)}
            >
              {formatClockTime(props.ts, locale)}
            </small>
          )}
          <MessageCopyButton text={props.text} footerStyle />
          {props.onEditUserMessage && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <UiButton
                    type="button"
                    variant="quiet"
                    size="icon-sm"
                    className={markerVariants({ variant: 'footer-action' })}
                    aria-label={editActionLabel}
                    aria-disabled={props.editDisabled === true ? 'true' : undefined}
                    data-action="edit"
                    onClick={() => {
                      if (props.editDisabled) return;
                      props.onEditUserMessage?.();
                    }}
                  />
                }
              >
                <Pencil size={12} aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>{editActionLabel}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </>
    );
  }
  // Assistant / system body: open prose, no bubble. Per-turn meta (model ·
  // duration · cost) lives in the footer's info tooltip; copy + the other
  // actions live in the turn footer.
  return (
    <Bubble variant="assistant" className="maka-bubble-with-actions">
      <Markdown text={props.text} />
    </Bubble>
  );
});

function MessageCopyButton(props: { text: string; label?: string; footerStyle?: boolean }) {
  const copyText = getConversationCopy(useUiLocale()).messages;
  const copyFeedback = useClipboardCopyFeedback(1400, { redact: false });
  const copyPhase = copyFeedback.phaseFor('message');
  const copyPending = copyPhase === 'pending';
  const copied = copyPhase === 'copied';

  async function copy() {
    await copyFeedback.copy('message', props.text);
  }

  // `footerStyle` renders this copy through the same semantic footer-action
  // seam as the assistant turn footer.
  // The user-message copy and the assistant copy then read as one button by
  // construction — same seam, same class, same icon metrics — instead
  // of a look-alike bespoke treatment.
  const footer = props.footerStyle === true;
  const iconSize = footer ? 12 : 14;

  const baseLabel = props.label ?? (footer ? copyText.copy : copyText.copyMessage);
  const actionLabel = copyPhase === 'pending'
    ? copyText.copying
    : copyPhase === 'copied'
      ? copyText.copied
      : copyPhase === 'failed'
        ? copyText.copyFailed
        : baseLabel;
  const icon = copied
    ? <Check size={iconSize} aria-hidden="true" />
    : <Copy size={iconSize} aria-hidden="true" />;

  if (footer) {
    // icon-only + tooltip, matching the assistant footer copy action (#546)
    // so the user-message copy and the assistant copy read as one button.
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <UiButton
              type="button"
              variant="quiet"
              size="icon-sm"
              className={markerVariants({ variant: 'footer-action' })}
              aria-label={baseLabel}
              aria-busy={copyPending ? 'true' : undefined}
              disabled={copyPending}
              data-copied={copied}
              data-copy-feedback={copyPhase ?? undefined}
              data-pending={copyPending ? 'true' : undefined}
              onClick={() => void copy()}
            />
          }
        >
          {icon}
        </TooltipTrigger>
        <TooltipContent>{actionLabel}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <BaseButton
      type="button"
      className="maka-message-copy"
      onClick={() => void copy()}
      aria-label={copyPhase ? `${actionLabel} · ${baseLabel}` : baseLabel}
      aria-busy={copyPending ? 'true' : undefined}
      disabled={copyPending}
      data-copied={copied}
      data-copy-feedback={copyPhase ?? undefined}
      data-pending={copyPending ? 'true' : undefined}
      data-labelled={props.label ? 'true' : undefined}
    >
      {icon}
      {props.label && <span>{copyPhase === 'pending' ? `${copyText.copying}…` : copyPhase === 'failed' ? copyText.copyFailed : copied ? copyText.copied : props.label}</span>}
    </BaseButton>
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
   * present, the assistant `Message` renders the live 深度思考 + answer bubble as
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
  // The assistant `Message` mounts once the turn has any timeline content OR
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
              type="button"
              variant="quiet"
              size="sm"
              className={markerVariants({ variant: 'lineage-badge' })}
              data-direction="forward"
              title={badge.tooltip ?? badge.label}
              onClick={() => props.onLineageBadgeClick?.(badge.targetTurnId)}
            >
              <GitBranch size={11} aria-hidden="true" />
              <span>{badge.label}</span>
            </UiButton>
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
        <Message
          variant="user"
          aria-label={copy.userAriaLabel}
          title={turn.user.ts ? formatAbsoluteTimestamp(turn.user.ts, locale) : undefined}
          className="group/usermsg"
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

        </Message>
      )}
      {turn.notes.map((note) => (
        <Message
          key={note.id}
          variant="system"
          title={note.ts ? formatAbsoluteTimestamp(note.ts, locale) : undefined}
        >
          <MessageBody role="system" text={note.text} ts={note.ts} />
        </Message>
      ))}
      {showAssistantMessage && (
        <Message
          variant="assistant"
          data-turn-status={turn.status}
          aria-label={copy.assistantAriaLabel}
          className="group/answer"
        >
          <div className="flex flex-col gap-2">
            {/* PR109d-c: aborted turn gets a muted "(已中断)" marker + Ban icon
                so the user sees this turn was cancelled without it looking like
                a fault state (reserved for `failed`). Rendered as its own row so
                per-segment Copy buttons still yank clean answer text. */}
            {turn.status === 'aborted' && (
              <Marker variant="aborted" role="status">
                <Ban size={12} aria-hidden="true" />
                <em>{turnAbortMarkerLabel(turn.abortSource, locale)}</em>
              </Marker>
            )}
            {/* PR109e-d: failed turn AlertOctagon banner with generalized
                Chinese copy (no raw `errorClass` leak per @kenji gate #3).
                Caller passes the pre-translated `failedReasonLabel` —
                @maka/ui doesn't know how to translate the runtime enum;
                that mapping lives in `session-status-presentation.ts`
                via `describeTurnErrorClass()`. */}
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
                    type="button"
                    variant="quiet"
                    size="sm"
                    className="maka-turn-failed-resume"
                    disabled={props.safeResumeAction.pending}
                    onClick={props.safeResumeAction.onResume}
                  >
                    {props.safeResumeAction.pending ? copy.safeResumePending : copy.safeResume}
                  </UiButton>
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
                  type="button"
                  variant="quiet"
                  size="sm"
                  className={markerVariants({ variant: 'lineage-badge' })}
                  data-direction="reverse"
                  title={badge.tooltip ?? badge.label}
                  onClick={() => props.onLineageBadgeClick?.(badge.targetTurnId)}
                >
                  <GitBranch size={11} aria-hidden="true" />
                  <span>{badge.label}</span>
                </UiButton>
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
        </Message>
      )}
    </section>
  );
});

/**
 * Turn footer actions row. Renders icon-only buttons (regenerate /
 * branch / copy, plus an optional info action whose tooltip carries
 * the turn meta) driven by the pure helper's enabled matrix. Disabled
 * buttons stay rendered so the user can see what actions exist on the
 * turn; click handlers no-op when disabled (#546: retry merged into
 * regenerate).
 *
 * Copy action is handled locally (write to clipboard) so the
 * consumer doesn't need a clipboard IPC for it. Other actions
 * (regenerate / branch) bubble up via `onAction`.
 */
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
    <Marker
      variant="footer"
      role="toolbar"
      aria-label={copy.answerActionsAriaLabel}
    >
      {props.actions.map((action) => {
        // Per @kenji review: pending state must keep the original button
        // label visible (not a spinner-only) so screen readers can hear
        // which action is processing. `data-pending` + `aria-busy="true"`
        // are the signals — the `footer-action` marker shell renders as a
        // bare `quiet` button in every state, so pending never keys off the
        // Button `variant`, and no presentation-priority hook is emitted.
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
        // Copy's tooltip comes from the helper (enabled affordance vs disabled
        // reason). Only while clipboard feedback is active do we surface that
        // transient state; otherwise the helper's tooltip wins.
        const tooltipText = isCopyAction
          ? (copyPhase ? copyFeedbackLabel : (action.tooltip ?? action.label))
          : (action.tooltip ?? action.label);
        const icon = isCopyAction && copyPhase === 'copied'
          ? <Check size={12} aria-hidden="true" />
          : STATUS_FOOTER_ICON[action.id];
        return (
          <Tooltip key={action.id}>
            <TooltipTrigger
              render={
                <UiButton
                  type="button"
                  variant="quiet"
                  size="icon-sm"
                  className={markerVariants({ variant: 'footer-action' })}
                  aria-label={action.label}
                  data-action={action.id}
                  data-pending={isActionPending || undefined}
                  data-copy-feedback={isCopyAction && copyPhase ? copyPhase : undefined}
                  aria-disabled={!action.enabled || copyIsPending}
                  aria-busy={isActionPending || undefined}
                  onClick={() => void handleClick(action)}
                />
              }
            >
              {icon}
            </TooltipTrigger>
            <TooltipContent>{tooltipText}</TooltipContent>
          </Tooltip>
        );
      })}
    </Marker>
  );
}

const STATUS_FOOTER_ICON: Record<TurnFooterActionMeta['id'], ReactNode> = {
  regenerate: <RefreshCcw size={12} aria-hidden="true" />,
  branch: <GitBranch size={12} aria-hidden="true" />,
  copy: <Copy size={12} aria-hidden="true" />,
  info: <Info size={12} aria-hidden="true" />,
};

/**
 * PR-UI-RENDER-1 — streaming assistant bubble.
 *
 * Wraps the live `streamingText` in `useSmoothStreamContent` so the
 * visible text grows at the EMA-tracked arrival CPS instead of
 * lurching with each network chunk. On `text_complete`, the parent keeps
 * the bubble mounted with `live=false` so the smoother can drain the final
 * tail before settled history takes over. Abort / error still unmount
 * immediately.
 *
 * `live=false` after `text_complete`: keep the bubble mounted until
 * the smoother catches up, then notify the parent to hand off to history.
 */
/**
 * #642 single render path: the live 深度思考 + streaming answer, rendered as the
 * trailing entries of the active tail turn. Shared by `TurnView` (the normal
 * path — injected into the committed tail turn's timeline) and the ChatView
 * fallback (rare: streaming began before the optimistic user turn materialized).
 * Thinking renders above the answer (it always precedes it) and is `live` only
 * until the answer text starts; the answer bubble fires `onStreamingSettled`
 * once it finishes catching up.
 */
/**
 * #646: the "正在处理…" row — the model is being awaited with nothing streaming
 * yet. Same row language as a tool trow / 深度思考 (16px icon + `TextShimmer`
 * label, muted, base tier); a neutral spinner (not Brain — this isn't reasoning)
 * carries the "working" affordance. The 200ms appearance delay lives upstream in
 * `useDelayedFlag`, so by the time this renders the wait is already worth showing.
 */
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

/**
 * #646: the calm "继续中…" hint — a mid-turn step-to-step lull after the turn has
 * already produced content (a tool settled / a step's text finished) while the
 * model works on the next step. Deliberately quieter than
 * `ModelProcessingIndicator`: muted + dimmed static text, no spinner and no
 * shimmer (both read as "actively working" and, fired after every step, made the
 * live thinking look swallowed — the regression this split fixes). A plain
 * whitelisted fade-in is the only motion; reduced-motion neutralizes it globally.
 */
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
  // PR-UI-C1 review fixup (@kenji msg fbb8f119): the smoother
  // typewriters PREFIXES of its input string. If the raw text
  // contains a mid-delta secret like `Authorization: Bearer sk-...`,
  // prefixes such as `Authorization: Bearer s` don't match any
  // redaction pattern by themselves and would leak to the DOM for
  // a frame or two before the downstream Markdown redactor sees
  // the full token. `prepareSmoothStreamText` runs `redactSecrets`
  // on the FULL raw text BEFORE the smoother sees it, so every
  // displayed prefix is guaranteed secret-free.
  //
  // PR-UI-Cx (@kenji msg cd09bcac): `props.text` is already the
  // post-redaction post-cap output of `applyAssistantDelta` (parent
  // ran the chokepoint before updating the live-turn projection),
  // so the smoother only sees safe text. `prepareSmoothStreamText`
  // here is defense-in-depth — `redactSecrets` is idempotent on
  // already-masked text, and the gate guarantees the smoother
  // contract holds even if a future caller forgets the chokepoint.
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
    <Bubble variant="assistant" className="maka-bubble-streaming">
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
    </Bubble>
  );
}

/**
 * Stable key for a timeline entry. Thinking/text keys use the source step's
 * messageId (one thinking + one text per step, so kind+messageId is unique
 * across the turn); tools use the first tool's id (unique per merged group).
 * No index component: a semantic key survives a group being inserted or
 * re-positioned mid-timeline without remounting — and thereby collapsing —
 * the disclosures after it.
 */
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

/**
 * "Processing" — a folded run of the model's reasoning + tool activity between
 * two answer texts (#1307; the fold is derived at render time by
 * `foldTimeline`, which only folds runs containing tool activity — a
 * pure-thinking run renders as the bare 深度思考 disclosure). Collapsed by
 * default (no defaultOpen — same disclosure-collapsible-contract as 深度思考 /
 * the tool trow): the summary line shows the current activity while running and
 * freezes to the settled tool roll-up (tool counts + 「N 个失败」 in
 * destructive; folded reasoning is not counted) once the turn ends. A
 * `waiting_permission` prompt inside forces the block open (trowNeedsAttention);
 * an errored tool stays collapsed with its failure count on the summary line.
 * The expanded panel preserves the full timeline with the SAME 深度思考
 * disclosures and direct tool rows. Processing already owns the group summary,
 * so nesting another tool-group disclosure would duplicate that layer.
 */
function ProcessingBlock(props: { entries: FoldedTimelineChild[] }) {
  const locale = useUiLocale();
  const { entries } = props;
  const running = isProcessingRunning(entries);
  const attention = processingNeedsAttention(entries);
  // Reuse the tool disclosure state machine: ordinary work summarized, a
  // permission prompt opens, an explicit toggle sticks across status changes.
  const disclosure = useToolDisclosure({ kind: 'tool', summary: '', needsAttention: attention });
  // #646 settle seam: play the one-shot landing fade only if this block was
  // seen running here (not a replayed transcript), matching the tool trow.
  const everRunningRef = useRef(false);
  if (running) everRunningRef.current = true;
  const settled = !running;
  const settling = settled && everRunningRef.current;
  const hasSandboxBlocked = entries.some(
    (entry) => entry.kind === 'tools' && entry.items.some(isSandboxDeniedTool),
  );
  const hasError = entries.some(
    (entry) =>
      entry.kind === 'tools' &&
      entry.items.some(
        (item) => item.status === 'errored' && !isSandboxDeniedTool(item),
      ),
  );
  const settledTone = hasError
    ? 'text-[color:var(--destructive)]'
    : hasSandboxBlocked
      ? 'text-[color:var(--warning-text,var(--info-text))]'
      : 'text-[color:var(--muted-foreground)]';
  const activityKind = processingActivityKind(entries);
  const summary = summarizeProcessing(entries, { live: running, locale });
  return (
    <Collapsible
      className="flex flex-col"
      data-processing="block"
      data-settled={settled ? 'true' : undefined}
      open={disclosure.open}
      onOpenChange={disclosure.setOpen}
    >
      {/* Same row language as the tool trow / 深度思考: [16px icon] + [label] +
          hover/open chevron, one tier — hierarchy carried by color, not size. */}
      <CollapsibleTrigger className="group flex w-full items-center gap-2 py-0.5 text-left">
        <ToolKindIcon
          kind={activityKind}
          size={16}
          aria-hidden="true"
          className={cn('shrink-0', settledTone)}
        />
        {running ? (
          <TextShimmer active delayed className="min-w-0 truncate text-[length:var(--font-size-base)]">{summary}</TextShimmer>
        ) : (
          <span className={cn('min-w-0 truncate text-[length:var(--font-size-base)]', settledTone, settling && SETTLE_FADE)}>{summary}</span>
        )}
        <ChevronRight
          size={14}
          aria-hidden="true"
          className="shrink-0 text-[color:var(--muted-foreground)] opacity-0 [transition:transform_var(--duration-quick)_var(--ease-out-strong),opacity_var(--duration-quick)_var(--ease-out-strong)] group-hover:opacity-100 group-data-[panel-open]:rotate-90 group-data-[panel-open]:opacity-100"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="mt-0.5 ml-2 flex flex-col gap-0.5 border-l border-[var(--border)] pl-2.5">
          {entries.map((entry, index) =>
            entry.kind === 'tools' ? (
              <ToolTrow key={timelineEntryKey(entry, index)} items={entry.items} variant="rows" />
            ) : (
              <TurnTimelineEntry key={timelineEntryKey(entry, index)} item={entry} />
            ),
          )}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * "深度思考" — the unified reasoning disclosure for both live streaming and
 * committed history (replaces ReasoningPanel + the retired `.maka-turn-thinking`
 * disclosure). Controlled Collapsible, collapsed by default (no defaultOpen —
 * disclosure-collapsible-contract), fixed title "深度思考".
 *
 * `live=true` (thinking still flowing): the title shimmers (TextShimmer) and the
 * expanded body streams plain redacted text through `useSmoothStreamContent`
 * (non-Markdown for the same frame-pacing reason as the old ReasoningPanel),
 * auto-following the tail. `live=false` (settled / committed): plain title,
 * Markdown render + a "复制思考过程" button.
 *
 * `props.text` is the already-redacted-and-capped buffer (C0 chokepoint);
 * `prepareSmoothStreamText` re-runs `redactSecrets` (idempotent) as
 * defense-in-depth so the smoother never sees a raw secret. The "已截断" pill
 * fires when the thinking cap dropped content.
 */
function DeepThinking(props: { text: string; live: boolean; truncated?: boolean }) {
  const copy = getConversationCopy(useUiLocale()).messages;
  const snap = useStreamSnap();
  const safeText = prepareSmoothStreamText(props.text);
  const { displayed } = useSmoothStreamContent(safeText, { streaming: props.live, snap });
  // Per-word fade over the freshly revealed reasoning tail — same entrance as the
  // main answer bubble (replaces the old caret). Plain-text path (no Markdown),
  // so we tokenize `displayed` directly and wrap post-boundary tokens. Inactive
  // (returns undefined) when settled or under snap.
  const streamFade = useStreamFade(displayed, props.live && !snap);
  // Controlled open (see ReasoningPanel history: a raw `open` attribute lets the
  // ~60Hz stream re-render re-assert open state and undo a manual collapse).
  // Collapsed by default so the answer reads cleanly; the click sticks.
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!props.live || !open) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [displayed, props.live, open]);
  return (
    <Collapsible
      className="flex flex-col"
      data-deep-thinking={props.live ? 'live' : undefined}
      open={open}
      onOpenChange={setOpen}
    >
      {/* Structurally identical to a tool trow row: [16px icon slot] + [label]
          + [hover-reveal trailing chevron]. One font size (base 13px), one
          weight (normal), muted color — the whole folded timeline reads as a
          single tier, hierarchy carried by color, not by size/weight jitter. */}
      <CollapsibleTrigger className="group flex w-full items-center gap-2 py-0.5 text-left">
        <Brain
          size={16}
          aria-hidden="true"
          className="shrink-0 text-[color:var(--muted-foreground)]"
        />
        {props.live ? (
          <TextShimmer active={!snap} className="min-w-0 truncate text-[length:var(--font-size-base)]">{copy.thinking}</TextShimmer>
        ) : (
          <span className="min-w-0 truncate text-[length:var(--font-size-base)] text-[color:var(--muted-foreground)]">{copy.thinking}</span>
        )}
        {/* "已截断" pill: the thinking cap (applyThinkingDelta /
            applyThinkingComplete) dropped content; same chrome as the
            tool-output truncated pill. */}
        {props.truncated && (
          <span
            className="rounded-[var(--radius-control)] border border-[oklch(from_var(--warning)_l_c_h_/_0.30)] bg-[oklch(from_var(--warning)_l_c_h_/_0.06)] px-1 text-[length:var(--font-size-caption)] text-[color:var(--warning-text,var(--info-text))]"
            data-truncated="true"
            title={copy.thinkingTruncatedTitle}
          >
            {copy.truncated}
          </span>
        )}
        {/* Quiet chevron sits right after the label (near the text, not pinned
            to the far edge), rides in on hover / open, matching the tool trow
            rows. No always-on affordance so the folded row stays calm. */}
        <span className="inline-flex shrink-0 items-center text-[color:var(--muted-foreground)] opacity-0 [transition:opacity_var(--duration-quick)_var(--ease-out-strong)] group-hover:opacity-100 group-data-[panel-open]:opacity-100">
          <ChevronRight
            size={14}
            aria-hidden="true"
            className="[transition:transform_var(--duration-quick)_var(--ease-out-strong)] group-data-[panel-open]:rotate-90"
          />
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {/* Left-border-indented quiet detail block, one language with the tool
            trow's expanded body. `live` and settled render the SAME plain-text
            body at the caption tier so the two states never jump size; settled
            is muted + regular weight (long reasoning in italic reads poorly).
            The copy action is an icon-only hover affordance pinned top-right so
            it never squeezes the reading column into a vertical char stack. */}
        <div className="group/reasoning relative mt-1 ml-2 border-l border-[var(--border)] pl-2.5 pr-7">
          {props.live ? (
            <pre
              ref={bodyRef}
              className="m-0 max-h-64 overflow-y-auto whitespace-pre-wrap [word-break:break-word] [font-family:inherit] text-[length:var(--font-size-base)] leading-normal text-[color:var(--muted-foreground)] [scroll-behavior:auto]"
            >
              <DeepThinkingBody text={displayed} streamFade={streamFade} />
            </pre>
          ) : (
            <>
              {/* Same `max-h-64 overflow-y-auto` bound as the live `<pre>` above
                  so an expanded panel doesn't jump taller the frame thinking
                  settles (live→settled swaps this body in place). Long reasoning
                  stays a compact scroll box in both states. Body uses base 13px
                  so tool output and thinking share one reading size. */}
              <div className="max-h-64 overflow-y-auto whitespace-pre-wrap [word-break:break-word] text-[length:var(--font-size-base)] leading-normal text-[color:var(--muted-foreground)]">
                {props.text}
              </div>
              <div className="absolute right-0 top-0 opacity-0 [transition:opacity_var(--duration-quick)_var(--ease-out-strong)] group-hover/reasoning:opacity-100 focus-within:opacity-100">
                <MessageCopyButton text={props.text} label={copy.copyThinking} footerStyle />
              </div>
            </>
          )}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * Plain-text reasoning body with the same per-word fade as the answer bubble.
 * When `streamFade` is absent (settled / snap) it renders the raw string so the
 * deterministic capture shows the full text with no spans. Otherwise it splits
 * the whole buffer at grapheme 0 and wraps each post-boundary token in a
 * `.maka-stream-fade` span with a negative `animation-delay` (= -age) so the
 * entrance resumes mid-flight across the ~60Hz streaming re-renders.
 */
function DeepThinkingBody(props: { text: string; streamFade?: StreamFade }) {
  const fade = props.streamFade;
  if (!fade) return <>{props.text}</>;
  const { tokens } = tokenizeFade(props.text, 0, fade.boundaryOffset);
  return (
    <>
      {tokens.map((token, index) =>
        token.fade ? (
          <span
            key={index}
            className="maka-stream-fade"
            style={{ animationDelay: `-${Math.round(fade.ageAt(token.offset))}ms` }}
          >
            {token.text}
          </span>
        ) : (
          <Fragment key={index}>{token.text}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * PR-UI-RENDER-1 — reduced-motion / e2e-fixture probe for the
 * streaming smoother.
 *
 * Three triggers force the smoother to snap (mirroring the rule in
 * `apps/desktop/src/renderer/scroll-motion-policy.ts`):
 *
 *   1. `data-maka-reduced-motion="true"` — set by the PR-IR-04
 *      reduced variant of the e2e-fixture fixture.
 *   2. `data-maka-e2e-fixture="true"` — set by ANY e2e-fixture
 *      capture so screenshots see the final text on the first paint.
 *   3. OS-level `prefers-reduced-motion: reduce`.
 *
 * The hook reads the dataset attributes once on mount (they're set
 * pre-React in main.tsx and don't toggle during a session) but
 * subscribes to `matchMedia` for the OS preference so a mid-session
 * toggle reaches the running stream.
 */
function useStreamSnap(): boolean {
  const [snap, setSnap] = useState(() => readStreamSnap());
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setSnap(readStreamSnap());
    // Initial read (in case dataset attrs landed after first paint).
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
