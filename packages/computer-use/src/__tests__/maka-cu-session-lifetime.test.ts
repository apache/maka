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
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createMakaCuBackend } from '../maka-cu-backend.js';

test('unknown clears retain bounded memory through the real backend and tools wiring', () => {
  // A fresh process isolates V8/test-runner history; both the stack and all IDs
  // remain reachable at measurement time. No executor is started.
  const script = `
    import assert from 'node:assert/strict';
    import { setImmediate as tick } from 'node:timers/promises';
    import { createMakaCuBackend } from ${JSON.stringify(new URL('../maka-cu-backend.js', import.meta.url).href)};
    import { buildComputerUseTools } from ${JSON.stringify(import.meta.resolve('@maka/runtime/computer-use-tools'))};
    let tools;
    let invalidations = 0;
    const backend = createMakaCuBackend({
      binaryPath: 'unused-test-executor',
      onSessionInvalidated: ({ sessionId }) => {
        invalidations++;
        tools.sessionEvents.reobserveRequired(sessionId);
      },
    });
    tools = buildComputerUseTools({ backend });
    const ids = Array.from({ length: 50000 }, (_, i) => 'unused-session-' + i);
    async function heap() {
      for (let i = 0; i < 6; i++) { await tick(); global.gc(); }
      return process.memoryUsage().heapUsed;
    }
    try {
      for (let i = 0; i < ids.length; i++) tools.clearSession('same-unused-session');
      const before = await heap();
      for (const id of ids) tools.clearSession(id);
      const retained = (await heap()) - before;
      assert.ok(retained < 4 * 1024 * 1024, 'retained heap bytes: ' + retained);
      assert.equal(invalidations, 0);
      assert.equal(backend.executorState().state, 'idle');
      assert.equal(ids.length, 50000);
      tools.clearSession(ids[0]);
      console.log(JSON.stringify({ retained }));
    } finally { backend.dispose(); }
  `;
  const child = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(child.status, 0, `${child.error ?? ''}\n${child.stdout}\n${child.stderr}`);
});

test('operation fences release after clear, reuse, reentrancy and executor death', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-cu-session-lifetime-'));
  t.after(async () => {
    backend.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  // Reuse the existing protocol fixture without importing/running its suite.
  const fixture = await readFile(new URL('./maka-cu-backend.test.js', import.meta.url), 'utf8');
  const mock = /const MOCK_SRC = String.raw\s*`([\s\S]*?)`;/.exec(fixture)?.[1];
  assert.ok(mock, 'existing owned fake RPC fixture');
  const binaryPath = join(dir, 'mock.cjs');
  await writeFile(binaryPath, mock);
  await chmod(binaryPath, 0o700);
  const logPath = join(dir, 'rpc.ndjson');
  const previousLog = process.env.MAKACU_MOCK_LOG;
  process.env.MAKACU_MOCK_LOG = logPath;
  t.after(() => {
    if (previousLog === undefined) delete process.env.MAKACU_MOCK_LOG;
    else process.env.MAKACU_MOCK_LOG = previousLog;
  });
  // Capture factory-owned maps only. Assertions use keys/values, never source
  // locations or allocation ordering; restore Map before any asynchronous work.
  const maps: Map<unknown, unknown>[] = [];
  const NativeMap = globalThis.Map;
  class TrackedMap<K, V> extends NativeMap<K, V> {
    constructor(entries?: Iterable<readonly [K, V]> | null) {
      super(entries);
      maps.push(this);
    }
  }
  const invalidations: string[] = [];
  const backend = (() => {
    globalThis.Map = TrackedMap;
    try {
      return createMakaCuBackend({
        binaryPath,
        imageDir: join(dir, 'images'),
        restartBackoffMs: 1,
        timeoutMs: 3_000,
        onSessionInvalidated: ({ sessionId }) => invalidations.push(sessionId),
      });
    } finally {
      globalThis.Map = NativeMap;
    }
  })();
  const signal = () => new AbortController().signal;
  const context = (sessionId: string) => ({ sessionId, turnId: 'turn', toolCallId: 'call' });
  const wait = (sessionId: string, durationMs = 0, abortSignal = signal()) =>
    backend.run({ type: 'wait', durationMs }, abortSignal, context(sessionId));
  const assertReleased = (sessionId: string) => {
    assert.ok(
      maps.every((map) => !map.has(sessionId)),
      `retained session: ${sessionId}`,
    );
  };
  const records = async () =>
    (await readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; method?: string; pid?: number });

  backend.clearSession('unknown');
  assert.equal(invalidations.length, 0);
  assertReleased('unknown');
  await backend.preflight(signal());
  const blocker = wait('blocker', 40);
  const old = wait('queued');
  backend.clearSession('queued');
  const fresh = wait('queued', 40);
  assert.equal((await blocker).outcome.ok, true);
  const oldOutcome = (await old).outcome;
  assert.equal(oldOutcome.ok, false);
  assert.equal(oldOutcome.error, 'aborted');
  assert.ok(
    maps.some((map) => map.has('queued')),
    'old finally must preserve fresh ownership',
  );
  assert.equal((await fresh).outcome.ok, true);
  assertReleased('queued');
  assertReleased('blocker');
  assert.ok(invalidations.includes('queued'));

  const hold = wait('hold', 40);
  const controller = new AbortController();
  const aborted = wait('reentrant', 0, controller.signal);
  const rejection = assert.rejects(aborted, /aborted/);
  let reentrant: ReturnType<typeof wait> | undefined;
  controller.signal.addEventListener('abort', () => {
    backend.clearSession('reentrant');
    reentrant = wait('reentrant');
  });
  controller.abort();
  await hold;
  await rejection;
  assert.ok(reentrant);
  assert.equal((await reentrant).outcome.ok, true);
  assertReleased('reentrant');

  for (let i = 0; i < 100; i++) {
    const id = `begun-${i}`;
    await backend.launchApp({ app: 'Fixture' }, signal(), context(id));
    assertReleased(id);
    backend.clearSession(id);
    assertReleased(id);
  }
  await backend.listApps!(signal()); // Flush preceding session.end replies.
  const log = await records();
  assert.equal(log.filter((entry) => entry.method === 'apps.launch').length, 100);
  assert.equal(log.filter((entry) => entry.method === 'session.end').length, 100);
  assert.equal(log.filter((entry) => entry.method === 'observe').length, 0);
  assert.equal(log.filter((entry) => entry.method === 'screen.capture').length, 0);
  assert.ok(invalidations.includes('begun-99'), 'known idle sessions still notify observers');
  assert.ok(maps.every((map) => map.size === 0));

  await backend.launchApp({ app: 'Fixture' }, signal(), context('released'));
  const beforeDeath = wait('death-blocker', 100);
  const stale = wait('released');
  const pid = (await records()).filter((entry) => entry.kind === 'start').at(-1)?.pid;
  assert.ok(pid);
  process.kill(pid, 'SIGKILL'); // Only this test's owned fake executor.
  for (let i = 0; i < 100 && backend.executorState().state === 'ready'; i++) await delay(2);
  assert.notEqual(backend.executorState().state, 'ready');
  const afterDeath = wait('released');
  await beforeDeath;
  const staleOutcome = (await stale).outcome;
  assert.equal(staleOutcome.ok, false);
  assert.equal(staleOutcome.error, 'aborted');
  assert.equal((await afterDeath).outcome.ok, true);
  assertReleased('released');
});
