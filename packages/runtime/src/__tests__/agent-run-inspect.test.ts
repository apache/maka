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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AgentRunEvent, AgentRunStore } from '@maka/core/agent-run';
import type { RuntimeEvent, RuntimeEventInvocationOpenedContent } from '@maka/core/runtime-event';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
import {
  buildInvocationOpenedEvent,
  runtimeInvocationsFromSessionEvents,
} from '@maka/core/runtime-invocation';
import { inspectAgentRunReadModel } from '../agent-run-inspect.js';
import { testInvocationOpening } from './invocation-fixture.js';
import { assertDoubleRunNotSealed } from './runtime-event-store-seal.js';

const sessionId = 'session-1';
const invocationId = 'inv-1';
const runId = 'run-1';
const turnId = 'turn-1';
const ts = 1_800_000_000_000;

describe('inspectAgentRunReadModel', () => {
  test('returns consistent diagnostics for a complete run', async () => {
    const runStore = new MemoryAgentRunStore();
    await runStore.appendRuntimeEvent(
      sessionId,
      runId,
      buildInvocationOpenedEvent({
        id: 'rt-open',
        run: { sessionId, invocationId, runId, turnId },
        openedAt: ts,
        opening: makeOpening(),
      }),
    );
    await runStore.appendEvent(
      sessionId,
      runId,
      makeRunEvent({ type: 'turn_started', ts: ts + 1 }),
    );
    await runStore.appendEvent(
      sessionId,
      runId,
      makeRunEvent({ type: 'model_stream_completed', ts: ts + 10 }),
    );
    await runStore.appendRuntimeEvent(
      sessionId,
      runId,
      makeRuntimeEvent({
        id: 'rt-user',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'hello' },
        ts: ts + 2,
      }),
    );
    await runStore.appendRuntimeEvent(
      sessionId,
      runId,
      makeRuntimeEvent({
        id: 'rt-assistant',
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'hi' },
        ts: ts + 3,
      }),
    );
    await runStore.appendRuntimeEvent(
      sessionId,
      runId,
      makeRuntimeEvent({
        id: 'rt-complete',
        role: 'system',
        author: 'system',
        status: 'completed',
        actions: { endInvocation: true },
        ts: ts + 10,
      }),
    );

    const inspected = await inspectAgentRunReadModel(runStore, runStore, { sessionId, runId });

    assert.deepStrictEqual(inspected.sourceHealth, {
      runtimeLedger: 'present',
      runtimeTerminalPresent: true,
    });
    assert.strictEqual(inspected.terminalRuntimeFact?.runStatus, 'completed');
    assert.deepStrictEqual(
      inspected.runtimeEvents.map((event) => event.id),
      ['rt-open', 'rt-user', 'rt-assistant', 'rt-complete'],
    );
    assert.deepStrictEqual(
      inspected.projection?.messages.map((message) => message.type),
      ['user', 'assistant', 'turn_state'],
    );
  });

  test('reports missing and corrupt runtime-events without discarding operational facts', async () => {
    const missingRuntimeStore = new MemoryAgentRunStore();
    await missingRuntimeStore.appendEvent(
      sessionId,
      runId,
      makeRunEvent({ type: 'model_stream_completed' }),
    );

    const missing = await inspectAgentRunReadModel(missingRuntimeStore, missingRuntimeStore, {
      sessionId,
      runId,
      invocation: makeInvocation(),
    });

    assert.deepStrictEqual(
      missing.events.map((event) => event.type),
      ['model_stream_completed'],
    );
    assert.strictEqual(missing.sourceHealth.runtimeLedger, 'missing');
    assert.strictEqual(missing.sourceHealth.runtimeTerminalPresent, false);
    assert.strictEqual(
      missing.diagnostics.some((diagnostic) => diagnostic.code === 'missing_runtime_ledger'),
      true,
    );

    const corruptRuntimeStore = new MemoryAgentRunStore({ failRuntimeEventReads: true });
    await corruptRuntimeStore.appendEvent(
      sessionId,
      runId,
      makeRunEvent({ type: 'model_stream_completed' }),
    );

    const corrupt = await inspectAgentRunReadModel(corruptRuntimeStore, corruptRuntimeStore, {
      sessionId,
      runId,
      invocation: makeInvocation(),
    });

    assert.deepStrictEqual(
      corrupt.events.map((event) => event.type),
      ['model_stream_completed'],
    );
    assert.strictEqual(corrupt.sourceHealth.runtimeLedger, 'read_failed');
    assert.strictEqual(
      corrupt.diagnostics.some((diagnostic) => diagnostic.code === 'runtime_ledger_read_failed'),
      true,
    );
  });
});

class MemoryAgentRunStore implements AgentRunStore, RuntimeEventStore {
  private events = new Map<string, AgentRunEvent[]>();
  private runtimeEvents = new Map<string, RuntimeEvent[]>();
  private runtimeEventEntries: RuntimeEvent[] = [];

  constructor(private readonly options: { failRuntimeEventReads?: boolean } = {}) {}

  async listSessionInvocations(sessionId: string): Promise<RuntimeInvocationRecord[]> {
    return runtimeInvocationsFromSessionEvents(
      sessionId,
      await this.readSessionRuntimeEvents(sessionId),
    );
  }

  async appendEvent(sessionId: string, runId: string, event: AgentRunEvent): Promise<void> {
    const eventKey = key(sessionId, runId);
    this.events.set(eventKey, [...(this.events.get(eventKey) ?? []), { ...event }]);
  }

  async readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    return (this.events.get(key(sessionId, runId)) ?? []).map((event) => ({ ...event }));
  }

  async appendRuntimeEvent(sessionId: string, runId: string, event: RuntimeEvent): Promise<void> {
    const eventKey = key(sessionId, runId);
    assertDoubleRunNotSealed(this.runtimeEvents.get(eventKey) ?? [], event);
    this.runtimeEvents.set(eventKey, [
      ...(this.runtimeEvents.get(eventKey) ?? []),
      copyRuntimeEvent(event),
    ]);
    if (event.partial !== true && !this.runtimeEventEntries.some(({ id }) => id === event.id)) {
      this.runtimeEventEntries.push(copyRuntimeEvent(event));
    }
  }

  async ensureTerminalRuntimeEventDurable(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
  ): Promise<void> {
    const existing = (this.runtimeEvents.get(key(sessionId, runId)) ?? []).find(
      (candidate) => candidate.id === event.id,
    );
    if (!existing) {
      await this.appendRuntimeEvent(sessionId, runId, event);
      return;
    }
    if (JSON.stringify(existing) !== JSON.stringify(event)) {
      throw new Error(`RuntimeEvent ${event.id} does not match the durable ledger record`);
    }
  }

  async readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    if (this.options.failRuntimeEventReads) throw new Error('runtime ledger is corrupt');
    return (this.runtimeEvents.get(key(sessionId, runId)) ?? []).map(copyRuntimeEvent);
  }

  async readSessionRuntimeEventEntries(sessionId: string) {
    return this.runtimeEventEntries
      .filter((event) => event.sessionId === sessionId)
      .map((event, index) => ({ ordinal: index + 1, event: copyRuntimeEvent(event) }));
  }

  async readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]> {
    const ordered: Array<{ event: RuntimeEvent; runId: string; eventIndex: number }> = [];
    for (const [eventKey, events] of this.runtimeEvents.entries()) {
      const [eventSessionId, runId] = eventKey.split(':');
      if (eventSessionId !== sessionId || !runId) continue;
      events.forEach((event, eventIndex) =>
        ordered.push({ event: copyRuntimeEvent(event), runId, eventIndex }),
      );
    }
    ordered.sort(
      (a, b) =>
        a.event.ts - b.event.ts ||
        a.runId.localeCompare(b.runId) ||
        a.eventIndex - b.eventIndex ||
        a.event.id.localeCompare(b.event.id),
    );
    return ordered.map((item) => item.event);
  }
}

function makeOpening(): RuntimeEventInvocationOpenedContent {
  return testInvocationOpening({
    configuration: { cwd: '/tmp/cwd' },
  });
}

/** The invocation a run is named by, for the cases whose ledger is unreadable. */
function makeInvocation(): RuntimeInvocationRecord {
  return { sessionId, invocationId, runId, turnId, openedAt: ts, opening: makeOpening() };
}

function makeRunEvent(overrides: Partial<AgentRunEvent> = {}): AgentRunEvent {
  return {
    type: 'turn_started',
    id: `op-${overrides.type ?? 'turn_started'}`,
    runId,
    sessionId,
    turnId,
    ts,
    ...overrides,
  };
}

function makeRuntimeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id: 'rt-1',
    invocationId: 'inv-1',
    runId,
    sessionId,
    turnId,
    ts,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}

function copyRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  return JSON.parse(JSON.stringify(event)) as RuntimeEvent;
}

function key(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`;
}
