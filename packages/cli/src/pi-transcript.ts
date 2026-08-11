import { Markdown } from '@earendil-works/pi-tui';
import type {
  ProviderRetryEvent,
  SandboxBoundaryRequestEvent,
  UserQuestionRequestEvent,
  SessionEvent,
  ToolOutputStream,
  ToolResultContent,
} from '@maka/core/events';
import {
  STEP_LIMIT_NOTICE_TEXT,
  type StoredMessage,
  type SystemNoteMessage,
} from '@maka/core/session';
import type { ContextBudgetDiagnostic } from '@maka/core/usage-stats/types';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import { isActiveShellRunStatus } from '@maka/core/shell-run';
import { mergeShellRunStateWithDiagnostics } from '@maka/core/shell-run-result';
import { projectToolActivityArgs } from '@maka/core/tool-activity-args';
import { type ShellRunUpdate } from '@maka/core/events';
import { homedir } from 'node:os';
import {
  materializeSession,
  type ChatItem,
  type ToolActivityItem,
} from '@maka/runtime/materializer';
import type { MakaSessionDriver } from './session-driver.js';
import { BoundedChunkBuffer } from './bounded-chunk-buffer.js';
import { ansi } from './tui-ansi.js';
import {
  fitLine,
  formatToolResultContent,
  formatUnknown,
  limitText,
  markdownTheme,
  renderIndented,
} from './pi-transcript-format.js';
import { renderToolBlock } from './pi-transcript-tools.js';

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
   * into a scrollback-clearing full redraw (#1097). In-memory only; never
   * persisted to storage. Resume resets both to collapsed.
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
  /**
   * Ref polls folded at `tool_start`, childToolUseId → card facts. A Read /
   * StopBackgroundTask aimed at a ref a visible Bash card owns is internal
   * polling: it never renders a row, and its result folds straight into the
   * parent. The facts survive only so an errored poll can surface as a normal
   * card instead of being swallowed.
   */
  pendingShellRunPolls: Map<string, MakaPiPendingShellRunPoll>;
  /** Aggregated token usage for statusline display; reset on session switch. */
  usage: MakaPiUsageSummary;
  /**
   * Read-only mirror of the runtime's authoritative pending queues, driven by
   * `queue_update` events and enqueue results. Rendered as the pending bar above
   * the editor; never the source of truth (the runtime owns that).
   */
  steering: string[];
  followup: string[];
  /**
   * Messages whose enqueue hit the no-live-owner fallback while a turn was
   * running (the begin window). CLI-owned, NOT a runtime mirror: the runner
   * retries the original enqueue until it lands and flushes any remainder
   * into the next turn at the turn boundary, so the text is never dropped.
   * Rendered in the pending bar alongside the mirror.
   */
  pendingFallback: Array<{ text: string; enqueue: 'steer' | 'queue' }>;
  /** Current non-durable provider retry progress for the activity strip. */
  providerRetry?: ProviderRetryEvent;
}

export type MakaPiPendingInteraction = SandboxBoundaryRequestEvent | UserQuestionRequestEvent;

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

/** Facts kept from a folded poll's `tool_start` so an errored result can still materialize a proper card. */
export interface MakaPiPendingShellRunPoll {
  toolName: string;
  title?: string;
  input: unknown;
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
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; messageId: string; text: string }
  | { kind: 'thinking'; messageId: string; text: string; expanded: boolean }
  | {
      kind: 'tool';
      /** Present for live events so terminal reconciliation is turn-scoped. */
      turnId?: string;
      toolUseId: string;
      toolName: string;
      title?: string;
      input: unknown;
      /** Structured result; preferred over `output` when present. */
      result?: ToolResultContent;
      /** Flattened result text, kept as a fallback for text/json/unknown kinds. */
      output?: string;
      /** In-memory revision for render-cache invalidation when a result is replaced. */
      resultVersion: number;
      progress: BoundedChunkBuffer<string>;
      outputDeltas: BoundedChunkBuffer<MakaPiToolOutputDelta>;
      durationMs?: number;
      status: 'running' | 'done' | 'error' | 'failed' | 'aborted' | 'detached' | 'unavailable';
      /** Expanded card view; stamped from expandAllTools, retargeted by Ctrl+O. */
      expanded: boolean;
      /**
       * Set when a successful shell-run poll is folded into its parent while
       * off-screen: the entry cannot be spliced (that would shift line numbers
       * and clear scrollback), but it must not render as an independent card
       * on a future full redraw. A hidden entry contributes zero lines.
       */
      hidden?: boolean;
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
  providerRetry?: ProviderRetryEvent;
}

export function createMakaPiTranscriptState(): MakaPiTranscriptState {
  return {
    entries: [],
    queuedInteractions: [],
    expandAllTools: false,
    expandAllThinking: false,
    renderGeometry: { entryFirstLine: undefined, viewportTop: 0 },
    pendingShellRunPolls: new Map(),
    usage: { costUsd: 0, cacheHitInput: 0, cacheMissInput: 0 },
    steering: [],
    followup: [],
    pendingFallback: [],
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

export function appendUserPrompt(state: MakaPiTranscriptState, text: string): void {
  state.entries.push({ kind: 'user', text });
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
    if (entry.kind !== 'tool' || entry.status !== 'running' || entry.result?.kind !== 'shell_run')
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
  if (tool && wasLive && isSettledShellRunCard(tool) && options?.announceSettle !== false) {
    pushShellRunSettledNotice(state, tool);
  }
  if (
    !tool ||
    tool.toolName !== 'Bash' ||
    tool.result?.kind !== 'shell_run' ||
    tool.result.ref !== update.result.ref ||
    !isActiveShellRunStatus(tool.result.status)
  )
    return applied;
  const status =
    update.ownership.kind === 'local'
      ? 'running'
      : update.ownership.kind === 'source_owned'
        ? 'detached'
        : 'unavailable';
  if (tool.status === status) return applied;
  tool.status = status;
  return true;
}

export function applyShellRunUpdateToTranscript(
  state: MakaPiTranscriptState,
  sourceToolCallId: string,
  update: Extract<ToolResultContent, { kind: 'shell_run' }>,
): boolean {
  const tool = findToolEntry(state, sourceToolCallId);
  if (!tool || tool.toolName !== 'Bash') return false;
  if (tool.result?.kind === 'shell_run' && tool.result.ref !== update.ref) return false;
  return applyShellRunResult(tool, update);
}

export function replaceTranscriptWithStoredMessages(
  state: MakaPiTranscriptState,
  messages: readonly StoredMessage[],
): void {
  const view = materializeSession(messages);
  state.entries = foldStoredShellRunChildren(view.items.flatMap(chatItemToTranscriptEntries));
  clearPendingInteractions(state);
  state.pendingShellRunPolls.clear();
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
  state.pendingFallback = [];
  for (const msg of messages) {
    if (msg.type === 'token_usage') accumulateUsage(state.usage, msg);
  }
}

/**
 * Fill durable tool details that are intentionally absent from Runtime Host
 * live events without applying session-switch reset semantics.
 */
export function reconcileToolsWithStoredMessages(
  state: MakaPiTranscriptState,
  turnId: string,
  messages: readonly StoredMessage[],
): boolean {
  const turnMessages = messages.filter((message) => message.turnId === turnId);
  const durableTools = new Map(
    foldStoredShellRunChildren(
      materializeSession(turnMessages).items.flatMap(chatItemToTranscriptEntries),
    )
      .filter(
        (entry): entry is Extract<MakaPiTranscriptEntry, { kind: 'tool' }> => entry.kind === 'tool',
      )
      .map((entry) => [entry.toolUseId, entry]),
  );
  let changed = false;
  const reconciled: MakaPiTranscriptEntry[] = [];
  for (const entry of state.entries) {
    if (entry.kind !== 'tool' || entry.turnId !== turnId) {
      reconciled.push(entry);
      continue;
    }
    const durable = durableTools.get(entry.toolUseId);
    if (!durable) {
      if (!entryInLiveViewport(state, entry)) {
        entry.hidden = true;
        reconciled.push(entry);
      }
      changed = true;
      continue;
    }
    entry.toolName = durable.toolName;
    entry.title = durable.title;
    entry.input = structuredClone(durable.input);
    entry.result = durable.result ? structuredClone(durable.result) : undefined;
    entry.output = durable.output;
    entry.durationMs = durable.durationMs;
    entry.status = durable.status;
    entry.hidden = durable.hidden;
    entry.resultVersion += 1;
    changed = true;
    reconciled.push(entry);
  }
  state.entries = reconciled;
  return changed;
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
 * When every card sits above the viewport (e.g. a block whose own expansion
 * pushed its head into scrollback, #1134), nothing visible can change — those
 * lines are immutable short of a scrollback-clearing full redraw — so the
 * toggle still flips the default and appends a notice saying why.
 */
export function toggleAllToolExpansion(state: MakaPiTranscriptState): boolean {
  if (togglesInert(state)) return false;
  const candidates = state.entries.filter(
    (entry): entry is MakaPiToolEntry => entry.kind === 'tool',
  );
  if (candidates.length === 0) return false;
  state.expandAllTools = !state.expandAllTools;
  const targets = candidates.filter((entry) => entryInLiveViewport(state, entry));
  for (const entry of targets) entry.expanded = state.expandAllTools;
  if (targets.length === 0) {
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: `No tool card in view to toggle — cards above stay as rendered in scrollback. New tool output starts ${state.expandAllTools ? 'expanded' : 'collapsed'}.`,
    });
  }
  return true;
}

/**
 * Toggle every thinking entry in the live viewport at once and flip the
 * default for future entries; false when there is no thinking at all or the
 * toggles are inert pending a render. Same head-scrolled contract as
 * toggleAllToolExpansion (#1134).
 */
export function toggleAllThinkingExpansion(state: MakaPiTranscriptState): boolean {
  if (togglesInert(state)) return false;
  const candidates = state.entries.filter(
    (entry): entry is MakaPiThinkingEntry =>
      entry.kind === 'thinking' && Boolean(entry.text.trim()),
  );
  if (candidates.length === 0) return false;
  state.expandAllThinking = !state.expandAllThinking;
  const targets = candidates.filter((entry) => entryInLiveViewport(state, entry));
  for (const entry of targets) entry.expanded = state.expandAllThinking;
  if (targets.length === 0) {
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: `No thinking in view to toggle — thinking above stays as rendered in scrollback. New thinking starts ${state.expandAllThinking ? 'expanded' : 'collapsed'}.`,
    });
  }
  return true;
}

export async function submitCompactToTranscript(input: {
  state: MakaPiTranscriptState;
  driver: Pick<MakaSessionDriver, 'compactSession'>;
  onChange?: () => void;
}): Promise<void> {
  let completed = false;
  let sawCompactionNotice = false;
  try {
    for await (const event of input.driver.compactSession()) {
      if (event.type === 'token_usage' && contextBudgetOutcomeNotice(event.contextBudget))
        sawCompactionNotice = true;
      if (event.type === 'complete' && event.stopReason === 'end_turn') completed = true;
      applyMakaSessionEventToTranscript(input.state, event);
      input.onChange?.();
    }
    if (completed && !sawCompactionNotice) {
      input.state.entries.push({
        kind: 'notice',
        level: 'info',
        text: 'Nothing to compact.',
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
      if (event.toolName === 'Read' || event.toolName === 'StopBackgroundTask') {
        const ref = readArgsRef(event.args);
        if (ref && findShellRunParent(state, ref, event.toolUseId)) {
          state.pendingShellRunPolls.set(event.toolUseId, {
            toolName: event.toolName,
            ...(event.displayName ? { title: event.displayName } : {}),
            input: projectToolActivityArgs(event.toolName, event.args),
          });
          break;
        }
      }
      state.entries.push({
        kind: 'tool',
        turnId: event.turnId,
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        ...(event.displayName ? { title: event.displayName } : {}),
        input: projectToolActivityArgs(event.toolName, event.args),
        resultVersion: 0,
        progress: createProgressBuffer(),
        outputDeltas: createOutputBuffer(),
        status: 'running',
        expanded: state.expandAllTools,
      });
      break;
    }

    case 'tool_result': {
      const foldedPoll = state.pendingShellRunPolls.get(event.toolUseId);
      if (foldedPoll) {
        state.pendingShellRunPolls.delete(event.toolUseId);
        const shellRun = event.content.kind === 'shell_run' ? event.content : undefined;
        const parent = shellRun
          ? findShellRunParent(state, shellRun.ref, event.toolUseId)
          : undefined;
        // isError is the call-level authoritative status: a failed call never
        // folds, even when it carries a well-formed shell_run payload.
        if (parent && shellRun && !event.isError) {
          applyLiveShellRunResultToParent(state, parent, shellRun);
          break;
        }
        // The poll failed (or lost its parent): surface a normal card so the
        // failure is never swallowed by the fold.
        const entry: MakaPiToolEntry = {
          kind: 'tool',
          turnId: event.turnId,
          toolUseId: event.toolUseId,
          toolName: foldedPoll.toolName,
          ...(foldedPoll.title ? { title: foldedPoll.title } : {}),
          input: foldedPoll.input,
          progress: createProgressBuffer(),
          outputDeltas: createOutputBuffer(),
          result: event.content,
          output: formatToolResultContent(event.content),
          resultVersion: 1,
          durationMs: event.durationMs,
          status: event.isError ? 'error' : 'done',
          expanded: state.expandAllTools,
        };
        if (shellRun && !event.isError) applyOwnShellRunResult(entry, shellRun, event.durationMs);
        state.entries.push(entry);
        break;
      }
      const tool = findToolEntry(state, event.toolUseId);
      const shellRun = event.content.kind === 'shell_run' ? event.content : undefined;
      const parent = shellRun
        ? findShellRunParent(state, shellRun.ref, event.toolUseId)
        : undefined;
      if (tool && parent && shellRun && !event.isError) {
        applyLiveShellRunResultToParent(state, parent, shellRun);
        if (tool.toolName === 'Read' || tool.toolName === 'StopBackgroundTask') {
          // Splicing an off-screen entry shifts subsequent entries' line
          // numbers, which changes the composed buffer above the viewport and
          // forces a scrollback-clearing full redraw (#1135). Leave it in
          // place but mark it hidden so it contributes zero lines: a future
          // full redraw (width change, session switch) will not render it as
          // a duplicate card. The stale entry is fully cleaned on the next
          // session switch / replaceTranscriptWithStoredMessages.
          if (entryInLiveViewport(state, tool)) {
            state.entries.splice(state.entries.indexOf(tool), 1);
          } else {
            tool.hidden = true;
          }
        } else {
          applyOwnShellRunResult(tool, shellRun, event.durationMs);
        }
        break;
      }
      if (tool) {
        if (shellRun) {
          if (tool.toolName === 'Bash') {
            applyShellRunResult(tool, shellRun);
          } else {
            applyOwnShellRunResult(tool, shellRun, event.durationMs);
          }
          // isError is the call-level authoritative status: a failed call shows
          // error even when its payload is a well-formed (still running) run.
          if (event.isError) tool.status = 'error';
        } else {
          tool.status = toolResultTranscriptStatus(event.content, event.isError);
          tool.result = event.content;
          tool.output = formatToolResultContent(event.content);
          tool.durationMs = event.durationMs;
          tool.resultVersion += 1;
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
          result: event.content,
          output: formatToolResultContent(event.content),
          resultVersion: 1,
          durationMs: event.durationMs,
          status: toolResultTranscriptStatus(event.content, event.isError),
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
      appendUserPrompt(state, event.content.displayText ?? event.content.text);
      break;

    case 'queue_update':
      // Authoritative snapshot from the runtime; mirror it for the pending bar.
      state.steering = [...event.steering];
      state.followup = [...event.followup];
      break;

    case 'provider_retry':
      state.providerRetry = event;
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
      state.pendingShellRunPolls.clear();
      state.entries.push({
        kind: 'notice',
        level: 'error',
        text: event.message,
      });
      break;

    case 'abort':
      clearPendingInteractions(state);
      state.pendingShellRunPolls.clear();
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: `Stopped: ${event.reason}`,
      });
      break;

    case 'complete':
      // The turn is over; any unresolved interaction is no longer actionable.
      clearPendingInteractions(state);
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

function chatItemToTranscriptEntries(item: ChatItem): MakaPiTranscriptEntry[] {
  switch (item.kind) {
    case 'user':
      return [{ kind: 'user', text: item.message.displayText ?? item.message.text }];
    case 'assistant': {
      const entries: MakaPiTranscriptEntry[] = [];
      // Stored thinking happened before the reply text, so it resumes above it.
      const thinking = item.message.thinking?.text;
      if (thinking?.trim()) {
        // Replay resets the expansion defaults to collapsed, so replayed
        // entries start collapsed too.
        entries.push({
          kind: 'thinking',
          messageId: item.message.id,
          text: thinking,
          expanded: false,
        });
      }
      entries.push({ kind: 'assistant', messageId: item.message.id, text: item.message.text });
      return entries;
    }
    case 'tool':
      return [toolActivityToTranscriptEntry(item.item)];
    case 'system_note': {
      const entry = systemNoteToTranscriptEntry(item.message);
      return entry ? [entry] : [];
    }
  }
}

function toolActivityToTranscriptEntry(item: ToolActivityItem): MakaPiToolEntry {
  const output = item.result
    ? formatToolResultContent(item.result)
    : item.status === 'interrupted'
      ? 'Interrupted before the tool returned a result.'
      : undefined;
  const entry: MakaPiToolEntry = {
    kind: 'tool',
    toolUseId: item.toolUseId,
    toolName: item.toolName,
    ...(item.displayName ? { title: item.displayName } : {}),
    input: item.args,
    progress: createProgressBuffer(),
    outputDeltas: createOutputBuffer(),
    ...(item.result ? { result: item.result } : {}),
    ...(output ? { output } : {}),
    resultVersion: item.result ? 1 : 0,
    ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
    status: transcriptToolStatus(item.status),
    expanded: false,
  };
  if (item.result?.kind === 'subagent') {
    entry.status = subagentTranscriptStatus(item.result.status);
  }
  // A failed call keeps its error status and raw payload: applying the shell_run
  // as the card's own result would let a still-running or settled payload
  // overwrite the error and swallow the failure on replay. This mirrors the live
  // tool_result path, which forces `error` for any errored shell_run result, and
  // is what lets the stored fold below recognize an errored poll by its status.
  if (item.result?.kind === 'shell_run' && !item.isError)
    applyOwnShellRunResult(entry, item.result);
  return entry;
}

function foldStoredShellRunChildren(entries: MakaPiTranscriptEntry[]): MakaPiTranscriptEntry[] {
  const folded: MakaPiTranscriptEntry[] = [];
  for (const entry of entries) {
    // An errored poll never folds: its failed payload must not mutate the parent
    // and its error card must survive replay, mirroring the live path's "failure
    // is never swallowed" invariant.
    if (entry.kind === 'tool' && entry.result?.kind === 'shell_run' && entry.status !== 'error') {
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

function transcriptToolStatus(status: ToolActivityItem['status']): MakaPiToolEntry['status'] {
  switch (status) {
    case 'completed':
      return 'done';
    case 'errored':
    case 'interrupted':
      return 'error';
    case 'pending':
    case 'running':
      return 'running';
  }
}

function toolResultTranscriptStatus(
  result: ToolResultContent,
  isError: boolean,
): MakaPiToolEntry['status'] {
  return result.kind === 'subagent'
    ? subagentTranscriptStatus(result.status)
    : isError
      ? 'error'
      : 'done';
}

function subagentTranscriptStatus(
  status: Extract<ToolResultContent, { kind: 'subagent' }>['status'],
): MakaPiToolEntry['status'] {
  switch (status) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'aborted';
    case 'running':
    case 'waiting_for_user':
      return 'running';
  }
}

function shellRunTranscriptStatus(
  status: Extract<ToolResultContent, { kind: 'shell_run' }>['status'],
): MakaPiToolEntry['status'] {
  switch (status) {
    case 'starting':
    case 'running':
      return 'running';
    case 'completed':
      return 'done';
    case 'cancelled':
      return 'aborted';
    case 'failed':
    case 'timed_out':
    case 'orphaned':
      return 'failed';
  }
}

function applyShellRunResult(
  entry: MakaPiToolEntry,
  result: Extract<ToolResultContent, { kind: 'shell_run' }>,
): boolean {
  const current = entry.result?.kind === 'shell_run' ? entry.result : undefined;
  const merged = mergeShellRunStateWithDiagnostics(current, result, 'cli.transcript');
  if (!merged.changed) return false;
  entry.status = shellRunTranscriptStatus(merged.result.status);
  entry.result = merged.result;
  entry.output = formatToolResultContent(merged.result);
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
  entry.status =
    entry.toolName === 'WriteStdin'
      ? result.operation?.kind === 'pty_control' && result.operation.failed
        ? 'error'
        : 'done'
      : shellRunTranscriptStatus(result.status);
  entry.result = result;
  entry.output = formatToolResultContent(result);
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
  const kind = decision.boundaryKind ?? contextBudget.highWaterReason ?? 'context';
  const coveredTurns = decision.coveredTurns ?? contextBudget.historyCompactedTurns;
  const coveredEvents = decision.coveredRuntimeEvents ?? contextBudget.historyCompactedEvents;
  const savedTokens =
    decision.estimatedTokensSaved ??
    tokenDelta(
      contextBudget.historyCompactedEstimatedTokensBefore,
      contextBudget.historyCompactedEstimatedTokensAfter,
    ) ??
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
      return 'Context compacted to keep this session within the model window.';
    case 'context_compaction_failed_open':
      return 'Context summary failed; the session continued without a new summary.';
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
    return renderWelcomeBlock(safeWidth);
  }

  const entryFirstLine = new Map<MakaPiTranscriptEntry, number>();
  const viewportTop = state.renderGeometry.viewportTop;
  for (let i = 0; i < state.entries.length; i += 1) {
    const entry = state.entries[i]!;
    if (entry.kind === 'tool' && entry.hidden) {
      entryFirstLine.set(entry, lines.length);
      continue;
    }
    const prev = state.entries[i - 1];
    // A blank gap separates human-facing boundaries (user/assistant/thinking/
    // notice) and the edges of a tool stack; only consecutive tool entries (the
    // agent-work stack) have no blank line between them. Thinking reads as
    // model output, so it gets the same blank-line breathing room as assistant
    // text rather than packing against the tool rows.
    const continuesStack = entry.kind === 'tool' && prev?.kind === 'tool';
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
  switch (entry.kind) {
    case 'user':
      return renderUserBlock(entry.text, width);
    case 'assistant':
      return renderAssistantBlock(entry.text, width);
    case 'thinking':
      return renderThinkingBlock(entry, width, entry.expanded);
    case 'tool':
      return renderToolBlock(entry, width, entry.expanded);
    case 'notice':
      return renderNotice(entry, width);
  }
}

function transcriptEntrySignature(entry: MakaPiTranscriptEntry, width: number): string {
  switch (entry.kind) {
    // User text is immutable, so length is a safe change key.
    case 'user':
      return `user|${width}|${entry.text.length}`;
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
      // A tool entry mutates in place as it runs: status/duration flip,
      // progress/output deltas append, and resultVersion advances whenever a
      // result is accepted. Count those revisions instead of duplicating the
      // result's rendering contract in this cache key. `input` and
      // `toolName` are omitted deliberately: both are set once at `tool_start`,
      // before the first render, and never change, so they can't go stale.
      return [
        'tool',
        width,
        entry.expanded ? 1 : 0,
        entry.status,
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
  const sep = ansi.dim(' · ');
  const parts: string[] = [
    ansi.bold(metadata.title),
    ansi.dim(permissionModeLabel(metadata.permissionMode)),
    ansi.dim(metadata.model),
  ];
  // #1064: omit thinking:default — it is noise before the user explicitly
  // changes the level. Only a non-default, explicitly set level shows.
  if (metadata.thinkingLevel) {
    parts.push(ansi.dim(`thinking:${metadata.thinkingLevel}`));
  }
  if (metadata.orchestrationMode === 'swarm') {
    parts.push(ansi.accent('swarm'));
  } else if (metadata.orchestrationMode === 'graph') {
    parts.push(ansi.accent('graph'));
  }
  const usage = metadata.usage;
  if (usage) {
    // ctx segment: only show when contextRemaining is available, since
    // token_usage.input is a billing-cumulative sum across tool-loop steps,
    // not the last request's context size. Using it as a proxy for "used"
    // would produce misleading percentages (potentially >100%).
    if (metadata.modelContextWindow !== undefined && usage.contextRemaining !== undefined) {
      const used = Math.max(0, metadata.modelContextWindow - usage.contextRemaining);
      const pct = Math.round((used / metadata.modelContextWindow) * 100);
      // #1064: color warning — yellow >80%, red >95%, dim otherwise.
      const ctxColor = pct > 95 ? ansi.red : pct > 80 ? ansi.yellow : ansi.dim;
      parts.push(
        ctxColor(
          `ctx ${formatTokenCount(used)}/${formatTokenCount(metadata.modelContextWindow)} ${pct}%`,
        ),
      );
    }
    if (usage.costUsd > 0) {
      parts.push(ansi.dim(`$${formatCost(usage.costUsd)}`));
    }
    const totalCache = usage.cacheHitInput + usage.cacheMissInput;
    if (totalCache > 0) {
      const hitRate = Math.round((usage.cacheHitInput / totalCache) * 100);
      parts.push(ansi.dim(`cache ${hitRate}%`));
    }
  }
  parts.push(ansi.dim(metadata.connectionSlug));
  // #1064: shorten cwd to ~-relative path instead of the full path.
  parts.push(ansi.dim(shortenCwd(metadata.cwd)));
  return fitLine(parts.join(sep), safeWidth);
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
    const retry = metadata.providerRetry;
    const text =
      retry.phase === 'scheduled'
        ? `Retrying in ${Math.max(1, Math.ceil(retry.delayMs / 1_000))}s (${retry.attempt}/${retry.maxAttempts})`
        : `Retrying (${retry.attempt}/${retry.maxAttempts})`;
    return fitLine(ansi.dim(text), safeWidth);
  }
  if (metadata.turnElapsedMs === undefined) return '';
  return fitLine(ansi.dim(`Working… ${formatElapsedDuration(metadata.turnElapsedMs)}`), safeWidth);
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
export function renderMakaPiPendingQueue(state: MakaPiTranscriptState, width: number): string[] {
  if (
    state.steering.length === 0 &&
    state.followup.length === 0 &&
    state.pendingFallback.length === 0
  ) {
    return [];
  }
  const safeWidth = Math.max(1, width);
  const steering = [
    ...state.steering,
    ...state.pendingFallback
      .filter((entry) => entry.enqueue === 'steer')
      .map((entry) => entry.text),
  ];
  const followup = [
    ...state.followup,
    ...state.pendingFallback
      .filter((entry) => entry.enqueue === 'queue')
      .map((entry) => entry.text),
  ];
  const lines: string[] = [];
  for (const text of steering) {
    lines.push(
      fitLine(`${ansi.accent('Steering:')} ${ansi.dim(firstLinePreview(text))}`, safeWidth),
    );
  }
  for (const text of followup) {
    lines.push(fitLine(`${ansi.dim('Queued:')} ${ansi.dim(firstLinePreview(text))}`, safeWidth));
  }
  lines.push(fitLine(ansi.dim('alt+↑ 取回队列以重新编辑'), safeWidth));
  return lines;
}

/** First non-empty line of a queued message, trimmed for a one-line preview. */
function firstLinePreview(text: string): string {
  const line =
    text
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? '';
  return limitText(line, 200);
}

/**
 * Shorten an absolute path to a `~`-relative form for the statusline.
 * `/Users/alice/workspace/project` → `~/workspace/project`.
 * Falls back to the original path if it is not under the home directory.
 */
function shortenCwd(cwd: string, homeDir?: string): string {
  const home = homeDir ?? homedir();
  if (home && cwd.startsWith(home + '/')) return `~${cwd.slice(home.length)}`;
  if (home && cwd === home) return '~';
  return cwd;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
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
// Four-line lowercase ASCII maka wordmark in Maka blue (#1098). Pure ASCII so it
// renders under any locale; stored without trailing spaces so the welcome lines
// and their tests agree after rtrim. A terminal too narrow to fit it falls back
// to a single `maka` line — see renderWelcomeBlock.
const MAKA_WORDMARK_LINES = [
  ' _ __    __ _  _  __   __ _',
  "| '_ \\  / _` | | |/ / / _` |",
  '| |_) | | (_| | |   <  | (_| |',
  '|_.__/  \\__,_| |_|\\_\\  \\__,_|',
];
const MAKA_WORDMARK_WIDTH = Math.max(...MAKA_WORDMARK_LINES.map((line) => line.length));

function renderWelcomeBlock(width: number): string[] {
  // The branded home greets with the maka wordmark, a short Chinese-first
  // tagline, and the command-center entry points (direct input, /session,
  // /model, /setup) so a fresh session shows the main actions without typing
  // `/`. The active model and connection live in the statusline, so the
  // welcome does not repeat them.
  const hints: [string, string][] = [
    ['/session', '切换或恢复会话'],
    ['/model', '切换模型'],
    ['/setup', '配置模型提供商'],
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
  lines.push(fitLine(ansi.dim('陪你把事做完'), width));
  lines.push('');
  lines.push(fitLine('  输入消息开始对话', width));
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
      `${ansi.bold('y')}${ansi.dim('/Enter allow for session')}  ${ansi.bold('n')}${ansi.dim('/Esc deny')}`,
      width,
    ),
  );
  return lines;
}
