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

import { Fragment, memo, useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { ICON_SIZE, ChevronRight, GitBranch, Pencil, RefreshCcw, Timer } from './icons.js';
import { useClipboardCopyFeedback } from './clipboard-feedback.js';
import { Markdown } from './markdown.js';
import { formatTurnDuration } from './chat-display-helpers.js';
import { formatAbsoluteTimestamp } from '@maka/core/relative-time';
import { isTimeDrivenMotionEnabled } from './streaming-presentation.js';
import { computerRunningLabel } from './tool-activity/computer-action-label.js';
import {
  Badge,
  Banner,
  Button as UiButton,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageMetadata,
  ChatSystemMessage,
  HStack,
  IconButton as UiIconButton,
  Spinner,
  Thumbnail,
  Timestamp,
  Token,
  useLightbox,
  useMediaQuery,
} from '@astryxdesign/core';
import { ChatReasoning } from './astryx-chat-reasoning.js';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { Icon } from '@astryxdesign/core/Icon';
import {
  type AttachmentRef,
  type InlineReference,
  type QuoteRef,
} from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import type { TransientUserMessageProjection } from './chat-view.js';
import { type LiveProviderRetry } from './live-turn-projection.js';
import { providerRetryDisplaySeconds } from '@maka/core/provider-retry-countdown';
import {
  type TurnTimelineItem,
  type TurnViewModel,
} from './materialize.js';
import { foldTimeline, reconcileFoldedEntries, type FoldedTimelineChild, type FoldedTimelineEntry } from './timeline-fold.js';
import { AttachmentKindIcon } from './attachment-kinds.js';
import { QuoteRefChip } from './quote-ref-chip.js';
import { Marker, markerVariants } from './primitives/chat.js';
import { ToolTrow } from './tool-activity.js';
import { formatBytes } from './tool-activity/preview-utils.js';
import { useUiLocale } from './locale-context.js';
import type { UiLocale } from '@maka/core/ui-locale';
import { getConversationCopy } from './conversation-copy.js';
import { AstryxLocaleProvider } from './astryx-i18n.js';
import { InlineReferenceText } from './inline-reference.js';
import { DirectoryReferenceChip } from './directory-reference-chip.js';
import { redactSecrets } from './redact.js';
import { useAttachmentImageSource } from './attachment-image.js';
import { resolvePreviewKind } from './artifact-preview-registry.js';
import { MakaClientSlotOutlet, useMakaClientSlotOccupied } from './client-plugin-slots.js';

export function LocalizedChatMessage({
  accessibleLabel,
  ...props
}: Omit<ComponentPropsWithoutRef<typeof ChatMessage>, 'aria-label'> & {
  accessibleLabel: string;
}) {
  const overrides = useMemo(
    // This is already formatted text, not an ICU template. Quote from the
    // first syntax character onward; ICU only opens a quote before syntax.
    () => ({ '@astryx.chatMessage.messageFrom': accessibleLabel.replace(/'/g, "''").replace(/[{}<>].*$/s, "'$&'") }),
    [accessibleLabel],
  );
  return (
    <AstryxLocaleProvider overrides={overrides}>
      <ChatMessage {...props} />
    </AstryxLocaleProvider>
  );
}

function AttachmentImage(props: { attachment: AttachmentRef }) {
  const preview = resolvePreviewKind({
    name: props.attachment.name,
    kind: 'image',
    mimeType: props.attachment.mimeType,
    sizeBytes: props.attachment.bytes,
  });
  const ref = preview.kind === 'image' && props.attachment.ref.kind === 'session_file'
    ? {
        sessionId: props.attachment.ref.sessionId,
        artifactId: props.attachment.ref.relativePath,
      }
    : undefined;
  const src = useAttachmentImageSource(ref);
  if (!src) {
    return (
      <Thumbnail
        className="maka-user-attachment-thumbnail"
        alt={props.attachment.name}
        label={props.attachment.name}
        isLoading={preview.kind === 'image'}
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
  directoryReferences?: readonly import('@maka/core/events').DirectoryReference[];
  inlineReferences?: readonly InlineReference[];
  /** When set on a user message, show an edit affordance that starts a revision draft. */
  onEditUserMessage?: () => void;
  editDisabled?: boolean;
  editDisabledReason?: string;
  delivery?: TransientUserMessageProjection;
  status?: ReactNode;
}) {
  const locale = useUiLocale();
  const copyText = getConversationCopy(locale).messages;
  const nonImageAttachments = props.attachments?.filter((attachment) => attachment.kind !== 'image') ?? [];
  const imageAttachments = props.attachments?.filter((attachment) => attachment.kind === 'image') ?? [];
  const editActionLabel = props.editDisabled
    ? (props.editDisabledReason ?? copyText.editMessageDisabledRunning)
    : copyText.editMessage;
  // Time and delivery status ride in the footer slot beside the actions rather
  // than in Astryx's `timestamp` slot: that slot draws a `·` before the footer,
  // and a separator between the stamp and the first action reads as a stray mark.
  const timeOrDelivery = props.delivery?.deliveryStatus ? (
    <span className="maka-message-delivery" role="status" title={props.delivery.deliveryDetail}>
      {props.delivery.deliveryStatus}
    </span>
  ) : props.ts !== undefined ? (
    // Timestamp takes milliseconds directly for modern chat timestamps.
    <Timestamp className="maka-message-time-inline" value={props.ts} format="auto" isLive />
  ) : null;
  const userMetadata = (
    <ChatMessageMetadata
      className="maka-message-meta"
      footer={
        <>
          {props.status ? <span className="maka-message-status-time">
            {props.status}
            {timeOrDelivery ? <span aria-hidden="true">·</span> : null}
            {timeOrDelivery}
          </span> : timeOrDelivery}
          {props.delivery?.deliveryActions?.map((action) => (
            <UiButton key={action.label} label={action.label} variant="ghost" size="sm" onClick={action.onClick} />
          ))}
          <CopyButton
            copyKey="message"
            text={props.text}
            label={copyText.copy}
            ariaLabel={copyText.messageActionAriaLabel(
              copyText.copy,
              accessibleActionContext(props.text, props.ts, locale),
            )}
            dataMessageId={props.messageId}
          />
          {props.onEditUserMessage ? (
            <UiIconButton
              label={copyText.messageActionAriaLabel(
                editActionLabel,
                accessibleActionContext(props.text, props.ts, locale),
              )}
              tooltip={editActionLabel}
              icon={<Icon icon={Pencil} size="sm" />}
              variant="ghost"
              size="sm"
              className={markerVariants({ variant: 'footer-action' })}
              isDisabled={props.editDisabled === true}
              data-action="edit"
              data-message-id={props.messageId}
              onClick={() => props.onEditUserMessage?.()}
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
      {props.directoryReferences?.length ? (
        <HStack gap={1} wrap="wrap" maxWidth="100%">
          {props.directoryReferences.map((reference, index) => (
            <DirectoryReferenceChip key={index} reference={reference} />
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
            />
          ))}
        </HStack>
      ) : null}
      {/* A structured-only message (#4804) may carry only quotes/attachments;
          an empty text must not render an empty bubble on those paths, but the
          metadata (timestamp, copy, edit entry) still belongs to the message. */}
      {props.text.trim().length > 0 ? (
        <ChatMessageBubble
          className="maka-chat-message-bubble maka-chat-message-bubble-user"
          metadata={userMetadata}
        >
          <InlineReferenceText text={props.text} references={props.inlineReferences ?? []} />
        </ChatMessageBubble>
      ) : (
        userMetadata
      )}
    </>
  );
});

export function TransientUserMessage(props: {
  message: TransientUserMessageProjection;
  status?: ReactNode;
}) {
  const copy = getConversationCopy(useUiLocale()).messages;
  const message = props.message;
  return (
    <div data-transient-message-id={message.id}>
      <LocalizedChatMessage
        accessibleLabel={copy.userAriaLabel}
        sender="user"
        className="maka-chat-message maka-user-message"
      >
        <UserMessageBody
          messageId={message.id}
          text={message.text}
          ts={message.ts}
          attachments={message.attachments}
          quotes={message.quotes}
          directoryReferences={message.directoryReferences}
          inlineReferences={message.inlineReferences}
          status={props.status}
          delivery={message}
        />
      </LocalizedChatMessage>
    </div>
  );
}


function accessibleTextExcerpt(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 48 ? `${normalized.slice(0, 47)}…` : normalized;
}

function accessibleActionContext(text: string, ts: number | undefined, locale: UiLocale): string {
  return [
    accessibleTextExcerpt(text),
    ts === undefined ? undefined : formatAbsoluteTimestamp(ts, locale),
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
}

/**
 * The transcript's one copy button: IconButton + clipboard feedback, shared by
 * the user-message copy and the turn footer's answer copy so the icon swap,
 * tooltip phases and loading state stay identical everywhere.
 */
function CopyButton(props: {
  /** Feedback namespace — 'message' and 'answer' track their phases apart. */
  copyKey: string;
  text: string;
  /** Resting tooltip; the phase labels take over while feedback shows. */
  label: string;
  /** Resolved accessible name (caller adds the message/answer context). */
  ariaLabel: string;
  disabled?: boolean;
  dataAction?: string;
  dataMessageId?: string;
}) {
  const copyText = getConversationCopy(useUiLocale()).messages;
  const copyFeedback = useClipboardCopyFeedback(1400, { redact: false });
  const copyPhase = copyFeedback.phaseFor(props.copyKey);
  const tooltip = copyPhase === 'pending'
    ? `${copyText.copying}…`
    : copyPhase === 'copied'
      ? copyText.copied
      : copyPhase === 'failed'
        ? copyText.copyFailed
        : props.label;
  return (
    <UiIconButton
      label={props.ariaLabel}
      tooltip={tooltip}
      icon={<Icon icon={copyPhase === 'copied' ? 'check' : 'copy'} size="sm" />}
      variant="ghost"
      size="sm"
      className={markerVariants({ variant: 'footer-action' })}
      isDisabled={props.disabled}
      isLoading={copyPhase === 'pending'}
      data-action={props.dataAction}
      data-message-id={props.dataMessageId}
      data-copy-feedback={copyPhase ?? undefined}
      onClick={() => void copyFeedback.copy(props.copyKey, props.text)}
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
  /** Optional identity repeated beside each prompt and answer in this turn. */
  messageHeader?: ReactNode;
  /** Optional accessible action on each message edge. */
  messageRail?: ReactNode;
  /** Host-owned status of the root prompt, displayed before its timestamp. */
  promptStatus?: ReactNode;
  transientMessages?: readonly TransientUserMessageProjection[];
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
   * How loud the failed-turn banner should be. Caller computes it from the
   * error class; `warning` marks the outcomes the session can simply continue
   * past. Defaults to `error` when a caller doesn't derive it.
   */
  failedSeverity?: 'error' | 'warning';
  /**
   * What the turn already did before it failed, when that changes the cost of
   * sending the next message (a tool that ran may have had side effects). This
   * accompanies `failedReasonLabel` rather than competing with it: the reason
   * is the outcome, this is the execution state, and both can be true.
   */
  failedExecutionStateLabel?: string;
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
   * While live the footer shows activity in the same slot as completed
   * actions, without exposing actions against a still-streaming answer.
   */
  /** Whether current Host observation permits activity cues; content stays intact. */
  activityObserved?: boolean;
  liveStreaming?: {
    onStreamingSettled?: (messageId?: string) => void;
    /**
     * Whether to show activity for the live turn. The turn's status row owns
     * it — as the process disclosure's summary when a work log exists, or a
     * standalone row at the top of the answer. False while waiting for user
     * input, whose prompt owns the next action.
     */
    runningStatus?: boolean;
    providerRetry?: LiveProviderRetry;
    initialLiveContent?: ReadonlyMap<string, string>;
  };
  /**
   * Open a linked subagent child session in the main chat column. Threaded into
   * linked subagent tool rows; omitted when the host has no navigation.
   */
  onOpenLinkedSession?(sessionId: string): void;
}) {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).messages;
  const { turn } = props;
  // Derive disclosure entries and reply identity together, only when this
  // turn's timeline changes. Rendering and copy share the original reply item.
  const folded = useMemo(() => foldTimeline(turn.timeline), [turn.timeline]);
  // The live turn's timeline moves on every event; the fold re-runs but its
  // entries are reconciled back to the previous objects, so the entry-level
  // memo boundaries below see only what actually moved.
  const foldedEntriesRef = useRef(folded.entries);
  if (foldedEntriesRef.current !== folded.entries) {
    foldedEntriesRef.current = reconcileFoldedEntries(foldedEntriesRef.current, folded.entries);
  }
  const foldedTimeline = foldedEntriesRef.current;
  const finalReply = folded.finalReply;
  const forwardBadges = props.lineageBadges?.filter((b) => b.direction === 'forward') ?? [];
  const reverseBadges = props.lineageBadges?.filter((b) => b.direction === 'reverse') ?? [];
  const answerContext = accessibleActionContext(
    turn.user?.text ?? finalReply?.text ?? '',
    turn.startedAt,
    locale,
  );
  // A recorded conversational terminal turn owns presentation beyond its
  // timeline: failure/abort state and recovery actions must remain visible even
  // when the provider produced no assistant event. Inferred legacy turns and
  // internal operations do not carry enough evidence for a recovery action.
  const showAssistantMessage =
    turn.timeline.length > 0 ||
    !!props.liveStreaming ||
    (turn.user !== undefined && turn.statusSource === 'recorded' && turn.status !== 'running');
  const runningToolLabel = computerRunningLabel(turn.tools, locale);
  const conversationSegments = useMemo(
    () => splitTimelineAtUserMessages(foldedTimeline, showAssistantMessage),
    [foldedTimeline, showAssistantMessage],
  );
  return (
    <section
      className="maka-turn"
      data-maka-contract="markdown-flow"
      data-turn-id={turn.turnId}
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
      {props.transientMessages?.map((message) => (
        <TransientUserMessage key={message.id} message={message} />
      ))}
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
          {props.messageRail}
          {props.messageHeader}
          <UserMessageBody
            status={props.promptStatus}
            messageId={turn.user.id}
            text={turn.user.text}
            ts={turn.user.ts}
            attachments={turn.user.attachments}
            quotes={turn.user.quotes}
            directoryReferences={turn.user.directoryReferences}
            inlineReferences={turn.user.inlineReferences}
            onEditUserMessage={
              props.onEditUserMessage && !turn.user.hostOrigin
                ? () => props.onEditUserMessage?.(turn.turnId)
                : undefined
            }
            // A revision restages neither attachments, directory references,
            // nor quotes, so a turn carrying any of them can't be edited
            // without silently dropping context the answer was grounded in.
            editDisabled={
              (turn.user.attachments?.length ?? 0) > 0 ||
              (turn.user.directoryReferences?.length ?? 0) > 0 ||
              (turn.user.quotes?.length ?? 0) > 0 ||
              props.editUserMessageTransformed === true ||
              props.editUserMessageDisabled === true ||
              turn.status === 'running' ||
              !!props.liveStreaming
            }
            editDisabledReason={
              (turn.user.attachments?.length ?? 0) > 0
                ? copy.editMessageDisabledAttachments
                : (turn.user.directoryReferences?.length ?? 0) > 0
                  ? copy.editMessageDisabledDirectoryReferences
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
          variant={note.compactionState === "running" || note.compactionState === "compacted" ? "divider" : "default"}
          data-compaction-state={note.compactionState === 'running' && props.activityObserved === false ? 'unavailable' : note.compactionState}
          aria-label={note.compactionState === 'running' && props.activityObserved === false ? copy.systemNotes.contextCompactionUnobserved : note.compactionState === "running" ? note.text : copy.systemAriaLabel}
        >
          {note.compactionState ? (
            <span className="maka-compaction-status">
              {note.compactionState === "running" && props.activityObserved !== false && <Spinner size="sm" shade="subtle" aria-hidden="true" />}
              <span>{note.compactionState === 'running' && props.activityObserved === false ? copy.systemNotes.contextCompactionUnobserved : note.text}</span>
              {note.compactionState === "running" && props.activityObserved !== false && <TurnElapsedTime startedAt={turn.startedAt} />}
            </span>
          ) : note.text}
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
              {props.messageRail}
              {props.messageHeader}
              <UserMessageBody
                messageId={message.id}
                text={message.text}
                ts={message.ts}
                attachments={message.attachments}
                quotes={message.quotes}
                directoryReferences={message.directoryReferences}
                inlineReferences={message.inlineReferences}
              />
            </LocalizedChatMessage>
          );
        }
        const ownsTurnChrome = segmentIndex === conversationSegments.length - 1;
        const activityProcessIndex = ownsTurnChrome
          ? segment.items.findLastIndex((item) => item.kind === 'processing')
          : -1;
        // The turn's one status row: on a turn with a work log it is the last
        // disclosure's summary (opening it reveals the process underneath);
        // without one it stands alone at the top of the answer. Either way the
        // row never moves — the running cue becomes the outcome in place.
        const statusBarStatus = props.liveStreaming ? 'running' : turn.status;
        // A recorded 'running' turn with no live stream is a stale leftover
        // (the app died mid-turn): claiming progress would be a lie, so the
        // row is skipped entirely — same as the state showing nothing before.
        const hasLiveStatus = statusBarStatus !== 'running' || !!props.liveStreaming;
        const statusRowProps = {
          status: statusBarStatus,
          running: props.liveStreaming?.runningStatus === true,
          providerRetry: props.liveStreaming?.providerRetry,
          startedAt: turn.startedAt > MIN_PLAUSIBLE_TURN_TS ? turn.startedAt : undefined,
          durationMs: turn.durationMs,
          activityLabel:
            props.liveStreaming?.runningStatus && !props.liveStreaming.providerRetry
              ? runningToolLabel
              : undefined,
        };
        const footerActions = props.liveStreaming ? [] : props.footerActions ?? [];
        const footerMeta = turnMetaSummary(turn);
        const finishedAt =
          turn.status !== 'running' &&
          turn.durationMs !== undefined &&
          turn.startedAt > MIN_PLAUSIBLE_TURN_TS
            ? turn.startedAt + turn.durationMs
            : undefined;
        // Disjoint namespaces: a steering id is any string, so a bare
        // sentinel could collide with a real one.
        const assistantKey =
          segment.repliesTo === undefined
            ? 'assistant-opening'
            : `assistant-after-${segment.repliesTo}`;
        return (
          <Fragment key={assistantKey}>
            <LocalizedChatMessage
              accessibleLabel={`${copy.assistantAriaLabel} · ${answerContext}`}
              sender="assistant"
              className="maka-chat-message maka-assistant-answer"
            >
            <div className="maka-assistant-answer-content">
              {props.messageRail}
              {props.messageHeader}
              {/* The turn timeline is the rendering source of truth
                (materialize.ts): each step's 深度思考 disclosure, answer bubble,
                and Astryx tool group in the order the model produced them.
                Intermediate text, reasoning and tools share a disclosure;
                the final reply and inserted user instructions stay outside. */}
              {ownsTurnChrome && activityProcessIndex === -1 && hasLiveStatus && (
                <TurnStatusBar {...statusRowProps} />
              )}
              {segment.items.map((item, index) =>
                item.kind === 'processing' ? (
                  <ProcessingBlock
                    key={`processing-${item.id}`}
                    activityObserved={props.activityObserved}
                    entries={item.children}
                    running={!!props.liveStreaming}
                    statusRow={
                      index === activityProcessIndex && hasLiveStatus
                        ? statusRowProps
                        : undefined
                    }
                    onStreamingSettled={props.liveStreaming?.onStreamingSettled}
                    onOpenLinkedSession={props.onOpenLinkedSession}
                    initialLiveContent={props.liveStreaming?.initialLiveContent}
                  />
                ) : (
                  <TurnTimelineEntry
                    key={timelineEntryKey(item, index)}
                    activityObserved={props.activityObserved}
                    item={item}
                    onStreamingSettled={props.liveStreaming?.onStreamingSettled}
                    onOpenLinkedSession={props.onOpenLinkedSession}
                    initialLiveContent={props.liveStreaming?.initialLiveContent}
                  />
                ),
              )}
              {ownsTurnChrome && props.liveStreaming?.providerRetry && (
                <ModelProviderRetryIndicator retry={props.liveStreaming.providerRetry} />
              )}
              {/* A failed turn's banner states the OUTCOME of the turn, so it
                  belongs after the work it is the outcome of. `description`
                  carries the parked-resume diagnostic when there
                  is one — it explains why the button did nothing, which
                  outranks execution state on the one turn that can have both. */}
              {ownsTurnChrome && turn.status === 'failed' && props.failedReasonLabel && (
                <Banner
                  status={props.failedSeverity ?? 'error'}
                  container="section"
                  className="maka-turn-failed-banner"
                  title={props.failedReasonLabel}
                  description={
                    <>
                      {props.safeResumeAction?.detail ?? props.failedExecutionStateLabel}
                      {!turn.failureMessage && <span className="maka-turn-failure-unavailable">{copy.failureDetailsUnavailable}</span>}
                    </>
                  }
                  {...(props.safeResumeAction
                    ? {
                        endContent: (
                          <UiButton
                            variant="ghost"
                            size="sm"
                            isDisabled={props.safeResumeAction.pending}
                            onClick={props.safeResumeAction.onResume}
                            label={
                              props.safeResumeAction.pending
                                ? copy.safeResumePending
                                : copy.safeResume
                            }
                          />
                        ),
                      }
                    : {})}
                >
                  {turn.failureMessage && (
                    <pre className="maka-turn-failure-detail">{turn.failureMessage}</pre>
                  )}
                </Banner>
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
            {ownsTurnChrome && (
              <TurnFooter
                turnId={turn.turnId}
                actions={footerActions}
                meta={footerMeta}
                finishedAt={finishedAt}
                live={!!props.liveStreaming}
                context={answerContext}
                onAction={
                  props.onFooterAction
                    ? (actionId) => props.onFooterAction?.(turn.turnId, actionId)
                    : undefined
                }
                assistantText={finalReply?.text ?? ''}
              />
            )}
            </LocalizedChatMessage>
          </Fragment>
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
       * change as the turn runs (a tools-only sequence disappears when its
       * tools are projected away) and a changing key remounts the whole
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
  id: 'branch' | 'copy';
  label: string;
  enabled: boolean;
  tooltip?: string;
  /** Busy from click until the action settles — renders the spinner. */
  pending?: boolean;
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
  failedSeverities: Record<string, 'error' | 'warning'>;
  failedExecutionStateLabels: Record<string, string>;
  lineageBadgesByTurn: Record<string, TurnLineageBadge[]>;
  /** The turn a safe resume would restart, when the shell offers one. */
  resumeCandidateTurnId?: string;
}

export type TurnPresentationDeriver = (turns: readonly TurnViewModel[]) => TurnPresentation;

/**
 * Below this, a `startedAt` is a placeholder rather than a time (the projection
 * yields 0 for a turn whose messages carried no timestamp). 2001-09-09 in millis:
 * comfortably after every real timestamp, comfortably before any clock a
 * transcript could predate.
 */
const MIN_PLAUSIBLE_TURN_TS = 1_000_000_000_000;

/**
 * The turn's one status: the running cue while work is in flight, the settled
 * outcome (word + duration) once the turn ends. Rendered inside the status row
 * — as a process disclosure's summary when the turn has a work log, as a
 * standalone row at the top of the answer otherwise — and nowhere else.
 */
export interface TurnStatusRowProps {
  status: TurnViewModel['status'];
  startedAt?: number;
  durationMs?: number;
  /** Work is actually arriving. Only consulted for the running arm. */
  running?: boolean;
  /** A scheduled/running provider retry replaces the working cue. */
  providerRetry?: LiveProviderRetry;
  /** A concrete activity (e.g. driving an app) outranks the playful phrase. */
  activityLabel?: string;
}

function TurnStatusRow(props: TurnStatusRowProps): ReactNode {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).messages;

  if (props.status === 'running') {
    const retry = props.providerRetry?.event;
    if (retry) {
      // The banner below the row owns the countdown and the reason; the row
      // states the wait without a per-second tick.
      return (
        <span className="maka-turn-statusbar-text">
          {retry.phase === 'scheduled'
            ? copy.providerRetryWaiting(retry.attempt, retry.maxAttempts)
            : copy.providerRetryStarted(retry.attempt, retry.maxAttempts)}
        </span>
      );
    }
    // Live but nothing arriving (a prompt owns the next action): an honest
    // in-progress label, not a clock billing time the turn is not burning.
    if (props.running === false) {
      return <span className="maka-turn-statusbar-text">{copy.processing}</span>;
    }
    return <TurnRunningStatus startedAt={props.startedAt} activityLabel={props.activityLabel} />;
  }

  // Localized duration, not the compact `3m 33s` the live counter uses: this
  // reads as prose in the transcript, and a Chinese UI must not show English units.
  const elapsed = props.durationMs === undefined
    ? undefined
    : copy.processDuration(
        Math.floor(props.durationMs / 60_000),
        Math.floor(props.durationMs / 1_000) % 60,
      );
  const label =
    props.status === 'completed'
      ? copy.turnStatusCompleted(elapsed)
      : props.status === 'aborted'
        ? copy.turnStatusAborted(elapsed)
        : copy.turnStatusFailed(elapsed);
  return <span className="maka-turn-statusbar-text">{label}</span>;
}

/** Standalone status row for a turn with no process disclosure to carry it —
 *  and for the pre-turn cue before the transcript contains the turn. */
export function TurnStatusBar(props: TurnStatusRowProps) {
  return (
    <div className="maka-turn-statusbar" data-turn-status={props.status}>
      <TurnStatusRow {...props} />
    </div>
  );
}

function TurnFooter(props: {
  turnId?: string;
  actions: ReadonlyArray<TurnFooterActionMeta>;
  /** Model · cost facts, before the actions. */
  meta?: string;
  /** Wall-clock finish time, rendered as a semantic Timestamp. */
  finishedAt?: number;
  live?: boolean;
  context: string;
  onAction?: (actionId: TurnFooterActionMeta['id']) => void;
  /** Assistant text used by the inline copy action. */
  assistantText?: string;
}) {
  const copy = getConversationCopy(useUiLocale()).messages;
  const hasSlotContent = useMakaClientSlotOccupied('conversation.turn.footer');
  const hasFooterContent =
    props.meta !== undefined || props.actions.length > 0 || hasSlotContent;
  const isToolbar = !props.live && (props.actions.length > 0 || hasSlotContent);
  return (
    <ChatMessageMetadata
      className={markerVariants({ variant: 'footer' })}
      role={isToolbar ? 'toolbar' : undefined}
      aria-label={isToolbar ? copy.answerActionsAriaLabel(props.context) : undefined}
      timestamp={
        props.finishedAt !== undefined
          ? <Timestamp value={props.finishedAt} format="auto" isLive />
          : undefined
      }
      footer={
        hasFooterContent ? (
        <>
          {props.meta !== undefined ? (
            <span className="maka-turn-footer-meta-model">{props.meta}</span>
          ) : null}
          {props.actions.map((action) =>
            action.id === 'copy' ? (
              <CopyButton
                key="copy"
                copyKey="answer"
                text={props.assistantText ?? ''}
                label={action.tooltip ?? action.label}
                ariaLabel={copy.answerActionAriaLabel(action.label, props.context)}
                disabled={!action.enabled}
                dataAction="copy"
              />
            ) : (
              <UiIconButton
                key={action.id}
                label={copy.answerActionAriaLabel(action.label, props.context)}
                tooltip={action.tooltip ?? action.label}
                icon={STATUS_FOOTER_ICON[action.id]}
                variant="ghost"
                size="sm"
                className={markerVariants({ variant: 'footer-action' })}
                data-action={action.id}
                isDisabled={!action.enabled}
                isLoading={action.pending === true}
                onClick={() => props.onAction?.(action.id)}
              />
            ),
          )}
          {hasSlotContent ? (
            <MakaClientSlotOutlet
              name="conversation.turn.footer"
              owner={{
                turnId: props.turnId,
                live: props.live === true,
                assistantText: props.assistantText,
              }}
            />
          ) : null}
        </>
        ) : undefined
      }
    />
  );
}

/** "model · cost" facts for the footer; the turn's state lives in the status row. */
function turnMetaSummary(turn: TurnViewModel): string | undefined {
  const parts: string[] = [];
  if (turn.modelId) parts.push(turn.modelId);
  if (turn.tokens?.costUsd && turn.tokens.costUsd > 0) parts.push(`$${turn.tokens.costUsd.toFixed(4)}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

const STATUS_FOOTER_ICON: Record<TurnFooterActionMeta['id'], ReactNode> = {
  branch: <Icon icon={GitBranch} size="sm" />,
  copy: <Icon icon="copy" size="sm" />,
};

const ELAPSED_TICK_MS = 1_000;
const WORKING_PHRASE_INTERVAL_MS = 20_000;

/**
 * One live activity cue, inside the turn's status row. Working phrases
 * express liveness, not stages or completed progress. Concrete activity
 * labels take precedence. Rotation shares the elapsed clock and never
 * changes the accessible status name.
 *
 * `startedAt` is the turn's own first-message timestamp, so the clock measures
 * the wait the user actually experienced — from pressing send, not from
 * whenever the model's first event happened to land. It is absent only on the
 * rare fallback path where streaming beat the user turn into the transcript;
 * the phrase then stands alone.
 */
function TurnRunningStatus(props: {
  startedAt?: number;
  activityLabel?: string;
}) {
  const copy = getConversationCopy(useUiLocale()).messages;
  const rootRef = useRef<HTMLSpanElement>(null);
  const elapsedMs = useTurnElapsedTime(props.startedAt);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const phrase = copy.workingPhrases[
    reducedMotion || !isTimeDrivenMotionEnabled(rootRef.current) ? 0
      : Math.floor((elapsedMs ?? 0) / WORKING_PHRASE_INTERVAL_MS) % copy.workingPhrases.length
  ];

  return (
    <span
      className="maka-turn-processing"
      role="status"
      aria-label={props.activityLabel ?? copy.processing}
      ref={rootRef}
    >
      {/* Name the activity once; the clock must not announce each second. */}
      <span className="maka-turn-indicator-text" aria-hidden="true">
        <span className="maka-turn-status-label">
          {props.activityLabel ?? phrase}
        </span>
        {elapsedMs !== undefined && <>
          <span className="maka-turn-status-separator">·</span>
          <span className="maka-turn-elapsed">{formatTurnDuration(elapsedMs)}</span>
        </>}
      </span>
    </span>
  );
}

function useTurnElapsedTime(startedAt: number | undefined) {
  // Undefined until an effect measures it, which is also what keeps a static
  // render deterministic: the clock is a client-only value, so server markup
  // and the first paint carry the phrase alone.
  const [elapsedMs, setElapsedMs] = useState<number | undefined>(undefined);

  useEffect(() => {
    // Elapsed time is task information, independent of motion preferences.
    // Screenshot fixtures can pin browser time without hiding this information.
    if (startedAt === undefined) {
      setElapsedMs(undefined);
      return;
    }
    setElapsedMs(Math.max(0, Date.now() - startedAt));
    const tick = window.setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - startedAt));
    }, ELAPSED_TICK_MS);
    return () => window.clearInterval(tick);
  }, [startedAt]);

  return elapsedMs;
}

function TurnElapsedTime(props: { startedAt?: number }) {
  const elapsedMs = useTurnElapsedTime(props.startedAt);

  return (
    <span className="maka-turn-elapsed" aria-hidden="true">
      {elapsedMs !== undefined && formatTurnDuration(elapsedMs)}
    </span>
  );
}

export function ModelProviderRetryIndicator(props: { retry: LiveProviderRetry }) {
  const copy = getConversationCopy(useUiLocale()).messages;
  const { event: retry, receivedAtMs } = props.retry;
  const rootRef = useRef<HTMLDivElement>(null);
  // Undefined until an effect measures it, so SSR and first paint render the
  // granted delay untouched; the effect then counts down against the
  // CLIENT-local receipt time (a single clock domain — the event's `ts`
  // belongs to the possibly remote Runtime Host clock), taking its length
  // from the skew-free `remainingMs` duration when the emitter provided one.
  const [nowMs, setNowMs] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (retry.phase !== 'scheduled') return;
    // The initial measurement sits OUTSIDE the motion gate on purpose: under
    // a genuine reduced-motion preference the banner must still show the
    // correct remaining wait at mount — gating it would pin the full delay
    // for the whole wait, the exact #3393 symptom. Only the per-second tick
    // respects the preference (and the frozen-fixture contract).
    setNowMs(Date.now());
    if (!isTimeDrivenMotionEnabled(rootRef.current)) return;
    const tick = window.setInterval(() => setNowMs(Date.now()), ELAPSED_TICK_MS);
    return () => window.clearInterval(tick);
  }, [retry.phase, retry.id, receivedAtMs]);
  const displaySeconds =
    retry.phase !== 'scheduled'
      ? 0
      : // nowMs undefined (SSR / first paint) reads as zero elapsed.
        providerRetryDisplaySeconds(retry, (nowMs ?? receivedAtMs) - receivedAtMs);
  // The banner is a role="status" live region: a title that changes every
  // second would be announced every second — for hours during a quota wait.
  // The ticking text is aria-hidden; the region exposes a stable label that
  // follows the running-turn indicator's pattern (the row's accessible name
  // is the whole status, the moving text is decoration).
  const scheduledA11y = retry.phase === 'scheduled';
  return (
    <Banner
      ref={rootRef}
      status="warning"
      container="section"
      role="status"
      className="maka-turn-provider-retry"
      {...(scheduledA11y
        ? {
            'aria-label': `${copy.providerRetryReason[retry.reason]} · ${copy.providerRetryWaiting(retry.attempt, retry.maxAttempts)}`,
          }
        : {})}
      title={
        scheduledA11y ? (
          <span aria-hidden="true">
            {copy.providerRetryScheduled(displaySeconds, retry.attempt, retry.maxAttempts)}
          </span>
        ) : (
          // The status row already owns the attempt count; the banner carries
          // the diagnostic.
          copy.providerRetryReason[retry.reason]
        )
      }
      description={
        scheduledA11y ? (
          <span aria-hidden="true">{copy.providerRetryReason[retry.reason]}</span>
        ) : undefined
      }
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
  | { text: string; phase: 'historical'; interrupted?: true }
  | {
      text: string;
      phase: 'streaming' | 'settled';
      interrupted?: true;
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
    <>
    {(!props.interrupted || props.text.length > 0) && (
    <ChatMessageBubble
      variant="ghost"
      data-maka-transcript-boundary=""
      data-live-streaming={props.phase === 'streaming' ? 'true' : undefined}
      data-response-interrupted={props.interrupted ? 'true' : undefined}
      // Astryx's own seam for a bubble that spans the message column: it sets
      // the width and drops the default max(80%, 280px) cap in one prop.
      width="100%"
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
    )}
    {props.interrupted && (
      <ChatSystemMessage variant="divider">
        {copy.providerRetryReason.stream_truncated}
      </ChatSystemMessage>
    )}
    </>
  );
});

// Semantic keys (no index) so mid-timeline inserts do not remount/collapse disclosures.
function timelineEntryKey(item: TurnTimelineItem, index: number): string {
  if (item.kind === 'tools') return `tools-${item.items[0]?.toolUseId ?? index}`;
  return `${item.kind}-${item.messageId}`;
}

/** Render one timeline entry: reasoning disclosure / answer bubble / tool group. */
const TurnTimelineEntry = memo(function TurnTimelineEntry(props: {
  activityObserved?: boolean;
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
        live={item.live === true && props.activityObserved !== false}
        settledText={props.initialLiveContent?.get(`thinking:${item.messageId}`)}
        truncated={item.truncated === true}
      />
    );
  }
  if (item.kind === 'tools') {
    return (
      <ToolTrow
        items={item.items}
        activityObserved={props.activityObserved}
        onOpenLinkedSession={props.onOpenLinkedSession}
      />
    );
  }
  // Same component either way — a type swap here would remount the answer.
  if (item.live !== true) return <AssistantAnswerBubble text={item.text} interrupted={item.interrupted} phase="historical" />;
  return (
    <AssistantAnswerBubble
      text={item.text}
      interrupted={item.interrupted}
      phase={item.complete === true ? 'settled' : 'streaming'}
      settledText={props.initialLiveContent?.get(`text:${item.messageId}`)}
      truncated={item.truncated === true}
      onSettled={() => props.onStreamingSettled?.(item.messageId)}
    />
  );
});

/**
 * The turn's execution process (reasoning, intermediate commentary, tool
 * activity) under one disclosure. Live work stays expanded; a settled turn
 * collapses and the reader's open/closed choice survives appended events.
 *
 * The LAST disclosure in a turn also carries the turn's status row as its
 * summary (`statusRow`), so the turn's state lives in one place whether or
 * not the turn has a work log. Earlier disclosures — and any in a turn that
 * owns no chrome — keep the plain process label.
 */
const ProcessingBlock = memo(function ProcessingBlock(props: {
  activityObserved?: boolean;
  entries: FoldedTimelineChild[];
  running: boolean;
  /** The turn's status row, rendered as this disclosure's summary. */
  statusRow?: TurnStatusRowProps;
  onStreamingSettled?: (messageId?: string) => void;
  onOpenLinkedSession?(sessionId: string): void;
  initialLiveContent?: ReadonlyMap<string, string>;
}) {
  const copy = getConversationCopy(useUiLocale()).messages;
  // null follows the lifecycle: open while running, collapsed on completion.
  // Settled reader choices survive appended events. Live work stays expanded.
  // A failed tool is an ordinary row: no label and no reveal of its own.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = props.running || manualOpen === true;
  return (
    <details
      className="maka-processing-sequence"
      data-maka-transcript-boundary=""
      open={open}
    >
      <summary
        className="maka-processing-summary"
        aria-expanded={open}
        aria-disabled={props.running || undefined}
        tabIndex={props.running ? -1 : 0}
        onClick={(event) => {
          event.preventDefault();
          if (!props.running) setManualOpen(!open);
        }}
      >
        {props.statusRow ? (
          <span className="maka-turn-statusbar" data-turn-status={props.statusRow.status}>
            <TurnStatusRow {...props.statusRow} />
          </span>
        ) : (
          <span>{copy.processDetails}</span>
        )}
        {!props.running && <ChevronRight size={ICON_SIZE.meta} aria-hidden="true" />}
      </summary>
      <div className="maka-processing-body">
        {props.entries.map((entry, index) => (
          <TurnTimelineEntry
            key={timelineEntryKey(entry, index)}
            activityObserved={open && props.activityObserved !== false}
            item={entry}
            onStreamingSettled={props.onStreamingSettled}
            onOpenLinkedSession={props.onOpenLinkedSession}
            initialLiveContent={props.initialLiveContent}
          />
        ))}
      </div>
    </details>
  );
});

function DeepThinking(props: { text: string; live: boolean; settledText?: string; truncated?: boolean }) {
  const copy = getConversationCopy(useUiLocale()).messages;
  const label = props.truncated ? `${copy.thinking} · ${copy.truncated}` : copy.thinking;
  return (
    <ChatReasoning
      className="maka-deep-thinking"
      data-maka-transcript-boundary=""
      label={label}
      previewText={reasoningPreviewText(props.text)}
      isStreaming={props.live}
      title={props.truncated ? copy.thinkingTruncatedTitle : undefined}
    >
      <Markdown
        text={props.text}
        streaming={props.live}
        // A truncated reasoning buffer slides at the head. It is a current
        // snapshot, not an append-only prefix for the reveal cursor to replay.
        settledText={props.truncated ? props.text : props.settledText}
        density="compact"
      />
    </ChatReasoning>
  );
}

function reasoningPreviewText(text: string): string {
  const safeText = redactSecrets(text);
  const firstLine = safeText.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
  return firstLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/\\([()[\]])/g, '')
    .replace(/\$\$/g, '')
    .replace(/[*_~`]+/g, '')
    .trim();
}
