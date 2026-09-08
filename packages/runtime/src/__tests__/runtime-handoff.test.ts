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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { AgentBackend, BackendSendInput } from '@maka/core/backend-types';
import { createRunCompositionSnapshot } from '@maka/core/run-composition';
import type { SessionEvent } from '@maka/core/events';
import { runtimeHandoffPause } from '@maka/core/runtime-handoff';
import { readLogicalRuntimeExecution } from '@maka/core/runtime-logical-execution';
import { createSessionStore } from '@maka/storage/session-store';
import { createSqliteAgentRunStore } from '@maka/storage/agent-run-store';
import { createSqliteRuntimeStore } from '@maka/storage/sqlite-runtime-store';
import { openInteractivePlanStoreForWrite } from '@maka/storage/plan-authority';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { RuntimeKernel } from '../runtime-kernel.js';
import { BackendRegistry, SessionManager } from '../session-manager.js';
import { FakeBackend } from '../test-only/fake-backend.js';
import { prepareConversationRuntimeLedgerCopy } from '../conversation-copy.js';
import { projectRuntimeEventUserMessage } from '../runtime-event-read-model.js';

for (const decision of [
  'commit',
  'cancel',
  'stop',
  'write_failure',
  'missing_source_snapshot',
  'missing_persisted_source_snapshot',
  'missing_capability',
  'uncommitted_preparation',
  'prompt_drift',
  'tool_drift',
  'availability_drift',
  'provider_options_drift',
  'context_window_drift',
  'revision_only',
  'inherited_denial',
  'denial_lookup_failure',
] as const) {
  test(`Runtime-owned handoff ${decision} preserves canonical logical outcome`, {
    timeout: 10_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-runtime-handoff-'));
    const owner = await tryAcquireInteractiveRootOwner(
      await resolveStorageRoot({ path: root, kind: 'interactive' }),
    );
    assert.ok(owner);
    const store = createSessionStore(root);
    const runStore = createSqliteAgentRunStore(root);
    const planStore = await openInteractivePlanStoreForWrite(owner.lease);
    const runtimeEventStore = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
    const entered = deferred<void>();
    const reachBoundary = deferred<void>();
    const releaseStream = deferred<void>();
    const executionAbort = new AbortController();
    let backendDispatches = 0;
    let fixtureBackend: AgentBackend | undefined;
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => {
      const backend = new (class extends FakeBackend {
        async prepareRunComposition(input: { runId: string; turnId: string }): Promise<void> {
          const successor = input.runId === 'successor-run';
          if (successor && decision === 'uncommitted_preparation') return;
          const unchanged = `sha256:${'0'.repeat(64)}` as const;
          const changed = `sha256:${'1'.repeat(64)}` as const;
          await ctx.recordRunComposition!(
            input.runId,
            createRunCompositionSnapshot({
              composerId: 'test.handoff',
              composerRevision: successor && decision === 'revision_only' ? '2' : '1',
              sourceRevisions: [],
              baseSystemPromptHash: successor && decision === 'prompt_drift' ? changed : unchanged,
              toolCatalogHash: successor && decision === 'tool_drift' ? changed : unchanged,
              toolAvailabilityHash:
                successor && decision === 'availability_drift' ? changed : unchanged,
              baseProviderOptionsHash:
                successor && decision === 'provider_options_drift' ? changed : unchanged,
              toolNames: [],
              contextWindow: successor && decision === 'context_window_drift' ? 8192 : null,
            }),
          );
        }

        override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
          backendDispatches += 1;
          if (!input.continuation) {
            if (decision !== 'missing_source_snapshot') {
              await this.prepareRunComposition({ runId: input.runId!, turnId: input.turnId });
            }
            entered.resolve();
            await reachBoundary.promise;
            const result = await input.handoffBoundary!(executionAbort.signal, 2);
            await releaseStream.promise;
            if (result === 'pause' && !executionAbort.signal.aborted) return;
          }
          if (input.continuation) {
            assert.equal(input.maxSteps, 2);
            assert.equal(input.headAnchorRuntimeEvent?.runId, 'original-run');
            assert.equal(input.headAnchorRuntimeEvent?.turnId, 'logical-turn');
            assert.equal(input.headAnchorRuntimeEvent?.content?.kind, 'text');
            assert.equal(input.continuation.sandboxBoundaryDenied, decision === 'inherited_denial');
          }
          yield {
            type: 'complete',
            id: `complete-${backendDispatches}`,
            turnId: input.turnId,
            ts: Date.now(),
            stopReason: executionAbort.signal.aborted ? 'user_stop' : 'end_turn',
          };
        }
        override async stop(): Promise<void> {
          executionAbort.abort();
        }
      })({ sessionId: ctx.sessionId });
      fixtureBackend = backend;
      return backend;
    });
    let id = 0;
    const deps = {
      store,
      runStore,
      runtimeEventStore,
      planStore,
      backends,
      safeBoundaryResumeEnabled: true,
      toolBoundaryProtocol: 't1_after_preflight_v1' as const,
      inspectContinuationSafety: async () => ({
        workspaceIdentity: 'workspace-1',
        backgroundOperationsSettled: true,
        availableToolNames: [] as string[],
      }),
      newId: () => `id-${++id}`,
      now: Date.now,
    };
    const kernel = new RuntimeKernel(deps);
    const manager = new SessionManager({ ...deps, runtimeKernel: kernel });
    const session = await manager.createSession({
      cwd: root,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
      name: 'handoff',
    });
    try {
      await planStore.submitProposal({
        sessionId: session.id,
        turnId: 'proposal-turn',
        title: 'work',
        steps: [{ id: 'step-1', title: 'finish', description: 'finish the logical task' }],
      });
      const proposal = (await planStore.readState(session.id)).proposals[0]!;
      await planStore.approveProposal({
        sessionId: session.id,
        proposalId: proposal.proposalId,
        expectedRevision: proposal.revision,
      });
      const events: SessionEvent[] = [];
      const running = (async () => {
        for await (const event of manager.sendMessage(
          session.id,
          {
            turnId: 'logical-turn',
            text: 'continue work',
            origin: { kind: 'goal', goalId: 'goal-1' },
          },
          { runId: 'original-run', durability: 'required' },
        ))
          events.push(event);
      })();
      void running.catch(() => {});
      await entered.promise;
      const pause = {
        protocol: 'runtime_handoff_pause_v1' as const,
        handoffId: 'handoff',
        hostEpoch: 'host-1',
        rootRunId: 'original-run',
        successorRunId: 'successor-run',
        successorInvocationId: 'successor-run',
        claimId: 'exact-handoff-claim',
      };
      const request = kernel.requestRunHandoff(
        session.id,
        'original-run',
        pause,
        new AbortController().signal,
      );
      assert.ok(request);
      reachBoundary.resolve();
      assert.equal(await request.ready, true);
      if (decision === 'missing_source_snapshot') {
        assert.throws(() => request.preview(), /durably committed Run Composition/);
        assert.throws(() => request.commit(), /durably committed Run Composition/);
        request.cancel();
        releaseStream.resolve();
        await running;
        assert.equal(await request.sealed, false);
        return;
      }
      assert.equal(
        events.some((event) => event.type === 'complete'),
        false,
      );
      if (decision === 'write_failure') {
        const append = runtimeEventStore.appendRuntimeEvent.bind(runtimeEventStore);
        runtimeEventStore.appendRuntimeEvent = async (sessionId, runId, event, options) => {
          if (event.actions?.handoffPause) throw new Error('pause durability failed');
          return append(sessionId, runId, event, options);
        };
      }
      if (decision === 'cancel') request.cancel();
      else assert.equal(request.commit(), true);
      const stopped =
        decision === 'stop' ? kernel.stopSession(session.id, { source: 'stop_button' }) : undefined;
      releaseStream.resolve();
      if (decision === 'write_failure') {
        await assert.rejects(running, /pause durability failed|finalization failed/);
        await assert.rejects(request.sealed, /pause durability failed/);
        return;
      }
      await stopped;
      await running;
      const committed = decision !== 'cancel' && decision !== 'stop';
      assert.equal(await request.sealed, committed);
      const source = await runtimeEventStore.readRunInvocation(session.id, 'original-run');
      assert.ok(source?.terminalEvent);
      if (!committed) {
        assert.equal(source.terminalEvent.status, decision === 'stop' ? 'aborted' : 'completed');
        assert.equal(runtimeHandoffPause(source.terminalEvent), undefined);
        return;
      }
      assert.deepEqual(runtimeHandoffPause(source.terminalEvent), { ...pause, remainingSteps: 2 });
      assert.equal(source.terminalEvent.status, undefined);
      assert.equal(
        events.some((event) => event.type === 'complete' || event.type === 'error'),
        false,
      );
      const sourceEvents = await runtimeEventStore.readRuntimeEvents(session.id, 'original-run');
      await assert.rejects(
        prepareConversationRuntimeLedgerCopy({
          sourceSessionId: session.id,
          sourceEvents,
          // The paused run carries no terminal status yet, so the read model
          // refuses to project the Session; the copy only reads the Turn its
          // messages name.
          copiedMessages: sourceEvents
            .map((event) => projectRuntimeEventUserMessage(event, event.id))
            .filter((message) => message !== undefined),
          runStore,
          runtimeEventStore,
        }),
        { code: 'branch_runtime_fact_rewrite_unsupported' },
      );
      await manager.recoverInterruptedSessions();
      assert.equal((await planStore.readState(session.id)).executions[0]?.status, 'active');
      assert.deepEqual(
        (await runtimeEventStore.readRunInvocation(session.id, 'original-run'))?.terminalEvent,
        source.terminalEvent,
      );
      const plan = await manager.planAuthoritativeSafeBoundaryContinuation(session.id, {
        sourceRunId: 'original-run',
        purpose: 'handoff',
      });
      assert.ok(plan.continuation, JSON.stringify(plan));
      assert.equal(plan.continuation.turnId, 'logical-turn');
      assert.equal(plan.continuation.runId, 'successor-run');
      assert.equal(
        (
          await manager.planAuthoritativeSafeBoundaryContinuation(session.id, {
            sourceRunId: 'original-run',
          })
        ).disposition,
        'park',
      );
      if (decision === 'missing_capability') {
        assert.ok(fixtureBackend);
        fixtureBackend.prepareRunComposition = undefined;
      }
      if (decision === 'inherited_denial' || decision === 'denial_lookup_failure') {
        store.hasExplicitSandboxBoundaryDenial = async (identities) => {
          assert.deepEqual(
            identities,
            plan.continuation!.boundary!.segments.map((segment) => segment.identity),
          );
          if (decision === 'denial_lookup_failure') throw new Error('denial authority unavailable');
          return true;
        };
      }
      if (decision === 'missing_persisted_source_snapshot') {
        const readEvents = runStore.readEvents.bind(runStore);
        runStore.readEvents = async (sessionId, runId) => {
          const recorded = await readEvents(sessionId, runId);
          return runId === 'original-run'
            ? recorded.filter((event) => event.type !== 'run_composition_recorded')
            : recorded;
        };
      }
      const resume = async () => {
        for await (const event of manager.resumeSafeBoundaryContinuation(plan.continuation!))
          events.push(event);
      };
      if (
        decision === 'denial_lookup_failure' ||
        decision === 'missing_persisted_source_snapshot'
      ) {
        await assert.rejects(resume, /denial authority unavailable|no durable Run Composition/);
        assert.equal(backendDispatches, 1);
        assert.equal(
          await runtimeEventStore.readRunInvocation(session.id, 'successor-run'),
          undefined,
        );
        assert.equal(
          await runtimeEventStore.readContinuationClaimStateByBoundary(
            plan.continuation.boundary!.manifestDigest,
          ),
          undefined,
        );
        return;
      }
      const failedPreparation =
        decision !== 'commit' && decision !== 'revision_only' && decision !== 'inherited_denial';
      if (failedPreparation) {
        await assert.rejects(resume, /Run Composition|composition preparation/);
      } else {
        await resume();
      }
      const logical = await readLogicalRuntimeExecution(runtimeEventStore, {
        sessionId: session.id,
        turnId: 'logical-turn',
        runId: 'original-run',
      });
      assert.equal(backendDispatches, failedPreparation ? 1 : 2);
      assert.equal(logical?.tip.runId, 'successor-run');
      assert.deepEqual(logical?.tip.opening.root, { kind: 'goal', goalId: 'goal-1' });
      assert.equal(logical?.tip.terminalEvent?.status, failedPreparation ? 'failed' : 'completed');
      assert.equal(
        events.filter((event) => event.type === 'complete').length,
        failedPreparation ? 0 : 1,
      );
      await manager.recoverInterruptedSessions();
      assert.equal((await planStore.readState(session.id)).executions[0]?.status, 'interrupted');
    } finally {
      reachBoundary.resolve();
      releaseStream.resolve();
      await kernel.disposeBackend(session.id).catch(() => {});
      runtimeEventStore.close();
      planStore.close();
      await runStore.close?.();
      await store.close?.();
      await owner.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
