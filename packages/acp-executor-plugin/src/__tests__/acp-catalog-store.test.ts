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
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExecutorCatalogEntry } from '@maka/core/executor-catalog';
import { AdmissionLimiter } from '@maka/runtime/admission-limiter';
import { AcpCatalog } from '../acp-catalog.js';
import { createAcpCatalogStore, type AcpCatalogPersistence } from '../acp-catalog-store.js';
import type { AcpLaunchSpec } from '../index.js';

// Recreate this storage client on restart; only the JSON file survives.
function diskStorage(path: string): AcpCatalogPersistence['storage'] {
  return {
    async get<T>() {
      try {
        return { revision: 1, value: JSON.parse(await readFile(path, 'utf8')) as T };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return { revision: 0, value: undefined };
        throw error;
      }
    },
    async set<T>(_key: string, value: T) {
      await writeFile(path, JSON.stringify(value));
      return { revision: 1, value };
    },
    async delete() {
      await rm(path, { force: true });
      return { revision: 2, value: undefined };
    },
  };
}

const entry: ExecutorCatalogEntry = {
  id: 'fixture-acp',
  displayName: 'Fixture',
  readiness: 'ready',
  models: [{ id: 'fast', name: 'Fast' }],
  currentModel: 'fast',
  supportsAttachments: true,
  supportsModelChange: true,
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'maka-acp-catalog-store-'));
  const executable = join(root, 'agent');
  const path = join(root, 'snapshot.json');
  await writeFile(executable, 'fixture', { mode: 0o700 });
  const make = (config: unknown = { executable }, launch: AcpLaunchSpec = { executable }) =>
    createAcpCatalogStore(
      { storage: diskStorage(path), key: 'snapshot' },
      entry.id,
      config,
      launch,
    );
  return { root, executable, path, make };
}

test('disk snapshot survives recreation without credentials or inherited environment dependencies', async () => {
  const f = await fixture();
  try {
    const config = { executable: f.executable, token: 'private-token', nested: { b: 2, a: 1 } };
    const store = (config: unknown, env: NodeJS.ProcessEnv) =>
      createAcpCatalogStore({ storage: diskStorage(f.path), key: 'snapshot' }, entry.id, config, {
        executable: f.executable,
        env,
      });
    await store(config, { LAUNCH_ID: 'first' }).save(entry);
    assert.equal((await readFile(f.path, 'utf8')).includes('private-token'), false);
    const recreated = store(
      { nested: { a: 1, b: 2 }, token: 'private-token', executable: f.executable },
      { LAUNCH_ID: 'second' },
    );
    assert.deepEqual(await recreated.load(), entry);
    assert.equal(await f.make({ ...config, token: 'different-account' }).load(), undefined);
    assert.equal(
      await f.make(config, { executable: f.executable, args: ['--other'] }).load(),
      undefined,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a catalog version bump re-derives presentation once without an executable or config change', async () => {
  const f = await fixture();
  const derived = {
    ...entry,
    displayName: 'Current adapter name',
    models: [{ id: 'fast', name: 'Current model name' }],
  };
  let probes = 0;
  const makeCatalog = () =>
    new AcpCatalog(
      new AdmissionLimiter(1),
      async () => {
        probes++;
        return derived;
      },
      () => ({ ...entry, readiness: 'unavailable' }),
      undefined,
      f.make(),
    );
  try {
    await f.make().save(entry);
    const current = JSON.parse(await readFile(f.path, 'utf8'));
    // Keep the binding and old derived values intact: only the code's catalog
    // version changes across this simulated upgrade.
    await writeFile(f.path, JSON.stringify({ ...current, version: current.version - 1 }));
    const upgraded = makeCatalog();
    try {
      assert.deepEqual(await upgraded.get(new AbortController().signal), derived);
      assert.deepEqual(await upgraded.get(new AbortController().signal), derived);
      assert.equal(probes, 1);
    } finally {
      await upgraded.dispose();
    }
    const repaired = JSON.parse(await readFile(f.path, 'utf8'));
    assert.equal(repaired.version, current.version);
    assert.equal(
      repaired.binding,
      current.binding,
      'config and executable metadata did not change',
    );
    assert.deepEqual(repaired.entry, derived);
    const restarted = makeCatalog();
    try {
      assert.deepEqual(await restarted.get(new AbortController().signal), derived);
      assert.equal(probes, 1, 'the refreshed derivation survives another restart without a probe');
    } finally {
      await restarted.dispose();
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('updated executables and missing sidecars cannot reuse a disk snapshot', async () => {
  const f = await fixture();
  try {
    await f.make().save(entry);
    await writeFile(f.executable, 'updated-fixture');
    assert.equal(await f.make().load(), undefined);
    await f.make().save(entry);
    await chmod(f.executable, 0o600);
    await assert.rejects(f.make().load());
    await chmod(f.executable, 0o700);
    const sidecar = join(f.root, 'sidecar');
    await writeFile(sidecar, 'sidecar', { mode: 0o700 });
    const store = () =>
      createAcpCatalogStore(
        { storage: diskStorage(f.path), key: 'snapshot' },
        entry.id,
        {},
        { executable: f.executable, requiredExecutables: [sidecar] },
      );
    await store().save(entry);
    await rm(sidecar);
    await assert.rejects(store().load());
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const changedModels of [false, true]) {
  test(`refresh after an executable update persists ${changedModels ? 'changed' : 'unchanged'} models with the new binding`, async () => {
    const f = await fixture();
    const store = f.make();
    let confirmSave!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      confirmSave = resolve;
    });
    let observed = entry;
    const catalog = new AcpCatalog(
      new AdmissionLimiter(1),
      async () => observed,
      () => ({ ...entry, readiness: 'unavailable' }),
      undefined,
      {
        load: () => store.load(),
        save: async (value) => {
          await store.save(value);
          confirmSave();
        },
      },
    );
    try {
      await catalog.get(new AbortController().signal);
      await firstSave;
      await writeFile(f.executable, 'updated-fixture');
      if (changedModels)
        observed = { ...entry, models: [{ id: 'new', name: 'New' }], currentModel: 'new' };
      assert.deepEqual(await catalog.get(new AbortController().signal, true), observed);
      await catalog.dispose();
      assert.deepEqual(
        await f.make().load(),
        observed,
        'restart must reuse the refreshed snapshot after an in-place executable update',
      );
    } finally {
      await catalog.dispose();
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test('corrupt, incompatible, and cross-executor snapshots fall back to fresh discovery', async () => {
  const f = await fixture();
  try {
    await f.make().save(entry);
    const valid = JSON.parse(await readFile(f.path, 'utf8'));
    const invalid = [
      '{broken',
      JSON.stringify({ ...valid, version: 1 }),
      JSON.stringify({ ...valid, version: 999 }),
      JSON.stringify({ ...valid, entry: { ...entry, id: 'other-agent' } }),
      JSON.stringify({ ...valid, entry: { ...entry, models: 'invalid' } }),
      JSON.stringify({ ...valid, entry: { ...entry, readiness: 'authentication_required' } }),
    ];
    for (const snapshot of invalid) {
      await writeFile(f.path, snapshot);
      let probes = 0;
      const catalog = new AcpCatalog(
        new AdmissionLimiter(1),
        async () => {
          probes++;
          return entry;
        },
        () => ({ ...entry, readiness: 'unavailable' }),
        undefined,
        f.make(),
      );
      try {
        assert.deepEqual(await catalog.get(new AbortController().signal), entry);
        assert.equal(probes, 1);
      } finally {
        await catalog.dispose();
      }
      assert.deepEqual(await f.make().load(), entry, 'discovery repairs the bad snapshot');
    }
    await f.make().save(undefined);
    assert.equal(await f.make().load(), undefined);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
