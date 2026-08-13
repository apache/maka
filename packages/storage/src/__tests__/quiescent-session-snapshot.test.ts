import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  createFileQuiescentSessionSnapshotCoordinator,
  type SessionSnapshotCancellation,
  SessionSnapshotError,
  type SessionSnapshotQuiescenceAuthority,
  type SessionSnapshotStatePreparer,
  type SessionSnapshotWorkspacePreparation,
  type SessionSnapshotWorkspacePreparer,
  SESSION_SNAPSHOT_WORKSPACE_POLICY_V1,
} from '../quiescent-session-snapshot.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('prepares state and workspace under one quiescence boundary, then releases live writers', async () => {
  const fixture = await createFixture();
  let liveState = 'state-at-boundary';
  let liveWorkspace = 'workspace-at-boundary';
  const events: string[] = [];
  let quiescent = false;

  const handle = await createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    privateStagingRootAuthority,
    quiescence: {
      async runQuiescent(_input, operation) {
        assert.equal(quiescent, false);
        quiescent = true;
        events.push('enter');
        try {
          return await operation();
        } finally {
          quiescent = false;
          events.push('exit');
        }
      },
    },
    state: {
      async prepareState(input) {
        assert.equal(quiescent, true);
        events.push('state');
        await mkdir(input.destinationRoot);
        await writeFile(join(input.destinationRoot, 'runtime.sqlite'), liveState, 'utf8');
        return {
          mediaType: 'application/vnd.maka.session-state-identity+json;version=1',
          bytes: Buffer.from('{"makaSessionId":"session-1"}', 'utf8'),
        };
      },
    },
    workspace: {
      async prepareWorkspace(input) {
        assert.equal(quiescent, true);
        assert.equal(input.policy.version, 1);
        events.push('workspace');
        await mkdir(input.destinationRoot);
        await writeFile(join(input.destinationRoot, 'main.ts'), liveWorkspace, 'utf8');
        return workspaceResult({ includedEntries: 1 });
      },
    },
  }).prepare({ makaSessionId: 'session-1' });

  assert.deepEqual(events, ['enter', 'state', 'workspace', 'exit']);
  assert.equal(quiescent, false);
  assert.notEqual(handle.snapshot.stateRoot, fixture.liveStateRoot);
  assert.notEqual(handle.snapshot.workspaceRoot, fixture.liveWorkspaceRoot);
  assert.equal(
    await readFile(join(handle.snapshot.stateRoot, 'runtime.sqlite'), 'utf8'),
    liveState,
  );
  assert.equal(
    await readFile(join(handle.snapshot.workspaceRoot, 'main.ts'), 'utf8'),
    liveWorkspace,
  );

  liveState = 'later-state';
  liveWorkspace = 'later-workspace';
  assert.equal(
    await readFile(join(handle.snapshot.stateRoot, 'runtime.sqlite'), 'utf8'),
    'state-at-boundary',
  );
  assert.equal(
    await readFile(join(handle.snapshot.workspaceRoot, 'main.ts'), 'utf8'),
    'workspace-at-boundary',
  );
  assert.deepEqual(handle.workspace, workspaceResult({ includedEntries: 1 }));

  const publishedRoot = dirname(handle.snapshot.stateRoot);
  const cleanupRename = interceptSnapshotCleanupRename(publishedRoot, async () => {
    await mkdir(publishedRoot, { mode: 0o700 });
    await writeFile(join(publishedRoot, 'replacement.txt'), 'keep', 'utf8');
  });
  await Promise.all([handle.release(), handle.release()]);
  await cleanupRename.completed;
  assert.equal(await readFile(join(publishedRoot, 'replacement.txt'), 'utf8'), 'keep');
  await rm(publishedRoot, { recursive: true });
  await handle.release();
});

test('serializes concurrent preparations for the same Session through the authority contract', async () => {
  const fixture = await createFixture();
  const authority = new SerialQuiescenceAuthority();
  const firstWorkspaceEntered = deferred<void>();
  const allowFirstWorkspace = deferred<void>();
  let statePreparations = 0;

  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    privateStagingRootAuthority,
    quiescence: authority,
    state: {
      async prepareState(input) {
        statePreparations += 1;
        await mkdir(input.destinationRoot);
        return stateIdentity(input.makaSessionId);
      },
    },
    workspace: {
      async prepareWorkspace(input) {
        await mkdir(input.destinationRoot);
        if (statePreparations === 1) {
          firstWorkspaceEntered.resolve();
          await allowFirstWorkspace.promise;
        }
        return workspaceResult();
      },
    },
  });

  const first = coordinator.prepare({ makaSessionId: 'same-session' });
  await firstWorkspaceEntered.promise;
  const second = coordinator.prepare({ makaSessionId: 'same-session' });
  await Promise.resolve();
  assert.equal(statePreparations, 1);
  assert.deepEqual(authority.activeSessions, ['same-session']);

  allowFirstWorkspace.resolve();
  const firstHandle = await first;
  const secondHandle = await second;
  assert.equal(statePreparations, 2);
  assert.equal(authority.maximumConcurrentBySession.get('same-session'), 1);
  await Promise.all([firstHandle.release(), secondHandle.release()]);
});

test('does not globally serialize preparations for different Sessions', async () => {
  const fixture = await createFixture();
  const authority = new SerialQuiescenceAuthority();
  const firstWorkspaceEntered = deferred<void>();
  const allowFirstWorkspace = deferred<void>();
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    privateStagingRootAuthority,
    quiescence: authority,
    state: directoryStatePreparer,
    workspace: {
      async prepareWorkspace(input) {
        await mkdir(input.destinationRoot);
        if (input.makaSessionId === 'session-a') {
          firstWorkspaceEntered.resolve();
          await allowFirstWorkspace.promise;
        }
        return workspaceResult();
      },
    },
  });

  const first = coordinator.prepare({ makaSessionId: 'session-a' });
  await firstWorkspaceEntered.promise;
  const secondHandle = await coordinator.prepare({ makaSessionId: 'session-b' });
  assert.deepEqual(authority.activeSessions, ['session-a']);
  assert.equal(authority.maximumConcurrentBySession.get('session-a'), 1);
  assert.equal(authority.maximumConcurrentBySession.get('session-b'), 1);

  allowFirstWorkspace.resolve();
  const firstHandle = await first;
  await Promise.all([firstHandle.release(), secondHandle.release()]);
});

test('removes partial staging and preserves a stable policy rejection', async () => {
  const fixture = await createFixture();
  const rejection = new SessionSnapshotError(
    'policy_rejected',
    'Workspace snapshot policy rejected an entry',
    { details: { phase: 'workspace', policyCategory: 'known_secret_file' } },
  );
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    privateStagingRootAuthority,
    quiescence: immediateAuthority,
    state: {
      async prepareState(input) {
        await mkdir(input.destinationRoot);
        await writeFile(join(input.destinationRoot, 'runtime.sqlite'), 'partial', 'utf8');
        return stateIdentity(input.makaSessionId);
      },
    },
    workspace: {
      async prepareWorkspace() {
        throw rejection;
      },
    },
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'session-secret' }),
    (error: unknown) => error === rejection,
  );
  assert.deepEqual(await readdir(fixture.stagingParent), []);
  assert.equal(rejection.message.includes('.env'), false);
});

test('failure cleanup refuses a staging root replaced by an unrelated directory', async () => {
  const fixture = await createFixture();
  let unrelatedFile = '';
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    privateStagingRootAuthority,
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    workspace: {
      async prepareWorkspace(input) {
        const preparingRoot = dirname(input.destinationRoot);
        await rename(preparingRoot, `${preparingRoot}.displaced`);
        await mkdir(preparingRoot, { mode: 0o700 });
        unrelatedFile = join(preparingRoot, 'unrelated.txt');
        await writeFile(unrelatedFile, 'keep', 'utf8');
        throw new Error('workspace preparation failed');
      },
    },
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'failure-cleanup-owner' }),
    isSnapshotError('cleanup_failed'),
  );
  assert.equal(await readFile(unrelatedFile, 'utf8'), 'keep');
});

test('cleans a published snapshot when the authority fails while releasing quiescence', async () => {
  const fixture = await createFixture();
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    privateStagingRootAuthority,
    quiescence: {
      async runQuiescent(_input, operation) {
        await operation();
        throw new Error('authority release failed');
      },
    },
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'session-release-failure' }),
    (error: unknown) =>
      error instanceof SessionSnapshotError &&
      error.code === 'io_failure' &&
      error.message === 'Session snapshot preparation failed',
  );
  assert.deepEqual(await readdir(fixture.stagingParent), []);
});

test('cancellation and an expired deadline stop before staging begins', async () => {
  const fixture = await createFixture();
  let authorityCalls = 0;
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    privateStagingRootAuthority,
    now: () => 10_000,
    quiescence: {
      async runQuiescent(_input, operation) {
        authorityCalls += 1;
        return operation();
      },
    },
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'cancelled', signal: controller.signal }),
    isSnapshotError('snapshot_cancelled'),
  );
  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'expired', deadlineAt: 10_000 }),
    isSnapshotError('snapshot_cancelled'),
  );
  assert.equal(authorityCalls, 0);
  assert.deepEqual(await readdir(fixture.stagingParent), []);
});

test('cancellation while waiting for quiescence is propagated as snapshot_cancelled', async () => {
  const fixture = await createFixture();
  const authorityEntered = deferred<void>();
  const controller = new AbortController();
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    privateStagingRootAuthority,
    quiescence: {
      async runQuiescent(input) {
        authorityEntered.resolve();
        await waitForAbort(input.cancellation);
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    },
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });

  const preparation = coordinator.prepare({ makaSessionId: 'waiting', signal: controller.signal });
  await authorityEntered.promise;
  controller.abort();
  await assert.rejects(preparation, isSnapshotError('snapshot_cancelled'));
  assert.deepEqual(await readdir(fixture.stagingParent), []);
});

test('cancellation while leaving quiescence cleans the published snapshot', async () => {
  const fixture = await createFixture();
  const controller = new AbortController();
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    privateStagingRootAuthority,
    quiescence: {
      async runQuiescent(_input, operation) {
        const result = await operation();
        controller.abort();
        return result;
      },
    },
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'cancel-after-publish', signal: controller.signal }),
    isSnapshotError('snapshot_cancelled'),
  );
  assert.deepEqual(await readdir(fixture.stagingParent), []);
});

test('release refuses a replacement directory and remains retryable for its owned root', async () => {
  const fixture = await createFixture();
  const handle = await createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    privateStagingRootAuthority,
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  }).prepare({ makaSessionId: 'release-owner' });
  const publishedRoot = dirname(handle.snapshot.stateRoot);
  const displacedRoot = `${publishedRoot}.displaced`;
  await rename(publishedRoot, displacedRoot);
  await mkdir(publishedRoot, { mode: 0o700 });
  const unrelated = join(publishedRoot, 'unrelated.txt');
  await writeFile(unrelated, 'keep', 'utf8');

  await assert.rejects(handle.release(), isSnapshotError('cleanup_failed'));
  assert.equal(await readFile(unrelated, 'utf8'), 'keep');

  await rm(publishedRoot, { recursive: true });
  await rename(displacedRoot, publishedRoot);
  await handle.release();
  await assert.rejects(readdir(publishedRoot), isCode('ENOENT'));
});

test('release resumes an interrupted partial cleanup using the external ownership record', async () => {
  const fixture = await createFixture();
  const handle = await createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    privateStagingRootAuthority,
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  }).prepare({ makaSessionId: 'partial-release-retry' });
  const publishedRoot = dirname(handle.snapshot.stateRoot);
  const snapshotId = basename(publishedRoot).slice('snapshot-'.length);
  const ownerFile = join(fixture.stagingParent, `.snapshot-${snapshotId}.owner.json`);
  const owner = JSON.parse(await readFile(ownerFile, 'utf8')) as { ownerToken: string };
  const cleanupRoot = join(
    fixture.stagingParent,
    `.snapshot-${snapshotId}.${owner.ownerToken}.cleanup`,
  );

  await rename(publishedRoot, cleanupRoot);
  await rm(join(cleanupRoot, 'state'), { recursive: true });
  await handle.release();

  assert.deepEqual(await readdir(fixture.stagingParent), []);
});

test('creation failure cleans only the inode it created and preserves a colliding owner file', async () => {
  const fixture = await createFixture();
  const snapshotId = '00000000-0000-4000-8000-000000000001';
  const ownerFile = join(fixture.stagingParent, `.snapshot-${snapshotId}.owner.json`);
  await writeFile(ownerFile, 'unrelated', 'utf8');
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    privateStagingRootAuthority,
    newSnapshotId: () => snapshotId,
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'create-failure-cleanup' }),
    isSnapshotError('io_failure'),
  );
  assert.equal(await readFile(ownerFile, 'utf8'), 'unrelated');
  assert.deepEqual(await readdir(fixture.stagingParent), [basename(ownerFile)]);
});

test('rejects a caller-supplied workspace policy override instead of downgrading V1 safety', async () => {
  const fixture = await createFixture();
  assert.throws(
    () =>
      createFileQuiescentSessionSnapshotCoordinator({
        stagingParent: fixture.stagingParent,
        privateStagingRootAuthority,
        quiescence: immediateAuthority,
        state: directoryStatePreparer,
        workspace: directoryWorkspacePreparer,
        policy: {
          version: 1,
          classify: () => ({ kind: 'include' }),
        },
      } as Parameters<typeof createFileQuiescentSessionSnapshotCoordinator>[0]),
    /cannot be overridden/u,
  );
});

test('binds private-root verification to the exact canonical staging path', async () => {
  const fixture = await createFixture();
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    privateStagingRootAuthority: {
      async verifyPrivateStagingRoot() {
        return { canonicalPath: fixture.root };
      },
    },
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'wrong-private-root-attestation' }),
    isSnapshotError('unsafe_source'),
  );
  assert.deepEqual(await readdir(fixture.stagingParent), []);
});

test('verifies and cleans each newly created snapshot directory when platform privacy fails', async () => {
  const fixture = await createFixture();
  let verificationCalls = 0;
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    privateStagingRootAuthority: {
      async verifyPrivateStagingRoot(input) {
        verificationCalls += 1;
        return {
          canonicalPath: verificationCalls === 1 ? input.canonicalPath : fixture.stagingParent,
        };
      },
    },
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'unsafe-created-staging-root' }),
    isSnapshotError('unsafe_source'),
  );
  assert.equal(verificationCalls, 2);
  assert.deepEqual(await readdir(fixture.stagingParent), []);
});

test('requires a caller-provided Windows ACL verifier', {
  skip: process.platform !== 'win32',
}, async () => {
  const fixture = await createFixture();
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'missing-windows-acl-verifier' }),
    isSnapshotError('unsafe_source'),
  );
});

test('requires a private staging parent on POSIX', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-snapshot-public-'));
  roots.push(root);
  const stagingParent = join(root, 'staging');
  await mkdir(stagingParent, { mode: 0o755 });
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent,
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'unsafe-parent' }),
    isSnapshotError('unsafe_source'),
  );
  assert.deepEqual(await readdir(stagingParent), []);
});

test('V1 workspace policy includes portable inputs, excludes rebuildable data, and rejects secrets', () => {
  const cases = [
    ['package.json', 'file', { kind: 'include' }],
    ['pnpm-lock.yaml', 'file', { kind: 'include' }],
    ['.maka-workspace.json', 'file', { kind: 'include' }],
    ['.git/config', 'file', { kind: 'exclude', category: 'source_control' }],
    [
      'packages/app/node_modules/pkg/index.js',
      'file',
      { kind: 'exclude', category: 'dependency_tree' },
    ],
    ['.turbo/cache.bin', 'file', { kind: 'exclude', category: 'cache' }],
    ['logs/agent.txt', 'file', { kind: 'exclude', category: 'log' }],
    ['debug.log', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['.maka-runtime/input.json', 'file', { kind: 'exclude', category: 'runtime_scratch' }],
    ['.env.local', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['keys/id_ed25519', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['credentials.yaml', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['secrets.json', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['.terraformrc', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['.git-credentials.lock', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['keys/client-private-key.pem', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['certs/client.p12', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['certs/client.crt', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['keys/service-account.json', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['.ssh/config', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['.aws/credentials', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['.cargo/credentials', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['.docker/config.json', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['.kube/config', 'file', { kind: 'reject', category: 'known_secret_file' }],
    [
      '.config/gcloud/application_default_credentials.json',
      'file',
      { kind: 'reject', category: 'known_secret_file' },
    ],
    ['../escape', 'file', { kind: 'reject', category: 'unsafe_path' }],
    ['a\\b', 'file', { kind: 'reject', category: 'unsafe_path' }],
  ] as const;

  for (const [relativePath, kind, expected] of cases) {
    assert.deepEqual(
      SESSION_SNAPSHOT_WORKSPACE_POLICY_V1.classify({ relativePath, kind }),
      expected,
    );
  }
});

const immediateAuthority: SessionSnapshotQuiescenceAuthority = {
  async runQuiescent(_input, operation) {
    return operation();
  },
};

const privateStagingRootAuthority = {
  async verifyPrivateStagingRoot(input: { canonicalPath: string }) {
    return { canonicalPath: await realpath(input.canonicalPath) };
  },
};

const directoryStatePreparer: SessionSnapshotStatePreparer = {
  async prepareState(input) {
    await mkdir(input.destinationRoot);
    return stateIdentity(input.makaSessionId);
  },
};

const directoryWorkspacePreparer: SessionSnapshotWorkspacePreparer = {
  async prepareWorkspace(input) {
    await mkdir(input.destinationRoot);
    return workspaceResult();
  },
};

function stateIdentity(makaSessionId: string) {
  return {
    mediaType: 'application/vnd.maka.session-state-identity+json;version=1',
    bytes: Buffer.from(JSON.stringify({ makaSessionId }), 'utf8'),
  };
}

function workspaceResult(
  overrides: Partial<SessionSnapshotWorkspacePreparation> = {},
): SessionSnapshotWorkspacePreparation {
  return {
    includedEntries: 0,
    excludedEntries: 0,
    excludedEntriesByCategory: {
      dependency_tree: 0,
      source_control: 0,
      cache: 0,
      log: 0,
      runtime_scratch: 0,
    },
    payloadBytes: 0,
    ...overrides,
  };
}

async function createFixture(): Promise<{
  root: string;
  stagingParent: string;
  liveStateRoot: string;
  liveWorkspaceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-snapshot-'));
  roots.push(root);
  const stagingParent = join(root, 'staging');
  const liveStateRoot = join(root, 'live-state');
  const liveWorkspaceRoot = join(root, 'live-workspace');
  await Promise.all([
    mkdir(stagingParent, { mode: 0o700 }),
    mkdir(liveStateRoot),
    mkdir(liveWorkspaceRoot),
  ]);
  return { root, stagingParent, liveStateRoot, liveWorkspaceRoot };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class SerialQuiescenceAuthority implements SessionSnapshotQuiescenceAuthority {
  readonly activeSessions: string[] = [];
  readonly maximumConcurrentBySession = new Map<string, number>();
  readonly #tails = new Map<string, Promise<void>>();
  readonly #activeBySession = new Map<string, number>();

  async runQuiescent<T>(
    input: { makaSessionId: string; cancellation: SessionSnapshotCancellation },
    operation: () => Promise<T>,
  ): Promise<T> {
    const predecessor = this.#tails.get(input.makaSessionId) ?? Promise.resolve();
    const release = deferred<void>();
    const tail = predecessor.catch(() => {}).then(() => release.promise);
    this.#tails.set(input.makaSessionId, tail);
    await predecessor;
    if (input.cancellation.signal.aborted) throw Object.assign(new Error(), { name: 'AbortError' });

    const active = (this.#activeBySession.get(input.makaSessionId) ?? 0) + 1;
    this.#activeBySession.set(input.makaSessionId, active);
    this.maximumConcurrentBySession.set(
      input.makaSessionId,
      Math.max(this.maximumConcurrentBySession.get(input.makaSessionId) ?? 0, active),
    );
    this.activeSessions.push(input.makaSessionId);
    try {
      return await operation();
    } finally {
      this.activeSessions.splice(this.activeSessions.indexOf(input.makaSessionId), 1);
      this.#activeBySession.set(input.makaSessionId, active - 1);
      release.resolve();
      if (this.#tails.get(input.makaSessionId) === tail) this.#tails.delete(input.makaSessionId);
    }
  }
}

async function waitForAbort(cancellation: SessionSnapshotCancellation): Promise<void> {
  if (cancellation.signal.aborted) return;
  await new Promise<void>((resolve) => {
    cancellation.signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function isSnapshotError(code: SessionSnapshotError['code']): (error: unknown) => boolean {
  return (error) => error instanceof SessionSnapshotError && error.code === code;
}

function isCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function interceptSnapshotCleanupRename(
  publishedRoot: string,
  afterRename: () => Promise<void>,
): { completed: Promise<void> } {
  const stagingParent = dirname(publishedRoot);
  const expectedName = basename(publishedRoot);
  let resolveCompleted!: () => void;
  let rejectCompleted!: (error: unknown) => void;
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  const observer = async () => {
    try {
      while (true) {
        const names = await readdir(stagingParent);
        if (!names.includes(expectedName)) {
          await afterRename();
          resolveCompleted();
          return;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      rejectCompleted(error);
    }
  };
  void observer();
  return { completed };
}
