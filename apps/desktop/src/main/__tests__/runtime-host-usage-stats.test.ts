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

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { OperationInput, OperationOutput } from '@maka/runtime-host/protocol';
import { loadDesktopUsageStats } from '../runtime-host-usage-ipc-main.js';

test('Desktop usage stats use the Host projection and load every activity page', async () => {
  const calls: Array<OperationInput<'usage.query'>> = [];
  const modelRows: Array<Record<string, unknown>> = Array.from(
    { length: 100 },
    (_, index) => modelLog(`model-${index}`, index),
  );
  modelRows.push({
    ...modelLog('aborted-model', 200),
    status: 'aborted',
    sessionId: undefined,
    costUsd: undefined,
  });
  const toolRows = [{
    source: 'tool' as const,
    id: 'tool-1',
    ts: 150,
    toolName: 'Bash',
    durationMs: 42,
    status: 'aborted' as const,
    bytesIn: 0,
    bytesOut: 0,
    startedAt: 108,
  }];
  const client = {
    async queryUsage(input: OperationInput<'usage.query'>): Promise<OperationOutput<'usage.query'>> {
      calls.push(input);
      if (input.kind === 'summary') {
        return {
          kind: 'summary',
          summary: {
            range: { from: 0, to: 300 },
            totalRequests: 101,
            totalCostUsd: 1.25,
            totalTokens: {
              input: 1010,
              output: 202,
              cacheMiss: 303,
              cacheRead: 404,
              cacheWrite: 505,
              reasoning: 606,
              total: 1212,
            },
            cacheHitRequests: 1,
            cacheCreateRequests: 1,
            errorRequests: 0,
          },
          provenance: {} as never,
        } as unknown as OperationOutput<'usage.query'>;
      }
      if (input.kind === 'buckets') {
        const key = input.groupBy === 'provider'
          ? 'provider-a'
          : input.groupBy === 'model'
            ? 'model-a'
            : 'Bash';
        return {
          kind: 'buckets',
          buckets: [{
            key,
            label: key,
            requests: input.groupBy === 'tool' ? 1 : 101,
            inputTokens: 1010,
            outputTokens: 202,
            cacheMissTokens: 303,
            cacheReadTokens: 404,
            cacheWriteTokens: 505,
            reasoningTokens: 606,
            totalTokens: 1212,
            costUsd: 1.25,
            avgLatencyMs: 10,
            errorRate: input.groupBy === 'tool' ? 1 : 0,
          }],
          offset: input.offset ?? 0,
          total: 1,
          nextOffset: null,
          provenance: {} as never,
        } as unknown as OperationOutput<'usage.query'>;
      }
      if (input.source === 'llm') {
        const offset = input.offset ?? 0;
        const rows = modelRows.slice(offset, offset + (input.limit ?? 100));
        return {
          kind: 'logs',
          source: 'llm',
          rows,
          offset,
          total: modelRows.length,
          nextOffset: offset + rows.length < modelRows.length ? offset + rows.length : null,
          provenance: {} as never,
        } as unknown as OperationOutput<'usage.query'>;
      }
      return {
        kind: 'logs',
        source: 'tool',
        rows: toolRows,
        offset: input.offset ?? 0,
        total: toolRows.length,
        nextOffset: null,
      } as OperationOutput<'usage.query'>;
    },
  };

  const stats = await loadDesktopUsageStats(client, 'all', 'host-a');

  assert.equal(stats.summary.totalRequests, 101);
  assert.equal(stats.summary.totalTokens, 1212);
  assert.equal(stats.logs.length, 102);
  assert.equal(stats.logs[0]?.status, 'aborted');
  assert.equal(stats.logs[0]?.sessionId, 'unknown');
  assert.equal(stats.logs[0]?.costUsd, undefined);
  assert.equal(stats.logs[2]?.sessionId, JSON.stringify(['host-a', 'session-a']));
  const concreteRanges = calls
    .filter((input) => input.kind === 'summary' || input.kind === 'buckets' || input.kind === 'logs')
    .map((input) => JSON.stringify(input.query.range));
  assert.equal(new Set(concreteRanges).size, 1, 'all Host reads must use one concrete time window');
  assert.deepEqual(stats.byTool, [{
    tool: 'Bash',
    calls: 1,
    success: 0,
    errors: 0,
    aborted: 1,
    avgDurationMs: 42,
  }]);
  assert.equal(
    calls.filter((input) => input.kind === 'logs' && input.source === 'llm').length,
    2,
    'the adapter must fetch the second model-log page',
  );
});

function modelLog(id: string, ts: number) {
  return {
    source: 'llm' as const,
    id,
    ts,
    providerId: 'provider-a',
    modelId: 'model-a',
    inputTokens: 10,
    outputTokens: 2,
    cacheMissTokens: 3,
    cacheReadTokens: 4,
    cacheWriteTokens: 5,
    reasoningTokens: 6,
    totalTokens: 12,
    costUsd: 0.01,
    latencyMs: 10,
    status: 'success' as const,
    sessionId: 'session-a',
    turnId: `turn-${id}`,
  };
}
