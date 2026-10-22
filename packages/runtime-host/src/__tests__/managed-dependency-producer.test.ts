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
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeProducerProcessResult } from '../server/managed-dependency-process.js';
import {
  measureProducerTree,
  ProducerQuotaError,
  runManagedDependencyProducer,
} from '../server/managed-dependency-producer.js';

const supported = process.platform === 'win32' || process.platform === 'linux';
const producerTest = supported ? test : test.skip;

async function fixture(t: TestContext) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'maka-producer-test-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  return {
    projectRoot,
    nodeExecutablePath: process.execPath,
    npmCliPath: process.execPath,
    supervisorPath: process.execPath,
    manifestBytes: Buffer.from('{"name":"fixture","version":"1.0.0"}'),
    lockfileBytes: Buffer.from('{"lockfileVersion":3,"packages":{}}'),
  };
}

test('only a complete settled report authorizes cleanup', () => {
  for (const value of [
    null,
    [],
    {},
    { settled: true },
    { settled: true, failed: false, exitCode: null },
    { settled: true, failed: false, exitCode: 9 },
    { settled: true, failed: false, exitCode: 0, extra: true },
  ]) {
    assert.deepEqual(decodeProducerProcessResult(value), { settled: false });
  }
  assert.deepEqual(decodeProducerProcessResult({ settled: true, failed: false, exitCode: 0 }), {
    settled: true,
    failed: false,
    exitCode: 0,
  });
});

producerTest('pre-cancelled producer makes no staging changes and never launches', async (t) => {
  const input = await fixture(t);
  const result = await runManagedDependencyProducer(
    { ...input, abortSignal: AbortSignal.abort() },
    async () => assert.fail('launched'),
  );
  assert.equal(result.kind, 'failed');
  assert.deepEqual(await readdir(input.projectRoot), []);
});

producerTest(
  'large cache preparation observes timeout and cancellation before launch',
  async (t) => {
    const seed = await fixture(t);
    for (let batch = 0; batch < 80; batch++) {
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          writeFile(join(seed.projectRoot, String(batch * 100 + i)), 'cache'),
        ),
      );
    }
    for (const reason of ['timeout', 'cancelled'] as const) {
      const input = await fixture(t);
      const controller = new AbortController();
      const timer = reason === 'cancelled' ? setTimeout(() => controller.abort(), 1) : undefined;
      let launched = false;
      try {
        const result = await runManagedDependencyProducer(
          {
            ...input,
            cacheSeedRoot: seed.projectRoot,
            timeoutMs: reason === 'timeout' ? 1 : 600_000,
            abortSignal: controller.signal,
          },
          async () => {
            launched = true;
            return { settled: true, failed: false, exitCode: 0 };
          },
        );
        assert.equal(result.kind, 'failed');
        if (result.kind === 'failed') assert.equal(result.reason, reason);
        assert.equal(launched, false);
        // Cancellation must stop preparation, not merely reject after copying it all.
        const cache = join(input.projectRoot, '.maka-runtime', 'provision', 'cache');
        const copied = await readdir(cache).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
        assert.ok(copied.length < 8000);
      } finally {
        clearTimeout(timer);
      }
    }
  },
);

producerTest('final inventory remains inside the lifecycle boundary', async (t) => {
  for (const reason of ['timeout', 'cancelled'] as const) {
    const input = await fixture(t);
    const controller = new AbortController();
    const result = await runManagedDependencyProducer(
      { ...input, abortSignal: controller.signal },
      async () => {
        if (reason === 'timeout') {
          // Advance the monotonic clock without firing the timer: the final
          // inventory must check the deadline itself before reporting success.
          const expired = performance.now() + 600_001;
          t.mock.method(performance, 'now', () => expired);
        } else {
          setImmediate(() => controller.abort());
        }
        return { settled: true, failed: false, exitCode: 0 };
      },
    );
    t.mock.restoreAll();
    assert.equal(result.kind, 'failed');
    if (result.kind === 'failed') assert.equal(result.reason, reason);
  }
});

producerTest('cache copying stops between entries at the lifecycle boundary', async (t) => {
  const seed = await fixture(t);
  for (let i = 0; i < 32; i++) await writeFile(join(seed.projectRoot, String(i)), 'cache');
  for (const reason of ['timeout', 'cancelled'] as const) {
    const input = await fixture(t);
    const cache = join(input.projectRoot, '.maka-runtime', 'provision', 'cache');
    const controller = new AbortController();
    const now = performance.now();
    // Trigger only after copying starts, independently of disk speed. This
    // catches a copy that checks cancellation only after the entire tree.
    t.mock.method(performance, 'now', () => {
      if (existsSync(cache) && readdirSync(cache).length >= 5) {
        if (reason === 'cancelled') controller.abort();
        else return now + 600_001;
      }
      return now;
    });
    try {
      let launched = false;
      const result = await runManagedDependencyProducer(
        { ...input, cacheSeedRoot: seed.projectRoot, abortSignal: controller.signal },
        async () => {
          launched = true;
          return { settled: true, failed: false, exitCode: 0 };
        },
      );
      assert.equal(result.kind, 'failed');
      if (result.kind === 'failed') assert.equal(result.reason, reason);
      assert.equal(launched, false);
      const copied = await readdir(cache);
      assert.ok(copied.length >= 5 && copied.length < 32);
      await delay(20);
      assert.deepEqual(await readdir(cache), copied);
    } finally {
      t.mock.restoreAll();
    }
  }
});

test('inventory checks cancellation while enumerating a directory', async (t) => {
  const input = await fixture(t);
  for (let i = 0; i < 20; i++) await writeFile(join(input.projectRoot, String(i)), 'data');
  let checkpoints = 0;
  const cancelled = new Error('cancelled');
  await assert.rejects(
    measureProducerTree(input.projectRoot, { maxBytes: 4096, maxEntries: 100 }, false, () => {
      if (++checkpoints === 5) throw cancelled;
    }),
    (error) => error === cancelled,
  );
  assert.equal(checkpoints, 5);
});

producerTest(
  'fixed offline invocation omits ambient credentials and reserves scratch exclusively',
  async (t) => {
    const input = await fixture(t);
    const result = await runManagedDependencyProducer(input, async (launch) => {
      assert.deepEqual(launch.arguments.slice(launch.arguments.indexOf(input.npmCliPath) + 1), [
        'ci',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ]);
      assert.equal(launch.environment.PATH, undefined);
      assert.equal(launch.environment.NODE_OPTIONS, undefined);
      assert.equal(launch.environment.HTTPS_PROXY, undefined);
      assert.equal(launch.environment.NPM_TOKEN, undefined);
      assert.ok(launch.environment.npm_config_cache.startsWith(input.projectRoot));
      assert.equal(
        await readFile(join(input.projectRoot, 'package.json'), 'utf8'),
        input.manifestBytes.toString(),
      );
      const second = await runManagedDependencyProducer(input, async () =>
        assert.fail('duplicate launched'),
      );
      assert.equal(second.kind, 'failed');
      return { settled: true, failed: false, exitCode: 0 };
    });
    assert.equal(result.kind, 'completed');
  },
);

producerTest(
  'unsettled or rejected supervisor retains staging and never reports ordinary failure',
  async (t) => {
    for (const reject of [false, true]) {
      const input = await fixture(t);
      const result = await runManagedDependencyProducer(input, async () => {
        await writeFile(join(input.projectRoot, 'retained'), 'evidence');
        if (reject) throw new Error('lost supervisor');
        return { settled: false };
      });
      assert.equal(result.kind, 'unsettled');
      assert.equal(await readFile(join(input.projectRoot, 'retained'), 'utf8'), 'evidence');
    }
  },
);

producerTest(
  'timeout and cancellation wait for the supervisor settlement rather than the signal',
  async (t) => {
    for (const reason of ['timeout', 'cancelled'] as const) {
      const input = await fixture(t);
      const controller = new AbortController();
      let confirmed = false;
      const result = await runManagedDependencyProducer(
        { ...input, timeoutMs: 1000, abortSignal: controller.signal },
        async (launch) => {
          if (reason === 'cancelled') setTimeout(() => controller.abort(), 10);
          await new Promise<void>((resolve) =>
            launch.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          await delay(20);
          confirmed = true;
          return { settled: true, exitCode: null, failed: true };
        },
      );
      assert.equal(confirmed, true);
      assert.equal(result.kind, 'failed');
      if (result.kind === 'failed') assert.equal(result.reason, reason);
    }
  },
);

producerTest(
  'live quota overflow cancels the process and final overflow rejects success',
  async (t) => {
    for (const live of [false, true]) {
      const input = await fixture(t);
      const result = await runManagedDependencyProducer(
        { ...input, maxBytes: 4096 },
        async (launch) => {
          await writeFile(join(input.projectRoot, 'large'), Buffer.alloc(8192));
          if (live)
            await new Promise<void>((resolve) =>
              launch.signal.addEventListener('abort', () => resolve(), { once: true }),
            );
          return { settled: true, failed: false, exitCode: 0 };
        },
      );
      assert.equal(result.kind, 'failed');
      if (result.kind === 'failed') assert.equal(result.reason, 'quota');
    }
  },
);

producerTest('child output is bounded and redacted before diagnostics are returned', async (t) => {
  const result = await runManagedDependencyProducer(await fixture(t), async (launch) => {
    launch.onOutput(Buffer.from('https://user:secret-password@example.com/?token=secret-query\n'));
    for (let i = 0; i < 100; i++) launch.onOutput(Buffer.alloc(8192, 'x'));
    return { settled: true, failed: true, exitCode: 1 };
  });
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') {
    assert.ok(result.diagnostic.length <= 4096);
    assert.ok(!result.diagnostic.includes('secret-password'));
    assert.ok(!result.diagnostic.includes('secret-query'));
  }
});

test('byte and entry bounds include the root and fail strictly above the limit', async (t) => {
  const { projectRoot } = await fixture(t);
  await writeFile(join(projectRoot, 'one'), '1234');
  assert.deepEqual(await measureProducerTree(projectRoot, { maxBytes: 4, maxEntries: 2 }), {
    bytes: 4,
    entries: 2,
  });
  await assert.rejects(
    measureProducerTree(projectRoot, { maxBytes: 3, maxEntries: 2 }),
    ProducerQuotaError,
  );
  await assert.rejects(
    measureProducerTree(projectRoot, { maxBytes: 4, maxEntries: 1 }),
    ProducerQuotaError,
  );
});

test('inventory skips POSIX link targets and rejects Windows junctions', async (t) => {
  const { projectRoot } = await fixture(t);
  const target = await mkdtemp(join(tmpdir(), 'maka-producer-link-target-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  await writeFile(join(target, 'outside'), Buffer.alloc(8192));
  await mkdir(join(projectRoot, '.bin'));
  await symlink(
    target,
    join(projectRoot, '.bin', 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  if (process.platform === 'win32') {
    await assert.rejects(
      measureProducerTree(projectRoot, { maxBytes: 4096, maxEntries: 10 }),
      /reparse/,
    );
  } else {
    const measured = await measureProducerTree(projectRoot, { maxBytes: 4096, maxEntries: 10 });
    assert.equal(measured.entries, 3);
    assert.equal(measured.bytes, Buffer.byteLength(target));
  }
});

producerTest('non-registry lock entries are rejected before launching', async (t) => {
  const input = await fixture(t);
  for (const resolved of [
    'git+https://example.com/p',
    'file:../p',
    'https://registry.npmjs.org.evil.test/p',
  ]) {
    const result = await runManagedDependencyProducer(
      {
        ...input,
        lockfileBytes: Buffer.from(
          JSON.stringify({
            lockfileVersion: 3,
            packages: { 'node_modules/p': { resolved, integrity: 'sha512-YQ==' } },
          }),
        ),
      },
      async () => assert.fail('unsafe source launched'),
    );
    assert.equal(result.kind, 'failed');
  }
});

test('unsupported platforms refuse before preparing staging', { skip: supported }, async (t) => {
  const input = await fixture(t);
  const result = await runManagedDependencyProducer(input, async () => assert.fail('launched'));
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.equal(result.reason, 'unsupported');
  assert.deepEqual(await readdir(input.projectRoot), []);
});

test('inventory tolerates entries removed while it is scanning', async (t) => {
  const { projectRoot } = await fixture(t);
  const directory = join(projectRoot, 'changing');
  await mkdir(directory);
  for (let i = 0; i < 20; i++) await writeFile(join(directory, String(i)), 'data');
  await Promise.all([
    measureProducerTree(projectRoot, { maxBytes: 4096, maxEntries: 100 }),
    rm(directory, { recursive: true }),
  ]);
});

producerTest('an existing scratch alias is rejected without writing through it', async (t) => {
  const input = await fixture(t);
  const outside = await fixture(t);
  await symlink(
    outside.projectRoot,
    join(input.projectRoot, '.maka-runtime'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const result = await runManagedDependencyProducer(input, async () => assert.fail('launched'));
  assert.equal(result.kind, 'failed');
  assert.deepEqual(await readdir(outside.projectRoot), []);
});
