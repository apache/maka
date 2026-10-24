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

import { deferred, nextId, waitFor, withTimeout } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  AgentGraphScheduleControlStore,
  AgentGraphScheduleUpdateRequest,
} from '@maka/core/agent-graph-schedule';
import type { AgentGraphIntentClaimStore } from '@maka/core/agent-graph-control';
import type { AgentGraphOperatorProvision } from '@maka/core/agent-graph-topology';
import type { SessionHeader } from '@maka/core/session';
import { createSqliteSessionMetadataStore } from '@maka/storage/sqlite-session-metadata-store';
import type {
  AgentGraphIntentExecutor,
  AgentGraphSupervisorObservation,
} from '../stream-graph-dispatch.js';
import { fingerprintAgentGraphRunnableIntent } from '../stream-graph-admission.js';
import type { AgentGraphRecord } from '../stream-graph-projection.js';
import type { AgentGraphInputHandoff } from '../stream-graph-handoff.js';
import {
  reconcileAgentGraphSchedule,
  type RenderAgentGraphScheduledWorkPromptInput,
  type AgentGraphScheduleStopController,
} from '../stream-graph-schedule-reconcile.js';
import {
  compileAgentGraphScheduleUpdate,
  type UpdateAgentGraphToolInput,
} from '../stream-graph-supervisor-tools.js';
import type { AgentGraphTraceTopology } from '../stream-graph-trace.js';

describe('stream graph schedule reconciliation', () => {
  test('hydrates selected results without leaking them into another work item', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(90) });
    const provisions: AgentGraphOperatorProvision[] = [];
    const controlStore = controlStoreWithProvisions(store, provisions);
    const observation = new MemoryGraphObservation();
    const executor = new MemoryScheduleExecutor(controlStore, observation);
    const historical = historicalRecord();
    try {
      await commitSchedule(controlStore, 'tool-historical', {
        add_work: [
          {
            agent_id: 'local-read',
            instruction: 'Continue from the selected earlier result.',
            input_ids: [],
            selected_result_inputs: [
              { source_graph_id: historical.graphId, result_id: historical.recordId },
            ],
          },
          {
            agent_id: 'local-read',
            instruction: 'This work only requested a current-graph input.',
            input_ids: [historical.recordId],
          },
        ],
      });
      let renderedRecord: AgentGraphRecord | undefined;
      const result = await reconcileAgentGraphSchedule({
        topology: topology(),
        controlStore,
        executor,
        stopController: new MemoryStopController(observation),
        newId: nextId(),
        maxNewActivations: 1,
        observeGraph: (currentTopology) => observation.read(currentTopology),
        resolveSelectedResultInputs: async () => [historical],
        async provisionOperator(input) {
          assert.deepEqual(input.edges, []);
          const provision: AgentGraphOperatorProvision = {
            schemaVersion: 1,
            provisionId: `graph_provision_${'4'.repeat(32)}`,
            provisionFingerprint: `sha256:${'5'.repeat(64)}`,
            graphId: input.graphId,
            workId: input.workId,
            agentId: input.agentId!,
            operatorId: input.operatorId,
            initialTurnId: 'reserved-turn',
            initialRunId: 'reserved-run',
            edges: input.edges,
            targetSessionId: 'session-historical-reader',
            provisionedAt: 91,
          };
          provisions.push(provision);
          return {
            provision,
            created: true,
            header: { id: provision.targetSessionId } as SessionHeader,
          };
        },
        renderPrompt: ({ inputRecords, work }) => {
          renderedRecord = inputRecords[0];
          return work.instruction;
        },
      });

      assert.equal(result.status, 'waiting');
      assert.equal(renderedRecord?.graphId, historical.graphId);
      assert.deepEqual(result.dispatches[0]?.intent.triggerRecordIds, [historical.recordId]);
      assert.deepEqual(
        result.deferredWork.map((item) => ({
          instruction: item.work.instruction,
          reason: item.reason,
          missingInputIds: item.missingInputIds,
        })),
        [
          {
            instruction: 'This work only requested a current-graph input.',
            reason: 'input_not_committed',
            missingInputIds: [historical.recordId],
          },
        ],
      );
    } finally {
      store.close();
    }
  });

  test('defers work whose historical result source becomes unresolvable', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(90) });
    const provisions: AgentGraphOperatorProvision[] = [];
    const controlStore = controlStoreWithProvisions(store, provisions);
    const observation = new MemoryGraphObservation();
    const executor = new MemoryScheduleExecutor(controlStore, observation);
    const historical = historicalRecord();
    try {
      await commitSchedule(controlStore, 'tool-unresolvable', {
        add_work: [
          {
            agent_id: 'local-read',
            instruction: 'Continue from the selected earlier result.',
            input_ids: [],
            selected_result_inputs: [
              { source_graph_id: historical.graphId, result_id: historical.recordId },
            ],
          },
        ],
      });
      let resolveCalls = 0;
      const result = await reconcileAgentGraphSchedule({
        topology: topology(),
        controlStore,
        executor,
        stopController: new MemoryStopController(observation),
        newId: nextId(),
        maxNewActivations: 1,
        observeGraph: (currentTopology) => observation.read(currentTopology),
        resolveSelectedResultInputs: async () => {
          resolveCalls += 1;
          throw new Error('source epoch runtime events are unreadable');
        },
        renderPrompt: ({ work }) => work.instruction,
      });

      assert.equal(result.status, 'waiting');
      assert.equal(result.failures.length, 0);
      assert.equal(result.dispatches.length, 0);
      assert.equal(resolveCalls, 1);
      assert.deepEqual(
        result.deferredWork.map((item) => ({
          reason: item.reason,
          missingInputIds: item.missingInputIds,
        })),
        [{ reason: 'input_not_committed', missingInputIds: [historical.recordId] }],
      );
    } finally {
      store.close();
    }
  });

  test('resolves each historical result source once per reconciliation', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(90) });
    const provisions: AgentGraphOperatorProvision[] = [];
    const controlStore = controlStoreWithProvisions(store, provisions);
    const observation = new MemoryGraphObservation();
    const executor = new MemoryScheduleExecutor(controlStore, observation);
    const historical = historicalRecord();
    try {
      await commitSchedule(controlStore, 'tool-cached-resolution', {
        add_work: [
          {
            agent_id: 'local-read',
            instruction: 'Continue from the selected earlier result.',
            input_ids: [],
            selected_result_inputs: [
              { source_graph_id: historical.graphId, result_id: historical.recordId },
            ],
          },
        ],
      });
      let resolveCalls = 0;
      const result = await reconcileAgentGraphSchedule({
        topology: topology(),
        controlStore,
        executor,
        stopController: new MemoryStopController(observation),
        newId: nextId(),
        maxNewActivations: 1,
        observeGraph: (currentTopology) => observation.read(currentTopology),
        resolveSelectedResultInputs: async (selected) => {
          resolveCalls += 1;
          return selected.map(() => structuredClone(historical));
        },
        async provisionOperator(input) {
          const provision: AgentGraphOperatorProvision = {
            schemaVersion: 1,
            provisionId: `graph_provision_${'4'.repeat(32)}`,
            provisionFingerprint: `sha256:${'5'.repeat(64)}`,
            graphId: input.graphId,
            workId: input.workId,
            agentId: input.agentId!,
            operatorId: input.operatorId,
            initialTurnId: 'reserved-turn',
            initialRunId: 'reserved-run',
            edges: input.edges,
            targetSessionId: 'session-historical-reader',
            provisionedAt: 91,
          };
          provisions.push(provision);
          return {
            provision,
            created: true,
            header: { id: provision.targetSessionId } as SessionHeader,
          };
        },
        renderPrompt: ({ work }) => work.instruction,
      });

      assert.equal(result.status, 'reconciled');
      assert.equal(result.dispatches.length, 1);
      assert.equal(resolveCalls, 1);
    } finally {
      store.close();
    }
  });

  test('defers only the work items whose historical source failed', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(90) });
    const provisions: AgentGraphOperatorProvision[] = [];
    const controlStore = controlStoreWithProvisions(store, provisions);
    const observation = new MemoryGraphObservation();
    const executor = new MemoryScheduleExecutor(controlStore, observation);
    const historical = historicalRecord();
    try {
      await commitSchedule(controlStore, 'tool-partial-resolution', {
        add_work: [
          {
            agent_id: 'local-read',
            instruction: 'Continue from the readable earlier result.',
            input_ids: [],
            selected_result_inputs: [
              { source_graph_id: historical.graphId, result_id: historical.recordId },
            ],
          },
          {
            agent_id: 'local-read',
            instruction: 'Continue from the unreadable earlier result.',
            input_ids: [],
            selected_result_inputs: [
              { source_graph_id: 'graph-broken', result_id: 'record-broken' },
            ],
          },
        ],
      });
      const result = await reconcileAgentGraphSchedule({
        topology: topology(),
        controlStore,
        executor,
        stopController: new MemoryStopController(observation),
        newId: nextId(),
        maxNewActivations: 2,
        observeGraph: (currentTopology) => observation.read(currentTopology),
        resolveSelectedResultInputs: async (selected) => {
          if (selected.some((item) => item.sourceGraphId === 'graph-broken')) {
            throw new Error('source epoch runtime events are unreadable');
          }
          return selected.map(() => structuredClone(historical));
        },
        async provisionOperator(input) {
          const provision: AgentGraphOperatorProvision = {
            schemaVersion: 1,
            provisionId: `graph_provision_${'4'.repeat(32)}`,
            provisionFingerprint: `sha256:${'5'.repeat(64)}`,
            graphId: input.graphId,
            workId: input.workId,
            agentId: input.agentId!,
            operatorId: input.operatorId,
            initialTurnId: 'reserved-turn',
            initialRunId: 'reserved-run',
            edges: input.edges,
            targetSessionId: `session-${input.workId}`,
            provisionedAt: 91,
          };
          provisions.push(provision);
          return {
            provision,
            created: true,
            header: { id: provision.targetSessionId } as SessionHeader,
          };
        },
        renderPrompt: ({ work }) => work.instruction,
      });

      assert.equal(result.status, 'waiting');
      assert.equal(result.failures.length, 0);
      assert.equal(result.dispatches.length, 1);
      assert.deepEqual(
        result.deferredWork.map((item) => ({
          reason: item.reason,
          missingInputIds: item.missingInputIds,
        })),
        [{ reason: 'input_not_committed', missingInputIds: ['record-broken'] }],
      );
    } finally {
      store.close();
    }
  });

  test('executes existing operators durably and leaves new agents waiting for topology', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(100) });
    const observation = new MemoryGraphObservation();
    const executor = new MemoryScheduleExecutor(store, observation);
    const stopController = new MemoryStopController(observation);
    let observedSnapshots = 0;
    let observedActivations = 0;
    const hydrateInputHandoffs = async (
      records: readonly AgentGraphRecord[],
    ): Promise<AgentGraphInputHandoff[]> =>
      records.map((record) => ({
        schemaVersion: 1,
        record: {
          recordId: record.recordId,
          graphId: record.graphId,
          operatorId: record.operatorId,
          activationId: record.activationId,
          facets: record.facets,
          source: record.source,
        },
        conclusion: {
          format: 'operator_handoff_markdown_v1',
          sourceRuntimeEventId: record.source.runtimeEventId,
          text: 'Outcome: upstream parser review completed.',
          originalBytes: 42,
          textTruncated: false,
        },
      }));
    const renderPrompt = ({
      work,
      inputRecords,
      inputHandoffs,
    }: RenderAgentGraphScheduledWorkPromptInput): string =>
      `${work.instruction}\nInputs: ${inputRecords.map((record) => record.recordId).join(',')}\nHandoff: ${inputHandoffs[0]?.conclusion?.text ?? 'none'}`;
    try {
      await commitSchedule(store, 'tool-add', {
        add_work: [
          {
            operator_id: 'writer',
            instruction: 'Revise the answer with the selected evidence.',
            input_ids: ['record-input'],
          },
          {
            agent_id: 'local-read',
            instruction: 'Check one more source.',
            input_ids: [],
          },
        ],
      });

      const first = await reconcileAgentGraphSchedule({
        topology: topology(),
        controlStore: store,
        executor,
        stopController,
        newId: nextId(),
        maxNewActivations: 1,
        observeGraph: () => observation.read(),
        hydrateInputHandoffs,
        renderPrompt,
        supervisor: {
          onObservation() {
            observedSnapshots += 1;
            throw new Error('presentation observer must not gate reconciliation');
          },
          onActivationReady() {
            observedActivations += 1;
          },
        },
      });

      assert.equal(first.status, 'waiting');
      assert.equal(first.newActivationCount, 1);
      assert.equal(first.observedExistingActivationCount, 0);
      assert.equal(first.dispatches.length, 1);
      assert.equal(first.dispatches[0]?.intent.policyKind, 'supervisor');
      assert.deepEqual(first.dispatches[0]?.intent.triggerRecordIds, ['record-input']);
      assert.deepEqual(
        first.deferredWork.map((item) => item.reason),
        ['agent_topology_required'],
      );
      assert.equal(executor.backendInvocations, 1);
      assert.match(executor.lastPrompt ?? '', /Handoff: Outcome: upstream parser review completed/);
      assert.ok(observedSnapshots >= 2);
      assert.equal(observedActivations, 1);

      const retry = await reconcileAgentGraphSchedule({
        topology: topology(),
        controlStore: store,
        executor,
        stopController,
        newId: nextId(),
        maxNewActivations: 0,
        observeGraph: () => observation.read(),
        hydrateInputHandoffs,
        renderPrompt,
      });

      assert.equal(retry.status, 'waiting');
      assert.equal(retry.newActivationCount, 0);
      assert.equal(retry.observedExistingActivationCount, 1);
      assert.equal(executor.backendInvocations, 1);
    } finally {
      store.close();
    }
  });

  test('materializes agent work as a child operator and claims its reserved first run', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(150) });
    const provisions: AgentGraphOperatorProvision[] = [];
    const controlStore = controlStoreWithProvisions(store, provisions);
    const observation = new MemoryGraphObservation();
    const executor = new MemoryScheduleExecutor(controlStore, observation);
    const stopController = new MemoryStopController(observation);
    try {
      const update = await commitSchedule(controlStore, 'tool-agent', {
        add_work: [
          {
            agent_id: 'local-read',
            instruction: 'Inspect one more source.',
            input_ids: ['record-input'],
          },
        ],
      });
      let provisionCalls = 0;
      const result = await reconcileAgentGraphSchedule({
        topology: topology(),
        controlStore,
        executor,
        stopController,
        newId: nextId(),
        maxNewActivations: 1,
        observeGraph: (currentTopology) => observation.read(currentTopology),
        async provisionOperator(input) {
          provisionCalls += 1;
          assert.equal(input.workId, update.addWork[0]!.workId);
          assert.equal(input.source.toolCallId, 'tool-agent');
          assert.deepEqual(
            input.edges.map((edge) => edge.fromOperatorId),
            ['writer'],
          );
          const provision: AgentGraphOperatorProvision = {
            schemaVersion: 1,
            provisionId: `graph_provision_${'1'.repeat(32)}`,
            provisionFingerprint: `sha256:${'2'.repeat(64)}`,
            graphId: input.graphId,
            workId: input.workId,
            agentId: input.agentId!,
            operatorId: input.operatorId,
            initialTurnId: 'reserved-turn',
            initialRunId: 'reserved-run',
            edges: input.edges,
            targetSessionId: 'session-dynamic',
            provisionedAt: 151,
          };
          provisions.push(provision);
          return {
            provision,
            created: true,
            header: { id: provision.targetSessionId } as SessionHeader,
          };
        },
        renderPrompt: ({ work }) => work.instruction,
      });

      assert.equal(result.status, 'reconciled');
      assert.equal(provisionCalls, 1);
      assert.equal(result.deferredWork.length, 0);
      assert.equal(result.dispatches.length, 1);
      assert.match(result.dispatches[0]!.intent.operatorId, /^graph_operator_[a-f0-9]{32}$/);
      assert.equal(result.dispatches[0]!.claim.targetSessionId, 'session-dynamic');
      assert.equal(result.dispatches[0]!.claim.targetTurnId, 'reserved-turn');
      assert.equal(result.dispatches[0]!.claim.targetRunId, 'reserved-run');
      assert.equal(
        result.observation.projection.operators.some(
          (operator) => operator.sessionId === 'session-dynamic',
        ),
        true,
      );
    } finally {
      store.close();
    }
  });

  test('stops an admitted activation before considering later work', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(200) });
    const observation = new MemoryGraphObservation();
    const executor = new MemoryScheduleExecutor(store, observation, 'running');
    const stopController = new MemoryStopController(observation);
    try {
      const added = await commitSchedule(store, 'tool-add', {
        add_work: [
          {
            operator_id: 'writer',
            instruction: 'Keep drafting until stopped.',
            input_ids: [],
          },
        ],
      });
      const workId = added.addWork[0]!.workId;
      const first = await reconcileAgentGraphSchedule({
        topology: topology(),
        controlStore: store,
        executor,
        stopController,
        newId: nextId(),
        maxNewActivations: 1,
        observeGraph: () => observation.read(),
        renderPrompt: ({ work }) => work.instruction,
      });
      assert.equal(first.status, 'reconciled');
      assert.equal(first.dispatches[0]?.result.status, 'running');

      await commitSchedule(store, 'tool-stop', {
        stop: [{ target_id: workId, reason: 'The draft is no longer useful.' }],
      });
      const stopped = await reconcileAgentGraphSchedule({
        topology: topology(),
        controlStore: store,
        executor,
        stopController,
        newId: nextId(),
        maxNewActivations: 0,
        observeGraph: () => observation.read(),
        renderPrompt: ({ work }) => work.instruction,
      });

      assert.equal(stopped.status, 'reconciled');
      assert.deepEqual(stopController.calls, [
        {
          sessionId: 'session-writer',
          runId: first.dispatches[0]!.claim.targetRunId,
          turnId: first.dispatches[0]!.claim.targetTurnId,
          source: 'graph_supervisor',
        },
      ]);
      assert.deepEqual(
        stopped.stops.map((result) => [result.targetId, result.status, result.activationId]),
        [[workId, 'stopped', first.dispatches[0]!.claim.targetRunId]],
      );
      assert.equal(stopped.dispatches.length, 0);
      assert.equal(stopped.schedule.work[0]?.status, 'stopped');
    } finally {
      store.close();
    }
  });

  test('a historical terminal stop target neither reaches the runtime nor blocks new work', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(250) });
    const observation = new MemoryGraphObservation();
    const executor = new MemoryScheduleExecutor(store, observation, 'running');
    const stopController = new MemoryStopController(observation);
    try {
      const added = await commitSchedule(store, 'tool-add', {
        add_work: [{ operator_id: 'writer', instruction: 'Draft until stopped.', input_ids: [] }],
      });
      const stoppedWorkId = added.addWork[0]!.workId;
      const newId = nextId();
      const reconcile = (controller: AgentGraphScheduleStopController) =>
        reconcileAgentGraphSchedule({
          topology: topology(),
          controlStore: store,
          executor,
          stopController: controller,
          newId,
          maxNewActivations: 1,
          observeGraph: () => observation.read(),
          renderPrompt: ({ work }) => work.instruction,
        });
      await reconcile(stopController);
      await commitSchedule(store, 'tool-stop', {
        stop: [{ target_id: stoppedWorkId, reason: 'The draft is obsolete.' }],
      });
      assert.equal((await reconcile(stopController)).stops[0]?.status, 'stopped');
      assert.equal(stopController.calls.length, 1);

      const next = await commitSchedule(store, 'tool-add-next', {
        add_work: [{ operator_id: 'writer', instruction: 'Draft the replacement.', input_ids: [] }],
      });
      let runtimeStops = 0;
      const result = await reconcile({
        async stopAgentGraphActivation() {
          runtimeStops += 1;
          throw new Error('a settled historical stop must not reach the runtime again');
        },
      });

      assert.equal(runtimeStops, 0);
      assert.equal(result.status, 'reconciled');
      assert.deepEqual(
        result.stops.map((stop) => [stop.targetId, stop.status]),
        [[stoppedWorkId, 'already_terminal']],
      );
      assert.deepEqual(
        result.dispatches.map((dispatch) => dispatch.intent.readinessId),
        [next.addWork[0]!.workId],
      );
    } finally {
      store.close();
    }
  });

  test('does not admit stale work when a stop wins the SQLite revision race', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(300) });
    const observation = new MemoryGraphObservation();
    const executor = new MemoryScheduleExecutor(store, observation);
    const stopController = new MemoryStopController(observation);
    try {
      const added = await commitSchedule(store, 'tool-add', {
        add_work: [
          {
            operator_id: 'writer',
            instruction: 'This must not start after stop commits.',
            input_ids: [],
          },
        ],
      });
      const workId = added.addWork[0]!.workId;
      let raced = false;
      const racingStore: AgentGraphScheduleControlStore = {
        commitAgentGraphScheduleUpdate: (request) => store.commitAgentGraphScheduleUpdate(request),
        listAgentGraphScheduleUpdates: (graphId) => store.listAgentGraphScheduleUpdates(graphId),
        listAgentGraphOperatorProvisions: (graphId) =>
          store.listAgentGraphOperatorProvisions(graphId),
        claimAgentGraphIntent: (request) => store.claimAgentGraphIntent(request),
        readAgentGraphIntentClaim: (graphId, intentId) =>
          store.readAgentGraphIntentClaim(graphId, intentId),
        listAgentGraphIntentClaims: (graphId) => store.listAgentGraphIntentClaims(graphId),
        beginAgentGraphIntentExecutionAtScheduleRevision: (graphId, intentId, expectedRevision) =>
          store.beginAgentGraphIntentExecutionAtScheduleRevision(
            graphId,
            intentId,
            expectedRevision,
          ),
        cancelAgentGraphIntentExecution: (graphId, intentId, reason) =>
          store.cancelAgentGraphIntentExecution(graphId, intentId, reason),
        async claimAgentGraphIntentAtScheduleRevision(request, expectedRevision) {
          if (!raced) {
            raced = true;
            await commitSchedule(store, 'tool-stop', {
              stop: [{ target_id: workId, reason: 'Stop won the revision race.' }],
            });
          }
          return await store.claimAgentGraphIntentAtScheduleRevision(request, expectedRevision);
        },
      };

      const result = await reconcileAgentGraphSchedule({
        topology: topology(),
        controlStore: racingStore,
        executor,
        stopController,
        newId: nextId(),
        maxNewActivations: 1,
        observeGraph: () => observation.read(),
        renderPrompt: ({ work }) => work.instruction,
      });

      assert.equal(result.status, 'reconciled');
      assert.equal(result.newActivationCount, 0);
      assert.equal(result.dispatches.length, 0);
      assert.equal(result.stops[0]?.status, 'cancelled_before_runtime');
      assert.equal(executor.backendInvocations, 0);
      assert.deepEqual(await store.listAgentGraphIntentClaims(GRAPH_ID), []);
    } finally {
      store.close();
    }
  });

  test('durably cancels a claim when stop wins before Runtime execution admission', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(400) });
    const observation = new MemoryGraphObservation();
    const executor = new MemoryScheduleExecutor(store, observation);
    const stopController = new MemoryStopController(observation);
    const claimed = deferred<void>();
    const releaseClaim = deferred<void>();
    let pauseClaim = true;
    try {
      const added = await commitSchedule(store, 'tool-add', {
        add_work: [
          {
            operator_id: 'writer',
            instruction: 'Do not start if the supervisor stops this claim.',
            input_ids: [],
          },
        ],
      });
      const workId = added.addWork[0]!.workId;
      const pausingStore: AgentGraphScheduleControlStore = {
        commitAgentGraphScheduleUpdate: (request) => store.commitAgentGraphScheduleUpdate(request),
        listAgentGraphScheduleUpdates: (graphId) => store.listAgentGraphScheduleUpdates(graphId),
        listAgentGraphOperatorProvisions: (graphId) =>
          store.listAgentGraphOperatorProvisions(graphId),
        claimAgentGraphIntent: (request) => store.claimAgentGraphIntent(request),
        readAgentGraphIntentClaim: (graphId, intentId) =>
          store.readAgentGraphIntentClaim(graphId, intentId),
        listAgentGraphIntentClaims: (graphId) => store.listAgentGraphIntentClaims(graphId),
        beginAgentGraphIntentExecutionAtScheduleRevision: (graphId, intentId, expectedRevision) =>
          store.beginAgentGraphIntentExecutionAtScheduleRevision(
            graphId,
            intentId,
            expectedRevision,
          ),
        cancelAgentGraphIntentExecution: (graphId, intentId, reason) =>
          store.cancelAgentGraphIntentExecution(graphId, intentId, reason),
        async claimAgentGraphIntentAtScheduleRevision(request, expectedRevision) {
          const result = await store.claimAgentGraphIntentAtScheduleRevision(
            request,
            expectedRevision,
          );
          if (pauseClaim) {
            pauseClaim = false;
            claimed.resolve();
            await releaseClaim.promise;
          }
          return result;
        },
      };
      const firstPromise = reconcileAgentGraphSchedule({
        topology: topology(),
        controlStore: pausingStore,
        executor,
        stopController,
        newId: nextId(),
        maxNewActivations: 1,
        observeGraph: () => observation.read(),
        renderPrompt: ({ work }) => work.instruction,
      });
      await claimed.promise;

      await commitSchedule(store, 'tool-stop', {
        stop: [{ target_id: workId, reason: 'Stop before Runtime admission.' }],
      });
      const stopper = await reconcileAgentGraphSchedule({
        topology: topology(),
        controlStore: store,
        executor,
        stopController,
        newId: nextId(),
        maxNewActivations: 0,
        observeGraph: () => observation.read(),
        renderPrompt: ({ work }) => work.instruction,
      });
      releaseClaim.resolve();
      const first = await firstPromise;

      assert.equal(stopper.status, 'reconciled');
      assert.equal(stopper.stops[0]?.status, 'cancelled_before_runtime');
      assert.equal(first.status, 'reconciled');
      assert.equal(first.dispatches.length, 0);
      assert.equal(executor.backendInvocations, 0);
    } finally {
      releaseClaim.resolve();
      store.close();
    }
  });

  test('ignores unknown stop and replacement targets without poisoning later work', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(500) });
    const observation = new MemoryGraphObservation();
    const executor = new MemoryScheduleExecutor(store, observation);
    const stopController = new MemoryStopController(observation);
    try {
      await commitSchedule(store, 'tool-unknown-stop', {
        stop: [{ target_id: 'typo-target', reason: 'This target was mistyped.' }],
      });
      await commitSchedule(store, 'tool-add', {
        add_work: [
          {
            operator_id: 'writer',
            instruction: 'Continue despite stale supervisor references.',
            input_ids: [],
            replaces: 'missing-replacement-target',
          },
        ],
      });

      const result = await reconcileAgentGraphSchedule({
        topology: topology(),
        controlStore: store,
        executor,
        stopController,
        newId: nextId(),
        maxNewActivations: 1,
        observeGraph: () => observation.read(),
        renderPrompt: ({ work }) => work.instruction,
      });

      assert.equal(result.status, 'reconciled');
      assert.deepEqual(
        result.stops.map((stop) => [stop.targetId, stop.status]),
        [
          ['missing-replacement-target', 'ignored_unknown'],
          ['typo-target', 'ignored_unknown'],
        ],
      );
      assert.equal(result.failures.length, 0);
      assert.equal(result.dispatches.length, 1);
      assert.equal(executor.backendInvocations, 1);
    } finally {
      store.close();
    }
  });

  test('notifies a dispatch failure before slower siblings settle', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(600) });
    const observation = new MemoryGraphObservation();
    const baseExecutor = new MemoryScheduleExecutor(store, observation);
    const stopController = new MemoryStopController(observation);
    const slowStarted = deferred<void>();
    const releaseSlow = deferred<void>();
    const failureObserved = deferred<void>();
    let reconciliationSettled = false;
    try {
      await commitSchedule(store, 'tool-parallel-failure', {
        add_work: [
          {
            operator_id: 'writer',
            instruction: 'fail immediately',
            input_ids: [],
          },
          {
            operator_id: 'writer',
            instruction: 'settle slowly',
            input_ids: [],
          },
        ],
      });
      const executor: AgentGraphIntentExecutor = {
        async runClaimedAgentGraphIntent(input) {
          if (input.prompt === 'fail immediately') {
            throw new Error('fast dispatch failure');
          }
          slowStarted.resolve(undefined);
          await releaseSlow.promise;
          return baseExecutor.runClaimedAgentGraphIntent(input);
        },
      };

      const reconciliation = reconcileAgentGraphSchedule({
        topology: topology(),
        controlStore: store,
        executor,
        stopController,
        newId: nextId(),
        maxNewActivations: 2,
        observeGraph: () => observation.read(),
        renderPrompt: ({ work }) => work.instruction,
        supervisor: {
          onReconciliationFailure(failure) {
            assert.equal(failure.phase, 'dispatch');
            assert.match(String(failure.error), /fast dispatch failure/);
            failureObserved.resolve(undefined);
          },
        },
      }).finally(() => {
        reconciliationSettled = true;
      });

      await Promise.all([slowStarted.promise, failureObserved.promise]);
      assert.equal(reconciliationSettled, false);
      releaseSlow.resolve(undefined);
      const result = await reconciliation;
      assert.equal(result.status, 'failed');
      assert.equal(result.failures.length, 1);
      assert.equal(result.dispatches.length, 1);
    } finally {
      releaseSlow.resolve(undefined);
      store.close();
    }
  });

  test('retains a schedule commit that arrives before the next wave wait is installed', async () => {
    const wave = await gatedScheduleWave(2);
    const enteredStop = deferred();
    const releaseStop = deferred();
    let first = true;
    wave.beforeStop = async () => {
      if (!first) return;
      first = false;
      enteredStop.resolve();
      await releaseStop.promise;
    };
    try {
      await wave.commit('stop-first', {
        stop: [{ target_id: wave.workIds[0]!, reason: 'First target.' }],
      });
      await withTimeout(enteredStop.promise, 1000, 'first stop must start');
      // The reconciler is still awaiting the first stop, not waiting for a wake.
      await wave.commit('stop-second', {
        stop: [{ target_id: wave.workIds[1]!, reason: 'Second target.' }],
      });
      releaseStop.resolve();
      const result = await withTimeout(
        wave.reconciliation,
        1000,
        'the retained wake must stop the second child',
      );
      assert.equal(result.dispatches.length, 2);
      assert.equal(wave.executor.backendInvocations, 2);
      assert.deepEqual(
        result.dispatches.map((dispatch) => dispatch.result.status),
        ['cancelled', 'cancelled'],
      );
      assert.equal((await wave.store.listAgentGraphIntentClaims(GRAPH_ID)).length, 2);
      assert.equal(wave.subscriptions, 0);
    } finally {
      releaseStop.resolve();
      await wave.close();
    }
  });

  test('more than eight schedule wakes preserve the running wave and its single dispatch', async () => {
    const wave = await gatedScheduleWave(1);
    try {
      for (let index = 0; index < 12; index += 1) {
        const observed = wave.observations;
        await wave.commit(`wake-${index}`, {
          stop: [{ target_id: `unknown-target-${index}`, reason: 'An unrelated obsolete target.' }],
        });
        await waitFor(() => wave.observations > observed, { timeoutMs: 1000 });
        assert.equal(wave.settled, false, 'a normal wake cannot exhaust reconciliation retries');
        assert.equal(wave.executor.backendInvocations, 1);
      }
      await wave.commit('stop-running-work', {
        stop: [{ target_id: wave.workIds[0]!, reason: 'Now stop the running work.' }],
      });
      const result = await withTimeout(
        wave.reconciliation,
        1000,
        'the original wave must remain stoppable',
      );
      assert.equal(result.status, 'reconciled');
      assert.equal(result.newActivationCount, 1);
      assert.equal(result.dispatches.length, 1);
      assert.equal(result.dispatches[0]!.result.status, 'cancelled');
      assert.equal((await wave.store.listAgentGraphIntentClaims(GRAPH_ID)).length, 1);
      assert.equal(wave.executor.backendInvocations, 1);
      assert.equal(wave.subscriptions, 0);
    } finally {
      await wave.close();
    }
  });

  test('reports a stop failure while the wave is live and retries after a later revision', async () => {
    const wave = await gatedScheduleWave(1);
    const failureObserved = deferred();
    wave.beforeStop = async () => {
      throw new Error('temporary exact-stop failure');
    };
    wave.onFailure = () => failureObserved.resolve();
    try {
      await wave.commit('failing-stop', {
        stop: [{ target_id: wave.workIds[0]!, reason: 'First stop attempt.' }],
      });
      await withTimeout(
        failureObserved.promise,
        1000,
        'stop failure must be visible before child completion',
      );
      assert.equal(wave.settled, false);
      assert.equal(wave.failures[0]?.phase, 'stop');
      assert.equal(wave.executor.backendInvocations, 1);
      wave.beforeStop = undefined;
      await wave.commit('retry-stop', {
        stop: [{ target_id: wave.workIds[0]!, reason: 'Retry after the stop service recovered.' }],
      });
      const result = await withTimeout(
        wave.reconciliation,
        1000,
        'later revision must retry the exact stop',
      );
      assert.equal(result.dispatches.length, 1);
      assert.equal(result.dispatches[0]!.result.status, 'cancelled');
      assert.equal(wave.failures.length, 1, 'the observer must retain the failure notification');
      assert.equal(result.status, 'reconciled');
      assert.equal(result.failures.length, 0, 'successful stop retry clears the obsolete failure');
      const recovered = await wave.reconcileAgain();
      assert.equal(recovered.status, 'reconciled');
      assert.equal(recovered.failures.length, 0);
      assert.equal(recovered.dispatches.length, 0);
      assert.equal(wave.executor.backendInvocations, 1);
    } finally {
      await wave.close();
    }
  });

  test('retries exact stop cleanup after the activation already has a terminal observation', async () => {
    const wave = await gatedScheduleWave(1);
    const failureObserved = deferred();
    let stopAttempts = 0;
    wave.beforeStop = async () => {
      stopAttempts += 1;
      if (stopAttempts === 1) {
        wave.markTerminalWithoutCompleting();
        throw new Error('terminal committed but exact-stop cleanup failed');
      }
    };
    wave.onFailure = () => failureObserved.resolve();
    try {
      await wave.commit('terminal-cleanup-failure', {
        stop: [{ target_id: wave.workIds[0]!, reason: 'Stop and settle this activation.' }],
      });
      await withTimeout(
        failureObserved.promise,
        1000,
        'cleanup failure must be reported while the terminal activation still owns its wave',
      );
      assert.equal(wave.settled, false);
      assert.equal(stopAttempts, 1);
      assert.equal(wave.failures[0]?.phase, 'stop');
      await wave.commit('retry-terminal-cleanup', {
        stop: [
          {
            target_id: wave.workIds[0]!,
            reason: 'Retry cleanup for the same terminal activation.',
          },
        ],
      });
      const result = await withTimeout(
        wave.reconciliation,
        1000,
        'terminal observation must not bypass the exact-stop cleanup retry',
      );
      assert.ok(stopAttempts >= 2);
      assert.equal(result.status, 'reconciled');
      assert.equal(result.failures.length, 0);
      assert.equal(result.dispatches.length, 1);
      assert.equal(result.dispatches[0]!.result.status, 'cancelled');
      assert.equal(result.newActivationCount, 1);
      assert.equal((await wave.store.listAgentGraphIntentClaims(GRAPH_ID)).length, 1);
      assert.equal(wave.executor.backendInvocations, 1);
      assert.equal(wave.subscriptions, 0);
    } finally {
      await wave.close();
    }
  });

  test('a transient control read failure leaves the wave stoppable on a later schedule wake', async () => {
    const wave = await gatedScheduleWave(1);
    const failureObserved = deferred();
    wave.onFailure = () => failureObserved.resolve();
    try {
      wave.failNextControlRead(new Error('temporary schedule read failure'));
      await wave.commit('read-failure-stop', {
        stop: [{ target_id: wave.workIds[0]!, reason: 'Stop during a transient read failure.' }],
      });
      await withTimeout(
        failureObserved.promise,
        1000,
        'control read failure must be reported while the child remains gated',
      );
      assert.equal(wave.settled, false);
      assert.equal(wave.failures.length, 1);
      assert.match(String(wave.failures[0]!.error), /temporary schedule read failure/);
      assert.equal(wave.executor.backendInvocations, 1);
      await wave.commit('read-recovered-stop', {
        stop: [{ target_id: wave.workIds[0]!, reason: 'Retry after schedule reads recover.' }],
      });
      const result = await withTimeout(
        wave.reconciliation,
        1000,
        'a recovered control read must cancel the original live wave',
      );
      assert.equal(result.status, 'reconciled');
      assert.equal(result.failures.length, 0);
      assert.equal(result.dispatches.length, 1);
      assert.equal(result.dispatches[0]!.result.status, 'cancelled');
      assert.equal(result.newActivationCount, 1);
      assert.equal((await wave.store.listAgentGraphIntentClaims(GRAPH_ID)).length, 1);
      assert.equal(wave.executor.backendInvocations, 1);
      assert.equal(wave.subscriptions, 0);
    } finally {
      await wave.close();
    }
  });

  test('mid-wave wakes do not stop an activation this reconciliation already stopped', async () => {
    const wave = await gatedScheduleWave(2);
    try {
      await wave.commit('stop-first', {
        stop: [{ target_id: wave.workIds[0]!, reason: 'Only the first branch is obsolete.' }],
      });
      await waitFor(() => wave.stopCalls === 1, { timeoutMs: 1000 });
      for (let index = 0; index < 3; index += 1) {
        const observed = wave.observations;
        await wave.commit(`unrelated-wake-${index}`, {
          stop: [{ target_id: `unknown-target-${index}`, reason: 'An unrelated target.' }],
        });
        await waitFor(() => wave.observations > observed, { timeoutMs: 1000 });
      }
      assert.equal(wave.stopCalls, 1, 'a settled stop target must not be stopped on every wake');
      await wave.commit('stop-second', {
        stop: [{ target_id: wave.workIds[1]!, reason: 'Now the second branch is obsolete.' }],
      });
      const result = await withTimeout(wave.reconciliation, 1000, 'second stop must settle');
      assert.equal(wave.stopCalls, 2);
      assert.equal(result.status, 'reconciled');
      assert.deepEqual(
        result.dispatches.map((dispatch) => dispatch.result.status),
        ['cancelled', 'cancelled'],
      );
    } finally {
      await wave.close();
    }
  });

  test('retries a failed stop while its wave is parked without another schedule wake', async () => {
    const wave = await gatedScheduleWave(1);
    let attempts = 0;
    wave.beforeStop = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient exact-stop failure');
    };
    try {
      await wave.commit('stop-once', {
        stop: [{ target_id: wave.workIds[0]!, reason: 'Stop despite one cleanup failure.' }],
      });
      const result = await withTimeout(
        wave.reconciliation,
        2000,
        'a failed stop must be retried while it parks the only running wave',
      );
      assert.equal(attempts, 2);
      assert.equal(result.status, 'reconciled');
      assert.equal(result.failures.length, 0);
      assert.equal(result.dispatches[0]!.result.status, 'cancelled');
      assert.equal(wave.failures.length, 1);
      assert.equal(wave.subscriptions, 0);
    } finally {
      await wave.close();
    }
  });

  test('reports a persistently failing stop once as stuck and clears it when the stop succeeds', async (t) => {
    const wave = await gatedScheduleWave(1);
    let failing = true;
    let attempts = 0;
    wave.beforeStop = async () => {
      attempts += 1;
      if (failing) throw new Error(`exact-stop failure ${attempts}`);
    };
    // Real backoff reaches its 5 s cap before the eighth failure; drive it with
    // mocked timers and real setImmediate turns for the in-memory store.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const flush = async () => {
      for (let turn = 0; turn < 3; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    const advanceToAttempt = async (target: number) => {
      await flush();
      while (attempts < target) {
        t.mock.timers.tick(5_000);
        await flush();
      }
    };
    try {
      await wave.commit('stuck-stop', {
        stop: [{ target_id: wave.workIds[0]!, reason: 'Stop although cleanup keeps failing.' }],
      });
      await advanceToAttempt(7);
      assert.equal(wave.failures.length, 1, 'retries before the threshold stay silent');
      assert.doesNotMatch(String(wave.failures[0]!.error), /is stuck/);

      await advanceToAttempt(8);
      assert.equal(wave.failures.length, 2);
      assert.equal(wave.failures[1]!.phase, 'stop');
      assert.match(String(wave.failures[1]!.error), /is stuck after 8 consecutive failures/);

      await advanceToAttempt(12);
      assert.equal(wave.failures.length, 2, 'a stuck stop is reported once, not on every retry');
      assert.equal(wave.settled, false, 'the stop is still retried, never dropped');

      failing = false;
      await advanceToAttempt(13);
      await flush();
      assert.equal(wave.settled, true);
      const result = await wave.reconciliation;
      assert.equal(result.status, 'reconciled');
      assert.equal(result.failures.length, 0, 'a later success clears the stuck failure');
      assert.equal(result.dispatches[0]!.result.status, 'cancelled');
      assert.equal(wave.failures.length, 2);
    } finally {
      t.mock.timers.reset();
      await wave.close();
    }
  });

  test('reports a persistently failing control read once as stuck and clears it when reads recover', async (t) => {
    const wave = await gatedScheduleWave(1);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const flush = async () => {
      for (let turn = 0; turn < 3; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    const base = wave.controlReads;
    const advanceToRead = async (target: number) => {
      await flush();
      while (wave.controlReads - base < target) {
        t.mock.timers.tick(5_000);
        await flush();
      }
    };
    try {
      wave.failControlReads(new Error('schedule read failure'));
      await wave.commit('stuck-read', {
        stop: [
          { target_id: wave.workIds[0]!, reason: 'Stop although control reads keep failing.' },
        ],
      });
      await advanceToRead(7);
      assert.equal(wave.failures.length, 1, 'read retries before the threshold stay silent');
      assert.equal(wave.failures[0]!.phase, 'schedule');
      assert.doesNotMatch(String(wave.failures[0]!.error), /is stuck/);

      await advanceToRead(8);
      assert.equal(wave.failures.length, 2);
      assert.equal(wave.failures[1]!.phase, 'schedule');
      assert.match(String(wave.failures[1]!.error), /is stuck after 8 consecutive failures/);

      await advanceToRead(12);
      assert.equal(wave.failures.length, 2, 'a stuck read is reported once, not on every retry');
      assert.equal(wave.settled, false);

      wave.failControlReads(undefined);
      await advanceToRead(13);
      await flush();
      assert.equal(wave.settled, true);
      const result = await wave.reconciliation;
      assert.equal(result.status, 'reconciled');
      assert.equal(result.failures.length, 0, 'a recovered read clears the stuck failure');
      assert.equal(result.dispatches[0]!.result.status, 'cancelled');
    } finally {
      t.mock.timers.reset();
      await wave.close();
    }
  });

  test('a driver abort keeps retrying a failed stop until its parked wave settles', async () => {
    const wave = await gatedScheduleWave(1);
    let attempts = 0;
    const failed = deferred();
    wave.beforeStop = async () => {
      attempts += 1;
      if (attempts <= 2) {
        failed.resolve();
        throw new Error('transient exact-stop failure');
      }
    };
    try {
      await wave.commit('stop-then-abort', {
        stop: [{ target_id: wave.workIds[0]!, reason: 'Stop while the driver is aborting.' }],
      });
      await withTimeout(failed.promise, 1000, 'first stop attempt must fail');
      wave.abortDriver();
      const result = await withTimeout(
        wave.reconciliation,
        2000,
        'an aborted driver must not stop retrying the stop that parks its wave',
      );
      assert.equal(attempts, 3);
      assert.equal(result.status, 'cancelled');
      assert.equal(result.failures.length, 0);
      assert.equal(result.dispatches[0]!.result.status, 'cancelled');
    } finally {
      await wave.close();
    }
  });
});

const GRAPH_ID = 'graph-schedule';

function historicalRecord(): AgentGraphRecord {
  return {
    schemaVersion: 1,
    recordId: 'record-historical-result',
    graphId: 'graph-previous',
    operatorId: 'historical-writer',
    activationId: 'historical-run',
    sessionId: 'session-historical-writer',
    agentRunId: 'historical-run',
    eventTime: 1,
    orderKey: {
      runCreatedAt: 1,
      operatorId: 'historical-writer',
      runId: 'historical-run',
      committedEventOrdinal: 0,
      runtimeEventId: 'historical-event',
    },
    type: 'agent_runtime_event',
    facets: ['message'],
    supervisorSignals: [],
    source: {
      kind: 'runtime_event',
      runtimeEventId: 'historical-event',
      sessionId: 'session-historical-writer',
      runId: 'historical-run',
      turnId: 'historical-turn',
      ts: 1,
    },
  };
}

function topology(): AgentGraphTraceTopology {
  return {
    graphId: GRAPH_ID,
    operators: [{ operatorId: 'writer', sessionId: 'session-writer' }],
    edges: [],
  };
}

async function commitSchedule(
  store: AgentGraphScheduleControlStore,
  toolCallId: string,
  input: UpdateAgentGraphToolInput,
): Promise<AgentGraphScheduleUpdateRequest> {
  const request = compileAgentGraphScheduleUpdate({
    graphId: GRAPH_ID,
    input,
    context: {
      sessionId: 'session-main',
      runId: 'run-main',
      turnId: 'turn-main',
      toolCallId,
    },
  });
  await store.commitAgentGraphScheduleUpdate(request);
  return request;
}

function controlStoreWithProvisions(
  store: AgentGraphScheduleControlStore,
  provisions: AgentGraphOperatorProvision[],
): AgentGraphScheduleControlStore {
  return {
    commitAgentGraphScheduleUpdate: (request) => store.commitAgentGraphScheduleUpdate(request),
    listAgentGraphScheduleUpdates: (graphId) => store.listAgentGraphScheduleUpdates(graphId),
    listAgentGraphOperatorProvisions: async (graphId) =>
      provisions
        .filter((provision) => provision.graphId === graphId)
        .map((provision) => structuredClone(provision)),
    claimAgentGraphIntent: (request) => store.claimAgentGraphIntent(request),
    readAgentGraphIntentClaim: (graphId, intentId) =>
      store.readAgentGraphIntentClaim(graphId, intentId),
    listAgentGraphIntentClaims: (graphId) => store.listAgentGraphIntentClaims(graphId),
    claimAgentGraphIntentAtScheduleRevision: (request, expectedRevision) =>
      store.claimAgentGraphIntentAtScheduleRevision(request, expectedRevision),
    beginAgentGraphIntentExecutionAtScheduleRevision: (graphId, intentId, expectedRevision) =>
      store.beginAgentGraphIntentExecutionAtScheduleRevision(graphId, intentId, expectedRevision),
    cancelAgentGraphIntentExecution: (graphId, intentId, reason) =>
      store.cancelAgentGraphIntentExecution(graphId, intentId, reason),
  };
}

async function gatedScheduleWave(count: number) {
  const store = createSqliteSessionMetadataStore(':memory:');
  const observation = new MemoryGraphObservation();
  const executor = new MemoryScheduleExecutor(store, observation, 'running');
  type Identity = Parameters<AgentGraphScheduleStopController['stopAgentGraphActivation']>[0];
  const active = new Map<
    string,
    { identity: Identity; gate: ReturnType<typeof deferred<void>>; cancelled: boolean }
  >();
  const listeners = new Set<() => void>();
  const state = {
    beforeStop: undefined as (() => Promise<void>) | undefined,
    onFailure: undefined as (() => void) | undefined,
    failures: [] as Array<{ phase: string; error: unknown }>,
    observations: 0,
    settled: false,
    readFailure: undefined as Error | undefined,
    persistentReadFailure: undefined as Error | undefined,
    controlReads: 0,
    stopCalls: 0,
    // Models the runtime's retained cleanup owner after a failed exact stop.
    retainedStops: new Set<string>(),
    driver: new AbortController(),
  };
  const added = await commitSchedule(store, 'initial-wave', {
    add_work: Array.from({ length: count }, (_, index) => ({
      operator_id: 'writer',
      instruction: `Gated work ${index}.`,
      input_ids: [],
    })),
  });
  const controlStore = new Proxy(store, {
    get(target, property) {
      if (property === 'listAgentGraphScheduleUpdates') {
        return async (graphId: string) => {
          state.controlReads += 1;
          if (state.readFailure) {
            const error = state.readFailure;
            state.readFailure = undefined;
            throw error;
          }
          if (state.persistentReadFailure) throw state.persistentReadFailure;
          return target.listAgentGraphScheduleUpdates(graphId);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const input = {
    topology: topology(),
    controlStore,
    executor: {
      async runClaimedAgentGraphIntent(
        request: Parameters<AgentGraphIntentExecutor['runClaimedAgentGraphIntent']>[0],
      ) {
        const result = await executor.runClaimedAgentGraphIntent(request);
        const current = {
          identity: {
            sessionId: result.childSessionId,
            runId: result.runId,
            turnId: result.turnId,
          },
          gate: deferred<void>(),
          cancelled: false,
        };
        active.set(result.runId, current);
        await current.gate.promise;
        const status = current.cancelled ? ('cancelled' as const) : ('completed' as const);
        observation.setActivation(result.childSessionId, result.runId, status, result.turnId);
        return { ...result, status };
      },
    },
    stopController: {
      async stopAgentGraphActivation(identity: Identity) {
        state.stopCalls += 1;
        try {
          await state.beforeStop?.();
        } catch (error) {
          state.retainedStops.add(identity.runId);
          throw error;
        }
        state.retainedStops.delete(identity.runId);
        const current = active.get(identity.runId);
        assert.ok(current, 'stop must address an existing exact activation');
        assert.deepEqual(identity, current.identity);
        observation.stopActivation(identity);
        current.cancelled = true;
        current.gate.resolve();
      },
      hasPendingAgentGraphActivationStop(identity: Identity) {
        return state.retainedStops.has(identity.runId);
      },
    },
    newId: nextId(),
    maxNewActivations: count,
    abortSignal: state.driver.signal,
    observeGraph: async () => {
      state.observations += 1;
      return observation.read();
    },
    renderPrompt: ({ work }: RenderAgentGraphScheduledWorkPromptInput) => work.instruction,
    subscribeToScheduleChanges(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    supervisor: {
      onReconciliationFailure(failure: { phase: string; error: unknown }) {
        state.failures.push(failure);
        state.onFailure?.();
      },
    },
  };
  const reconciliation = reconcileAgentGraphSchedule(input).finally(() => {
    state.settled = true;
  });
  await waitFor(() => active.size === count, { timeoutMs: 1000 });
  return {
    store,
    executor,
    reconciliation,
    workIds: added.addWork.map((work) => work.workId),
    get beforeStop() {
      return state.beforeStop;
    },
    set beforeStop(value) {
      state.beforeStop = value;
    },
    get onFailure() {
      return state.onFailure;
    },
    set onFailure(value) {
      state.onFailure = value;
    },
    get failures() {
      return state.failures;
    },
    get observations() {
      return state.observations;
    },
    get settled() {
      return state.settled;
    },
    get stopCalls() {
      return state.stopCalls;
    },
    abortDriver() {
      state.driver.abort();
    },
    get subscriptions() {
      return listeners.size;
    },
    async commit(toolCallId: string, update: UpdateAgentGraphToolInput) {
      await commitSchedule(store, toolCallId, update);
      for (const listener of listeners) listener();
    },
    markTerminalWithoutCompleting() {
      assert.equal(active.size, 1, 'this cleanup control owns one exact activation');
      for (const current of active.values()) {
        observation.stopActivation(current.identity);
        current.cancelled = true;
      }
      // Keep the completion gate closed until a later exact-stop attempt succeeds.
    },
    failNextControlRead(error: Error) {
      state.readFailure = error;
    },
    /** Fail every control read until called without an error. */
    failControlReads(error: Error | undefined) {
      state.persistentReadFailure = error;
    },
    get controlReads() {
      return state.controlReads;
    },
    reconcileAgain: () => reconcileAgentGraphSchedule(input),
    async close() {
      state.beforeStop = undefined;
      for (const current of active.values()) current.gate.resolve();
      await reconciliation;
      store.close();
    },
  };
}

class MemoryGraphObservation {
  private readonly activations = new Map<
    string,
    {
      sessionId: string;
      turnId: string;
      status: 'running' | 'completed' | 'cancelled';
    }
  >();

  setActivation(
    sessionId: string,
    activationId: string,
    status: 'running' | 'completed' | 'cancelled',
    turnId: string,
  ): void {
    this.activations.set(activationId, { sessionId, turnId, status });
  }

  stopActivation(
    identity: Parameters<AgentGraphScheduleStopController['stopAgentGraphActivation']>[0],
  ): void {
    const activation = this.activations.get(identity.runId);
    if (!activation) return;
    assert.equal(activation.sessionId, identity.sessionId);
    assert.equal(activation.turnId, identity.turnId);
    if (activation.status === 'running') {
      this.activations.set(identity.runId, { ...activation, status: 'cancelled' });
    }
  }

  async read(
    currentTopology: AgentGraphTraceTopology = topology(),
  ): Promise<AgentGraphSupervisorObservation> {
    const operatorStates = Object.fromEntries(
      currentTopology.operators.flatMap((binding) => {
        const activationEntries = [...this.activations]
          .filter(([, activation]) => activation.sessionId === binding.sessionId)
          .map(([activationId, activation]) => [
            activationId,
            {
              activationId,
              agentRunId: activationId,
              status: activation.status,
              recordCount: 1,
              firstEventTime: 1,
              lastEventTime: 2,
              lastRecordId: `record-${activationId}`,
              ...(activation.status === 'running'
                ? {}
                : { terminalRecordId: `record-${activationId}` }),
            },
          ]);
        const current = activationEntries.at(-1)?.[0] as string | undefined;
        return current
          ? [
              [
                binding.operatorId,
                {
                  operatorId: binding.operatorId,
                  sessionId: binding.sessionId,
                  status: this.activations.get(current)!.status,
                  currentActivationId: current,
                  activations: Object.fromEntries(activationEntries),
                },
              ],
            ]
          : [];
      }),
    );
    return structuredClone({
      projection: {
        graphId: GRAPH_ID,
        operators: currentTopology.operators.map((operator) => ({ ...operator })),
        ignoredPartialEvents: 0,
        records: [
          ...[...this.activations].map(([activationId, activation]): AgentGraphRecord => {
            const binding = currentTopology.operators.find(
              (operator) => operator.sessionId === activation.sessionId,
            )!;
            return {
              schemaVersion: 1,
              recordId: `record-${activationId}`,
              graphId: GRAPH_ID,
              operatorId: binding.operatorId,
              activationId,
              sessionId: activation.sessionId,
              agentRunId: activationId,
              eventTime: 2,
              orderKey: {
                runCreatedAt: 1,
                operatorId: binding.operatorId,
                runId: activationId,
                committedEventOrdinal: 0,
                runtimeEventId: `event-${activationId}`,
              },
              type: 'agent_runtime_event',
              facets: ['message'],
              supervisorSignals: [],
              source: {
                kind: 'runtime_event',
                runtimeEventId: `event-${activationId}`,
                sessionId: activation.sessionId,
                runId: activationId,
                turnId: activation.turnId,
                ts: 2,
              },
            };
          }),
          {
            schemaVersion: 1,
            recordId: 'record-input',
            graphId: GRAPH_ID,
            operatorId: 'writer',
            activationId: 'run-input',
            sessionId: 'session-writer',
            agentRunId: 'run-input',
            eventTime: 1,
            orderKey: {
              runCreatedAt: 1,
              operatorId: 'writer',
              runId: 'run-input',
              committedEventOrdinal: 0,
              runtimeEventId: 'event-input',
            },
            type: 'agent_runtime_event',
            facets: ['message'],
            supervisorSignals: [],
            source: {
              kind: 'runtime_event',
              runtimeEventId: 'event-input',
              sessionId: 'session-writer',
              runId: 'run-input',
              turnId: 'turn-input',
              ts: 1,
            },
          },
        ],
        supervisorMetaStream: [],
        state: {
          graphId: GRAPH_ID,
          appliedRecordIds: ['record-input'],
          operators: operatorStates,
        },
      },
      readiness: {
        schemaVersion: 1,
        graphId: GRAPH_ID,
        topologyFingerprint: `sha256:${'a'.repeat(64)}`,
        trace: {
          schemaVersion: 1,
          graphId: GRAPH_ID,
          topologyFingerprint: `sha256:${'a'.repeat(64)}`,
          topologicalOrder: currentTopology.operators.map((operator) => operator.operatorId),
          rootOperatorIds: ['writer'],
          sinkOperatorIds: ['writer'],
          recordIds: ['record-input'],
          operators: {},
          edges: {},
          routes: [],
        },
        readiness: {},
        supervisorView: [],
      },
      claims: [],
    } as AgentGraphSupervisorObservation);
  }
}

class MemoryScheduleExecutor implements AgentGraphIntentExecutor {
  backendInvocations = 0;
  lastPrompt?: string;
  private readonly results = new Map<
    string,
    Awaited<ReturnType<AgentGraphIntentExecutor['runClaimedAgentGraphIntent']>>
  >();

  constructor(
    private readonly claims: AgentGraphIntentClaimStore,
    private readonly observation: MemoryGraphObservation,
    private readonly status: 'running' | 'completed' = 'completed',
  ) {}

  async runClaimedAgentGraphIntent(
    input: Parameters<AgentGraphIntentExecutor['runClaimedAgentGraphIntent']>[0],
  ): ReturnType<AgentGraphIntentExecutor['runClaimedAgentGraphIntent']> {
    const existing = this.results.get(input.intentId);
    if (existing) return existing;
    if (input.admitExecution && (await input.admitExecution()) === 'cancelled') {
      throw new Error('schedule execution cancelled before runtime admission');
    }
    const claim = await this.claims.readAgentGraphIntentClaim(input.graphId, input.intentId);
    if (!claim) throw new Error('missing schedule claim');
    if (
      claim.graphId !== input.intent.graphId ||
      claim.intentId !== input.intent.intentId ||
      claim.readinessContextFingerprint !== input.intent.readinessContextFingerprint ||
      claim.targetOperatorId !== input.intent.operatorId ||
      claim.targetSessionId !== input.intent.targetSessionId ||
      claim.intentFingerprint !==
        fingerprintAgentGraphRunnableIntent({
          intent: input.intent,
          executionInput: { prompt: input.prompt },
        })
    ) {
      throw new Error('scheduled graph execution does not match its durable claim');
    }
    this.lastPrompt = input.prompt;
    this.backendInvocations += 1;
    this.observation.setActivation(
      claim.targetSessionId,
      claim.targetRunId,
      this.status,
      claim.targetTurnId,
    );
    await input.onReady?.({
      claimId: claim.claimId,
      graphId: claim.graphId,
      intentId: claim.intentId,
      operatorId: claim.targetOperatorId,
      childSessionId: claim.targetSessionId,
      turnId: claim.targetTurnId,
      runId: claim.targetRunId,
      agentId: 'local-read',
      agentName: 'Local Read',
    });
    const result = {
      claimId: claim.claimId,
      graphId: claim.graphId,
      intentId: claim.intentId,
      operatorId: claim.targetOperatorId,
      childSessionId: claim.targetSessionId,
      turnId: claim.targetTurnId,
      runId: claim.targetRunId,
      agentId: 'local-read',
      agentName: 'Local Read',
      profile: 'local_read',
      status: this.status,
      permissionMode: 'explore' as const,
      summary: this.status,
      artifactIds: [],
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      eventCount: 1,
    };
    this.results.set(input.intentId, result);
    return result;
  }
}

class MemoryStopController {
  readonly calls: Array<{
    sessionId: string;
    runId: string;
    turnId: string;
    source: 'graph_supervisor';
  }> = [];

  constructor(private readonly observation: MemoryGraphObservation) {}

  async stopAgentGraphActivation(
    identity: Parameters<AgentGraphScheduleStopController['stopAgentGraphActivation']>[0],
    input: { source: 'graph_supervisor' },
  ): Promise<void> {
    this.calls.push({ ...identity, source: input.source });
    this.observation.stopActivation(identity);
  }
}
function nextNumber(start: number): () => number {
  let value = start;
  return () => value++;
}
