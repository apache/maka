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

import { memo, useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import { ICON_SIZE, AlertOctagon, Ban, Check, Copy, GitBranch, Info, Pencil, RefreshCcw, Timer } from './icons.js';
import { type ClipboardCopyPhase, useClipboardCopyFeedback } from './clipboard-feedback.js';
import { Markdown } from './markdown.js';
import {
  formatAbsoluteTimestamp,
  formatTurnDuration,
  turnAbortMarkerLabel,
} from './chat-display-helpers.js';
import { redactSecrets } from './redact.js';
import { isProgressiveStreamingEnabled, isTimeDrivenMotionEnabled } from './streaming-presentation.js';
import {
  Badge,
  Banner,
  Button as UiButton,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageMetadata,
  ChatSystemMessage,
  ChatTokenizedText,
  HStack,
  IconButton as UiIconButton,
  Spinner,
  Thumbnail,
  Timestamp,
  Token,
  useLightbox,
} from '@astryxdesign/core';
import { useStreamingText } from '@astryxdesign/core/hooks';
import { ChatReasoning } from './astryx-chat-reasoning.js';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { SKILL_INVOCATION_TOKEN_SOURCE } from '@maka/core/skill-invocation-token';
import {
  type AttachmentRef,
  type InlineReference,
  type ProviderRetryEvent,
  type QuoteRef,
} from '@maka/core/events';
import {
  finalAssistantReplyText,
  type TurnTimelineItem,
  type TurnViewModel,
} from './materialize.js';
import { foldTimeline, type FoldedTimelineChild, type FoldedTimelineEntry } from './timeline-fold.js';
import { AttachmentKindIcon } from './attachment-kinds.js';
import { QuoteRefChip } from './quote-ref-chip.js';
import { Marker, markerVariants } from './primitives/chat.js';
import { ToolTrow, toolTrowHasVisibleSpinner } from './tool-activity.js';
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

/**
 * A user message: their text verbatim, with attachments, quotes and the edit
 * affordance. Memoized so streaming re-renders do not rebuild settled asks.
 */
const UserMessageBody = memo(function UserMessageBody(props: {
  messageId: string;
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
          /* `value` takes ms directly: Timestamp's own parseValue reads
             anything past 1e12 as milliseconds (2001-09-09 onward), and a
             chat message never predates that. */
          (<Timestamp className="maka-message-time-inline" value={props.ts} format="time" />)
        ) : undefined
      }
      footer={
        <>
          <MessageCopyButton
            messageId={props.messageId}
            text={props.text}
            ts={props.ts}
          />
          {props.onEditUserMessage ? (
            <UiIconButton
              label={copyText.messageActionAriaLabel(
                editActionLabel,
                accessibleActionContext(props.text, props.ts, locale),
              )}
              tooltip={editActionLabel}
              icon={<Pencil size={ICON_SIZE.control} aria-hidden="true" />}
              variant="ghost"
              size="sm"
              className={markerVariants({ variant: 'footer-action' })}
              aria-disabled={props.editDisabled === true ? 'true' : undefined}
              data-action="edit"
              data-message-id={props.messageId}
              onClick={() => {
                if (props.editDisabled) return;
                props.onEditUserMessage?.();
              }}
            />
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
});


function accessibleTextExcerpt(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 48 ? `${normalized.slice(0, 47)}…` : normalized;
}

function accessibleActionContext(text: string, ts: number | undefined, locale: 'zh' | 'en'): string {
  return [
    accessibleTextExcerpt(text),
    ts === undefined ? undefined : formatAbsoluteTimestamp(ts, locale),
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
}

function MessageCopyButton(props: {
  messageId: string;
  text: string;
  ts?: number;
}) {
  const locale = useUiLocale();
  const copyText = getConversationCopy(locale).messages;
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
    ? <Check size={ICON_SIZE.control} aria-hidden="true" />
    : <Copy size={ICON_SIZE.control} aria-hidden="true" />;

  return (
    <UiIconButton
      label={copyText.messageActionAriaLabel(
        baseLabel,
        accessibleActionContext(props.text, props.ts, locale),
      )}
      data-message-id={props.messageId}
      tooltip={actionLabel}
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
    /**
     * Whether to show the running status line at the tail of the live turn.
     *
     * It stays up for the WHOLE turn, not just the wait before the first token.
     * The cue it replaces was gated on the turn having no live content yet, so
     * it vanished the moment a tool started — exactly the stretch where a turn
     * looks abandoned and the user most needs to see it is still working.
     */
    runningStatus?: boolean;
    providerRetry?: ProviderRetryEvent;
    initialLiveContent?: ReadonlyMap<string, string>;
  };
  /**
   * Injected host reader for image attachment bytes. Threaded down to the user
   * message's `AttachmentImage` thumbnails; absent on non-desktop hosts, where
   * image thumbnails stay in their pending skeleton. Keeps @maka/ui from
   * reaching into the desktop preload directly.
   */
  onReadAttachmentBytes?: ReadAttachmentBytes;
  /**
   * Open a linked subagent child session in the main chat column. Threaded into
   * linked subagent tool rows; omitted when the host has no navigation.
   */
  onOpenLinkedSession?(sessionId: string): void;
}) {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).messages;
  const { turn } = props;
  const forwardBadges = props.lineageBadges?.filter((b) => b.direction === 'forward') ?? [];
  const reverseBadges = props.lineageBadges?.filter((b) => b.direction === 'reverse') ?? [];
  // A recorded conversational terminal turn owns presentation beyond its
  // timeline: failure/abort state and recovery actions must remain visible even
  // when the provider produced no assistant event. Inferred legacy turns and
  // internal operations do not carry enough evidence for a recovery action.
  const showAssistantMessage =
    turn.timeline.length > 0 ||
    !!props.liveStreaming ||
    (turn.user !== undefined && turn.statusSource === 'recorded' && turn.status !== 'running');
  // #1307: the collapsed "Processing" fold is derived at render time from the
  // flat timeline. Settled turn identities are stable (memoized projections),
  // so this only recomputes for the turn whose timeline actually changed.
  const foldedTimeline = useMemo(() => foldTimeline(turn.timeline), [turn.timeline]);
  const conversationSegments = useMemo(
    () => splitTimelineAtUserMessages(foldedTimeline, showAssistantMessage),
    [foldedTimeline, showAssistantMessage],
  );
  const toolSurfaceOwnsSpinner = turn.timeline.some(
    (item) => item.kind === 'tools' && toolTrowHasVisibleSpinner(item.items),
  );
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
              icon={<GitBranch size={ICON_SIZE.meta} aria-hidden="true" />}
              label={badge.label}
            />
          ))}
        </Marker>
      )}
      {/* Host provenance keeps non-user prompts from impersonating the user.
          Durable ids stay in tooltips instead of the transcript body. */}
      {turn.user?.hostOrigin?.kind === 'scheduled_task' && (
        <Marker
          variant="host-origin"
          role="note"
          title={copy.scheduledTaskTitle(turn.user.hostOrigin.scheduledTaskId)}
        >
          <Timer size={ICON_SIZE.meta} aria-hidden="true" />
          <span>{copy.scheduledTaskTriggered}</span>
        </Marker>
      )}
      {turn.user?.hostOrigin?.kind === 'legacy_automation' && (
        <Marker
          variant="host-origin"
          role="note"
          title={copy.legacyAutomationTitle(turn.user.hostOrigin.automationId)}
        >
          <Timer size={ICON_SIZE.meta} aria-hidden="true" />
          <span>{copy.legacyAutomationTriggered}</span>
        </Marker>
      )}
      {turn.user?.hostOrigin?.kind === 'goal' && (
        <Marker
          variant="host-origin"
          role="note"
          title={copy.goalTitle(turn.user.hostOrigin.goalId)}
        >
          <RefreshCcw size={ICON_SIZE.meta} aria-hidden="true" />
          <span>{copy.goalContinued}</span>
        </Marker>
      )}
      {turn.user?.hostOrigin?.kind === 'agent_graph' && (
        <Marker
          variant="host-origin"
          role="note"
          title={copy.agentGraphTitle(turn.user.hostOrigin.graphId)}
        >
          <GitBranch size={ICON_SIZE.meta} aria-hidden="true" />
          <span>{copy.agentGraphTriggered}</span>
        </Marker>
      )}
      {turn.user && (
        <LocalizedChatMessage
          accessibleLabel={
            turn.user.hostOrigin?.kind === 'legacy_automation'
              ? copy.legacyAutomationTriggered
              : copy.userAriaLabel
          }
          sender="user"
          className="maka-chat-message maka-user-message"
        >
          <UserMessageBody
            messageId={turn.user.id}
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
      {conversationSegments.map((segment, segmentIndex) => {
        if (segment.kind === 'user') {
          const message = segment.item.message;
          return (
            <LocalizedChatMessage
              key={`user-${message.id}`}
              accessibleLabel={copy.userAriaLabel}
              sender="user"
              className="maka-chat-message maka-user-message maka-steering-message"
            >
              <UserMessageBody
                messageId={message.id}
                text={message.text}
                ts={message.ts}
                attachments={message.attachments}
                quotes={message.quotes}
                inlineReferences={message.inlineReferences}
                onReadAttachmentBytes={props.onReadAttachmentBytes}
              />
            </LocalizedChatMessage>
          );
        }
        const ownsTurnChrome = segmentIndex === conversationSegments.length - 1;
        return (
          <LocalizedChatMessage
            // Disjoint namespaces: a steering id is any string, so a bare
            // sentinel could collide with a real one.
            key={
              segment.repliesTo === undefined
                ? 'assistant-opening'
                : `assistant-after-${segment.repliesTo}`
            }
            accessibleLabel={copy.assistantAriaLabel}
            sender="assistant"
            data-turn-status={turn.status}
            className="maka-chat-message maka-assistant-answer"
          >
            <div className="maka-assistant-answer-content">
              {ownsTurnChrome && turn.status === 'aborted' && (
                <Marker variant="aborted" role="status">
                  <Ban size={ICON_SIZE.meta} aria-hidden="true" />
                  <em>{turnAbortMarkerLabel(turn.abortSource, locale)}</em>
                </Marker>
              )}
              {ownsTurnChrome && turn.status === 'failed' && props.failedReasonLabel && (
                <Marker variant="failed-banner" role="alert">
                  <Marker as="span" variant="failed-icon" aria-hidden="true">
                    <AlertOctagon size={ICON_SIZE.control} />
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
                      label={
                        props.safeResumeAction.pending ? copy.safeResumePending : copy.safeResume
                      }
                    />
                  )}
                </Marker>
              )}
              {/* The turn timeline is the rendering source of truth
                (materialize.ts): each step's 深度思考 disclosure, answer bubble,
                and Astryx tool group in the order the model produced them.
                #1307: runs of reasoning + tools between answer texts render
                through the derived fold as collapsed Processing blocks. */}
              {segment.items.map((item, index) =>
                item.kind === 'processing' ? (
                  <ProcessingBlock
                    key={`processing-${item.id}`}
                    entries={item.children}
                    onOpenLinkedSession={props.onOpenLinkedSession}
                    initialLiveContent={props.liveStreaming?.initialLiveContent}
                  />
                ) : (
                  <TurnTimelineEntry
                    key={timelineEntryKey(item, index)}
                    item={item}
                    onStreamingSettled={props.liveStreaming?.onStreamingSettled}
                    onOpenLinkedSession={props.onOpenLinkedSession}
                    initialLiveContent={props.liveStreaming?.initialLiveContent}
                  />
                ),
              )}
              {ownsTurnChrome && props.liveStreaming && (
                <>
                  {props.liveStreaming.providerRetry ? (
                    <ModelProviderRetryIndicator retry={props.liveStreaming.providerRetry} />
                  ) : (
                    props.liveStreaming.runningStatus && (
                      <TurnRunningStatus
                        startedAt={turn.startedAt}
                        showSpinner={!toolSurfaceOwnsSpinner}
                      />
                    )
                  )}
                </>
              )}
            </div>
            {ownsTurnChrome && reverseBadges.length > 0 && (
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
                    icon={<GitBranch size={ICON_SIZE.meta} aria-hidden="true" />}
                    label={badge.label}
                  />
                ))}
              </Marker>
            )}
            {ownsTurnChrome &&
              (props.liveStreaming ? (
                /* #642: reserved-height footer placeholder while streaming — same
                   `mt-0.5 h-8` box the real footer occupies, so the live→settled
                   swap is height-neutral (the footer slot never grows/shrinks). No
                   actionable footer here: the live tail's derived status is
                   `completed`, so a real `TurnFooterActions` would render a
                   clickable regenerate/branch on a still-streaming answer. */
                <div aria-hidden="true" className="maka-live-turn-footer-placeholder" />
              ) : (
                props.footerActions &&
                props.footerActions.length > 0 && (
                  <TurnFooterActions
                    actions={props.footerActions}
                    context={accessibleActionContext(
                      turn.user?.text ?? finalAssistantReplyText(turn) ?? '',
                      turn.startedAt,
                      locale,
                    )}
                    onAction={
                      props.onFooterAction
                        ? (actionId) => props.onFooterAction?.(turn.turnId, actionId)
                        : undefined
                    }
                    assistantText={finalAssistantReplyText(turn)}
                  />
                )
              ))}
          </LocalizedChatMessage>
        );
      })}
    </section>
  );
});

type UserTimelineItem = Extract<TurnTimelineItem, { kind: 'user' }>;
type AssistantFoldedTimelineEntry = Exclude<FoldedTimelineEntry, UserTimelineItem>;
type ConversationSegment =
  | { kind: 'user'; item: UserTimelineItem }
  | {
      kind: 'assistant';
      items: AssistantFoldedTimelineEntry[];
      /**
       * What this answer replies to: the steering message that opened it, or
       * the turn itself for the first answer. This is the segment's identity —
       * its React key must not be derived from its contents, because those
       * change as the turn runs (a Processing fold dissolves once its last
       * tools group is projected away) and a changing key remounts the whole
       * answer, costing the user their scroll position, any disclosure they
       * had open, and any text Selection held inside it.
       *
       * Same rule, same reason as `ProcessingFold.id` in `timeline-fold.ts`:
       * identity comes from the preceding boundary, never from the first child.
       */
      repliesTo?: string;
    };

function splitTimelineAtUserMessages(
  items: readonly FoldedTimelineEntry[],
  includeEmptyAssistant: boolean,
): ConversationSegment[] {
  const segments: ConversationSegment[] = [];
  let repliesTo: string | undefined;
  for (const item of items) {
    const last = segments.at(-1);
    if (item.kind === 'user') {
      segments.push({ kind: 'user', item });
      repliesTo = item.message.id;
    } else if (last?.kind === 'assistant') {
      last.items.push(item);
    } else {
      segments.push({ kind: 'assistant', items: [item], repliesTo });
    }
  }
  if (includeEmptyAssistant && segments.at(-1)?.kind !== 'assistant') {
    segments.push({ kind: 'assistant', items: [], repliesTo });
  }
  return segments;
}

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
  context: string;
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
      aria-label={copy.answerActionsAriaLabel(props.context)}
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
              ? <Check size={ICON_SIZE.control} aria-hidden="true" />
              : STATUS_FOOTER_ICON[action.id];
            return (
              <UiIconButton
                key={action.id}
                label={copy.answerActionAriaLabel(
                  action.label,
                  props.context,
                )}
                tooltip={tooltipText}
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
            );
          })}
        </>
      }
    />
  );
}

const STATUS_FOOTER_ICON: Record<TurnFooterActionMeta['id'], ReactNode> = {
  regenerate: <RefreshCcw size={ICON_SIZE.control} aria-hidden="true" />,
  branch: <GitBranch size={ICON_SIZE.control} aria-hidden="true" />,
  copy: <Copy size={ICON_SIZE.control} aria-hidden="true" />,
  info: <Info size={ICON_SIZE.control} aria-hidden="true" />,
};

/** How long one working phrase holds before the next fades in. */
const WORKING_PHRASE_INTERVAL_MS = 20_000;
/** Must match the `.maka-turn-working-phrase` transition duration in styles.css. */
const WORKING_PHRASE_FADE_MS = 300;
const ELAPSED_TICK_MS = 1_000;

/**
 * The live turn's running status line: a working phrase that rotates every 20s,
 * and the elapsed clock beside it.
 *
 * The elapsed time is what actually carries the message — it is the only part
 * that proves the harness and the model are still moving, and it is why the
 * phrase pool can afford to be playful rather than informative. Both are driven
 * by the clock, so this component owns its own timers and re-renders only
 * itself: hoisting the seconds into the turn (let alone the shell) would repaint
 * the whole transcript once a second while an answer streams into it.
 *
 * `startedAt` is the turn's own first-message timestamp, so the clock measures
 * the wait the user actually experienced — from pressing send, not from
 * whenever the model's first event happened to land. It is absent only on the
 * rare fallback path where streaming beat the user turn into the transcript;
 * the phrase then stands alone.
 */
export function TurnRunningStatus(props: { startedAt?: number; showSpinner?: boolean }) {
  const copy = getConversationCopy(useUiLocale()).messages;
  const phrases = copy.workingPhrases;
  const { startedAt } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  // Undefined until an effect measures it, which is also what keeps a static
  // render deterministic: the clock is a client-only value, so server markup
  // and the first paint carry the phrase alone.
  const [elapsedMs, setElapsedMs] = useState<number | undefined>(undefined);
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [phraseFading, setPhraseFading] = useState(false);

  useEffect(() => {
    // Frozen (fixture / reduced motion) the clock is dropped rather than
    // pinned: any value it could show is a real wall-clock difference, so a
    // capture taken a second later would differ from this one. The gate needs
    // this node because the freeze can be declared on any ancestor.
    if (startedAt === undefined || !isTimeDrivenMotionEnabled(rootRef.current)) return;
    setElapsedMs(Math.max(0, Date.now() - startedAt));
    const tick = window.setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - startedAt));
    }, ELAPSED_TICK_MS);
    return () => window.clearInterval(tick);
  }, [startedAt]);

  useEffect(() => {
    if (phrases.length < 2 || !isTimeDrivenMotionEnabled(rootRef.current)) return;
    let fadeTimer: number | undefined;
    const rotate = window.setInterval(() => {
      setPhraseFading(true);
      fadeTimer = window.setTimeout(() => {
        setPhraseIndex((current) => (current + 1) % phrases.length);
        setPhraseFading(false);
      }, WORKING_PHRASE_FADE_MS);
    }, WORKING_PHRASE_INTERVAL_MS);
    return () => {
      window.clearInterval(rotate);
      if (fadeTimer !== undefined) window.clearTimeout(fadeTimer);
    };
  }, [phrases.length]);

  return (
    <div className="maka-turn-processing" role="status" aria-label={copy.processing} ref={rootRef}>
      {props.showSpinner !== false && (
        <Spinner size="md" shade="subtle" aria-hidden="true" />
      )}
      {/* Every visible token here moves on the clock. Announcing either would
          talk over the answer being streamed beside it, so the row's label is
          its whole accessible name and the text is decoration. */}
      <span className="maka-turn-indicator-text" aria-hidden="true">
        <span className="maka-turn-working-phrase" data-fading={phraseFading || undefined}>
          {phrases[phraseIndex] ?? copy.processing}
        </span>
        {elapsedMs !== undefined && (
          <>
            <span className="maka-turn-status-separator">·</span>
            <span className="maka-turn-elapsed">{formatTurnDuration(elapsedMs)}</span>
          </>
        )}
      </span>
    </div>
  );
}

export function ModelProviderRetryIndicator(props: { retry: ProviderRetryEvent }) {
  const copy = getConversationCopy(useUiLocale()).messages;
  const title =
    props.retry.phase === 'scheduled'
      ? copy.providerRetryScheduled(
          Math.max(1, Math.ceil(props.retry.delayMs / 1_000)),
          props.retry.attempt,
          props.retry.maxAttempts,
        )
      : copy.providerRetryStarted(props.retry.attempt, props.retry.maxAttempts);
  return (
    <Banner
      status="warning"
      container="section"
      role="status"
      className="maka-turn-provider-retry"
      title={title}
      description={copy.providerRetryReason[props.retry.reason]}
    />
  );
}

/**
 * Which of an answer's three lives this bubble is rendering.
 *
 * One field, not a pair of booleans: a bubble replayed from history has no
 * stream to be behind, no settlement to announce, and no live-stream seed, so
 * `historical` must not be able to carry those at all. Spelling it as
 * `(live, streaming)` made `live: false, streaming: true` representable and
 * pushed the gating out to every call site, where forgetting one is silent.
 */
type AssistantAnswerPhase = 'historical' | 'streaming' | 'settled';

type AssistantAnswerBubbleProps =
  | { text: string; phase: 'historical' }
  | {
      text: string;
      phase: 'streaming' | 'settled';
      /** Text already streamed before this mount, so a remount does not replay it. */
      settledText?: string;
      truncated?: boolean;
      /** Called once when this answer's stream closes. */
      onSettled?: () => void;
    };

/**
 * The assistant's answer, in every state it can be in.
 *
 * One component on purpose. Swapping component types as a turn ends would
 * unmount the answer's DOM and mount an identical-looking copy, taking with it
 * the user's scroll position, any open disclosure inside, and any text
 * Selection held in the removed subtree.
 */
const AssistantAnswerBubble = memo(function AssistantAnswerBubble(props: AssistantAnswerBubbleProps) {
  const copy = getConversationCopy(useUiLocale()).messages;
  const settledText = props.phase === 'historical' ? undefined : props.settledText;
  const truncated = props.phase === 'historical' ? false : props.truncated === true;
  const onSettled = props.phase === 'historical' ? undefined : props.onSettled;
  // Settlement is an edge, not a value: it happens when this answer *enters*
  // `settled`, including straight into it on mount. Reading the phase alone
  // would let a historical bubble — which mounts already past the stream —
  // consume the announcement that belongs to the live handoff.
  const announcedFrom = useRef<AssistantAnswerPhase | null>(null);

  useEffect(() => {
    const previous = announcedFrom.current;
    announcedFrom.current = props.phase;
    if (props.phase !== 'settled' || previous === 'settled') return;
    onSettled?.();
  }, [props.phase, onSettled]);

  return (
    <ChatMessageBubble
      variant="ghost"
      className={
        props.phase === 'historical'
          ? 'maka-chat-message-bubble maka-chat-message-bubble-assistant'
          : 'maka-chat-message-bubble maka-chat-message-bubble-assistant maka-bubble-streaming'
      }
    >
      <Markdown
        text={props.text}
        streaming={props.phase === 'streaming'}
        settledText={settledText}
        // Names the surface, and not exclusively: the desktop Artifact
        // Preview asks for compact too and takes the same rules, so retuning
        // them here is retuning them there. What this prop does NOT do is set
        // this turn's block spacing. Every top-level gap in a transcript turn
        // comes from the rhythm table in styles.css, which keys on the
        // `data-density="compact"` this prop reflects and overrides Astryx's
        // own margins outright. So `compact` still buys the transcript
        // heading scale and the tighter rhythm inside a list item or a quote,
        // and reading it as "paragraphs are squeezed here" is the wrong
        // file — retune `--md-gap-block` instead.
        density="compact"
      />
      {truncated && (
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
});

// Semantic keys (no index) so mid-timeline inserts do not remount/collapse disclosures.
function timelineEntryKey(item: TurnTimelineItem, index: number): string {
  if (item.kind === 'tools') return `tools-${item.items[0]?.toolUseId ?? index}`;
  return `${item.kind}-${item.messageId}`;
}

/** Render one timeline entry: reasoning disclosure / answer bubble / tool group. */
function TurnTimelineEntry(props: {
  item: Exclude<TurnTimelineItem, { kind: 'user' }>;
  onStreamingSettled?: (messageId?: string) => void;
  onOpenLinkedSession?(sessionId: string): void;
  initialLiveContent?: ReadonlyMap<string, string>;
}) {
  const { item } = props;
  if (item.kind === 'thinking') {
    return (
      <DeepThinking
        text={item.text}
        live={item.live === true}
        settledText={props.initialLiveContent?.get(`thinking:${item.messageId}`)}
        truncated={item.truncated === true}
      />
    );
  }
  if (item.kind === 'tools') {
    return <ToolTrow items={item.items} onOpenLinkedSession={props.onOpenLinkedSession} />;
  }
  // Same component either way — a type swap here would remount the answer.
  if (item.live !== true) return <AssistantAnswerBubble text={item.text} phase="historical" />;
  return (
    <AssistantAnswerBubble
      text={item.text}
      phase={item.complete === true ? 'settled' : 'streaming'}
      settledText={props.initialLiveContent?.get(`text:${item.messageId}`)}
      truncated={item.truncated === true}
      onSettled={() => props.onStreamingSettled?.(item.messageId)}
    />
  );
}

function ProcessingBlock(props: {
  entries: FoldedTimelineChild[];
  onOpenLinkedSession?(sessionId: string): void;
  initialLiveContent?: ReadonlyMap<string, string>;
}) {
  const { entries } = props;
  return (
    <div className="maka-processing-sequence">
      {entries.map((entry, index) => (
        <TurnTimelineEntry
          key={timelineEntryKey(entry, index)}
          item={entry}
          onOpenLinkedSession={props.onOpenLinkedSession}
          initialLiveContent={props.initialLiveContent}
        />
      ))}
    </div>
  );
}

function DeepThinking(props: { text: string; live: boolean; settledText?: string; truncated?: boolean }) {
  const copy = getConversationCopy(useUiLocale()).messages;
  const safeText = redactSecrets(props.text);
  const displayed = useStreamingText(safeText, isProgressiveStreamingEnabled(props.live), {
    settledText: props.settledText === undefined
      ? undefined
      : redactSecrets(props.settledText),
  });
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
