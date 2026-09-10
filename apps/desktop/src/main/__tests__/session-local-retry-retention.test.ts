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
import test from 'node:test';

test('local retry timers release delivery records while durable intents remain retryable', () => {
  const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  // Isolate GC and controlled timers; the service and SQLite store are real.
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { randomBytes } from 'node:crypto';
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { setImmediate as tick } from 'node:timers/promises';
    import { RuntimeHostRequestInterruptedError } from '@maka/runtime-host/client';
    import { DesktopSessionLocalService } from ${moduleUrl('../session-local-service.js')};
    import { DesktopSessionLocalStore } from ${moduleUrl('../session-local-store.js')};

    const directory = await mkdtemp(join(tmpdir(), 'maka-local-retry-retention-'));
    const store = new DesktopSessionLocalStore(join(directory, 'client.sqlite'));
    const timers = new Set();
    globalThis.setTimeout = (callback, delay) => {
      assert.equal(delay, 5000);
      const timer = { callback, unreferenced: false,
        unref() { this.unreferenced = true; } };
      timers.add(timer);
      return timer;
    };
    globalThis.clearTimeout = timer => {
      timer.callback = undefined;
      timers.delete(timer);
    };
    function fireTimers() {
      for (const timer of [...timers]) {
        assert.equal(timer.unreferenced, true);
        const callback = timer.callback;
        clearTimeout(timer);
        callback();
      }
    }
    const weak = [];
    const update = store.update.bind(store);
    store.update = record => {
      weak.push(new WeakRef(record), new WeakRef(record.intent.command.content));
      update(record);
    };
    const calls = [];
    let fail = true;
    const target = { partition: 'authority', profileId: 'profile',
      scope: { hostId: 'host', targetEpoch: 'target' },
      client: { hostEpoch: 'epoch' },
      async submit(input) {
        calls.push({ messageId: input.messageId, originHostEpoch: input.originHostEpoch });
        if (fail) throw new RuntimeHostRequestInterruptedError(
          'turn.message.submit', 'command', 'dispatched', 'connection_lost');
        return { disposition: 'turn_started', turnId: 'turn',
          skillInvocation: { loaded: [], failed: [], receipts: [] } };
      },
    };
    const service = new DesktopSessionLocalService(store, {
      targets: () => [target], changed() {}, onError: error => { throw error; },
    });
    async function waitFor(predicate) {
      for (let i = 0; i < 1000; i++) {
        if (predicate()) return;
        await tick();
      }
      assert.fail('Local delivery did not settle');
    }
    async function assertReleased(label) {
      for (let i = 0; i < 8; i++) { await tick(); global.gc(); }
      assert.equal(weak.filter(ref => ref.deref()).length, 0, label);
    }
    function enqueue(id) {
      store.enqueue(target.partition, { command: { sessionId: 'session', messageId: id,
        placement: 'current_turn', content: { text: randomBytes(96 * 1024).toString('base64') } },
        staged: [] });
      service.wake();
    }
    function retire(id) {
      service.cacheTranscript(target.scope, { sessionId: 'session', generation: 'generation',
        hostEpoch: 'epoch', durableThrough: 1,
        durable: [{ sequence: 1, message: {
          type: 'user', id, turnId: 'turn', ts: 1,
          text: store.get(target.partition, id).intent.command.content.text,
        } }], overlay: [], hasOlder: false, hasNewer: false });
    }
    try {
      enqueue('automatic');
      await waitFor(() => store.get(target.partition, 'automatic')?.state === 'unknown');
      await assertReleased('pending retry must read its payload from SQLite');
      assert.equal(store.get(target.partition, 'automatic').intent.command.content.text.length, 128 * 1024);
      assert.equal(timers.size, 1);
      service.wake();
      await tick(); await tick();
      assert.equal(calls.length, 1);
      assert.equal(timers.size, 1);
      fail = false;
      fireTimers();
      await waitFor(() => store.get(target.partition, 'automatic')?.state === 'accepted');
      assert.deepEqual(calls, [
        { messageId: 'automatic', originHostEpoch: 'epoch' },
        { messageId: 'automatic', originHostEpoch: 'epoch' },
      ]);
      assert.equal(timers.size, 0);
      retire('automatic');
      for (let i = 0; i < 8; i++) {
        const id = 'manual-' + i;
        fail = true;
        enqueue(id);
        await waitFor(() => store.get(target.partition, id)?.state === 'unknown');
        fail = false;
        service.reconcile(target, 'session', id);
        await waitFor(() => store.get(target.partition, id)?.state === 'accepted');
        retire(id);
      }
      await assertReleased('settled messages must not survive in old retry callbacks');
      assert.deepEqual(store.list(target.partition), []);
      assert.equal(timers.size, 8);
      const settledCalls = calls.length;
      fireTimers();
      await tick(); await tick();
      assert.equal(calls.length, settledCalls);
      assert.equal(timers.size, 0);
      fail = true;
      enqueue('shutdown');
      await waitFor(() => store.get(target.partition, 'shutdown')?.state === 'unknown');
      service.close();
      assert.equal(timers.size, 0);
      await assertReleased('shutdown releases callbacks without deleting durable intent');
      assert.equal(store.get(target.partition, 'shutdown').state, 'unknown');
    } finally {
      service.close(); store.close();
      await rm(directory, { recursive: true, force: true });
    }
  `], { encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
