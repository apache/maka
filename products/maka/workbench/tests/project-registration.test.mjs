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
import { registerHooks } from 'node:module';
import test from 'node:test';

const appRoot = new URL('../app/', import.meta.url);
const native = {
  nsh: `export const signal = v => { const r = () => v; r.set = n => { v = n; }; return r; };
    export const cleanup = () => {}; export const host = { call: async () => null };
    export const platform = { os: 'macos', idiom: 'desktop' };`,
  locale: `export const tr = (k, v) => v ? k.replace(/\\{(\\w+)\\}/g, (_, n) => String(v[n] ?? '')) : k;`,
};
const hooks = registerHooks({
  resolve(specifier, ctx, next) {
    const inApp = ctx.parentURL?.startsWith(appRoot.href);
    const key = inApp && specifier === './locale' ? 'locale' : specifier;
    if (key in native)
      return { url: `data:text/javascript,${encodeURIComponent(native[key])}`, shortCircuit: true };
    if (inApp && specifier.startsWith('.') && !/\.\w+$/.test(specifier))
      return next(`${specifier}.ts`, ctx);
    return next(specifier, ctx);
  },
});
const {
  admitWorkspaceLocation,
  locateWorkspaceDirectory,
  registerProjectDirectory,
  restoreArchivedProject,
} = await import(new URL('projectRegistration.ts', appRoot));
hooks.deregister();

const outcomeReply = (outcome) => ({
  operationId: 'op-1',
  reply: { receipt: { kind: 'recorded', outcome } },
});
const reply = (value) => outcomeReply({ kind: 'returned', result: { kind: 'success', value } });
const opts = { pause: async () => {} };
const admit = (host, path) => admitWorkspaceLocation(host, path, opts);
const register = (host, path) => registerProjectDirectory(host, path, opts);
const project = (id, name, path, extra) => ({
  reference: { id, revision: 'a'.repeat(64) },
  name,
  archived: false,
  available: true,
  path,
  ...extra,
});

const locs = (roots, revision = 1) => ({ source: { kind: 'managed', revision }, roots });

function makeHost({
  roots = [{ name: 'work', path: '/work' }],
  locations = locs([]),
  projectFor = () => null,
  ...overrides
} = {}) {
  return {
    refresh: async () => {},
    pendingSettings: async () => [],
    pendingControls: async () => [],
    query: async (ep, m, input) => {
      if (ep === 'agent' && m === 'directories')
        return { kind: 'roots', roots: typeof roots === 'function' ? roots() : roots };
      if (ep === 'settings' && m === 'workspaceLocations') return locations;
      if (ep === 'agent' && m === 'projects') {
        const existing = projectFor(input);
        const name = existing?.name ?? input.path.split('/').filter(Boolean).at(-1) ?? input.path;
        return { kind: 'directory', location: { path: input.path, name, project: existing } };
      }
      throw new Error(`Unexpected query ${ep}.${m}`);
    },
    ...overrides,
  };
}

test('admitWorkspaceLocation returns inside existing root, rejects pending, and handles Windows paths', async () => {
  let calls = 0;
  const inside = makeHost({
    roots: [{ name: 'Code', path: '/Users/dev/code' }],
    settingsMutation: async () => (calls++, reply({ status: 'committed' })),
  });
  assert.equal(await admit(inside, '/Users/dev/code/maka'), '/Users/dev/code/maka');
  assert.equal(calls, 0);

  const blocked = makeHost({ roots: [], pendingSettings: async () => [{ id: 'pending-1' }] });
  await assert.rejects(admit(blocked, '/outside/repo'), /Manage locations/);

  const win = locateWorkspaceDirectory(
    [
      { name: 'Root', path: 'C:\\Users\\dev' },
      { name: 'Code', path: 'C:\\Users\\dev\\code' },
    ],
    'C:\\Users\\dev\\code\\maka',
    'windows',
  );
  assert.deepEqual([win?.root.name, win?.names], ['Code', ['maka']]);
});

test('admitWorkspaceLocation appends deduplicated root, skips already-saved duplicates, and polls', async () => {
  const base = [{ name: 'maka', path: '/work/existing/maka' }];
  let [polls, saved] = [0, null];
  const host = makeHost({
    roots: () =>
      saved && ++polls >= 2 ? [...base, { name: 'maka (2)', path: '/other/maka' }] : base,
    locations: locs([{ label: 'maka', path: '/work/existing/maka' }]),
    settingsMutation: async (ep, m, input) => {
      assert.deepEqual([ep, m], ['settings', 'updateWorkspaceLocations']);
      saved = input.roots;
      return reply({ status: 'committed' });
    },
  });
  assert.equal(await admit(host, '/other/maka'), '/other/maka');
  assert.deepEqual(saved, [
    { label: 'maka', path: '/work/existing/maka' },
    { label: 'maka (2)', path: '/other/maka' },
  ]);
  assert.equal(polls, 2);

  let [dupPolls, mutations] = [0, 0];
  const dup = makeHost({
    roots: () => (++dupPolls >= 3 ? [{ name: 'maka', path: '/other/maka' }] : []),
    locations: locs([{ label: 'maka', path: '/other/maka' }], 2),
    settingsMutation: async () => (mutations++, reply({ status: 'committed' })),
  });
  assert.equal(await admit(dup, '/other/maka'), '/other/maka');
  assert.deepEqual([mutations, dupPolls], [0, 3]);
});

test('registerProjectDirectory auto-admits, retries changed conflicts, and maps non-returned receipts', async () => {
  let admitted = false;
  let calls = 0;
  const controls = [];
  const created = project('p-new', 'repo', '/extra/repo');
  const host = makeHost({
    roots: () => (admitted ? [{ name: 'repo', path: '/extra/repo' }] : []),
    projectFor: (input) => (
      assert.deepEqual(input, { kind: 'directory', path: '/extra/repo' }), null
    ),
    settingsMutation: async () => ((admitted = true), reply({ status: 'committed' })),
    control: async (method, input) => (
      controls.push([method, input]),
      reply(++calls === 1 ? { kind: 'changed' } : { kind: 'committed', project: created })
    ),
  });
  assert.deepEqual(await register(host, '/extra/repo'), { kind: 'registered', project: created });
  assert.equal(calls, 2);
  assert.deepEqual(controls[0], [
    'project',
    { kind: 'register', path: '/extra/repo', expected: null },
  ]);

  for (const [outcome, pattern] of [
    [{ kind: 'not_executed' }, /did not run\. Try again\./],
    [{ kind: 'unknown' }, /The original result is unconfirmed\. Check its receipt\./],
  ]) {
    const errHost = makeHost({ control: async () => outcomeReply(outcome) });
    await assert.rejects(register(errHost, '/work/repo'), pattern);
  }
});

test('registerProjectDirectory reconciles pending project controls and blocks on unresolved ones', async () => {
  const [abandoned, dismissed] = [[], []];
  let pending = [
    { id: 'op-unprepared', method: 'project', reference: null },
    { id: 'op-unknown', method: 'project', reference: { id: 'ref-1' } },
  ];
  const created = project('p-reconciled', 'repo', '/work/repo');
  const host = makeHost({
    pendingControls: async () => pending,
    abandonControl: async (id) => (
      abandoned.push(id), (pending = pending.filter((op) => op.id !== id)), { id }
    ),
    recoverControl: async (id) =>
      outcomeReply({ kind: id === 'op-unresolved' ? 'unresolved' : 'unknown' }).reply,
    dismissControl: async (id) => (
      dismissed.push(id), (pending = pending.filter((op) => op.id !== id))
    ),
    control: async () => reply({ kind: 'committed', project: created }),
  });

  assert.deepEqual(await register(host, '/work/repo'), { kind: 'registered', project: created });
  assert.deepEqual([abandoned, dismissed], [['op-unprepared'], ['op-unknown']]);

  pending = [{ id: 'op-unresolved', method: 'project', reference: { id: 'ref-2' } }];
  await assert.rejects(
    register(host, '/work/repo'),
    /The original result is unconfirmed\. Check its receipt\./,
  );
});

test('registerProjectDirectory returns archived without mutating and handles active/worktree paths', async () => {
  const archived = project('p-old', 'Legacy', '/work/legacy', { archived: true });
  let mutated = false;
  const archHost = makeHost({
    projectFor: () => archived,
    control: async () => ((mutated = true), reply({ kind: 'committed', project: archived })),
  });
  const archOutcome = await register(archHost, '/work/legacy');
  assert.equal(mutated, false);
  assert.deepEqual([archOutcome.kind, archOutcome.project], ['archived', archived]);

  const active = project('p-active', 'App', '/work/app');
  const controls = [];
  const activeHost = makeHost({
    projectFor: () => active,
    control: async (method, input) => (
      controls.push([method, input]),
      reply({
        kind: 'committed',
        project: {
          ...active,
          path: input.path,
          reference: { id: 'p-active', revision: 'b'.repeat(64) },
        },
      })
    ),
  });
  assert.equal((await register(activeHost, '/work/app')).kind, 'already_active');
  assert.equal(controls.length, 0);

  const wt = await register(activeHost, '/work/app-wt');
  assert.deepEqual([wt.kind, wt.project.path], ['already_active', '/work/app-wt']);
  assert.deepEqual(controls, [
    ['project', { kind: 'register', path: '/work/app-wt', expected: active.reference }],
  ]);
});

test('restoreArchivedProject restores and binds a new worktree path when needed', async () => {
  const archived = project('p-arch', 'Legacy', '/work/legacy-old', { archived: true });
  const restored = project('p-arch', 'Legacy', '/work/legacy-old', {
    reference: { id: 'p-arch', revision: 'b'.repeat(64) },
  });
  const bound = project('p-arch', 'Legacy', '/work/legacy-wt', {
    reference: { id: 'p-arch', revision: 'c'.repeat(64) },
  });
  const controls = [];
  const host = makeHost({
    query: undefined,
    control: async (method, input) => (
      controls.push([method, input]),
      reply({ kind: 'committed', project: input.kind === 'restore' ? restored : bound })
    ),
  });
  assert.deepEqual(await restoreArchivedProject(host, archived, '/work/legacy-wt'), bound);
  assert.deepEqual(controls, [
    ['project', { kind: 'restore', project: archived.reference }],
    ['project', { kind: 'register', path: '/work/legacy-wt', expected: restored.reference }],
  ]);
});
