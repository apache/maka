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

/**
 * Backend → UI unified event stream.
 *
 * Runtime backends normalize their provider-native streams to
 * this `SessionEvent` union. The UI never imports SDK types directly.
 *
 * Connection-setup events live in ./connections.ts (separate channel).
 */

import type {
  AdditionalPermissionRequest,
  PermissionMode,
  PermissionRequest,
  PermissionResponse,
  SandboxEscalationRequest,
} from './permission.js';
import type { SandboxBoundaryExpansion, SandboxBoundaryRequestStatus } from './sandbox-boundary.js';
import type { UserQuestionRequest } from './user-question.js';
import type {
  PipeShellOutput,
  PtyShellOutput,
  ShellOutput,
  ShellRunOperation,
  ShellRunStatus,
  ShellRunTerminalStatus,
} from './shell-run.js';
export { SHELL_RUN_SOURCE_TOOL_CALL_ID_MAX_BYTES } from './shell-run.js';
import { type TokenUsageFields } from './usage-record-schema.js';
import { defineObjectShape, hasExactShape, isRecord } from './record-schema.js';

export const TOOL_OUTPUT_STREAMS = ['stdout', 'stderr'] as const;
export const TOOL_OUTPUT_DELTA_MAX_CHARS = 8192;
export const TOOL_ACTIVITY_KINDS = [
  // Driving the user's own machine is not "a tool call". It has its own risk,
  // its own approval classes and its own place in a transcript, and reading it
  // under the same gear icon as everything else hides the one activity a person
  // most wants to pick out at a glance.
  'computer',
  'read',
  'search',
  'websearch',
  'webfetch',
  'edit',
  'command',
  'explore',
  'browser',
  'tool',
] as const;
export type ToolActivityKind = (typeof TOOL_ACTIVITY_KINDS)[number];
type TerminalToolResultStatus = Exclude<ShellRunTerminalStatus, 'orphaned'>;

// ============================================================================
// Storage refs (shared by attachments, image tool results, etc.)
// ============================================================================

export type StorageRef =
  | { kind: 'session_file'; sessionId: string; relativePath: string }
  | { kind: 'workspace_file'; relativePath: string }
  | { kind: 'external_file'; absolutePath: string };

export interface AttachmentRef {
  kind: 'image' | 'pdf' | 'doc' | 'code' | 'other';
  name: string;
  mimeType: string;
  bytes: number;
  ref: StorageRef;
}

/**
 * An inline quoted excerpt attached to a user message — e.g. text selected in
 * the transcript and carried into a follow-up. Unlike {@link AttachmentRef}
 * (file-backed), the quoted text lives inline: it renders as a chip on the user
 * bubble (never as raw body text) and is folded into the model-facing content.
 */
export interface QuoteRef {
  text: string;
  /** Optional label shown on the chip (e.g. the source turn's role/preview). */
  label?: string;
  /** Provenance: the transcript turn the excerpt was selected from. */
  sourceTurnId?: string;
}

/**
 * Frozen display metadata for one token embedded in a sent message's visible
 * text. The model-facing authority remains {@link MessageContent.text}; this
 * record only lets clients replay the token the user actually sent without
 * consulting a mutable Skill catalog or guessing file-path boundaries.
 */
export interface InlineReference {
  kind: 'skill' | 'workspace_file';
  /** Exact serialized token value present in `displayText ?? text`. */
  value: string;
  /** Display label captured when the message was accepted. */
  label: string;
  /** UTF-16 offset of this exact occurrence in `displayText ?? text`. */
  start: number;
}

/** Canonical user-authored content shared by storage, runtime, and Host wire. */
export interface MessageContent {
  /**
   * Authoritative model-facing input. This may be a composed envelope when a
   * client injects context such as explicit skill instructions.
   */
  text: string;
  /** Human-facing text when it differs from `text`; omit when equal. */
  displayText?: string;
  /** Ordered attachment references; omit when empty. Attachment bytes never travel here. */
  attachments?: AttachmentRef[];
  /** Ordered inline excerpts; omit when empty. Provenance remains part of content identity. */
  quotes?: QuoteRef[];
  /** Sent inline tokens; an empty array marks a current-format plain message. Never model-visible. */
  inlineReferences?: InlineReference[];
}

const MESSAGE_CONTENT_SHAPE = defineObjectShape<MessageContent>()(
  ['text'],
  ['displayText', 'attachments', 'quotes', 'inlineReferences'],
);
const ATTACHMENT_REF_SHAPE = defineObjectShape<AttachmentRef>()(
  ['kind', 'name', 'mimeType', 'bytes', 'ref'],
  [],
);
const QUOTE_REF_SHAPE = defineObjectShape<QuoteRef>()(['text'], ['label', 'sourceTurnId']);
const INLINE_REFERENCE_SHAPE = defineObjectShape<InlineReference>()(
  ['kind', 'value', 'label', 'start'],
  [],
);
const INLINE_SKILL_REFERENCE_VALUE = /^\/skill:[A-Za-z0-9._-]+$/;
export const INLINE_REFERENCE_MAX_COUNT = 32;
const MAX_INLINE_REFERENCE_VALUE_LENGTH = 4_096;
export const INLINE_REFERENCE_LABEL_MAX_LENGTH = 200;
const SESSION_FILE_REF_SHAPE = defineObjectShape<Extract<StorageRef, { kind: 'session_file' }>>()(
  ['kind', 'sessionId', 'relativePath'],
  [],
);
const WORKSPACE_FILE_REF_SHAPE = defineObjectShape<
  Extract<StorageRef, { kind: 'workspace_file' }>
>()(['kind', 'relativePath'], []);
const EXTERNAL_FILE_REF_SHAPE = defineObjectShape<Extract<StorageRef, { kind: 'external_file' }>>()(
  ['kind', 'absolutePath'],
  [],
);

export function normalizeMessageContent(content: MessageContent): MessageContent {
  return {
    text: content.text,
    ...(content.displayText !== undefined && content.displayText !== content.text
      ? { displayText: content.displayText }
      : {}),
    ...(content.attachments !== undefined && content.attachments.length > 0
      ? {
          attachments: content.attachments.map((attachment) => ({
            ...attachment,
            bytes: Object.is(attachment.bytes, -0) ? 0 : attachment.bytes,
            ref: { ...attachment.ref },
          })),
        }
      : {}),
    ...(content.quotes !== undefined && content.quotes.length > 0
      ? {
          quotes: content.quotes.map((quote) => ({
            text: quote.text,
            ...(quote.label !== undefined ? { label: quote.label } : {}),
            ...(quote.sourceTurnId !== undefined ? { sourceTurnId: quote.sourceTurnId } : {}),
          })),
        }
      : {}),
    ...(content.inlineReferences !== undefined
      ? {
          inlineReferences: content.inlineReferences.map((reference) => ({ ...reference })),
        }
      : {}),
  };
}

export function aggregateMessageContents(contents: readonly MessageContent[]): MessageContent {
  const text = contents.map((content) => content.text).join('\n\n');
  const displayText = contents.map((content) => content.displayText ?? content.text).join('\n\n');
  const attachments = contents.flatMap((content) => content.attachments ?? []);
  const quotes = contents.flatMap((content) => content.quotes ?? []);
  const inlineReferences: InlineReference[] = [];
  const hasInlineReferenceMarker = contents.some(
    (content) => content.inlineReferences !== undefined,
  );
  let displayOffset = 0;
  for (const content of contents) {
    for (const reference of content.inlineReferences ?? []) {
      if (inlineReferences.length === INLINE_REFERENCE_MAX_COUNT) break;
      inlineReferences.push({ ...reference, start: displayOffset + reference.start });
    }
    displayOffset += (content.displayText ?? content.text).length + 2;
  }
  return normalizeMessageContent({
    text,
    ...(displayText !== text ? { displayText } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(quotes.length > 0 ? { quotes } : {}),
    ...(hasInlineReferenceMarker ? { inlineReferences } : {}),
  });
}

export function decodeMessageContent(value: unknown): MessageContent {
  if (!isMessageContent(value)) throw new TypeError('Invalid MessageContent');
  return normalizeMessageContent(value);
}

export function isMessageContent(value: unknown): value is MessageContent {
  return (
    isRecord(value) &&
    hasExactShape(value, MESSAGE_CONTENT_SHAPE) &&
    typeof value.text === 'string' &&
    (value.displayText === undefined || typeof value.displayText === 'string') &&
    (value.attachments === undefined ||
      (Array.isArray(value.attachments) && value.attachments.every(isAttachmentRef))) &&
    (value.quotes === undefined ||
      (Array.isArray(value.quotes) && value.quotes.every(isQuoteRef))) &&
    (value.inlineReferences === undefined ||
      (Array.isArray(value.inlineReferences) &&
        value.inlineReferences.length <= INLINE_REFERENCE_MAX_COUNT &&
        value.inlineReferences.every(isInlineReference) &&
        inlineReferencesMatchText(value.inlineReferences, value.displayText ?? value.text)))
  );
}

function inlineReferencesMatchText(references: readonly InlineReference[], text: string): boolean {
  let previousEnd = 0;
  for (const reference of references) {
    if (
      reference.start < previousEnd ||
      text.slice(reference.start, reference.start + reference.value.length) !== reference.value
    ) {
      return false;
    }
    previousEnd = reference.start + reference.value.length;
  }
  return true;
}

export function isInlineReference(value: unknown): value is InlineReference {
  return (
    isRecord(value) &&
    hasExactShape(value, INLINE_REFERENCE_SHAPE) &&
    (value.kind === 'skill' || value.kind === 'workspace_file') &&
    typeof value.value === 'string' &&
    value.value.length > 0 &&
    value.value.length <= MAX_INLINE_REFERENCE_VALUE_LENGTH &&
    typeof value.label === 'string' &&
    value.label.length > 0 &&
    value.label.length <= INLINE_REFERENCE_LABEL_MAX_LENGTH &&
    typeof value.start === 'number' &&
    Number.isSafeInteger(value.start) &&
    value.start >= 0 &&
    (value.kind === 'skill'
      ? INLINE_SKILL_REFERENCE_VALUE.test(value.value)
      : value.value.startsWith('@') &&
        isCanonicalStorageRef({
          kind: 'workspace_file',
          relativePath: value.value.slice(1),
        }))
  );
}

export function isQuoteRef(value: unknown): value is QuoteRef {
  return (
    isRecord(value) &&
    hasExactShape(value, QUOTE_REF_SHAPE) &&
    typeof value.text === 'string' &&
    (value.label === undefined || typeof value.label === 'string') &&
    (value.sourceTurnId === undefined || typeof value.sourceTurnId === 'string')
  );
}

export function isAttachmentRef(value: unknown): value is AttachmentRef {
  return (
    isRecord(value) &&
    hasExactShape(value, ATTACHMENT_REF_SHAPE) &&
    (value.kind === 'image' ||
      value.kind === 'pdf' ||
      value.kind === 'doc' ||
      value.kind === 'code' ||
      value.kind === 'other') &&
    typeof value.name === 'string' &&
    typeof value.mimeType === 'string' &&
    typeof value.bytes === 'number' &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    isStorageRef(value.ref)
  );
}

/** A structurally valid attachment whose metadata and locator are canonical at durable boundaries. */
export function isCanonicalAttachmentRef(value: unknown): value is AttachmentRef {
  return (
    isAttachmentRef(value) &&
    value.name.length > 0 &&
    value.mimeType.length > 0 &&
    isCanonicalStorageRef(value.ref)
  );
}

export function isStorageRef(value: unknown): value is StorageRef {
  if (!isRecord(value)) return false;
  if (value.kind === 'session_file') {
    return (
      hasExactShape(value, SESSION_FILE_REF_SHAPE) &&
      typeof value.sessionId === 'string' &&
      typeof value.relativePath === 'string'
    );
  }
  if (value.kind === 'workspace_file') {
    return hasExactShape(value, WORKSPACE_FILE_REF_SHAPE) && typeof value.relativePath === 'string';
  }
  return (
    value.kind === 'external_file' &&
    hasExactShape(value, EXTERNAL_FILE_REF_SHAPE) &&
    typeof value.absolutePath === 'string'
  );
}

export function isCanonicalStorageRef(value: unknown): value is StorageRef {
  if (!isStorageRef(value)) return false;
  if (value.kind === 'external_file') return isCanonicalAbsolutePath(value.absolutePath);
  if (value.kind === 'session_file' && !/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId)) {
    return false;
  }
  return isCanonicalRelativePath(value.relativePath);
}

function isCanonicalRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes('\0') &&
    !path.includes('\\') &&
    !path.startsWith('/') &&
    !/^[A-Za-z]:/.test(path) &&
    path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

function isCanonicalAbsolutePath(path: string): boolean {
  if (path.length === 0 || path.includes('\0')) return false;
  if (path.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(path)) return true;
  return /^\\\\[^\\/]+[\\/][^\\/]+/.test(path);
}

export function messageContentsEqual(left: MessageContent, right: MessageContent): boolean {
  const leftDisplayText = left.displayText === left.text ? undefined : left.displayText;
  const rightDisplayText = right.displayText === right.text ? undefined : right.displayText;
  const leftAttachments = left.attachments?.length ? left.attachments : undefined;
  const rightAttachments = right.attachments?.length ? right.attachments : undefined;
  const leftQuotes = left.quotes?.length ? left.quotes : undefined;
  const rightQuotes = right.quotes?.length ? right.quotes : undefined;
  const leftInlineReferences = left.inlineReferences;
  const rightInlineReferences = right.inlineReferences;
  return (
    left.text === right.text &&
    leftDisplayText === rightDisplayText &&
    ((leftAttachments === undefined && rightAttachments === undefined) ||
      (leftAttachments !== undefined &&
        rightAttachments !== undefined &&
        leftAttachments.length === rightAttachments.length &&
        leftAttachments.every((attachment, index) =>
          attachmentRefsEqual(attachment, rightAttachments[index]!),
        ))) &&
    ((leftQuotes === undefined && rightQuotes === undefined) ||
      (leftQuotes !== undefined &&
        rightQuotes !== undefined &&
        leftQuotes.length === rightQuotes.length &&
        leftQuotes.every((quote, index) => quoteRefsEqual(quote, rightQuotes[index]!)))) &&
    ((leftInlineReferences === undefined && rightInlineReferences === undefined) ||
      (leftInlineReferences !== undefined &&
        rightInlineReferences !== undefined &&
        leftInlineReferences.length === rightInlineReferences.length &&
        leftInlineReferences.every((reference, index) =>
          inlineReferencesEqual(reference, rightInlineReferences[index]!),
        )))
  );
}

function inlineReferencesEqual(left: InlineReference, right: InlineReference): boolean {
  return (
    left.kind === right.kind &&
    left.value === right.value &&
    left.label === right.label &&
    left.start === right.start
  );
}

function quoteRefsEqual(left: QuoteRef, right: QuoteRef): boolean {
  return (
    left.text === right.text &&
    left.label === right.label &&
    left.sourceTurnId === right.sourceTurnId
  );
}

function attachmentRefsEqual(left: AttachmentRef, right: AttachmentRef): boolean {
  if (
    left.kind !== right.kind ||
    left.name !== right.name ||
    left.mimeType !== right.mimeType ||
    left.bytes !== right.bytes ||
    left.ref.kind !== right.ref.kind
  ) {
    return false;
  }
  switch (left.ref.kind) {
    case 'session_file':
      return (
        right.ref.kind === 'session_file' &&
        left.ref.sessionId === right.ref.sessionId &&
        left.ref.relativePath === right.ref.relativePath
      );
    case 'workspace_file':
      return (
        right.ref.kind === 'workspace_file' && left.ref.relativePath === right.ref.relativePath
      );
    case 'external_file':
      return right.ref.kind === 'external_file' && left.ref.absolutePath === right.ref.absolutePath;
  }
}

// ============================================================================
// Event union
// ============================================================================

interface BaseEvent {
  /** Event uuid — used for dedup on reconnect/replay. */
  id: string;
  /** Groups all events from one agent turn. */
  turnId: string;
  /** Unix ms timestamp. */
  ts: number;
}

interface ToolActivityIdentity {
  /** Execution surface that produced this tool activity. */
  origin?: 'provider' | 'code_mode';
  /** Provider-history projection policy for this activity. */
  modelVisibility?: 'visible' | 'hidden';
  /** Enclosing exec provider call, for nested CodeMode activity. */
  parentToolCallId?: string;
  /** Enclosing exec durable operation, for nested CodeMode activity. */
  parentOperationId?: string;
}

export type SessionEvent =
  | TextDeltaEvent
  | TextCompleteEvent
  | ThinkingDeltaEvent
  | ThinkingCompleteEvent
  | ToolStartEvent
  | ToolOutputDeltaEvent
  | ToolProgressEvent
  | ToolResultPreviewEvent
  | ToolResultEvent
  | AnyPermissionRequestEvent
  | SandboxBoundaryRequestEvent
  | SandboxBoundaryDecisionAckEvent
  | PermissionAnswerAckEvent
  | PermissionClosureAckEvent
  | PermissionDecisionAckEvent
  | UserQuestionRequestEvent
  | UserQuestionAnswerAckEvent
  | PlanSubmittedEvent
  | TokenUsageEvent
  | SteeringMessageEvent
  | QueueUpdateEvent
  | ProviderRetryEvent
  | ErrorEvent
  | CompleteEvent
  | AbortEvent;

export interface TextDeltaEvent extends BaseEvent {
  type: 'text_delta';
  messageId: string;
  /** Absolute UTF-16 offset for replay-safe streams; absent for append-only backends. */
  startOffset?: number;
  text: string;
}

export interface TextCompleteEvent extends BaseEvent {
  type: 'text_complete';
  messageId: string;
  text: string;
  /** Provider-owned text metadata such as Responses URL citations. */
  providerOptions?: Record<string, unknown>;
}

export interface ThinkingDeltaEvent extends BaseEvent {
  type: 'thinking_delta';
  messageId: string;
  /** Absolute UTF-16 offset for replay-safe streams; absent for append-only backends. */
  startOffset?: number;
  text: string;
}

export interface ThinkingCompleteEvent extends BaseEvent {
  type: 'thinking_complete';
  messageId: string;
  text: string;
  /** Anthropic signed thinking — MUST be re-sent on replay. */
  signature?: string;
  /** Provider-owned replay metadata that must survive backend recreation. */
  providerOptions?: Record<string, unknown>;
}

export interface ToolStartEvent extends BaseEvent, ToolActivityIdentity {
  type: 'tool_start';
  toolUseId: string;
  toolName: string;
  /** Runtime-owned durable tool-operation identity (Phase 2). */
  operationId?: string;
  /** Stable semantic category for presentation; absent on legacy events. */
  activityKind?: ToolActivityKind;
  args: unknown;
  /** Provider-owned opaque call metadata that must survive model replay. */
  providerOptions?: Record<string, unknown>;
  /** True when the provider executed the tool inside the model request. */
  providerExecuted?: boolean;
  displayName?: string;
  intent?: string;
  /**
   * Id of the assistant step this tool call belongs to (equals the step's
   * AssistantMessage id / the step's text+thinking messageId). Lets model
   * replay group a step's reasoning + text + tool calls into one provider
   * assistant message. Absent on legacy events; consumers treat a missing
   * stepId as un-pairable (degraded, per-turn) history.
   */
  stepId?: string;
}

export type ToolOutputStream = (typeof TOOL_OUTPUT_STREAMS)[number];

/**
 * Live output side-channel for long-running tools.
 *
 * This is intentionally separate from ToolResultEvent: deltas are transient UI
 * updates, while tool_result remains the terminal persisted result. `seq` is
 * monotonic per toolCallId/toolUseId so renderers can de-dupe and repair
 * event/result races without relying on arrival order.
 */
export interface ToolOutputDeltaEvent extends BaseEvent, ToolActivityIdentity {
  type: 'tool_output_delta';
  sessionId: string;
  toolCallId: string;
  /** Existing UI/runtime name for the same identifier. */
  toolUseId: string;
  seq: number;
  stream: ToolOutputStream;
  chunk: string;
  redacted: boolean;
  createdAt: number;
}

export interface ToolProgressEvent extends BaseEvent, ToolActivityIdentity {
  type: 'tool_progress';
  toolUseId: string;
  chunk: string | { kind: 'stdout' | 'stderr'; text: string };
}

/**
 * Live-only open-facts for a tool that is still running (e.g. agent_spawn child ready).
 * Not a durable transcript commit and not model-visible function_response.
 * Terminal outcome remains a later tool_result.
 */
export type ToolResultPreviewContent = {
  kind: 'subagent';
  /** Required: the sole purpose of this preview is mid-flight Open. */
  childSessionId: string;
  agentId?: string;
  agentName: string;
  turnId: string;
  runId?: string;
  status: 'running';
  permissionMode: PermissionMode;
};

export interface ToolResultPreviewEvent extends BaseEvent, ToolActivityIdentity {
  type: 'tool_result_preview';
  toolUseId: string;
  isError: boolean;
  content: ToolResultPreviewContent;
}

export interface ToolResultEvent extends BaseEvent, ToolActivityIdentity {
  type: 'tool_result';
  toolUseId: string;
  /** Runtime-owned durable tool-operation identity (Phase 2). */
  operationId?: string;
  /** True when the provider executed the tool inside the model request. */
  providerExecuted?: boolean;
  /** Raw provider result retained for provider-native replay; never rendered directly. */
  providerOutput?: unknown;
  isError: boolean;
  content: ToolResultContent;
  durationMs?: number;
}

type ShellRunResultMetadata = {
  kind: 'shell_run';
  ref: string;
  status: ShellRunStatus;
  cwd: string;
  cmd: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  exitCode?: number;
  failureMessage?: string;
  revision: number;
  timeoutMs?: number;
  sandboxDenial?: SandboxDenialSignal | SandboxDenialRecovery;
};

export interface SandboxDenialSignal {
  likely: true;
  backend?: 'macos-seatbelt' | 'linux' | 'windows';
}

export interface SandboxDenialRecovery extends SandboxDenialSignal {
  recovery: 'require_escalated';
}

export interface SandboxBoundaryFailureSignal {
  reason: 'sandbox_boundary_required' | 'requires_bypass';
  requiredExpansion?: SandboxBoundaryExpansion;
}

export interface ToolUncertainOutcomeSignal {
  code: 'outcome_unknown';
  retrySafe: false;
}

export class ToolOutcomeUnknownError extends Error {
  readonly code = 'outcome_unknown';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ToolOutcomeUnknownError';
  }
}

export type ShellRunCompactResult = ShellRunResultMetadata &
  ({ mode: 'pipes'; output?: never } | { mode: 'pty'; output?: never });

export type ShellRunSnapshotResult = ShellRunResultMetadata &
  ({ mode: 'pipes'; output: PipeShellOutput } | { mode: 'pty'; output: PtyShellOutput });

export type ShellRunStateResult = ShellRunCompactResult | ShellRunSnapshotResult;

type ShellRunStopOperation = Extract<ShellRunOperation, { kind: 'stop' }>;
type ShellRunPtyControlOperation = Extract<ShellRunOperation, { kind: 'pty_control' }>;
type ShellRunToolResultContent =
  | (ShellRunCompactResult & { operation?: never })
  | (ShellRunSnapshotResult &
      (
        | { operation?: never }
        | { operation: ShellRunStopOperation }
        | { mode: 'pty'; output: PtyShellOutput; operation: ShellRunPtyControlOperation }
      ));

export type ToolResultContent =
  | {
      kind: 'text';
      text: string;
      sandboxDenial?: SandboxDenialSignal;
      sandboxFailure?: SandboxBoundaryFailureSignal;
      uncertainOutcome?: ToolUncertainOutcomeSignal;
    }
  | { kind: 'json'; value: unknown }
  | { kind: 'file_diff'; paths: string[]; diff: string }
  | { kind: 'file_write'; path: string; bytes: number }
  | {
      kind: 'archived_tool_result';
      status: 'not_loaded' | 'missing' | 'corrupt';
      runtimeEventId: string;
      toolCallId: string;
      toolName: string;
      artifactId?: string;
      bodySha256?: string;
      originalEstimatedTokens: number;
      originalBytes: number;
      rewriteVersion: number;
      reason: 'stale_tool_result_pruned_before_compact';
    }
  | {
      kind: 'terminal';
      cwd: string;
      cmd: string;
      status: TerminalToolResultStatus;
      exitCode?: number;
      failureMessage?: string;
      output: ShellOutput;
      sandboxDenial?: SandboxDenialSignal | SandboxDenialRecovery;
    }
  | ShellRunToolResultContent
  | { kind: 'image'; mimeType: string; ref: StorageRef }
  | { kind: 'summary'; original: string; summarized: string; reason: 'too_large' }
  /**
   * PR-CHAT-WEB-SEARCH-RENDER-0: structured tool-result for the gated
   * WebSearch agent tool. The chat renderer surfaces these as plain
   * text cards (title + url + snippet + source); never markdown, never
   * HTML, matching the Settings → 联网搜索 live-query verification surface.
   *
   * Rows are an opaque `unknown[]` here so the storage layer does not
   * need to import the `@maka/core/web-search` row type; the renderer
   * narrows each row at render time.
   */
  | {
      kind: 'web_search';
      provider: string;
      query: string;
      rows: ReadonlyArray<{
        title: string;
        url: string;
        snippet: string;
        source: string;
      }>;
    }
  | {
      kind: 'web_search_error';
      ok: false;
      provider: string;
      query?: string;
      reason: string;
      message: string;
      credentialSource?: string;
    }
  | {
      kind: 'explore_agent';
      ok: boolean;
      partial?: boolean;
      terminalStatus?: 'completed' | 'completed_empty' | 'failed' | 'canceled' | 'canceled_partial';
      mode: 'read_only';
      objective: string;
      roots: string[];
      queries: string[];
      ignoredPaths?: string[];
      stoppingCondition?: string;
      limitReasons?: ReadonlyArray<
        'candidate_budget' | 'file_budget' | 'match_budget' | 'byte_budget'
      >;
      filesDiscovered?: number;
      filesInspected: number;
      filesSkipped: number;
      sensitiveFilesSkipped?: number;
      bytesRead: number;
      startedAt?: number;
      completedAt?: number;
      durationMs?: number;
      progress: string[];
      recentEvents?: ReadonlyArray<{ type: string; at: number; message: string }>;
      evidence?: ReadonlyArray<{
        type: 'match' | 'candidate';
        path: string;
        line?: number;
        label: string;
        score?: number;
      }>;
      summary?: string;
      report?: string;
      candidateFiles: ReadonlyArray<{ path: string; score: number; reasons: string[] }>;
      matches: ReadonlyArray<{ path: string; line: number; query: string; snippet: string }>;
      notes: string[];
      reason?: 'invalid_objective' | 'invalid_root' | 'no_readable_roots' | 'aborted';
      message?: string;
    }
  | {
      kind: 'subagent';
      childSessionId?: string;
      agentId?: string;
      agentName: string;
      turnId: string;
      runId?: string;
      status: 'completed' | 'failed' | 'cancelled' | 'running' | 'waiting_for_user';
      permissionMode: PermissionMode;
      summary: string;
      artifactIds: readonly string[];
      startedAt?: number;
      completedAt?: number;
      durationMs?: number;
      eventCount?: number;
      failureClass?: string;
    }
  | {
      kind: 'agent_swarm';
      status: 'completed' | 'partial' | 'failed' | 'cancelled';
      items: ReadonlyArray<{
        itemId: string;
        index: number;
        profile: string;
        started: boolean;
        childSessionId?: string;
        agentId?: string;
        agentName?: string;
        turnId?: string;
        runId?: string;
        resumedFromRunId?: string;
        status: 'completed' | 'failed' | 'cancelled';
        summary: string;
        artifactIds: readonly string[];
        startedAt?: number;
        completedAt?: number;
        durationMs?: number;
        failureClass?: string;
      }>;
      startedAt: number;
      completedAt: number;
      durationMs: number;
    }
  | {
      kind: 'rive_workflow';
      ok: boolean;
      action: string;
      command: string[];
      state?: string;
      ids: {
        workflowRunId?: string;
        schedulerRunId?: string;
        rootWorkNodeId?: string;
      };
      summary: string;
      projection?: {
        templateId?: string;
        version?: number;
        templateHash?: string;
        idempotencyStatus?: string;
        workflowRunId?: string;
        schedulerRunId?: string;
        rootWorkNodeId?: string;
        state?: string;
        schedulerState?: string;
        rootState?: string;
      };
      nodes?: ReadonlyArray<{
        id?: string;
        templateId?: string;
        title?: string;
        state?: string;
        runner?: string;
        worker?: string;
      }>;
      stdoutTail?: string;
      stderrTail?: string;
      error?: {
        reason: string;
        message: string;
        code?: string;
        suggestedAction?: string;
      };
    };

/** Durable ShellRun state updates use a separate observer channel from model turns. */
export type ShellRunUpdateOwnership =
  | { kind: 'local' }
  | { kind: 'source_owned'; sourceSessionId: string; ownerSessionId: string }
  | { kind: 'source_unavailable'; sourceSessionId: string };

export interface ShellRunUpdate {
  /** Session whose conversation view should consume this projection. */
  sessionId: string;
  /** Whether the process is local or inherited, and whether its real owner is still resolvable. */
  ownership: ShellRunUpdateOwnership;
  sourceTurnId: string;
  sourceToolCallId: string;
  result: ShellRunStateResult;
}

export interface PermissionRequestEvent extends BaseEvent, PermissionRequest {
  type: 'permission_request';
}

export interface AdditionalPermissionRequestEvent extends BaseEvent, AdditionalPermissionRequest {
  type: 'permission_request';
  /** Additional-permission prompts deliberately do not expose raw tool arguments. */
  args: undefined;
  rememberForTurnAllowed?: false;
}

export interface SandboxEscalationRequestEvent extends BaseEvent, SandboxEscalationRequest {
  type: 'permission_request';
  /** Escalation prompts expose only bounded command and justification fields. */
  args: undefined;
  rememberForTurnAllowed?: false;
}

export type AnyPermissionRequestEvent =
  | PermissionRequestEvent
  | AdditionalPermissionRequestEvent
  | SandboxEscalationRequestEvent;

export interface UserQuestionRequestEvent extends BaseEvent, UserQuestionRequest {
  type: 'user_question_request';
}

export interface SandboxBoundaryRequestEvent extends BaseEvent {
  type: 'sandbox_boundary_request';
  requestId: string;
  toolUseId: string;
  justification: string;
  expansion: SandboxBoundaryExpansion;
}

/**
 * The requests a session can park on while it waits for the user. Both are
 * registered by RuntimeKernel while unanswered, so a surface that missed the
 * live event can rehydrate the prompt instead of stranding the run.
 */
export type ActiveInteractionRequestEvent = SandboxBoundaryRequestEvent | UserQuestionRequestEvent;

export interface SandboxBoundaryDecisionAckEvent extends BaseEvent {
  type: 'sandbox_boundary_decision_ack';
  requestId: string;
  toolUseId: string;
  decision: 'allow' | 'deny';
  status: Exclude<SandboxBoundaryRequestStatus, 'pending'>;
  revision: number;
}

/**
 * Echo that the backend accepted a user-question answer.
 * The canonical answer remains owned by InteractionStore.
 */
export interface UserQuestionAnswerAckEvent extends BaseEvent {
  type: 'user_question_answer_ack';
  requestId: string;
  toolUseId: string;
}

/**
 * Echo that the hosted runtime accepted a permission answer.
 * The canonical decision remains owned by the Interaction outcome.
 */
export interface PermissionAnswerAckEvent extends BaseEvent {
  type: 'permission_answer_ack';
  requestId: string;
  toolUseId: string;
}

export type PermissionClosureReason = 'timed_out';

/**
 * Echo that the hosted runtime durably closed an unanswered permission request.
 * This acknowledgement carries identity and closure reason only.
 */
export interface PermissionClosureAckEvent extends BaseEvent {
  type: 'permission_closure_ack';
  requestId: string;
  toolUseId: string;
  reason: PermissionClosureReason;
}

/**
 * Embedded/legacy echo of a permission decision. Hosted execution uses the
 * identity-only PermissionAnswerAckEvent instead.
 */
export interface PermissionDecisionAckEvent extends BaseEvent {
  type: 'permission_decision_ack';
  requestId: string;
  toolUseId: string;
  decision: 'allow' | 'deny';
  rememberForTurn?: boolean;
  reviewer?: import('./permission.js').ApprovalsReviewer;
  rationale?: string;
  riskLevel?: import('./permission.js').ApprovalRiskLevel;
}

export interface PlanSubmittedEvent extends BaseEvent {
  type: 'plan_submitted';
  planId: string;
  proposalId?: string;
  revision?: number;
  title: string;
  overview?: string;
  risks?: string[];
  /** Legacy file-backed proposal representation. */
  markdownPath?: string;
  steps?: PlanStep[];
}

export interface PlanStep {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  files?: string[];
  complexity?: 'low' | 'medium' | 'high';
}

export interface TokenUsageEvent extends BaseEvent, TokenUsageFields {
  type: 'token_usage';
}

/**
 * A user message injected into a running turn at a step boundary (steering).
 * The runtime persists it as a user event in the ledger and echoes it through
 * the stream so the transcript renders the interjection in place. `text` is the
 * raw user text; the backend wraps it in a steering envelope for the model.
 */
export interface SteeringMessageEvent extends BaseEvent {
  type: 'steering_message';
  messageId: string;
  content: MessageContent;
  submittedContentDigest?: `sha256:${string}`;
}

/**
 * Result of enqueuing a steering / followup message. `fallback` means there was
 * no active run to attach to (the turn just ended) and the caller should open a
 * fresh turn with the text instead, so a message is never silently dropped.
 * Queue contents travel on ONE path only: the `queue_update` event.
 */
export type QueueEnqueueOutcome = { kind: 'queued' } | { kind: 'fallback' };

/**
 * Authoritative queue snapshot pushed into the active turn's event stream
 * whenever either pending queue changes (enqueue, step-boundary consumption, or
 * interrupt clear). UI observers mirror it; the runtime owns the source of truth.
 */
export interface QueueUpdateEvent extends BaseEvent {
  type: 'queue_update';
  steering: string[];
  followup: string[];
}

export type ProviderRetryReason =
  | 'network'
  | 'provider_unavailable'
  | 'rate_limit'
  | 'timeout'
  | 'unknown';

/**
 * Transient progress for a provider request that Runtime will retry.
 *
 * This event is intentionally not a durable conversation fact. `attempt`
 * names the next/current physical request (2–10), while `maxAttempts`
 * includes the first request.
 */
export type ProviderRetryEvent = ProviderRetryScheduledEvent | ProviderRetryStartedEvent;

export interface ProviderRetryScheduledEvent extends BaseEvent {
  type: 'provider_retry';
  phase: 'scheduled';
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: ProviderRetryReason;
}

export interface ProviderRetryStartedEvent extends BaseEvent {
  type: 'provider_retry';
  phase: 'started';
  attempt: number;
  maxAttempts: number;
  reason: ProviderRetryReason;
}

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  recoverable: boolean;
  code?: string;
  /** Stable machine-readable reason for UI / telemetry routing. */
  reason?: string;
  message: string;
  /** Adapter MUST scrub secrets before populating this field. */
  details?: string[] | Record<string, unknown>;
}

export interface CompleteEvent extends BaseEvent {
  type: 'complete';
  stopReason:
    | 'end_turn'
    | 'user_stop'
    | 'error'
    | 'plan_handoff'
    | 'graph_yield'
    | 'permission_handoff'
    | 'step_limit'
    | 'max_tokens'
    | 'context_budget_exhausted';
  /**
   * Detail for `stopReason: 'context_budget_exhausted'` — the runtime could not
   * produce a provider-safe request even after mid-turn compaction. A first-class
   * outcome, not a provider context-length error.
   */
  contextBudgetExhaustedDetail?: ContextBudgetExhaustedDetail;
}

export type ContextBudgetExhaustedDetail =
  | 'no_safe_completed_span'
  | 'summarizer_failed'
  | 'head_anchor_exceeds_capacity';

export type CompleteStopReason = CompleteEvent['stopReason'];

/** Stable failure taxonomy for complete events that did not finish the turn. */
export function failureClassFromCompleteStopReason(
  reason: CompleteStopReason,
): 'runtime_error' | 'tool_step_cap_reached' | 'context_budget_exhausted' | undefined {
  if (reason === 'error') return 'runtime_error';
  if (reason === 'step_limit') return 'tool_step_cap_reached';
  if (reason === 'context_budget_exhausted') return 'context_budget_exhausted';
  return undefined;
}

export interface AbortEvent extends BaseEvent {
  type: 'abort';
  reason: 'user_stop' | 'redirect' | 'timeout' | 'crash';
}

// ============================================================================
// UI → Backend commands
// ============================================================================

/**
 * SessionCommand: commands that target a specific session.
 *
 * Connection-management commands live in ConnectionCommand (./connections.ts).
 *
 * `permission_response` composes PermissionResponse rather than flattening
 * its fields, so there is exactly ONE shape for a permission decision in
 * the codebase.
 */
export type AttachmentIngestItem =
  | { approvalId: string; name: string; mimeType?: string }
  | { name: string; mimeType?: string; base64: string };

export type SessionCommand =
  | {
      type: 'send';
      turnId: string;
      text: string;
      attachmentItems?: AttachmentIngestItem[];
    }
  | { type: 'stop' }
  | { type: 'permission_response'; response: PermissionResponse }
  | {
      type: 'plan_response';
      planId: string;
      action: 'approve' | 'refine';
      feedback?: string;
    };
