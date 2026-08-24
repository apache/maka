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
import { createSqliteSessionMetadataStore } from '@maka/storage';
import type { AgentGraphSupervisorObservation } from '../stream-graph-dispatch.js';
import type { MakaToolContext } from '../tool-runtime.js';
import {
  UPDATE_AGENT_GRAPH_TOOL_NAME,
  VIEW_AGENT_GRAPH_TOOL_NAME,
  YIELD_AGENT_GRAPH_TOOL_NAME,
  buildAgentGraphSupervisorTools,
  projectAgentGraphSchedule,
} from '../stream-graph-supervisor-tools.js';

describe('stream graph supervisor tools', () => {
  test('exposes compact read, durable update, and cooperative yield tools', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(100) });
    const [viewTool, updateTool, yieldTool] = buildAgentGraphSupervisorTools({
      graphId: 'graph-supervised',
      scheduleStore: store,
      observeGraph: async () => observationWithRecords('graph-supervised', ['verified-result']),
      listHistoricalSelectedResults: async () => ({
        results: [{ sourceGraphId: 'graph-previous', resultId: 'selected-result' }],
        nextBeforeEpoch: null,
      }),
    });
    try {
      assert.equal(viewTool.name, VIEW_AGENT_GRAPH_TOOL_NAME);
      assert.equal(updateTool.name, UPDATE_AGENT_GRAPH_TOOL_NAME);
      assert.equal(yieldTool.name, YIELD_AGENT_GRAPH_TOOL_NAME);
      assert.equal(viewTool.recoveryMode, 'replay_safe');
      assert.equal(updateTool.recoveryMode, 'idempotent');
      assert.equal(yieldTool.recoveryMode, 'replay_safe');
      assert.equal(yieldTool.nesting, 'direct_only');

      await assert.rejects(
        async () =>
          await yieldTool.impl(
            { reason: 'Nothing has been scheduled.' },
            toolContext('yield-empty'),
          ),
        /no pending scheduled work/,
      );

      const firstInput = {
        add_work: [
          {
            agent_id: 'fact-checker',
            instruction: 'Verify the conflicting figures.',
            input_ids: ['result-b', 'result-a'],
            selected_result_inputs: [
              { source_graph_id: 'graph-previous', result_id: 'selected-result' },
            ],
          },
          {
            operator_id: 'writer',
            instruction: 'Prepare a follow-up explanation.',
            input_ids: ['result-a'],
          },
        ],
      };
      const first = await updateTool.impl(firstInput, toolContext('tool-1'));
      const retry = await updateTool.impl(firstInput, toolContext('tool-1'));
      assert.deepEqual(retry, first);
      assert.equal((await store.listAgentGraphScheduleUpdates('graph-supervised')).length, 1);
      assert.deepEqual(first.schedule.work[0]?.inputIds, ['result-a', 'result-b']);
      assert.deepEqual(first.schedule.work[0]?.selectedResultInputs, [
        { sourceGraphId: 'graph-previous', resultId: 'selected-result' },
      ]);
      assert.deepEqual(first.historicalSelectedResults, [
        { sourceGraphId: 'graph-previous', resultId: 'selected-result' },
      ]);
      assert.equal(first.nextHistoricalBeforeEpoch, null);
      assert.equal(first.runtime.operators[0]?.status, 'running');
      assert.equal(first.runtime.operators[0]?.childSessionId, 'session-writer');
      assert.equal(first.runtime.operators[0]?.currentRunId, 'run-writer');
      assert.deepEqual(first.runtime.readiness[0]?.waitingFor, [
        { kind: 'input_route', upstreamOperatorIds: ['researcher'] },
      ]);
      assert.doesNotMatch(JSON.stringify(first), /graph-supervised|updateId|"revision"/);
      assert.deepEqual(
        await yieldTool.impl(
          { reason: 'The scheduled operators are still executing.' },
          toolContext('yield-running'),
        ),
        {
          kind: 'agent_graph_yielded',
          pendingWorkCount: 2,
          liveOperatorCount: 1,
          reason: 'The scheduled operators are still executing.',
        },
      );

      const [firstWork, secondWork] = first.schedule.work;
      assert.ok(firstWork);
      assert.ok(secondWork);
      const second = await updateTool.impl(
        {
          add_work: [
            {
              operator_id: 'fact-checker',
              instruction: 'Recheck the figures against primary filings.',
              input_ids: ['result-a', 'result-b'],
              replaces: firstWork.workId,
            },
          ],
          stop: [{ target_id: secondWork.workId, reason: 'The explanation is premature.' }],
        },
        toolContext('tool-2'),
      );
      assert.equal(
        (await store.listAgentGraphScheduleUpdates('graph-supervised')).at(-1)?.revision,
        2,
      );
      assert.deepEqual(
        second.schedule.work.map((work) => work.status),
        ['requested', 'superseded', 'stopped'],
      );

      const thirdWork = second.schedule.work.find((work) => work.status === 'requested');
      assert.ok(thirdWork);
      await assert.rejects(
        async () =>
          await updateTool.impl(
            {
              finish: {
                result_ids: ['does-not-exist'],
                reason: 'This typo must not close the graph.',
              },
            },
            toolContext('tool-invalid-finish'),
          ),
        /not committed graph records/,
      );
      assert.equal((await store.listAgentGraphScheduleUpdates('graph-supervised')).length, 2);
      assert.equal(
        (await viewTool.impl({}, toolContext('tool-view-before-finish'))).schedule.closed,
        false,
      );
      const finished = await updateTool.impl(
        {
          stop: [{ target_id: thirdWork.workId, reason: 'Verification is complete.' }],
          finish: {
            result_ids: ['verified-result'],
            reason: 'Use the verified result as the final answer.',
          },
        },
        toolContext('tool-3'),
      );
      assert.equal(
        (await store.listAgentGraphScheduleUpdates('graph-supervised')).at(-1)?.revision,
        3,
      );
      assert.equal(finished.schedule.closed, true);
      assert.deepEqual(finished.schedule.finish?.resultIds, ['verified-result']);
      await assert.rejects(
        async () => await yieldTool.impl({ reason: 'Already done.' }, toolContext('yield-closed')),
        /already finished/,
      );

      const viewed = await viewTool.impl({}, toolContext('tool-view'));
      assert.deepEqual(viewed.schedule, finished.schedule);
      const providerFilledLatest = await viewTool.impl(
        { mode: 'latest', cursor: 'provider-placeholder' },
        toolContext('tool-view-provider-filled'),
      );
      assert.deepEqual(providerFilledLatest.schedule, finished.schedule);
      await assert.rejects(
        async () =>
          updateTool.impl(
            {
              add_work: [
                {
                  agent_id: 'researcher',
                  instruction: 'Start work after the graph is finished.',
                  input_ids: [],
                },
              ],
            },
            toolContext('tool-4'),
          ),
        /already finished/,
      );
    } finally {
      store.close();
    }
  });

  test('keeps graph identity and idempotency fields out of the model-facing update schema', () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    const [, updateTool] = buildAgentGraphSupervisorTools({
      graphId: 'graph-supervised',
      scheduleStore: store,
      observeGraph: async () => observationWithRecords('graph-supervised'),
    });
    try {
      const schema = updateTool.parameters as {
        safeParse(value: unknown): { success: boolean; data?: Record<string, unknown> };
      };
      assert.equal(schema.safeParse({}).success, false);
      assert.equal(
        schema.safeParse({
          add_work: [{ agent_id: 'researcher', instruction: 'Defaults to no input ids.' }],
        }).success,
        true,
      );
      assert.equal(
        schema.safeParse({
          add_work: [
            {
              agent_id: 'researcher',
              operator_id: 'existing',
              instruction: 'Ambiguous target.',
              input_ids: [],
            },
          ],
        }).success,
        false,
      );
      const forgedIdentity = schema.safeParse({
        graph_id: 'forged-graph',
        add_work: [
          {
            agent_id: 'researcher',
            instruction: 'Try to escape the bound graph.',
            input_ids: [],
          },
        ],
      });
      assert.equal(forgedIdentity.success, true);
      assert.equal(forgedIdentity.data?.graph_id, undefined);
      assert.equal(
        schema.safeParse({
          add_work: [
            {
              agent_id: 'researcher',
              instruction: 'Cannot add work while finishing.',
              input_ids: [],
            },
          ],
          finish: { result_ids: ['result-1'], reason: 'Done.' },
        }).success,
        false,
      );
    } finally {
      store.close();
    }
  });

  test('rejects yield when requested work is already terminal and no future wake is pending', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    const observation = terminalObservation('graph-terminal-only');
    const [, updateTool, yieldTool] = buildAgentGraphSupervisorTools({
      graphId: 'graph-terminal-only',
      scheduleStore: store,
      observeGraph: async () => observation,
      prepareYieldPermit: () => ({
        acquire: async () => false,
        cancel() {},
      }),
    });
    try {
      await updateTool.impl(
        {
          operation: 'add_work',
          add_work: [
            {
              target_kind: 'existing_operator',
              operator_id: 'writer',
              instruction: 'Follow up on the completed activation.',
              input_ids: [],
              replacement_mode: 'none',
            },
          ],
        },
        toolContext('tool-terminal-work'),
      );

      await assert.rejects(
        async () =>
          await yieldTool.impl(
            { reason: 'There is nothing left in flight.' },
            toolContext('yield-terminal-only'),
          ),
        /no in-flight work or pending reconciliation.*future supervisor checkpoint/,
      );
    } finally {
      store.close();
    }
  });

  test('registers yield admission before reading a terminal runtime transition', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    const observation = terminalObservation('graph-terminal-race');
    let yielding = false;
    let permitRegistered = false;
    let terminalProofCaptured = false;
    const [, updateTool, yieldTool] = buildAgentGraphSupervisorTools({
      graphId: 'graph-terminal-race',
      scheduleStore: store,
      observeGraph: async () => {
        if (yielding) {
          assert.equal(permitRegistered, true, 'the waiter must exist before observation starts');
          terminalProofCaptured = true;
        }
        return observation;
      },
      prepareYieldPermit: () => {
        permitRegistered = true;
        return {
          acquire: async () => terminalProofCaptured,
          cancel() {
            permitRegistered = false;
          },
        };
      },
    });
    try {
      await updateTool.impl(
        {
          operation: 'add_work',
          add_work: [
            {
              target_kind: 'existing_operator',
              operator_id: 'writer',
              instruction: 'Follow up after the terminal transition.',
              input_ids: [],
              replacement_mode: 'none',
            },
          ],
        },
        toolContext('tool-terminal-race'),
      );
      yielding = true;
      assert.deepEqual(
        await yieldTool.impl(
          { reason: 'The registered waiter captured the terminal checkpoint.' },
          toolContext('yield-terminal-race'),
        ),
        {
          kind: 'agent_graph_yielded',
          pendingWorkCount: 1,
          liveOperatorCount: 0,
          reason: 'The registered waiter captured the terminal checkpoint.',
        },
      );
      assert.equal(permitRegistered, false);
    } finally {
      store.close();
    }
  });

  test('uses explicit discriminators when a provider fills unrelated optional fields', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    const [, updateTool] = buildAgentGraphSupervisorTools({
      graphId: 'graph-provider-filled',
      scheduleStore: store,
      observeGraph: async () => observationWithRecords('graph-provider-filled'),
    });
    try {
      const parsed = (
        updateTool.parameters as {
          safeParse(input: unknown): { success: boolean; data?: Record<string, unknown> };
        }
      ).safeParse({
        operation: 'add_work',
        add_work: [
          {
            target_kind: 'new_preset',
            subagent_id: 'deepseek-flash-reader',
            agent_id: { malformed: true },
            operator_id: { malformed: true },
            instruction: 'Implement node A.',
            replacement_mode: 'none',
            replaces: { malformed: true },
            ignored: true,
          },
        ],
        stop: 'not-an-array',
        finish: { malformed: true },
        ignored: true,
      });
      assert.equal(parsed.success, true);
      assert.deepEqual(parsed.data, {
        operation: 'add_work',
        add_work: [
          {
            target_kind: 'new_preset',
            subagent_id: 'deepseek-flash-reader',
            instruction: 'Implement node A.',
            input_ids: [],
            replacement_mode: 'none',
          },
        ],
      });

      const result = await updateTool.impl(
        {
          operation: 'add_work',
          add_work: [
            {
              target_kind: 'new_preset',
              subagent_id: 'deepseek-flash-reader',
              agent_id: 'provider-placeholder',
              operator_id: 'provider-placeholder',
              instruction: 'Implement node A.',
              input_ids: [],
              replaces: 'provider-placeholder',
              replacement_mode: 'none',
            },
          ],
          stop: [],
          finish: {
            result_ids: ['provider-placeholder'],
            reason: 'provider-placeholder',
          },
        },
        toolContext('tool-provider-filled'),
      );

      assert.equal(result.schedule.closed, false);
      assert.equal(result.schedule.finish, undefined);
      assert.deepEqual(result.schedule.work[0]?.target, {
        kind: 'preset',
        presetId: 'deepseek-flash-reader',
      });
      assert.equal(result.schedule.work[0]?.replaces, undefined);
    } finally {
      store.close();
    }
  });

  test('fails closed on non-contiguous durable schedule replay', () => {
    assert.throws(
      () =>
        projectAgentGraphSchedule('graph-supervised', [
          {
            schemaVersion: 1,
            updateId: `graph_update_${'a'.repeat(32)}`,
            updateFingerprint: `sha256:${'b'.repeat(64)}`,
            graphId: 'graph-supervised',
            source: {
              sessionId: 'session-main',
              runId: 'run-main',
              turnId: 'turn-main',
              toolCallId: 'tool-main',
            },
            addWork: [],
            stop: [{ targetId: 'work-1', reason: 'Stop stale work.' }],
            revision: 2,
            committedAt: 1,
          },
        ]),
      /non-contiguous revision 2/,
    );
  });

  test('fails closed when the runtime observation is for another graph', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    const [viewTool] = buildAgentGraphSupervisorTools({
      graphId: 'graph-supervised',
      scheduleStore: store,
      observeGraph: async () => observationWithRecords('graph-other'),
    });
    try {
      await assert.rejects(
        async () => await viewTool.impl({}, toolContext('tool-view')),
        /another graph/,
      );
    } finally {
      store.close();
    }
  });

  test('paginates all live state instead of hiding older requested work', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    const [viewTool, updateTool] = buildAgentGraphSupervisorTools({
      graphId: 'graph-supervised',
      scheduleStore: store,
      observeGraph: async () => observationWithRecords('graph-supervised'),
    });
    try {
      for (let batch = 0; batch < 4; batch += 1) {
        await updateTool.impl(
          {
            add_work: Array.from({ length: 20 }, (_, index) => ({
              agent_id: `agent-${batch}-${index}`,
              instruction: `Run live work ${batch}-${index}.`,
            })),
          },
          toolContext(`tool-batch-${batch}`),
        );
      }

      const firstPage = await viewTool.impl({}, toolContext('tool-view-1'));
      assert.equal(firstPage.schedule.work.length, 64);
      assert.ok(firstPage.nextCursor);
      const secondPage = await viewTool.impl(
        { cursor: firstPage.nextCursor },
        toolContext('tool-view-2'),
      );
      assert.equal(secondPage.schedule.work.length, 16);
      assert.equal(secondPage.runtime.operators.length, 1);
      assert.equal(secondPage.runtime.readiness.length, 1);
      assert.equal(secondPage.nextCursor, undefined);
      assert.equal(
        new Set([
          ...firstPage.schedule.work.map((work) => work.workId),
          ...secondPage.schedule.work.map((work) => work.workId),
        ]).size,
        80,
      );
    } finally {
      store.close();
    }
  });
});

function observationWithRecords(
  graphId: string,
  recordIds: readonly string[] = [],
): AgentGraphSupervisorObservation {
  const topologyFingerprint = `sha256:${'a'.repeat(64)}`;
  const policyFingerprint = `sha256:${'b'.repeat(64)}`;
  const readinessContextFingerprint = `sha256:${'c'.repeat(64)}`;
  const activationId = 'activation-writer';
  const records = recordIds.map((recordId, index) => {
    const runtimeEventId = `runtime-event-${index}`;
    const eventTime = index + 1;
    return {
      schemaVersion: 1 as const,
      recordId,
      graphId,
      operatorId: 'writer',
      activationId,
      sessionId: 'session-writer',
      agentRunId: 'run-writer',
      eventTime,
      orderKey: {
        runCreatedAt: 1,
        operatorId: 'writer',
        runId: 'run-writer',
        committedEventOrdinal: index,
        runtimeEventId,
      },
      ...(index > 0 ? { previousRecordId: recordIds[index - 1] } : {}),
      type: 'agent_runtime_event' as const,
      facets: ['message' as const],
      supervisorSignals: [],
      source: {
        kind: 'runtime_event' as const,
        runtimeEventId,
        sessionId: 'session-writer',
        runId: 'run-writer',
        turnId: 'turn-writer',
        ts: eventTime,
      },
    };
  });
  const lastRecord = records.at(-1);
  return {
    projection: {
      graphId,
      operators: [{ operatorId: 'writer', sessionId: 'session-writer' }],
      ignoredPartialEvents: 0,
      records,
      supervisorMetaStream: records.map((record) => ({
        recordId: record.recordId,
        graphId,
        operatorId: record.operatorId,
        activationId,
        eventTime: record.eventTime,
        orderKey: { ...record.orderKey },
        facets: [...record.facets],
        signals: [],
        source: { ...record.source },
      })),
      state: {
        graphId,
        appliedRecordIds: records.map((record) => record.recordId),
        operators: lastRecord
          ? {
              writer: {
                operatorId: 'writer',
                sessionId: 'session-writer',
                status: 'running',
                currentActivationId: activationId,
                activations: {
                  [activationId]: {
                    activationId,
                    agentRunId: 'run-writer',
                    status: 'running',
                    recordCount: records.length,
                    firstEventTime: records[0]!.eventTime,
                    lastEventTime: lastRecord.eventTime,
                    lastRecordId: lastRecord.recordId,
                  },
                },
              },
            }
          : {},
      },
    },
    readiness: {
      schemaVersion: 1,
      graphId,
      topologyFingerprint,
      trace: {
        schemaVersion: 1,
        graphId,
        topologyFingerprint,
        topologicalOrder: ['writer'],
        rootOperatorIds: ['writer'],
        sinkOperatorIds: ['writer'],
        recordIds: records.map((record) => record.recordId),
        operators: {
          writer: {
            operatorId: 'writer',
            sessionId: 'session-writer',
            topologicalIndex: 0,
            upstreamOperatorIds: [],
            downstreamOperatorIds: [],
            emittedRecordIds: records.map((record) => record.recordId),
            receivedRouteIds: [],
          },
        },
        edges: {},
        routes: [],
      },
      readiness: {},
      supervisorView: [
        {
          graphId,
          topologyFingerprint,
          readinessId: 'readiness-writer',
          operatorId: 'writer',
          policyKind: 'map',
          policyFingerprint,
          readinessContextFingerprint,
          status: 'waiting',
          intentIds: [],
          waitingFor: [{ kind: 'input_route', upstreamOperatorIds: ['researcher'] }],
        },
      ],
    },
    claims: [],
  };
}

function terminalObservation(graphId: string): AgentGraphSupervisorObservation {
  const observation = observationWithRecords(graphId, ['terminal-result']);
  const writer = observation.projection.state.operators.writer;
  assert.ok(writer);
  writer.status = 'completed';
  writer.activations[writer.currentActivationId]!.status = 'completed';
  return observation;
}

function toolContext(toolCallId: string): MakaToolContext {
  return {
    sessionId: 'session-main',
    runId: 'run-main',
    turnId: 'turn-main',
    toolCallId,
    cwd: '/workspace',
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };
}

function nextNumber(start: number): () => number {
  let value = start;
  return () => value++;
}
