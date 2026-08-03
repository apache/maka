import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { AgentRunHeader } from '@maka/core';
import { createInMemoryTaskRunStore, runTaskOnce } from '@maka/headless';
import type { SessionInspectDocument } from '@maka/runtime';
import type { RuntimeHostConnection } from '@maka/runtime-host/client';
import { createSessionStore } from '@maka/storage';
import { createSqliteAgentRunStore, createWorkspaceRuntimeStore } from '@maka/storage';
import {
  openHeadlessExecutionStoresForWrite,
  openInteractiveExecutionStoresForWrite,
} from '@maka/storage/execution-stores';
import {
  createHeadlessRootLease,
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import {
  inspectResolvedTarget,
  resolveInspectTarget,
  runMakaInspectCli,
  type InspectCommandDependencies,
  withInspectCommandStores,
} from '../inspect-command.js';

describe('unified inspect target resolution', () => {
  test('does not guess when one id names multiple entity kinds and AgentRuns', async () => {
    await withStores(async (stores) => {
      const first = await createSession(stores, 'First');
      const second = await createSession(stores, 'Second');
      const sharedId = first.id;
      await stores.agentRunStore.createRun(runHeader(first.id, sharedId));
      await stores.agentRunStore.createRun(runHeader(second.id, sharedId));
      await stores.taskRunStore.appendEvent(sharedId, {
        type: 'task_run_created',
        id: 'task-created',
        taskRunId: sharedId,
        ts: 1,
        taskId: 'task-1',
        configId: 'config-1',
      });

      const resolution = await resolveInspectTarget(stores, { id: sharedId });

      assert.equal(resolution.status, 'ambiguous');
      const agentSessionIds = [first.id, second.id].sort();
      assert.deepEqual(resolution.document.candidates, [
        { kind: 'agent-run', id: sharedId, sessionId: agentSessionIds[0] },
        { kind: 'agent-run', id: sharedId, sessionId: agentSessionIds[1] },
        { kind: 'session', id: sharedId },
        { kind: 'task-run', id: sharedId },
      ]);
    });
  });

  test('uses explicit kind and Session to resolve duplicate AgentRun ids', async () => {
    await withStores(async (stores) => {
      const first = await createSession(stores, 'First');
      const second = await createSession(stores, 'Second');
      await stores.agentRunStore.createRun(runHeader(first.id, 'run-shared'));
      await stores.agentRunStore.createRun(runHeader(second.id, 'run-shared'));

      const ambiguous = await resolveInspectTarget(stores, {
        id: 'run-shared',
        requestedKind: 'agent-run',
      });
      assert.equal(ambiguous.status, 'ambiguous');

      const resolved = await resolveInspectTarget(stores, {
        id: 'run-shared',
        requestedKind: 'agent-run',
        sessionId: second.id,
      });
      assert.equal(resolved.status, 'resolved');
      if (resolved.status !== 'resolved') return;
      const document = await inspectResolvedTarget(stores, resolved.candidate);
      assert.equal(document.kind, 'agent_run');
      if (document.kind !== 'agent_run') return;
      assert.equal(document.agentRun.sessionId, second.id);
    });
  });

  test('returns a stable not-found resolution document', async () => {
    await withStores(async (stores) => {
      const resolution = await resolveInspectTarget(stores, { id: 'missing' });
      assert.equal(resolution.status, 'not_found');
      assert.deepEqual(resolution.document, {
        schemaVersion: 'maka.inspect_resolution.v1',
        kind: 'inspect_resolution',
        query: { id: 'missing' },
        status: 'not_found',
        candidates: [],
      });
    });
  });
});

describe('inspect CLI storage authority boundary', () => {
  test('inspects a marked headless root through authenticated readers', async () => {
    await withDiskRoot('maka-inspect-headless-', async (root) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'headless' });
      const stores = await openHeadlessExecutionStoresForWrite(
        createHeadlessRootLease(capability, 'write'),
      );
      const session = await stores.sessionStore.create(sessionInput('Headless session'));
      const sessionOutput = captureIo();

      assert.equal(
        await runMakaInspectCli([session.id, '--store', root, '--json'], sessionOutput.io),
        0,
      );
      assert.equal(sessionOutput.stderr(), '');
      assert.equal((JSON.parse(sessionOutput.stdout()) as { kind: string }).kind, 'session');

      const taskRunId = 'headless-task-run';
      const run = await runTaskOnce(
        {
          id: 'inspect-config',
          backend: 'fake',
          llmConnectionSlug: 'fake',
          model: 'fake-model',
        },
        {
          id: 'inspect-task',
          instruction: 'Create an inspectable TaskRun.',
          workspaceDir: root,
          verification: { command: 'true', protectedPaths: [] },
        },
        { storageRoot: root, taskRunId },
      );
      assert.equal(run.projection.status, 'completed');

      const taskOutput = captureIo();
      assert.equal(
        await runMakaInspectCli(
          [taskRunId, '--store', root, '--kind', 'task-run', '--json'],
          taskOutput.io,
        ),
        0,
      );
      assert.equal(taskOutput.stderr(), '');
      assert.equal((JSON.parse(taskOutput.stdout()) as { kind: string }).kind, 'task_run');
    });
  });

  test('inspects a marked interactive root without exposing TaskRun resolution', async () => {
    await withDiskRoot('maka-inspect-interactive-', async (root) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      const writer = await openInteractiveExecutionStoresForWrite(owner.lease);
      const session = await writer.sessionStore.create(sessionInput('Interactive session'));
      await owner.close();

      await withInspectCommandStores(root, async (stores) => {
        assert.equal(stores.taskRunStore, undefined);
        const taskResolution = await resolveInspectTarget(stores, {
          id: session.id,
          requestedKind: 'task-run',
        });
        assert.equal(taskResolution.status, 'not_found');
      });
      const successor = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(successor);
      await successor.close();

      const output = captureIo();
      assert.equal(await runMakaInspectCli([session.id, '--store', root, '--json'], output.io), 0);
      assert.equal((JSON.parse(output.stdout()) as { kind: string }).kind, 'session');
    });
  });

  test('rejects unmarked and invalid roots with typed authority errors', async () => {
    await withDiskRoot('maka-inspect-unmarked-', async (root) => {
      await assert.rejects(
        () => withInspectCommandStores(root, async () => undefined),
        authorityError('root_unmarked'),
      );

      const output = captureIo();
      assert.equal(await runMakaInspectCli(['missing', '--store', root], output.io), 1);
      assert.match(output.stderr(), /Initialize it through its owning Maka write command/);
      assert.doesNotMatch(output.stderr(), /StorageRootAuthorityError|\n\s+at /);

      const invalidRoot = join(root, 'not-a-directory');
      await writeFile(invalidRoot, 'invalid\n');
      await assert.rejects(
        () => withInspectCommandStores(invalidRoot, async () => undefined),
        authorityError('invalid_root'),
      );
    });
  });

  test('fails AgentRun inspection closed when root identity changes after resolution', async () => {
    await withDiskRoot('maka-inspect-identity-', async (base) => {
      const root = join(base, 'root');
      const displaced = join(base, 'displaced-root');
      await mkdir(root);
      const capability = await resolveStorageRoot({ path: root, kind: 'headless' });
      const writer = await openHeadlessExecutionStoresForWrite(
        createHeadlessRootLease(capability, 'write'),
      );
      const session = await writer.sessionStore.create(sessionInput('Identity change'));
      await writer.agentRunStore.createRun(runHeader(session.id, 'run-identity-change'));

      await withInspectCommandStores(root, async (stores) => {
        const resolution = await resolveInspectTarget(stores, {
          id: 'run-identity-change',
          requestedKind: 'agent-run',
          sessionId: session.id,
        });
        assert.equal(resolution.status, 'resolved');
        if (resolution.status !== 'resolved') return;

        await rename(root, displaced);
        await mkdir(root);
        await assert.rejects(
          () => inspectResolvedTarget(stores, resolution.candidate),
          authorityError('root_identity_changed'),
        );
      });
    });
  });

  test('fails closed with a typed error when the interactive reader lock is unavailable', async () => {
    await withDiskRoot('maka-inspect-locked-', async (root) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      try {
        await assert.rejects(
          () => withInspectCommandStores(root, async () => undefined),
          authorityError('lock_failed'),
        );
      } finally {
        await owner.close();
      }
    });
  });

  test('routes an exclusively locked Interactive root through the existing Runtime Host', async () => {
    await withDiskRoot('maka-inspect-live-host-', async (root) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      const writer = await openInteractiveExecutionStoresForWrite(owner.lease);
      const session = await writer.sessionStore.create(sessionInput('Live Host session'));
      const requests: string[] = [];
      const connection = {
        request: async (operation: string) => {
          requests.push(operation);
          if (operation === 'execution.inspect.resolve') {
            return {
              status: 'resolved',
              candidates: [{ kind: 'session', id: session.id }],
              truncated: false,
            };
          }
          if (operation === 'execution.inspect.query') {
            return { kind: 'session', document: sessionInspectDocument(session.id) };
          }
          throw new Error(`Unexpected operation: ${operation}`);
        },
        close: async () => undefined,
      } as unknown as RuntimeHostConnection;
      const dependencies: InspectCommandDependencies = {
        connectExistingHost: (async () => ({
          kind: 'connected',
          connection,
          registration: {
            kind: 'maka-runtime-host',
            schemaVersion: 1,
            rootId: capability.rootId,
            hostEpoch: 'host-1',
            endpoint: '/tmp/runtime-host.sock',
            protocolMin: 0,
            protocolMax: 0,
            state: 'ready',
            pid: 1,
            createdAt: new Date(0).toISOString(),
          },
        })) as InspectCommandDependencies['connectExistingHost'],
      };
      const output = captureIo();
      try {
        assert.equal(
          await runMakaInspectCli([session.id, '--store', root, '--json'], output.io, dependencies),
          0,
        );
        assert.equal(output.stderr(), '');
        assert.equal((JSON.parse(output.stdout()) as { kind: string }).kind, 'session');
        assert.deepEqual(requests, ['execution.inspect.resolve', 'execution.inspect.query']);
      } finally {
        await writer.sessionStore.close?.();
        await owner.close();
      }
    });
  });

  test('reports an unavailable live Host without exposing a stack', async () => {
    await withDiskRoot('maka-inspect-live-host-unavailable-', async (root) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      const output = captureIo();
      try {
        const dependencies: InspectCommandDependencies = {
          connectExistingHost: (async () => ({
            kind: 'unavailable',
            reason: 'connect_failed',
          })) as InspectCommandDependencies['connectExistingHost'],
        };
        assert.equal(
          await runMakaInspectCli(['missing', '--store', root], output.io, dependencies),
          1,
        );
        assert.match(output.stderr(), /Runtime Host is unavailable \(connect_failed\)/);
        assert.doesNotMatch(output.stderr(), /LiveInspectError|\n\s+at /);
      } finally {
        await owner.close();
      }
    });
  });
});

type InspectCommandTestStores = {
  sessionStore: ReturnType<typeof createSessionStore>;
  agentRunStore: ReturnType<typeof createSqliteAgentRunStore>;
  runtimeEventStore: ReturnType<typeof createWorkspaceRuntimeStore>;
  taskRunStore: ReturnType<typeof createInMemoryTaskRunStore>;
};

async function createSession(stores: InspectCommandTestStores, name: string) {
  return stores.sessionStore.create(sessionInput(name));
}

function sessionInput(name: string) {
  return {
    cwd: '/tmp/workspace',
    name,
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
  } as const;
}

function runHeader(sessionId: string, runId: string): AgentRunHeader {
  return {
    runId,
    sessionId,
    turnId: `turn-${sessionId}`,
    status: 'completed',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/workspace',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 2,
    completedAt: 2,
  };
}

function sessionInspectDocument(sessionId: string): SessionInspectDocument {
  return {
    schemaVersion: 'maka.session_inspect.v1',
    kind: 'session',
    session: {
      sessionId,
      name: 'Live Host session',
      status: 'active',
      createdAt: 1,
      lastUsedAt: 1,
      isArchived: false,
    },
    agentRuns: [],
    diagnostics: [],
  };
}

async function withStores(run: (stores: InspectCommandTestStores) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-unified-inspect-'));
  try {
    await run({
      sessionStore: createSessionStore(root),
      agentRunStore: createSqliteAgentRunStore(root),
      runtimeEventStore: createWorkspaceRuntimeStore(root),
      taskRunStore: createInMemoryTaskRunStore(),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withDiskRoot(prefix: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function authorityError(code: StorageRootAuthorityError['code']) {
  return (error: unknown) => error instanceof StorageRootAuthorityError && error.code === code;
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: { write: (value: string) => stdout.push(value) },
      stderr: { write: (value: string) => stderr.push(value) },
    },
    stdout: () => stdout.join(''),
    stderr: () => stderr.join(''),
  };
}
