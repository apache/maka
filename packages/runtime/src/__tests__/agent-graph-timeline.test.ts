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
import { AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION } from '@maka/core/agent-graph-supervisor-wake';
import { type AgentGraphTimelineMetadataSnapshot } from '@maka/core/agent-graph-timeline';
import { type AgentRunHeader } from '@maka/core/agent-run';
import { type RuntimeEvent } from '@maka/core/runtime-event';
import { createSqliteSessionMetadataStore } from '@maka/storage';
import {
  buildAgentGraphTimeline,
  buildAgentGraphTimelineCurrentState,
  paginateAgentGraphTimeline,
  readAgentGraphTimelinePage,
} from '../agent-graph-timeline.js';
import { readCommittedAgentGraphProjection } from '../stream-graph-projection.js';

describe('agent graph replay timeline', () => {
  test('reconstructs control, child records, parent completion, and supervisor wake chronologically', async () => {
    const fixture = await timelineFixture();
    const events = buildAgentGraphTimeline(fixture);
    const currentState = buildAgentGraphTimelineCurrentState(
      fixture.metadata,
      fixture.rootSessionId,
      fixture.graphId,
    );

    assert.deepEqual(
      events.map((event) => event.sequence),
      Array.from({ length: events.length }, (_unused, index) => index + 1),
    );
    assert.deepEqual(
      events
        .filter(
          (event): event is Extract<(typeof events)[number], { kind: 'record_committed' }> =>
            event.kind === 'record_committed' && event.eventTime === 110,
        )
        .map((event) => event.sourceRuntimeEventId),
      ['child-tool-call', 'child-tool-result'],
      'same-millisecond runtime records retain committed ledger order',
    );
    const firstRootTerminal = requireEvent(
      events,
      'supervisor_turn_terminal',
      (event) => event.kind === 'supervisor_turn_terminal' && event.run.runId === 'root-run-1',
    );
    const childTerminal = requireEvent(events, 'activation_terminal');
    const wakeAttempt = requireEvent(events, 'supervisor_wake_attempted');
    const wakeRootStart = requireEvent(
      events,
      'supervisor_turn_started',
      (event) => event.kind === 'supervisor_turn_started' && event.run.runId === 'root-run-2',
    );
    const finish = requireEvent(events, 'schedule_finished');
    assert.ok(firstRootTerminal.eventTime < childTerminal.eventTime);
    assert.ok(childTerminal.eventTime < wakeAttempt.eventTime);
    assert.equal(wakeRootStart.eventTime, wakeAttempt.eventTime);
    assert.ok(wakeRootStart.eventTime < finish.eventTime);
    if (wakeRootStart.kind !== 'supervisor_turn_started') assert.fail('unexpected event');
    assert.deepEqual(wakeRootStart.wake, {
      wakeId: 'wake-1',
      attemptId: 'attempt-1',
    });

    assert.deepEqual(currentState.admissions, [
      {
        intentId: `graph_intent_${'f'.repeat(32)}`,
        state: 'executing',
        updatedAt: 103,
      },
    ]);
    assert.equal(childTerminal.kind, 'activation_terminal');
    assert.equal(childTerminal.status, 'completed');
    assert.deepEqual(currentState.supervisorWakes, [
      {
        wakeId: 'wake-1',
        status: 'delivered',
        attemptCount: 1,
        updatedAt: 130,
        currentAttemptId: 'attempt-1',
        currentTurnId: 'root-turn-2',
      },
    ]);

    const serialized = JSON.stringify({ events, currentState });
    assert.doesNotMatch(serialized, /SECRET_(INSTRUCTION|FINISH_REASON|CHILD_OUTPUT|TOOL_ARG)/);
    assert.match(serialized, /child-tool-result/);
  });

  test('paginates with a validated stable cursor and reports bounded omissions', async () => {
    const fixture = await timelineFixture();
    const events = buildAgentGraphTimeline(fixture);
    const currentState = buildAgentGraphTimelineCurrentState(
      fixture.metadata,
      fixture.rootSessionId,
      fixture.graphId,
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    let pageNumber = 0;
    do {
      const page = paginateAgentGraphTimeline(events, 'root-session', 'graph-1', currentState, {
        ...(cursor ? { cursor } : {}),
        limit: 3,
      });
      seen.push(...page.events.map((event) => event.eventId));
      assert.equal(page.omittedBefore, pageNumber * 3);
      assert.equal(page.omittedAfter, Math.max(0, events.length - seen.length));
      assert.deepEqual(page.coverage.limitations, [
        'admission_transition_history_not_persisted',
        'supervisor_wake_transition_history_not_persisted',
        'reconcile_history_not_persisted',
      ]);
      cursor = page.nextCursor;
      pageNumber += 1;
    } while (cursor);
    assert.deepEqual(
      seen,
      events.map((event) => event.eventId),
    );

    const first = paginateAgentGraphTimeline(events, 'root-session', 'graph-1', currentState, {
      limit: 1,
    });
    await assert.rejects(
      async () =>
        paginateAgentGraphTimeline(events, 'root-session', 'another-graph', currentState, {
          cursor: first.nextCursor,
        }),
      /another graph/,
    );

    const cursorPage = paginateAgentGraphTimeline(events, 'root-session', 'graph-1', currentState, {
      limit: 2,
    });
    const withEarlierEvent = events.map((event) => ({
      ...event,
      sequence: event.sequence + 1,
    }));
    withEarlierEvent.unshift({
      ...events[0]!,
      eventId: 'graph_timeline_late_discovery',
      eventTime: Math.max(0, events[0]!.eventTime - 1),
      sequence: 1,
    });
    const resumed = paginateAgentGraphTimeline(
      withEarlierEvent,
      'root-session',
      'graph-1',
      currentState,
      {
        cursor: cursorPage.nextCursor,
        limit: 1,
      },
    );
    assert.equal(resumed.events[0]?.eventId, events[2]?.eventId);
    assert.equal(resumed.omittedBefore, 3);
  });

  test('keeps historical pagination cursors valid when mutable control snapshots change', async () => {
    const fixture = await timelineFixture();
    const claimedMetadata = structuredClone(fixture.metadata);
    claimedMetadata.intentAdmissions[0] = {
      ...claimedMetadata.intentAdmissions[0]!,
      state: 'claimed',
      updatedAt: 102,
    };
    const claimedEvents = buildAgentGraphTimeline({
      ...fixture,
      metadata: claimedMetadata,
    });
    const claimedState = buildAgentGraphTimelineCurrentState(
      claimedMetadata,
      fixture.rootSessionId,
      fixture.graphId,
    );
    const firstPage = paginateAgentGraphTimeline(
      claimedEvents,
      fixture.rootSessionId,
      fixture.graphId,
      claimedState,
      { limit: 4 },
    );

    const executingEvents = buildAgentGraphTimeline(fixture);
    const executingState = buildAgentGraphTimelineCurrentState(
      fixture.metadata,
      fixture.rootSessionId,
      fixture.graphId,
    );
    assert.deepEqual(
      executingEvents.map((event) => [event.eventId, event.eventTime]),
      claimedEvents.map((event) => [event.eventId, event.eventTime]),
    );
    const secondPage = paginateAgentGraphTimeline(
      executingEvents,
      fixture.rootSessionId,
      fixture.graphId,
      executingState,
      { cursor: firstPage.nextCursor, limit: 4 },
    );
    assert.equal(secondPage.currentState.admissions[0]?.state, 'executing');
    assert.equal(secondPage.omittedBefore, 4);
  });

  test('joins a transactionally read SQLite metadata snapshot with immutable run ledgers', async () => {
    const fixture = await timelineFixture();
    const runsBySession = new Map<string, AgentRunHeader[]>([
      ['root-session', [...fixture.rootRuns]],
      ['child-session', [fixture.childRun]],
    ]);
    const eventsByRun = new Map([['child-run', fixture.childEvents]]);
    let metadataReads = 0;
    const page = await readAgentGraphTimelinePage({
      rootSessionId: 'root-session',
      graphId: 'graph-1',
      controlStore: {
        async readAgentGraphTimelineMetadata() {
          metadataReads += 1;
          return fixture.metadata;
        },
      },
      runStore: {
        async listSessionRuns(sessionId) {
          return runsBySession.get(sessionId) ?? [];
        },
      },
      runtimeEventStore: {
        async readImmutableRuntimeEvents(_sessionId, runId) {
          return eventsByRun.get(runId) ?? [];
        },
      },
      options: { limit: 256 },
    });

    assert.equal(metadataReads, 1);
    assert.equal(page.omittedAfter, 0);
    assert.equal(page.totalEvents, page.events.length);
    assert.ok(page.events.some((event) => event.kind === 'schedule_finished'));
    assert.ok(page.events.some((event) => event.kind === 'record_committed'));
    assert.equal(page.currentState.admissions[0]?.state, 'executing');
  });

  test('emits activation_started from a durable claimed AgentRun before its first RuntimeEvent', async () => {
    const fixture = await timelineFixture();
    const page = await readAgentGraphTimelinePage({
      rootSessionId: fixture.rootSessionId,
      graphId: fixture.graphId,
      controlStore: {
        async readAgentGraphTimelineMetadata() {
          return fixture.metadata;
        },
      },
      runStore: {
        async listSessionRuns(sessionId) {
          if (sessionId === fixture.rootSessionId) return [...fixture.rootRuns];
          if (sessionId === fixture.childRun.sessionId) {
            return [{ ...fixture.childRun, status: 'running', completedAt: undefined }];
          }
          return [];
        },
      },
      runtimeEventStore: {
        async readImmutableRuntimeEvents() {
          return [];
        },
      },
      options: { limit: 256 },
    });

    const activation = requireEvent(page.events, 'activation_started');
    assert.equal(activation.kind, 'activation_started');
    assert.equal(activation.eventTime, fixture.childRun.createdAt);
    assert.deepEqual(activation.activation, {
      sessionId: 'child-session',
      runId: 'child-run',
      turnId: 'child-turn',
    });
    assert.equal(
      page.events.some((event) => event.kind === 'record_committed'),
      false,
    );
    assert.equal(
      page.events.some((event) => event.kind === 'activation_terminal'),
      false,
    );
  });

  test('projects a superseded durable supervisor wake attempt as settled', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    try {
      await store.claimAgentGraphSupervisorWake({
        schemaVersion: AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION,
        graphId: 'graph-1',
        wakeId: 'wake-superseded',
        snapshotVersion: 'snapshot-superseded',
        rootSessionId: 'root-session',
      });
      await store.beginAgentGraphSupervisorWakeAttempt({
        graphId: 'graph-1',
        wakeId: 'wake-superseded',
        attemptId: 'attempt-superseded',
        turnId: 'turn-superseded',
      });
      await store.supersedeAgentGraphSupervisorWakes({
        rootSessionIds: ['root-session'],
        reason: 'session_retired',
      });

      const fixture = await timelineFixture();
      const metadata = await store.readAgentGraphTimelineMetadata('graph-1');
      const events = buildAgentGraphTimeline({
        ...fixture,
        metadata: {
          ...fixture.metadata,
          supervisorWakes: metadata.supervisorWakes,
        },
      });
      const settled = requireEvent(events, 'supervisor_wake_settled');

      assert.equal(settled.kind, 'supervisor_wake_settled');
      assert.equal(settled.wakeId, 'wake-superseded');
      assert.equal(settled.attemptId, 'attempt-superseded');
      assert.equal(settled.status, 'superseded');
      assert.ok(
        requireEvent(events, 'supervisor_wake_attempted').sequence < settled.sequence,
        'the settled projection follows its durable attempt',
      );
    } finally {
      store.close();
    }
  });
});

async function timelineFixture() {
  const rootRun1 = runHeader({
    sessionId: 'root-session',
    runId: 'root-run-1',
    turnId: 'root-turn-1',
    status: 'completed',
    createdAt: 90,
    completedAt: 115,
  });
  const rootRun2 = runHeader({
    sessionId: 'root-session',
    runId: 'root-run-2',
    turnId: 'root-turn-2',
    status: 'completed',
    createdAt: 122,
    completedAt: 150,
    agentGraphWakeId: 'wake-1',
    agentGraphWakeAttemptId: 'attempt-1',
  });
  const childRun = runHeader({
    sessionId: 'child-session',
    runId: 'child-run',
    turnId: 'child-turn',
    status: 'completed',
    createdAt: 102,
    completedAt: 120,
  });
  const childEvents: RuntimeEvent[] = [
    runtimeEvent(childRun, {
      id: 'child-input',
      ts: 104,
      role: 'user',
      author: 'host',
      content: { kind: 'text', text: 'SECRET_INSTRUCTION' },
    }),
    runtimeEvent(childRun, {
      id: 'child-tool-call',
      ts: 110,
      role: 'model',
      author: 'agent',
      content: {
        kind: 'function_call',
        id: 'call-1',
        name: 'Read',
        args: { path: 'SECRET_TOOL_ARG' },
      },
    }),
    runtimeEvent(childRun, {
      id: 'child-tool-result',
      ts: 110,
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'call-1',
        name: 'Read',
        result: 'SECRET_CHILD_OUTPUT',
      },
    }),
    runtimeEvent(childRun, {
      id: 'child-final',
      ts: 119,
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'SECRET_CHILD_OUTPUT' },
    }),
    runtimeEvent(childRun, {
      id: 'child-terminal',
      ts: 120,
      status: 'completed',
      actions: { endInvocation: true },
    }),
  ];
  const projection = await readCommittedAgentGraphProjection({
    graphId: 'graph-1',
    operators: [{ operatorId: 'operator-1', sessionId: 'child-session' }],
    runStore: {
      async listSessionRuns() {
        return [childRun];
      },
    },
    runtimeEventStore: {
      async readImmutableRuntimeEvents() {
        return childEvents;
      },
    },
  });
  const metadata: AgentGraphTimelineMetadataSnapshot = {
    graphId: 'graph-1',
    scheduleUpdates: [
      {
        schemaVersion: 1,
        updateId: `graph_update_${'a'.repeat(32)}`,
        updateFingerprint: `sha256:${'a'.repeat(64)}`,
        graphId: 'graph-1',
        source: {
          sessionId: 'root-session',
          runId: 'root-run-1',
          turnId: 'root-turn-1',
          toolCallId: 'schedule-call-1',
        },
        addWork: [
          {
            workId: `graph_work_${'b'.repeat(32)}`,
            target: { kind: 'agent', agentId: 'local-read' },
            instruction: 'SECRET_INSTRUCTION',
            inputIds: [],
          },
        ],
        stop: [],
        revision: 1,
        committedAt: 100,
      },
      {
        schemaVersion: 1,
        updateId: `graph_update_${'c'.repeat(32)}`,
        updateFingerprint: `sha256:${'c'.repeat(64)}`,
        graphId: 'graph-1',
        source: {
          sessionId: 'root-session',
          runId: 'root-run-2',
          turnId: 'root-turn-2',
          toolCallId: 'schedule-call-2',
        },
        addWork: [],
        stop: [],
        finish: {
          resultIds: [projection.records.at(-2)!.recordId],
          reason: 'SECRET_FINISH_REASON',
        },
        revision: 2,
        committedAt: 145,
      },
    ],
    operatorProvisions: [
      {
        schemaVersion: 1,
        provisionId: `graph_provision_${'d'.repeat(32)}`,
        provisionFingerprint: `sha256:${'d'.repeat(64)}`,
        graphId: 'graph-1',
        workId: `graph_work_${'b'.repeat(32)}`,
        agentId: 'local-read',
        operatorId: 'operator-1',
        initialTurnId: 'child-turn',
        initialRunId: 'child-run',
        edges: [],
        targetSessionId: 'child-session',
        provisionedAt: 101,
      },
    ],
    intentClaims: [
      {
        schemaVersion: 1,
        claimId: `graph_claim_${'e'.repeat(32)}`,
        graphId: 'graph-1',
        intentId: `graph_intent_${'f'.repeat(32)}`,
        intentFingerprint: `sha256:${'e'.repeat(64)}`,
        readinessContextFingerprint: `sha256:${'f'.repeat(64)}`,
        targetOperatorId: 'operator-1',
        targetSessionId: 'child-session',
        targetTurnId: 'child-turn',
        targetRunId: 'child-run',
        claimedAt: 102,
      },
    ],
    intentAdmissions: [
      {
        graphId: 'graph-1',
        intentId: `graph_intent_${'f'.repeat(32)}`,
        state: 'executing',
        updatedAt: 103,
      },
    ],
    supervisorWakes: [
      {
        wake: {
          schemaVersion: 1,
          graphId: 'graph-1',
          wakeId: 'wake-1',
          snapshotVersion: 'snapshot-1',
          rootSessionId: 'root-session',
          status: 'delivered',
          attemptCount: 1,
          currentAttemptId: 'attempt-1',
          currentTurnId: 'root-turn-2',
          createdAt: 121,
          updatedAt: 130,
        },
        attempts: [
          {
            graphId: 'graph-1',
            wakeId: 'wake-1',
            attemptId: 'attempt-1',
            turnId: 'root-turn-2',
            status: 'delivered',
            startedAt: 122,
            completedAt: 130,
          },
        ],
      },
    ],
  };
  return {
    rootSessionId: 'root-session',
    graphId: 'graph-1',
    metadata,
    rootRuns: [rootRun1, rootRun2],
    childRuns: [childRun],
    projection,
    childRun,
    childEvents,
  };
}

function runHeader(
  input: Pick<
    AgentRunHeader,
    | 'sessionId'
    | 'runId'
    | 'turnId'
    | 'status'
    | 'createdAt'
    | 'completedAt'
    | 'agentGraphWakeId'
    | 'agentGraphWakeAttemptId'
  >,
): AgentRunHeader {
  return {
    ...input,
    invocationId: `invocation-${input.runId}`,
    backendKind: 'ai-sdk',
    llmConnectionSlug: 'deepseek',
    modelId: 'deepseek-chat',
    cwd: '/workspace',
    permissionMode: 'explore',
    updatedAt: input.completedAt ?? input.createdAt,
  };
}

function runtimeEvent(
  run: AgentRunHeader,
  overrides: Partial<RuntimeEvent> & Pick<RuntimeEvent, 'id' | 'ts'>,
): RuntimeEvent {
  return {
    invocationId: run.invocationId!,
    runId: run.runId,
    sessionId: run.sessionId,
    turnId: run.turnId,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}

function requireEvent<K extends string>(
  events: ReturnType<typeof buildAgentGraphTimeline>,
  kind: K,
  predicate: (event: ReturnType<typeof buildAgentGraphTimeline>[number]) => boolean = () => true,
) {
  const event = events.find((candidate) => candidate.kind === kind && predicate(candidate));
  assert.ok(event, `missing ${kind}`);
  return event;
}
