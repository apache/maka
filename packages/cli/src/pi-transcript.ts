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

import { Markdown, visibleWidth } from '@earendil-works/pi-tui';
import type {
  ProviderRetryEvent,
  ProviderRetryScheduledEvent,
  SandboxBoundaryRequestEvent,
  UserQuestionRequestEvent,
  SessionEvent,
  ShellRunSnapshotResult,
  ToolOutputStream,
  ToolResultContent,
} from '@maka/core/events';
import {
  deriveTurnRecords,
  STEP_LIMIT_NOTICE_TEXT,
  type StoredMessage,
  type SystemNoteMessage,
} from '@maka/core/session';
import type { ContextBudgetDiagnostic } from '@maka/core/usage-stats/types';
import { providerRetryDisplaySeconds } from '@maka/core/provider-retry-countdown';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import {
  defineUiMessageCatalog,
  resolveUiMessageCatalog,
  type UiLocale,
} from '@maka/core/ui-locale';
import { TUI_COPY_RESOURCES } from './tui-copy-catalog.js';
import { isActiveShellRunStatus } from '@maka/core/shell-run';
import { mergeShellRunStateWithDiagnostics } from '@maka/core/shell-run-result';
import { projectToolActivityArgs } from '@maka/core/tool-activity-args';
import {
  type ToolActivityStatus,
  toolResultActivityStatus,
  unfinishedToolActivityStatus,
} from '@maka/core/tool-result-status';
import { type ShellRunUpdate } from '@maka/core/events';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, sep } from 'node:path';
import type { MakaSessionDriver, MakaSideConversationParentStatus } from './session-driver.js';
import { BoundedChunkBuffer } from './bounded-chunk-buffer.js';
import { ansi } from './tui-ansi.js';
import {
  collapseToSingleLine,
  fitLine,
  formatTokenCount,
  formatUnknown,
  limitText,
  markdownTheme,
  renderIndented,
} from './pi-transcript-format.js';
import { goalStatusLineText, isLiveGoalStatus } from './pi-goal.js';
import { renderToolBlock } from './pi-transcript-tools.js';
import { getTuiPrimaryGuidance } from './tui-primary-guidance.js';
import { renderTuiShortcutCopy } from './tui-shortcut-copy.js';
import type { GoalProjection } from '@maka/runtime-host/protocol';

export interface MakaPiUsageSummary {
  /** Cumulative cost in USD across the session. */
  costUsd: number;
  /** Cumulative cache hit input tokens. */
  cacheHitInput: number;
  /** Cumulative cache miss input tokens. */
  cacheMissInput: number;
  /** Remaining context tokens from the latest token_usage event. */
  contextRemaining?: number;
}

export interface MakaPiTranscriptState {
  entries: MakaPiTranscriptEntry[];
  pendingInteraction?: MakaPiPendingInteraction;
  queuedInteractions: MakaPiPendingInteraction[];
  /**
   * Expansion defaults: entries stamp `expanded` from these at creation, and
   * one Ctrl+O / Ctrl+T press retargets every tool / thinking entry inside the
   * live viewport and flips the default for entries created later. Entries
   * above the viewport keep their state — their rendered lines sit in terminal
   * scrollback, which cannot be rewritten, so resizing one would force pi-tui
   * into a scrollback-clearing full redraw (#1097). The deliberate exception:
   * a second press within 2s of a collapse that stranded expanded entries
   * above the viewport applies the default to them too and pays one such
   * redraw knowingly (#4011, applyExpansionDefaultToAll). In-memory only;
   * never persisted to storage. Resume resets both to collapsed.
   */
  expandAllTools: boolean;
  expandAllThinking: boolean;
  /**
   * Geometry of the transcript render pi-tui last diffed against:
   * renderMakaPiTranscript records each entry's first line and
   * MakaPiLayoutComponent records the live-viewport top. The expansion toggles
   * read it to leave entries above the viewport untouched (#1097); see
   * entryInLiveViewport.
   */
  renderGeometry: MakaPiRenderGeometry;
  /** Aggregated token usage for statusline display; reset on session switch. */
  usage: MakaPiUsageSummary;
  /**
   * Read-only mirror of the runtime's authoritative pending queues, driven by
   * `queue_update` events and enqueue results. Rendered as the pending bar above
   * the editor; never the source of truth (the runtime owns that).
   */
  steering: string[];
  followup: string[];
  /** Current non-durable provider retry progress for the activity strip. */
  providerRetry?: ProviderRetryCountdown;
}

export type MakaPiPendingInteraction = SandboxBoundaryRequestEvent | UserQuestionRequestEvent;

/**
 * A provider retry event plus the CLIENT-local time it was applied. Counting
 * down from `receivedAtMs` keeps the whole countdown in one clock domain —
 * the event's own `ts` is stamped on the (possibly remote) Runtime Host
 * clock, so subtracting it from a client clock would skew the display by the
 * clock offset between the two machines.
 */
export interface ProviderRetryCountdown {
  event: ProviderRetryEvent;
  receivedAtMs: number;
}

export interface MakaPiRenderGeometry {
  /**
   * First rendered transcript-line index per entry, from the latest render.
   * `undefined` means no entry position is known — the transcript was just
   * replaced wholesale and has not rendered since — which the toggles must
   * treat as "nothing safely reachable" while the viewport has scrolled.
   */
  entryFirstLine: Map<MakaPiTranscriptEntry, number> | undefined;
  /**
   * pi-tui's live-viewport top in transcript-line coordinates (the transcript
   * is the first layout child, so transcript line i is composed line i). Held
   * as a monotonic max: pi-tui's viewport never scrolls back up short of a
   * full redraw, and a full redraw has already cleared scrollback, so
   * overestimating only makes the toggles more conservative.
   */
  viewportTop: number;
}

/** A single live output chunk from a `tool_output_delta` event. */
export interface MakaPiToolOutputDelta {
  seq: number;
  stream: ToolOutputStream;
  chunk: string;
  redacted: boolean;
}

const LIVE_TOOL_BUFFER_MAX_CHARS = 64 * 1024;
const LIVE_TOOL_BUFFER_MAX_CHUNKS = 512;

export type MakaPiTranscriptEntry =
  | { kind: 'user'; messageId: string; text: string; transient?: boolean }
  | { kind: 'legacy_automation'; text: string }
  | { kind: 'goal_continuation'; text: string }
  | { kind: 'assistant'; messageId: string; text: string }
  | { kind: 'thinking'; messageId: string; text: string; expanded: boolean }
  | {
      kind: 'tool';
      /** Present for live events so durable hydration is turn-scoped. */
      turnId?: string;
      toolUseId: string;
      toolName: string;
      title?: string;
      /** Runtime-authored, bounded description of the live call's purpose. */
      intent?: string;
      input: unknown;
      /** Structured result returned by the tool. */
      result?: ToolResultContent;
      /** In-memory revision for render-cache invalidation when a result is replaced. */
      resultVersion: number;
      progress: BoundedChunkBuffer<string>;
      outputDeltas: BoundedChunkBuffer<MakaPiToolOutputDelta>;
      durationMs?: number;
      /** Invocation lifecycle. Resource liveness remains authoritative in `result`. */
      callStatus: ToolActivityStatus;
      /** Ownership of an active ShellRun; absent means locally owned. */
      shellRunSource?: 'source_owned' | 'unavailable';
      /** Expanded card view; stamped from expandAllTools, retargeted by Ctrl+O. */
      expanded: boolean;
      /** An internal shell-run poll retained for correlation but not displayed. */
      suppressed?: boolean;
      /** Local-only Runtime Resource started by `!<command>`, never a model tool call. */
      userOwned?: boolean;
    }
  | { kind: 'notice'; level: 'info' | 'error'; text: string };

export interface MakaPiTranscriptMetadata {
  title: string;
  cwd: string;
  model: string;
  connectionSlug: string;
  permissionMode: string;
  orchestrationMode?: 'default' | 'swarm' | 'graph';
  thinkingLevel?: ThinkingLevel;
  thinkingLevels?: readonly ThinkingLevel[];
  sessionId?: string | null;
  busy?: boolean;
  usage?: MakaPiUsageSummary;
  /** Maximum context tokens for the active model, for the `ctx used/window pct%` segment. */
  modelContextWindow?: number;
  /** Elapsed milliseconds of the running agent turn, for the activity strip. */
  turnElapsedMs?: number;
  providerRetry?: ProviderRetryCountdown;
  /** Resolved locale for primary TUI guidance. Defaults to English for direct embeddings. */
  uiLocale?: UiLocale;
  /**
   * Latest known goal projection for the session, or null when no goal is
   * set. The status line shows live goals only (active/waiting/paused);
   * terminal goals leave no segment, matching the desktop chip.
   */
  goal?: GoalProjection | null;
  sideConversation?: {
    view: 'parent' | 'side';
    parentStatus?: MakaSideConversationParentStatus;
  };
}

export function createMakaPiTranscriptState(): MakaPiTranscriptState {
  return {
    entries: [],
    queuedInteractions: [],
    expandAllTools: false,
    expandAllThinking: false,
    renderGeometry: { entryFirstLine: undefined, viewportTop: 0 },
    usage: { costUsd: 0, cacheHitInput: 0, cacheMissInput: 0 },
    steering: [],
    followup: [],
  };
}

function accumulateUsage(
  usage: MakaPiUsageSummary,
  msg: {
    costUsd?: number;
    input?: number;
    cacheHitInput?: number;
    cacheRead?: number;
    cacheWriteInput?: number;
    cacheCreation?: number;
    cacheMissInput?: number;
    contextRemaining?: number;
  },
): void {
  usage.costUsd += msg.costUsd ?? 0;
  const hit = msg.cacheHitInput ?? msg.cacheRead ?? 0;
  const write = msg.cacheWriteInput ?? msg.cacheCreation ?? 0;
  usage.cacheHitInput += hit;
  usage.cacheMissInput += msg.cacheMissInput ?? Math.max(0, (msg.input ?? 0) - hit - write);
  usage.contextRemaining = msg.contextRemaining;
}

export function appendUserPrompt(
  state: MakaPiTranscriptState,
  text: string,
  messageId: string,
  transient = false,
): void {
  const entry = {
    kind: 'user',
    messageId,
    text,
    ...(transient ? { transient: true } : {}),
  } as const;
  const existingIndex = state.entries.findIndex(
    (candidate) => candidate.kind === 'user' && candidate.messageId === messageId,
  );
  if (existingIndex >= 0) {
    state.entries[existingIndex] = entry;
    return;
  }
  state.entries.push(entry);
}

export function retireCancelledTransientMessages(
  state: MakaPiTranscriptState,
  cancelledMessageIds: readonly string[],
): void {
  const cancelled = new Set(cancelledMessageIds);
  if (cancelled.size === 0) return;
  state.entries = state.entries.filter(
    (entry) => entry.kind !== 'user' || entry.transient !== true || !cancelled.has(entry.messageId),
  );
}

export function appendTurnFailureToTranscript(state: MakaPiTranscriptState, error: unknown): void {
  clearPendingInteractions(state);
  state.entries.push({
    kind: 'notice',
    level: 'error',
    text: error instanceof Error ? error.message : String(error),
  });
}

export function refreshRunningShellRunElapsed(
  state: MakaPiTranscriptState,
  now = Date.now(),
): boolean {
  let found = false;
  for (const entry of state.entries) {
    if (
      entry.kind !== 'tool' ||
      entry.result?.kind !== 'shell_run' ||
      makaPiToolPresentationStatus(entry) !== 'running'
    )
      continue;
    entry.durationMs = Math.max(0, now - entry.result.startedAt);
    found = true;
  }
  return found;
}

export function applyShellRunViewUpdateToTranscript(
  state: MakaPiTranscriptState,
  update: ShellRunUpdate,
  options?: {
    /**
     * Whether a running → settled flip appends a transcript-tail notice.
     * Default true for live updates. Hydration catch-up (`listShellRunUpdates`)
     * passes false: replaying durable state is not a live event, and the notice
     * is never persisted, so announcing catch-up would re-announce on every
     * session attach.
     */
    announceSettle?: boolean;
  },
): boolean {
  const tool = findToolEntry(state, update.sourceToolCallId);
  const wasLive = isLiveShellRunCard(tool);
  const applied = applyShellRunUpdateToTranscript(state, update.sourceToolCallId, update.result);
  if (
    tool &&
    tool.userOwned !== true &&
    wasLive &&
    isSettledShellRunCard(tool) &&
    options?.announceSettle !== false
  ) {
    pushShellRunSettledNotice(state, tool);
  }
  if (
    !tool ||
    !isShellRunToolCard(tool) ||
    tool.result?.kind !== 'shell_run' ||
    tool.result.ref !== update.result.ref ||
    tool.result.revision !== update.result.revision ||
    !isActiveShellRunStatus(tool.result.status)
  )
    return applied;
  const shellRunSource =
    update.ownership.kind === 'local'
      ? undefined
      : update.ownership.kind === 'source_owned'
        ? 'source_owned'
        : 'unavailable';
  if (tool.shellRunSource === shellRunSource) return applied;
  tool.shellRunSource = shellRunSource;
  return true;
}

export function applyShellRunUpdateToTranscript(
  state: MakaPiTranscriptState,
  sourceToolCallId: string,
  update: Extract<ToolResultContent, { kind: 'shell_run' }>,
): boolean {
  const tool = findToolEntry(state, sourceToolCallId);
  if (!tool || !isShellRunToolCard(tool)) return false;
  if (tool.result?.kind === 'shell_run' && tool.result.ref !== update.ref) return false;
  return applyShellRunResult(tool, update);
}

/** Adds a local-only card for a `!<command>` resource without creating a model turn. */
export function appendUserCommandToTranscript(
  state: MakaPiTranscriptState,
  input: { commandId: string; command: string; result: ShellRunSnapshotResult },
): void {
  state.entries.push({
    kind: 'tool',
    toolUseId: input.commandId,
    toolName: 'User command',
    title: 'User command',
    input: { command: input.command },
    result: input.result,
    resultVersion: 1,
    progress: createProgressBuffer(),
    outputDeltas: createOutputBuffer(),
    callStatus: toolResultActivityStatus(
      input.result.status === 'failed' || input.result.status === 'timed_out',
      input.result,
    ),
    expanded: true,
    userOwned: true,
  });
}

export function replaceTranscriptWithStoredMessages(
  state: MakaPiTranscriptState,
  messages: readonly StoredMessage[],
  options: { preserveClientLocalEntries?: boolean } = {},
): void {
  const durableMessageIds = new Set(messages.map((message) => message.id));
  const durableEntries = foldStoredShellRunChildren(storedMessagesToTranscriptEntries(messages));
  const durableEntryIds = new Set(durableEntries.map(transcriptEntryId).filter(Boolean));
  // Client-local entries have no durable counterpart to arrive in `messages`:
  // a transient user row still waiting for its canonical message, and every
  // notice the client itself wrote (recap, skill card, error). A replacement
  // that dropped them would erase what the client just told the user.
  const isClientLocal = (entry: MakaPiTranscriptEntry): boolean =>
    entry.kind === 'notice' ||
    (entry.kind === 'tool' && entry.userOwned === true) ||
    (entry.kind === 'user' && entry.transient === true && !durableMessageIds.has(entry.messageId));
  // A preserved entry keeps its place relative to the durable entry it
  // followed. With no durable entry ahead of it it stays at the head, unless
  // something durable preceded it — then the tail is where it belongs.
  const transientEntriesByBoundary = new Map<number, MakaPiTranscriptEntry[]>();
  if (options.preserveClientLocalEntries) {
    state.entries.forEach((entry, index) => {
      if (!isClientLocal(entry)) return;
      const priorEntries = state.entries.slice(0, index);
      const previousDurableId = priorEntries
        .map(transcriptEntryId)
        .reverse()
        .find((messageId) => messageId !== undefined && durableEntryIds.has(messageId));
      const previousIndex = previousDurableId
        ? durableEntries.findIndex(
            (candidate) => transcriptEntryId(candidate) === previousDurableId,
          )
        : -1;
      const hadPrecedingEntry = priorEntries.some((candidate) => !isClientLocal(candidate));
      const boundary =
        previousIndex >= 0 ? previousIndex + 1 : hadPrecedingEntry ? durableEntries.length : 0;
      const grouped = transientEntriesByBoundary.get(boundary);
      if (grouped) grouped.push(entry);
      else transientEntriesByBoundary.set(boundary, [entry]);
    });
  }
  state.entries = [];
  for (let boundary = 0; boundary <= durableEntries.length; boundary += 1) {
    state.entries.push(...(transientEntriesByBoundary.get(boundary) ?? []));
    if (boundary < durableEntries.length) state.entries.push(durableEntries[boundary]!);
  }
  clearPendingInteractions(state);
  state.expandAllTools = false;
  state.expandAllThinking = false;
  // The old entries are gone; no position is known until the next render, and
  // until then the toggles must not touch anything (a replacement entry could
  // render above the still-scrolled viewport). viewportTop is left to the next
  // layout render: when the replacement changes lines above it, pi-tui
  // full-redraws and the layout's shadow diff resets the estimate to match;
  // when the replacement is a pure truncation or identical content, pi-tui
  // keeps its viewport and so does the estimate.
  state.renderGeometry.entryFirstLine = undefined;
  state.usage = { costUsd: 0, cacheHitInput: 0, cacheMissInput: 0 };
  // Queues are per-active-run; a switched/reset session has none pending.
  state.steering = [];
  state.followup = [];
  for (const msg of messages) {
    if (msg.type === 'token_usage') accumulateUsage(state.usage, msg);
  }
}

function transcriptEntryId(entry: MakaPiTranscriptEntry): string | undefined {
  switch (entry.kind) {
    case 'user':
    case 'assistant':
    case 'thinking':
      return entry.messageId;
    case 'tool':
      return entry.toolUseId;
    default:
      return undefined;
  }
}

export function hasRunningUserCommand(state: MakaPiTranscriptState): boolean {
  return state.entries.some(
    (entry) => entry.kind === 'tool' && entry.userOwned === true && isLiveShellRunCard(entry),
  );
}

/**
 * Fill durable tool details that are intentionally absent from Runtime Host
 * live events without applying session-switch reset semantics.
 */
export function hydrateToolsWithStoredMessages(
  state: MakaPiTranscriptState,
  turnId: string,
  messages: readonly StoredMessage[],
): boolean {
  const turnMessages = messages.filter((message) => message.turnId === turnId);
  const durableTools = new Map(
    foldStoredShellRunChildren(storedMessagesToTranscriptEntries(turnMessages))
      .filter(
        (entry): entry is Extract<MakaPiTranscriptEntry, { kind: 'tool' }> => entry.kind === 'tool',
      )
      .map((entry) => [entry.toolUseId, entry]),
  );
  let changed = false;
  for (const entry of state.entries) {
    if (entry.kind !== 'tool' || entry.turnId !== turnId) continue;
    const durable = durableTools.get(entry.toolUseId);
    if (!durable) continue;
    entry.toolName = durable.toolName;
    entry.title = durable.title;
    entry.input = structuredClone(durable.input);
    entry.callStatus = mergeToolCallStatus(entry.callStatus, durable.callStatus);
    if (
      durable.result?.kind === 'shell_run' &&
      durable.callStatus !== 'errored' &&
      entry.toolName === 'Bash'
    ) {
      applyShellRunResult(entry, structuredClone(durable.result));
    } else if (durable.result !== undefined && entry.result === undefined) {
      entry.result = structuredClone(durable.result);
      entry.resultVersion += 1;
      if (durable.durationMs !== undefined) entry.durationMs = durable.durationMs;
    } else if (durable.durationMs !== undefined && entry.durationMs === undefined) {
      entry.durationMs = durable.durationMs;
    }
    changed = true;
  }
  return changed;
}

function mergeToolCallStatus(
  current: ToolActivityStatus,
  durable: ToolActivityStatus,
): ToolActivityStatus {
  return current === 'running' ? durable : current;
}

/**
 * True when the entry will render inside the live viewport, or has not been
 * rendered yet (a fresh entry first appears at the tail, inside the viewport).
 * Entries above the viewport sit in terminal scrollback, which ANSI terminals
 * cannot rewrite: resizing one forces pi-tui's differential renderer into a
 * full redraw that clears pre-Maka scrollback and resets the user's scroll
 * position (#1097), so the global toggles leave them untouched.
 */
function entryInLiveViewport(state: MakaPiTranscriptState, entry: MakaPiTranscriptEntry): boolean {
  const geometry = state.renderGeometry;
  // No positions at all (fresh state, or replaced and not yet rendered): safe
  // only while the viewport has never scrolled.
  if (geometry.entryFirstLine === undefined) return geometry.viewportTop === 0;
  const firstLine = geometry.entryFirstLine.get(entry);
  return firstLine === undefined || firstLine >= geometry.viewportTop;
}

/**
 * True while entry positions are unknown but the viewport has scrolled (a
 * wholesale replacement not yet re-rendered): a toggle could rewrite lines
 * above pi-tui's real viewport, so it must do nothing until the next render.
 *
 * Unknown positions with viewportTop === 0 are deliberately NOT inert: while
 * the viewport has never scrolled, no line sits in scrollback and pi-tui's
 * differential render (`firstChanged < viewportTop`) can never full-redraw,
 * so toggling everything — including entries awaiting their first render —
 * is physically safe.
 */
function togglesInert(state: MakaPiTranscriptState): boolean {
  return state.renderGeometry.entryFirstLine === undefined && state.renderGeometry.viewportTop > 0;
}

/**
 * Toggle every tool card in the live viewport at once and flip the default for
 * future cards; false when the session has no tool card at all or the toggles
 * are inert pending a render.
 *
 * A collapse that strands expanded cards above the viewport (their heads sit
 * in scrollback, #1134) appends a notice naming them and offering the #4011
 * second-press escape: the runner arms a confirm window whenever
 * hasExpandedEntriesAboveViewport still holds after the toggle. A partial
 * collapse says so too — the keypress is never silent about what it skipped.
 */
export function toggleAllToolExpansion(state: MakaPiTranscriptState): boolean {
  return toggleExpansion(state, 'tool');
}

/**
 * Toggle every thinking entry in the live viewport at once and flip the
 * default for future entries; false when there is no thinking at all or the
 * toggles are inert pending a render. Same head-scrolled contract and #4011
 * second-press escape as toggleAllToolExpansion.
 */
export function toggleAllThinkingExpansion(state: MakaPiTranscriptState): boolean {
  return toggleExpansion(state, 'thinking');
}

/**
 * True when an entry of the kind above the live viewport remains expanded —
 * the stranded blocks the #4011 confirmed collapse exists for. False while
 * the toggles are inert (positions unknown after a wholesale replacement).
 */
export function hasExpandedEntriesAboveViewport(
  state: MakaPiTranscriptState,
  kind: ExpansionEntryKind,
): boolean {
  if (togglesInert(state)) return false;
  return expansionCandidates(state, kind).some(
    (entry) => entry.expanded && !entryInLiveViewport(state, entry),
  );
}

/**
 * Appends the visible, explicit offer for the one deliberate full-redraw
 * escape hatch. The runner owns the time window; this helper keeps both the
 * first offer and an expired offer on the same copy authority.
 */
export function appendExpansionCollapseConfirmation(
  state: MakaPiTranscriptState,
  kind: ExpansionEntryKind,
): boolean {
  if (!hasExpandedEntriesAboveViewport(state, kind)) return false;
  const copy = EXPANSION_KIND_COPY[kind];
  const stuck = expansionCandidates(state, kind).filter(
    (entry) => entry.expanded && !entryInLiveViewport(state, entry),
  );
  state.entries.push({
    kind: 'notice',
    level: 'info',
    text: `${stuck.length} ${stuck.length === 1 ? copy.singular : copy.plural} above the view stayed expanded in scrollback — press ${copy.key} again within ${EXPANSION_COLLAPSE_CONFIRM_WINDOW_MS / 1000}s to collapse them too (this redraws the screen and clears pre-session scrollback). New ${copy.newOutput} starts collapsed.`,
  });
  return true;
}

/**
 * Apply the current expansion default to every entry of the kind, including
 * entries above the live viewport whose rendered lines sit in scrollback.
 * This is #4011's confirmed second press: a true return means lines above
 * the viewport change, so the caller MUST follow with pi-tui's
 * `requestRender(true)` — a scrollback-clearing full redraw that re-anchors
 * the viewport at the tail. (The differential path would reach the same
 * redraw via `firstChanged < viewportTop`; forcing it keeps renderer and the
 * layout's viewport shadow in agreement by construction.)
 * This is intentionally the only expansion mutation that bypasses the
 * unknown-geometry guard: its caller immediately forces that wholesale
 * redraw, which resets the renderer's prior geometry before it re-renders.
 */
export function applyExpansionDefaultToAll(
  state: MakaPiTranscriptState,
  kind: ExpansionEntryKind,
): boolean {
  const expanded = kind === 'tool' ? state.expandAllTools : state.expandAllThinking;
  let changed = false;
  for (const entry of expansionCandidates(state, kind)) {
    if (entry.expanded === expanded) continue;
    entry.expanded = expanded;
    changed = true;
  }
  return changed;
}

export type ExpansionEntryKind = 'tool' | 'thinking';

/**
 * How close together two identical expansion-toggle presses read as the
 * confirmed "collapse the stranded blocks above the viewport" gesture (#4011).
 * Lives beside the notice copy so the offer text and the runner's confirm
 * window share one authority and cannot drift.
 */
export const EXPANSION_COLLAPSE_CONFIRM_WINDOW_MS = 2_000;

const EXPANSION_KIND_COPY: Record<
  ExpansionEntryKind,
  {
    key: string;
    singular: string;
    plural: string;
    noTargetsNotice: (expand: boolean) => string;
    newOutput: string;
  }
> = {
  tool: {
    key: 'Ctrl+O',
    singular: 'tool card',
    plural: 'tool cards',
    newOutput: 'tool output',
    noTargetsNotice: (expand) =>
      `No tool card in view to toggle — cards above stay as rendered in scrollback. New tool output starts ${expand ? 'expanded' : 'collapsed'}.`,
  },
  thinking: {
    key: 'Ctrl+T',
    singular: 'thinking block',
    plural: 'thinking blocks',
    newOutput: 'thinking',
    noTargetsNotice: (expand) =>
      `No thinking in view to toggle — thinking above stays as rendered in scrollback. New thinking starts ${expand ? 'expanded' : 'collapsed'}.`,
  },
};

function expansionCandidates(
  state: MakaPiTranscriptState,
  kind: ExpansionEntryKind,
): Array<MakaPiToolEntry | MakaPiThinkingEntry> {
  return kind === 'tool'
    ? state.entries.filter(
        (entry): entry is MakaPiToolEntry => entry.kind === 'tool' && entry.userOwned !== true,
      )
    : state.entries.filter(
        (entry): entry is MakaPiThinkingEntry =>
          entry.kind === 'thinking' && Boolean(entry.text.trim()),
      );
}

function toggleExpansion(state: MakaPiTranscriptState, kind: ExpansionEntryKind): boolean {
  if (togglesInert(state)) return false;
  const candidates = expansionCandidates(state, kind);
  if (candidates.length === 0) return false;
  const expand = kind === 'tool' ? !state.expandAllTools : !state.expandAllThinking;
  if (kind === 'tool') state.expandAllTools = expand;
  else state.expandAllThinking = expand;
  const targets = candidates.filter((entry) => entryInLiveViewport(state, entry));
  for (const entry of targets) entry.expanded = expand;
  const stuck = candidates.filter((entry) => entry.expanded !== expand);
  const copy = EXPANSION_KIND_COPY[kind];
  // The confirm offer exists for collapses only: expanded-above blocks are the
  // screen-reclaiming pain (#4011), while collapsed-above blocks are compact
  // and harmless in scrollback — and arming on expand would make a quick
  // expand-then-collapse pair read the second press as "expand everything".
  if (!expand && stuck.length > 0) {
    appendExpansionCollapseConfirmation(state, kind);
  } else if (targets.length === 0) {
    state.entries.push({ kind: 'notice', level: 'info', text: copy.noTargetsNotice(expand) });
  }
  return true;
}

export async function submitCompactToTranscript(input: {
  state: MakaPiTranscriptState;
  driver: Pick<MakaSessionDriver, 'compactSession'>;
  onChange?: () => void;
}): Promise<void> {
  let outcome: Extract<SessionEvent, { type: 'complete' }>['contextCompactionOutcome'];
  try {
    for await (const event of input.driver.compactSession()) {
      if (event.type === 'complete') outcome = event.contextCompactionOutcome;
      if (event.type === 'token_usage') accumulateUsage(input.state.usage, event);
      else applyMakaSessionEventToTranscript(input.state, event);
      input.onChange?.();
    }
    if (outcome) {
      input.state.entries.push({
        kind: 'notice',
        level: outcome.kind === 'failed' ? 'error' : 'info',
        text:
          outcome.kind === 'compacted'
            ? 'Context compacted.'
            : outcome.kind === 'unchanged'
              ? 'Nothing to compact.'
              : `Context compaction failed: ${outcome.reason}.`,
      });
      input.onChange?.();
    }
  } catch (error) {
    input.state.entries.push({
      kind: 'notice',
      level: 'error',
      text: error instanceof Error ? error.message : String(error),
    });
    input.onChange?.();
  }
}

export function applyMakaSessionEventToTranscript(
  state: MakaPiTranscriptState,
  event: SessionEvent,
): void {
  if (
    event.type === 'text_delta' ||
    event.type === 'text_complete' ||
    event.type === 'thinking_delta' ||
    event.type === 'thinking_complete' ||
    event.type === 'tool_start' ||
    event.type === 'error' ||
    event.type === 'abort' ||
    event.type === 'complete'
  ) {
    state.providerRetry = undefined;
  }
  switch (event.type) {
    case 'text_delta':
      appendAssistantText(state, event.messageId, event.text);
      break;

    case 'text_complete':
      if (!setAssistantText(state, event.messageId, event.text) && event.text) {
        appendAssistantText(state, event.messageId, event.text);
      }
      break;

    case 'thinking_delta':
      appendThinking(state, event.messageId, event.text);
      break;

    case 'thinking_complete':
      if (event.text) setThinking(state, event.messageId, event.text);
      break;

    case 'tool_start': {
      // A Read / StopBackgroundTask aimed at a ref a visible Bash card owns is
      // internal polling of that run: it never gets a row, so an active polling
      // loop cannot flicker cards in and out of the transcript. The result
      // folds into the parent at tool_result. A poll is folded only when its
      // parent card already carries the run's shell_run result — otherwise it
      // renders normally and the tool_result fold below still applies.
      const ref = event.shellRunRef ?? readArgsRef(event.args);
      const suppressed =
        (event.toolName === 'Read' || event.toolName === 'StopBackgroundTask') &&
        !!ref &&
        !!findShellRunParent(state, ref, event.toolUseId);
      state.entries.push({
        kind: 'tool',
        turnId: event.turnId,
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        ...(event.displayName ? { title: event.displayName } : {}),
        ...(event.intent ? { intent: event.intent } : {}),
        // Live Runtime Host frames omit full args; the bounded wire preview
        // still lets the compact row name the call. The turn-end reconcile
        // replaces it with the durable full args.
        input: projectToolActivityArgs(event.toolName, event.args ?? event.argsPreview),
        resultVersion: 0,
        progress: createProgressBuffer(),
        outputDeltas: createOutputBuffer(),
        callStatus: 'running',
        expanded: state.expandAllTools,
        ...(suppressed ? { suppressed: true } : {}),
      });
      break;
    }

    case 'tool_result': {
      const tool = findToolEntry(state, event.toolUseId);
      if (tool?.suppressed && event.contentOmitted && !event.isError) {
        state.entries.splice(state.entries.indexOf(tool), 1);
        break;
      }
      const shellRun = event.content.kind === 'shell_run' ? event.content : undefined;
      const parent = shellRun
        ? findShellRunParent(state, shellRun.ref, event.toolUseId)
        : undefined;
      if (tool && parent && shellRun && !event.isError) {
        applyLiveShellRunResultToParent(state, parent, shellRun);
        if (tool.toolName === 'Read' || tool.toolName === 'StopBackgroundTask') {
          state.entries.splice(state.entries.indexOf(tool), 1);
        } else {
          applyOwnShellRunResult(tool, shellRun, event.durationMs);
        }
        break;
      }
      if (tool) {
        if (tool.suppressed) unsuppressToolAtTail(state, tool);
        tool.callStatus = toolResultActivityStatus(event.isError, event.content);
        if (shellRun) {
          if (tool.toolName === 'Bash') {
            applyShellRunResult(tool, shellRun);
          } else {
            applyOwnShellRunResult(tool, shellRun, event.durationMs);
          }
        } else {
          if (!(event.contentOmitted && tool.result?.kind === 'shell_run')) {
            tool.durationMs = event.durationMs;
          }
          if (!event.contentOmitted) {
            tool.result = event.content;
            tool.resultVersion += 1;
          }
        }
      } else {
        state.entries.push({
          kind: 'tool',
          turnId: event.turnId,
          toolUseId: event.toolUseId,
          toolName: event.toolUseId,
          input: undefined,
          progress: createProgressBuffer(),
          outputDeltas: createOutputBuffer(),
          ...(!event.contentOmitted ? { result: event.content } : {}),
          resultVersion: event.contentOmitted ? 0 : 1,
          durationMs: event.durationMs,
          callStatus: toolResultActivityStatus(event.isError, event.content),
          expanded: state.expandAllTools,
        });
      }
      break;
    }

    case 'tool_progress': {
      const tool = findToolEntry(state, event.toolUseId);
      if (tool) {
        const progress =
          typeof event.chunk === 'string'
            ? event.chunk
            : event.chunk.text
              ? `[${event.chunk.kind}] ${event.chunk.text}`
              : '';
        if (progress) tool.progress.append(progress);
      }
      break;
    }

    case 'tool_result_preview':
      // Live-only open-facts for desktop Open; TUI has no mid-flight Open surface.
      break;

    case 'tool_output_delta': {
      const tool = findToolEntry(state, event.toolUseId);
      if (tool && (event.chunk || event.redacted)) {
        tool.outputDeltas.append({
          seq: event.seq,
          stream: event.stream,
          chunk: event.chunk,
          redacted: event.redacted,
        });
      }
      break;
    }

    case 'sandbox_boundary_request':
      enqueuePendingInteraction(state, event);
      break;
    case 'user_question_request':
      enqueuePendingInteraction(state, event);
      break;

    case 'sandbox_boundary_decision_ack':
      {
        const request = findPendingInteraction(state, event.requestId);
        if (request?.type === 'sandbox_boundary_request') {
          completePendingInteraction(state, event.requestId);
          state.entries.push({
            kind: 'notice',
            level: 'info',
            text: `Access ${event.decision === 'allow' ? 'expanded' : 'unchanged'}`,
          });
        }
      }
      break;

    case 'user_question_answer_ack':
      completePendingInteraction(state, event.requestId);
      break;

    case 'plan_submitted':
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: `Plan submitted: ${event.title}`,
      });
      break;

    case 'steering_message':
      // A user interjection injected mid-turn; render it in place as a user turn.
      appendUserPrompt(
        state,
        event.content.displayText ?? event.content.text,
        event.messageId,
        state.entries.some(
          (entry) =>
            entry.kind === 'user' &&
            entry.messageId === event.messageId &&
            entry.transient === true,
        ),
      );
      break;

    case 'message_admission':
      if (event.outcome === 'retracted') {
        state.entries = state.entries.filter(
          (entry) =>
            entry.kind !== 'user' ||
            entry.transient !== true ||
            entry.messageId !== event.messageId,
        );
      }
      break;

    case 'queue_update':
      // Authoritative snapshot from the runtime; mirror it for the pending bar.
      state.steering = [...event.steering];
      state.followup = [...event.followup];
      break;

    case 'provider_retry':
      state.providerRetry = { event, receivedAtMs: Date.now() };
      break;

    case 'token_usage': {
      accumulateUsage(state.usage, event);
      const notice = contextBudgetOutcomeNotice(event.contextBudget);
      if (notice) {
        state.entries.push({
          kind: 'notice',
          level: notice.level,
          text: notice.text,
        });
      }
      break;
    }

    case 'error':
      clearPendingInteractions(state);
      dropSuppressedTools(state);
      state.entries.push({
        kind: 'notice',
        level: 'error',
        text: event.message,
      });
      break;

    case 'abort':
      clearPendingInteractions(state);
      dropSuppressedTools(state);
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: `Stopped: ${event.reason}`,
      });
      break;

    case 'complete':
      // The turn is over; any unresolved interaction is no longer actionable.
      clearPendingInteractions(state);
      dropSuppressedTools(state);
      if (event.stopReason === 'max_tokens') {
        state.entries.push({
          kind: 'notice',
          level: 'info',
          text: 'Stopped: max tokens',
        });
      }
      if (event.stopReason === 'step_limit') {
        state.entries.push({ kind: 'notice', level: 'info', text: STEP_LIMIT_NOTICE_TEXT });
      }
      break;
  }
}

function storedMessagesToTranscriptEntries(
  messages: readonly StoredMessage[],
): MakaPiTranscriptEntry[] {
  const entries: MakaPiTranscriptEntry[] = [];
  const resultsByToolUseId = new Map(
    messages
      .filter(
        (message): message is Extract<StoredMessage, { type: 'tool_result' }> =>
          message.type === 'tool_result',
      )
      .map((message) => [message.toolUseId, message]),
  );
  const turnStatusById = new Map(
    deriveTurnRecords(messages).map((turn) => [turn.turnId, turn.status]),
  );

  for (const message of messages) {
    switch (message.type) {
      case 'user':
        if (message.origin?.kind === 'legacy_automation') {
          entries.push({ kind: 'legacy_automation', text: message.displayText ?? message.text });
        } else if (message.origin?.kind === 'goal') {
          entries.push({ kind: 'goal_continuation', text: message.displayText ?? message.text });
        } else {
          entries.push({
            kind: 'user',
            messageId: message.id,
            text: message.displayText ?? message.text,
          });
        }
        break;
      case 'assistant': {
        // Stored thinking happened before the reply text, so it resumes above it.
        const thinking = message.thinking?.text;
        if (thinking?.trim()) {
          entries.push({
            kind: 'thinking',
            messageId: message.id,
            text: thinking,
            expanded: false,
          });
        }
        entries.push({ kind: 'assistant', messageId: message.id, text: message.text });
        break;
      }
      case 'tool_call':
        entries.push(
          storedToolToTranscriptEntry(
            message,
            resultsByToolUseId.get(message.id),
            turnStatusById.get(message.turnId),
          ),
        );
        break;
      case 'system_note': {
        const entry = systemNoteToTranscriptEntry(message);
        if (entry) entries.push(entry);
        break;
      }
      case 'tool_result':
      case 'permission_decision':
      case 'token_usage':
      case 'turn_state':
        break;
    }
  }
  return entries;
}

function storedToolToTranscriptEntry(
  call: Extract<StoredMessage, { type: 'tool_call' }>,
  result: Extract<StoredMessage, { type: 'tool_result' }> | undefined,
  turnStatus: ReturnType<typeof deriveTurnRecords>[number]['status'] | undefined,
): MakaPiToolEntry {
  const entry: MakaPiToolEntry = {
    kind: 'tool',
    toolUseId: call.id,
    toolName: call.toolName,
    ...(call.displayName ? { title: call.displayName } : {}),
    input: projectToolActivityArgs(call.toolName, call.args),
    progress: createProgressBuffer(),
    outputDeltas: createOutputBuffer(),
    ...(result ? { result: result.content } : {}),
    resultVersion: result ? 1 : 0,
    ...(result?.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    callStatus: result
      ? toolResultActivityStatus(result.isError, result.content)
      : unfinishedToolActivityStatus(turnStatus),
    expanded: false,
  };
  // A failed call keeps its error status and raw payload: applying the shell_run
  // as the card's own result would let a still-running or settled payload
  // overwrite the error and swallow the failure on replay. This mirrors the live
  // tool_result path, which forces `error` for any errored shell_run result, and
  // is what lets the stored fold below recognize an errored poll by its status.
  if (result?.content.kind === 'shell_run' && !result.isError)
    applyOwnShellRunResult(entry, result.content);
  return entry;
}

function foldStoredShellRunChildren(entries: MakaPiTranscriptEntry[]): MakaPiTranscriptEntry[] {
  const folded: MakaPiTranscriptEntry[] = [];
  for (const entry of entries) {
    // An errored poll never folds: its failed payload must not mutate the parent
    // and its error card must survive replay, mirroring the live path's "failure
    // is never swallowed" invariant.
    if (
      entry.kind === 'tool' &&
      entry.result?.kind === 'shell_run' &&
      entry.callStatus !== 'errored'
    ) {
      const shellRun = entry.result;
      const parent = [...folded]
        .reverse()
        .find(
          (candidate): candidate is MakaPiToolEntry =>
            candidate.kind === 'tool' &&
            candidate.toolName === 'Bash' &&
            candidate.result?.kind === 'shell_run' &&
            candidate.result.ref === shellRun.ref,
        );
      if (parent) {
        applyShellRunResult(parent, shellRun);
        if (entry.toolName === 'Read' || entry.toolName === 'StopBackgroundTask') continue;
      }
    }
    folded.push(entry);
  }
  return folded;
}

export type MakaPiToolPresentationStatus =
  | 'running'
  | 'done'
  | 'error'
  | 'failed'
  | 'aborted'
  | 'detached'
  | 'unavailable';

export function makaPiToolPresentationStatus(entry: MakaPiToolEntry): MakaPiToolPresentationStatus {
  if (entry.result?.kind === 'subagent') return SUBAGENT_PRESENTATION_STATUS[entry.result.status];
  if (entry.result?.kind === 'shell_run') {
    if (entry.callStatus === 'errored') return 'error';
    if (entry.toolName === 'WriteStdin') {
      return entry.result.operation?.kind === 'pty_control' && entry.result.operation.failed
        ? 'error'
        : 'done';
    }
    if (isActiveShellRunStatus(entry.result.status)) {
      return entry.shellRunSource === 'source_owned'
        ? 'detached'
        : entry.shellRunSource === 'unavailable'
          ? 'unavailable'
          : 'running';
    }
    return SHELL_RUN_PRESENTATION_STATUS[entry.result.status];
  }
  return CALL_PRESENTATION_STATUS[entry.callStatus];
}

const CALL_PRESENTATION_STATUS = {
  running: 'running',
  completed: 'done',
  errored: 'error',
  interrupted: 'aborted',
} as const satisfies Record<ToolActivityStatus, MakaPiToolPresentationStatus>;

const SUBAGENT_PRESENTATION_STATUS = {
  completed: 'done',
  failed: 'failed',
  cancelled: 'aborted',
  running: 'running',
  waiting_for_user: 'running',
} as const satisfies Record<
  Extract<ToolResultContent, { kind: 'subagent' }>['status'],
  MakaPiToolPresentationStatus
>;

const SHELL_RUN_PRESENTATION_STATUS = {
  starting: 'running',
  running: 'running',
  completed: 'done',
  cancelled: 'aborted',
  failed: 'failed',
  timed_out: 'failed',
  orphaned: 'failed',
} as const satisfies Record<
  Extract<ToolResultContent, { kind: 'shell_run' }>['status'],
  MakaPiToolPresentationStatus
>;

function applyShellRunResult(
  entry: MakaPiToolEntry,
  result: Extract<ToolResultContent, { kind: 'shell_run' }>,
): boolean {
  const current = entry.result?.kind === 'shell_run' ? entry.result : undefined;
  const merged = mergeShellRunStateWithDiagnostics(current, result, 'cli.transcript');
  if (!merged.changed) return false;
  entry.result = merged.result;
  entry.durationMs = Math.max(
    0,
    (merged.result.completedAt ?? merged.result.updatedAt) - merged.result.startedAt,
  );
  entry.resultVersion += 1;
  return true;
}

function applyOwnShellRunResult(
  entry: MakaPiToolEntry,
  result: Extract<ToolResultContent, { kind: 'shell_run' }>,
  operationDurationMs = entry.durationMs,
): void {
  entry.result = result;
  if (entry.toolName === 'WriteStdin') {
    entry.durationMs = operationDurationMs;
  } else {
    entry.durationMs = Math.max(0, (result.completedAt ?? result.updatedAt) - result.startedAt);
  }
  entry.resultVersion += 1;
}

function systemNoteToTranscriptEntry(
  message: SystemNoteMessage,
): MakaPiTranscriptEntry | undefined {
  const text = systemNoteText(message);
  if (!text) return undefined;
  return {
    kind: 'notice',
    level: message.kind === 'error' ? 'error' : 'info',
    text,
  };
}

function contextBudgetOutcomeNotice(
  contextBudget: ContextBudgetDiagnostic | undefined,
): { level: 'info' | 'error'; text: string } | undefined {
  const failedOpen = contextBudgetFailureNoticeText(contextBudget);
  if (failedOpen) return { level: 'error', text: failedOpen };
  const replaced = contextBudgetNoticeText(contextBudget);
  if (replaced) return { level: 'info', text: replaced };
  return undefined;
}

function contextBudgetNoticeText(
  contextBudget: ContextBudgetDiagnostic | undefined,
): string | undefined {
  const decision = contextBudget?.compactionDecisions?.find(
    (candidate) => candidate.decision === 'replaced',
  );
  if (!contextBudget || !decision) return undefined;
  const kind = decision.boundaryKind ?? 'context';
  const coveredTurns = decision.coveredTurns;
  const coveredEvents = decision.coveredRuntimeEvents;
  const savedTokens =
    decision.estimatedTokensSaved ??
    tokenDelta(contextBudget.estimatedTokensBefore, contextBudget.estimatedTokensAfter);
  const parts = [`Context compacted: ${kind}`];
  if (coveredTurns !== undefined || coveredEvents !== undefined) {
    parts.push(`${coveredTurns ?? '?'} turns / ${coveredEvents ?? '?'} events`);
  }
  if (savedTokens !== undefined && savedTokens > 0)
    parts.push(`saved ~${Math.round(savedTokens)} tokens`);
  return `${parts.join('; ')}.`;
}

function contextBudgetFailureNoticeText(
  contextBudget: ContextBudgetDiagnostic | undefined,
): string | undefined {
  const decision = contextBudget?.compactionDecisions?.find(
    (candidate) => candidate.decision === 'failedOpen',
  );
  const reason = decision?.failOpenReason ?? decision?.reason;
  if (!decision || !reason) return undefined;
  return `Context compaction skipped: ${reason}.`;
}

function tokenDelta(before: number | undefined, after: number | undefined): number | undefined {
  if (before === undefined || after === undefined) return undefined;
  return Math.max(0, before - after);
}

function systemNoteText(message: SystemNoteMessage): string | undefined {
  switch (message.kind) {
    case 'session_start':
    case 'session_resume':
      return undefined;
    case 'mode_change':
      return 'Permission mode changed.';
    case 'model_change':
      return 'Model changed.';
    case 'context_compacted':
      return 'Context compacted to keep this task within the model window.';
    case 'context_compaction_failed_open':
      return 'Context summary failed; the session continued without a new summary.';
    case 'context_provider_dropping':
      return 'The provider is dropping or rewriting context: content was appended but its reported usage did not grow. Declare a context window for this model so Maka compacts first.';
    case 'context_overflow_after_compaction':
      return 'History was compacted and the provider still called this request too large. What remains also carries the system prompt, the tool schemas, the summary and the recent tail; shortening this message is the part you control.';
    case 'context_reported_window_exceeded': {
      const data = message.data as
        | { usedTokens?: unknown; reportedContextWindow?: unknown }
        | undefined;
      const used = typeof data?.usedTokens === 'number' ? data.usedTokens : undefined;
      const reported =
        typeof data?.reportedContextWindow === 'number' ? data.reportedContextWindow : undefined;
      if (used === undefined || reported === undefined) {
        return 'This exchange ran past the context window this model reports, and the provider accepted it anyway.';
      }
      return `This exchange used about ${used} tokens, past the ${reported} this model reports, and the provider accepted it without complaint. Nothing is declared, so Maka does not compact on its own; declare a context window to have it compact first.`;
    }
    case 'context_window_overrun': {
      const data = message.data as
        | { usedTokens?: unknown; declaredContextWindow?: unknown }
        | undefined;
      const used = typeof data?.usedTokens === 'number' ? data.usedTokens : undefined;
      const declared =
        typeof data?.declaredContextWindow === 'number' ? data.declaredContextWindow : undefined;
      if (used === undefined || declared === undefined) {
        return 'This exchange ran past the context window declared for this model.';
      }
      return `This exchange used about ${used} tokens against the declared window of ${declared}: the reply needed more room than was left. Maka compacts before the next request; raise the window if the replies should stay whole.`;
    }
    case 'context_window_suggestion': {
      const data = message.data as
        | { suggestedContextWindow?: unknown; declaredContextWindow?: unknown }
        | undefined;
      const tokens =
        typeof data?.suggestedContextWindow === 'number' ? data.suggestedContextWindow : undefined;
      const declared =
        typeof data?.declaredContextWindow === 'number' ? data.declaredContextWindow : undefined;
      if (tokens === undefined) return 'The provider rejected this request as too large.';
      return declared === undefined
        ? `The provider rejected this request. No context window is declared for this model; the last accepted request was about ${tokens} tokens — declare that as the window so Maka compacts first.`
        : `The provider rejected this request at about ${tokens} tokens, below the declared window of ${declared}. The declaration is likely larger than the provider's window; consider lowering it to ${tokens}.`;
    }
    case 'step_limit':
      return STEP_LIMIT_NOTICE_TEXT;
    case 'error':
      return 'Session recorded an error.';
    case 'abort':
      return 'Session was stopped.';
  }
}

export function renderMakaPiTranscript(
  state: MakaPiTranscriptState,
  metadata: MakaPiTranscriptMetadata,
  width: number,
): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];

  // A fresh session (no history, nothing pending) opens on a welcome block so the
  // first screen greets and orients instead of showing an empty pane. Once the
  // first prompt lands, entries take over and it never renders again.
  if (state.entries.length === 0 && !state.pendingInteraction) {
    return renderWelcomeBlock(safeWidth, metadata.uiLocale ?? 'en');
  }

  const entryFirstLine = new Map<MakaPiTranscriptEntry, number>();
  const viewportTop = state.renderGeometry.viewportTop;
  let previousVisibleEntry: MakaPiTranscriptEntry | undefined;
  for (let i = 0; i < state.entries.length; i += 1) {
    const entry = state.entries[i]!;
    if (entry.kind === 'tool' && entry.suppressed) {
      entryFirstLine.set(entry, lines.length);
      continue;
    }
    // A blank gap separates human-facing boundaries (user/assistant/thinking/
    // notice) and the edges of a tool stack; only consecutive tool entries (the
    // agent-work stack) have no blank line between them. Thinking reads as
    // model output, so it gets the same blank-line breathing room as assistant
    // text rather than packing against the tool rows.
    const continuesStack = entry.kind === 'tool' && previousVisibleEntry?.kind === 'tool';
    if (!continuesStack) lines.push('');
    entryFirstLine.set(entry, lines.length);
    // An entry that sits entirely above the live viewport is in terminal
    // scrollback — freeze its rendered lines (#1135). An entry that straddles
    // the boundary (first line in scrollback, tail still visible) must still
    // re-render: append-only entries (assistant text, tool deltas) only change
    // the visible tail, and pi-tui's `firstChanged` will be inside the
    // viewport, so no full redraw is triggered. An entry with a zero-line
    // cache (e.g. blank thinking) is still off-screen if its first line is
    // above the viewport — it must not suddenly produce lines in scrollback.
    const cachedLines = transcriptEntryRenderCache.get(entry);
    const entryHeight = cachedLines?.lines.length ?? 0;
    const fullyOffScreen =
      lines.length < viewportTop &&
      (entryHeight === 0 || lines.length + entryHeight <= viewportTop);
    lines.push(...renderTranscriptEntryMemoized(entry, safeWidth, fullyOffScreen));
    previousVisibleEntry = entry;
  }
  state.renderGeometry.entryFirstLine = entryFirstLine;

  if (state.pendingInteraction?.type === 'sandbox_boundary_request') {
    lines.push('');
    lines.push(...renderSandboxBoundaryPrompt(state.pendingInteraction, safeWidth));
  }

  return lines;
}

export function completePendingInteraction(
  state: MakaPiTranscriptState,
  requestId: string,
): boolean {
  if (state.pendingInteraction?.requestId === requestId) {
    state.pendingInteraction = state.queuedInteractions.shift();
    return true;
  }
  const index = state.queuedInteractions.findIndex((request) => request.requestId === requestId);
  if (index < 0) return false;
  state.queuedInteractions.splice(index, 1);
  return true;
}

export function activeSandboxBoundaryRequest(
  state: MakaPiTranscriptState,
): SandboxBoundaryRequestEvent | undefined {
  return state.pendingInteraction?.type === 'sandbox_boundary_request'
    ? state.pendingInteraction
    : undefined;
}

export function activeUserQuestionRequest(
  state: MakaPiTranscriptState,
): UserQuestionRequestEvent | undefined {
  return state.pendingInteraction?.type === 'user_question_request'
    ? state.pendingInteraction
    : undefined;
}

function enqueuePendingInteraction(
  state: MakaPiTranscriptState,
  request: MakaPiPendingInteraction,
): void {
  if (findPendingInteraction(state, request.requestId)) return;
  if (!state.pendingInteraction) state.pendingInteraction = request;
  else state.queuedInteractions.push(request);
}

function findPendingInteraction(
  state: MakaPiTranscriptState,
  requestId: string,
): MakaPiPendingInteraction | undefined {
  if (state.pendingInteraction?.requestId === requestId) return state.pendingInteraction;
  return state.queuedInteractions.find((request) => request.requestId === requestId);
}

function clearPendingInteractions(state: MakaPiTranscriptState): void {
  state.pendingInteraction = undefined;
  state.queuedInteractions = [];
}

function dropSuppressedTools(state: MakaPiTranscriptState): void {
  state.entries = state.entries.filter((entry) => entry.kind !== 'tool' || !entry.suppressed);
}

/**
 * Per-entry render cache. The transcript re-renders on every keystroke and
 * stream delta, but only the tail entry actually changes; caching the rendered
 * lines of unchanged entries avoids rebuilding a `Markdown` instance per block
 * on each pass. Keyed by entry identity (a fresh entry object is a cache miss);
 * the signature busts the cache when anything that affects the entry's rendered
 * lines changes (its growing text, tool status, width, or an expansion toggle).
 */
interface TranscriptEntryRender {
  signature: string;
  lines: string[];
  /** Width the cached lines were rendered at, for off-screen freeze matching. */
  width: number;
}

const transcriptEntryRenderCache = new WeakMap<MakaPiTranscriptEntry, TranscriptEntryRender>();

// Returns the cached line array by reference on a hit — callers must treat it as
// read-only (copy the lines into their own buffer rather than mutating in place),
// or a later render would serve corrupted content for that entry. The only
// caller, renderMakaPiTranscript, spreads the lines into its own buffer.
function renderTranscriptEntryMemoized(
  entry: MakaPiTranscriptEntry,
  width: number,
  offScreen: boolean,
): string[] {
  // Off-screen entries live in terminal scrollback, which is immutable: any
  // change to their rendered lines forces pi-tui's differential renderer into a
  // scrollback-clearing full redraw (#1135). Serving the cached render keeps
  // the display consistent with what's already in the terminal. The underlying
  // entry state still updates — only the visual output is frozen. A width
  // change already triggered a pi-tui full redraw (re-anchoring viewportTop to
  // the tail), so a stale-width cache won't be served.
  if (offScreen) {
    const cached = transcriptEntryRenderCache.get(entry);
    if (cached && cached.width === width) return cached.lines;
  }
  const signature = transcriptEntrySignature(entry, width);
  const cached = transcriptEntryRenderCache.get(entry);
  if (cached && cached.signature === signature) return cached.lines;
  const lines = renderTranscriptEntryBlock(entry, width);
  transcriptEntryRenderCache.set(entry, { signature, lines, width });
  return lines;
}

function renderTranscriptEntryBlock(entry: MakaPiTranscriptEntry, width: number): string[] {
  // Keep the conversation stream inside a one-cell gutter. The editor owns
  // the full terminal width, so this makes the two surfaces align without
  // changing any of the individual block renderers' internal prefixes.
  const contentWidth = Math.max(1, width - 2);
  const lines = (() => {
    switch (entry.kind) {
      case 'user':
        return renderUserBlock(entry.text, contentWidth);
      case 'legacy_automation':
        return renderLegacyAutomationBlock(entry.text, contentWidth);
      case 'goal_continuation':
        return renderGoalContinuationBlock(entry.text, contentWidth);
      case 'assistant':
        return renderAssistantBlock(entry.text, contentWidth);
      case 'thinking':
        return renderThinkingBlock(entry, contentWidth, entry.expanded);
      case 'tool':
        return renderToolBlock(entry, contentWidth, entry.expanded);
      case 'notice':
        return renderNotice(entry, contentWidth);
    }
  })();

  // Markdown preserves a final blank paragraph. It should not become part of
  // the block's vertical footprint because renderMakaPiTranscript already
  // inserts the single separator row between entries.
  let end = lines.length;
  while (end > 0 && isBlankTranscriptLine(lines[end - 1]!)) end -= 1;
  return lines.slice(0, end).map((line) => {
    if (isBlankTranscriptLine(line)) return '';
    return fitLine(` ${line}`, width);
  });
}

function isBlankTranscriptLine(line: string): boolean {
  return line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim().length === 0;
}

function transcriptEntrySignature(entry: MakaPiTranscriptEntry, width: number): string {
  switch (entry.kind) {
    // User text is immutable, so length is a safe change key.
    case 'user':
      return `user|${width}|${entry.text.length}`;
    case 'legacy_automation':
      return `legacy_automation|${width}|${entry.text}`;
    case 'goal_continuation':
      return `goal_continuation|${width}|${entry.text}`;
    case 'assistant':
      // text_complete authoritatively replaces streamed text, including with a
      // same-length final, so the full value must participate in the cache key.
      return `assistant|${width}|${entry.text}`;
    case 'thinking':
      // Not just the length: `thinking_complete` can replace the streamed text
      // in place with a same-length final, which a length-only key would miss and
      // then serve stale reasoning from the cache. Key on the full text.
      return `thinking|${width}|${entry.expanded ? 1 : 0}|${entry.text}`;
    case 'notice':
      return `notice|${width}|${entry.level}|${entry.text.length}`;
    case 'tool':
      // A tool entry mutates in place as it runs: its derived presentation and
      // duration change, progress/output deltas append, and resultVersion
      // advances whenever durable detail or a resource revision is accepted.
      // Count those facts instead of duplicating the result rendering contract.
      return [
        'tool',
        width,
        entry.expanded ? 1 : 0,
        makaPiToolPresentationStatus(entry),
        entry.durationMs ?? '',
        entry.title ?? entry.toolName,
        entry.progress.version,
        entry.outputDeltas.version,
        entry.resultVersion,
      ].join('|');
  }
}

/**
 * The one CLI label for a permission mode, shared by the status line, the
 * picker header, and the mode-change notice (#1611). `explore` is a real
 * boundary a resumed session can be in, so it must be nameable here; legacy
 * `execute` has no boundary of its own and reads as Auto, as does anything
 * else this metadata ever carries.
 */
export function permissionModeLabel(mode: string): string {
  if (mode === 'bypass') return 'Full access';
  if (mode === 'explore') return 'Read only';
  return 'Auto';
}

export function renderMakaPiStatusLine(metadata: MakaPiTranscriptMetadata, width: number): string {
  const safeWidth = Math.max(1, width);
  if (metadata.sideConversation?.view === 'side') {
    return fitLine(ansi.dim(sideConversationStatusLineText(metadata.sideConversation)), safeWidth);
  }
  const sep = ansi.dim(' · ');
  // #3421: segments carry a dropRank so overflow drops whole low-value
  // segments instead of cutting the chain mid-token from the right.
  // Lower ranks drop first; segments without a rank never drop:
  // title, permission mode and goal are safety-relevant, ctx is the
  // context budget, model is the session's identity.
  const parts: MakaPiStatusLineSegment[] = [
    {
      text: ansi.bold(metadata.title),
      compactRank: 1,
      shortenedText: ansi.bold(fitLine(metadata.title, 7)),
    },
    {
      text: ansi.dim(permissionModeLabel(metadata.permissionMode)),
      compactRank: 4,
      shortenedText: ansi.dim(compactPermissionModeLabel(metadata.permissionMode)),
    },
    {
      text: ansi.dim(metadata.model),
      compactRank: 0,
      shortenedText: ansi.dim(fitLine(metadata.model, 11)),
    },
  ];
  if (metadata.sideConversation?.view === 'parent') {
    parts.push({
      text: ansi.dim(sideConversationStatusLineText(metadata.sideConversation)),
      dropRank: 4,
    });
  }
  // #1064: omit thinking:default — it is noise before the user explicitly
  // changes the level. Only a non-default, explicitly set level shows.
  if (metadata.thinkingLevel) {
    parts.push({ text: ansi.dim(`thinking:${metadata.thinkingLevel}`), dropRank: 3 });
  }
  if (metadata.orchestrationMode === 'swarm') {
    parts.push({ text: ansi.accent('swarm'), dropRank: 4 });
  } else if (metadata.orchestrationMode === 'graph') {
    parts.push({ text: ansi.accent('graph'), dropRank: 4 });
  }
  // An autonomous goal burns tokens between prompts; it must never be
  // invisible. Terminal goals show nothing (the desktop chip hides them too).
  if (metadata.goal && isLiveGoalStatus(metadata.goal.status)) {
    const text = goalStatusLineText(metadata.goal, Date.now());
    const compactStatus =
      metadata.goal.status === 'active' ? '' : metadata.goal.status === 'paused' ? 'p' : 'w';
    const compactText = `g${compactStatus}${metadata.goal.iterations}/${metadata.goal.maxIterations}`;
    // paused gets warning salience: the loop stopped burning but stays armed
    // and resumable, which the user must not miss. waiting is a normal
    // transient between turns, so it stays dim like the other chrome.
    parts.push({
      text:
        metadata.goal.status === 'active'
          ? ansi.accent(text)
          : metadata.goal.status === 'paused'
            ? ansi.yellow(text)
            : ansi.dim(text),
      compactRank: 3,
      shortenedText:
        metadata.goal.status === 'active'
          ? ansi.accent(fitLine(compactText, 8))
          : metadata.goal.status === 'paused'
            ? ansi.yellow(fitLine(compactText, 8))
            : ansi.dim(fitLine(compactText, 8)),
    });
  }
  const usage = metadata.usage;
  // ctx segment: only show "used" when contextRemaining is available, since
  // token_usage.input is a billing-cumulative sum across tool-loop steps,
  // not the last request's context size. Using it as a proxy for "used"
  // would produce misleading percentages (potentially >100%).
  const contextRemaining = usage?.contextRemaining;
  if (metadata.modelContextWindow !== undefined && contextRemaining !== undefined) {
    const used = Math.max(0, metadata.modelContextWindow - contextRemaining);
    const pct = Math.round((used / metadata.modelContextWindow) * 100);
    // #1064: color warning — yellow >80%, red >95%, dim otherwise.
    const ctxColor = pct > 95 ? ansi.red : pct > 80 ? ansi.yellow : ansi.dim;
    parts.push({
      text: ctxColor(
        `ctx ${formatTokenCount(used)}/${formatTokenCount(metadata.modelContextWindow)} ${pct}%`,
      ),
      compactRank: 2,
      shortenedText: ctxColor(`c${pct}%`),
    });
  } else if (metadata.modelContextWindow !== undefined) {
    // #3371: the window is known but no usage has arrived yet (fresh session,
    // or the provider doesn't report per-step input tokens). Degrade
    // explicitly, pi-style, instead of hiding the segment silently — the user
    // can then tell "not measured yet" apart from "window unknown".
    parts.push({
      text: ansi.dim(`ctx ?/${formatTokenCount(metadata.modelContextWindow)}`),
      compactRank: 2,
      shortenedText: ansi.dim('c?'),
    });
  }
  if (usage) {
    if (usage.costUsd > 0) {
      parts.push({ text: ansi.dim(`$${formatCost(usage.costUsd)}`), dropRank: 1 });
    }
    const totalCache = usage.cacheHitInput + usage.cacheMissInput;
    if (totalCache > 0) {
      const hitRate = Math.round((usage.cacheHitInput / totalCache) * 100);
      parts.push({ text: ansi.dim(`cache ${hitRate}%`), dropRank: 0 });
    }
  }
  parts.push({ text: ansi.dim(metadata.connectionSlug), dropRank: 2 });
  // #1064: shorten cwd to ~-relative path instead of the full path.
  const cwd = shortenCwd(metadata.cwd);
  // cwd degrades progressively (full → basename → dropped), after every
  // ranked segment above but before the final truncation fallback. A drive
  // root (C:\) or filesystem root has no useful basename — empty, or the
  // path itself — so it drops directly instead of rendering an empty
  // segment after the separator.
  const cwdBase = basename(cwd);
  parts.push({
    text: ansi.dim(cwd),
    dropRank: 5,
    shortenedText: cwdBase === '' || cwdBase === cwd ? undefined : ansi.dim(cwdBase),
  });
  return fitStatusLine(parts, sep, safeWidth);
}

interface MakaPiStatusLineSegment {
  text: string;
  /** Overflow drops whole segments lowest-rank-first; undefined never drops. */
  dropRank?: number;
  /** Critical segments shorten in this order after every droppable segment is gone. */
  compactRank?: number;
  /** Progressive fallback tried before this segment is dropped entirely. */
  shortenedText?: string;
}

function fitStatusLine(segments: MakaPiStatusLineSegment[], sep: string, width: number): string {
  const compactSep = ansi.dim(' ');
  let activeSep = sep;
  const lineWidth = (segs: MakaPiStatusLineSegment[]): number =>
    visibleWidth(segs.map((segment) => segment.text).join(activeSep));
  let kept = segments;
  // Drop whole low-value segments, lowest rank first, re-checking after each
  // rank so the fewest possible segments are sacrificed.
  while (lineWidth(kept) > width) {
    const dropRanks = kept.flatMap((segment) =>
      segment.dropRank !== undefined ? [segment.dropRank] : [],
    );
    if (dropRanks.length > 0) {
      const lowest = Math.min(...dropRanks);
      // A droppable segment with a shortened form degrades before disappearing.
      const shorten = kept.find(
        (segment) => segment.dropRank === lowest && segment.shortenedText !== undefined,
      );
      if (shorten) {
        kept = kept.map((segment) =>
          segment === shorten
            ? { ...segment, text: segment.shortenedText ?? segment.text, shortenedText: undefined }
            : segment,
        );
      } else {
        kept = kept.filter((segment) => segment.dropRank !== lowest);
      }
      continue;
    }

    const compactRanks = kept.flatMap((segment) =>
      segment.compactRank !== undefined && segment.shortenedText !== undefined
        ? [segment.compactRank]
        : [],
    );
    if (compactRanks.length === 0) break;
    const nextRank = Math.min(...compactRanks);
    const shorten = kept.find(
      (segment) => segment.compactRank === nextRank && segment.shortenedText !== undefined,
    );
    if (!shorten) break;
    kept = kept.map((segment) =>
      segment === shorten
        ? { ...segment, text: segment.shortenedText ?? segment.text, shortenedText: undefined }
        : segment,
    );
    // Once critical values compact, reclaim separator chrome too. At widths
    // below the compact critical seam, fitLine remains the honest fallback.
    activeSep = compactSep;
  }
  return fitLine(kept.map((segment) => segment.text).join(activeSep), width);
}

function compactPermissionModeLabel(mode: string): string {
  if (mode === 'bypass') return 'Full';
  if (mode === 'explore') return 'Read';
  return 'Auto';
}

function sideConversationStatusLineText(
  side: NonNullable<MakaPiTranscriptMetadata['sideConversation']>,
): string {
  if (side.view === 'parent') return 'Ctrl+/ for side';
  const status = side.parentStatus?.replaceAll('_', ' ');
  return [
    'Side from main thread',
    ...(status ? [`main ${status}`] : []),
    'Ctrl+/ to switch',
    'Ctrl+C to close',
  ].join(' · ');
}

/**
 * One-line activity strip shown between the transcript and the editor.
 * Renders `Working… <elapsed>` while a turn runs, or a blank reserved row when idle
 * so the layout does not jump when a turn starts or ends.
 */
export function renderMakaPiActivityStrip(
  metadata: MakaPiTranscriptMetadata,
  width: number,
): string {
  const safeWidth = Math.max(1, width);
  if (metadata.providerRetry) {
    const { event: retry, receivedAtMs } = metadata.providerRetry;
    const text =
      retry.phase === 'scheduled'
        ? `Retrying in ${formatRetryCountdown(retry, receivedAtMs)} (${retry.attempt}/${retry.maxAttempts})`
        : `Retrying (${retry.attempt}/${retry.maxAttempts})`;
    return fitLine(ansi.dim(text), safeWidth);
  }
  if (metadata.turnElapsedMs === undefined) return '';
  return fitLine(ansi.dim(`Working… ${formatElapsedDuration(metadata.turnElapsedMs)}`), safeWidth);
}

/**
 * Remaining wait for a scheduled provider retry, ticked against the client's
 * own receipt time so the strip counts down on the 1s heartbeat instead of
 * pinning the original delay for the whole sleep. The computation itself is
 * shared with the desktop banner in `@maka/core/provider-retry-countdown`.
 * Long provider-mandated waits (a subscription quota window can be hours)
 * render as `4h 28m 3s` via the shared duration formatter rather than a raw
 * five-digit second count.
 */
function formatRetryCountdown(retry: ProviderRetryScheduledEvent, receivedAtMs: number): string {
  const seconds = providerRetryDisplaySeconds(retry, Date.now() - receivedAtMs);
  return formatElapsedDuration(seconds * 1_000);
}

function formatElapsedDuration(elapsedMs: number): string {
  let remainingSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const units = [
    ['d', 86_400],
    ['h', 3_600],
    ['m', 60],
  ] as const;
  const parts: string[] = [];

  for (const [suffix, secondsPerUnit] of units) {
    const value = Math.floor(remainingSeconds / secondsPerUnit);
    if (value > 0) {
      parts.push(`${value}${suffix}`);
      remainingSeconds %= secondsPerUnit;
    }
  }

  if (remainingSeconds > 0 || parts.length === 0) parts.push(`${remainingSeconds}s`);
  return parts.join(' ');
}

/**
 * Pending-queue bar shown above the editor while messages are queued. Each
 * steering message reads `Steering: <text>` (injected into the running turn at
 * the next step boundary); each followup reads `Queued: <text>` (opens the next
 * turn). A trailing hint reminds the user that alt+↑ takes them back to edit.
 * Renders nothing when both queues are empty.
 */
interface TuiPendingQueueCopy {
  readonly steeringLabel: string;
  readonly queuedLabel: string;
  readonly requeueHint: string;
}

const TUI_PENDING_QUEUE_COPY = resolveUiMessageCatalog(
  defineUiMessageCatalog<TuiPendingQueueCopy>()(TUI_COPY_RESOURCES['pending-queue']),
);

export function renderMakaPiPendingQueue(
  state: MakaPiTranscriptState,
  width: number,
  platform: NodeJS.Platform,
  locale: UiLocale,
): string[] {
  if (state.steering.length === 0 && state.followup.length === 0) {
    return [];
  }
  const copy = TUI_PENDING_QUEUE_COPY[locale];
  const safeWidth = Math.max(1, width);
  const steering = state.steering;
  const followup = state.followup;
  const lines: string[] = [];
  for (const text of steering) {
    lines.push(
      fitLine(`${ansi.accent(copy.steeringLabel)} ${ansi.dim(firstLinePreview(text))}`, safeWidth),
    );
  }
  for (const text of followup) {
    lines.push(
      fitLine(`${ansi.dim(copy.queuedLabel)} ${ansi.dim(firstLinePreview(text))}`, safeWidth),
    );
  }
  lines.push(fitLine(ansi.dim(renderTuiShortcutCopy(copy.requeueHint, platform)), safeWidth));
  return lines;
}

/**
 * First non-empty line of a queued message, trimmed for a one-line preview.
 *
 * `limitText` appends its truncation suffix behind a newline, so its output is
 * multi-line whenever the cap trips. Each element the pending-bar returns must
 * occupy exactly one terminal row — pi-tui writes them between explicit \r\n
 * separators and counts one row each, so an embedded newline shifts every
 * later row down while the diff accounting still believes one row was written
 * (#3824). `fitLine` cannot catch it: visibleWidth treats controls as
 * zero-width. Sibling call sites collapse the same output the same way.
 */
function firstLinePreview(text: string): string {
  const line =
    text
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? '';
  return collapseToSingleLine(limitText(line, 200));
}

/**
 * Shorten an absolute path to a `~`-relative form for the statusline.
 * `/Users/alice/workspace/project` → `~/workspace/project`.
 * Falls back to the original path if it is not under the home directory.
 * Comparison runs through `path.relative`, so Windows profile paths and
 * case-only differences shorten as well; the remainder keeps its native
 * separators (`~/Videos\Clips` on Windows).
 */
export function shortenCwd(cwd: string, homeDir?: string): string {
  const home = homeDir ?? homedir();
  if (!home) return cwd;
  const rel = relative(home, cwd);
  if (rel === '') return '~';
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    return cwd;
  }
  return `~/${rel}`;
}

function formatCost(costUsd: number): string {
  if (costUsd < 0.01) return '<0.01';
  return costUsd.toFixed(2);
}

function appendAssistantText(state: MakaPiTranscriptState, messageId: string, text: string): void {
  const last = state.entries[state.entries.length - 1];
  if (last?.kind === 'assistant' && last.messageId === messageId) {
    last.text += text;
    return;
  }
  state.entries.push({ kind: 'assistant', messageId, text });
}

function setAssistantText(state: MakaPiTranscriptState, messageId: string, text: string): boolean {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (entry?.kind === 'assistant' && entry.messageId === messageId) {
      entry.text = text;
      return true;
    }
  }
  return false;
}

function appendThinking(state: MakaPiTranscriptState, messageId: string, text: string): void {
  const last = state.entries[state.entries.length - 1];
  if (last?.kind === 'thinking' && last.messageId === messageId) {
    last.text += text;
    return;
  }
  state.entries.push({ kind: 'thinking', messageId, text, expanded: state.expandAllThinking });
}

function setThinking(state: MakaPiTranscriptState, messageId: string, text: string): void {
  // thinking_complete can arrive after the reply text or tool events; replace
  // the streamed entry wherever it sits instead of appending a duplicate.
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (entry?.kind === 'thinking' && entry.messageId === messageId) {
      entry.text = text;
      return;
    }
  }
  state.entries.push({ kind: 'thinking', messageId, text, expanded: state.expandAllThinking });
}

// Thinking stays collapsed to a one-line marker by default so reasoning
// never floods the scrollback; Ctrl+T expands every thinking entry on demand.
function renderThinkingBlock(
  entry: MakaPiThinkingEntry,
  width: number,
  expanded: boolean,
): string[] {
  if (!entry.text.trim()) return [];
  if (!expanded) return [fitLine(ansi.dim('Thinking…'), width)];
  const lines = [fitLine(ansi.dim('Thinking'), width)];
  lines.push(...renderIndented(entry.text, width, 2).map((line) => fitLine(ansi.dim(line), width)));
  return lines;
}

type MakaPiAssistantEntry = Extract<MakaPiTranscriptEntry, { kind: 'assistant' }>;
type MakaPiThinkingEntry = Extract<MakaPiTranscriptEntry, { kind: 'thinking' }>;

export type MakaPiToolEntry = Extract<MakaPiTranscriptEntry, { kind: 'tool' }>;
type MakaPiNoticeEntry = Extract<MakaPiTranscriptEntry, { kind: 'notice' }>;

function findToolEntry(
  state: MakaPiTranscriptState,
  toolUseId: string,
): MakaPiToolEntry | undefined {
  return [...state.entries]
    .reverse()
    .find(
      (entry): entry is MakaPiToolEntry => entry.kind === 'tool' && entry.toolUseId === toolUseId,
    );
}

function unsuppressToolAtTail(state: MakaPiTranscriptState, tool: MakaPiToolEntry): void {
  tool.suppressed = undefined;
  const index = state.entries.indexOf(tool);
  if (index < 0 || index === state.entries.length - 1) return;
  state.entries.splice(index, 1);
  state.entries.push(tool);
}

function isShellRunToolCard(tool: MakaPiToolEntry): boolean {
  return tool.toolName === 'Bash' || tool.userOwned === true;
}

function createProgressBuffer(): BoundedChunkBuffer<string> {
  return new BoundedChunkBuffer({
    maxChars: LIVE_TOOL_BUFFER_MAX_CHARS,
    maxChunks: LIVE_TOOL_BUFFER_MAX_CHUNKS,
    textOf: (chunk) => chunk,
    withText: (_chunk, text) => text,
  });
}

function createOutputBuffer(): BoundedChunkBuffer<MakaPiToolOutputDelta> {
  return new BoundedChunkBuffer({
    maxChars: LIVE_TOOL_BUFFER_MAX_CHARS,
    maxChunks: LIVE_TOOL_BUFFER_MAX_CHUNKS,
    textOf: (delta) => delta.chunk,
    withText: (delta, chunk) => ({ ...delta, chunk }),
    sequence: (delta) => delta.seq,
  });
}

function findShellRunParent(
  state: MakaPiTranscriptState,
  ref: string,
  childToolUseId: string,
): MakaPiToolEntry | undefined {
  return [...state.entries]
    .reverse()
    .find(
      (entry): entry is MakaPiToolEntry =>
        entry.kind === 'tool' &&
        entry.toolName === 'Bash' &&
        entry.toolUseId !== childToolUseId &&
        entry.result?.kind === 'shell_run' &&
        entry.result.ref === ref,
    );
}

/** The runtime-resource ref a tool call is aimed at, when the args carry one. */
function readArgsRef(args: unknown): string | undefined {
  const ref =
    args !== null && typeof args === 'object' ? (args as { ref?: unknown }).ref : undefined;
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined;
}

/**
 * A card whose run resource is still `running`. The transition is keyed on the
 * resource status, not the presentation status: an inherited run is shown as
 * `detached` while its resource keeps running, and its settle must still
 * announce. Replay stays silent via the `announceSettle: false` hydration option
 * and because stored replay never routes through the notice path.
 */
function isLiveShellRunCard(entry: MakaPiToolEntry | undefined): boolean {
  return entry?.result?.kind === 'shell_run' && isActiveShellRunStatus(entry.result.status);
}

/**
 * Apply a live result to a parent Bash card, announcing a running → settled
 * transition exactly once. Shared by both poll paths (folded at tool_start and
 * the tool_result fold) so a settle observed through the model's polling
 * notifies the same way as the event-driven update.
 */
function applyLiveShellRunResultToParent(
  state: MakaPiTranscriptState,
  parent: MakaPiToolEntry,
  result: Extract<ToolResultContent, { kind: 'shell_run' }>,
): void {
  const wasLive = isLiveShellRunCard(parent);
  applyShellRunResult(parent, result);
  if (wasLive && isSettledShellRunCard(parent)) pushShellRunSettledNotice(state, parent);
}

function isSettledShellRunCard(entry: MakaPiToolEntry): boolean {
  return entry.result?.kind === 'shell_run' && !isActiveShellRunStatus(entry.result.status);
}

/**
 * Announce a live running → settled transition at the transcript tail: the
 * card flip itself happens wherever the card sits in the scrollback, which is
 * usually off-screen by the time a long task ends. Only live transitions fire
 * — a run first seen settled (own result, stored replay) stays silent, so a
 * settle reported twice (event + folded poll) notifies exactly once.
 */
function pushShellRunSettledNotice(state: MakaPiTranscriptState, entry: MakaPiToolEntry): void {
  const result = entry.result?.kind === 'shell_run' ? entry.result : undefined;
  if (!result) return;
  const failed =
    result.status === 'failed' || result.status === 'timed_out' || result.status === 'orphaned';
  const verb =
    result.status === 'completed'
      ? 'completed'
      : result.status === 'cancelled'
        ? 'stopped'
        : result.status === 'timed_out'
          ? 'timed out'
          : result.status;
  const parts: string[] = [];
  if (result.exitCode !== undefined) parts.push(`exit ${result.exitCode}`);
  const secs = Math.round((entry.durationMs ?? 0) / 1000);
  if (secs >= 1) parts.push(`${secs}s`);
  const suffix = parts.length > 0 ? ` (${parts.join(' · ')})` : '';
  const failure =
    failed && result.failureMessage ? ` — ${result.failureMessage.split('\n', 1)[0]}` : '';
  state.entries.push({
    kind: 'notice',
    level: failed ? 'error' : 'info',
    text: `Background task ${verb}: ${result.cmd.split('\n', 1)[0]}${suffix}${failure}`,
  });
}

/** A user turn: a dim `>` quote prefix per line, no speaker label. */
function renderUserBlock(text: string, width: number): string[] {
  if (!text.trim()) return [];
  const prefix = ansi.dim('>');
  // renderIndented reserves a 2-column gutter; reuse it and swap the two
  // leading spaces for `> ` so wrapped lines stay aligned under the prefix.
  return renderIndented(text, width, 2).map((line) => fitLine(`${prefix} ${line.slice(2)}`, width));
}

/** Provenance header + indented body for non-human-authored prompts. */
function renderProvenanceBlock(
  label: string,
  accent: boolean,
  text: string,
  width: number,
): string[] {
  if (!text.trim()) return [];
  const styled = accent ? ansi.accent(label) : ansi.dim(label);
  return [
    fitLine(styled, width),
    ...renderIndented(text, width, 2).map((line) => fitLine(line, width)),
  ];
}

function renderLegacyAutomationBlock(text: string, width: number): string[] {
  return renderProvenanceBlock('Legacy Automation (history only)', false, text, width);
}

function renderGoalContinuationBlock(text: string, width: number): string[] {
  return renderProvenanceBlock('Goal continuation (autonomous)', true, text, width);
}

/** An assistant turn: bare markdown prose, no speaker label or indent. */
function renderAssistantBlock(text: string, width: number): string[] {
  if (!text.trim()) return [];
  return new Markdown(text, 0, 0, markdownTheme, undefined, { preserveOrderedListMarkers: true })
    .render(width)
    .map((line) => fitLine(line, width));
}

function renderNotice(entry: MakaPiNoticeEntry, width: number): string[] {
  const label = entry.level === 'error' ? ansi.red('Error') : ansi.dim('Note');
  return renderIndented(`${label}: ${entry.text}`, width, 0).map((line) => fitLine(line, width));
}

// Shown on a fresh, empty session. Greets with the branded maka wordmark and a
// short tagline, then points at the command-center entry points (direct input,
// /session, /model, /setup) — enough to start without reading docs.
// Five-line lowercase ASCII maka wordmark in Maka blue (#1098, #3661). Pure ASCII so it
// renders under any locale; stored without trailing spaces so the welcome lines
// and their tests agree after rtrim. A terminal too narrow to fit it falls back
// to a single `maka` line — see renderWelcomeBlock.
const MAKA_WORDMARK_LINES = [
  '                  _',
  '  _ __ ___   __ _| | ____ _',
  " | '_ ` _ \\ / _` | |/ / _` |",
  ' | | | | | | (_| |   < (_| |',
  ' |_| |_| |_|\\__,_|_|\\_\\__,_|',
];
const MAKA_WORDMARK_WIDTH = Math.max(...MAKA_WORDMARK_LINES.map((line) => line.length));

function renderWelcomeBlock(width: number, locale: UiLocale): string[] {
  // The branded home greets with the maka wordmark, a short localized tagline,
  // and the command-center entry points (direct input, /session,
  // /model, /setup) so a fresh session shows the main actions without typing
  // `/`. The active model and connection live in the statusline, so the
  // welcome does not repeat them.
  const copy = getTuiPrimaryGuidance(locale).welcome;
  const hints: [string, string][] = [
    ['/session', copy.session],
    ['/model', copy.model],
    ['/setup', copy.setup],
  ];
  const keyWidth = Math.max(...hints.map(([key]) => key.length));
  const lines: string[] = [];
  if (width < MAKA_WORDMARK_WIDTH) {
    lines.push(fitLine(ansi.accent('maka'), width));
  } else {
    for (const line of MAKA_WORDMARK_LINES) {
      lines.push(fitLine(ansi.accent(line), width));
    }
  }
  lines.push('');
  lines.push(fitLine(ansi.dim(copy.tagline), width));
  lines.push('');
  lines.push(fitLine(`  ${copy.start}`, width));
  for (const [key, description] of hints) {
    lines.push(fitLine(ansi.dim(`  ${key.padEnd(keyWidth)}  ${description}`), width));
  }
  return lines;
}

function renderSandboxBoundaryPrompt(
  request: SandboxBoundaryRequestEvent,
  width: number,
): string[] {
  const lines = [
    fitLine(ansi.yellow('Allow access outside the workspace?'), width),
    ...renderIndented(request.justification, width, 2),
  ];
  for (const entry of request.expansion.filesystem?.entries ?? []) {
    lines.push(...renderIndented(`${entry.access} ${entry.scope} ${entry.path}`, width, 2));
  }
  if (request.expansion.network?.enabled) {
    lines.push(...renderIndented('network enabled', width, 2));
  }
  lines.push(
    fitLine(
      `${ansi.bold('y')}${ansi.dim('/Enter allow for this task')}  ${ansi.bold('n')}${ansi.dim('/Esc deny')}`,
      width,
    ),
  );
  return lines;
}
