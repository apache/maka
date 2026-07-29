import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, mock, test } from 'node:test';
import { createTelemetryRepo, TelemetryRepoPublicationError } from '../telemetry-repo.js';

describe('FileTelemetryRepo', () => {
  test('single-flights concurrent load and allows retry after failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-load-retry-'));
    const path = join(root, 'telemetry.json');
    const repo = createTelemetryRepo(root);
    try {
      await writeFile(path, '{');

      const first = repo.load();
      const concurrent = repo.load();
      assert.equal(concurrent, first);
      await assert.rejects(() => first, SyntaxError);

      await writeFile(
        path,
        JSON.stringify({ version: 1, usageRecords: [], toolInvocations: [] }, null, 2) + '\n',
      );
      await repo.load();
      assert.equal(repo.summary({ range: 'all' }).totalRequests, 0);
    } finally {
      await repo.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('close joins a load started in the same tick and closes managed pricing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-load-close-'));
    const repo = createTelemetryRepo(root);
    try {
      let loadSettled = false;
      const load = repo.load().finally(() => {
        loadSettled = true;
      });
      await repo.close();
      assert.equal(loadSettled, true);
      await load;

      assert.match(await readFile(join(root, 'telemetry.json'), 'utf8'), /"version": 1/);
      assert.match(await readFile(join(root, 'pricing.json'), 'utf8'), /"version": 1/);
      assert.throws(() => repo.summary({ range: 'all' }), /draining or closed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('retry does not reuse legacy pricing from a failed load attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-stale-load-'));
    const repo = createTelemetryRepo(root);
    try {
      await writeFile(
        join(root, 'telemetry.json'),
        JSON.stringify({
          pricingOverrides: [{ modelKey: 'openai:stale', inputUsdPer1M: 1, outputUsdPer1M: 2 }],
        }),
      );
      await writeFile(join(root, 'pricing.json'), '{');
      await assert.rejects(() => repo.load(), SyntaxError);

      await Promise.all([rm(join(root, 'telemetry.json')), rm(join(root, 'pricing.json'))]);
      await repo.load();
      assert.deepEqual(repo.listPricingOverrides(), []);
      assert.deepEqual(
        (
          JSON.parse(await readFile(join(root, 'pricing.json'), 'utf8')) as {
            overrides: unknown[];
          }
        ).overrides,
        [],
      );
    } finally {
      await repo.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('upserts LLM calls by id and aggregates the latest record', async () => {
    await withRepo(async (repo) => {
      await repo.load();
      await repo.insertLlmCall(
        llmRecord({
          id: 'usage_turn_1',
          inputTokens: 10,
          outputTokens: 20,
          cacheMissInputTokens: 10,
          totalTokens: 30,
        }),
      );
      await repo.insertLlmCall(
        llmRecord({
          id: 'usage_turn_1',
          inputTokens: 30,
          outputTokens: 40,
          cacheMissInputTokens: 30,
          totalTokens: 70,
        }),
      );

      const summary = repo.summary({ range: 'all' });
      const logs = repo.logs({ range: 'all' });

      assert.equal(summary.totalRequests, 1);
      assert.equal(summary.totalTokens.input, 30);
      assert.equal(summary.totalTokens.output, 40);
      assert.equal(summary.totalTokens.cacheMiss, 30);
      assert.equal(summary.totalTokens.total, 70);
      assert.equal(logs.total, 1);
      assert.equal(logs.rows[0]?.inputTokens, 30);
      assert.equal(logs.rows[0]?.cacheMissTokens, 30);
    });
  });

  test('carries the tool-availability diagnostic and tool-schema change reason through logs()', async () => {
    await withRepo(async (repo) => {
      await repo.load();
      await repo.insertLlmCall(
        llmRecord({
          id: 'usage_diag',
          systemPromptHash: 'sys-hash',
          toolSchemaChangeReason: 'tool_source_enabled',
          toolAvailability: {
            mode: 'economy',
            enabledSourceIds: ['docs'],
            availableSourceIds: ['rive'],
            connectorToolName: 'load_tools',
            visibleToolNamesBySource: { docs: ['docs_edit'] },
            hiddenToolCount: 1,
          },
        }),
      );

      const row = repo.logs({ range: 'all' }).rows[0];
      assert.equal(row?.systemPromptHash, 'sys-hash');
      assert.equal(row?.toolSchemaChangeReason, 'tool_source_enabled');
      assert.equal(row?.toolAvailability?.mode, 'economy');
      assert.deepEqual(row?.toolAvailability?.enabledSourceIds, ['docs']);
      assert.equal(row?.toolAvailability?.hiddenToolCount, 1);
    });
  });

  test('strictly admits current token aliases and diagnostic shapes', async () => {
    await withRepo(async (repo) => {
      await repo.load();
      await repo.insertLlmCall(
        llmRecord({
          cachedInputTokens: 4,
          cacheHitInputTokens: 4,
          rawUsage: {
            prompt_tokens: 10,
            prompt_tokens_details: { cached_tokens: 4 },
          },
          promptSegments: [{ kind: 'system_prompt', chars: 12, estimatedTokens: 3 }],
          contextBudget: {
            enabled: true,
            estimatedTokensBefore: 10,
            estimatedTokensAfter: 8,
            keptTurns: 1,
            droppedTurns: 0,
            keptEvents: 2,
            droppedEvents: 0,
          },
        }),
      );

      assert.equal(repo.logs({ range: 'all' }).rows[0]?.cacheReadTokens, 4);
    });
  });

  test('owns admitted records and returns detached frozen diagnostics', async () => {
    await withRepo(async (repo, root) => {
      await repo.load();
      const record = llmRecord({
        contextBudget: {
          enabled: true,
          estimatedTokensBefore: 10,
          estimatedTokensAfter: 8,
          keptTurns: 1,
          droppedTurns: 0,
          keptEvents: 2,
          droppedEvents: 0,
        },
      });
      const inserted = repo.insertLlmCall(record);
      const callerContext = record.contextBudget as { keptTurns: number };
      callerContext.keptTurns = 99;
      record.inputTokens = 999;
      await inserted;

      const first = repo.logs({ range: 'all' }).rows[0];
      assert.equal(repo.summary({ range: 'all' }).totalTokens.input, 10);
      assert.equal(first?.contextBudget?.keptTurns, 1);
      assert.equal(Object.isFrozen(first?.contextBudget), true);
      assert.throws(() => {
        (first?.contextBudget as { keptTurns: number }).keptTurns = 77;
      }, TypeError);
      assert.equal(repo.logs({ range: 'all' }).rows[0]?.contextBudget?.keptTurns, 1);
      const bytes = await readFile(join(root, 'telemetry.json'), 'utf8');
      assert.match(bytes, /"inputTokens": 10/);
      assert.match(bytes, /"keptTurns": 1/);
    });
  });

  test('rejects unknown fields and invalid diagnostics at writer admission', async () => {
    await withRepo(async (repo) => {
      await repo.load();
      await assert.rejects(
        () => repo.insertLlmCall(llmRecord({ unexpected: true })),
        /invalid LLM row keys/,
      );
      await assert.rejects(
        () =>
          repo.insertLlmCall(
            llmRecord({
              contextBudget: {
                enabled: 'yes',
                estimatedTokensBefore: 1,
                estimatedTokensAfter: 1,
                keptTurns: 0,
                droppedTurns: 0,
                keptEvents: 0,
                droppedEvents: 0,
              },
            }),
          ),
        /invalid contextBudget/,
      );
      assert.deepEqual(repo.logs({ range: 'all' }), { rows: [], total: 0 });
    });
  });

  test('carries auxiliary LLM call identity through logs()', async () => {
    await withRepo(async (repo) => {
      await repo.load();
      await repo.insertLlmCall(
        llmRecord({
          id: 'usage_semantic_compact_turn_1_2_3',
          callKind: 'semantic_compact',
          callId: 'semantic_compact_turn_1_2_3',
        }),
      );

      const row = repo.logs({ range: 'all' }).rows[0];
      assert.equal(row?.callKind, 'semantic_compact');
      assert.equal(row?.callId, 'semantic_compact_turn_1_2_3');
    });
  });

  test('filters logs by range, status, provider, model, and pagination', async () => {
    await withRepo(async (repo) => {
      await repo.load();
      await repo.insertLlmCall(
        llmRecord({ id: 'old', ts: 1, status: 'success', providerId: 'openai', modelId: 'gpt-4o' }),
      );
      await repo.insertLlmCall(
        llmRecord({
          id: 'new-success',
          ts: 20,
          status: 'success',
          providerId: 'openai',
          modelId: 'gpt-4o',
        }),
      );
      await repo.insertLlmCall(
        llmRecord({
          id: 'middle-success',
          ts: 15,
          status: 'success',
          providerId: 'openai',
          modelId: 'gpt-4o',
          contextBudget: {
            enabled: true,
            estimatedTokensBefore: 10,
            estimatedTokensAfter: 8,
            keptTurns: 1,
            droppedTurns: 0,
            keptEvents: 2,
            droppedEvents: 0,
          },
        }),
      );
      await repo.insertLlmCall(
        llmRecord({
          id: 'new-error',
          ts: 30,
          status: 'error',
          providerId: 'anthropic',
          modelId: 'claude',
        }),
      );

      const logs = repo.logs(
        { range: { from: 10, to: 40 }, status: 'success', providerId: 'openai', modelId: 'gpt-4o' },
        1,
        1,
      );

      assert.equal(logs.total, 2);
      assert.deepEqual(
        logs.rows.map((row) => row.id),
        ['middle-success'],
      );
      assert.equal(Object.isFrozen(logs), true);
      assert.equal(Object.isFrozen(logs.rows), true);
      assert.equal(Object.isFrozen(logs.rows[0]?.contextBudget), true);
      assert.throws(() => {
        (logs.rows[0]?.contextBudget as { keptTurns: number }).keptTurns = 99;
      }, TypeError);
      assert.equal(
        repo.logs({ range: 'all' }).rows.find((row) => row.id === 'middle-success')?.contextBudget
          ?.keptTurns,
        1,
      );
    });
  });

  test('filters and returns latest LLM runtime probes by connection slug', async () => {
    await withRepo(async (repo) => {
      await repo.load();
      await repo.insertLlmCall(
        llmRecord({
          id: 'conn-a-old',
          connectionSlug: 'conn-a',
          modelId: 'glm-4.7',
          ts: 10,
          status: 'success',
        }),
      );
      await repo.insertLlmCall(
        llmRecord({
          id: 'conn-b-new',
          connectionSlug: 'conn-b',
          modelId: 'glm-4.7',
          ts: 50,
          status: 'error',
        }),
      );
      await repo.insertLlmCall(
        llmRecord({
          id: 'conn-a-new',
          connectionSlug: 'conn-a',
          modelId: 'glm-4.7',
          ts: 40,
          status: 'aborted',
        }),
      );

      const logs = repo.logs({ range: 'all', connectionSlug: 'conn-a' });
      const latest = repo.latestLlmRuntimeProbe('conn-a', 'glm-4.7');

      assert.equal(logs.total, 2);
      assert.equal(logs.rows[0]?.id, 'conn-a-new');
      assert.equal(logs.rows[0]?.connectionSlug, 'conn-a');
      assert.equal(latest?.id, 'conn-a-new');
      assert.equal(repo.latestLlmRuntimeProbe('missing'), undefined);
    });
  });

  test('builds provider, model, day, hour, and tool buckets', async () => {
    await withRepo(async (repo) => {
      await repo.load();
      await repo.insertLlmCall(
        llmRecord({
          id: 'usage_1',
          providerId: 'openai',
          modelId: 'gpt-4o',
          ts: Date.UTC(2026, 0, 1, 1),
          date: '2026-01-01',
        }),
      );
      await repo.insertLlmCall(
        llmRecord({
          id: 'usage_2',
          providerId: 'openai',
          modelId: 'gpt-4o-mini',
          ts: Date.UTC(2026, 0, 1, 2),
          date: '2026-01-01',
        }),
      );
      await repo.insertToolInvocation(
        toolRecord({ id: 'tool_1', toolName: 'Bash', durationMs: 30, status: 'success' }),
      );
      await repo.insertToolInvocation(
        toolRecord({ id: 'tool_2', toolName: 'Bash', durationMs: 90, status: 'error' }),
      );

      assert.equal(repo.buckets({ range: 'all' }, 'provider')[0]?.key, 'openai');
      assert.equal(repo.buckets({ range: 'all' }, 'model').length, 2);
      assert.equal(repo.buckets({ range: 'all' }, 'day')[0]?.key, '2026-01-01');
      assert.equal(repo.buckets({ range: 'all' }, 'hour').length, 2);

      const tool = repo.buckets({ range: 'all' }, 'tool')[0];
      assert.equal(tool?.key, 'Bash');
      assert.equal(tool?.requests, 2);
      assert.equal(tool?.avgLatencyMs, 60);
      assert.equal(tool?.errorRate, 0.5);
    });
  });

  test('separates LLM and tool logs and rejects inapplicable filters', async () => {
    await withRepo(async (repo) => {
      await repo.load();
      await repo.insertLlmCall(llmRecord());
      await repo.insertToolInvocation(
        toolRecord({
          id: 'bash',
          toolName: 'Bash',
          resultSummary: { kind: 'shell', completedItemCount: 1 },
        }),
      );
      await repo.insertToolInvocation(toolRecord({ id: 'read', toolName: 'Read' }));

      assert.deepEqual(
        repo.logs({ range: 'all' }).rows.map((row) => row.id),
        ['usage_1'],
      );
      assert.deepEqual(
        repo.toolLogs({ range: 'all', toolName: 'Bash' }).rows.map((row) => row.id),
        ['bash'],
      );
      const toolResult = repo.toolLogs({ range: 'all', toolName: 'Bash' }).rows[0]?.resultSummary;
      assert.equal(Object.isFrozen(toolResult), true);
      assert.throws(() => {
        (toolResult as { completedItemCount: number }).completedItemCount = 9;
      }, TypeError);
      assert.equal(
        repo.toolLogs({ range: 'all', toolName: 'Bash' }).rows[0]?.resultSummary
          ?.completedItemCount,
        1,
      );
      assert.throws(
        () => repo.logs({ range: 'all', toolName: 'Bash' }),
        /toolName is not applicable to LLM logs/,
      );
      assert.throws(
        () =>
          repo.toolLogs({
            range: 'all',
            providerId: 'openai',
          } as Parameters<typeof repo.toolLogs>[0]),
        /accept only range, toolName, and status/,
      );
    });
  });

  test('persists pricing overrides and reloads them from disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-'));
    const first = createTelemetryRepo(root);
    const second = createTelemetryRepo(root);
    try {
      await first.load();
      await first.upsertPricing({
        modelKey: 'openai:gpt-4o',
        inputUsdPer1M: 2.5,
        outputUsdPer1M: 10,
      });

      await second.load();

      assert.deepEqual(second.listPricingOverrides(), [
        { modelKey: 'openai:gpt-4o', inputUsdPer1M: 2.5, outputUsdPer1M: 10 },
      ]);
    } finally {
      await Promise.all([first.close(), second.close()]);
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  test('load creates an empty telemetry file only when missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-missing-'));
    const repo = createTelemetryRepo(root);
    try {
      await repo.load();
      const raw = await readFile(join(root, 'telemetry.json'), 'utf8');

      assert.deepEqual(repo.logs({ range: 'all' }), { rows: [], total: 0 });
      assert.match(raw, /"usageRecords": \[\]/);
      assert.match(raw, /"toolInvocations": \[\]/);
    } finally {
      await repo.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  test('load accepts legacy telemetry files with only known array sections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-legacy-'));
    const repo = createTelemetryRepo(root);
    try {
      await writeFile(
        join(root, 'telemetry.json'),
        JSON.stringify({ usageRecords: [] }) + '\n',
        'utf8',
      );
      await repo.load();

      assert.deepEqual(repo.logs({ range: 'all' }), { rows: [], total: 0 });
      assert.deepEqual(repo.listPricingOverrides(), []);
    } finally {
      await repo.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  test('load rejects corrupt telemetry.json without overwriting usage history bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-corrupt-'));
    const repo = createTelemetryRepo(root);
    try {
      const corrupt = '{"usageRecords":[{"id":"usage_1"}]';
      await writeFile(join(root, 'telemetry.json'), corrupt, 'utf8');
      await assert.rejects(() => repo.load(), SyntaxError);
      assert.equal(await readFile(join(root, 'telemetry.json'), 'utf8'), corrupt);
    } finally {
      await repo.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  test('load rejects wrong telemetry schema without overwriting bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-wrong-schema-'));
    const repo = createTelemetryRepo(root);
    try {
      const wrongShape = JSON.stringify({ reminders: [] }, null, 2) + '\n';
      await writeFile(join(root, 'telemetry.json'), wrongShape, 'utf8');
      await assert.rejects(() => repo.load(), /expected known telemetry sections/);
      assert.equal(await readFile(join(root, 'telemetry.json'), 'utf8'), wrongShape);
    } finally {
      await repo.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  test('load rejects known telemetry sections with non-array values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-bad-section-'));
    const repo = createTelemetryRepo(root);
    try {
      const wrongShape = JSON.stringify({ usageRecords: {} }, null, 2) + '\n';
      await writeFile(join(root, 'telemetry.json'), wrongShape, 'utf8');
      await assert.rejects(() => repo.load(), /usageRecords must be an array/);
      assert.equal(await readFile(join(root, 'telemetry.json'), 'utf8'), wrongShape);
    } finally {
      await repo.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  test('version 1 rejects unknown fields and invalid canonical values without rewriting bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-canonical-invalid-'));
    const repo = createTelemetryRepo(root);
    try {
      const invalidCanonical =
        JSON.stringify(
          {
            version: 1,
            usageRecords: [{ ...llmRecord(), inputTokens: -1, unexpected: true }],
            toolInvocations: [],
          },
          null,
          2,
        ) + '\n';
      await writeFile(join(root, 'telemetry.json'), invalidCanonical);

      await assert.rejects(() => repo.load(), /invalid LLM row keys/);
      assert.equal(await readFile(join(root, 'telemetry.json'), 'utf8'), invalidCanonical);
    } finally {
      await repo.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('surfaces publication failure through mutation, flush, and close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-publication-'));
    try {
      const repo = createTelemetryRepo(root);
      await repo.load();
      await rm(join(root, 'telemetry.json'));
      await mkdir(join(root, 'telemetry.json'));

      await assert.rejects(() => repo.insertLlmCall(llmRecord()), /Unable to publish telemetry/);
      assert.equal(repo.summary({ range: 'all' }).totalRequests, 0);
      await assert.rejects(() => repo.flush(), /Unable to publish telemetry/);
      await assert.rejects(() => repo.close(), /Unable to publish telemetry/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('poisons reads after rename succeeds but directory sync fails', {
    skip: process.platform === 'win32',
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-commit-unknown-'));
    try {
      const repo = createTelemetryRepo(root);
      await repo.load();
      const fault = new Error('injected telemetry directory sync failure');
      const probe = await open(root, 'r');
      const fileHandlePrototype = Object.getPrototypeOf(probe) as {
        sync: typeof probe.sync;
      };
      const originalSync = fileHandlePrototype.sync;
      await probe.close();
      let injected = false;
      const syncMock = mock.method(
        fileHandlePrototype,
        'sync',
        async function (this: typeof probe) {
          const metadata = await this.stat();
          if (!injected && metadata.isDirectory()) {
            injected = true;
            throw fault;
          }
          return originalSync.call(this);
        },
      );
      let failure: unknown;
      try {
        failure = await repo.insertLlmCall(llmRecord()).then(
          () => undefined,
          (error: unknown) => error,
        );
      } finally {
        syncMock.mock.restore();
      }

      assert(failure instanceof TelemetryRepoPublicationError);
      assert.equal(failure.commitUnknown, true);
      assert.match(await readFile(join(root, 'telemetry.json'), 'utf8'), /"usage_1"/);
      assert.throws(
        () => repo.summary({ range: 'all' }),
        (error) => error === failure,
      );
      await assert.rejects(
        () => repo.flush(),
        (error) => error === failure,
      );
      await assert.rejects(
        () => repo.close(),
        (error) => error === failure,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('close settles and aggregates telemetry and managed pricing failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-close-failures-'));
    try {
      const repo = createTelemetryRepo(root);
      await repo.load();
      await Promise.all([rm(join(root, 'telemetry.json')), rm(join(root, 'pricing.json'))]);
      await Promise.all([mkdir(join(root, 'telemetry.json')), mkdir(join(root, 'pricing.json'))]);

      const pricingFailure = repo.upsertPricing({
        modelKey: 'openai:gpt-4o',
        inputUsdPer1M: 2.5,
        outputUsdPer1M: 10,
      });
      const pricingRejected = assert.rejects(
        () => pricingFailure,
        /Unable to publish pricing authority/,
      );
      await assert.rejects(() => repo.insertLlmCall(llmRecord()), /Unable to publish telemetry/);
      await pricingRejected;
      await assert.rejects(
        () => repo.close(),
        (error) => error instanceof AggregateError && error.errors.length === 2,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function withRepo(
  fn: (repo: ReturnType<typeof createTelemetryRepo>, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-'));
  const repo = createTelemetryRepo(root);
  try {
    await fn(repo, root);
  } finally {
    await repo.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

function llmRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'usage_1',
    providerId: 'openai',
    modelId: 'gpt-4o',
    inputTokens: 10,
    outputTokens: 20,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 10,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 30,
    costUsd: 0.001,
    latencyMs: 100,
    status: 'success',
    date: '2026-01-01',
    ts: Date.UTC(2026, 0, 1),
    startedAt: Date.UTC(2026, 0, 1) - 100,
    ...overrides,
  } as Parameters<ReturnType<typeof createTelemetryRepo>['insertLlmCall']>[0];
}

function toolRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tool_1',
    toolName: 'Bash',
    durationMs: 10,
    status: 'success',
    argsSummary: '',
    bytesIn: 0,
    bytesOut: 0,
    date: '2026-01-01',
    ts: Date.UTC(2026, 0, 1),
    startedAt: Date.UTC(2026, 0, 1) - 10,
    ...overrides,
  } as Parameters<ReturnType<typeof createTelemetryRepo>['insertToolInvocation']>[0];
}
