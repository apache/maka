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
 * Materializer — converts durable messages into the view-model shape the UI
 * renders. Lives in `runtime` (not `storage`) because correlation is a semantic
 * operation, not a disk concern.
 *
 * Runtime/UI materializer for rebuilding chat and tool activity state from
 * append-only stored messages.
 */

import type {
  StoredMessage,
  UserMessage,
  AssistantMessage,
  ToolCallMessage,
  ToolResultMessage,
  PermissionDecisionMessage,
  TokenUsageMessage,
  SystemNoteMessage,
  TurnStatus,
} from '@maka/core/session';

import type { ToolActivityKind, ToolResultContent } from '@maka/core/events';

import type { ToolActivityStatus } from '@maka/core/tool-result-status';
import { deriveTurnRecords } from '@maka/core/session';
import { projectToolActivityArgs } from '@maka/core/tool-activity-args';
import {
  toolResultActivityStatus,
  unfinishedToolActivityStatus,
} from '@maka/core/tool-result-status';

// ============================================================================
// View-model types (mirror packages/ui/src exports, lifted here for reuse)
// ============================================================================

export interface ToolActivityItem {
  toolUseId: string;
  toolName: string;
  activityKind?: ToolActivityKind;
  displayName?: string;
  intent?: string;
  status: ToolActivityStatus;
  args: unknown;
  result?: ToolResultContent;
  isError?: boolean;
  durationMs?: number;
  ts: number;
}

export type ChatItem =
  | { kind: 'user'; message: UserMessage }
  | { kind: 'assistant'; message: AssistantMessage }
  | { kind: 'tool'; item: ToolActivityItem; decision?: PermissionDecisionMessage }
  | { kind: 'system_note'; message: SystemNoteMessage };

export interface SessionViewModel {
  items: ChatItem[];
  totalTokens: { input: number; output: number; costUsd?: number };
}

// ============================================================================
// Materialize one shot (used on session reload)
// ============================================================================

/**
 * Convert StoredMessage[] into a ChatItem[] for rendering.
 *
 * A ToolCallMessage with no matching ToolResultMessage is read against its
 * turn: still `running` means the call is in flight, anything else makes it
 * `interrupted`. Storage never synthesizes a fake ToolResultMessage — that's
 * our job here.
 */
export function materializeSession(messages: readonly StoredMessage[]): SessionViewModel {
  const items: ChatItem[] = [];
  let totalInput = 0;
  let totalOutput = 0;
  let totalCostUsd = 0;
  let hasCost = false;

  // Index for tool correlation. ToolCallMessage.id === toolUseId, by §4.2.
  const resultsByToolUseId = new Map<string, ToolResultMessage>();
  const decisionsByToolUseId = new Map<string, PermissionDecisionMessage>();
  const turnStatusById = new Map(
    deriveTurnRecords(messages).map((turn) => [turn.turnId, turn.status]),
  );

  // First pass: index results + decisions.
  for (const m of messages) {
    if (m.type === 'tool_result') {
      resultsByToolUseId.set(m.toolUseId, m);
    } else if (m.type === 'permission_decision') {
      decisionsByToolUseId.set(m.toolUseId, m);
    }
  }

  // Second pass: emit ChatItems in document order, skipping tool_result + decision
  // (they're folded into the tool ChatItem at the call site).
  for (const m of messages) {
    switch (m.type) {
      case 'user':
        items.push({ kind: 'user', message: m });
        break;
      case 'assistant':
        items.push({ kind: 'assistant', message: m });
        break;
      case 'tool_call': {
        const result = resultsByToolUseId.get(m.id);
        const decision = decisionsByToolUseId.get(m.id);
        items.push({
          kind: 'tool',
          item: toolActivityFromPair(m, result, turnStatusById.get(m.turnId)),
          decision,
        });
        break;
      }
      case 'tool_result':
      case 'permission_decision':
        // folded into tool ChatItem above; skip here
        break;
      case 'token_usage':
        totalInput += m.input;
        totalOutput += m.output;
        if (typeof m.costUsd === 'number') {
          totalCostUsd += m.costUsd;
          hasCost = true;
        }
        break;
      case 'system_note':
        items.push({ kind: 'system_note', message: m });
        break;
    }
  }

  return {
    items,
    totalTokens: {
      input: totalInput,
      output: totalOutput,
      ...(hasCost ? { costUsd: totalCostUsd } : {}),
    },
  };
}

/**
 * Build a ToolActivityItem from a (ToolCallMessage, ToolResultMessage?) pair.
 *
 * - Missing result → `unfinishedToolActivityStatus` reads it against the turn
 * - Cancelled shell / aborted explore → 'interrupted' (not failure)
 * - Result with isError === true → 'errored' (includes permission deny/block)
 * - Result with isError === false → 'completed'
 */
function toolActivityFromPair(
  call: ToolCallMessage,
  result: ToolResultMessage | undefined,
  turnStatus: TurnStatus | undefined,
): ToolActivityItem {
  if (result === undefined) {
    return {
      toolUseId: call.id,
      toolName: call.toolName,
      ...(call.activityKind !== undefined ? { activityKind: call.activityKind } : {}),
      ...(call.displayName !== undefined ? { displayName: call.displayName } : {}),
      ...(call.intent !== undefined ? { intent: call.intent } : {}),
      status: unfinishedToolActivityStatus(turnStatus),
      args: projectToolActivityArgs(call.toolName, call.args),
      ts: call.ts,
    };
  }
  return {
    toolUseId: call.id,
    toolName: call.toolName,
    ...(call.activityKind !== undefined ? { activityKind: call.activityKind } : {}),
    ...(call.displayName !== undefined ? { displayName: call.displayName } : {}),
    ...(call.intent !== undefined ? { intent: call.intent } : {}),
    status: toolResultActivityStatus(result.isError, result.content),
    args: projectToolActivityArgs(call.toolName, call.args),
    result: result.content,
    isError: result.isError,
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    ts: call.ts,
  };
}

// ============================================================================
// Streaming patch for live updates (used during an active turn)
// ============================================================================

/**
 * Apply a single newly-appended StoredMessage to an existing ChatItem[].
 * Used by the renderer to incrementally update the view as events / writes
 * land, without re-materializing the whole session.
 *
 * Returns the new items array (immutable update) and an optional patch hint
 * indicating which existing item id was modified.
 */
export function applyAppendedMessage(
  items: readonly ChatItem[],
  message: StoredMessage,
): { items: ChatItem[]; modifiedToolUseId?: string } {
  switch (message.type) {
    case 'user':
      return { items: [...items, { kind: 'user', message }] };

    case 'assistant':
      return { items: [...items, { kind: 'assistant', message }] };

    case 'tool_call': {
      const item: ToolActivityItem = {
        toolUseId: message.id,
        toolName: message.toolName,
        ...(message.activityKind !== undefined ? { activityKind: message.activityKind } : {}),
        ...(message.displayName !== undefined ? { displayName: message.displayName } : {}),
        ...(message.intent !== undefined ? { intent: message.intent } : {}),
        status: 'pending',
        args: projectToolActivityArgs(message.toolName, message.args),
        ts: message.ts,
      };
      return { items: [...items, { kind: 'tool', item }] };
    }

    case 'tool_result': {
      // Patch the matching tool ChatItem in place by toolUseId.
      const next = items.map((it) => {
        if (it.kind !== 'tool' || it.item.toolUseId !== message.toolUseId) return it;
        return {
          ...it,
          item: {
            ...it.item,
            status: toolResultActivityStatus(message.isError, message.content),
            result: message.content,
            isError: message.isError,
            ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
          },
        };
      });
      return { items: next, modifiedToolUseId: message.toolUseId };
    }

    case 'permission_decision': {
      const next = items.map((it) => {
        if (it.kind !== 'tool' || it.item.toolUseId !== message.toolUseId) return it;
        return { ...it, decision: message };
      });
      return { items: next, modifiedToolUseId: message.toolUseId };
    }

    case 'system_note':
      return { items: [...items, { kind: 'system_note', message }] };

    case 'token_usage':
      // No item to render; UI aggregates separately.
      return { items: [...items] };

    case 'turn_state':
      // Turn metadata feeds the higher-level TurnViewModel projection; the
      // incremental ChatItem stream has no standalone row for it.
      return { items: [...items] };
  }
}

// ============================================================================
// Event-driven UI status transitions (used during streaming)
// ============================================================================

/**
 * Renderer helpers for transitioning ToolActivityItem.status based on
 * SessionEvent stream (NOT JSONL replay). Idempotent by toolUseId per §10
 * implementation notes — multiple events for the same id are merged.
 */
export function setToolStatus(
  items: readonly ChatItem[],
  toolUseId: string,
  patch: Partial<Pick<ToolActivityItem, 'status' | 'result' | 'isError' | 'durationMs'>>,
): ChatItem[] {
  return items.map((it) => {
    if (it.kind !== 'tool' || it.item.toolUseId !== toolUseId) return it;
    return { ...it, item: { ...it.item, ...patch } };
  });
}
