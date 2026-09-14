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
import fs, {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createDefaultSettings } from '@maka/core/settings';
import {
  createSettingsStore,
  SettingsRecoveryError,
  SettingsRecoveryCommitUnknownError,
  type CorruptSettingsRecovery,
  type SettingsStoreOptions,
} from '../settings-store.js';
import { AtomicFileWriteCommitUnknownError } from '../atomic-file-write.js';

const corrupt = Buffer.from('{"appearance":{"theme":"dark"},"secret":"do-not-log"');
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(t: TestContext, options?: SettingsStoreOptions) {
  const root = await mkdtemp(join(tmpdir(), 'maka-settings-recovery-'));
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  const path = join(root, 'settings.json');
  await writeFile(path, corrupt);
  const events: CorruptSettingsRecovery[] = [];
  const store = createSettingsStore(
    root,
    options ?? {
      onCorruptRecovery: (event) => {
        events.push(event);
      },
    },
  );
  return { root, path, events, store };
}

for (const [name, bytes] of [
  ['empty', Buffer.alloc(0)],
  ['truncated', corrupt],
  ['invalid UTF-8 and truncated', Buffer.concat([corrupt, Buffer.from([0xff, 0xc3])])],
] as const) {
  test(`recovers ${name} settings with an exact byte backup before reporting`, async (t) => {
    const { root, path, store, events } = await fixture(t);
    await writeFile(path, bytes);
    assert.deepEqual(await store.get(), createDefaultSettings());
    assert.equal(events.length, 1);
    assert.equal(events[0].settingsPath, path);
    assert.equal(events[0].outcome, 'recovered');
    assert.match(events[0].backupPath, /settings\.json\.corrupt-\d+-[a-f0-9-]+$/u);
    assert.deepEqual(await readFile(events[0].backupPath), bytes);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), createDefaultSettings());
    await store.get();
    assert.equal(events.length, 1);
    assert.equal((await readdir(root)).length, 2);
  });
}

test('concurrent reads recover once and later reads observe external changes', async (t) => {
  const { path, store, events } = await fixture(t);
  const values = await Promise.all(Array.from({ length: 16 }, () => store.get()));
  assert.equal(events.length, 1);
  for (const value of values)
    assert.deepEqual(JSON.parse(JSON.stringify(value)), createDefaultSettings());
  const changed = createDefaultSettings();
  changed.appearance.theme = 'dark';
  await writeFile(path, JSON.stringify(changed));
  assert.equal((await store.get()).appearance.theme, 'dark');
  assert.equal(events.length, 1);
});

test('missing and valid JSON keep their normal behavior without a recovery report', async (t) => {
  const { path, root, store, events } = await fixture(t);
  await rm(path);
  await store.get();
  for (const text of ['null', '{}', '{"appearance":{"theme":"dark"}}']) {
    await writeFile(path, text);
    await store.get();
    assert.equal(await readFile(path, 'utf8'), text);
  }
  assert.deepEqual(events, []);
  assert.deepEqual(await readdir(root), ['settings.json']);
});

for (const callback of [
  undefined,
  () => {
    throw new Error('observer failed');
  },
  async () => {
    throw new Error('observer rejected');
  },
]) {
  test('optional or failing observer cannot change a successful recovery', async (t) => {
    const { store } = await fixture(t, { onCorruptRecovery: callback });
    assert.deepEqual(await store.get(), createDefaultSettings());
    await turn(); // Any unhandled observer rejection would fail this test.
  });
}

test('an async observer may reenter the store without deadlocking its queue', {
  timeout: 5_000,
}, async (t) => {
  const { root } = await fixture(t);
  let observed: Promise<unknown> | undefined;
  const store = createSettingsStore(root, {
    onCorruptRecovery: () => {
      observed = store.get();
      return observed.then(() => {});
    },
  });
  await store.get();
  assert.deepEqual(JSON.parse(JSON.stringify(await observed)), createDefaultSettings());
});

test('mutations use the recovered defaults and execute their own work once', async (t) => {
  const { path, store, events } = await fixture(t);
  assert.equal((await store.update({ appearance: { theme: 'dark' } })).appearance.theme, 'dark');
  await writeFile(path, corrupt);
  let predicates = 0;
  let patches = 0;
  const result = await store.updateIf(
    (current) => {
      predicates += 1;
      assert.deepEqual(current, createDefaultSettings());
      return true;
    },
    () => {
      patches += 1;
      return { appearance: { theme: 'light' } };
    },
  );
  assert.equal(result.applied, true);
  assert.equal(result.settings.appearance.theme, 'light');
  assert.equal(predicates, 1);
  assert.equal(patches, 1);
  await writeFile(path, corrupt);
  assert.equal((await store.upsertOnboardingMilestone('first_chat_sent', 'completed')).length, 1);
  await writeFile(path, corrupt);
  assert.deepEqual(await store.clearOnboardingMilestone('first_chat_sent'), []);
  assert.equal(events.length, 4);
  assert.equal(new Set(events.map((event) => event.backupPath)).size, 4);
});

test('private backups do not change the normal settings umask policy', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { path, store, events } = await fixture(t);
  await chmod(path, 0o644);
  const previous = process.umask(0o027);
  try {
    await store.get();
  } finally {
    process.umask(previous);
  }
  assert.equal((await stat(events[0].backupPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path)).mode & 0o777, 0o640);
});

for (const code of ['EACCES', 'EIO']) {
  test(`read ${code} does not reset or create backups`, async (t) => {
    const { path, root, store, events } = await fixture(t);
    const failure = Object.assign(new Error('read failed'), { code });
    const read = fs.readFile;
    t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === path) throw failure;
      return read(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(store.get(), (error) => error === failure);
    assert.deepEqual(await read(path), corrupt);
    assert.deepEqual(await readdir(root), ['settings.json']);
    assert.deepEqual(events, []);
  });
}

for (const phase of ['open', 'writeFile', 'chmod', 'sync', 'close', 'directory'] as const) {
  test(`backup ${phase} failure preserves source and reports the original cause`, {
    skip: process.platform === 'win32' && (phase === 'chmod' || phase === 'directory'),
  }, async (t) => {
    const { path, root, store, events } = await fixture(t);
    const failure = Object.assign(new Error(`backup ${phase} failed`), { code: 'EIO' });
    const originalOpen = fs.open;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const backup = String(args[0]).startsWith(`${path}.corrupt-`);
      if (backup && phase === 'open') throw failure;
      const handle = await originalOpen(...args);
      if (backup && phase !== 'open' && phase !== 'directory') {
        t.mock.method(
          handle,
          phase,
          async () => {
            throw failure;
          },
          { times: 1 },
        );
      }
      if (args[0] === root && phase === 'directory') {
        t.mock.method(handle, 'sync', async () => {
          throw failure;
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(store.get(), (error) => {
      assert.ok(error instanceof SettingsRecoveryError);
      assert.equal(error.phase, 'backup');
      assert.equal(error.cause, failure);
      assert.equal(error.settingsPath, path);
      assert.equal(error.backupPath, undefined);
      assert.equal(error.incompleteBackupPath, undefined);
      assert.equal(error.message.includes('do-not-log'), false);
      return true;
    });
    assert.deepEqual(await readFile(path), corrupt);
    assert.deepEqual(await readdir(root), ['settings.json']);
    assert.deepEqual(events, []);
  });
}

test('backup cleanup failure retains the original cause and identifies an incomplete file', async (t) => {
  const { path, store } = await fixture(t);
  const failure = new Error('backup write failed');
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).startsWith(`${path}.corrupt-`)) {
      t.mock.method(handle, 'writeFile', async () => {
        throw failure;
      });
    }
    return handle;
  });
  t.mock.method(fs, 'rm', async () => {
    throw new Error('cleanup failed');
  });
  syncBuiltinESMExports();
  await assert.rejects(store.get(), (error) => {
    assert.ok(error instanceof SettingsRecoveryError);
    assert.equal(error.cause, failure);
    assert.equal(error.backupPath, undefined);
    assert.ok(error.incompleteBackupPath?.startsWith(`${path}.corrupt-`));
    return true;
  });
  assert.deepEqual(await readFile(path), corrupt);
});

for (const planted of ['file', 'symlink'] as const) {
  test(`refuses a preexisting backup ${planted} without deleting it`, {
    skip: process.platform === 'win32' && planted === 'symlink',
  }, async (t) => {
    const { path, root, store } = await fixture(t);
    const target = join(root, 'unrelated');
    await writeFile(target, 'keep me');
    const originalOpen = fs.open;
    let collision = '';
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).startsWith(`${path}.corrupt-`)) {
        collision = String(args[0]);
        if (planted === 'file') await writeFile(collision, 'keep me');
        else await symlink(target, collision);
      }
      return originalOpen(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(
      store.get(),
      (error) =>
        error instanceof SettingsRecoveryError &&
        (error.cause as NodeJS.ErrnoException).code === 'EEXIST',
    );
    assert.equal(await readFile(collision, 'utf8'), 'keep me');
    assert.equal(await readFile(target, 'utf8'), 'keep me');
    assert.deepEqual(await readFile(path), corrupt);
  });
}

test('reset publication failure retains the complete backup and never reports success', async (t) => {
  const { path, root, store, events } = await fixture(t);
  const failure = Object.assign(new Error('rename failed'), { code: 'EACCES' });
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === path) throw failure;
    return rename(...args);
  });
  syncBuiltinESMExports();
  let backupPath = '';
  await assert.rejects(store.get(), (error) => {
    assert.ok(error instanceof SettingsRecoveryError);
    assert.equal(error.phase, 'reset');
    assert.equal(error.cause, failure);
    assert.ok(error.backupPath);
    backupPath = error.backupPath;
    return true;
  });
  assert.deepEqual(await readFile(backupPath), corrupt);
  assert.deepEqual(await readFile(path), corrupt);
  assert.equal((await readdir(root)).length, 2);
  assert.deepEqual(events, []);
});

for (const code of ['ENOENT', 'syntax']) {
  test(`a migration write failure (${code}) cannot trigger creation or recovery`, async (t) => {
    const { path, root, store, events } = await fixture(t);
    const text = '{"network":{"proxy":{"password":"legacy"}},"appearance":{"theme":"dark"}}';
    await writeFile(path, text);
    const failure =
      code === 'syntax'
        ? new SyntaxError('migration failed')
        : Object.assign(new Error('migration failed'), { code });
    t.mock.method(fs, 'rename', async () => {
      throw failure;
    });
    syncBuiltinESMExports();
    await assert.rejects(store.get(), (error) => error === failure);
    assert.equal(await readFile(path, 'utf8'), text);
    assert.deepEqual(await readdir(root), ['settings.json']);
    assert.deepEqual(events, []);
  });
}

test('normalization errors are not interpreted as invalid JSON', async (t) => {
  const { path, store, events } = await fixture(t);
  await writeFile(path, '{}');
  const failure = new SyntaxError('normalizer failed');
  t.mock.method(JSON, 'parse', () =>
    Object.defineProperty({}, 'network', {
      get() {
        throw failure;
      },
    }),
  );
  await assert.rejects(store.get(), (error) => error === failure);
  assert.deepEqual(events, []);
  assert.equal(await readFile(path, 'utf8'), '{}');
});

for (const mutation of ['get', 'update', 'updateIf', 'milestone'] as const) {
  test(`post-publication failure remains commit-unknown through ${mutation}`, {
    skip: process.platform === 'win32',
  }, async (t) => {
    const { root, path, store, events } = await fixture(t);
    const failure = Object.assign(new Error('reset directory sync failed'), { code: 'EIO' });
    const originalOpen = fs.open;
    let directories = 0;
    let syncs = 0;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === root && ++directories === 2) {
        t.mock.method(handle, 'sync', async () => {
          syncs += 1;
          throw failure;
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    let predicateCalls = 0;
    const operation =
      mutation === 'get'
        ? store.get()
        : mutation === 'update'
          ? store.update({ appearance: { theme: 'dark' } })
          : mutation === 'milestone'
            ? store.upsertOnboardingMilestone('first_chat_sent', 'completed')
            : store.updateIf(
                () => {
                  predicateCalls += 1;
                  return true;
                },
                { appearance: { theme: 'dark' } },
              );
    await assert.rejects(operation, (error) => {
      assert.ok(error instanceof SettingsRecoveryCommitUnknownError);
      assert.ok(error instanceof AtomicFileWriteCommitUnknownError);
      assert.equal(error.published, true);
      assert.ok(error.cause instanceof AtomicFileWriteCommitUnknownError);
      assert.equal(error.cause.cause, failure);
      assert.equal(error.settingsPath, path);
      assert.equal(error.backupPath, events[0]?.backupPath);
      assert.equal(error.message.includes('do-not-log'), false);
      return true;
    });
    assert.equal(syncs, 1);
    assert.equal(directories, 2);
    assert.equal(predicateCalls, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, 'commit-unknown');
    assert.deepEqual(await readFile(events[0].backupPath), corrupt);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), createDefaultSettings());
    assert.deepEqual(JSON.parse(JSON.stringify(await store.get())), createDefaultSettings());
    assert.equal(events.length, 1);
  });
}
