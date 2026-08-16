import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  PricingCommitUnknownError,
  PricingRevisionConflictError,
  PricingStoreClosedError,
  PricingStoreNotLoadedError,
  PricingStorePublicationError,
  PricingValidationError,
} from '../pricing-store.js';
import {
  resolveStorageRoot,
  STORAGE_ROOT_MARKER_FILE,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootReader,
  tryAcquireInteractiveRootOwner,
  type StorageRootAuthorityErrorCode,
} from '../root-authority.js';
import {
  TelemetryQueryValidationError,
  TelemetryRepoClosedError,
  TelemetryRepoNotLoadedError,
  TelemetryRepoPublicationError,
} from '../telemetry-repo.js';
import {
  classifyInteractiveUsageStoresFailure,
  InteractiveUsageStoresClosedError,
  openInteractiveUsageStoresForRead,
  openInteractiveUsageStoresForWrite,
} from '../usage-stores.js';

describe('InteractiveUsageStores', () => {
  test('classifies facade failures without exposing concrete errors to callers', () => {
    assert.deepEqual(
      classifyInteractiveUsageStoresFailure(new PricingRevisionConflictError(3, 4)),
      { kind: 'revision_conflict', expectedRevision: 3, actualRevision: 4 },
    );
    for (const error of [
      new PricingValidationError('bad mutation'),
      new TelemetryQueryValidationError('bad query'),
    ]) {
      assert.deepEqual(classifyInteractiveUsageStoresFailure(error), {
        kind: 'invalid_request',
      });
    }
    for (const error of [
      new InteractiveUsageStoresClosedError(),
      new PricingStoreClosedError(),
      new TelemetryRepoClosedError(),
      new StorageRootAuthorityError('invalid_lease', 'revoked'),
      new StorageRootAuthorityError('invalid_owner', 'inauthentic'),
    ]) {
      assert.deepEqual(classifyInteractiveUsageStoresFailure(error), {
        kind: 'lifecycle',
      });
    }
    for (const error of [
      new PricingCommitUnknownError({ cause: new Error('directory sync') }),
      new TelemetryRepoPublicationError(true, { cause: new Error('directory sync') }),
    ]) {
      assert.deepEqual(classifyInteractiveUsageStoresFailure(error), {
        kind: 'commit_outcome_unknown',
        needsDrain: true,
      });
    }
    for (const error of [
      new PricingStorePublicationError({ cause: new Error('rename') }),
      new TelemetryRepoPublicationError(false, { cause: new Error('rename') }),
    ]) {
      assert.deepEqual(classifyInteractiveUsageStoresFailure(error), {
        kind: 'persistence_failed',
        needsDrain: true,
      });
    }
    for (const error of [new PricingStoreNotLoadedError(), new TelemetryRepoNotLoadedError()]) {
      assert.deepEqual(classifyInteractiveUsageStoresFailure(error), {
        kind: 'persistence_failed',
        needsDrain: false,
      });
    }
    const rootAuthorityNeedsDrain = {
      invalid_root: false,
      invalid_root_kind: false,
      root_not_found: false,
      root_unmarked: true,
      invalid_marker: true,
      root_identity_collision: true,
      root_identity_changed: true,
      invalid_repair: false,
      invalid_capability: false,
      invalid_lock_artifact: false,
      insecure_control_directory: false,
      root_io_failed: false,
      control_io_failed: false,
      lock_failed: false,
    } as const satisfies Record<
      Exclude<StorageRootAuthorityErrorCode, 'invalid_lease' | 'invalid_owner'>,
      boolean
    >;
    for (const [code, needsDrain] of Object.entries(rootAuthorityNeedsDrain)) {
      assert.deepEqual(
        classifyInteractiveUsageStoresFailure(
          new StorageRootAuthorityError(code as StorageRootAuthorityErrorCode, code),
        ),
        { kind: 'persistence_failed', needsDrain },
      );
    }

    const unknown = new Error('unknown');
    assert.deepEqual(classifyInteractiveUsageStoresFailure(unknown), {
      kind: 'unknown',
      error: unknown,
    });
  });

  test('seeds an empty pricing authority for a fresh workspace', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const stores = await openInteractiveUsageStoresForWrite(owner.lease);
      try {
        assert.deepEqual(await stores.pricing.snapshot(), { revision: 0, overrides: [] });
      } finally {
        await stores.close();
        await owner.close();
      }
    });
  });

  test('classifies a renamed or replaced live root as a draining persistence failure', {
    skip:
      process.platform === 'win32'
        ? 'Windows does not permit renaming a directory with an open SQLite database'
        : false,
  }, async () => {
    for (const replacement of [false, true]) {
      await withInteractiveRoot(async ({ root, capability }) => {
        const owner = await tryAcquireInteractiveRootOwner(capability);
        assert(owner);
        const stores = await openInteractiveUsageStoresForWrite(owner.lease);
        try {
          await rename(root, `${root}-moved`);
          if (replacement) await mkdir(root);
          await assert.rejects(
            () => stores.pricing.snapshot(),
            (error: unknown) => {
              assert.ok(error instanceof StorageRootAuthorityError);
              assert.equal(error.code, 'root_identity_changed');
              assert.deepEqual(classifyInteractiveUsageStoresFailure(error), {
                kind: 'persistence_failed',
                needsDrain: true,
              });
              return true;
            },
          );
        } finally {
          await stores.close();
          await owner.close();
        }
      });
    }
  });

  test('classifies poisoned live root markers as draining persistence failures', async () => {
    const scenarios: ReadonlyArray<{
      code: 'root_unmarked' | 'invalid_marker';
      poison(markerPath: string): Promise<void>;
    }> = [
      {
        code: 'root_unmarked',
        poison: (markerPath) => rm(markerPath),
      },
      {
        code: 'invalid_marker',
        poison: (markerPath) => writeFile(markerPath, '{'),
      },
      {
        code: 'invalid_marker',
        poison: async (markerPath) => {
          const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { kind: string };
          marker.kind = 'retired_kind';
          await writeFile(markerPath, `${JSON.stringify(marker)}\n`);
        },
      },
    ];

    for (const scenario of scenarios) {
      await withInteractiveRoot(async ({ root, capability }) => {
        const owner = await tryAcquireInteractiveRootOwner(capability);
        assert(owner);
        const stores = await openInteractiveUsageStoresForWrite(owner.lease);
        await scenario.poison(join(root, STORAGE_ROOT_MARKER_FILE));
        try {
          await assert.rejects(
            () => stores.pricing.snapshot(),
            (error: unknown) => {
              assert.ok(error instanceof StorageRootAuthorityError);
              assert.equal(error.code, scenario.code);
              assert.deepEqual(classifyInteractiveUsageStoresFailure(error), {
                kind: 'persistence_failed',
                needsDrain: true,
              });
              return true;
            },
          );
        } finally {
          await stores.close();
          await owner.close();
        }
      });
    }
  });

  test('drain waits accepted writes and rejects new admission', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const stores = await openInteractiveUsageStoresForWrite(owner.lease);
      const accepted = stores.telemetry.recordLlmCall(llmRecord());
      const drained = stores.beginDrain();

      assert.throws(
        () => stores.telemetry.recordToolInvocation(toolRecord()),
        InteractiveUsageStoresClosedError,
      );
      await Promise.all([accepted, drained]);
      await stores.close();
      await assert.rejects(
        () => readFile(join(root, 'telemetry.json'), 'utf8'),
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
      await owner.close();
      const successor = await tryAcquireInteractiveRootOwner(capability);
      assert(successor);
      const reopened = await openInteractiveUsageStoresForWrite(successor.lease);
      assert.equal((await reopened.telemetry.logs({ range: 'all' })).rows[0]?.id, 'usage_1');
      await reopened.close();
      await successor.close();
    });
  });

  test('lease-bound facade exposes separate LLM and filtered tool logs', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const stores = await openInteractiveUsageStoresForWrite(owner.lease);
      await stores.telemetry.recordLlmCall(llmRecord());
      await stores.telemetry.recordToolInvocation(toolRecord());

      assert.equal((await stores.telemetry.logs({ range: 'all' })).total, 1);
      const tools = await stores.telemetry.toolLogs({
        range: 'all',
        toolName: 'Bash',
        status: 'success',
      });
      assert.equal(tools.total, 1);
      assert.equal(tools.rows[0]?.toolName, 'Bash');
      await assert.rejects(
        () => stores.telemetry.logs({ range: 'all', toolName: 'Bash' }),
        /toolName is not applicable to LLM logs/,
      );
      await stores.close();
      await owner.close();
    });
  });

  test('every facade read observes lease revocation', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const stores = await openInteractiveUsageStoresForWrite(owner.lease);
      await owner.close();

      await assert.rejects(
        () => stores.telemetry.summary({ range: 'all' }),
        (error) => error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );
      await assert.rejects(
        () => stores.pricing.snapshot(),
        (error) => error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );
      await stores.close();
    });
  });

  test('reader close releases local resources after lease revocation', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const writer = await openInteractiveUsageStoresForWrite(owner.lease);
      await writer.close();
      await owner.close();

      const readerOwner = await tryAcquireInteractiveRootReader(capability);
      assert(readerOwner);
      const reader = await openInteractiveUsageStoresForRead(readerOwner.lease);
      await readerOwner.close();

      await assert.rejects(
        () => reader.pricing.snapshot(),
        (error) => error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );
      await reader.close();
    });
  });
});

async function withInteractiveRoot(
  run: (input: {
    root: string;
    capability: Awaited<ReturnType<typeof resolveStorageRoot<'interactive'>>>;
  }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-usage-stores-'));
  try {
    const root = join(base, 'interactive');
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    await run({ root, capability });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function llmRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'usage_1',
    providerId: 'openai',
    modelId: 'gpt-5',
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
  } as Parameters<
    Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>>['telemetry']['recordLlmCall']
  >[0];
}

function toolRecord() {
  return {
    id: 'tool_1',
    toolName: 'Bash',
    durationMs: 30,
    status: 'success',
    bytesIn: 1,
    bytesOut: 2,
    date: '2026-01-01',
    ts: Date.UTC(2026, 0, 1),
    startedAt: Date.UTC(2026, 0, 1),
  } as Parameters<
    Awaited<
      ReturnType<typeof openInteractiveUsageStoresForWrite>
    >['telemetry']['recordToolInvocation']
  >[0];
}
