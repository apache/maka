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
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@maka/runtime/plugin-kernel';
import { PluginStorageService } from '@maka/runtime/plugin-data-services';
import { HostPluginDataRuntime } from '../server/plugin-data-runtime.js';

const namespace = Object.freeze({ extensionId: 'fixture.extension', scopeId: 'session:test' });

test('Plugin data persists CAS mutations and seals credentials at rest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-data-'));
  try {
    const runtime = new HostPluginDataRuntime(root);
    assert.deepEqual(await runtime.read(namespace, 'settings', 'mode'), {
      revision: 0,
      value: undefined,
    });
    assert.deepEqual(
      await runtime.mutate(namespace, 'settings', [
        { key: 'mode', value: 'strict', expectedRevision: 0 },
      ]),
      {
        mode: { revision: 1, value: 'strict' },
      },
    );
    await assert.rejects(
      runtime.mutate(namespace, 'settings', [{ key: 'mode', value: 'loose', expectedRevision: 0 }]),
      /revision conflict/u,
    );
    await runtime.mutate(namespace, 'storage', [
      { key: 'state/count', value: 1 },
      { key: 'state/name', value: 'fixture' },
    ]);
    await runtime.commitCredential(namespace, 'token', 'never-plaintext', { provider: 'fixture' });

    const restarted = new HostPluginDataRuntime(root);
    assert.deepEqual(await restarted.read(namespace, 'settings', 'mode'), {
      revision: 1,
      value: 'strict',
    });
    assert.deepEqual(Object.keys(await restarted.list(namespace, 'storage', 'state/')), [
      'state/count',
      'state/name',
    ]);
    assert.equal(
      await restarted.useCredential(namespace, 'token', (secret) => secret),
      'never-plaintext',
    );

    const files = await findJson(root);
    const disk = (await Promise.all(files.map((path) => readFile(path, 'utf8')))).join('\n');
    assert.equal(disk.includes('never-plaintext'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function findJson(root: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith('.json')) output.push(path);
    }
  };
  await visit(root);
  return output;
}

test('scratch paths survive runtime replacement and clear Agent startup writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-scratch-'));
  const signal = new AbortController().signal;
  let firstPath = '';
  try {
    await new HostPluginDataRuntime(root).withScratchDirectory(
      namespace,
      'catalog',
      signal,
      async (path) => {
        firstPath = path;
        assert.deepEqual(await readdir(path), []);
        await writeFile(join(path, 'agent-history'), 'synthetic');
      },
    );
    await assert.rejects(stat(firstPath), { code: 'ENOENT' });
    await new HostPluginDataRuntime(root).withScratchDirectory(
      namespace,
      'catalog',
      signal,
      async (path) => {
        assert.equal(path, firstPath);
        assert.deepEqual(await readdir(path), []);
      },
    );
    for (const different of [
      { ...namespace, scopeId: 'session:other' },
      { ...namespace, extensionId: 'other.extension' },
    ]) {
      await new HostPluginDataRuntime(root).withScratchDirectory(
        different,
        'catalog',
        signal,
        async (path) => {
          assert.notEqual(path, firstPath);
        },
      );
    }
    await new HostPluginDataRuntime(root).withScratchDirectory(
      namespace,
      'other-adapter',
      signal,
      async (path) => {
        assert.notEqual(path, firstPath);
      },
    );
    await assert.rejects(
      new HostPluginDataRuntime(root).withScratchDirectory(
        namespace,
        'catalog',
        signal,
        async (path) => {
          await writeFile(join(path, 'partial'), 'synthetic');
          throw new Error('initialization failed');
        },
      ),
      /initialization failed/,
    );
    await assert.rejects(stat(firstPath), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scratch leases serialize runtime instances and cancellation cannot clean another owner', {
  timeout: 10_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-scratch-lock-'));
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let announce!: () => void;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const signal = new AbortController().signal;
  const first = new HostPluginDataRuntime(root).withScratchDirectory(
    namespace,
    'catalog',
    signal,
    async (path) => {
      await writeFile(join(path, 'owned'), 'synthetic');
      announce();
      await hold;
      assert.equal(await readFile(join(path, 'owned'), 'utf8'), 'synthetic');
      return path;
    },
  );
  try {
    await started;
    const controller = new AbortController();
    const cancelled = new HostPluginDataRuntime(root).withScratchDirectory(
      namespace,
      'catalog',
      controller.signal,
      async () => {
        assert.fail('a cancelled waiter must not use the directory');
      },
    );
    const checked = assert.rejects(cancelled, /cancelled|AbortError/);
    controller.abort(new Error('cancelled'));
    await checked;
    let entered = false;
    const second = new HostPluginDataRuntime(root).withScratchDirectory(
      namespace,
      'catalog',
      signal,
      async (path) => {
        entered = true;
        assert.deepEqual(await readdir(path), []);
        return path;
      },
    );
    await delay(50);
    assert.equal(entered, false, 'a live owner excludes another runtime instance');
    release();
    assert.equal(await second, await first);
  } finally {
    release();
    await first;
    await rm(root, { recursive: true, force: true });
  }
});

test('a crashed scratch owner releases its native lease and the next process cleans residue', {
  timeout: 10_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-scratch-crash-'));
  const child = fork(new URL('./fixtures/plugin-scratch-holder.js', import.meta.url), [root], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  try {
    const [message] = await once(child, 'message');
    const path = (message as { path: string }).path;
    assert.equal(await readFile(join(path, 'owned'), 'utf8'), 'synthetic');
    const signal = new AbortController().signal;
    let entered = false;
    const next = new HostPluginDataRuntime(root).withScratchDirectory(
      namespace,
      'catalog',
      signal,
      async (directory) => {
        entered = true;
        assert.equal(directory, path);
        assert.deepEqual(await readdir(directory), []);
      },
    );
    await delay(50);
    assert.equal(entered, false, 'a live child process owns the directory');
    assert.equal(await readFile(join(path, 'owned'), 'utf8'), 'synthetic');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await next;
    assert.equal(entered, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('Plugin storage scratch calls preserve the consumer namespace through the public service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-plugin-scratch-service-'));
  const root = new Context();
  const storage = new PluginStorageService(root);
  storage.bindRuntime(new HostPluginDataRuntime(directory));
  try {
    const paths: string[] = [];
    for (const scope of ['profile', 'session:test']) {
      const consumer = root.extend({
        maka: { rootId: scope, packageId: 'fixture', entryId: 'adapter', generation: 1 },
      });
      await consumer
        .get<PluginStorageService>('storage')!
        .withScratchDirectory('catalog', new AbortController().signal, async (path) => {
          paths.push(path);
          assert.deepEqual(await readdir(path), []);
        });
    }
    assert.notEqual(paths[0], paths[1]);
  } finally {
    await root.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
