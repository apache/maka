import {
  deriveTurnRecords,
  isActiveShellRunStatus,
  mergeShellRunStateWithDiagnostics,
  projectToolActivityArgs,
  STEP_LIMIT_NOTICE_TEXT,
  toolResultActivityStatus,
} from '@maka/core';
import type { AttachmentRef, QuoteRef, ShellRunUpdate, StoredMessage, ToolActivityKind, ToolResultContent, TurnRecord, TurnStatus } from '@maka/core';
import type { LiveTurnProjection } from './live-turn-projection.js';

export { isCancelledToolResultContent, toolResultActivityStatus } from '@maka/core';

export interface ChatItem {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** Wall-clock timestamp of the source StoredMessage; surfaced for hover meta. */
  ts?: number;
  /** User-message attachments projected from StoredMessage; absent on assistant/system rows. */
  attachments?: AttachmentRef[];
  /** Inline quoted excerpts projected from StoredMessage; user rows only. */
  quotes?: QuoteRef[];
  /** Present when the turn was fired by an automation, not hand-typed. */
  automationOrigin?: { automationId: string };
  /** Present when the host resumed the root Agent at a durable graph milestone. */
  agentGraphOrigin?: { graphId: string; wakeId: string; attemptId: string };
}

/**
 * One chunk from PR-REAL-4 `tool_output_delta`. The renderer keeps these
 * per-tool, sorted by `seq` (per-toolCallId monotonic), so out-of-order
 * arrivals are repaired and duplicates dropped. `redacted: true` signals
 * the runtime suppressed a secret in this chunk; the UI renders a small
 * "[已脱敏]" hint instead of pretending the chunk arrived clean.
 */
export interface ToolOutputChunk {
  seq: number;
  stream: 'stdout' | 'stderr';
  text: string;
  redacted: boolean;
  createdAt: number;
}

export interface ToolActivityItem {
  toolUseId: string;
  toolName: string;
  activityKind?: ToolActivityKind;
  displayName?: string;
  intent?: string;
  /**
   * Assistant step this tool belongs to (equals the step's AssistantMessage
   * id). Populated from the persisted `tool_call.stepId`, or from the live
   * `ToolStartEvent.stepId` for in-flight tools. The turn timeline uses it to
   * place a step's tools after that step's thinking/text; absent means a
   * legacy call with no step association.
   */
  stepId?: string;
  status: 'pending' | 'waiting_permission' | 'running' | 'completed' | 'errored' | 'interrupted';
  args: unknown;
  result?: ToolResultContent;
  durationMs?: number;
  /**
   * Live streamed output buffer (PR-UI-12). Append-only from the
   * renderer's perspective — runtime side already enforces the
   * 256-char redaction tail and per-toolCallId seq monotonicity, so
   * the UI only needs to:
   *  - dedupe by `seq` (drop chunks whose seq already exists)
   *  - keep the list sorted by `seq` (insert-sort on out-of-order)
   *  - render in two visual streams (stdout / stderr) but preserve
   *    the global seq order so interleaving reads correctly.
   *
   * PR-UI-12 review fixup #2 (@kenji A3 msg 365ff8b9): the renderer
   * also runs each incoming chunk through `redactSecrets` and a
   * size cap before appending — see `applyToolOutputChunk` in
   * `tool-output-stream.ts`. Defense in depth against runtime
   * tail-redactor misses.
   */
  outputChunks?: ToolOutputChunk[];
  /**
   * `true` when `applyToolOutputChunk` dropped/truncated content
   * (per-chunk size cap, per-tool count cap, or per-tool total-char
   * cap fired). UI surfaces this as a "已截断" pill so users know
   * the visible stream is not the full underlying output.
   */
  outputTruncated?: boolean;
  /** Ownership state for a running ShellRun copied into a branched session. */
  shellRunSource?: 'owned' | 'unavailable';
}

// system_note kinds that we surface inline to the user. Everything else
// (session_resume, connection_locked, mode_change-as-internal-audit, …)
// stays in the JSONL audit trail but is hidden from the chat surface so
// the conversation reads like a conversation, not a debug log.
const VISIBLE_SYSTEM_NOTES = new Set<string>([
  'context_compacted',
  'context_compaction_failed_open',
  'step_limit',
]);

const SYSTEM_NOTE_LABELS: Record<string, string> = {
  context_compacted: 'Context compacted to keep this session within the model window.',
  context_compaction_failed_open: 'Context summary failed; the session continued without a new summary.',
  step_limit: STEP_LIMIT_NOTICE_TEXT,
  mode_change: 'Permission mode changed',
  turn_aborted: 'Turn aborted',
};

export function materializeChat(messages: StoredMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const message of messages) {
    if (message.type === 'user') {
      items.push({
        id: message.id,
        role: 'user',
        text: message.displayText ?? message.text,
        ts: message.ts,
        ...(message.attachments && message.attachments.length > 0 ? { attachments: message.attachments } : {}),
        ...(message.quotes && message.quotes.length > 0 ? { quotes: message.quotes } : {}),
      });
    }
    if (message.type === 'assistant') items.push({ id: message.id, role: 'assistant', text: message.text, ts: message.ts });
    if (message.type === 'system_note' && VISIBLE_SYSTEM_NOTES.has(message.kind)) {
      items.push({
        id: message.id,
        role: 'system',
        text: SYSTEM_NOTE_LABELS[message.kind] ?? message.kind,
        ts: message.ts,
      });
    }
  }
  return items;
}

export function materializeTools(messages: StoredMessage[]): ToolActivityItem[] {
  const results = new Map(messages.filter((message) => message.type === 'tool_result').map((message) => [message.toolUseId, message]));
  return messages
    .filter((message) => message.type === 'tool_call')
    .map((call) => {
      const result = results.get(call.id);
      return {
        toolUseId: call.id,
        toolName: call.toolName,
        activityKind: call.activityKind,
        displayName: call.displayName,
        intent: call.intent,
        ...(call.stepId !== undefined ? { stepId: call.stepId } : {}),
        status: result ? materializeToolResultStatus(result) : 'interrupted',
        args: projectToolActivityArgs(call.toolName, call.args),
        result: result?.content,
        durationMs: result?.durationMs,
      };
    });
}

function materializeToolResultStatus(
  result: Extract<StoredMessage, { type: 'tool_result' }>,
): ToolActivityItem['status'] {
  return toolResultActivityStatus(result.isError, result.content);
}

/**
 * PR-UI-12 fixup (@xuan review): merge live tool state on top of the
 * persisted tool. The general rule (preserved from before PR-UI-12) is
 * "live wins" — live events arrive faster than persisted JSONL refresh
 * and represent the most current status.
 *
 * One scoped exception: if persisted reached `interrupted` while live
 * is still an in-flight status (`pending` / `running` /
 * `waiting_permission`), persisted wins. This catches the post-abort
 * race where the live handler missed a clean status update (e.g.
 * `error` events without a per-tool terminal patch) and live would
 * otherwise mask the persisted `interrupted` signal forever.
 *
 * `completed` / `errored` always defer to live by design — the
 * existing test "merges live tool over persisted tool keeping the
 * latest status" locks the "stale-persisted-completed" case so a tool
 * that's actually still streaming doesn't snap back to "completed"
 * just because JSONL got there first.
 *
 * Live `outputChunks` always come from live — persisted JSONL doesn't
 * store them (PR-REAL-4 contract: chunks are transient UI).
 */
function mergeLiveOverPersisted(persisted: ToolActivityItem, live: ToolActivityItem): ToolActivityItem {
  const liveIsInFlight =
    live.status === 'pending'
    || live.status === 'running'
    || live.status === 'waiting_permission';
  const merged: ToolActivityItem = { ...persisted, ...live };
  if (live.toolName === 'Tool') {
    merged.toolName = persisted.toolName;
    merged.activityKind = persisted.activityKind;
    merged.displayName = persisted.displayName;
    merged.intent = persisted.intent;
    merged.args = persisted.args;
  }
  if (
    merged.toolName === 'Bash'
    && persisted.result?.kind === 'shell_run'
    && live.result?.kind === 'shell_run'
  ) {
    const shellRun = mergeShellRunStateWithDiagnostics(
      persisted.result,
      live.result,
      'ui.live-over-persisted',
    ).result;
    merged.result = shellRun;
  }
  if (persisted.status === 'interrupted' && liveIsInFlight) {
    merged.status = 'interrupted';
  }
  if (live.outputChunks && live.outputChunks.length > 0) {
    merged.outputChunks = live.outputChunks;
  }
  return merged;
}

/**
 * One entry on a turn's render timeline — the interleaved thinking / answer /
 * tool sequence in the order the model actually produced it. This is the
 * rendering source of truth (see `TurnViewModel.timeline`); the aggregate
 * `assistant` / `assistantThinking` fields are kept only for older consumers
 * (copy, export, prompt rail).
 *
 * - `thinking`: one reasoning block (a step's thinking; adjacent blocks are
 *   pre-merged with `\n\n`). Rendered as a collapsed "深度思考" disclosure.
 * - `text`: one assistant answer segment (a step's text). `ts` is the source
 *   step's wall-clock for hover meta.
 * - `tools`: one contiguous group of tool activity, rendered as a single
 *   Codex-style trow. Adjacent groups are pre-merged.
 *
 * The model stays FLAT: the collapsed "Processing" fold (#1307) is a render
 * concern applied by `foldTimeline` (timeline-fold.ts) at the component layer,
 * so timeline-rewriting passes (overlayLiveTurn, projectTurnTools, shell-run
 * folding) never have to maintain a nesting invariant.
 */
export type TurnTimelineItem =
  | { kind: 'thinking'; text: string; messageId: string; live?: boolean; truncated?: boolean }
  | { kind: 'text'; text: string; messageId: string; ts?: number; live?: boolean; complete?: boolean; truncated?: boolean }
  | { kind: 'tools'; items: ToolActivityItem[] };

/**
 * A single conversational turn — typically one user message, the assistant's
 * tool calls (if any), and the assistant's final answer. Derived as a
 * read-only projection from `messages` + live tools (no storage changes
 * needed — every StoredMessage already carries a `turnId`).
 *
 * Per @kenji UI-04 (turn narrative): replaces the previous "message stack
 * + tools panel at end" layout with a per-turn rendering so a single user
 * → assistant exchange reads as one work unit instead of fragments.
 */
export interface TurnViewModel {
  turnId: string;
  status: TurnStatus;
  parentTurnId?: string;
  retriedFromTurnId?: string;
  regeneratedFromTurnId?: string;
  branchOfTurnId?: string;
  parentSessionId?: string;
  abortedAt?: number;
  abortSource?: string;
  errorClass?: string;
  partialOutputRetained: boolean;
  user?: ChatItem;
  tools: ToolActivityItem[];
  assistant?: ChatItem;
  /**
   * Anthropic-style reasoning that some providers expose alongside the
   * assistant's final answer. Rendered in a collapsed `<details>` so the
   * answer reads cleanly but the thinking is one click away when the
   * user wants to verify the chain of reasoning.
   */
  assistantThinking?: string;
  /**
   * Interleaved thinking / answer / tool sequence in production order — the
   * rendering source of truth for the turn body. Built from the per-step
   * assistant rows and each step's paired tools (see buildTurnTimeline).
   */
  timeline: TurnTimelineItem[];
  /** System notes inside this turn that survive the VISIBLE_SYSTEM_NOTES gate. */
  notes: ChatItem[];
  /** Wall-clock ts of the earliest message in this turn — used for sorting. */
  startedAt: number;
  /** Model id from the assistant message (if any), e.g. claude-sonnet-4-5. */
  modelId?: string;
  /** Wall-clock ms between earliest user/tool message and assistant message. */
  durationMs?: number;
  /** Token totals summed across all `token_usage` messages within the turn. */
  tokens?: {
    input: number;
    output: number;
    cacheMiss?: number;
    cacheRead?: number;
    cacheCreation?: number;
    reasoning?: number;
    costUsd?: number;
  };
}

export function overlayLiveTurn(
  turns: readonly TurnViewModel[],
  liveTurn: LiveTurnProjection | undefined,
): readonly TurnViewModel[] {
  if (!liveTurn) return turns;
  const targetIndex = turns.findIndex((turn) => turn.turnId === liveTurn.turnId);
  if (targetIndex >= 0 && liveTurn.steps.length === 0) return turns;
  const current = targetIndex >= 0
    ? turns[targetIndex]!
    : {
        turnId: liveTurn.turnId,
        status: 'completed' as const,
        partialOutputRetained: false,
        tools: [],
        notes: [],
        timeline: [],
        startedAt: Date.now(),
      } satisfies TurnViewModel;
  const tools = [...current.tools];
  const toolByUseId = new Map(tools.map((tool) => [tool.toolUseId, tool]));
  const liveToolIds = new Set<string>();
  for (const step of liveTurn.steps) {
    for (const liveTool of step.tools) {
      liveToolIds.add(liveTool.toolUseId);
      const persisted = toolByUseId.get(liveTool.toolUseId);
      const merged = persisted ? mergeLiveOverPersisted(persisted, liveTool) : liveTool;
      toolByUseId.set(merged.toolUseId, merged);
      const toolIndex = tools.findIndex((tool) => tool.toolUseId === merged.toolUseId);
      if (toolIndex >= 0) tools[toolIndex] = merged;
      else tools.push(merged);
    }
  }
  const timeline: TurnTimelineItem[] = [];
  for (const item of current.timeline) {
    if (item.kind !== 'tools') {
      timeline.push(item);
      continue;
    }
    const settledItems = item.items.filter((tool) => !liveToolIds.has(tool.toolUseId));
    if (settledItems.length > 0) timeline.push({ kind: 'tools', items: settledItems });
  }
  for (const step of liveTurn.steps) {
    const contentOrder = step.contentOrder ?? [
      ...(step.thinking ? ['thinking' as const] : []),
      ...(step.text ? ['text' as const] : []),
      ...(step.tools.length > 0 ? ['tools' as const] : []),
    ];
    for (const kind of contentOrder) {
      if (kind === 'thinking' && step.thinking?.text) {
        timeline.push({
          kind: 'thinking',
          text: step.thinking.text,
          messageId: step.stepId,
          live: step.thinking.complete !== true,
          truncated: step.thinking.truncated,
        });
      } else if (kind === 'text' && step.text?.text) {
        timeline.push({
          kind: 'text',
          text: step.text.text,
          messageId: step.stepId,
          live: true,
          complete: step.text.complete,
          truncated: step.text.truncated,
        });
      } else if (kind === 'tools') {
        const stepTools = step.tools.flatMap((tool) => {
          const projected = toolByUseId.get(tool.toolUseId);
          return projected ? [projected] : [];
        });
        if (stepTools.length > 0) timeline.push({ kind: 'tools', items: stepTools });
      }
    }
  }
  const next = { ...current, tools, timeline: mergeAdjacentTimeline(timeline) };
  const overlaid = targetIndex < 0
    ? [...turns, next]
    : turns.map((turn, index) => index === targetIndex ? next : turn);
  return foldShellRunTurns(overlaid);
}

export function overlayShellRunUpdates(
  turns: readonly TurnViewModel[],
  updates: readonly ShellRunUpdate[],
): readonly TurnViewModel[] {
  if (updates.length === 0) return turns;
  const byToolUseId = new Map<string, {
    result: Extract<ToolResultContent, { kind: 'shell_run' }>;
    source: ToolActivityItem['shellRunSource'];
  }>();
  for (const update of updates) {
    const current = byToolUseId.get(update.sourceToolCallId);
    const merged = mergeShellRunStateWithDiagnostics(
      current?.result,
      update.result,
      'ui.overlay-shell-run-updates',
    );
    byToolUseId.set(update.sourceToolCallId, {
      result: merged.result,
      source: !isActiveShellRunStatus(merged.result.status) || update.ownership.kind === 'local'
        ? undefined
        : update.ownership.kind === 'source_owned' ? 'owned' : 'unavailable',
    });
  }
  const projected = turns.flatMap((turn) => turn.tools).map((tool) => {
    const update = byToolUseId.get(tool.toolUseId);
    if (!update || tool.toolName !== 'Bash') return tool;
    const current = tool.result?.kind === 'shell_run' ? tool.result : undefined;
    if (tool.result && !current) return tool;
    const merged = mergeShellRunStateWithDiagnostics(
      current,
      update.result,
      'ui.overlay-shell-run-update',
    );
    return merged.changed || tool.shellRunSource !== update.source
      ? { ...tool, result: merged.result, shellRunSource: update.source }
      : tool;
  });
  return projectTurnTools(turns, projected);
}

/**
 * Group materialized chat + tool items by `turnId` into ordered turns. Items
 * without a turnId (e.g. fake-backend echo, or older sessions) fall into a
 * synthetic `__loose` bucket rendered first so they remain visible.
 */
export function materializeTurns(messages: StoredMessage[]): TurnViewModel[] {
  const turnRecords = deriveTurnRecords(messages);
  const turnRecordById = new Map(turnRecords.map((turn) => [turn.turnId, turn]));
  const turnsByMsg = new Map<string, string>();
  const order: string[] = [];
  const byId = new Map<string, TurnViewModel>();
  const looseTurnId = '__loose';
  // Storage-ordered messages per turn — the raw sequence the timeline pass
  // replays to interleave a step's thinking/text with its paired tools.
  const messagesByTurn = new Map<string, StoredMessage[]>();

  function ensureTurn(turnId: string, startedAt: number): TurnViewModel {
    let turn = byId.get(turnId);
    if (!turn) {
      const record = turnRecordById.get(turnId);
      turn = {
        turnId,
        status: record?.status ?? 'completed',
        ...(record?.parentTurnId ? { parentTurnId: record.parentTurnId } : {}),
        ...(record?.retriedFromTurnId ? { retriedFromTurnId: record.retriedFromTurnId } : {}),
        ...(record?.regeneratedFromTurnId ? { regeneratedFromTurnId: record.regeneratedFromTurnId } : {}),
        ...(record?.branchOfTurnId ? { branchOfTurnId: record.branchOfTurnId } : {}),
        ...(record?.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
        ...(record?.abortedAt !== undefined ? { abortedAt: record.abortedAt } : {}),
        ...(record?.abortSource ? { abortSource: record.abortSource } : {}),
        ...(record?.errorClass ? { errorClass: record.errorClass } : {}),
        partialOutputRetained: record?.partialOutputRetained ?? false,
        tools: [],
        notes: [],
        timeline: [],
        startedAt,
      };
      byId.set(turnId, turn);
      order.push(turnId);
    } else if (startedAt < turn.startedAt) {
      turn.startedAt = startedAt;
    }
    return turn;
  }

  // First pass: assign each message to its turn and walk chat-relevant
  // messages into the projection.
  for (const message of messages) {
    const turnId = (message as { turnId?: string }).turnId ?? looseTurnId;
    const ts = (message as { ts?: number }).ts ?? 0;
    const turn = ensureTurn(turnId, ts);
    const turnMessageList = messagesByTurn.get(turnId);
    if (turnMessageList) turnMessageList.push(message);
    else messagesByTurn.set(turnId, [message]);
    if (message.type === 'user') {
      turn.user = {
        id: message.id,
        role: 'user',
        text: message.displayText ?? message.text,
        ts: message.ts,
        ...(message.attachments && message.attachments.length > 0 ? { attachments: message.attachments } : {}),
        ...(message.quotes && message.quotes.length > 0 ? { quotes: message.quotes } : {}),
        ...(message.origin?.kind === 'automation' ? { automationOrigin: { automationId: message.origin.automationId } } : {}),
        ...(message.origin?.kind === 'agent_graph'
          ? {
              agentGraphOrigin: {
                graphId: message.origin.graphId,
                wakeId: message.origin.wakeId,
                attemptId: message.origin.attemptId,
              },
            }
          : {}),
      };
    } else if (message.type === 'assistant') {
      // A turn now holds one AssistantMessage per model step. Concatenate their
      // text (and thinking) in step order so the turn reads as one answer; keep
      // the first step's id as the stable anchor, and advance ts to the latest
      // step so durationMs measures to the turn's final assistant message.
      const priorText = turn.assistant?.text ?? '';
      const mergedText = message.text.length > 0
        ? (priorText.length > 0 ? `${priorText}\n\n${message.text}` : message.text)
        : priorText;
      turn.assistant = {
        id: turn.assistant?.id ?? message.id,
        role: 'assistant',
        text: mergedText,
        ts: message.ts,
      };
      turn.modelId = message.modelId;
      if (message.thinking?.text) {
        turn.assistantThinking = turn.assistantThinking
          ? `${turn.assistantThinking}\n\n${message.thinking.text}`
          : message.thinking.text;
      }
      // Time-to-answer measured from the earliest message in this turn (usually
      // the user's send) to the turn's final assistant message ts. Tool runs are
      // inside this window, so the same metric captures both LLM latency and tool
      // wall-time. We only compute this once an assistant message lands, so a
      // streaming turn stays at undefined ("进行中" per kenji's PR82 review)
      // instead of ticking up against the current clock and forcing visible
      // re-renders. Recomputed as each step lands, so it ends at the last step.
      if (message.ts !== undefined && message.ts >= turn.startedAt) {
        turn.durationMs = message.ts - turn.startedAt;
      }
    } else if (message.type === 'system_note' && VISIBLE_SYSTEM_NOTES.has(message.kind)) {
      turn.notes.push({
        id: message.id,
        role: 'system',
        text: SYSTEM_NOTE_LABELS[message.kind] ?? message.kind,
        ts: message.ts,
      });
    } else if (message.type === 'tool_call') {
      turnsByMsg.set(message.id, turnId);
    } else if (message.type === 'token_usage') {
      const totals = turn.tokens ?? { input: 0, output: 0 };
      totals.input += message.input;
      totals.output += message.output;
      if (message.cacheMissInput !== undefined) totals.cacheMiss = (totals.cacheMiss ?? 0) + message.cacheMissInput;
      if (message.cacheRead !== undefined) totals.cacheRead = (totals.cacheRead ?? 0) + message.cacheRead;
      if (message.cacheCreation !== undefined) totals.cacheCreation = (totals.cacheCreation ?? 0) + message.cacheCreation;
      if (message.reasoning !== undefined) totals.reasoning = (totals.reasoning ?? 0) + message.reasoning;
      if (message.costUsd !== undefined) totals.costUsd = (totals.costUsd ?? 0) + message.costUsd;
      turn.tokens = totals;
    }
  }

  // Second pass: persisted tools land in the turn matching their tool_call's
  // turnId. Live tools are applied separately by overlayLiveTurn so streaming
  // deltas never force settled history to rematerialize.
  const persistedTools = foldShellRunToolActivities(materializeTools(messages));
  // toolItemByUseId feeds the timeline pass: the fully merged (persisted+live)
  // item keyed by toolUseId, so replaying tool_call rows in storage order
  // yields the same ToolActivityItem the tools list holds.
  const toolItemByUseId = new Map<string, ToolActivityItem>();
  for (const tool of persistedTools) {
    const turnId = turnsByMsg.get(tool.toolUseId) ?? order[order.length - 1] ?? looseTurnId;
    const turn = ensureTurn(turnId, Date.now());
    turn.tools.push(tool);
    toolItemByUseId.set(tool.toolUseId, tool);
  }
  // Third pass: rebuild each turn's render timeline from its storage-ordered
  // messages, interleaving a step's thinking/text with its paired tools.
  for (const turnId of order) {
    const turn = byId.get(turnId)!;
    turn.timeline = buildTurnTimeline(
      messagesByTurn.get(turnId) ?? [],
      toolItemByUseId,
    );
  }

  return order.map((turnId) => byId.get(turnId)!);
}

export function foldShellRunToolActivities(items: readonly ToolActivityItem[]): ToolActivityItem[] {
  const folded: ToolActivityItem[] = [];
  for (const item of items) {
    const result = item.result?.kind === 'shell_run' ? item.result : undefined;
    if (!result || item.toolName === 'Bash') {
      folded.push(item);
      continue;
    }
    const parentIndex = findShellRunParentIndex(folded, result.ref);
    if (parentIndex >= 0) {
      const parent = folded[parentIndex]!;
      const current = parent.result?.kind === 'shell_run' ? parent.result : undefined;
      const merged = mergeShellRunStateWithDiagnostics(
        current,
        result,
        'ui.fold-shell-run-child',
      );
      if (merged.changed) {
        folded[parentIndex] = {
          ...parent,
          result: merged.result,
        };
      }
      if (item.toolName === 'Read' || item.toolName === 'StopBackgroundTask') continue;
    }
    folded.push(item);
  }
  return folded;
}

function foldShellRunTurns(turns: readonly TurnViewModel[]): readonly TurnViewModel[] {
  return projectTurnTools(
    turns,
    foldShellRunToolActivities(turns.flatMap((turn) => turn.tools)),
  );
}

function projectTurnTools(
  turns: readonly TurnViewModel[],
  tools: readonly ToolActivityItem[],
): readonly TurnViewModel[] {
  const projected = new Map(tools.map((tool) => [tool.toolUseId, tool]));
  return turns.map((turn) => {
    const nextTools = turn.tools.flatMap((tool) => {
      const projectedTool = projected.get(tool.toolUseId);
      return projectedTool ? [projectedTool] : [];
    });
    let timelineChanged = false;
    const timeline = turn.timeline.flatMap<TurnTimelineItem>((item): TurnTimelineItem[] => {
      if (item.kind !== 'tools') return [item];
      const items = item.items.flatMap((tool) => {
        const projectedTool = projected.get(tool.toolUseId);
        return projectedTool ? [projectedTool] : [];
      });
      if (items.length !== item.items.length || items.some((tool, index) => tool !== item.items[index])) {
        timelineChanged = true;
      }
      return items.length > 0 ? [{ kind: 'tools' as const, items }] : [];
    });
    const toolsChanged = nextTools.length !== turn.tools.length
      || nextTools.some((tool, index) => tool !== turn.tools[index]);
    return toolsChanged || timelineChanged ? { ...turn, tools: nextTools, timeline } : turn;
  });
}

function findShellRunParentIndex(items: readonly ToolActivityItem[], ref: string): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const candidate = items[index];
    if (
      candidate?.toolName === 'Bash'
      && candidate.result?.kind === 'shell_run'
      && candidate.result.ref === ref
    ) return index;
  }
  return -1;
}

/**
 * Rebuild a turn's render timeline from its storage-ordered messages.
 *
 * Ledger order within a turn is tool_call(s) -> tool_result(s) ->
 * assistant(step) -> next step's tools -> ... . Walking that sequence:
 *
 *  - tool_call rows buffer their (merged) ToolActivityItem into `pending`,
 *    tagged by the item's stepId.
 *  - an assistant row (id === a step's messageId) flushes the buffer around
 *    its own thinking/text. New rows carry `contentOrder`, the first-observed
 *    order recorded by the runtime; older rows retain the historical
 *    thinking -> legacy tools -> text -> matched tools fallback. Tools
 *    whose stepId matches no assistant row are orphans of a pure-tool step
 *    (which persists no assistant message); ledger append order guarantees
 *    they ran BEFORE this row landed, so they flush ahead of this step's
 *    content — parking them past the text would invert the common
 *    "call tools, then summarize next step" turn into answer-then-tools.
 *  - leftover buffered tools (abort / pure-tool turn with no assistant row)
 *    flush as a trailing tools group.
 *
 * Empty text/thinking produce no item. Adjacent thinking blocks merge with
 * a blank line; adjacent tools groups merge into one trow.
 */
function buildTurnTimeline(
  turnMessages: readonly StoredMessage[],
  toolItemByUseId: ReadonlyMap<string, ToolActivityItem>,
): TurnTimelineItem[] {
  const raw: TurnTimelineItem[] = [];
  let pending: ToolActivityItem[] = [];
  const flushTools = (items: ToolActivityItem[]): void => {
    if (items.length > 0) raw.push({ kind: 'tools', items });
  };
  for (const message of turnMessages) {
    if (message.type === 'tool_call') {
      const item = toolItemByUseId.get(message.id);
      if (item) pending.push(item);
    } else if (message.type === 'assistant') {
      const rowId = message.id;
      const legacy = pending.filter((tool) => tool.stepId === undefined);
      const matched = pending.filter((tool) => tool.stepId === rowId);
      // stepId set but not this row's: orphans of an earlier pure-tool step
      // (no assistant row carries their stepId). A later step's tools cannot
      // be pending here — the ledger appends them after this assistant row —
      // so these ran earlier and must render before this step's content.
      const orphaned = pending.filter((tool) => tool.stepId !== undefined && tool.stepId !== rowId);
      pending = [];
      flushTools(orphaned);
      if (message.contentOrder?.length) {
        // Legacy calls cannot be associated with a step, so preserve their
        // old pre-answer position without letting them disturb the recorded
        // order of this row's own content.
        flushTools(legacy);
        const remaining = new Set<'thinking' | 'text' | 'tools'>(['thinking', 'text', 'tools']);
        const append = (kind: 'thinking' | 'text' | 'tools'): void => {
          if (!remaining.delete(kind)) return;
          if (kind === 'thinking' && message.thinking?.text) {
            raw.push({ kind: 'thinking', text: message.thinking.text, messageId: rowId });
          } else if (kind === 'text' && message.text.length > 0) {
            raw.push({ kind: 'text', text: message.text, messageId: rowId, ts: message.ts });
          } else if (kind === 'tools') {
            flushTools(matched);
          }
        };
        for (const kind of message.contentOrder) append(kind);
        // Malformed or partial metadata must never hide persisted content.
        for (const kind of ['thinking', 'text', 'tools'] as const) append(kind);
      } else {
        if (message.thinking?.text) {
          raw.push({ kind: 'thinking', text: message.thinking.text, messageId: rowId });
        }
        flushTools(legacy);
        if (message.text.length > 0) {
          raw.push({ kind: 'text', text: message.text, messageId: rowId, ts: message.ts });
        }
        flushTools(matched);
      }
    }
  }
  flushTools(pending);
  return mergeAdjacentTimeline(raw);
}

function mergeAdjacentTimeline(items: readonly TurnTimelineItem[]): TurnTimelineItem[] {
  const out: TurnTimelineItem[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (item.kind === 'thinking' && last?.kind === 'thinking' && !item.live && !last.live) {
      last.text = `${last.text}\n\n${item.text}`;
    } else if (item.kind === 'tools' && last?.kind === 'tools') {
      last.items = [...last.items, ...item.items];
    } else if (item.kind === 'tools') {
      out.push({ kind: 'tools', items: [...item.items] });
    } else {
      out.push({ ...item });
    }
  }
  return out;
}

export interface TurnLineageTarget {
  retriedToTurnId?: string;
  regeneratedToTurnId?: string;
}

export function deriveTurnLineageMap(
  turns: readonly Pick<TurnRecord, 'turnId' | 'retriedFromTurnId' | 'regeneratedFromTurnId'>[],
): Map<string, TurnLineageTarget> {
  const out = new Map<string, TurnLineageTarget>();
  for (const turn of turns) {
    if (turn.retriedFromTurnId) {
      out.set(turn.retriedFromTurnId, {
        ...(out.get(turn.retriedFromTurnId) ?? {}),
        retriedToTurnId: turn.turnId,
      });
    }
    if (turn.regeneratedFromTurnId) {
      out.set(turn.regeneratedFromTurnId, {
        ...(out.get(turn.regeneratedFromTurnId) ?? {}),
        regeneratedToTurnId: turn.turnId,
      });
    }
  }
  return out;
}
