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

import { assertMaximalJsonPages } from './fixtures/json-pages.js';
import { HostPlanCoordinator } from '../server/plan-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import {
  decodePlanQueryResult,
  PLAN_PAGE_MAX_ITEMS,
  PLAN_RESULT_MAX_BYTES,
  type PlanQueryInput,
  type PlanQueryResult,
} from '../protocol/index.js';

import { waitFor, withTimeout } from '@maka/core/test-only/async-primitives';
import { defineInteractiveRuntimeHostComposition } from '../server/host-composition.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractivePlanStoreForWrite } from '@maka/storage/plan-authority';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  connectRuntimeHost,
  type RuntimeHostConnection,
  type RuntimeHostSessionSubscription,
} from '../client/index.js';
import {
  RUNTIME_HOST_PROTOCOL_VERSION,
  type OperationOutput,
  type SubscriptionFrame,
} from '../protocol/index.js';
import { FakeBackend } from '@maka/runtime/test-only/fake-backend';
import type { BackendSendInput } from '@maka/core/backend-types';
import type { SessionEvent } from '@maka/core/events';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import { RuntimeHostKernel, type RuntimeHostCompositionFactory } from '../server/host-kernel.js';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

test('two Clients and a restarted production Host share one retry-safe Plan authority', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-plan-uds-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  let owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  let host: Awaited<ReturnType<typeof RuntimeHostKernel.start>> | undefined;
  let desktop: RuntimeHostConnection | undefined;
  let tui: RuntimeHostConnection | undefined;
  const turns = new PlanTurnControl();
  try {
    const setupStores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const setupPlanStore = await openInteractivePlanStoreForWrite(owner.lease);
    const session = await setupStores.sessionStore.create({
      cwd: root,
      llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'explore',
      collaborationMode: 'plan',
    });
    const submitted = await setupPlanStore.submitProposal({
      operationId: 'submit-operation',
      sessionId: session.id,
      turnId: 'turn-1',
      title: 'Shared Plan',
      steps: [
        {
          id: 'step-1',
          title: 'Commit once',
          description: 'Approve one durable Plan execution',
        },
      ],
    });
    assert.equal(submitted.event.type, 'plan_submitted');
    if (submitted.event.type !== 'plan_submitted') return;
    setupPlanStore.close();

    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 30_000,
      composition: defineInteractiveRuntimeHostComposition(controllableBackendComposition(turns)),
    });
    owner = undefined;
    [desktop, tui] = await Promise.all([connect(root), connect(root)]);
    const subscription = await desktop.openSessionSubscription({
      sessionId: session.id,
      transcript: { kind: 'none' },
    });
    await subscription.ready();

    const first = await desktop.request('plan.query', {
      kind: 'list_start',
      sessionId: session.id,
    });
    assert.equal(first.kind, 'page');
    if (first.kind !== 'page') return;
    const approval = {
      kind: 'approve_proposal' as const,
      sessionId: session.id,
      proposalId: submitted.event.proposal.proposalId,
      expectedRevision: submitted.event.proposal.revision,
      expectedStoreVersion: first.storeVersion,
      turnId: 'approve-turn',
    };
    // The deterministic backend parks inside `send`, so "the execution is
    // running" is a barrier the test holds, not a window it hopes to hit before
    // the Turn settles.
    turns.hold();
    const starting = tui.request('plan.turn.start', approval);
    await turns.dispatched(1);
    // The Host renders the request the model reads, so let the fake observe what
    // actually crossed that boundary: the execution and every step identity it
    // must report through update_plan, with nothing left to infer.
    const request = turns.texts[0] ?? '';
    assert.match(request, /^Execute the approved plan execution \S+\.$/m);
    assert.match(request, /^Steps:$/m);
    assert.match(request, /^- step-1 \[pending\] Commit once$/m);
    assert.match(request, /^Use update_plan to keep every step status current\.$/m);
    assert.doesNotMatch(request, /revision/);

    const changed = await withTimeout(
      nextFrameOfKind(subscription, 'subscription.session_domain_changed'),
      2_000,
      'Plan invalidation did not reach the other Client',
    );
    assert.equal(changed.sessionId, session.id);
    assert.equal(changed.domain, 'plan');

    const running = await tui.request('plan.query', { kind: 'list_start', sessionId: session.id });
    assert.equal(running.kind, 'page');
    if (running.kind === 'page') {
      assert.equal(
        running.activeExecutionId,
        (await starting).plan.executionId,
        'the approved execution is active while its Turn is still running',
      );
      assert.equal(running.items.filter((item) => item.kind === 'execution').length, 1);
    }
    turns.release();
    const started = await starting;
    const approved = started.plan;
    assert.equal(approved.eventType, 'plan_approved');
    assert.ok(approved.executionId);
    assert.equal(started.turn.turnId, approval.turnId);
    await waitForTerminal(tui, started.turn);
    // A root Turn that ends without every step reaching a terminal state settles
    // the execution instead of leaving it active until the next Host start.
    const settled = await waitForExecutionStatus(tui, session.id, null);
    assert.equal(executionStatusOf(settled), 'interrupted');

    await subscription.close();
    await Promise.all([desktop.close(), tui.close()]);
    desktop = undefined;
    tui = undefined;
    await host.close();
    host = undefined;

    owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 30_000,
      composition: defineInteractiveRuntimeHostComposition(controllableBackendComposition(turns)),
    });
    owner = undefined;
    tui = await connect(root);

    const replayed = await tui.request('plan.turn.start', approval);
    assert.equal(replayed.plan.executionId, approved.executionId);
    assert.equal(replayed.plan.storeVersion, approved.storeVersion);
    assert.equal(replayed.turn.turnId, approval.turnId);
    // Retrying the approval after the Plan state moved on must reuse the admitted
    // Turn: re-rendering the request from the current projection would hand the
    // model a different first message for the same Turn identity.
    assert.deepEqual(turns.texts, [request], 'the replayed approval must not re-dispatch');

    const recovered = await tui.request('plan.query', {
      kind: 'list_start',
      sessionId: session.id,
    });
    assert.equal(recovered.kind, 'page');
    if (recovered.kind !== 'page') return;
    assert.equal(recovered.activeExecutionId, null);
    const execution = recovered.items.find((item) => item.kind === 'execution');
    assert.ok(execution && execution.kind === 'execution');
    if (!execution || execution.kind !== 'execution') return;
    assert.equal(execution.execution.status, 'interrupted');

    await assert.rejects(
      tui.request('plan.turn.start', {
        kind: 'resume_execution',
        sessionId: session.id,
        executionId: execution.execution.executionId,
        turnId: approval.turnId,
      }),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'operation_conflict',
    );
    const unchanged = await tui.request('plan.query', {
      kind: 'list_start',
      sessionId: session.id,
    });
    assert.equal(unchanged.kind, 'page');
    assert.equal(
      unchanged.kind === 'page'
        ? unchanged.items.find((item) => item.kind === 'execution')?.execution.status
        : undefined,
      'interrupted',
    );

    turns.hold();
    const resuming = tui.request('plan.turn.start', {
      kind: 'resume_execution',
      sessionId: session.id,
      executionId: execution.execution.executionId,
      turnId: 'resume-turn',
    });
    await turns.dispatched(2);
    const resumeRequest = turns.texts[1] ?? '';
    assert.match(resumeRequest, /^Resume the approved plan execution \S+\.$/m);
    assert.match(resumeRequest, /^- step-1 \[pending\] Commit once$/m);
    const resumedRunning = await tui.request('plan.query', {
      kind: 'list_start',
      sessionId: session.id,
    });
    assert.equal(
      resumedRunning.kind === 'page' ? resumedRunning.activeExecutionId : undefined,
      execution.execution.executionId,
      'a resumed execution is active while its Turn is still running',
    );
    turns.release();
    const resumed = await resuming;
    assert.equal(resumed.plan.eventType, 'plan_execution_resumed');
    assert.equal(resumed.plan.executionId, execution.execution.executionId);
    assert.equal(resumed.turn.turnId, 'resume-turn');
    await waitForTerminal(tui, resumed.turn);
    const afterResume = await waitForExecutionStatus(tui, session.id, null);
    assert.equal(
      executionStatusOf(afterResume),
      'interrupted',
      'the resumed execution settles when its Turn ends without progress',
    );
  } finally {
    await Promise.allSettled([desktop?.close(), tui?.close()]);
    await host?.close().catch(() => undefined);
    await owner?.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

type PlanPage = Extract<PlanQueryResult, { kind: 'page' }>;

function executionStatusOf(page: PlanPage): string | undefined {
  const execution = page.items.find((item) => item.kind === 'execution');
  return execution?.kind === 'execution' ? execution.execution.status : undefined;
}

async function waitForExecutionStatus(
  connection: RuntimeHostConnection,
  sessionId: string,
  activeExecutionId: string | null,
): Promise<PlanPage> {
  let page: PlanPage | undefined;
  await waitFor(
    async () => {
      const result = await connection.request('plan.query', {
        kind: 'list_start',
        sessionId,
      });
      if (result.kind !== 'page') return false;
      page = result;
      return result.activeExecutionId === activeExecutionId;
    },
    { timeoutMs: 5_000, pollMs: 10, message: 'Plan execution did not settle' },
  );
  assert.ok(page);
  return page;
}

async function connect(rootPath: string): Promise<RuntimeHostConnection> {
  const result = await connectRuntimeHost({ rootPath, protocol: PROTOCOL });
  assert.equal(result.kind, 'connected');
  if (result.kind !== 'connected') throw new Error('Unable to connect to Runtime Host');
  return result.connection;
}

async function waitForTerminal(
  connection: RuntimeHostConnection,
  initial: OperationOutput<'plan.turn.start'>['turn'],
): Promise<void> {
  let snapshot = initial;
  await waitFor(
    async () => {
      if (
        snapshot.status === 'completed' ||
        snapshot.status === 'failed' ||
        snapshot.status === 'cancelled'
      ) {
        return true;
      }
      snapshot = await connection.request('turn.query', {
        sessionId: snapshot.sessionId,
        turnId: snapshot.turnId,
      });
      return (
        snapshot.status === 'completed' ||
        snapshot.status === 'failed' ||
        snapshot.status === 'cancelled'
      );
    },
    { timeoutMs: 5_000, pollMs: 10, message: 'Plan execution Turn did not settle' },
  );
}

async function nextFrameOfKind<K extends SubscriptionFrame['kind']>(
  subscription: RuntimeHostSessionSubscription,
  kind: K,
): Promise<Extract<SubscriptionFrame, { kind: K }>> {
  for await (const frame of subscription) {
    if (frame.kind === kind) {
      return frame as Extract<SubscriptionFrame, { kind: K }>;
    }
  }
  throw new Error(`Session subscription ended before ${kind}`);
}
/**
 * Lets a test park the deterministic backend inside `send` so it can observe the
 * Plan projection while the transition Turn is provably still in flight, then
 * let the Turn run to its terminal fact. Recording the dispatched text is what
 * makes the request itself assertable at the real model boundary.
 */
class PlanTurnControl {
  readonly texts: string[] = [];
  #gate: Promise<void> = Promise.resolve();
  #open: () => void = () => {};
  #arrivals: Array<() => void> = [];

  hold(): void {
    this.#gate = new Promise<void>((resolve) => {
      this.#open = resolve;
    });
  }

  release(): void {
    this.#open();
    this.#gate = Promise.resolve();
    this.#open = () => {};
  }

  waitForTurn(): Promise<void> {
    return this.#gate;
  }

  async dispatched(count: number): Promise<void> {
    while (this.texts.length < count) {
      await new Promise<void>((resolve) => this.#arrivals.push(resolve));
    }
  }

  record(text: string): void {
    this.texts.push(text);
    for (const resolve of this.#arrivals.splice(0)) resolve();
  }
}

class PlanTurnBackend extends FakeBackend {
  readonly #control: PlanTurnControl;

  constructor(ctx: { sessionId: string }, control: PlanTurnControl) {
    super(ctx);
    this.#control = control;
  }

  override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.#control.record(input.text);
    await this.#control.waitForTurn();
    yield* super.send(input);
  }
}

function controllableBackendComposition(control: PlanTurnControl): RuntimeHostCompositionFactory {
  return (context) =>
    createExecutionRuntimeHostComposition(
      context,
      {},
      { primaryBackendFactory: (backendContext) => new PlanTurnBackend(backendContext, control) },
    );
}

test('Plan queries include their state header when selecting byte-limited continuation pages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plan-pages-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const store = await openInteractivePlanStoreForWrite(owner.lease);
  let sessions: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
  try {
    sessions = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await sessions.sessionStore.create({
      cwd: root,
      llmConnectionSlug: 'test',
      model: 'test-model',
      permissionMode: 'explore',
      collaborationMode: 'plan',
    });
    for (let index = 0; index < 17; index += 1) {
      await store.submitProposal({
        operationId: `submit-${index}`,
        sessionId: session.id,
        turnId: `turn-${index}`,
        title: `Proposal ${index}`,
        steps: [{ id: 'step-1', title: 'Review', description: '文"\\🙂'.repeat(1000) }],
      });
    }
    const state = await store.readState(session.id);
    const expected = state.proposals.map((proposal) => ({ kind: 'proposal' as const, proposal }));
    const coordinator = new HostPlanCoordinator({
      store,
      sessions: sessions.sessionStore,
      sessionAdmission: new SessionAdmissionGate(),
      runtime: null as never,
      root: null as never,
      isSessionActive: () => false,
      refreshContinuity: async () => {},
      requestDrain: () => assert.fail('query must not drain'),
    });
    const pages: Extract<PlanQueryResult, { kind: 'page' }>[] = [];
    let input: PlanQueryInput = { kind: 'list_start', sessionId: session.id };
    let end = 0;
    do {
      const outcome = await coordinator.handlers['plan.query'](input, null as never);
      assert.ok(outcome.ok && outcome.result.kind === 'page');
      const page = outcome.result;
      assert.deepEqual(decodePlanQueryResult(page), page);
      assert.equal(page.latestProposalId, state.latestProposalId);
      assert.equal(page.storeVersion, state.storeVersion);
      assert.ok(page.items.length > 0);
      pages.push(page);
      end += page.items.length;
      assert.equal(page.nextCursor, end < expected.length ? String(end) : null);
      if (page.nextCursor === null) break;
      input = {
        kind: 'list_continue',
        sessionId: session.id,
        storeVersion: page.storeVersion,
        cursor: page.nextCursor,
      };
    } while (end < expected.length);
    assert.ok(pages.length > 1);
    assert.ok(pages[0]!.items.length < PLAN_PAGE_MAX_ITEMS);
    assertMaximalJsonPages(pages, expected, {
      maxBytes: PLAN_RESULT_MAX_BYTES,
      maxItems: PLAN_PAGE_MAX_ITEMS,
      items: (page) => page.items,
      candidate: (page, items, end) => ({
        ...page,
        items,
        nextCursor: end < expected.length ? String(end) : null,
      }),
    });
  } finally {
    store.close();
    await sessions?.sessionStore.close?.();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});
