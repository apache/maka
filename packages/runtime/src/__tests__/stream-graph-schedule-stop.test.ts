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
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import type { AgentBackend, BackendSendInput } from '@maka/core/backend-types';
import type { SessionEvent } from '@maka/core/events';
import { isTerminalRuntimeEvent } from '@maka/core/runtime-event';
import {
  deferred,
  waitFor,
  withTimeout,
  type Deferred,
} from '@maka/core/test-only/async-primitives';
import { createSqliteAgentRunStore } from '@maka/storage/agent-run-store';
import { OPERATIONAL_STATE_DATABASE_NAME } from '@maka/storage/operational-state-store';
import { createWorkspaceRuntimeStore } from '@maka/storage/runtime-event-persistence';
import { createSessionStore } from '@maka/storage/session-store';
import { createSqliteSessionMetadataStore } from '@maka/storage/sqlite-session-metadata-store';
import { BackendRegistry, SessionManager } from '../session-manager.js';
import { AgentGraphCoordinator, agentGraphIdForRootSession } from '../stream-graph-coordinator.js';
import type { UpdateAgentGraphToolInput } from '../stream-graph-supervisor-tools.js';
import type { MakaToolContext } from '../tool-runtime.js';

// This backend cannot finish a child naturally until the test opens its gate.
// The real SessionManager still owns admission, cancellation and terminal facts.
interface GatedSend {
  turnId: string;
  naturalCompletion: Deferred;
  stopped: Deferred;
  wasStopped: boolean;
}

class GatedGraphBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly started = deferred();
  readonly sends: GatedSend[] = [];
  // A non-cooperative provider: stop is delivered, but neither stop nor the
  // send returns before the provider finishes on its own.
  ignoreStop = false;
  stopCalls = 0;
  private active: GatedSend | undefined;

  constructor(
    readonly sessionId: string,
    private readonly child: boolean,
  ) {}

  get naturalCompletion() {
    const current = this.active ?? this.sends.at(-1);
    assert.ok(current, 'the backend must have started before opening its completion gate');
    return current.naturalCompletion;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const call: GatedSend = {
      turnId: input.turnId,
      naturalCompletion: deferred(),
      stopped: deferred(),
      wasStopped: false,
    };
    this.sends.push(call);
    this.active = call;
    const event = { turnId: input.turnId, ts: Date.now() };
    try {
      if (this.child) {
        this.started.resolve();
        yield {
          ...event,
          id: randomUUID(),
          type: 'text_delta',
          messageId: input.turnId,
          text: 'Working on the requested task.',
        };
        await Promise.race([call.naturalCompletion.promise, call.stopped.promise]);
      }
      yield {
        ...event,
        id: randomUUID(),
        type: 'text_complete',
        messageId: input.turnId,
        text: call.wasStopped ? 'Stopped.' : 'Completed requested work.',
      };
      yield {
        ...event,
        id: randomUUID(),
        type: 'complete',
        stopReason: call.wasStopped ? 'user_stop' : 'end_turn',
      };
    } finally {
      if (this.active === call) this.active = undefined;
    }
  }
  async stop(): Promise<void> {
    this.stopCalls += 1;
    if (!this.active) return;
    if (this.ignoreStop) {
      await this.active.naturalCompletion.promise;
      return;
    }
    this.active.wasStopped = true;
    this.active.stopped.resolve();
  }
  async dispose(): Promise<void> {
    await this.stop();
  }
  async respondToSandboxBoundary(): Promise<void> {}
}

async function graphFixture() {
  const root = await mkdtemp(join(tmpdir(), 'maka-graph-schedule-stop-'));
  const sessionStore = createSessionStore(root);
  const runStore = createSqliteAgentRunStore(root);
  const runtimeEventStore = createWorkspaceRuntimeStore(root);
  const controlStore = createSqliteSessionMetadataStore(
    join(root, OPERATIONAL_STATE_DATABASE_NAME),
  );
  const children = new Map<string, GatedGraphBackend>();
  const backends = new BackendRegistry();
  backends.register('ai-sdk', (context) => {
    const backend = new GatedGraphBackend(
      context.sessionId,
      Boolean(context.header.subagentParent),
    );
    if (context.header.subagentParent) children.set(context.sessionId, backend);
    return backend;
  });
  const manager = new SessionManager({
    store: sessionStore,
    runStore,
    runtimeEventStore,
    backends,
    childTools: ['Read', 'Glob', 'Grep'].map((name) => ({
      name,
      description: 'In-memory fixture',
      parameters: z.object({}),
      categoryHint: 'read',
      impl: async () => ({ ok: true }),
    })),
    newId: randomUUID,
    now: Date.now,
  });
  const session = await manager.createSession({
    cwd: root,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
    name: 'Graph supervisor',
  });
  const turnId = randomUUID();
  for await (const _event of manager.sendMessage(session.id, {
    turnId,
    text: 'Prepare graph work.',
  })) {
  }
  const [run] = await runtimeEventStore.listSessionInvocations(session.id);
  assert.ok(run);
  const coordinators: AgentGraphCoordinator[] = [];
  const createCoordinator = () => {
    const coordinator = new AgentGraphCoordinator({
      sessionStore,
      runtimeEventStore,
      controlStore,
      runtime: manager,
      newId: randomUUID,
      maxNewActivations: 4,
    });
    coordinators.push(coordinator);
    return coordinator;
  };
  const coordinator = createCoordinator();
  const update = (await coordinator.toolsForSession(session.id)).find(
    (tool) => tool.name === 'update_agent_graph',
  )!;
  const context = (): MakaToolContext => ({
    sessionId: session.id,
    runId: run.runId,
    turnId,
    toolCallId: randomUUID(),
    cwd: root,
    abortSignal: new AbortController().signal,
    emitOutput() {},
  });
  return {
    manager,
    coordinator,
    createCoordinator,
    children,
    session,
    runtimeEventStore,
    controlStore,
    update: (input: UpdateAgentGraphToolInput) => update.impl(input, context()),
    async start(count: number) {
      const previous = new Set(children.keys());
      await update.impl(
        {
          operation: 'add_work',
          add_work: Array.from({ length: count }, (_, i) => ({
            target_kind: 'new_agent',
            agent_id: 'local-read',
            instruction: `Inspect local input ${i}.`,
            input_ids: [],
            replacement_mode: 'none',
          })),
        },
        context(),
      );
      await waitFor(() => children.size === previous.size + count, { timeoutMs: 5000 });
      const added = [...children.values()].filter((child) => !previous.has(child.sessionId));
      await Promise.all(added.map((child) => child.started.promise));
      const provisions = await controlStore.listAgentGraphOperatorProvisions(
        agentGraphIdForRootSession(session.id),
      );
      return added.map((child) => ({
        child,
        workId: provisions.find((p) => p.targetSessionId === child.sessionId)!.workId,
      }));
    },
    async close() {
      for (const child of children.values()) {
        for (const send of child.sends) send.naturalCompletion.resolve();
      }
      await Promise.all(coordinators.map((owned) => owned.close()));
      controlStore.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('a durable graph stop cancels the running child before natural completion', async () => {
  const fixture = await graphFixture();
  try {
    const [{ child, workId }] = await fixture.start(1);
    await fixture.update({
      operation: 'stop',
      stop: [{ target_id: workId, reason: 'This work is no longer needed.' }],
    });
    await withTimeout(
      fixture.coordinator.waitForIdle(fixture.session.id),
      1000,
      'graph stop must settle the child while its natural completion gate remains closed',
    );
    assert.equal((await fixture.manager.listTurns(child.sessionId))[0]?.status, 'aborted');
    assert.equal(
      (await fixture.manager.listSessions()).find((s) => s.id === child.sessionId)?.status,
      'aborted',
    );
    assert.deepEqual(fixture.manager.runningTurnIds(child.sessionId), []);
    await assertDurableTerminal(fixture, child, 'aborted');
  } finally {
    await fixture.close();
  }
});

type GraphFixture = Awaited<ReturnType<typeof graphFixture>>;

async function assertDurableTerminal(
  fixture: GraphFixture,
  child: GatedGraphBackend,
  expected: 'aborted' | 'completed' | 'either',
  coordinator = fixture.coordinator,
) {
  const runs = await fixture.runtimeEventStore.listSessionInvocations(child.sessionId);
  assert.equal(runs.length, 1, 'one child work must create exactly one durable activation');
  const run = runs[0]!;
  const events = await fixture.runtimeEventStore.readImmutableRuntimeEvents(
    child.sessionId,
    run.runId,
  );
  const terminal = events.filter(isTerminalRuntimeEvent);
  assert.equal(terminal.length, 1, 'the activation must have exactly one durable terminal fact');
  if (expected === 'either') {
    assert.ok(terminal[0]!.status === 'completed' || terminal[0]!.status === 'aborted');
  } else {
    assert.equal(terminal[0]!.status, expected);
  }
  assert.equal(run.terminalEvent?.id, terminal[0]!.id);
  const claims = await fixture.controlStore.listAgentGraphIntentClaims(
    agentGraphIdForRootSession(fixture.session.id),
  );
  const childClaims = claims.filter((claim) => claim.targetSessionId === child.sessionId);
  assert.equal(childClaims.length, 1);
  assert.equal(childClaims[0]!.targetRunId, run.runId);
  const observation = await coordinator.observe(fixture.session.id);
  const terminalRecords = observation.projection.records.filter(
    (record) => record.source.runtimeEventId === terminal[0]!.id,
  );
  assert.equal(
    terminalRecords.length,
    1,
    'the durable terminal must project to one graph result record',
  );
  assert.equal(terminalRecords[0]!.activationId, run.runId);
  assert.equal(child.sends.length, 1, 'reconciliation must not execute the same work again');
  return { runId: run.runId, terminalId: terminal[0]!.id, recordId: terminalRecords[0]!.recordId };
}

test('stopping one graph child leaves its sibling running until natural completion', async () => {
  const fixture = await graphFixture();
  try {
    const [target, sibling] = await fixture.start(2);
    await fixture.update({
      operation: 'stop',
      stop: [{ target_id: target!.workId, reason: 'Only this branch is obsolete.' }],
    });
    await waitFor(
      async () => {
        const runs = await fixture.runtimeEventStore.listSessionInvocations(
          target!.child.sessionId,
        );
        return runs[0]?.terminalEvent?.status === 'aborted';
      },
      { timeoutMs: 1000, message: 'selected child must stop while its sibling remains gated' },
    );
    await assertDurableTerminal(fixture, target!.child, 'aborted');
    const siblingRuns = await fixture.runtimeEventStore.listSessionInvocations(
      sibling!.child.sessionId,
    );
    assert.equal(siblingRuns.length, 1);
    assert.equal(siblingRuns[0]!.terminalEvent, undefined);
    assert.deepEqual(fixture.manager.runningTurnIds(sibling!.child.sessionId), [
      siblingRuns[0]!.turnId,
    ]);
    sibling!.child.naturalCompletion.resolve();
    await withTimeout(
      fixture.coordinator.waitForIdle(fixture.session.id),
      3000,
      'sibling should finish',
    );
    await assertDurableTerminal(fixture, sibling!.child, 'completed');
  } finally {
    await fixture.close();
  }
});

test('new graph work completes after an earlier work was stopped', async () => {
  const fixture = await graphFixture();
  try {
    const [first] = await fixture.start(1);
    await fixture.update({
      operation: 'stop',
      stop: [{ target_id: first!.workId, reason: 'Replace the abandoned branch.' }],
    });
    await withTimeout(
      fixture.coordinator.waitForIdle(fixture.session.id),
      1000,
      'first work should stop',
    );
    const firstFacts = await assertDurableTerminal(fixture, first!.child, 'aborted');
    const [next] = await fixture.start(1);
    assert.notEqual(next!.child.sessionId, first!.child.sessionId);
    assert.equal(fixture.manager.runningTurnIds(next!.child.sessionId).length, 1);
    next!.child.naturalCompletion.resolve();
    await withTimeout(
      fixture.coordinator.waitForIdle(fixture.session.id),
      3000,
      'new work should finish',
    );
    await assertDurableTerminal(fixture, next!.child, 'completed');
    assert.deepEqual(await assertDurableTerminal(fixture, first!.child, 'aborted'), firstFacts);
  } finally {
    await fixture.close();
  }
});

test('concurrent graph stop and natural completion preserve one durable activation and result', async () => {
  const fixture = await graphFixture();
  try {
    const [{ child, workId }] = await fixture.start(1);
    const stop = fixture.update({
      operation: 'stop',
      stop: [{ target_id: workId, reason: 'Stop races with the final child output.' }],
    });
    child.naturalCompletion.resolve();
    await stop;
    await withTimeout(
      fixture.coordinator.waitForIdle(fixture.session.id),
      3000,
      'racing operations should settle',
    );
    const facts = await assertDurableTerminal(fixture, child, 'either');
    await fixture.coordinator.reconcile(fixture.session.id);
    assert.deepEqual(await assertDurableTerminal(fixture, child, 'either'), facts);
    assert.deepEqual(fixture.manager.runningTurnIds(child.sessionId), []);
  } finally {
    await fixture.close();
  }
});

test('a fresh graph coordinator recovers stopped and completed work without replaying children', async () => {
  const fixture = await graphFixture();
  try {
    const [stopped, completed] = await fixture.start(2);
    await fixture.update({
      operation: 'stop',
      stop: [{ target_id: stopped!.workId, reason: 'Persist this cancellation before recovery.' }],
    });
    await waitFor(
      async () => {
        const runs = await fixture.runtimeEventStore.listSessionInvocations(
          stopped!.child.sessionId,
        );
        return runs[0]?.terminalEvent?.status === 'aborted';
      },
      { timeoutMs: 1000, message: 'stop must settle before the sibling is allowed to complete' },
    );
    completed!.child.naturalCompletion.resolve();
    await withTimeout(
      fixture.coordinator.waitForIdle(fixture.session.id),
      3000,
      'work should settle before recovery',
    );
    const stoppedFacts = await assertDurableTerminal(fixture, stopped!.child, 'aborted');
    const completedFacts = await assertDurableTerminal(fixture, completed!.child, 'completed');
    await fixture.coordinator.close();
    const recovered = fixture.createCoordinator();
    assert.deepEqual(await recovered.recover(), [fixture.session.id]);
    assert.deepEqual(
      await assertDurableTerminal(fixture, stopped!.child, 'aborted', recovered),
      stoppedFacts,
    );
    assert.deepEqual(
      await assertDurableTerminal(fixture, completed!.child, 'completed', recovered),
      completedFacts,
    );
    assert.equal(fixture.children.size, 2);
  } finally {
    await fixture.close();
  }
});

test('a stop that one backend ignores does not hold back its sibling stop in the same pass', async () => {
  const fixture = await graphFixture();
  try {
    const [ignored, cooperative] = await fixture.start(2);
    ignored!.child.ignoreStop = true;
    await fixture.update({
      operation: 'stop',
      stop: [
        { target_id: ignored!.workId, reason: 'This provider ignores the stop.' },
        { target_id: cooperative!.workId, reason: 'This provider honors the stop.' },
      ],
    });
    await waitFor(
      async () => {
        const runs = await fixture.runtimeEventStore.listSessionInvocations(
          cooperative!.child.sessionId,
        );
        return runs[0]?.terminalEvent?.status === 'aborted';
      },
      {
        timeoutMs: 1000,
        message: 'the cooperative stop must settle while its sibling still ignores its own',
      },
    );
    assert.ok(ignored!.child.stopCalls >= 1, 'both stops are delivered in the same pass');
    const ignoredRuns = await fixture.runtimeEventStore.listSessionInvocations(
      ignored!.child.sessionId,
    );
    assert.equal(ignoredRuns[0]!.terminalEvent, undefined);
    await assertDurableTerminal(fixture, cooperative!.child, 'aborted');

    ignored!.child.naturalCompletion.resolve();
    await withTimeout(
      fixture.coordinator.waitForIdle(fixture.session.id),
      3000,
      'the ignored stop settles once its provider finishes',
    );
    await assertDurableTerminal(fixture, ignored!.child, 'either');
    await assertDurableTerminal(fixture, cooperative!.child, 'aborted');
  } finally {
    await fixture.close();
  }
});
