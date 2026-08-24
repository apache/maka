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

import { RuntimeHostProtocolError } from '../protocol/errors.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  BUNDLED_SKILL_CATALOG,
  buildStarterSkillTemplate,
  createManagedSkillLock,
} from '@maka/runtime/skills';
import { decodeHostFrame, isSkillCatalogProjectRootLexicallyAbsolute } from '../protocol/index.js';
import type {
  SkillCatalogGovernanceItem,
  SkillCatalogQueryResult,
  SkillCatalogRevision,
} from '../protocol/index.js';
import {
  SkillCatalogRepository,
  SkillCatalogRepositoryError,
  type SkillCatalogLocalContext,
  type SkillCatalogRepositoryOptions,
} from '../server/skill-catalog-repository.js';
import {
  type SkillCatalogTransactionFailpoint,
  type SkillCatalogTransactionOptions,
} from '../server/skill-catalog-transaction.js';

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

test('revision is stable, project-bound, excludes state timestamps, and tracks external content', async () => {
  const fixture = await createFixture();
  await createSkill(join(fixture.project, '.maka', 'skills'), 'alpha', skillBody('Alpha', 'one'));
  const repository = fixture.repository();

  const first = await start(repository, fixture.project, 'governance');
  const repeated = await start(repository, fixture.project, 'governance');
  assert.equal(repeated.revision, first.revision);

  await mkdir(join(fixture.root, '.maka'), { recursive: true });
  await writeFile(
    join(fixture.root, '.maka', 'skills-state.json'),
    stateFile('project:maka:alpha', true, false, '2026-01-01T00:00:00.000Z'),
  );
  const withState = await start(repository, fixture.project, 'governance');
  await writeFile(
    join(fixture.root, '.maka', 'skills-state.json'),
    stateFile('project:maka:alpha', true, false, '2027-02-02T00:00:00.000Z'),
  );
  const timestampOnly = await start(repository, fixture.project, 'governance');
  assert.equal(timestampOnly.revision, withState.revision);

  await writeFile(
    join(fixture.project, '.maka', 'skills', 'alpha', 'SKILL.md'),
    skillBody('Alpha', 'externally changed'),
  );
  const changed = await start(repository, fixture.project, 'governance');
  assert.notEqual(changed.revision, timestampOnly.revision);

  const otherProject = await tempDirectory('maka-skill-other-project-');
  await createSkill(
    join(otherProject, '.maka', 'skills'),
    'alpha',
    skillBody('Alpha', 'externally changed'),
  );
  const other = await start(repository, otherProject, 'governance');
  assert.notEqual(other.revision, changed.revision);
});

test('continuation pages are pinned to a freshly scanned revision', async () => {
  const fixture = await createFixture();
  const root = join(fixture.project, '.maka', 'skills');
  for (let index = 0; index < 140; index += 1) {
    const id = `skill-${String(index).padStart(3, '0')}`;
    await createSkill(root, id, skillBody(`Skill ${index}`, `Description ${index}`));
  }
  const repository = fixture.repository();
  const first = await start(repository, fixture.project, 'governance');
  assert.ok(first.nextCursor);
  assert.ok(first.items.length <= 128);
  assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') <= 48 * 1024);

  await writeFile(
    join(root, 'skill-139', 'SKILL.md'),
    skillBody('Skill 139', 'changed between pages'),
  );
  const continued = await repository.query({
    kind: 'continue',
    view: 'governance',
    revision: first.revision,
    cursor: first.nextCursor,
  });
  assert.equal(continued.kind, 'revision_changed');
  if (continued.kind === 'revision_changed') {
    assert.equal(continued.expectedRevision, first.revision);
    assert.notEqual(continued.actualRevision, first.revision);
  }
});

test('continuation rejects a cursor at the exact end of the current view', async () => {
  const fixture = await createFixture();
  await createSkill(
    join(fixture.project, '.maka', 'skills'),
    'only-skill',
    skillBody('Only Skill', 'one item'),
  );
  const repository = fixture.repository();
  const page = await start(repository, fixture.project, 'governance');
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, null);

  const endCursor = Buffer.from(
    JSON.stringify({ v: 1, view: 'governance', offset: page.items.length }),
    'utf8',
  ).toString('base64url');
  await assert.rejects(
    repository.query({
      kind: 'continue',
      view: 'governance',
      revision: page.revision,
      cursor: endCursor,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SkillCatalogRepositoryError);
      assert.equal(error.code, 'invalid_request');
      return true;
    },
  );
});

test('governance context status contains structural facts without synthetic budget ranks', async () => {
  const fixture = await createFixture();
  await createSkill(
    join(fixture.project, '.maka', 'skills'),
    'active',
    skillBody('Active', 'advertised structurally'),
  );
  await createSkill(
    join(fixture.project, '.maka', 'skills'),
    'duplicate',
    skillBody('Project Duplicate', 'winner'),
  );
  await createSkill(
    join(fixture.root, 'skills'),
    'duplicate',
    skillBody('Workspace Duplicate', 'shadowed'),
  );
  await createSkill(
    join(fixture.root, 'skills'),
    'disabled',
    skillBody('Disabled', 'disabled by state'),
  );
  await createSkill(
    join(fixture.project, '.agents', 'skills'),
    'invalid',
    '# missing frontmatter\n',
  );
  await mkdir(join(fixture.root, '.maka'), { recursive: true });
  await writeFile(
    join(fixture.root, '.maka', 'skills-state.json'),
    stateFile('workspace:legacy:disabled', false, false, '2026-01-01T00:00:00.000Z'),
  );
  const page = await start(fixture.repository(), fixture.project, 'governance');

  assert.equal(governanceItem(page, 'project:maka:active').contextStatus, 'unknown');
  assert.equal(governanceItem(page, 'workspace:legacy:disabled').contextStatus, 'disabled');
  assert.equal(governanceItem(page, 'workspace:legacy:duplicate').contextStatus, 'shadowed');
  assert.equal(governanceItem(page, 'project:agents:invalid').contextStatus, 'invalid');
  for (const item of page.items) {
    if (item.kind === 'skill' || item.kind === 'discovery_diagnostic') {
      assert.equal(item.contextRank, null);
      assert.notEqual(item.contextStatus, 'budget');
      assert.notEqual(item.contextStatus, 'host_incompatible');
      assert.notEqual(item.contextStatus, 'advertised');
      if (item.contextStatus === 'unknown') assert.equal(item.contextRank, null);
    }
  }
});

test('removed bundled sources lose provenance trust without disabling the local copy', async () => {
  const fixture = await createFixture();
  const id = 'retired-bundled-skill';
  const content = skillBody('Retired Bundled Skill', 'installed by an older Maka release');
  const skillDirectory = await createSkill(join(fixture.root, 'skills'), id, content);
  await writeFile(
    join(skillDirectory, 'skill.lock.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      id,
      sourceType: 'bundled',
      sourceName: 'maka-bundled',
      sourceVersion: '1',
      contentSha256: sha256(content),
      installedAt: '2026-07-01T00:00:00.000Z',
    })}\n`,
  );
  const repository = fixture.repository();

  const governance = await start(repository, fixture.project, 'governance');
  const installed = governanceItem(governance, `workspace:legacy:${id}`);
  assert.equal(installed.validationStatus, 'metadata_error');
  assert.deepEqual(installed.validationCodes, ['unsupported_schema']);
  assert.equal(installed.runtimeStatus, 'enabled');
  assert.equal(installed.enabled, true);

  const invocable = await repository.queryInvocable(
    { kind: 'start' },
    { projectRoot: fixture.project },
    { toolNames: new Set(['Read']) },
  );
  assert.equal(invocable.kind, 'page');
  if (invocable.kind !== 'page') return;
  assert.deepEqual(
    invocable.items.map((item) => item.id),
    [id],
  );
  assert.equal(await readFile(join(skillDirectory, 'SKILL.md'), 'utf8'), content);
});

test('bounds oversized metadata with an explicit diagnostic and encodable mutation result', async () => {
  const fixture = await createFixture();
  const sourceId = 'oversized-metadata';
  const content = skillBodyWithTools('N'.repeat(300), 65, 'T'.repeat(300));
  await createSkill(fixture.sources, sourceId, content);
  const repository = fixture.repository();
  const initial = await start(repository, fixture.project, 'managed_sources');
  assert.equal(initial.items[0]?.kind, 'managed_source');
  if (initial.items[0]?.kind === 'managed_source') {
    assert.equal(initial.items[0].metadataTruncated, true);
  }

  const committed = await repository.mutate({
    expectedRevision: initial.revision,
    mutation: { kind: 'install', sourceType: 'managed', sourceId },
  });
  assert.equal(committed.kind, 'committed');
  if (committed.kind !== 'committed') return;
  assert.equal(committed.entry?.metadataTruncated, true);
  assert.equal(committed.entry?.declaredTools.length, 64);
  assert.ok(committed.entry?.declaredTools.every((tool) => Buffer.byteLength(tool) <= 256));
  assert.ok(committed.entry?.validationCodes.includes('projection_truncated'));
  const frame = {
    requestId: 'metadata-projection',
    operation: 'skill.catalog.mutate' as const,
    ok: true as const,
    result: { ...committed, resolvedWorkspace: workspaceProjection(fixture.project) },
  };
  assert.deepEqual(decodeHostFrame(frame), frame);

  const page = await start(repository, fixture.project, 'governance');
  assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 48 * 1024);
  assert.equal(governanceItem(page, `workspace:legacy:${sourceId}`).metadataTruncated, true);
});

test('external project sources are read-only while Data Root preferences use durable schema v2', async () => {
  const fixture = await createFixture();
  const skillPath = await createSkill(
    join(fixture.project, '.agents', 'skills'),
    'external',
    skillBody('External', 'read only'),
  );
  const repository = fixture.repository();
  const first = await start(repository, fixture.project, 'governance');
  const external = governanceItem(first, 'project:agents:external');

  const rejected = await repository.mutate({
    expectedRevision: first.revision,
    mutation: { kind: 'delete', ref: external.ref },
  });
  assert.deepEqual(rejected, { kind: 'rejected', reason: 'blocked_scope' });
  assert.match(await readFile(join(skillPath, 'SKILL.md'), 'utf8'), /External/);

  const committed = await repository.mutate({
    expectedRevision: first.revision,
    mutation: { kind: 'set_enabled', ref: external.ref, enabled: false },
  });
  assert.equal(committed.kind, 'committed');
  const state = JSON.parse(
    await readFile(join(fixture.root, '.maka', 'skills-state.json'), 'utf8'),
  ) as { schemaVersion: number; skills: Record<string, { enabled: boolean }> };
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.skills[external.ref]?.enabled, false);
  assert.match(await readFile(join(skillPath, 'SKILL.md'), 'utf8'), /External/);
});

test('noncanonical external ids remain wire-safe governance entries', async () => {
  const fixture = await createFixture();
  await createSkill(
    join(fixture.project, '.maka', 'skills'),
    'valid skill',
    skillBody('Valid Skill', 'noncanonical external id'),
  );
  await createSkill(
    join(fixture.project, '.maka', 'skills'),
    'bad\nskill',
    skillBody('Control Skill', 'control directory id'),
  );
  const repository = fixture.repository();
  const page = await start(repository, fixture.project, 'governance');
  assert.equal(governanceItem(page, 'project:maka:valid skill').id, 'valid skill');
  const control = page.items.find(
    (item): item is SkillCatalogGovernanceItem =>
      item.kind === 'discovery_diagnostic' && item.name === 'Control Skill',
  );
  assert.ok(control);
  assert.equal(control.id, 'invalid-skill-id');
  assert.equal(control.manageable, false);
  assert.equal(/[\u0000-\u001F\u007F]/.test(control.ref), false);
  const frame = {
    requestId: 'noncanonical-external-id',
    operation: 'skill.catalog.query' as const,
    ok: true as const,
    result: { ...page, resolvedWorkspace: workspaceProjection(fixture.project) },
  };
  assert.deepEqual(decodeHostFrame(frame), frame);

  assert.deepEqual(
    await repository.mutate({
      expectedRevision: page.revision,
      mutation: { kind: 'set_enabled', ref: control.ref, enabled: false },
    }),
    { kind: 'rejected', reason: 'not_found' },
  );
  await assert.rejects(readFile(join(fixture.root, '.maka', 'skills-state.json')), {
    code: 'ENOENT',
  });
  const initialModel = await repository.readCanonicalModelInventory({
    projectRoot: fixture.project,
  });
  assert.equal(
    initialModel.inventory.some((skill) => skill.id === 'bad\nskill'),
    false,
  );
  assert.equal(
    initialModel.inventory.some((skill) => skill.id === 'valid skill'),
    true,
  );

  const disabled = await repository.mutate({
    expectedRevision: page.revision,
    mutation: {
      kind: 'set_enabled',
      ref: 'project:maka:valid skill',
      enabled: false,
    },
  });
  assert.equal(disabled.kind, 'committed');
  const model = await repository.readCanonicalModelInventory({
    projectRoot: fixture.project,
  });
  assert.equal(model.inventory.find((skill) => skill.id === 'valid skill')?.enabled, false);
});

test('repository preserves filesystem-safe ids and codec preserves the 256-byte display-id boundary', async () => {
  const fixture = await createFixture();
  const filesystemId = `${'界'.repeat(83)} abcde`;
  const boundaryId = `${'界'.repeat(84)} abc`;
  const oversizedId = `${boundaryId}x`;
  assert.equal(Buffer.byteLength(filesystemId, 'utf8'), 255);
  assert.equal(Buffer.byteLength(boundaryId, 'utf8'), 256);
  assert.equal(Buffer.byteLength(oversizedId, 'utf8'), 257);
  await createSkill(
    join(fixture.project, '.maka', 'skills'),
    filesystemId,
    skillBody('Boundary Skill', 'encodable external id'),
  );

  const repository = fixture.repository();
  const page = await start(repository, fixture.project, 'governance');
  const filesystemRef = `project:maka:${filesystemId}`;
  const filesystemItem = governanceItem(page, filesystemRef);
  assert.equal(filesystemItem.id, filesystemId);
  assert.equal(filesystemItem.manageable, false);

  const boundaryPage = {
    ...page,
    items: [{ ...filesystemItem, id: boundaryId }],
    resolvedWorkspace: workspaceProjection(fixture.project),
  };
  const queryFrame = {
    requestId: 'display-id-boundary-query',
    operation: 'skill.catalog.query' as const,
    ok: true as const,
    result: boundaryPage,
  };
  assert.deepEqual(decodeHostFrame(queryFrame), queryFrame);

  const oversizedFrame = {
    ...queryFrame,
    result: {
      ...boundaryPage,
      items: [{ ...filesystemItem, id: oversizedId }],
    },
  };
  assert.throws(
    () => decodeHostFrame(oversizedFrame),
    (error: unknown) => error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame',
  );

  const committed = await repository.mutate({
    expectedRevision: page.revision,
    mutation: { kind: 'set_enabled', ref: filesystemRef, enabled: false },
  });
  assert.equal(committed.kind, 'committed');
  if (committed.kind !== 'committed') return;
  assert.equal(committed.entry?.id, filesystemId);
  const mutationFrame = {
    requestId: 'display-id-boundary-mutation',
    operation: 'skill.catalog.mutate' as const,
    ok: true as const,
    result: { ...committed, resolvedWorkspace: workspaceProjection(fixture.project) },
  };
  assert.deepEqual(decodeHostFrame(mutationFrame), mutationFrame);

  const model = await repository.readCanonicalModelInventory({
    projectRoot: fixture.project,
  });
  assert.equal(model.inventory.find((skill) => skill.id === filesystemId)?.enabled, false);
});

test('managed source read failures are not projected as an empty catalog', async () => {
  if (process.platform === 'win32') return;
  const fixture = await createFixture();
  await createSkill(fixture.sources, 'restricted', skillBody('Restricted', 'unreadable'));
  await chmod(fixture.sources, 0o000);
  try {
    await assert.rejects(
      start(fixture.repository(), fixture.project, 'managed_sources'),
      (error: unknown) => {
        assert.ok(error instanceof SkillCatalogRepositoryError);
        assert.equal(error.code, 'persistence_failed');
        return true;
      },
    );
  } finally {
    await chmod(fixture.sources, 0o700);
  }
});

test('one unreadable managed source child makes the Host catalog fail closed', async () => {
  if (process.platform === 'win32') return;
  const fixture = await createFixture();
  await createSkill(fixture.sources, 'readable', skillBody('Readable', 'valid source'));
  const unreadable = await createSkill(
    fixture.sources,
    'unreadable',
    skillBody('Unreadable', 'restricted source'),
  );
  const unreadableFile = join(unreadable, 'SKILL.md');
  await chmod(unreadableFile, 0o000);
  try {
    await assert.rejects(
      start(fixture.repository(), fixture.project, 'managed_sources'),
      (error: unknown) => {
        assert.ok(error instanceof SkillCatalogRepositoryError);
        assert.equal(error.code, 'persistence_failed');
        return true;
      },
    );
  } finally {
    await chmod(unreadableFile, 0o600);
  }
});

test('starter creation uses the shared template and reuses the lowest valid starter', async () => {
  const fixture = await createFixture();
  const repository = fixture.repository();
  const initial = await start(repository, fixture.project, 'governance');
  const created = await repository.mutate({
    expectedRevision: initial.revision,
    mutation: { kind: 'create_starter' },
  });
  assert.equal(created.kind, 'committed');
  if (created.kind !== 'committed') return;
  assert.equal(created.entry?.ref, 'workspace:legacy:starter-skill');
  assert.equal(
    await readFile(join(fixture.root, 'skills', 'starter-skill', 'SKILL.md'), 'utf8'),
    buildStarterSkillTemplate('starter-skill', '示例技能'),
  );

  const repeated = await repository.mutate({
    expectedRevision: created.revision,
    mutation: { kind: 'create_starter' },
  });
  assert.equal(repeated.kind, 'unchanged');
  if (repeated.kind === 'unchanged') {
    assert.equal(repeated.entry?.ref, 'workspace:legacy:starter-skill');
  }
});

test('invalid starter ids remain occupied when selecting the lowest available ordinal', async () => {
  const fixture = await createFixture();
  await createSkill(join(fixture.root, 'skills'), 'starter-skill', '# invalid starter\n');
  const repository = fixture.repository();
  const initial = await start(repository, fixture.project, 'governance');
  const created = await repository.mutate({
    expectedRevision: initial.revision,
    mutation: { kind: 'create_starter' },
  });
  assert.equal(created.kind, 'committed');
  if (created.kind !== 'committed') return;
  assert.equal(created.entry?.ref, 'workspace:legacy:starter-skill-2');
  assert.equal(
    await readFile(join(fixture.root, 'skills', 'starter-skill-2', 'SKILL.md'), 'utf8'),
    buildStarterSkillTemplate('starter-skill-2', '示例技能 2'),
  );
});

test('empty publication targets occupy starter ids and participate in revision', async () => {
  const fixture = await createFixture();
  const emptyTarget = join(fixture.root, 'skills', 'starter-skill');
  await mkdir(emptyTarget, { recursive: true });
  const repository = fixture.repository();
  const occupied = await start(repository, fixture.project, 'governance');

  const created = await repository.mutate({
    expectedRevision: occupied.revision,
    mutation: { kind: 'create_starter' },
  });
  assert.equal(created.kind, 'committed');
  if (created.kind === 'committed') {
    assert.equal(created.entry?.ref, 'workspace:legacy:starter-skill-2');
  }

  const withEmptyTarget = await start(repository, fixture.project, 'governance');
  await rm(emptyTarget, { recursive: true });
  const withoutEmptyTarget = await start(repository, fixture.project, 'governance');
  assert.notEqual(withoutEmptyTarget.revision, withEmptyTarget.revision);
});

test('root-owned rejected and empty placeholders can be deleted and reinstalled', async () => {
  const fixture = await createFixture();
  const source = BUNDLED_SKILL_CATALOG[0];
  assert.ok(source);
  await createSkill(join(fixture.root, 'skills'), source.id, '# invalid\n');
  await mkdir(join(fixture.root, 'skills', 'empty-placeholder'), { recursive: true });
  const repository = fixture.repository();

  const initial = await start(repository, fixture.project, 'governance');
  const rejected = governanceItem(initial, `workspace:legacy:${source.id}`);
  const empty = governanceItem(initial, 'workspace:legacy:empty-placeholder');
  assert.equal(rejected.manageable, true);
  assert.equal(empty.manageable, true);

  const deletedRejected = await repository.mutate({
    expectedRevision: initial.revision,
    mutation: { kind: 'delete', ref: rejected.ref },
  });
  assert.equal(deletedRejected.kind, 'committed');
  if (deletedRejected.kind !== 'committed') return;
  const deletedEmpty = await repository.mutate({
    expectedRevision: deletedRejected.revision,
    mutation: { kind: 'delete', ref: empty.ref },
  });
  assert.equal(deletedEmpty.kind, 'committed');
  if (deletedEmpty.kind !== 'committed') return;

  const installed = await repository.mutate({
    expectedRevision: deletedEmpty.revision,
    mutation: { kind: 'install', sourceType: 'bundled', sourceId: source.id },
  });
  assert.equal(installed.kind, 'committed');
  assert.match(await readFile(join(fixture.root, 'skills', source.id, 'SKILL.md'), 'utf8'), /---/);
});

test('delete revision covers nested references, scripts, assets, and empty directories', async () => {
  const fixture = await createFixture();
  const directory = await createSkill(
    join(fixture.root, 'skills'),
    'tree-skill',
    skillBody('Tree Skill', 'nested content'),
  );
  await mkdir(join(directory, 'references'), { recursive: true });
  await mkdir(join(directory, 'scripts'), { recursive: true });
  await mkdir(join(directory, 'assets', 'empty'), { recursive: true });
  await writeFile(join(directory, 'references', 'notes.txt'), 'one\n');
  await writeFile(join(directory, 'scripts', 'run.sh'), 'echo one\n');
  const repository = fixture.repository();
  const snapshot = await start(repository, fixture.project, 'governance');

  await writeFile(join(directory, 'assets', 'added.txt'), 'added\n');
  const addedConflict = await repository.mutate({
    expectedRevision: snapshot.revision,
    mutation: { kind: 'delete', ref: 'workspace:legacy:tree-skill' },
  });
  assert.equal(addedConflict.kind, 'revision_conflict');
  assert.equal(await readFile(join(directory, 'assets', 'added.txt'), 'utf8'), 'added\n');

  const changedSnapshot = await start(repository, fixture.project, 'governance');
  await writeFile(join(directory, 'scripts', 'run.sh'), 'echo changed\n');
  const changedConflict = await repository.mutate({
    expectedRevision: changedSnapshot.revision,
    mutation: { kind: 'delete', ref: 'workspace:legacy:tree-skill' },
  });
  assert.equal(changedConflict.kind, 'revision_conflict');
  assert.equal(await readFile(join(directory, 'scripts', 'run.sh'), 'utf8'), 'echo changed\n');

  const referenceSnapshot = await start(repository, fixture.project, 'governance');
  await writeFile(join(directory, 'references', 'notes.txt'), 'changed\n');
  const referenceConflict = await repository.mutate({
    expectedRevision: referenceSnapshot.revision,
    mutation: { kind: 'delete', ref: 'workspace:legacy:tree-skill' },
  });
  assert.equal(referenceConflict.kind, 'revision_conflict');
  assert.equal(await readFile(join(directory, 'references', 'notes.txt'), 'utf8'), 'changed\n');
});

test('starter creation reuses the lowest ordinal valid Data Root starter', async () => {
  const fixture = await createFixture();
  await createSkill(
    join(fixture.root, 'skills'),
    'starter-skill-3',
    skillBody('Existing Starter 3', 'existing'),
  );
  await createSkill(
    join(fixture.root, 'skills'),
    'Starter-Skill-2',
    skillBody('Existing Starter 2', 'existing'),
  );
  const repository = fixture.repository();
  const initial = await start(repository, fixture.project, 'governance');
  const result = await repository.mutate({
    expectedRevision: initial.revision,
    mutation: { kind: 'create_starter' },
  });
  assert.equal(result.kind, 'unchanged');
  if (result.kind === 'unchanged') {
    assert.equal(result.entry?.ref, 'workspace:legacy:Starter-Skill-2');
  }
  await assert.rejects(readFile(join(fixture.root, 'skills', 'starter-skill', 'SKILL.md')), {
    code: 'ENOENT',
  });
});

test('managed preview is bounded and hash-bound, then a force update commits the source', async () => {
  const fixture = await createFixture();
  const sourceId = 'managed-preview';
  const sourceContent = longSkillBody('Managed Preview', 'source');
  await createSkill(fixture.sources, sourceId, sourceContent);
  const repository = fixture.repository();

  const initial = await start(repository, fixture.project, 'managed_sources');
  const installed = await repository.mutate({
    expectedRevision: initial.revision,
    mutation: { kind: 'install', sourceType: 'managed', sourceId },
  });
  assert.equal(installed.kind, 'committed');
  if (installed.kind !== 'committed') return;

  const installedPath = join(fixture.root, 'skills', sourceId, 'SKILL.md');
  const localContent = longSkillBody('Managed Preview', 'local edit');
  await writeFile(installedPath, localContent);
  const modified = await start(repository, fixture.project, 'governance');
  const preview = await repository.previewUpdate({
    expectedRevision: modified.revision,
    ref: `workspace:legacy:${sourceId}`,
  });
  assert.equal(preview.kind, 'preview');
  if (preview.kind !== 'preview') return;
  assert.ok(preview.currentSnippet.split('\n').length <= 80);
  assert.ok(preview.sourceSnippet.split('\n').length <= 80);
  assert.equal(preview.currentTruncated, true);
  assert.equal(preview.sourceTruncated, true);
  assert.equal(preview.hasManagedBaseline, true);
  assert.equal(preview.expectedCurrentSha256, sha256(localContent));
  assert.equal(preview.expectedSourceSha256, sha256(sourceContent));
  assert.ok(Buffer.byteLength(JSON.stringify(preview), 'utf8') <= 48 * 1024);

  const updated = await repository.mutate({
    expectedRevision: preview.revision,
    mutation: {
      kind: 'update_managed',
      ref: `workspace:legacy:${sourceId}`,
      force: true,
      expectedCurrentSha256: preview.expectedCurrentSha256,
      expectedSourceSha256: preview.expectedSourceSha256,
    },
  });
  assert.equal(updated.kind, 'committed');
  assert.equal(await readFile(installedPath, 'utf8'), sourceContent);
});

test('Host previews, updates, and recovers the canonical Desktop managed-install layout', async () => {
  const fixture = await createFixture();
  const sourceId = 'desktop-managed';
  const versionOne = skillBody('Desktop Managed', 'version one');
  const versionTwo = skillBody('Desktop Managed', 'version two');
  await createSkill(fixture.sources, sourceId, versionTwo);
  const skillDirectory = join(fixture.root, 'skills', sourceId);
  await mkdir(join(skillDirectory, '.maka', 'baseline'), { recursive: true });
  await writeFile(join(skillDirectory, 'SKILL.md'), versionOne);
  await writeFile(
    join(skillDirectory, 'skill.lock.json'),
    `${JSON.stringify(createManagedSkillLock(sourceId, sha256(versionOne), sha256(versionOne)), null, 2)}\n`,
  );
  await writeFile(join(skillDirectory, '.maka', 'baseline', 'SKILL.md'), versionOne);

  let armed = true;
  const repository = fixture.repository({
    failpoint(point) {
      if (armed && point === 'after_managed_freeze') {
        armed = false;
        throw new Error('simulated process loss after directory freeze');
      }
    },
  });
  const snapshot = await start(repository, fixture.project, 'governance');
  const preview = await repository.previewUpdate({
    expectedRevision: snapshot.revision,
    ref: `workspace:legacy:${sourceId}`,
  });
  assert.equal(preview.kind, 'preview');

  await assert.rejects(
    repository.mutate({
      expectedRevision: snapshot.revision,
      mutation: {
        kind: 'update_managed',
        ref: `workspace:legacy:${sourceId}`,
        force: false,
        expectedCurrentSha256: null,
        expectedSourceSha256: null,
      },
    }),
    (error: unknown) =>
      error instanceof SkillCatalogRepositoryError && error.code === 'commit_outcome_unknown',
  );
  await start(repository, fixture.project, 'governance');
  assert.equal(await readFile(join(skillDirectory, 'SKILL.md'), 'utf8'), versionTwo);
  assert.equal(
    await readFile(join(skillDirectory, '.maka', 'baseline', 'SKILL.md'), 'utf8'),
    versionTwo,
  );
});

test('managed install and update reject source changes after their revision snapshot', async () => {
  const fixture = await createFixture();
  const sourceId = 'managed-race';
  const sourcePath = join(fixture.sources, sourceId, 'SKILL.md');
  const versionOne = skillBody('Managed Race', 'version one');
  const versionTwo = skillBody('Managed Race', 'version two');
  const versionThree = skillBody('Managed Race', 'version three');
  const versionFour = skillBody('Managed Race', 'version four');
  await createSkill(fixture.sources, sourceId, versionOne);
  let replacement: string | undefined;
  const repository = fixture.repository(undefined, {
    beforeManagedSourceMutationRead: async () => {
      if (replacement === undefined) return;
      const next = replacement;
      replacement = undefined;
      await writeFile(sourcePath, next);
    },
  });

  const initial = await start(repository, fixture.project, 'managed_sources');
  replacement = versionTwo;
  const racedInstall = await repository.mutate({
    expectedRevision: initial.revision,
    mutation: { kind: 'install', sourceType: 'managed', sourceId },
  });
  assert.deepEqual(racedInstall, { kind: 'rejected', reason: 'source_changed' });
  await assert.rejects(readFile(join(fixture.root, 'skills', sourceId, 'SKILL.md')), {
    code: 'ENOENT',
  });

  const versionTwoSnapshot = await start(repository, fixture.project, 'managed_sources');
  const installed = await repository.mutate({
    expectedRevision: versionTwoSnapshot.revision,
    mutation: { kind: 'install', sourceType: 'managed', sourceId },
  });
  assert.equal(installed.kind, 'committed');
  const installedPath = join(fixture.root, 'skills', sourceId, 'SKILL.md');
  assert.equal(await readFile(installedPath, 'utf8'), versionTwo);

  await writeFile(sourcePath, versionThree);
  const versionThreeSnapshot = await start(repository, fixture.project, 'governance');
  replacement = versionFour;
  const racedUpdate = await repository.mutate({
    expectedRevision: versionThreeSnapshot.revision,
    mutation: {
      kind: 'update_managed',
      ref: `workspace:legacy:${sourceId}`,
      force: false,
      expectedCurrentSha256: null,
      expectedSourceSha256: null,
    },
  });
  assert.deepEqual(racedUpdate, { kind: 'rejected', reason: 'source_changed' });
  assert.equal(await readFile(installedPath, 'utf8'), versionTwo);
});

test('managed install and update reject malformed UTF-8 sources before writing', async () => {
  const fixture = await createFixture();
  const sourceId = 'managed-invalid-encoding';
  const sourcePath = join(fixture.sources, sourceId, 'SKILL.md');
  const installedPath = join(fixture.root, 'skills', sourceId, 'SKILL.md');
  const versionOne = skillBody('Managed Encoding', 'version one');
  const versionTwo = skillBody('Managed Encoding', 'version two');
  await createSkill(fixture.sources, sourceId, versionOne);
  await writeFile(sourcePath, Buffer.concat([Buffer.from(versionOne), Buffer.from([0x80])]));
  const repository = fixture.repository();

  const malformedInstallSnapshot = await start(repository, fixture.project, 'managed_sources');
  assert.deepEqual(
    await repository.mutate({
      expectedRevision: malformedInstallSnapshot.revision,
      mutation: { kind: 'install', sourceType: 'managed', sourceId },
    }),
    { kind: 'rejected', reason: 'source_invalid' },
  );
  await assert.rejects(readFile(installedPath), { code: 'ENOENT' });

  await writeFile(sourcePath, versionOne);
  const validSnapshot = await start(repository, fixture.project, 'managed_sources');
  const installed = await repository.mutate({
    expectedRevision: validSnapshot.revision,
    mutation: { kind: 'install', sourceType: 'managed', sourceId },
  });
  assert.equal(installed.kind, 'committed');

  await writeFile(sourcePath, Buffer.concat([Buffer.from(versionTwo), Buffer.from([0x80])]));
  const malformedUpdateSnapshot = await start(repository, fixture.project, 'governance');
  assert.deepEqual(
    await repository.mutate({
      expectedRevision: malformedUpdateSnapshot.revision,
      mutation: {
        kind: 'update_managed',
        ref: `workspace:legacy:${sourceId}`,
        force: false,
        expectedCurrentSha256: null,
        expectedSourceSha256: null,
      },
    }),
    { kind: 'rejected', reason: 'source_invalid' },
  );
  assert.equal(await readFile(installedPath, 'utf8'), versionOne);
});

test('non-force managed update preserves a local edit made after its snapshot', async () => {
  const fixture = await createFixture();
  const sourceId = 'managed-local-race';
  const sourcePath = join(fixture.sources, sourceId, 'SKILL.md');
  const installedContent = skillBody('Managed Local Race', 'installed');
  const updateContent = skillBody('Managed Local Race', 'source update');
  const localEdit = skillBody('Managed Local Race', 'local edit after snapshot');
  await createSkill(fixture.sources, sourceId, installedContent);
  let editBeforeRead = false;
  const installedPath = join(fixture.root, 'skills', sourceId, 'SKILL.md');
  const repository = fixture.repository(undefined, {
    beforeManagedInstalledArtifactsRead: async () => {
      if (!editBeforeRead) return;
      editBeforeRead = false;
      await writeFile(installedPath, localEdit);
    },
  });
  const initial = await start(repository, fixture.project, 'managed_sources');
  const installed = await repository.mutate({
    expectedRevision: initial.revision,
    mutation: { kind: 'install', sourceType: 'managed', sourceId },
  });
  assert.equal(installed.kind, 'committed');

  await writeFile(sourcePath, updateContent);
  const snapshot = await start(repository, fixture.project, 'governance');
  editBeforeRead = true;
  const result = await repository.mutate({
    expectedRevision: snapshot.revision,
    mutation: {
      kind: 'update_managed',
      ref: `workspace:legacy:${sourceId}`,
      force: false,
      expectedCurrentSha256: null,
      expectedSourceSha256: null,
    },
  });
  assert.deepEqual(result, { kind: 'rejected', reason: 'local_modified' });
  assert.equal(await readFile(installedPath, 'utf8'), localEdit);
});

test('revision covers exact managed lock and baseline bytes and rejects post-snapshot edits', async () => {
  const fixture = await createFixture();
  const sourceId = 'managed-artifact-race';
  const sourcePath = join(fixture.sources, sourceId, 'SKILL.md');
  const versionOne = skillBody('Managed Artifact Race', 'one');
  const versionTwo = skillBody('Managed Artifact Race', 'two');
  await createSkill(fixture.sources, sourceId, versionOne);
  let editBaselineBeforeRead = false;
  const skillDirectory = join(fixture.root, 'skills', sourceId);
  const baselinePath = join(skillDirectory, '.maka', 'baseline', 'SKILL.md');
  const lockPath = join(skillDirectory, 'skill.lock.json');
  const repository = fixture.repository(undefined, {
    beforeManagedInstalledArtifactsRead: async () => {
      if (!editBaselineBeforeRead) return;
      editBaselineBeforeRead = false;
      await writeFile(baselinePath, `${versionOne}\npost-snapshot edit\n`);
    },
  });
  const initial = await start(repository, fixture.project, 'managed_sources');
  const installed = await repository.mutate({
    expectedRevision: initial.revision,
    mutation: { kind: 'install', sourceType: 'managed', sourceId },
  });
  assert.equal(installed.kind, 'committed');

  const stable = await start(repository, fixture.project, 'governance');
  const baseline = await readFile(baselinePath, 'utf8');
  await writeFile(baselinePath, `${baseline}\nchanged\n`);
  const baselineChanged = await start(repository, fixture.project, 'governance');
  assert.notEqual(baselineChanged.revision, stable.revision);
  await writeFile(baselinePath, baseline);
  assert.equal((await start(repository, fixture.project, 'governance')).revision, stable.revision);

  const lock = await readFile(lockPath, 'utf8');
  await writeFile(lockPath, `${lock.trimEnd()} \n`);
  assert.notEqual(
    (await start(repository, fixture.project, 'governance')).revision,
    stable.revision,
  );
  await writeFile(lockPath, lock);

  await writeFile(sourcePath, versionTwo);
  const updateSnapshot = await start(repository, fixture.project, 'governance');
  editBaselineBeforeRead = true;
  const raced = await repository.mutate({
    expectedRevision: updateSnapshot.revision,
    mutation: {
      kind: 'update_managed',
      ref: `workspace:legacy:${sourceId}`,
      force: false,
      expectedCurrentSha256: null,
      expectedSourceSha256: null,
    },
  });
  assert.deepEqual(raced, { kind: 'rejected', reason: 'local_modified' });
});

test('malformed installed artifacts retain raw revision hashes but cannot enter transactions', async () => {
  const fixture = await createFixture();
  const sourceId = 'managed-raw-bytes';
  const versionOne = skillBody('Managed Raw Bytes', 'one');
  const skillDirectory = join(fixture.root, 'skills', sourceId);
  const installedPath = join(skillDirectory, 'SKILL.md');
  const lockPath = join(skillDirectory, 'skill.lock.json');
  const baselinePath = join(skillDirectory, '.maka', 'baseline', 'SKILL.md');
  const malformedA = Buffer.from([0x80]);
  const malformedB = Buffer.from([0x81]);
  await createSkill(fixture.sources, sourceId, versionOne);
  const repository = fixture.repository();
  const initial = await start(repository, fixture.project, 'managed_sources');
  const installed = await repository.mutate({
    expectedRevision: initial.revision,
    mutation: { kind: 'install', sourceType: 'managed', sourceId },
  });
  assert.equal(installed.kind, 'committed');

  const lock = await readFile(lockPath);
  await writeFile(lockPath, Buffer.concat([lock, malformedA]));
  const lockA = await start(repository, fixture.project, 'governance');
  await writeFile(lockPath, Buffer.concat([lock, malformedB]));
  const lockB = await start(repository, fixture.project, 'governance');
  assert.notEqual(lockA.revision, lockB.revision);
  await writeFile(lockPath, lock);

  const baseline = await readFile(baselinePath);
  await writeFile(baselinePath, Buffer.concat([baseline, malformedA]));
  const baselineA = await start(repository, fixture.project, 'governance');
  await writeFile(baselinePath, Buffer.concat([baseline, malformedB]));
  const baselineB = await start(repository, fixture.project, 'governance');
  assert.notEqual(baselineA.revision, baselineB.revision);
  await writeFile(baselinePath, baseline);

  const currentA = Buffer.concat([Buffer.from(versionOne), malformedA]);
  await writeFile(installedPath, currentA);
  const skillA = await start(repository, fixture.project, 'governance');
  const previewA = await repository.previewUpdate({
    expectedRevision: skillA.revision,
    ref: `workspace:legacy:${sourceId}`,
  });
  assert.deepEqual(previewA, { kind: 'rejected', reason: 'metadata_error' });
  assert.deepEqual(
    await repository.mutate({
      expectedRevision: skillA.revision,
      mutation: {
        kind: 'update_managed',
        ref: `workspace:legacy:${sourceId}`,
        force: true,
        expectedCurrentSha256: sha256(currentA),
        expectedSourceSha256: sha256(versionOne),
      },
    }),
    { kind: 'rejected', reason: 'metadata_error' },
  );
  assert.deepEqual(await readFile(installedPath), currentA);

  const currentB = Buffer.concat([Buffer.from(versionOne), malformedB]);
  await writeFile(installedPath, currentB);
  const skillB = await start(repository, fixture.project, 'governance');
  const previewB = await repository.previewUpdate({
    expectedRevision: skillB.revision,
    ref: `workspace:legacy:${sourceId}`,
  });
  assert.deepEqual(previewB, { kind: 'rejected', reason: 'metadata_error' });
  assert.notEqual(skillA.revision, skillB.revision);
});

test('install rejects invalid and case-only workspace occupants', async () => {
  const source = BUNDLED_SKILL_CATALOG[0];
  assert.ok(source);

  const invalidFixture = await createFixture();
  await createSkill(join(invalidFixture.root, 'skills'), source.id, '# invalid\n');
  const invalidRepository = invalidFixture.repository();
  const invalidSnapshot = await start(invalidRepository, invalidFixture.project, 'bundled');
  assert.deepEqual(
    await invalidRepository.mutate({
      expectedRevision: invalidSnapshot.revision,
      mutation: { kind: 'install', sourceType: 'bundled', sourceId: source.id },
    }),
    { kind: 'rejected', reason: 'already_exists' },
  );

  const emptyFixture = await createFixture();
  await mkdir(join(emptyFixture.root, 'skills', source.id), { recursive: true });
  const emptyRepository = emptyFixture.repository();
  const emptySnapshot = await start(emptyRepository, emptyFixture.project, 'bundled');
  assert.deepEqual(
    await emptyRepository.mutate({
      expectedRevision: emptySnapshot.revision,
      mutation: { kind: 'install', sourceType: 'bundled', sourceId: source.id },
    }),
    { kind: 'rejected', reason: 'already_exists' },
  );

  const caseFixture = await createFixture();
  await createSkill(
    join(caseFixture.root, 'skills'),
    source.id.toUpperCase(),
    skillBody('Case Occupant', 'case-only duplicate'),
  );
  const caseRepository = caseFixture.repository();
  const caseSnapshot = await start(caseRepository, caseFixture.project, 'bundled');
  const caseProjection = caseSnapshot.items.find(
    (item) => item.kind === 'bundled' && item.id === source.id,
  );
  assert.equal(caseProjection?.kind === 'bundled' && caseProjection.installed, true);
  assert.deepEqual(
    await caseRepository.mutate({
      expectedRevision: caseSnapshot.revision,
      mutation: { kind: 'install', sourceType: 'bundled', sourceId: source.id },
    }),
    { kind: 'rejected', reason: 'already_exists' },
  );
});

test('managed source projection uses case-insensitive publication occupancy', async () => {
  const fixture = await createFixture();
  const sourceId = 'managed-occupant';
  await createSkill(fixture.sources, sourceId, skillBody('Managed Source', 'source'));
  await createSkill(
    join(fixture.root, 'skills'),
    sourceId.toUpperCase(),
    skillBody('Case Occupant', 'existing'),
  );
  const page = await start(fixture.repository(), fixture.project, 'managed_sources');
  const projected = page.items.find(
    (item) => item.kind === 'managed_source' && item.id === sourceId,
  );
  assert.equal(projected?.kind === 'managed_source' && projected.installed, true);
});

test('repository rejects relative project roots before filesystem canonicalization', async () => {
  assert.equal(isSkillCatalogProjectRootLexicallyAbsolute('C:\\project', 'win32'), true);
  assert.equal(isSkillCatalogProjectRootLexicallyAbsolute('\\\\server\\share', 'win32'), true);
  assert.equal(isSkillCatalogProjectRootLexicallyAbsolute('\\project', 'win32'), false);
  assert.equal(isSkillCatalogProjectRootLexicallyAbsolute('/project', 'win32'), false);
  assert.equal(isSkillCatalogProjectRootLexicallyAbsolute('C:project', 'win32'), false);

  const fixture = await createFixture();
  await assert.rejects(
    start(fixture.repository(), '.', 'governance'),
    (error: unknown) =>
      error instanceof SkillCatalogRepositoryError && error.code === 'invalid_request',
  );
});

test('durable transaction uncertainty is not reported as success and the next scan recovers it', async () => {
  const fixture = await createFixture();
  const failpoint: SkillCatalogTransactionFailpoint = 'after_publish_rename';
  let armed = true;
  const transactionOptions: SkillCatalogTransactionOptions = {
    failpoint(point) {
      if (armed && point === failpoint) {
        armed = false;
        throw new Error('simulated process loss');
      }
    },
  };
  const repository = fixture.repository(transactionOptions);
  const initial = await start(repository, fixture.project, 'bundled');
  const source = BUNDLED_SKILL_CATALOG[0];
  assert.ok(source);

  await assert.rejects(
    repository.mutate({
      expectedRevision: initial.revision,
      mutation: { kind: 'install', sourceType: 'bundled', sourceId: source.id },
    }),
    (error: unknown) => {
      assert.ok(error instanceof SkillCatalogRepositoryError);
      assert.equal(error.code, 'commit_outcome_unknown');
      return true;
    },
  );

  await repository.recover();
  const recovered = await start(repository, fixture.project, 'governance');
  assert.ok(
    recovered.items.some(
      (item) => item.kind === 'skill' && item.ref === `workspace:legacy:${source.id}`,
    ),
  );
});

interface Fixture {
  root: string;
  project: string;
  home: string;
  sources: string;
  repository(
    transactionOptions?: SkillCatalogTransactionOptions,
    testHooks?: SkillCatalogRepositoryOptions['testHooks'],
  ): TestSkillCatalogRepository;
}

class TestSkillCatalogRepository extends SkillCatalogRepository {
  constructor(
    options: SkillCatalogRepositoryOptions,
    private readonly context: SkillCatalogLocalContext,
  ) {
    super(options);
  }

  override query(
    input: Parameters<SkillCatalogRepository['query']>[0],
    context?: SkillCatalogLocalContext,
  ) {
    return super.query(input, context ?? this.context);
  }

  override mutate(
    input: Parameters<SkillCatalogRepository['mutate']>[0],
    context?: SkillCatalogLocalContext,
  ) {
    return super.mutate(input, context ?? this.context);
  }

  override previewUpdate(
    input: Parameters<SkillCatalogRepository['previewUpdate']>[0],
    context?: SkillCatalogLocalContext,
  ) {
    return super.previewUpdate(input, context ?? this.context);
  }
}

async function createFixture(): Promise<Fixture> {
  const base = await tempDirectory('maka-skill-repository-');
  const root = join(base, 'data');
  const project = join(base, 'project');
  const home = join(base, 'home');
  const sources = join(home, '.maka', 'skill-sources');
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sources, { recursive: true }),
  ]);
  const runWithRoot = async <T>(operation: (leasedRoot: string) => Promise<T>): Promise<T> =>
    operation(root);
  return {
    root,
    project,
    home,
    sources,
    repository(transactionOptions, testHooks) {
      return new TestSkillCatalogRepository(
        {
          runWithRoot,
          homeDirectory: home,
          managedSourcesRoot: sources,
          ...(transactionOptions ? { transactionOptions } : {}),
          ...(testHooks ? { testHooks } : {}),
        },
        { projectRoot: project },
      );
    },
  };
}

async function tempDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.add(root);
  return root;
}

async function createSkill(parent: string, id: string, content: string): Promise<string> {
  const directory = join(parent, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), content);
  return directory;
}

function skillBody(name: string, description: string): string {
  return `---
name: ${name}
description: ${description}
allowed-tools: Read
---

# ${name}

Instructions.
`;
}

function skillBodyWithTools(name: string, toolCount: number, finalTool: string): string {
  const tools = Array.from({ length: toolCount }, (_, index) =>
    index === toolCount - 1 ? finalTool : `Tool${index}`,
  );
  return `---
name: ${name}
description: Oversized metadata projection.
allowed-tools:
${tools.map((tool) => `  - ${tool}`).join('\n')}
---

# Oversized metadata
`;
}

function longSkillBody(name: string, label: string): string {
  return `${skillBody(name, `${label} description`)}${Array.from(
    { length: 120 },
    (_, index) => `${label} line ${index} ${'x'.repeat(240)}`,
  ).join('\n')}\n`;
}

function stateFile(ref: string, enabled: boolean, pinned: boolean, updatedAt: string): string {
  return `${JSON.stringify({
    schemaVersion: 2,
    skills: { [ref]: { enabled, pinned, updatedAt } },
  })}\n`;
}

function workspaceProjection(projectRoot: string) {
  return {
    target: { kind: 'host_path' as const, path: projectRoot },
    hostCwd: projectRoot,
  };
}

async function start(
  repository: TestSkillCatalogRepository,
  projectRoot: string,
  view: 'governance' | 'bundled' | 'managed_sources',
): Promise<Extract<SkillCatalogQueryResult, { kind: 'page' }>> {
  const result = await repository.query(
    {
      kind: 'start',
      view,
    },
    { projectRoot },
  );
  assert.equal(result.kind, 'page');
  return result as Extract<SkillCatalogQueryResult, { kind: 'page' }>;
}

function governanceItem(
  page: Extract<SkillCatalogQueryResult, { kind: 'page' }>,
  ref: string,
): SkillCatalogGovernanceItem {
  const item = page.items.find(
    (candidate): candidate is SkillCatalogGovernanceItem =>
      candidate.kind === 'skill' && 'ref' in candidate && candidate.ref === ref,
  );
  assert.ok(item);
  return item;
}

function sha256(content: string | Uint8Array): SkillCatalogRevision {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
