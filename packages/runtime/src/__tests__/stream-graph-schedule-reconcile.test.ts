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
import type {
  AgentGraphScheduleControlStore,
  AgentGraphScheduleUpdateRequest,
} from '@maka/core/agent-graph-schedule';
import type { AgentGraphIntentClaimStore } from '@maka/core/agent-graph-control';
import type { AgentGraphOperatorProvision } from '@maka/core/agent-graph-topology';
import type { SessionHeader } from '@maka/core/session';
import { createSqliteSessionMetadataStore } from '@maka/storage';
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
        { sessionId: 'session-writer', source: 'graph_supervisor' },
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

class MemoryGraphObservation {
  private readonly activations = new Map<
    string,
    {
      sessionId: string;
      status: 'running' | 'completed' | 'cancelled';
    }
  >();

  setActivation(
    sessionId: string,
    activationId: string,
    status: 'running' | 'completed' | 'cancelled',
  ): void {
    this.activations.set(activationId, { sessionId, status });
  }

  stopSession(sessionId: string): void {
    for (const [activationId, activation] of this.activations) {
      if (activation.sessionId === sessionId && activation.status === 'running') {
        this.activations.set(activationId, { ...activation, status: 'cancelled' });
      }
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
    this.observation.setActivation(claim.targetSessionId, claim.targetRunId, this.status);
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
  readonly calls: Array<{ sessionId: string; source: 'graph_supervisor' }> = [];

  constructor(private readonly observation: MemoryGraphObservation) {}

  async stopSession(sessionId: string, input: { source: 'graph_supervisor' }): Promise<void> {
    this.calls.push({ sessionId, source: input.source });
    this.observation.stopSession(sessionId);
  }
}

function nextId(): () => string {
  let value = 0;
  return () => `schedule-id-${++value}`;
}

function nextNumber(start: number): () => number {
  let value = start;
  return () => value++;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
