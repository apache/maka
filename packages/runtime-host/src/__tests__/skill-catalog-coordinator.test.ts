import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { HostSkillCatalogCoordinator } from '../server/skill-catalog-coordinator.js';
import {
  SkillCatalogRepository,
  SkillCatalogRepositoryError,
} from '../server/skill-catalog-repository.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const roots = new Set<string>();
const workspaceResolver = {
  async run<T>(
    target: { readonly kind: 'host_path'; readonly path: string },
    operation: (workspace: {
      readonly target: typeof target;
      readonly cwd: string;
      readonly projectId: null;
    }) => Promise<T>,
  ) {
    return operation({ target, cwd: target.path, projectId: null });
  },
};

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

test('multi-caller operations share one lane and drain waits for admitted work', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-skill-coordinator-'));
  roots.add(base);
  const root = join(base, 'data');
  const project = join(base, 'project');
  const home = join(base, 'home');
  const sources = join(home, '.maka', 'skill-sources');
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sources, { recursive: true }),
  ]);

  let active = 0;
  let maximumActive = 0;
  let releaseFirst!: () => void;
  let announceFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    announceFirst = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let gateArmed = true;
  const repository = new SkillCatalogRepository({
    homeDirectory: home,
    managedSourcesRoot: sources,
    runWithRoot: async (operation) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (gateArmed) {
          gateArmed = false;
          announceFirst();
          await firstGate;
        }
        return await operation(root);
      } finally {
        active -= 1;
      }
    },
  });
  const coordinator = new HostSkillCatalogCoordinator(repository, workspaceResolver);
  const input = {
    kind: 'start' as const,
    context: { workspace: { kind: 'host_path' as const, path: project } },
    view: 'governance' as const,
  };

  const first = coordinator.query(input);
  await firstEntered;
  const second = coordinator.query(input);
  coordinator.beginDrain();
  const rejected = await coordinator.query(input);
  assert.deepEqual(rejected, {
    ok: false,
    error: { code: 'host_draining', message: 'Runtime Host is draining' },
  });

  let closed = false;
  const closing = coordinator.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  releaseFirst();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  await closing;
  assert.equal(closed, true);
  assert.equal(maximumActive, 1);
  assert.equal(coordinator.close(), coordinator.close());
});

test('lifecycle recovery remains queued during drain and close waits for it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-skill-recovery-drain-'));
  roots.add(base);
  const root = join(base, 'data');
  const project = join(base, 'project');
  const home = join(base, 'home');
  await Promise.all([mkdir(root), mkdir(project), mkdir(home)]);

  let announceRecovery!: () => void;
  let releaseRecovery!: () => void;
  const recoveryEntered = new Promise<void>((resolve) => {
    announceRecovery = resolve;
  });
  const recoveryGate = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  const repository = new SkillCatalogRepository({
    homeDirectory: home,
    managedSourcesRoot: join(home, '.maka', 'skill-sources'),
    runWithRoot: async (operation) => {
      announceRecovery();
      await recoveryGate;
      return operation(root);
    },
  });
  const coordinator = new HostSkillCatalogCoordinator(repository, workspaceResolver);

  coordinator.beginDrain();
  const recovery = coordinator.recover();
  await recoveryEntered;

  let closed = false;
  const closing = coordinator.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);

  releaseRecovery();
  await recovery;
  await closing;
  assert.equal(closed, true);

  const rejected = await coordinator.query({
    kind: 'start',
    context: { workspace: { kind: 'host_path', path: project } },
    view: 'governance',
  });
  assert.deepEqual(rejected, {
    ok: false,
    error: { code: 'host_draining', message: 'Runtime Host is draining' },
  });
  await assert.rejects(
    coordinator.readCanonicalModelInventory({ projectRoot: project }),
    (error) =>
      error instanceof SkillCatalogRepositoryError &&
      error.code === 'persistence_failed' &&
      error.message === 'Runtime Host is draining',
  );
});

test('canonical model inventory uses the same revision and is deeply immutable', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-skill-model-inventory-'));
  roots.add(base);
  const root = join(base, 'data');
  const project = join(base, 'project');
  const home = join(base, 'home');
  await Promise.all([mkdir(root), mkdir(project), mkdir(home)]);
  const repository = new SkillCatalogRepository({
    homeDirectory: home,
    managedSourcesRoot: join(home, '.maka', 'skill-sources'),
    runWithRoot: async (operation) => operation(root),
  });
  const coordinator = new HostSkillCatalogCoordinator(repository, workspaceResolver);

  await coordinator.recover();
  const query = await coordinator.query({
    kind: 'start',
    context: { workspace: { kind: 'host_path', path: project } },
    view: 'governance',
  });
  assert.equal(query.ok, true);
  if (!query.ok) return;
  assert.equal(query.result.kind, 'page');
  if (query.result.kind !== 'page') return;
  assert.deepEqual(query.result.resolvedWorkspace, {
    target: { kind: 'host_path', path: project },
    hostCwd: project,
  });
  const model = await coordinator.readCanonicalModelInventory({ projectRoot: project });
  assert.equal(model.revision, query.result.revision);
  assert.equal(Object.isFrozen(model), true);
  assert.equal(Object.isFrozen(model.inventory), true);
  assert.equal(Object.isFrozen(model.diagnostics), true);
});

test('invocable pages use the authoritative Host tool surface and invalidate on capability change', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-skill-invocable-'));
  roots.add(base);
  const root = join(base, 'data');
  const project = join(base, 'project');
  const home = join(base, 'home');
  const plain = join(project, '.agents', 'skills', 'plain');
  const gated = join(project, '.agents', 'skills', 'gated');
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(plain, { recursive: true }),
    mkdir(gated, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(plain, 'SKILL.md'),
      '---\nname: Plain\ndescription: Always available.\n---\n# Plain\n',
    ),
    writeFile(
      join(gated, 'SKILL.md'),
      '---\nname: Gated\ndescription: Needs a Host tool.\nrequired-tools: [ImaginaryTool]\n---\n# Gated\n',
    ),
  ]);
  let toolNames = new Set(['Read']);
  const coordinator = new HostSkillCatalogCoordinator(
    new SkillCatalogRepository({
      homeDirectory: home,
      managedSourcesRoot: join(home, '.maka', 'skill-sources'),
      runWithRoot: async (operation) => operation(root),
    }),
    workspaceResolver,
    async () => ({ projectRoot: project, host: { toolNames } }),
  );
  const context: ConnectionContext = {
    hostEpoch: 'epoch-1',
    connectionId: 'desktop-1',
    surface: 'desktop',
    principal: 'local_os_user',
    acquireResidency: () => ({ release() {} }),
  };

  const first = await coordinator.queryInvocable(
    {
      kind: 'start',
      target: {
        kind: 'new_session',
        context: { workspace: { kind: 'host_path', path: project } },
        collaborationMode: 'agent',
        permissionMode: 'ask',
      },
    },
    context,
  );
  assert.equal(first.ok, true);
  if (!first.ok || first.result.kind !== 'page') throw new Error('Expected invocable page');
  assert.deepEqual(
    first.result.items.map((item) => item.id),
    ['plain'],
  );

  toolNames = new Set(['Read', 'ImaginaryTool']);
  const changed = await coordinator.queryInvocable(
    {
      kind: 'continue',
      target: {
        kind: 'new_session',
        context: { workspace: { kind: 'host_path', path: project } },
        collaborationMode: 'agent',
        permissionMode: 'ask',
      },
      revision: first.result.revision,
      cursor: 'stale-cursor',
    },
    context,
  );
  assert.equal(changed.ok, true);
  if (!changed.ok) throw new Error('Expected invocable revision change');
  assert.equal(changed.result.kind, 'revision_changed');
});
