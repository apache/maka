import { defineInteractiveRuntimeHostComposition } from '../server/host-composition.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { connectRuntimeHost, type RuntimeHostConnection } from '../client/index.js';
import {
  RUNTIME_HOST_PROTOCOL_VERSION,
  type ClientSurface,
  type SkillCatalogQueryResult,
} from '../protocol/index.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import { RuntimeHostKernel } from '../server/index.js';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;
const REQUEST_TIMEOUT_MS = 5_000;

test('two UDS clients converge on one lease-bound Skill catalog authority', {
  skip: process.platform === 'win32',
  timeout: 20_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-skill-catalog-two-client-'));
  const dataRoot = join(base, 'data-root');
  const projectRoot = join(base, 'project');
  const isolatedHome = join(base, 'home');
  const skillDirectory = join(projectRoot, '.maka', 'skills', 'private-project-skill');
  const skillPath = join(skillDirectory, 'SKILL.md');
  const privateMarker = 'PRIVATE_SKILL_BODY_MARKER_9df86eae';
  const skillBody = `---
name: Private Project Skill
description: Public catalog description
allowed-tools: Read
---

# Private Project Skill

Keep ${privateMarker} inside the lazy-loaded body.
`;
  const skillHash = createHash('sha256').update(skillBody).digest('hex');
  const previousHome = process.env.HOME;
  let host: RuntimeHostKernel | undefined;
  const connections: RuntimeHostConnection[] = [];
  let rootId: string | undefined;
  let endpoint: string | undefined;

  process.env.HOME = isolatedHome;
  try {
    await mkdir(isolatedHome, { recursive: true });
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(skillPath, skillBody);

    const capability = await resolveStorageRoot({
      path: dataRoot,
      kind: 'interactive',
    });
    rootId = capability.rootId;
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner, 'the test must acquire the real Interactive root lease');

    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 30_000,
      composition: defineInteractiveRuntimeHostComposition(createExecutionRuntimeHostComposition),
    });
    endpoint = host.endpoint;

    const [desktop, tui] = await Promise.all([
      connectClient(dataRoot, 'desktop'),
      connectClient(dataRoot, 'tui'),
    ]);
    connections.push(desktop, tui);

    const query = {
      kind: 'start',
      context: { workspace: { kind: 'host_path', path: projectRoot } },
      view: 'governance',
    } as const;
    const [desktopInitial, tuiInitial] = await Promise.all([
      desktop.request('skill.catalog.query', query, REQUEST_TIMEOUT_MS),
      tui.request('skill.catalog.query', query, REQUEST_TIMEOUT_MS),
    ]);
    const desktopPage = requirePage(desktopInitial);
    const tuiPage = requirePage(tuiInitial);
    assert.equal(desktopPage.revision, tuiPage.revision);
    const canonicalProjectRoot = await realpath(projectRoot);
    const expectedWorkspace = {
      target: { kind: 'host_path' as const, path: canonicalProjectRoot },
      hostCwd: canonicalProjectRoot,
    };
    assert.deepEqual(desktopPage.resolvedWorkspace, expectedWorkspace);
    assert.deepEqual(tuiPage.resolvedWorkspace, expectedWorkspace);
    assert.ok(
      desktopPage.items.some(
        (item) => item.kind === 'skill' && item.ref === 'project:maka:private-project-skill',
      ),
    );

    const { resolvedWorkspace: _desktopWorkspace, ...desktopMetadata } = desktopPage;
    const { resolvedWorkspace: _tuiWorkspace, ...tuiMetadata } = tuiPage;
    const wireJson = JSON.stringify([desktopMetadata, tuiMetadata]);
    for (const value of nestedStrings(JSON.parse(wireJson))) {
      assert.equal(isAbsolute(value), false, `wire projection leaked absolute path ${value}`);
    }
    for (const secret of [
      dataRoot,
      projectRoot,
      isolatedHome,
      privateMarker,
      skillBody,
      skillHash,
      `sha256:${skillHash}`,
    ]) {
      assert.equal(wireJson.includes(secret), false, `wire projection leaked ${secret}`);
    }

    const expectedRevision = desktopPage.revision;
    const mutation = {
      context: { workspace: { kind: 'host_path', path: projectRoot } },
      expectedRevision,
      mutation: { kind: 'create_starter' },
    } as const;
    const mutationResults = await Promise.all([
      desktop.request('skill.catalog.mutate', mutation, REQUEST_TIMEOUT_MS),
      tui.request('skill.catalog.mutate', mutation, REQUEST_TIMEOUT_MS),
    ]);
    assert.deepEqual(mutationResults.map((result) => result.kind).sort(), [
      'committed',
      'revision_conflict',
    ]);
    const committed = mutationResults.find((result) => result.kind === 'committed');
    const conflict = mutationResults.find((result) => result.kind === 'revision_conflict');
    assert.ok(committed && committed.kind === 'committed');
    assert.ok(conflict && conflict.kind === 'revision_conflict');
    assert.equal(conflict.expectedRevision, expectedRevision);
    assert.equal(conflict.actualRevision, committed.revision);

    const [desktopFinal, tuiFinal] = await Promise.all([
      desktop.request('skill.catalog.query', query, REQUEST_TIMEOUT_MS),
      tui.request('skill.catalog.query', query, REQUEST_TIMEOUT_MS),
    ]);
    assert.deepEqual(desktopFinal, tuiFinal);
    const finalPage = requirePage(desktopFinal);
    assert.equal(finalPage.revision, committed.revision);
    assert.ok(
      finalPage.items.some(
        (item) =>
          item.kind === 'skill' &&
          item.ref === 'workspace:legacy:starter-skill' &&
          item.id === 'starter-skill',
      ),
    );

    const projectSkillBeforeDelete = await readFile(skillPath, 'utf8');
    const blockedDelete = await desktop.request(
      'skill.catalog.mutate',
      {
        context: { workspace: { kind: 'host_path', path: projectRoot } },
        expectedRevision: finalPage.revision,
        mutation: { kind: 'delete', ref: 'project:maka:private-project-skill' },
      },
      REQUEST_TIMEOUT_MS,
    );
    assert.deepEqual(blockedDelete, {
      kind: 'rejected',
      reason: 'blocked_scope',
      resolvedWorkspace: expectedWorkspace,
    });
    assert.equal(await readFile(skillPath, 'utf8'), projectSkillBeforeDelete);
  } finally {
    const cleanupErrors: unknown[] = [];
    const connectionClosures = await Promise.allSettled(
      connections.map((connection) => connection.close()),
    );
    for (const closure of connectionClosures) {
      if (closure.status === 'rejected') cleanupErrors.push(closure.reason);
    }
    await host?.close().catch((error: unknown) => cleanupErrors.push(error));
    if (endpoint)
      await assert.rejects(lstat(endpoint), { code: 'ENOENT' }).catch((error: unknown) => {
        cleanupErrors.push(error);
      });
    if (rootId)
      await rm(join(resolveRootControlNamespace(), rootId), {
        recursive: true,
        force: true,
      }).catch((error: unknown) => cleanupErrors.push(error));
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(base, { recursive: true, force: true }).catch((error: unknown) =>
      cleanupErrors.push(error),
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Skill catalog UDS test cleanup failed');
    }
  }
});

async function connectClient(
  rootPath: string,
  surface: ClientSurface,
): Promise<RuntimeHostConnection> {
  const result = await connectRuntimeHost({
    rootPath,
    surface,
    protocol: PROTOCOL,
    connectTimeoutMs: REQUEST_TIMEOUT_MS,
    handshakeTimeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (result.kind !== 'connected') {
    throw new Error(`Runtime Host Client did not connect: ${result.kind}`);
  }
  return result.connection;
}

function requirePage(
  result: SkillCatalogQueryResult,
): Extract<SkillCatalogQueryResult, { kind: 'page' }> {
  assert.equal(result.kind, 'page');
  if (result.kind !== 'page') throw new Error('expected a Skill catalog page');
  return result;
}

function* nestedStrings(value: unknown): Generator<string> {
  if (typeof value === 'string') {
    yield value;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* nestedStrings(item);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) yield* nestedStrings(item);
  }
}
