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
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, {
  chmod,
  lstat,
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

const secret = 'sk-live-SECRET';
const corrupt = Buffer.from(`{"a":${secret}}`);
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

async function changeDuringTempWrite(t: TestContext, root: string, change: () => Promise<void>) {
  // The shared writer captures its default open dependency at module load.
  // Intercept the handle method so the edit occurs inside the real temp write.
  const probePath = join(root, 'handle-probe');
  const probe = await fs.open(probePath, 'wx');
  const prototype = Object.getPrototypeOf(probe);
  const originalWrite = probe.writeFile;
  await probe.close();
  await rm(probePath);
  t.mock.method(
    prototype,
    'writeFile',
    async function (this: typeof probe, ...args: Parameters<typeof probe.writeFile>) {
      await originalWrite.apply(this, args);
      if (typeof args[0] === 'string' && args[1] === 'utf8') await change();
    },
  );
}

test('the invalid-token fixture would expose its secret if a parser error escaped', () => {
  assert.throws(
    () => JSON.parse(corrupt.toString('utf8')),
    (error) => {
      assert.ok(error instanceof SyntaxError);
      assert.ok(error.message.includes(secret));
      return true;
    },
  );
});

test('UTF-8 BOM settings are read without resetting or rewriting the file', async (t) => {
  const { path, root, store, events } = await fixture(t);
  const bytes = Buffer.from('\uFEFF{"appearance":{"theme":"dark"}}');
  await writeFile(path, bytes);
  assert.equal((await store.get()).appearance.theme, 'dark');
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await readdir(root), ['settings.json']);
  assert.deepEqual(events, []);
});

for (const bigEndian of [false, true]) {
  test(`UTF-16 ${bigEndian ? 'BE' : 'LE'} settings require UTF-8 conversion without resetting`, async (t) => {
    const { path, root, store, events } = await fixture(t);
    const bytes = Buffer.from('\uFEFF{"appearance":{"theme":"dark"}}', 'utf16le');
    if (bigEndian) bytes.swap16();
    await writeFile(path, bytes);
    await assert.rejects(store.get(), /Save the file as UTF-8/);
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(await readdir(root), ['settings.json']);
    assert.deepEqual(events, []);
  });
}

test('corrupt settings behind a symlink are not reset and the link survives', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { path, root, store, events } = await fixture(t);
  const target = join(root, 'linked-settings.json');
  await fs.rename(path, target);
  await symlink(target, path);
  await assert.rejects(store.get(), /symbolic-link target manually/);
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  assert.deepEqual(await readFile(target), corrupt);
  assert.equal((await readdir(root)).length, 2);
  assert.deepEqual(events, []);
});

test('a valid settings symlink keeps its existing read behavior', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { path, root, store, events } = await fixture(t);
  const target = join(root, 'linked-settings.json');
  const text = '{"appearance":{"theme":"dark"}}';
  await writeFile(target, text);
  await rm(path);
  await symlink(target, path);
  assert.equal((await store.get()).appearance.theme, 'dark');
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), text);
  assert.deepEqual(events, []);
});

test('a symlink installed during temp preparation is not replaced or followed for recovery', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { path, root, store, events } = await fixture(t);
  const target = join(root, 'linked-settings.json');
  const text = '{"appearance":{"theme":"dark"}}';
  await writeFile(target, text);
  await changeDuringTempWrite(t, root, async () => {
    await rm(path);
    await symlink(target, path);
  });
  syncBuiltinESMExports();
  await assert.rejects(
    store.get(),
    (error) =>
      error instanceof SettingsRecoveryError &&
      /symbolic-link target manually/.test(String(error.cause)),
  );
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), text);
  assert.equal(
    (await readdir(root)).some((name) => name.endsWith('.tmp')),
    false,
  );
  assert.deepEqual(events, []);
});

for (const stage of ['initial read', 'backup write', 'temp write'] as const) {
  test(`a repair of the same byte length during ${stage} is used without publishing defaults`, async (t) => {
    const { path, root, store, events } = await fixture(t);
    const repaired = '{"appearance":{"theme":"dark"}}';
    await writeFile(path, corrupt.toString('utf8').padEnd(Buffer.byteLength(repaired), ' '));
    if (stage === 'initial read') {
      const originalRead = fs.readFile;
      t.mock.method(
        fs,
        'readFile',
        async (...args: Parameters<typeof fs.readFile>) => {
          const result = await originalRead(...args);
          if (args[0] === path) await writeFile(path, repaired);
          return result;
        },
        { times: 1 },
      );
    } else if (stage === 'temp write') {
      await changeDuringTempWrite(t, root, () => writeFile(path, repaired));
    } else {
      const originalOpen = fs.open;
      t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (
          stage === 'backup write' &&
          String(args[0]).startsWith(`${path}.corrupt-`) &&
          args[1] === 'wx'
        ) {
          const originalWrite = handle.writeFile.bind(handle);
          t.mock.method(
            handle,
            'writeFile',
            async (...writeArgs: Parameters<typeof handle.writeFile>) => {
              await originalWrite(...writeArgs);
              await writeFile(path, repaired);
            },
          );
        }
        return handle;
      });
    }
    syncBuiltinESMExports();
    assert.equal((await store.get()).appearance.theme, 'dark');
    assert.equal(await readFile(path, 'utf8'), repaired);
    assert.deepEqual(events, []);
    const files = await readdir(root);
    assert.equal(
      files.some((name) => name.endsWith('.tmp')),
      false,
    );
    assert.equal(files.length, stage === 'initial read' ? 1 : 2);
  });
}

for (const change of ['remove', 'another corrupt value', 'same bytes in a new inode'] as const) {
  test(`a concurrent ${change} aborts the current recovery without retrying`, async (t) => {
    const { path, root, store, events } = await fixture(t);
    await changeDuringTempWrite(t, root, async () => {
      await rm(path);
      if (change !== 'remove')
        await writeFile(path, change === 'another corrupt value' ? '{' : corrupt);
    });
    syncBuiltinESMExports();
    await assert.rejects(
      store.get(),
      change === 'remove' ? /reset failed/ : /changed during recovery/,
    );
    if (change === 'remove') await assert.rejects(readFile(path), { code: 'ENOENT' });
    else
      assert.deepEqual(
        await readFile(path),
        change === 'another corrupt value' ? Buffer.from('{') : corrupt,
      );
    const files = await readdir(root);
    assert.equal(files.filter((name) => name.startsWith('settings.json.corrupt-')).length, 1);
    assert.equal(
      files.some((name) => name.endsWith('.tmp')),
      false,
    );
    assert.deepEqual(events, []);
  });
}

test('recovery survives successive process exits during backup writes', async (t) => {
  const { path, root, store, events } = await fixture(t);
  const interruptedBackups: string[] = [];
  for (const length of [0, 3]) {
    // Exit without unwinding the store's cleanup, as a terminated process would.
    // Exercise both an empty exclusive creation and a partially written backup.
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      import { createSettingsStore } from ${JSON.stringify(new URL('../settings-store.js', import.meta.url).href)};
      const open = fs.open;
      fs.open = async (...args) => {
        const handle = await open(...args);
        if (String(args[0]).startsWith(${JSON.stringify(`${path}.corrupt-`)}) && args[1] === 'wx') {
          handle.writeFile = async (bytes) => {
            await handle.write(bytes.subarray(0, ${length}));
            await handle.sync();
            process.exit(73);
          };
        }
        return handle;
      };
      syncBuiltinESMExports();
      await createSettingsStore(${JSON.stringify(root)}).get();
    `,
      ],
      { encoding: 'utf8', timeout: 5_000 },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 73, child.stderr);
    assert.deepEqual(await readFile(path), corrupt);
    const backup = (await readdir(root)).find(
      (name) => name.startsWith('settings.json.corrupt-') && !interruptedBackups.includes(name),
    );
    assert.ok(backup);
    interruptedBackups.push(backup);
    assert.deepEqual(await readFile(join(root, backup)), corrupt.subarray(0, length));
  }

  assert.deepEqual(await store.get(), createDefaultSettings());
  assert.equal(events.length, 1);
  assert.deepEqual(await readFile(events[0].backupPath), corrupt);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), createDefaultSettings());
  assert.deepEqual(await readFile(join(root, interruptedBackups[0])), Buffer.alloc(0));
  assert.deepEqual(await readFile(join(root, interruptedBackups[1])), corrupt.subarray(0, 3));
  assert.equal((await readdir(root)).length, 4);
});

test('failed resets reuse one complete backup across calls and recreated store instances', async (t) => {
  const { path, root, store, events } = await fixture(t);
  const failure = Object.assign(new Error('rename failed'), { code: 'EPERM' });
  const originalRename = fs.rename;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === path) throw failure;
    return originalRename(...args);
  });
  syncBuiltinESMExports();
  const backups = new Set<string>();
  for (const current of [store, store, createSettingsStore(root), createSettingsStore(root)]) {
    await assert.rejects(current.get(), (error) => {
      assert.ok(error instanceof SettingsRecoveryError);
      assert.equal(error.phase, 'reset');
      assert.equal(error.cause, failure);
      backups.add(error.backupPath!);
      return true;
    });
  }
  assert.equal(backups.size, 1);
  assert.equal((await readdir(root)).length, 2);
  assert.deepEqual(await readFile([...backups][0]), corrupt);
  assert.deepEqual(events, []);
});

test('failed resets reuse an alternative backup without replacing an interrupted write', async (t) => {
  const { path, root, store, events } = await fixture(t);
  const incomplete = `${path}.corrupt-${createHash('sha256').update(corrupt).digest('hex')}`;
  await writeFile(incomplete, corrupt.subarray(0, 3), { mode: 0o600 });
  const failure = Object.assign(new Error('rename failed'), { code: 'EPERM' });
  const originalRename = fs.rename;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === path) throw failure;
    return originalRename(...args);
  });
  syncBuiltinESMExports();
  const backups = new Set<string>();
  for (const current of [store, store, createSettingsStore(root), createSettingsStore(root)]) {
    await assert.rejects(current.get(), (error) => {
      assert.ok(error instanceof SettingsRecoveryError);
      assert.equal(error.phase, 'reset');
      assert.equal(error.cause, failure);
      assert.ok(error.backupPath);
      assert.notEqual(error.backupPath, incomplete);
      backups.add(error.backupPath);
      return true;
    });
  }
  assert.equal(backups.size, 1);
  assert.deepEqual(await readFile([...backups][0]), corrupt);
  assert.deepEqual(await readFile(incomplete), corrupt.subarray(0, 3));
  assert.deepEqual(await readFile(path), corrupt);
  assert.equal((await readdir(root)).length, 3);
  assert.deepEqual(events, []);
});

for (const phase of ['open', 'readFile', 'sync'] as const) {
  test(`an I/O failure during backup reuse (${phase}) does not create an alternative`, async (t) => {
    const { path, root, store, events } = await fixture(t);
    const backup = `${path}.corrupt-${createHash('sha256').update(corrupt).digest('hex')}`;
    await writeFile(backup, corrupt, { mode: 0o600 });
    const failure = Object.assign(new Error(`backup reuse ${phase} failed`), { code: 'EIO' });
    const originalOpen = fs.open;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const reuse = args[0] === backup && args[1] !== 'wx';
      if (reuse && phase === 'open') throw failure;
      const handle = await originalOpen(...args);
      if (reuse && phase !== 'open') {
        t.mock.method(handle, phase, async () => {
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
      return true;
    });
    assert.deepEqual(await readFile(path), corrupt);
    assert.deepEqual(await readFile(backup), corrupt);
    assert.equal((await readdir(root)).length, 2);
    assert.deepEqual(events, []);
  });
}

test('a different corruption after a failed reset gets its own backup and preserves both versions', async (t) => {
  const { path, root, store, events } = await fixture(t);
  const failure = Object.assign(new Error('rename failed'), { code: 'EPERM' });
  const originalRename = fs.rename;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === path) throw failure;
    return originalRename(...args);
  });
  syncBuiltinESMExports();
  const first = corrupt;
  const second = Buffer.from('{"appearance":');
  const backups: string[] = [];
  for (const [current, bytes] of [
    [store, first],
    [store, second],
    [createSettingsStore(root), second],
  ] as const) {
    await writeFile(path, bytes);
    await assert.rejects(current.get(), (error) => {
      assert.ok(error instanceof SettingsRecoveryError);
      assert.equal(error.phase, 'reset');
      assert.equal(error.cause, failure);
      assert.ok(error.backupPath);
      backups.push(error.backupPath);
      return true;
    });
    assert.deepEqual(await readFile(path), bytes);
  }
  assert.notEqual(backups[0], backups[1], 'new source bytes need a separate backup');
  assert.equal(backups[1], backups[2], 'a new store reuses the second complete backup');
  assert.deepEqual(await readFile(backups[0]), first);
  assert.deepEqual(await readFile(backups[1]), second);
  assert.equal((await readdir(root)).length, 3, 'only the source and its two byte versions remain');
  assert.deepEqual(events, []);
});

test('a completed backup survives directory sync failure and is fenced again before reuse', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { path, root, store } = await fixture(t);
  const originalOpen = fs.open;
  let directorySyncs = 0;
  let backupCreates = 0;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).startsWith(`${path}.corrupt-`) && args[1] === 'wx') backupCreates += 1;
    if (args[0] === root) {
      const originalSync = handle.sync.bind(handle);
      t.mock.method(handle, 'sync', async () => {
        if (++directorySyncs === 1) throw new Error('directory fence failed');
        await originalSync();
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  let backup = '';
  await assert.rejects(store.get(), (error) => {
    assert.ok(error instanceof SettingsRecoveryError);
    assert.ok(error.unsyncedBackupPath);
    backup = error.unsyncedBackupPath;
    assert.equal(error.backupPath, undefined);
    return true;
  });
  assert.deepEqual(await readFile(backup), corrupt);
  assert.deepEqual(await createSettingsStore(root).get(), createDefaultSettings());
  assert.equal(backupCreates, 1);
  assert.equal(directorySyncs, 3);
  assert.equal((await readdir(root)).length, 2);
});

for (const unsafe of ['tampered', 'partial', 'public mode', 'hard link'] as const) {
  test(`a ${unsafe} backup candidate is never reused or replaced`, {
    skip: process.platform === 'win32' && (unsafe === 'public mode' || unsafe === 'hard link'),
  }, async (t) => {
    const { path, root, store } = await fixture(t);
    const backup = `${path}.corrupt-${createHash('sha256').update(corrupt).digest('hex')}`;
    const bytes =
      unsafe === 'partial'
        ? corrupt.subarray(0, 3)
        : unsafe === 'tampered'
          ? Buffer.alloc(corrupt.length, 0x78)
          : corrupt;
    await writeFile(backup, bytes, { mode: 0o600 });
    if (unsafe === 'public mode') await chmod(backup, 0o644);
    if (unsafe === 'hard link') await fs.link(backup, join(root, 'another-link'));
    for (const current of [store, createSettingsStore(root)]) {
      await writeFile(path, corrupt);
      assert.deepEqual(await current.get(), createDefaultSettings());
    }
    assert.deepEqual(await readFile(backup), bytes);
    const backups = (await readdir(root)).filter((name) =>
      name.startsWith('settings.json.corrupt-'),
    );
    assert.equal(backups.length, 2);
    const alternative = backups.find((name) => join(root, name) !== backup);
    assert.ok(alternative);
    assert.deepEqual(await readFile(join(root, alternative)), corrupt);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), createDefaultSettings());
    assert.equal((await stat(join(root, alternative))).nlink, 1);
    if (process.platform !== 'win32')
      assert.equal((await stat(join(root, alternative))).mode & 0o777, 0o600);
  });
}

for (const [name, bytes] of [
  ['empty', Buffer.alloc(0)],
  ['truncated', Buffer.from('{"appearance":')],
  ['invalid token', corrupt],
  ['invalid UTF-8', Buffer.concat([corrupt, Buffer.from([0xff, 0xc3])])],
] as const) {
  test(`recovers ${name} settings with an exact byte backup before reporting`, async (t) => {
    const { root, path, store, events } = await fixture(t);
    await writeFile(path, bytes);
    assert.deepEqual(await store.get(), createDefaultSettings());
    assert.equal(events.length, 1);
    assert.equal(events[0].settingsPath, path);
    assert.equal(events[0].outcome, 'recovered');
    assert.match(events[0].backupPath, /settings\.json\.corrupt-[a-f0-9]{64}$/u);
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
  assert.equal(new Set(events.map((event) => event.backupPath)).size, 1);
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
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.unsyncedBackupPath !== undefined, phase === 'directory');
      return true;
    });
    assert.deepEqual(await readFile(path), corrupt);
    if (phase === 'directory') {
      const backups = (await readdir(root)).filter((name) =>
        name.startsWith('settings.json.corrupt-'),
      );
      assert.equal(backups.length, 1);
      assert.deepEqual(await readFile(join(root, backups[0])), corrupt);
    } else {
      assert.deepEqual(await readdir(root), ['settings.json']);
    }
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

test('backup failure cleanup does not remove an externally replaced backup entry', async (t) => {
  const { path, root, store } = await fixture(t);
  const originalOpen = fs.open;
  let backup = '';
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).startsWith(`${path}.corrupt-`) && args[1] === 'wx') {
      backup = String(args[0]);
      t.mock.method(handle, 'writeFile', async () => {
        await fs.rename(backup, join(root, 'moved-backup'));
        await writeFile(backup, 'externally replaced');
        throw new Error('backup write failed');
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  await assert.rejects(store.get(), SettingsRecoveryError);
  assert.equal(await readFile(backup, 'utf8'), 'externally replaced');
  assert.deepEqual(await readFile(path), corrupt);
});

for (const planted of ['file', 'symlink'] as const) {
  test(`refuses a preexisting backup ${planted} without deleting it`, {
    skip: process.platform === 'win32' && planted === 'symlink',
  }, async (t) => {
    const { path, root, store, events } = await fixture(t);
    const target = join(root, 'unrelated');
    await writeFile(target, 'keep me');
    const originalOpen = fs.open;
    let collision = '';
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      if (!collision && String(args[0]).startsWith(`${path}.corrupt-`) && args[1] === 'wx') {
        collision = String(args[0]);
        if (planted === 'file') await writeFile(collision, 'keep me');
        else await symlink(target, collision);
      }
      return originalOpen(...args);
    });
    syncBuiltinESMExports();
    assert.deepEqual(await store.get(), createDefaultSettings());
    assert.equal(await readFile(collision, 'utf8'), 'keep me');
    assert.equal(await readFile(target, 'utf8'), 'keep me');
    assert.equal(events.length, 1);
    assert.notEqual(events[0].backupPath, collision);
    assert.deepEqual(await readFile(events[0].backupPath), corrupt);
    if (planted === 'symlink') assert.equal((await lstat(collision)).isSymbolicLink(), true);
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
      assert.equal(error.message.includes(secret), false);
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
