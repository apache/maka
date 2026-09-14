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
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { SkillCatalogGovernanceItem, SkillCatalogMutation } from '@maka/runtime-host/protocol';
import { SkillCatalogRepository } from '../../../../../packages/runtime-host/dist/server/skill-catalog-repository.js';
import type { DesktopRuntimeHostClient } from '../runtime-host-client.js';
import { ComputerHistorySkillInstaller } from '../computer-history-skill.js';

type SkillClient = Pick<DesktopRuntimeHostClient, 'loadSkillCatalog' | 'mutateSkillCatalog'>;
const REF = 'workspace:legacy:computer-history';
const INSTALL = { kind: 'install', sourceType: 'bundled', sourceId: 'computer-history' } as const;

test('no history and collection disabled leaves the catalog untouched', async (t) => {
  const f = await fixture(t);
  f.needed = false;
  f.installer.hostChanged('local', f.client);
  await f.installer.refresh();
  assert.equal(f.reads.length, 0);
  assert.equal(f.mutations.length, 0);
  assert.deepEqual(f.errors, []);
});

test('first enable installs through the local default Host catalog and defaults enabled', async (t) => {
  const f = await fixture(t);
  f.installer.hostChanged('remote-selected', {
    loadSkillCatalog: async () => { throw new Error('must not reach the selected remote Host'); },
    mutateSkillCatalog: async () => { throw new Error('must not mutate a remote Host'); },
  });
  assert.equal(f.reads.length, 0);
  await f.installer.refresh();
  assert.match(String(f.errors.pop()), /Local Host is unavailable/);
  f.installer.hostChanged('local', f.client);
  await f.installer.refresh();
  assert.deepEqual(f.mutations, [INSTALL]);
  const skill = await f.installed();
  assert.equal(skill?.enabled, true);
  assert.equal(skill?.runtimeStatus, 'enabled');
  assert.equal(skill?.ref, REF);
  assert.ok(f.reads.every((context) => context.workspace.kind === 'host_path' && context.workspace.path === f.root));
  assert.deepEqual(f.errors, []);
});

test('repeated refreshes and a restarted installer preserve a manually disabled Skill', async (t) => {
  const f = await fixture(t);
  f.installer.hostChanged('local', f.client);
  await Promise.all([f.installer.refresh(), f.installer.refresh(), f.installer.refresh()]);
  assert.equal(f.mutations.length, 1);
  await f.mutate({ kind: 'set_enabled', ref: REF, enabled: false });
  const state = await readFile(join(f.root, '.maka', 'skills-state.json'), 'utf8');
  await f.installer.refresh();
  const restarted = f.restart();
  restarted.hostChanged('local', f.client);
  await restarted.refresh();
  assert.equal((await f.installed())?.enabled, false);
  assert.equal(await readFile(join(f.root, '.maka', 'skills-state.json'), 'utf8'), state);
  assert.deepEqual(f.mutations, [INSTALL]);
});

test('deletion and automatic reinstall retain full-ref disabled preference', async (t) => {
  const f = await fixture(t);
  f.installer.hostChanged('local', f.client);
  await f.installer.refresh();
  await f.mutate({ kind: 'set_enabled', ref: REF, enabled: false });
  await f.mutate({ kind: 'delete', ref: REF });
  await f.installer.refresh();
  assert.deepEqual(f.mutations, [INSTALL, INSTALL]);
  assert.equal((await f.installed())?.enabled, false);
});

test('existing customized skill contents and metadata are never replaced', async (t) => {
  const f = await fixture(t);
  await f.mutate(INSTALL);
  const file = join(f.root, 'skills', 'computer-history', 'SKILL.md');
  const customized = `${await readFile(file, 'utf8')}\nUser customization.\n`;
  await writeFile(file, customized);
  f.installer.hostChanged('local', f.client);
  await f.installer.refresh();
  assert.equal(await readFile(file, 'utf8'), customized);
  assert.equal((await f.installed())?.userModified, true);
  assert.equal(f.mutations.length, 0);
});

test('same-ID shadowed or state-error governance entries are preserved', async (t) => {
  for (const runtimeStatus of ['disabled', 'state_error'] as const) {
    const f = await fixture(t);
    const source = f.client.loadSkillCatalog;
    f.client.loadSkillCatalog = async (context, view) => {
      const snapshot = await source(context, view);
      return {
        ...snapshot,
        items: [{
          kind: 'skill', id: 'computer-history', ref: 'global:agents:computer-history',
          runtimeStatus, enabled: false, userModified: true, shadowedBy: 'project:maka:computer-history',
        } as SkillCatalogGovernanceItem],
      };
    };
    f.installer.hostChanged('local', f.client);
    await f.installer.refresh();
    assert.equal(f.mutations.length, 0);
    assert.deepEqual(f.errors, []);
  }
});

test('a competing install and manual disable win a revision conflict', async (t) => {
  const f = await fixture(t);
  const mutate = f.client.mutateSkillCatalog;
  f.client.mutateSkillCatalog = async (input) => {
    await f.mutate(INSTALL);
    await f.mutate({ kind: 'set_enabled', ref: REF, enabled: false });
    return mutate(input);
  };
  f.installer.hostChanged('local', f.client);
  await f.installer.refresh();
  assert.equal(f.mutations.length, 1);
  assert.equal((await f.installed())?.enabled, false);
  assert.deepEqual(f.errors, []);
});

test('revision conflicts are bounded and a later refresh can retry', async (t) => {
  const f = await fixture(t);
  const mutate = f.client.mutateSkillCatalog;
  const reported = deferred<void>();
  f.onError = () => reported.resolve();
  let attempts = 0;
  f.client.mutateSkillCatalog = async (input) => {
    attempts += 1;
    return {
      kind: 'revision_conflict', expectedRevision: input.expectedRevision,
      actualRevision: input.expectedRevision,
      resolvedWorkspace: { target: input.context.workspace, hostCwd: f.root },
    };
  };
  f.installer.hostChanged('local', f.client);
  await reported.promise;
  assert.equal(attempts, 3);
  assert.match(String(f.errors[0]), /catalog kept changing/);
  // Drain the reported flight before the independent retry.
  await f.installer.refresh();
  f.client.mutateSkillCatalog = mutate;
  await f.installer.refresh();
  assert.equal((await f.installed())?.enabled, true);
});

test('a replacement local connection retries while a stale read is pending', async (t) => {
  const f = await fixture(t);
  const empty = await f.client.loadSkillCatalog(f.context, 'governance');
  const blocked = deferred<Awaited<ReturnType<SkillClient['loadSkillCatalog']>>>();
  const reading = deferred<void>();
  let staleReads = 0;
  const stale = {
    ...f.client,
    loadSkillCatalog: async () => { staleReads += 1; reading.resolve(); return blocked.promise; },
    mutateSkillCatalog: async () => { throw new Error('stale connection must not install'); },
  };
  f.installer.hostChanged('local', stale);
  const staleRun = f.installer.refresh();
  await reading.promise;
  f.installer.hostChanged('local');
  f.installer.hostChanged('remote-selected', stale);
  f.installer.hostChanged('local', f.client);
  await f.installer.refresh();
  assert.equal((await f.installed())?.enabled, true);
  blocked.resolve(empty);
  await staleRun;
  assert.equal(staleReads, 1);
  assert.deepEqual(f.mutations, [INSTALL]);
  assert.deepEqual(f.errors, []);
});

test('a third enable refresh during the second empty-history read is not lost', async (t) => {
  const f = await fixture(t);
  const initial = deferred<boolean>();
  const second = deferred<boolean>();
  const readingSecond = deferred<void>();
  let checks = 0;
  let enabled = false;
  const installer = new ComputerHistorySkillInstaller({
    workspaceRoot: f.root,
    isNeeded: () => {
      checks += 1;
      if (checks === 1) return initial.promise;
      if (checks === 2) { readingSecond.resolve(); return second.promise; }
      return Promise.resolve(enabled);
    },
    onError: (error) => { f.errors.push(error); },
  });
  installer.hostChanged('local', f.client);
  const refresh = installer.refresh();
  initial.resolve(false);
  await readingSecond.promise;
  enabled = true;
  const third = installer.refresh();
  second.resolve(false);
  await Promise.all([refresh, third]);
  assert.equal((await f.installed())?.enabled, true);
  assert.deepEqual(f.mutations, [INSTALL]);
  assert.deepEqual(f.errors, []);
});

test('enablement arriving during the initial empty-history check is not lost', async (t) => {
  const f = await fixture(t);
  const checking = deferred<boolean>();
  let first = true;
  const installer = new ComputerHistorySkillInstaller({
    workspaceRoot: f.root,
    isNeeded: () => {
      if (first) { first = false; return checking.promise; }
      return Promise.resolve(true);
    },
    onError: (error) => { f.errors.push(error); },
  });
  installer.hostChanged('local', f.client);
  const enabled = installer.refresh();
  checking.resolve(false);
  await enabled;
  assert.equal((await f.installed())?.enabled, true);
  assert.deepEqual(f.errors, []);
});

test('a queued enable retries after the preceding history read rejects', async (t) => {
  const f = await fixture(t);
  const checking = deferred<boolean>();
  let first = true;
  const installer = new ComputerHistorySkillInstaller({
    workspaceRoot: f.root,
    isNeeded: () => {
      if (first) { first = false; return checking.promise; }
      return Promise.resolve(true);
    },
    onError: (error) => { f.errors.push(error); },
  });
  installer.hostChanged('local', f.client);
  const enabled = installer.refresh();
  checking.reject(new Error('History was temporarily unreadable'));
  await enabled;
  assert.equal((await f.installed())?.enabled, true);
  assert.deepEqual(f.mutations, [INSTALL]);
  assert.equal(f.errors.length, 1);
  assert.match(String(f.errors[0]), /temporarily unreadable/);
});

test('rejected installation is reported without a preference write and reconnect retries', async (t) => {
  const f = await fixture(t);
  const failureClient: SkillClient = {
    ...f.client,
    mutateSkillCatalog: async (input) => ({
      kind: 'rejected', reason: 'state_error',
      resolvedWorkspace: { target: input.context.workspace, hostCwd: f.root },
    }),
  };
  f.installer.hostChanged('local', failureClient);
  await f.installer.refresh();
  assert.match(String(f.errors[0]), /installation rejected: state_error/);
  assert.equal(await f.installed(), undefined);
  f.installer.hostChanged('local', f.client);
  await f.installer.refresh();
  assert.equal((await f.installed())?.enabled, true);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'maka-history-skill-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'default');
  const home = join(base, 'home');
  await mkdir(root);
  await mkdir(home);
  const repository = new SkillCatalogRepository({
    runWithRoot: (operation) => operation(root), homeDirectory: home,
  });
  const context = { workspace: { kind: 'host_path' as const, path: root } };
  const reads: Parameters<SkillClient['loadSkillCatalog']>[0][] = [];
  const mutations: SkillCatalogMutation[] = [];
  const errors: unknown[] = [];
  const client: SkillClient = {
    async loadSkillCatalog(request, view) {
      reads.push(request);
      assert.deepEqual(request, context);
      const page = await repository.query({ kind: 'start', view }, { projectRoot: root });
      assert.equal(page.kind, 'page');
      if (page.kind !== 'page') throw new Error('Unexpected catalog response');
      assert.equal(page.nextCursor, null);
      return { revision: page.revision, view, items: page.items, workspace: { target: request.workspace, hostCwd: root } };
    },
    async mutateSkillCatalog(input) {
      mutations.push(input.mutation);
      assert.deepEqual(input.context, context);
      const result = await repository.mutate(input, { projectRoot: root });
      return { ...result, resolvedWorkspace: { target: input.context.workspace, hostCwd: root } };
    },
  };
  const f = {
    root, client, context, reads, mutations, errors, needed: true,
    onError: () => {},
    installer: undefined as unknown as ComputerHistorySkillInstaller,
    restart: () => new ComputerHistorySkillInstaller({
      workspaceRoot: root, isNeeded: async () => f.needed,
      onError: (error) => { errors.push(error); f.onError(); },
    }),
    async installed() {
      const page = await client.loadSkillCatalog(context, 'governance');
      return page.items.find((item): item is SkillCatalogGovernanceItem => item.kind === 'skill' && item.ref === REF);
    },
    async mutate(mutation: SkillCatalogMutation) {
      const snapshot = await client.loadSkillCatalog(context, 'governance');
      const result = await repository.mutate({ expectedRevision: snapshot.revision, mutation }, { projectRoot: root });
      assert.equal(result.kind, 'committed');
    },
  };
  f.installer = f.restart();
  return f;
}
