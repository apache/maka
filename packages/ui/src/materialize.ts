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

import { deriveTurnRecords, STEP_LIMIT_NOTICE_TEXT } from '@maka/core/session';
import {
  isInFlightToolStatus,
  toolResultActivityStatus,
  unfinishedToolActivityStatus,
} from '@maka/core/tool-result-status';
import { isActiveShellRunStatus } from '@maka/core/shell-run';
import { mergeShellRunStateWithDiagnostics } from '@maka/core/shell-run-result';
import { projectToolActivityArgs } from '@maka/core/tool-activity-args';
import type {
  AttachmentRef,
  InlineReference,
  MessageContent,
  QuoteRef,
  ShellRunUpdate,
  ToolActivityKind,
  ToolResultContent,
} from '@maka/core/events';
import type { ToolActivityStatus } from '@maka/core/tool-result-status';
import type { ShellRunToolResult } from '@maka/core/shell-run-result';
import type { StoredMessage, TurnRecord, TurnStatus, UserMessage } from '@maka/core/session';
import type {
  LiveSteeringProjection,
  LiveTurnProjection,
} from "./live-turn-projection.js";

export { isCancelledToolResultContent, isInFlightToolStatus, toolResultActivityStatus } from '@maka/core/tool-result-status';

export interface ChatItem {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  /** Wall-clock timestamp of the source StoredMessage; surfaced for hover meta. */
  ts?: number;
  /** User-message attachments projected from StoredMessage; absent on assistant/system rows. */
  attachments?: AttachmentRef[];
  /** Inline quoted excerpts projected from StoredMessage; user rows only. */
  quotes?: QuoteRef[];
  /** Frozen inline token metadata projected from StoredMessage; user rows only. */
  inlineReferences?: InlineReference[];
  /** Present when the Host authored this message instead of the user. */
  hostOrigin?: NonNullable<UserMessage["origin"]>;
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
  stream: "stdout" | "stderr";
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
  origin?: 'provider' | 'code_mode';
  modelVisibility?: 'visible' | 'hidden';
  parentToolCallId?: string;
  parentOperationId?: string;
  /**
   * Assistant step this tool belongs to (equals the step's AssistantMessage
   * id). Populated from the persisted `tool_call.stepId`, or from the live
   * `ToolStartEvent.stepId` for in-flight tools. The turn timeline uses it to
   * place a step's tools after that step's thinking/text; absent means a
   * legacy call with no step association.
   */
  stepId?: string;
  status: ToolActivityStatus;
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
  shellRunSource?: "owned" | "unavailable";
}

// system_note kinds that we surface inline to the user. Everything else
// (session_resume, connection_locked, mode_change-as-internal-audit, …)
// stays in the JSONL audit trail but is hidden from the chat surface so
// the conversation reads like a conversation, not a debug log.
const VISIBLE_SYSTEM_NOTES = new Set<string>([
  "context_compacted",
  "context_compaction_failed_open",
  "step_limit",
]);

const SYSTEM_NOTE_LABELS: Record<string, string> = {
  context_compacted:
    "Context compacted to keep this session within the model window.",
  context_compaction_failed_open:
    "Context summary failed; the session continued without a new summary.",
  step_limit: STEP_LIMIT_NOTICE_TEXT,
  mode_change: "Permission mode changed",
  turn_aborted: "Turn aborted",
};

export function materializeChat(
  messages: readonly StoredMessage[],
): ChatItem[] {
  const items: ChatItem[] = [];
  for (const message of messages) {
    if (message.type === "user") {
      items.push({
        id: message.id,
        role: "user",
        text: message.displayText ?? message.text,
        ts: message.ts,
        ...(message.attachments && message.attachments.length > 0
          ? { attachments: message.attachments }
          : {}),
        ...(message.quotes && message.quotes.length > 0
          ? { quotes: message.quotes }
          : {}),
        ...(message.inlineReferences !== undefined
          ? { inlineReferences: message.inlineReferences }
          : {}),
        ...(message.origin ? { hostOrigin: message.origin } : {}),
      });
    }
    if (message.type === "assistant")
      items.push({
        id: message.id,
        role: "assistant",
        text: message.text,
        ts: message.ts,
      });
    if (
      message.type === "system_note" &&
      VISIBLE_SYSTEM_NOTES.has(message.kind)
    ) {
      items.push({
        id: message.id,
        role: "system",
        text: SYSTEM_NOTE_LABELS[message.kind] ?? message.kind,
        ts: message.ts,
      });
    }
  }
  return items;
}

export function materializeTools(
  messages: readonly StoredMessage[],
): ToolActivityItem[] {
  const results = new Map(
    messages
      .filter((message) => message.type === "tool_result")
      .map((message) => [message.toolUseId, message]),
  );
  const turnStatusById = new Map(
    deriveTurnRecords(messages).map((turn) => [turn.turnId, turn.status]),
  );
  return messages
    .filter((message) => message.type === "tool_call")
    .map((call) => {
      const result = results.get(call.id);
      return {
        toolUseId: call.id,
        toolName: call.toolName,
        activityKind: call.activityKind,
        displayName: call.displayName,
        intent: call.intent,
        ...(call.origin !== undefined ? { origin: call.origin } : {}),
        ...(call.modelVisibility !== undefined ? { modelVisibility: call.modelVisibility } : {}),
        ...(call.parentToolCallId !== undefined ? { parentToolCallId: call.parentToolCallId } : {}),
        ...(call.parentOperationId !== undefined ? { parentOperationId: call.parentOperationId } : {}),
        ...(call.stepId !== undefined ? { stepId: call.stepId } : {}),
        status: result
          ? materializeToolResultStatus(result)
          : unfinishedToolActivityStatus(turnStatusById.get(call.turnId)),
        args: projectToolActivityArgs(call.toolName, call.args),
        result: result?.content,
        durationMs: result?.durationMs,
      };
    });
}

function materializeToolResultStatus(
  result: Extract<StoredMessage, { type: "tool_result" }>,
): ToolActivityItem["status"] {
  return toolResultActivityStatus(result.isError, result.content);
}

/**
 * Merge live tool state on top of the persisted tool. Live owns transient
 * state: its events arrive ahead of the persisted transcript refresh, so it
 * carries the most current status and output chunks. The durable transcript
 * fills call arguments and settled results when the live path has no payload.
 * Runtime Host live events deliberately omit both; letting those empty
 * projections win made an expanded tool row blank until the whole Turn
 * settled.
 *
 * The exception is a turn that has already ended. Live only stays current
 * while events keep arriving, and the subscription does not replay — a missed
 * `abort`/`error`/`complete` leaves the projection frozen mid-run, and
 * `reconcileTerminalLiveTurn` hands a tool off only once it is `interrupted`
 * or has a result, so a frozen `running` never clears. The turn's own settled
 * status is the counter-evidence: once it has ended, no tool inside it is
 * still running, and the persisted status is the authority.
 *
 * Live `outputChunks` always come from live — persisted JSONL doesn't
 * store them (PR-REAL-4 contract: chunks are transient UI).
 */
function mergeLiveOverPersisted(
  persisted: ToolActivityItem,
  live: ToolActivityItem,
  turnSettled: boolean,
): ToolActivityItem {
  const merged: ToolActivityItem = { ...persisted, ...live };
  if (live.args === undefined) {
    merged.args = persisted.args;
  }
  const liveResultIsEmpty =
    live.result === undefined ||
    (live.result.kind === "text" && live.result.text.length === 0);
  if (persisted.result !== undefined && liveResultIsEmpty) {
    // Runtime Host represents its deliberately omitted result payload as an
    // empty text result at the SessionEvent compatibility seam. A transcript
    // refresh can also win the race with the terminal live event, leaving no
    // live result at all. In both cases the committed result supplies detail
    // without taking a newer, meaningful live result away.
    merged.result = persisted.result;
  }
  // A settled turn always yields a settled persisted status — materializeTools
  // only reads a tool as in-flight while the turn record says `running` — so
  // this needs no guard on the persisted side.
  if (turnSettled && isInFlightToolStatus(live.status)) {
    merged.status = persisted.status;
  }
  if (live.toolName === "Tool") {
    merged.toolName = persisted.toolName;
    merged.activityKind = persisted.activityKind;
    merged.displayName = persisted.displayName;
    merged.intent = persisted.intent;
    merged.args = persisted.args;
  }
  if (
    merged.toolName === "Bash" &&
    persisted.result?.kind === "shell_run" &&
    live.result?.kind === "shell_run"
  ) {
    const shellRun = mergeShellRunStateWithDiagnostics(
      persisted.result,
      live.result,
      "ui.live-over-persisted",
    ).result;
    merged.result = shellRun;
  }
  if (live.outputChunks && live.outputChunks.length > 0) {
    merged.outputChunks = live.outputChunks;
  }
  return merged;
}

/**
 * One entry on a turn's render timeline — interleaved thinking, answer, tool,
 * and mid-turn user messages in conversational order. This is the
 * rendering source of truth (see `TurnViewModel.timeline`); the aggregate
 * `assistant` / `assistantThinking` fields are kept only for older consumers
 * (copy, export, prompt rail).
 *
 * - `thinking`: one reasoning block (a step's thinking; adjacent blocks are
 *   pre-merged with `\n\n`). Rendered as a collapsed "深度思考" disclosure.
 * - `text`: one assistant answer segment (a step's text). `ts` is the source
 *   step's wall-clock for hover meta.
 * - `tools`: one contiguous group of tool activity. Adjacent groups are
 *   pre-merged; presentation may split ordinary evidence and linked-session
 *   navigation into adjacent native Astryx segments without reordering them.
 * - `user`: an instruction inserted after the turn began, kept at the ledger
 *   position where Runtime acknowledged it.
 *
 * The model stays FLAT: the collapsed "Processing" fold (#1307) is a render
 * concern applied by `foldTimeline` (timeline-fold.ts) at the component layer,
 * so timeline-rewriting passes (overlayLiveTurn, projectTurnTools, shell-run
 * folding) never have to maintain a nesting invariant.
 */
export type TurnTimelineItem =
  | {
      kind: "user";
      message: ChatItem;
      messageId: string;
      steeringEventId?: string;
    }
  | {
      kind: "thinking";
      text: string;
      messageId: string;
      live?: boolean;
      truncated?: boolean;
    }
  | {
      kind: "text";
      text: string;
      messageId: string;
      ts?: number;
      live?: boolean;
      complete?: boolean;
      truncated?: boolean;
    }
  | { kind: "tools"; items: ToolActivityItem[] };

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
  /**
   * See `TurnRecord.statusSource` — whether `status` is evidence or a reading.
   * Absent on hand-built view models, which are treated as non-evidence.
   */
  statusSource?: TurnRecord["statusSource"];
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
   * Interleaved thinking / answer / tool / steering sequence in production order — the
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
  const targetIndex = turns.findIndex(
    (turn) => turn.turnId === liveTurn.turnId,
  );
  if (
    targetIndex >= 0
    && liveTurn.steps.length === 0
    && (liveTurn.pendingSteering?.length ?? 0) === 0
  ) {
    return turns;
  }
  const current =
    targetIndex >= 0
      ? turns[targetIndex]!
      : ({
          turnId: liveTurn.turnId,
          status: "completed" as const,
          partialOutputRetained: false,
          tools: [],
          notes: [],
          timeline: [],
          startedAt: Date.now(),
        } satisfies TurnViewModel);
  // Only a recorded turn_state is evidence the turn ended; a legacy turn's
  // inferred `completed` is a guess, and such a turn cannot be live anyway.
  const turnRecordedAsEnded =
    current.statusSource === "recorded" && current.status !== "running";
  const toolByUseId = new Map(
    current.tools.map((tool) => [tool.toolUseId, tool]),
  );
  const liveToolIds = new Set<string>();
  const liveContentKeys = new Set<string>();
  const liveSteeringIds = new Set<string>();
  for (const step of liveTurn.steps) {
    for (const message of step.leadingSteering ?? []) liveSteeringIds.add(message.id);
    if (step.thinking) liveContentKeys.add(`thinking\0${step.stepId}`);
    if (step.text) liveContentKeys.add(`text\0${step.stepId}`);
    for (const liveTool of step.tools) {
      liveToolIds.add(liveTool.toolUseId);
      const persisted = toolByUseId.get(liveTool.toolUseId);
      toolByUseId.set(
        liveTool.toolUseId,
        persisted
          ? mergeLiveOverPersisted(persisted, liveTool, turnRecordedAsEnded)
          : liveTool,
      );
    }
  }
  for (const message of liveTurn.pendingSteering ?? []) liveSteeringIds.add(message.id);
  const timeline: TurnTimelineItem[] = [];
  const lastSettledContentIndex = current.timeline.findLastIndex((item) => item.kind !== "user");
  const deferredSteering: Extract<TurnTimelineItem, { kind: "user" }>[] = [];
  for (const [index, item] of current.timeline.entries()) {
    if (item.kind !== "tools") {
      if (item.kind === "user" && liveSteeringIds.has(item.messageId)) continue;
      if (
        item.kind === "user" &&
        item.steeringEventId !== undefined &&
        index > lastSettledContentIndex
      ) {
        deferredSteering.push(item);
        continue;
      }
      if (liveContentKeys.has(`${item.kind}\0${item.messageId}`)) continue;
      timeline.push(item);
      continue;
    }
    const settledItems = item.items.filter(
      (tool) => !liveToolIds.has(tool.toolUseId),
    );
    if (settledItems.length > 0)
      timeline.push({ kind: "tools", items: settledItems });
  }
  const emittedSteeringIds = new Set<string>();
  const appendLiveSteering = (
    messages: readonly LiveSteeringProjection[],
  ): void => {
    for (const message of messages) {
      if (emittedSteeringIds.has(message.id)) continue;
      emittedSteeringIds.add(message.id);
      timeline.push({
        kind: "user",
        message: chatItemFromContent(message.id, message.ts, message.content),
        messageId: message.id,
      });
    }
  };
  for (const step of liveTurn.steps) {
    appendLiveSteering(step.leadingSteering ?? []);
    const contentOrder = step.contentOrder ?? [
      ...(step.thinking ? ["thinking" as const] : []),
      ...(step.text ? ["text" as const] : []),
      ...(step.tools.length > 0 ? ["tools" as const] : []),
    ];
    for (const kind of contentOrder) {
      if (kind === "thinking" && step.thinking?.text) {
        timeline.push({
          kind: "thinking",
          text: step.thinking.text,
          messageId: step.stepId,
          live: step.thinking.complete !== true,
          truncated: step.thinking.truncated,
        });
      } else if (kind === "text" && step.text?.text) {
        timeline.push({
          kind: "text",
          text: step.text.text,
          messageId: step.stepId,
          live: true,
          complete: step.text.complete,
          truncated: step.text.truncated,
        });
      } else if (kind === "tools") {
        const stepTools = step.tools.flatMap((tool) => {
          const projected = toolByUseId.get(tool.toolUseId);
          return projected ? [projected] : [];
        });
        if (stepTools.length > 0)
          timeline.push({ kind: "tools", items: stepTools });
      }
    }
  }
  appendLiveSteering(liveTurn.pendingSteering ?? []);
  timeline.push(...deferredSteering);
  const mergedTimeline = mergeAdjacentTimeline(timeline);
  const next = {
    ...current,
    tools: timelineTools(mergedTimeline),
    timeline: mergedTimeline,
  };
  const overlaid =
    targetIndex < 0
      ? [...turns, next]
      : turns.map((turn, index) => (index === targetIndex ? next : turn));
  return foldShellRunTurns(overlaid);
}

/**
 * The display state a shell-run update contributes to its owning tool: the
 * merged result plus the ownership badge. Folded from the raw update list once
 * per update change, so the per-tool application below sees one entry per tool
 * rather than the whole update history.
 */
export interface ShellRunOverlayEntry {
  result: Extract<ToolResultContent, { kind: "shell_run" }>;
  source: ToolActivityItem["shellRunSource"];
}

export function foldShellRunUpdates(
  updates: readonly ShellRunUpdate[],
): ReadonlyMap<string, ShellRunOverlayEntry> {
  const byToolUseId = new Map<string, ShellRunOverlayEntry>();
  for (const update of updates) {
    const current = byToolUseId.get(update.sourceToolCallId);
    const merged = mergeShellRunStateWithDiagnostics(
      current?.result,
      update.result,
      "ui.overlay-shell-run-updates",
    );
    byToolUseId.set(update.sourceToolCallId, {
      result: merged.result,
      source:
        !isActiveShellRunStatus(merged.result.status) ||
        update.ownership.kind === "local"
          ? undefined
          : update.ownership.kind === "source_owned"
            ? "owned"
            : "unavailable",
    });
  }
  return byToolUseId;
}

/**
 * Apply one folded update to the tool that owns it. Returns the SAME tool when
 * the update says nothing new, so a caller that holds the previous output can
 * tell "nothing changed" from object identity.
 *
 * A durable update's revision permanently leads the `tool_result` snapshot
 * persisted in messages, so against the persisted tool this returns a fresh
 * object every time. Identity for that case is re-established downstream by
 * value — see `reconcileTurnIdentities`.
 */
export function applyShellRunOverlayEntry(
  tool: ToolActivityItem,
  entry: ShellRunOverlayEntry,
): ToolActivityItem {
  if (tool.toolName !== "Bash") return tool;
  const current = tool.result?.kind === "shell_run" ? tool.result : undefined;
  if (tool.result && !current) return tool;
  const merged = mergeShellRunStateWithDiagnostics(
    current,
    entry.result,
    "ui.overlay-shell-run-update",
  );
  return merged.changed || tool.shellRunSource !== entry.source
    ? { ...tool, result: merged.result, shellRunSource: entry.source }
    : tool;
}

/**
 * Group materialized chat + tool items by `turnId` into ordered turns. Items
 * without a turnId (e.g. fake-backend echo, or older sessions) fall into a
 * synthetic `__loose` bucket rendered first so they remain visible.
 */
export function materializeTurns(
  messages: readonly StoredMessage[],
): TurnViewModel[] {
  const turnRecords = deriveTurnRecords(messages);
  const turnRecordById = new Map(
    turnRecords.map((turn) => [turn.turnId, turn]),
  );
  const order: string[] = [];
  const byId = new Map<string, TurnViewModel>();
  const looseTurnId = "__loose";
  // Storage-ordered messages per turn — the raw sequence the timeline pass
  // replays to interleave a step's thinking/text with its paired tools.
  const messagesByTurn = new Map<string, StoredMessage[]>();

  function ensureTurn(turnId: string, startedAt: number): TurnViewModel {
    let turn = byId.get(turnId);
    if (!turn) {
      const record = turnRecordById.get(turnId);
      turn = {
        turnId,
        status: record?.status ?? "completed",
        statusSource: record?.statusSource ?? "inferred",
        ...(record?.parentTurnId ? { parentTurnId: record.parentTurnId } : {}),
        ...(record?.retriedFromTurnId
          ? { retriedFromTurnId: record.retriedFromTurnId }
          : {}),
        ...(record?.regeneratedFromTurnId
          ? { regeneratedFromTurnId: record.regeneratedFromTurnId }
          : {}),
        ...(record?.branchOfTurnId
          ? { branchOfTurnId: record.branchOfTurnId }
          : {}),
        ...(record?.parentSessionId
          ? { parentSessionId: record.parentSessionId }
          : {}),
        ...(record?.abortedAt !== undefined
          ? { abortedAt: record.abortedAt }
          : {}),
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
    if (message.type === "user") {
      const user = chatItemFromUserMessage(message);
      if (!turn.user) {
        turn.user = user;
      }
    } else if (message.type === "assistant") {
      // A turn now holds one AssistantMessage per model step. Concatenate their
      // text (and thinking) in step order so the turn reads as one answer; keep
      // the first step's id as the stable anchor, and advance ts to the latest
      // step so durationMs measures to the turn's final assistant message.
      const priorText = turn.assistant?.text ?? "";
      const mergedText =
        message.text.length > 0
          ? priorText.length > 0
            ? `${priorText}\n\n${message.text}`
            : message.text
          : priorText;
      turn.assistant = {
        id: turn.assistant?.id ?? message.id,
        role: "assistant",
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
    } else if (
      message.type === "system_note" &&
      VISIBLE_SYSTEM_NOTES.has(message.kind)
    ) {
      turn.notes.push({
        id: message.id,
        role: "system",
        text: SYSTEM_NOTE_LABELS[message.kind] ?? message.kind,
        ts: message.ts,
      });
    } else if (message.type === "token_usage") {
      const totals = turn.tokens ?? { input: 0, output: 0 };
      totals.input += message.input;
      totals.output += message.output;
      if (message.cacheMissInput !== undefined)
        totals.cacheMiss = (totals.cacheMiss ?? 0) + message.cacheMissInput;
      if (message.cacheRead !== undefined)
        totals.cacheRead = (totals.cacheRead ?? 0) + message.cacheRead;
      if (message.cacheCreation !== undefined)
        totals.cacheCreation =
          (totals.cacheCreation ?? 0) + message.cacheCreation;
      if (message.reasoning !== undefined)
        totals.reasoning = (totals.reasoning ?? 0) + message.reasoning;
      if (message.costUsd !== undefined)
        totals.costUsd = (totals.costUsd ?? 0) + message.costUsd;
      turn.tokens = totals;
    }
  }

  // Second pass: build the canonical tool map. Live tools are applied
  // separately by overlayLiveTurn so streaming deltas never force settled
  // history to rematerialize.
  const toolItemByUseId = new Map<string, ToolActivityItem>(
    foldShellRunToolActivities(materializeTools(messages)).map((tool) => [
      tool.toolUseId,
      tool,
    ]),
  );
  // Third pass: rebuild each turn's render timeline from its storage-ordered
  // messages, interleaving a step's thinking/text with its paired tools. The
  // timeline is the turn's only tool authority; `tools` is flattened out of it
  // so the two can never disagree about which tools a turn holds (a tool_call
  // row always lands in its own turn's message list, so every surviving tool
  // reaches exactly one timeline).
  for (const turnId of order) {
    const turn = byId.get(turnId)!;
    turn.timeline = buildTurnTimeline(
      messagesByTurn.get(turnId) ?? [],
      toolItemByUseId,
    );
    turn.tools = timelineTools(turn.timeline);
  }

  return order.map((turnId) => byId.get(turnId)!);
}

/**
 * The turn's final reply: the last answer step on the timeline. Intermediate
 * steps (text emitted between tool calls) narrate the work in progress; the
 * clipboard wants only the answer the turn settled on (#2407), not the
 * `\n\n`-joined `assistant.text` aggregate. Falls back to the aggregate for
 * turns with no timeline text entry.
 */
export function finalAssistantReplyText(turn: TurnViewModel): string {
  for (let index = turn.timeline.length - 1; index >= 0; index -= 1) {
    const item = turn.timeline[index];
    if (item?.kind === "text" && item.text.length > 0) return item.text;
  }
  return turn.assistant?.text ?? "";
}

/**
 * Fold a background command's child tools (its `Read`s and `StopBackgroundTask`)
 * into the `Bash` that owns the run.
 *
 * Parent lookup is deliberately position-independent. A turn's tools are a
 * flattening of its timeline, and a live overlay moves that turn's tools to the
 * end of the timeline — which can order a child ahead of the `Bash` it belongs
 * to. Scanning only what has been folded so far would silently stop folding
 * there, leaving an orphan tool row and a parent that never took the child's
 * revision.
 */
export function foldShellRunToolActivities(
  items: readonly ToolActivityItem[],
): ToolActivityItem[] {
  const ownedRefs = new Set<string>();
  for (const item of items) {
    if (item.toolName === "Bash" && item.result?.kind === "shell_run")
      ownedRefs.add(item.result.ref);
  }

  const folded: ToolActivityItem[] = [];
  const parentIndexByRef = new Map<string, number>();
  const childResultsByRef = new Map<string, ShellRunToolResult[]>();

  for (const item of items) {
    const result = item.result?.kind === "shell_run" ? item.result : undefined;
    if (!result || item.toolName === "Bash") {
      if (result) parentIndexByRef.set(result.ref, folded.length);
      folded.push(item);
      continue;
    }
    if (ownedRefs.has(result.ref)) {
      const pending = childResultsByRef.get(result.ref);
      if (pending) pending.push(result);
      else childResultsByRef.set(result.ref, [result]);
      if (item.toolName === "Read" || item.toolName === "StopBackgroundTask")
        continue;
    }
    folded.push(item);
  }

  for (const [ref, results] of childResultsByRef) {
    const index = parentIndexByRef.get(ref)!;
    const parent = folded[index]!;
    let current =
      parent.result?.kind === "shell_run" ? parent.result : undefined;
    let changed = false;
    for (const result of results) {
      const merged = mergeShellRunStateWithDiagnostics(
        current,
        result,
        "ui.fold-shell-run-child",
      );
      if (merged.changed) {
        current = merged.result;
        changed = true;
      }
    }
    if (changed && current) folded[index] = { ...parent, result: current };
  }

  return folded;
}

function foldShellRunTurns(
  turns: readonly TurnViewModel[],
): readonly TurnViewModel[] {
  return projectTurnTools(
    turns,
    foldShellRunToolActivities(turns.flatMap((turn) => turn.tools)),
  );
}

/** Flatten a turn's timeline into its tool list — the one derivation direction. */
export function timelineTools(
  timeline: readonly TurnTimelineItem[],
): ToolActivityItem[] {
  return timeline.flatMap((item) => (item.kind === "tools" ? item.items : []));
}

/**
 * Rewrite `turns` against a canonical tool map. The timeline is rebuilt from
 * the map and `turn.tools` is flattened out of the rebuilt timeline, so there
 * is one tool authority per turn instead of two structures kept in step.
 *
 * Identity-preserving: a turn whose tools all resolve to the objects it
 * already holds is returned unchanged, which is what lets a memoized TurnView
 * skip a turn that this pass did not touch.
 */
export function projectTurnTools(
  turns: readonly TurnViewModel[],
  tools: readonly ToolActivityItem[],
): readonly TurnViewModel[] {
  const projected = new Map(tools.map((tool) => [tool.toolUseId, tool]));
  return turns.map((turn) => {
    let changed = false;
    const timeline = turn.timeline.flatMap<TurnTimelineItem>(
      (item): TurnTimelineItem[] => {
        if (item.kind !== "tools") return [item];
        const items = item.items.flatMap((tool) => {
          const projectedTool = projected.get(tool.toolUseId);
          return projectedTool ? [projectedTool] : [];
        });
        if (
          items.length !== item.items.length ||
          items.some((tool, index) => tool !== item.items[index])
        ) {
          changed = true;
        }
        return items.length > 0 ? [{ kind: "tools" as const, items }] : [];
      },
    );
    if (!changed) return turn;
    return { ...turn, tools: timelineTools(timeline), timeline };
  });
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
 * a blank line; adjacent tools groups merge into one group.
 */
function buildTurnTimeline(
  turnMessages: readonly StoredMessage[],
  toolItemByUseId: ReadonlyMap<string, ToolActivityItem>,
): TurnTimelineItem[] {
  const raw: TurnTimelineItem[] = [];
  let pending: ToolActivityItem[] = [];
  let sawUser = false;
  const flushTools = (items: ToolActivityItem[]): void => {
    if (items.length > 0) raw.push({ kind: "tools", items });
  };
  for (const message of turnMessages) {
    if (message.type === "user") {
      if (!sawUser) {
        sawUser = true;
        continue;
      }
      flushTools(pending);
      pending = [];
      raw.push({
        kind: "user",
        message: chatItemFromUserMessage(message),
        messageId: message.id,
        ...(message.steeringEventId ? { steeringEventId: message.steeringEventId } : {}),
      });
    } else if (message.type === "tool_call") {
      const item = toolItemByUseId.get(message.id);
      if (item) pending.push(item);
    } else if (message.type === "assistant") {
      const rowId = message.id;
      const legacy = pending.filter((tool) => tool.stepId === undefined);
      const matched = pending.filter((tool) => tool.stepId === rowId);
      // stepId set but not this row's: orphans of an earlier pure-tool step
      // (no assistant row carries their stepId). A later step's tools cannot
      // be pending here — the ledger appends them after this assistant row —
      // so these ran earlier and must render before this step's content.
      const orphaned = pending.filter(
        (tool) => tool.stepId !== undefined && tool.stepId !== rowId,
      );
      pending = [];
      flushTools(orphaned);
      if (message.contentOrder?.length) {
        // Legacy calls cannot be associated with a step, so preserve their
        // old pre-answer position without letting them disturb the recorded
        // order of this row's own content.
        flushTools(legacy);
        const remaining = new Set<"thinking" | "text" | "tools">([
          "thinking",
          "text",
          "tools",
        ]);
        const append = (kind: "thinking" | "text" | "tools"): void => {
          if (!remaining.delete(kind)) return;
          if (kind === "thinking" && message.thinking?.text) {
            raw.push({
              kind: "thinking",
              text: message.thinking.text,
              messageId: rowId,
            });
          } else if (kind === "text" && message.text.length > 0) {
            raw.push({
              kind: "text",
              text: message.text,
              messageId: rowId,
              ts: message.ts,
            });
          } else if (kind === "tools") {
            flushTools(matched);
          }
        };
        for (const kind of message.contentOrder) append(kind);
        // Malformed or partial metadata must never hide persisted content.
        for (const kind of ["thinking", "text", "tools"] as const) append(kind);
      } else {
        if (message.thinking?.text) {
          raw.push({
            kind: "thinking",
            text: message.thinking.text,
            messageId: rowId,
          });
        }
        flushTools(legacy);
        if (message.text.length > 0) {
          raw.push({
            kind: "text",
            text: message.text,
            messageId: rowId,
            ts: message.ts,
          });
        }
        flushTools(matched);
      }
    }
  }
  flushTools(pending);
  return mergeAdjacentTimeline(raw);
}

function chatItemFromUserMessage(message: UserMessage): ChatItem {
  return chatItemFromContent(message.id, message.ts, message, message.origin);
}

function chatItemFromContent(
  id: string,
  ts: number,
  content: MessageContent,
  hostOrigin?: NonNullable<UserMessage["origin"]>,
): ChatItem {
  return {
    id,
    role: "user",
    text: content.displayText ?? content.text,
    ts,
    ...(content.attachments && content.attachments.length > 0
      ? { attachments: content.attachments }
      : {}),
    ...(content.quotes && content.quotes.length > 0
      ? { quotes: content.quotes }
      : {}),
    ...(content.inlineReferences !== undefined
      ? { inlineReferences: content.inlineReferences }
      : {}),
    ...(hostOrigin ? { hostOrigin } : {}),
  };
}

function mergeAdjacentTimeline(
  items: readonly TurnTimelineItem[],
): TurnTimelineItem[] {
  const out: TurnTimelineItem[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (
      item.kind === "thinking" &&
      last?.kind === "thinking" &&
      !item.live &&
      !last.live
    ) {
      last.text = `${last.text}\n\n${item.text}`;
    } else if (item.kind === "tools" && last?.kind === "tools") {
      last.items = [...last.items, ...item.items];
    } else if (item.kind === "tools") {
      out.push({ kind: "tools", items: [...item.items] });
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
  turns: readonly Pick<
    TurnRecord,
    "turnId" | "retriedFromTurnId" | "regeneratedFromTurnId"
  >[],
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
