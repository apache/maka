<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Runtime Ledger Backfill Implementation Plan

> Archived: the implementation landed in PR #188. This plan is retained only as historical execution context.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Agent runtime reads and subsequent turns continue when a completed top-level run has an empty RuntimeEvent ledger, by reconstructing only low-risk RuntimeEvents from legacy StoredMessage rows.

**Architecture:** Add a focused runtime helper that synthesizes in-memory RuntimeEvents from same-turn StoredMessage rows and marks every recovered event with `actions.stateDelta.makaRuntimeRecovery`. Wire that helper into `RuntimeReadModel.getSessionView()` and `AgentRun.buildPriorRuntimeContext()` only when `RuntimeEventStore.readRuntimeEvents()` returns an empty array for a terminal run. Do not write recovered events back to `RuntimeEventStore` in this first version because the store exposes only single-event append; a partial repair write could make the ledger worse.

**Tech Stack:** TypeScript, Node test runner, `@maka/core` RuntimeEvent and StoredMessage types, `@maka/runtime` read model and AgentRun paths.

---

## Scope

This plan fixes only empty RuntimeEvent ledgers for terminal, top-level Agent runs when safe legacy StoredMessage evidence exists.

It does not repair non-empty ledgers that are missing a terminal RuntimeEvent. It does not reconstruct streaming partial chunks, provider event ids, permission requests, artifact deltas, agent transfer events, or branch metadata. Those fields are high risk because the legacy StoredMessage rows do not carry enough evidence to recreate them without guessing.

## File Structure

- Create: `packages/runtime/src/runtime-event-backfill.ts`
  - Pure helper for converting low-risk legacy StoredMessage rows into marked RuntimeEvents.
  - No UI imports, no SessionManager dependency, no RuntimeEventStore writes.
- Create: `packages/runtime/src/__tests__/runtime-event-backfill.test.ts`
  - Unit tests for low-risk conversion, recovery markers, and skipped high-risk rows.
- Modify: `packages/runtime/src/runtime-read-model.ts`
  - When a terminal run has an empty RuntimeEvent ledger, read legacy rows from `projectionCache` and use recovered in-memory events if they include a terminal event.
- Modify: `packages/runtime/src/agent-run.ts`
  - When building prior model context and a previous terminal run has an empty ledger, read legacy rows from `input.store` and use recovered in-memory events if they include a terminal event.
- Modify: `packages/runtime/src/__tests__/session-manager.test.ts`
  - Change the current hard-fail read-model test into a recovery test.
  - Add a second-turn test proving `AgentRun` can build model context from recovered events.

## Low-Risk Backfill Rules

Backfill only rows whose RuntimeEvent shape is directly evidenced by StoredMessage:

- `user` -> `role: 'user'`, `author: 'user'`, `content.kind: 'text'`, preserve attachments.
- `assistant` -> `role: 'model'`, `author: 'agent'`, `content.kind: 'text'`.
- `assistant.thinking` -> separate `content.kind: 'thinking'` event, preserve signature.
- `tool_call` -> `content.kind: 'function_call'`, preserve id, name, args, displayName, intent.
- `tool_result` -> `content.kind: 'function_response'` only when a same-turn earlier `tool_call` with the same id exists.
- `permission_decision` -> `actions.permissionDecision` only when a same-turn earlier `tool_call` with the same id exists.
- `token_usage` -> `actions.tokenUsage`, copying fields exactly.
- terminal event -> `status` plus `actions.endInvocation` only when it can be safely mapped:
  - `completed` is safe.
  - `failed` is safe only if `AgentRunHeader.failureClass` exists.
  - `aborted` / `cancelled` is safe only if a legacy `TurnStateMessage.abortSource` exists.

Every recovered event must carry:

```ts
actions: {
  stateDelta: {
    makaRuntimeRecovery: {
      kind: 'runtime_event_backfill',
      source: 'legacy_stored_message',
      reason: 'missing_runtime_event_ledger',
      sourceMessageId: 'legacy-message-id',
      sourceMessageType: 'assistant',
      confidence: 'lossless',
      generatedAt: 1710000000000,
      version: 1,
    },
  },
}
```

For synthetic terminal events, `sourceMessageId` and `sourceMessageType` should point to the latest same-turn `turn_state` row when present.

### Task 1: Backfill Helper Unit Tests

**Files:**
- Create: `packages/runtime/src/__tests__/runtime-event-backfill.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Create `packages/runtime/src/__tests__/runtime-event-backfill.test.ts` with this content:

```ts
import { describe, test } from 'node:test';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { StoredMessage } from '@maka/core/session';
import { expect } from '../test-helpers.js';
import {
  RUNTIME_EVENT_BACKFILL_STATE_KEY,
  backfillRuntimeEventsFromStoredMessages,
} from '../runtime-event-backfill.js';

const run: AgentRunHeader = {
  runId: 'run-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  status: 'completed',
  backendKind: 'fake',
  llmConnectionSlug: 'fake',
  modelId: 'fake-model',
  cwd: '/tmp/cwd',
  permissionMode: 'ask',
  createdAt: 100,
  updatedAt: 180,
  completedAt: 180,
};

function nextIds(): () => string {
  let index = 0;
  return () => {
    index += 1;
    return `rt-backfill-${index}`;
  };
}

function recoveryMarker(event: RuntimeEvent): Record<string, unknown> | undefined {
  return event.actions?.stateDelta?.[RUNTIME_EVENT_BACKFILL_STATE_KEY] as Record<string, unknown> | undefined;
}

describe('runtime event backfill', () => {
  test('backfills only low-risk RuntimeEvents from legacy StoredMessage rows', () => {
    const messages: StoredMessage[] = [
      {
        type: 'user',
        id: 'legacy-user',
        turnId: 'turn-1',
        ts: 101,
        text: 'hello',
        attachments: [{
          kind: 'txt',
          name: 'note.txt',
          mimeType: 'text/plain',
          bytes: 12,
          ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'attachments/note.txt' },
        }],
      },
      {
        type: 'assistant',
        id: 'legacy-assistant',
        turnId: 'turn-1',
        ts: 110,
        text: 'answer',
        modelId: 'fake-model',
        thinking: { text: 'reasoning', signature: 'sig-1' },
      },
      {
        type: 'tool_call',
        id: 'tool-1',
        turnId: 'turn-1',
        ts: 120,
        toolName: 'Read',
        displayName: 'Read file',
        intent: 'inspect',
        args: { path: 'README.md' },
      },
      {
        type: 'tool_result',
        id: 'legacy-tool-result',
        turnId: 'turn-1',
        ts: 130,
        toolUseId: 'tool-1',
        isError: false,
        content: { kind: 'text', text: 'file body' },
        durationMs: 42,
      },
      {
        type: 'permission_decision',
        id: 'perm-1',
        turnId: 'turn-1',
        ts: 140,
        toolUseId: 'tool-1',
        toolName: 'Read',
        decision: 'allow',
        rememberForTurn: true,
      },
      {
        type: 'token_usage',
        id: 'usage-1',
        turnId: 'turn-1',
        ts: 150,
        input: 10,
        output: 5,
        total: 15,
      },
      {
        type: 'turn_state',
        id: 'legacy-state',
        turnId: 'turn-1',
        ts: 180,
        status: 'completed',
        partialOutputRetained: true,
      },
    ];

    const result = backfillRuntimeEventsFromStoredMessages({
      run,
      messages,
      newId: nextIds(),
      now: () => 999,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.events.map((event) => event.id)).toEqual([
      'rt-backfill-1',
      'rt-backfill-2',
      'rt-backfill-3',
      'rt-backfill-4',
      'rt-backfill-5',
      'rt-backfill-6',
      'rt-backfill-7',
      'rt-backfill-8',
    ]);
    expect(result.events.map((event) => event.invocationId)).toEqual(Array(8).fill('backfill-run-1'));
    expect(result.events.map((event) => event.partial)).toEqual(Array(8).fill(false));
    expect(result.events[0]?.content).toEqual({
      kind: 'text',
      text: 'hello',
      attachments: [{
        kind: 'txt',
        name: 'note.txt',
        mimeType: 'text/plain',
        bytes: 12,
        ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'attachments/note.txt' },
      }],
    });
    expect(result.events[1]?.content).toEqual({ kind: 'text', text: 'answer' });
    expect(result.events[2]?.content).toEqual({ kind: 'thinking', text: 'reasoning', signature: 'sig-1' });
    expect(result.events[3]?.content).toEqual({ kind: 'function_call', id: 'tool-1', name: 'Read', args: { path: 'README.md' } });
    expect(result.events[3]?.actions?.stateDelta?.displayName).toBe('Read file');
    expect(result.events[3]?.actions?.stateDelta?.intent).toBe('inspect');
    expect(result.events[4]?.content).toEqual({ kind: 'function_response', id: 'tool-1', name: 'Read', result: { kind: 'text', text: 'file body' }, isError: false });
    expect(result.events[4]?.actions?.stateDelta?.durationMs).toBe(42);
    expect(result.events[5]?.actions?.permissionDecision).toEqual({ requestId: 'perm-1', decision: 'allow', rememberForTurn: true });
    expect(result.events[5]?.refs).toEqual({ storedMessageId: 'perm-1', toolCallId: 'tool-1' });
    expect(result.events[6]?.actions?.tokenUsage).toEqual({ input: 10, output: 5, total: 15 });
    expect(result.events[7]?.status).toBe('completed');
    expect(result.events[7]?.actions?.endInvocation).toBe(true);
    expect(result.events[7]?.refs).toEqual({ storedMessageId: 'legacy-state' });

    for (const event of result.events) {
      expect(recoveryMarker(event)).toMatchObject({
        kind: 'runtime_event_backfill',
        source: 'legacy_stored_message',
        reason: 'missing_runtime_event_ledger',
        confidence: 'lossless',
        generatedAt: 999,
        version: 1,
      });
    }
  });

  test('skips high-risk legacy rows that cannot be reconstructed safely', () => {
    const messages: StoredMessage[] = [
      {
        type: 'tool_result',
        id: 'orphan-result',
        turnId: 'turn-1',
        ts: 120,
        toolUseId: 'missing-tool',
        isError: false,
        content: { kind: 'text', text: 'orphan' },
      },
      {
        type: 'permission_decision',
        id: 'orphan-permission',
        turnId: 'turn-1',
        ts: 130,
        toolUseId: 'missing-tool',
        toolName: 'Write',
        decision: 'deny',
      },
      {
        type: 'system_note',
        id: 'session-note',
        ts: 140,
        kind: 'session_resume',
      },
      {
        type: 'turn_state',
        id: 'legacy-state',
        turnId: 'turn-1',
        ts: 180,
        status: 'completed',
        partialOutputRetained: false,
      },
    ];

    const result = backfillRuntimeEventsFromStoredMessages({
      run,
      messages,
      newId: nextIds(),
      now: () => 999,
    });

    expect(result.events.map((event) => event.status)).toEqual(['completed']);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'skipped_unmatched_tool_result',
      'skipped_unmatched_permission_decision',
      'skipped_high_risk_message',
    ]);
  });
});
```

- [ ] **Step 2: Run typecheck to verify the test fails before implementation**

Run:

```bash
npm --workspace @maka/runtime run typecheck
```

Expected: FAIL with an error like:

```text
Cannot find module '../runtime-event-backfill.js'
```

- [ ] **Step 3: Commit the failing test**

Run:

```bash
git add packages/runtime/src/__tests__/runtime-event-backfill.test.ts
git commit -m "test: cover runtime ledger backfill rules"
```

### Task 2: RuntimeEvent Backfill Helper

**Files:**
- Create: `packages/runtime/src/runtime-event-backfill.ts`
- Test: `packages/runtime/src/__tests__/runtime-event-backfill.test.ts`

- [ ] **Step 1: Implement the helper**

Create `packages/runtime/src/runtime-event-backfill.ts` with this content:

```ts
import type {
  RuntimeEvent,
  RuntimeEventStatus,
} from '@maka/core/runtime-event';
import { createRuntimeEventId } from '@maka/core/runtime-event';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type {
  PermissionDecisionMessage,
  StoredMessage,
  TokenUsageMessage,
  ToolCallMessage,
  ToolResultMessage,
  TurnStateMessage,
} from '@maka/core/session';

export const RUNTIME_EVENT_BACKFILL_STATE_KEY = 'makaRuntimeRecovery';

export type RuntimeEventBackfillDiagnosticCode =
  | 'skipped_high_risk_message'
  | 'skipped_unmatched_tool_result'
  | 'skipped_unmatched_permission_decision'
  | 'skipped_unsafe_terminal_state';

export interface RuntimeEventBackfillDiagnostic {
  code: RuntimeEventBackfillDiagnosticCode;
  message: string;
  detail?: unknown;
}

export interface RuntimeEventBackfillInput {
  run: AgentRunHeader;
  messages: readonly StoredMessage[];
  invocationId?: string;
  now?: () => number;
  newId?: () => string;
}

export interface RuntimeEventBackfillResult {
  events: RuntimeEvent[];
  diagnostics: RuntimeEventBackfillDiagnostic[];
}

interface RuntimeEventBackfillRecoveryState {
  kind: 'runtime_event_backfill';
  source: 'legacy_stored_message';
  reason: 'missing_runtime_event_ledger';
  sourceMessageId?: string;
  sourceMessageType?: StoredMessage['type'];
  confidence: 'lossless';
  generatedAt: number;
  version: 1;
}

export function backfillRuntimeEventsFromStoredMessages(input: RuntimeEventBackfillInput): RuntimeEventBackfillResult {
  const newId = input.newId ?? (() => createRuntimeEventId('rt-backfill'));
  const now = input.now ?? (() => Date.now());
  const invocationId = input.invocationId ?? `backfill-${input.run.runId}`;
  const diagnostics: RuntimeEventBackfillDiagnostic[] = [];
  const events: RuntimeEvent[] = [];
  const turnMessages = input.messages
    .filter((message) => messageTurnId(message) === input.run.turnId)
    .slice()
    .sort((a, b) => a.ts - b.ts || messageId(a).localeCompare(messageId(b)));
  const toolCalls = new Map<string, ToolCallMessage>();

  for (const message of turnMessages) {
    if (message.type === 'tool_call') {
      toolCalls.set(message.id, message);
    }
  }

  for (const message of turnMessages) {
    const base = {
      invocationId,
      runId: input.run.runId,
      sessionId: input.run.sessionId,
      turnId: input.run.turnId,
      ts: message.ts,
      partial: false,
    } as const;

    switch (message.type) {
      case 'user':
        events.push({
          ...base,
          id: newId(),
          role: 'user',
          author: 'user',
          content: {
            kind: 'text',
            text: message.text,
            ...(message.attachments !== undefined && message.attachments.length > 0
              ? { attachments: message.attachments }
              : {}),
          },
          actions: { stateDelta: recoveryState(now, message) },
          refs: { storedMessageId: message.id },
        });
        break;

      case 'assistant':
        events.push({
          ...base,
          id: newId(),
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: message.text },
          actions: { stateDelta: recoveryState(now, message) },
          refs: { storedMessageId: message.id },
        });
        if (message.thinking && message.thinking.text.length > 0) {
          events.push({
            ...base,
            id: newId(),
            role: 'model',
            author: 'agent',
            content: {
              kind: 'thinking',
              text: message.thinking.text,
              ...(message.thinking.signature !== undefined ? { signature: message.thinking.signature } : {}),
            },
            actions: { stateDelta: recoveryState(now, message) },
            refs: { storedMessageId: message.id },
          });
        }
        break;

      case 'tool_call':
        events.push({
          ...base,
          id: newId(),
          role: 'model',
          author: 'agent',
          content: {
            kind: 'function_call',
            id: message.id,
            name: message.toolName,
            args: message.args,
          },
          actions: {
            stateDelta: {
              ...recoveryState(now, message),
              ...(message.displayName !== undefined ? { displayName: message.displayName } : {}),
              ...(message.intent !== undefined ? { intent: message.intent } : {}),
            },
          },
          refs: { storedMessageId: message.id, toolCallId: message.id },
        });
        break;

      case 'tool_result': {
        const call = safePriorToolCall(toolCalls, message);
        if (!call) {
          diagnostics.push({
            code: 'skipped_unmatched_tool_result',
            message: 'tool_result requires an earlier same-turn tool_call to recover RuntimeEvent function_response',
            detail: { messageId: message.id, toolUseId: message.toolUseId, runId: input.run.runId, turnId: input.run.turnId },
          });
          break;
        }
        events.push({
          ...base,
          id: newId(),
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: message.toolUseId,
            name: call.toolName,
            result: message.content,
            ...(message.isError ? { isError: true } : {}),
          },
          actions: {
            stateDelta: {
              ...recoveryState(now, message),
              ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
            },
          },
          refs: { storedMessageId: message.id, toolCallId: message.toolUseId },
        });
        break;
      }

      case 'permission_decision': {
        const call = safePriorToolCall(toolCalls, message);
        if (!call) {
          diagnostics.push({
            code: 'skipped_unmatched_permission_decision',
            message: 'permission_decision requires an earlier same-turn tool_call to recover RuntimeEvent permissionDecision',
            detail: { messageId: message.id, toolUseId: message.toolUseId, runId: input.run.runId, turnId: input.run.turnId },
          });
          break;
        }
        events.push({
          ...base,
          id: newId(),
          role: 'system',
          author: 'system',
          actions: {
            stateDelta: recoveryState(now, message),
            permissionDecision: {
              requestId: message.id,
              decision: message.decision,
              ...(message.rememberForTurn !== undefined ? { rememberForTurn: message.rememberForTurn } : {}),
            },
          },
          refs: { storedMessageId: message.id, toolCallId: call.id },
        });
        break;
      }

      case 'token_usage':
        events.push({
          ...base,
          id: newId(),
          role: 'system',
          author: 'system',
          actions: {
            stateDelta: recoveryState(now, message),
            tokenUsage: tokenUsageFromMessage(message),
          },
          refs: { storedMessageId: message.id },
        });
        break;

      case 'turn_state':
        break;

      case 'system_note':
        diagnostics.push({
          code: 'skipped_high_risk_message',
          message: 'system_note is not recovered into a run ledger because session-level notes may not belong to this run',
          detail: { messageId: message.id, kind: message.kind, runId: input.run.runId, turnId: input.run.turnId },
        });
        break;
    }
  }

  const terminal = terminalRuntimeEvent({ run: input.run, turnMessages, invocationId, newId, now });
  if (terminal.event) {
    events.push(terminal.event);
  } else if (terminal.diagnostic) {
    diagnostics.push(terminal.diagnostic);
  }

  return { events, diagnostics };
}

function recoveryState(now: () => number, message: StoredMessage): Record<string, unknown> {
  const state: RuntimeEventBackfillRecoveryState = {
    kind: 'runtime_event_backfill',
    source: 'legacy_stored_message',
    reason: 'missing_runtime_event_ledger',
    sourceMessageId: messageId(message),
    sourceMessageType: message.type,
    confidence: 'lossless',
    generatedAt: now(),
    version: 1,
  };
  return { [RUNTIME_EVENT_BACKFILL_STATE_KEY]: state };
}

function terminalRecoveryState(now: () => number, message: TurnStateMessage | undefined): Record<string, unknown> {
  const state: RuntimeEventBackfillRecoveryState = {
    kind: 'runtime_event_backfill',
    source: 'legacy_stored_message',
    reason: 'missing_runtime_event_ledger',
    ...(message ? { sourceMessageId: message.id, sourceMessageType: message.type } : {}),
    confidence: 'lossless',
    generatedAt: now(),
    version: 1,
  };
  return { [RUNTIME_EVENT_BACKFILL_STATE_KEY]: state };
}

function terminalRuntimeEvent(input: {
  run: AgentRunHeader;
  turnMessages: readonly StoredMessage[];
  invocationId: string;
  newId: () => string;
  now: () => number;
}): { event?: RuntimeEvent; diagnostic?: RuntimeEventBackfillDiagnostic } {
  const turnState = latestTurnState(input.turnMessages);
  const status = terminalStatus(input.run, turnState);
  if (!status) {
    return {
      diagnostic: {
        code: 'skipped_unsafe_terminal_state',
        message: 'terminal RuntimeEvent was not recovered because legacy terminal evidence is incomplete',
        detail: { runId: input.run.runId, turnId: input.run.turnId, runStatus: input.run.status, turnStatus: turnState?.status },
      },
    };
  }
  const ts = turnState?.ts ?? input.run.completedAt ?? input.run.updatedAt;
  return {
    event: {
      id: input.newId(),
      invocationId: input.invocationId,
      runId: input.run.runId,
      sessionId: input.run.sessionId,
      turnId: input.run.turnId,
      ts,
      partial: false,
      role: 'system',
      author: 'system',
      status,
      actions: {
        endInvocation: true,
        stateDelta: {
          ...terminalRecoveryState(input.now, turnState),
          ...(turnState?.abortSource !== undefined ? { abortSource: turnState.abortSource } : {}),
        },
      },
      ...(turnState ? { refs: { storedMessageId: turnState.id } } : {}),
    },
  };
}

function terminalStatus(run: AgentRunHeader, turnState: TurnStateMessage | undefined): RuntimeEventStatus | undefined {
  const legacyStatus = turnState?.status;
  if (legacyStatus === 'completed' || run.status === 'completed') return 'completed';
  if ((legacyStatus === 'failed' || run.status === 'failed') && run.failureClass) return 'failed';
  if ((legacyStatus === 'aborted' || run.status === 'cancelled') && turnState?.abortSource) return 'aborted';
  return undefined;
}

function latestTurnState(messages: readonly StoredMessage[]): TurnStateMessage | undefined {
  return messages
    .filter((message): message is TurnStateMessage => message.type === 'turn_state')
    .at(-1);
}

function safePriorToolCall(
  toolCalls: ReadonlyMap<string, ToolCallMessage>,
  message: ToolResultMessage | PermissionDecisionMessage,
): ToolCallMessage | undefined {
  const call = toolCalls.get(message.toolUseId);
  if (!call) return undefined;
  return call.ts <= message.ts ? call : undefined;
}

function tokenUsageFromMessage(message: TokenUsageMessage): NonNullable<RuntimeEvent['actions']>['tokenUsage'] {
  return {
    input: message.input,
    output: message.output,
    ...(message.cacheHitInput !== undefined ? { cacheHitInput: message.cacheHitInput } : {}),
    ...(message.cacheMissInput !== undefined ? { cacheMissInput: message.cacheMissInput } : {}),
    ...(message.cacheWriteInput !== undefined ? { cacheWriteInput: message.cacheWriteInput } : {}),
    ...(message.cacheMissInputSource !== undefined ? { cacheMissInputSource: message.cacheMissInputSource } : {}),
    ...(message.reasoning !== undefined ? { reasoning: message.reasoning } : {}),
    ...(message.total !== undefined ? { total: message.total } : {}),
    ...(message.rawFinishReason !== undefined ? { rawFinishReason: message.rawFinishReason } : {}),
    ...(message.cacheRead !== undefined ? { cacheRead: message.cacheRead } : {}),
    ...(message.cacheCreation !== undefined ? { cacheCreation: message.cacheCreation } : {}),
    ...(message.costUsd !== undefined ? { costUsd: message.costUsd } : {}),
    ...(message.systemPromptHash !== undefined ? { systemPromptHash: message.systemPromptHash } : {}),
    ...(message.prefixHash !== undefined ? { prefixHash: message.prefixHash } : {}),
    ...(message.prefixChangeReason !== undefined ? { prefixChangeReason: message.prefixChangeReason } : {}),
    ...(message.requestShapeHash !== undefined ? { requestShapeHash: message.requestShapeHash } : {}),
    ...(message.requestShapeChangeReason !== undefined ? { requestShapeChangeReason: message.requestShapeChangeReason } : {}),
    ...(message.promptSegments !== undefined ? { promptSegments: message.promptSegments } : {}),
    ...(message.contextBudget !== undefined ? { contextBudget: message.contextBudget } : {}),
  };
}

function messageTurnId(message: StoredMessage): string | undefined {
  return 'turnId' in message && typeof message.turnId === 'string' ? message.turnId : undefined;
}

function messageId(message: StoredMessage): string {
  return 'id' in message && typeof message.id === 'string' ? message.id : '';
}
```

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm --workspace @maka/runtime run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run runtime tests**

Run:

```bash
npm --workspace @maka/runtime run test
```

Expected: PASS, including `runtime-event-backfill.test.js`.

- [ ] **Step 4: Commit the helper**

Run:

```bash
git add packages/runtime/src/runtime-event-backfill.ts packages/runtime/src/__tests__/runtime-event-backfill.test.ts
git commit -m "feat: add in-memory runtime ledger backfill"
```

### Task 3: RuntimeReadModel Empty-Ledger Fallback

**Files:**
- Modify: `packages/runtime/src/runtime-read-model.ts`
- Modify: `packages/runtime/src/__tests__/session-manager.test.ts`
- Test: `packages/runtime/src/__tests__/session-manager.test.ts`

- [ ] **Step 1: Update the existing hard-fail test to expect recovery**

In `packages/runtime/src/__tests__/session-manager.test.ts`, replace the test named `getMessages rejects when a terminal run has no runtime ledger` with:

```ts
  test('getMessages backfills low-risk legacy rows when a terminal run has no runtime ledger', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    const legacyMessages: StoredMessage[] = [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'legacy only' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'legacy answer', modelId: 'fake-model' },
      { type: 'tool_call', id: 'tool-1', turnId: 'turn-1', ts: 103, toolName: 'Read', args: { path: 'README.md' } },
      { type: 'tool_result', id: 'legacy-tool-result', turnId: 'turn-1', ts: 104, toolUseId: 'tool-1', isError: false, content: { kind: 'text', text: 'file body' } },
      { type: 'token_usage', id: 'legacy-usage', turnId: 'turn-1', ts: 105, input: 10, output: 5 },
      { type: 'turn_state', id: 'legacy-state', turnId: 'turn-1', ts: 106, status: 'completed', partialOutputRetained: true },
    ];
    await store.appendMessages(session.id, legacyMessages);
    await runStore.createRun(makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'completed',
      completedAt: 106,
    }));

    const messages = await manager.getMessages(session.id);
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    expect(messages.map((message) => message.type)).toEqual([
      'user',
      'assistant',
      'tool_call',
      'tool_result',
      'token_usage',
      'turn_state',
    ]);
    expect(messages.map((message) => message.id)).toEqual([
      'legacy-user',
      'legacy-assistant',
      'tool-1',
      'legacy-tool-result',
      'legacy-usage',
      'legacy-state',
    ]);
    expect(runtimeEvents).toEqual([]);
  });
```

- [ ] **Step 2: Run the test to verify it fails before wiring**

Run:

```bash
npm --workspace @maka/runtime run test
```

Expected: FAIL with:

```text
RuntimeEvent ledger is missing for a terminal run
```

- [ ] **Step 3: Wire the fallback into RuntimeReadModel**

In `packages/runtime/src/runtime-read-model.ts`, add this import near the other local imports:

```ts
import { backfillRuntimeEventsFromStoredMessages } from './runtime-event-backfill.js';
```

Then replace the empty-ledger branch in `getSessionView()`:

```ts
      if (runEvents.length === 0) {
        throw new RuntimeReadModelError('RuntimeEvent ledger is missing for a terminal run', [
          readModelDiagnostic('incomplete_event', 'terminal run has no readable RuntimeEvent ledger', {
            runId: run.runId,
            turnId: run.turnId,
          }),
        ]);
      }
```

with:

```ts
      if (runEvents.length === 0) {
        const recovered = await this.backfillMissingRuntimeEvents(sessionId, run);
        if (recovered.length === 0 || !recovered.some(isTerminalRuntimeEvent)) {
          throw new RuntimeReadModelError('RuntimeEvent ledger is missing for a terminal run', [
            readModelDiagnostic('incomplete_event', 'terminal run has no readable RuntimeEvent ledger', {
              runId: run.runId,
              turnId: run.turnId,
            }),
          ]);
        }
        runEvents = recovered;
      }
```

Add this private method inside `RuntimeReadModel`, before `buildView()`:

```ts
  private async backfillMissingRuntimeEvents(sessionId: string, run: AgentRunHeader): Promise<RuntimeEvent[]> {
    if (!this.deps.projectionCache) return [];
    let messages: StoredMessage[];
    try {
      messages = await this.deps.projectionCache.readMessages(sessionId);
    } catch {
      return [];
    }
    return backfillRuntimeEventsFromStoredMessages({ run, messages }).events;
  }
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm --workspace @maka/runtime run test
```

Expected: PASS for the updated read-model recovery test.

- [ ] **Step 5: Commit the read-model fallback**

Run:

```bash
git add packages/runtime/src/runtime-read-model.ts packages/runtime/src/__tests__/session-manager.test.ts
git commit -m "fix: backfill empty runtime ledger in read model"
```

### Task 4: AgentRun Prior Context Fallback

**Files:**
- Modify: `packages/runtime/src/agent-run.ts`
- Modify: `packages/runtime/src/__tests__/session-manager.test.ts`
- Test: `packages/runtime/src/__tests__/session-manager.test.ts`

- [ ] **Step 1: Add a failing second-turn context test**

In `packages/runtime/src/__tests__/session-manager.test.ts`, add this test after `runtime event ledger write failure does not fail sendMessage`:

```ts
  test('sendMessage backfills an empty prior runtime ledger for model context', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backend: TestBackend | undefined;
    backends.register('fake', (ctx) => {
      backend = new TestBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(7_000),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'prior question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'prior answer', modelId: 'fake-model' },
      { type: 'turn_state', id: 'legacy-state', turnId: 'turn-1', ts: 103, status: 'completed', partialOutputRetained: true },
    ]);
    await runStore.createRun(makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'completed',
      createdAt: 100,
      updatedAt: 103,
      completedAt: 103,
    }));

    const sessionEvents = await collectSessionEvents(
      manager.sendMessage(session.id, { turnId: 'turn-2', text: 'follow up' }),
    );

    expect(sessionEvents.map((event) => event.type)).toEqual(['text_delta', 'complete']);
    expect(backend?.sendInputs[0]?.context.map((message) => message.type)).toEqual(['user', 'assistant', 'turn_state']);
    expect(backend?.sendInputs[0]?.context.map((message) => 'text' in message ? message.text : message.type)).toEqual([
      'prior question',
      'prior answer',
      'turn_state',
    ]);
    expect(backend?.sendInputs[0]?.runtimeContext?.map((event) => event.runId)).toEqual(['run-1', 'run-1', 'run-1']);
    expect(await runStore.readRuntimeEvents(session.id, 'run-1')).toEqual([]);
  });
```

- [ ] **Step 2: Run the test to verify it fails before wiring**

Run:

```bash
npm --workspace @maka/runtime run test
```

Expected: FAIL with:

```text
Cannot build model context: RuntimeEvent ledger is missing for prior run run-1
```

- [ ] **Step 3: Wire the fallback into AgentRun**

In `packages/runtime/src/agent-run.ts`, add this import near the other local imports:

```ts
import { backfillRuntimeEventsFromStoredMessages } from './runtime-event-backfill.js';
```

Then replace this section in `buildPriorRuntimeContext()`:

```ts
      const events = await this.input.runtimeEventStore.readRuntimeEvents(this.sessionId, run.runId);
      if (events.length === 0) {
        throw new Error(`Cannot build model context: RuntimeEvent ledger is missing for prior run ${run.runId}`);
      }
      if (!events.some(isTerminalRuntimeEvent)) {
        throw new Error(`Cannot build model context: RuntimeEvent ledger has no terminal fact for prior run ${run.runId}`);
      }
```

with:

```ts
      let events = await this.input.runtimeEventStore.readRuntimeEvents(this.sessionId, run.runId);
      if (events.length === 0) {
        const recovered = await this.backfillMissingPriorRuntimeEvents(run);
        if (recovered.length === 0 || !recovered.some(isTerminalRuntimeEvent)) {
          throw new Error(`Cannot build model context: RuntimeEvent ledger is missing for prior run ${run.runId}`);
        }
        events = recovered;
      }
      if (!events.some(isTerminalRuntimeEvent)) {
        throw new Error(`Cannot build model context: RuntimeEvent ledger has no terminal fact for prior run ${run.runId}`);
      }
```

Add this private method inside `AgentRun`, before `buildPriorRuntimeContext()`:

```ts
  private async backfillMissingPriorRuntimeEvents(run: AgentRunHeader): Promise<RuntimeEvent[]> {
    let messages: StoredMessage[];
    try {
      messages = await this.input.store.readMessages(this.sessionId);
    } catch {
      return [];
    }
    return backfillRuntimeEventsFromStoredMessages({ run, messages }).events;
  }
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm --workspace @maka/runtime run test
```

Expected: PASS for the new second-turn context test.

- [ ] **Step 5: Commit the AgentRun fallback**

Run:

```bash
git add packages/runtime/src/agent-run.ts packages/runtime/src/__tests__/session-manager.test.ts
git commit -m "fix: backfill empty runtime ledger for prior context"
```

### Task 5: Final Verification

**Files:**
- Verify: `packages/runtime/src/runtime-event-backfill.ts`
- Verify: `packages/runtime/src/runtime-read-model.ts`
- Verify: `packages/runtime/src/agent-run.ts`
- Verify: `packages/runtime/src/__tests__/runtime-event-backfill.test.ts`
- Verify: `packages/runtime/src/__tests__/session-manager.test.ts`

- [ ] **Step 1: Run runtime typecheck**

Run:

```bash
npm --workspace @maka/runtime run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run runtime tests**

Run:

```bash
npm --workspace @maka/runtime run test
```

Expected: PASS.

- [ ] **Step 3: Run repository typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS across workspaces that define `typecheck`.

- [ ] **Step 4: Inspect the final diff**

Run:

```bash
git diff --stat
git diff -- packages/runtime/src/runtime-event-backfill.ts packages/runtime/src/runtime-read-model.ts packages/runtime/src/agent-run.ts packages/runtime/src/__tests__/runtime-event-backfill.test.ts packages/runtime/src/__tests__/session-manager.test.ts
```

Expected: the diff touches only runtime Agent code and runtime tests.

- [ ] **Step 5: Commit final verification adjustments if needed**

Run this only if final verification required small fixes after Task 4:

```bash
git add packages/runtime/src/runtime-event-backfill.ts packages/runtime/src/runtime-read-model.ts packages/runtime/src/agent-run.ts packages/runtime/src/__tests__/runtime-event-backfill.test.ts packages/runtime/src/__tests__/session-manager.test.ts
git commit -m "test: verify runtime ledger backfill"
```

## Self-Review

- Spec coverage: The plan covers recovery markers, low-risk-only backfill, no UI changes, read-model recovery, and next-turn AgentRun context recovery.
- Placeholder scan: The plan contains no unfinished placeholder markers, no generic test instructions, and every code-changing step includes concrete code.
- Type consistency: The plan uses `RuntimeEvent`, `StoredMessage`, `AgentRunHeader`, `RuntimeReadModel`, `AgentRun`, and `RuntimeEventStore` names that exist in the current codebase.
- Scope check: The plan intentionally leaves non-empty corrupt ledgers for a later repair because fixing them safely likely requires ledger quarantine or a batch repair interface.
