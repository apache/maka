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
import test from 'node:test';
import {
  type RuntimeHostConnection,
  RuntimeHostOperationError,
} from '@maka/runtime-host/client';
import type { OperationInput, OperationKey } from '@maka/runtime-host/protocol';
import {
  DesktopRuntimeHostClient,
  DesktopRuntimeHostClientError,
} from '../runtime-host-client.js';

test('loads all Usage snapshot pages behind one start revision', async () => {
  const requests: Array<{ operation: OperationKey; input: unknown }> = [];
  const client = usageClient(async (operation, input) => {
    requests.push({ operation, input });
    if (operation === 'usage.snapshot.release') return { released: true };
    assert.equal(operation, 'usage.query');
    if (input.kind === 'snapshot_start') return started('revision-1', 2);
    assert.equal(input.revision, 'revision-1');
    if (input.kind === 'snapshot_logs' && input.source === 'llm') {
      return input.offset === 0
        ? logPage('revision-1', 'llm', [llmLog('llm-1', 2)], 0, 2, 1, false)
        : logPage('revision-1', 'llm', [llmLog('llm-2', 1)], 1, 2, null, false);
    }
    if (input.kind === 'snapshot_logs') {
      return logPage('revision-1', 'tool', [toolLog('tool-1', 3)], 0, 1, null, false);
    }
    if (input.kind === 'snapshot_pricing') {
      return input.offset === 0
        ? pricingPage('revision-1', [pricing('a:model')], 0, 2, 1)
        : pricingPage('revision-1', [pricing('b:model')], 1, 2, null);
    }
    throw new Error('Unexpected Usage request');
  });

  assert.deepEqual(await client.loadUsageSnapshot({ from: 0, to: 10 }), {
    revision: 'revision-1',
    summary: validSummary(2),
    provenance: validProvenance(),
    llmLogs: [llmLog('llm-1', 2), llmLog('llm-2', 1)],
    toolLogs: [toolLog('tool-1', 3)],
    pricingEntries: [pricing('a:model'), pricing('b:model')],
    llmLogsTruncated: false,
    toolLogsTruncated: false,
  });
  assert.equal(
    requests.filter(({ input }) => (input as { kind?: string }).kind === 'snapshot_start').length,
    1,
  );
  assert.deepEqual(requests.at(-1), {
    operation: 'usage.snapshot.release',
    input: { revision: 'revision-1' },
  });
  assert.equal(
    requests.filter(({ operation }) => operation === 'usage.snapshot.release').length,
    1,
  );
});

test('releases an acquired Usage revision when its start range is invalid', async () => {
  const released: string[] = [];
  const client = usageClient(async (operation, input) => {
    if (operation === 'usage.snapshot.release') {
      released.push(input.revision);
      return { released: true };
    }
    if (input.kind === 'snapshot_start') {
      const response = started('revision-1', 1);
      return { ...response, summary: { ...response.summary, range: { from: 1, to: 10 } } };
    }
    throw new Error('Unexpected Usage request');
  });

  await assert.rejects(
    () => client.loadUsageSnapshot({ from: 0, to: 10 }),
    (error: unknown) =>
      error instanceof DesktopRuntimeHostClientError && error.code === 'projection_unstable',
  );
  assert.deepEqual(released, ['revision-1']);
});

test('does not release an invalid Usage snapshot start without an acquired revision', async () => {
  const released: string[] = [];
  const client = usageClient(async (operation, input) => {
    if (operation === 'usage.snapshot.release') {
      released.push(input.revision);
      return { released: true };
    }
    if (input.kind === 'snapshot_start') {
      return { kind: 'revision_changed', expectedRevision: 'revision-1' };
    }
    throw new Error('Unexpected Usage request');
  });

  await assert.rejects(
    () => client.loadUsageSnapshot('all'),
    (error: unknown) =>
      error instanceof DesktopRuntimeHostClientError && error.code === 'projection_unstable',
  );
  assert.deepEqual(released, []);
});

test('discards every partial Usage result and restarts after revision_changed', async () => {
  let starts = 0;
  const released: string[] = [];
  const client = usageClient(async (_operation, input) => {
    if (_operation === 'usage.snapshot.release') {
      released.push(input.revision);
      return { released: true };
    }
    if (input.kind === 'snapshot_start') {
      starts += 1;
      return started(`revision-${starts}`, starts);
    }
    if (input.revision === 'revision-1' && input.kind === 'snapshot_logs' && input.source === 'llm') {
      return { kind: 'revision_changed', expectedRevision: 'revision-1' };
    }
    if (input.kind === 'snapshot_logs') {
      const row = input.source === 'llm' ? llmLog('fresh-llm', 2) : toolLog('fresh-tool', 1);
      return logPage(input.revision, input.source, [row], 0, 1, null, false);
    }
    if (input.kind === 'snapshot_pricing') {
      return pricingPage(input.revision, [pricing('fresh:model')], 0, 1, null);
    }
    throw new Error('Unexpected Usage request');
  });

  const snapshot = await client.loadUsageSnapshot('all');
  assert.equal(starts, 2);
  assert.equal(snapshot.revision, 'revision-2');
  assert.deepEqual(snapshot.llmLogs.map((row) => row.id), ['fresh-llm']);
  assert.deepEqual(snapshot.toolLogs.map((row) => row.id), ['fresh-tool']);
  assert.deepEqual(released, ['revision-1', 'revision-2']);
});

test('retries Usage snapshot capacity conflicts as whole loads', async () => {
  let starts = 0;
  const client = usageClient(async (operation, input) => {
    if (operation === 'usage.snapshot.release') return { released: true };
    if (input.kind === 'snapshot_start') {
      starts += 1;
      if (starts < 3) {
        throw new RuntimeHostOperationError(
          'usage.query',
          'operation_conflict',
          'Usage snapshot capacity is occupied',
        );
      }
      return started('revision-3', 0);
    }
    if (input.kind === 'snapshot_logs') {
      return logPage('revision-3', input.source, [], 0, 0, null, false);
    }
    if (input.kind === 'snapshot_pricing') {
      return pricingPage('revision-3', [], 0, 0, null);
    }
    throw new Error('Unexpected Usage request');
  });

  const snapshot = await client.loadUsageSnapshot('all');
  assert.equal(snapshot.revision, 'revision-3');
  assert.equal(starts, 3);
});

test('bounds repeated Usage snapshot capacity conflicts', async () => {
  let starts = 0;
  const client = usageClient(async (operation, input) => {
    assert.equal(operation, 'usage.query');
    assert.equal(input.kind, 'snapshot_start');
    starts += 1;
    throw new RuntimeHostOperationError(
      'usage.query',
      'operation_conflict',
      'Usage snapshot capacity is occupied',
    );
  });

  await assert.rejects(
    () => client.loadUsageSnapshot('all'),
    (error: unknown) =>
      error instanceof DesktopRuntimeHostClientError && error.code === 'usage_unstable',
  );
  assert.equal(starts, 3);
});

test('releases an acquired Usage revision when a page reader throws without replacing its error', async () => {
  const pageError = new Error('Usage page failed');
  const released: string[] = [];
  const client = usageClient(async (operation, input) => {
    if (operation === 'usage.snapshot.release') {
      released.push(input.revision);
      return { released: true };
    }
    if (input.kind === 'snapshot_start') return started('revision-1', 1);
    if (input.kind === 'snapshot_logs' && input.source === 'llm') throw pageError;
    if (input.kind === 'snapshot_logs') {
      return logPage('revision-1', 'tool', [toolLog('tool-1', 1)], 0, 1, null, false);
    }
    if (input.kind === 'snapshot_pricing') {
      return pricingPage('revision-1', [pricing('model')], 0, 1, null);
    }
    throw new Error('Unexpected Usage request');
  });

  await assert.rejects(() => client.loadUsageSnapshot('all'), (error: unknown) => error === pageError);
  assert.deepEqual(released, ['revision-1']);
});

test('keeps a successful Usage snapshot when its release fails', async () => {
  const released: string[] = [];
  const client = usageClient(async (operation, input) => {
    if (operation === 'usage.snapshot.release') {
      released.push(input.revision);
      throw new Error('Usage release failed');
    }
    if (input.kind === 'snapshot_start') return started('revision-1', 1);
    if (input.kind === 'snapshot_logs') {
      const row = input.source === 'llm' ? llmLog('llm-1', 1) : toolLog('tool-1', 1);
      return logPage('revision-1', input.source, [row], 0, 1, null, false);
    }
    if (input.kind === 'snapshot_pricing') {
      return pricingPage('revision-1', [pricing('model')], 0, 1, null);
    }
    throw new Error('Unexpected Usage request');
  });

  const snapshot = await client.loadUsageSnapshot('all');
  assert.equal(snapshot.revision, 'revision-1');
  assert.deepEqual(released, ['revision-1']);
});

test('keeps a successful Usage snapshot when release throws synchronously', async () => {
  const released: string[] = [];
  const client = usageClient((operation, input) => {
    if (operation === 'usage.snapshot.release') {
      released.push(input.revision);
      throw new Error('Usage release failed synchronously');
    }
    if (input.kind === 'snapshot_start') return started('revision-1', 1);
    if (input.kind === 'snapshot_logs') {
      const row = input.source === 'llm' ? llmLog('llm-1', 1) : toolLog('tool-1', 1);
      return logPage('revision-1', input.source, [row], 0, 1, null, false);
    }
    if (input.kind === 'snapshot_pricing') {
      return pricingPage('revision-1', [pricing('model')], 0, 1, null);
    }
    throw new Error('Unexpected Usage request');
  });

  const snapshot = await client.loadUsageSnapshot('all');
  assert.equal(snapshot.revision, 'revision-1');
  assert.deepEqual(released, ['revision-1']);
});

test('fails with usage_unstable after three complete Usage snapshot attempts', async () => {
  let starts = 0;
  const client = usageClient(async (_operation, input) => {
    if (input.kind === 'snapshot_start') {
      starts += 1;
      return started(`revision-${starts}`, 0);
    }
    return { kind: 'revision_changed', expectedRevision: input.revision };
  });

  await assert.rejects(
    () => client.loadUsageSnapshot('all'),
    (error: unknown) =>
      error instanceof DesktopRuntimeHostClientError && error.code === 'usage_unstable',
  );
  assert.equal(starts, 3);
});

test('rejects non-progressing or identity-changing Usage snapshot pages', async () => {
  const client = usageClient(async (_operation, input) => {
    if (input.kind === 'snapshot_start') return started('revision-1', 1);
    if (input.kind === 'snapshot_logs' && input.source === 'llm') {
      return logPage('wrong-revision', 'llm', [llmLog('llm-1', 1)], 0, 2, 0, false);
    }
    if (input.kind === 'snapshot_logs') {
      return logPage('revision-1', 'tool', [], 0, 0, null, false);
    }
    return pricingPage('revision-1', [], 0, 0, null);
  });

  await assert.rejects(
    () => client.loadUsageSnapshot('all'),
    (error: unknown) =>
      error instanceof DesktopRuntimeHostClientError && error.code === 'projection_unstable',
  );
});

function usageClient(
  respond: (operation: OperationKey, input: any) => Promise<any> | any,
): DesktopRuntimeHostClient {
  const connection = {
    hostEpoch: 'host-current',
    connectionId: 'connection-current',
    rootId: 'root-current',
    request: <K extends OperationKey>(operation: K, input: OperationInput<K>) =>
      respond(operation, input),
    close: async () => undefined,
  } as unknown as RuntimeHostConnection;
  return new DesktopRuntimeHostClient(connection);
}

function started(revision: string, totalRequests: number) {
  return {
    kind: 'snapshot_started' as const,
    revision,
    summary: validSummary(totalRequests),
    provenance: validProvenance(),
  };
}

function logPage(
  revision: string,
  source: 'llm' | 'tool',
  rows: readonly unknown[],
  offset: number,
  total: number,
  nextOffset: number | null,
  truncated: boolean,
) {
  return { kind: 'snapshot_logs' as const, revision, source, rows, offset, total, nextOffset, truncated };
}

function pricingPage(
  revision: string,
  entries: readonly unknown[],
  offset: number,
  total: number,
  nextOffset: number | null,
) {
  return { kind: 'snapshot_pricing' as const, revision, entries, offset, total, nextOffset };
}

function validSummary(totalRequests: number) {
  return {
    range: { from: 0, to: 10 },
    totalRequests,
    totalCostUsd: 0,
    totalTokens: {
      input: 0,
      output: 0,
      cacheMiss: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 0,
    },
    cacheHitRequests: 0,
    cacheCreateRequests: 0,
    errorRequests: 0,
  };
}

function validProvenance() {
  return {
    coverage: {
      attempts: 0,
      pricedAttempts: 0,
      unpricedAttempts: 0,
      usageReportedAttempts: 0,
      usagePartialAttempts: 0,
      usageMissingAttempts: 0,
    },
    legacyRecords: 0,
    unreadableRecords: 0,
    pendingRepairs: 0,
  };
}

function llmLog(id: string, ts: number) {
  return {
    source: 'llm' as const,
    id,
    ts,
    providerId: 'provider',
    modelId: 'model',
    inputTokens: 1,
    outputTokens: 1,
    cacheMissTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 2,
    costUsd: 0,
    latencyMs: 1,
    status: 'success' as const,
  };
}

function toolLog(id: string, ts: number) {
  return {
    source: 'tool' as const,
    id,
    ts,
    toolName: 'Read',
    durationMs: 1,
    status: 'success' as const,
    bytesIn: 0,
    bytesOut: 0,
    startedAt: ts,
  };
}

function pricing(modelKey: string) {
  return {
    source: 'custom' as const,
    resetEffect: 'become_unpriced' as const,
    pricing: { modelKey, inputUsdPer1M: 1, outputUsdPer1M: 2 },
  };
}
