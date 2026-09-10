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
import { test } from 'node:test';
import { buildComputerUseTools, type CuDispatchBackend } from '../computer-use-tools.js';
import type { MakaToolContext } from '../tool-runtime.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('presentation fences live until the last queue tail, preserving same-turn stop authority', async () => {
  const firstGate = deferred();
  const firstEntered = deferred();
  const freshGate = deferred();
  const freshEntered = deferred();
  let calls = 0;
  const backend: CuDispatchBackend = {
    async preflight() {
      return { accessibility: true, screenRecording: true };
    },
    async run() {
      throw new Error('unexpected dispatch');
    },
    async listApps() {
      calls++;
      if (calls === 1) {
        firstEntered.resolve();
        await firstGate.promise;
      } else if (calls === 2) {
        freshEntered.resolve();
        await freshGate.promise;
      }
      return [];
    },
  };
  const maps: Map<unknown, unknown>[] = [];
  const NativeMap = globalThis.Map;
  class TrackedMap<K, V> extends NativeMap<K, V> {
    constructor(entries?: Iterable<readonly [K, V]> | null) {
      super(entries);
      maps.push(this);
    }
  }
  const tools = (() => {
    globalThis.Map = TrackedMap;
    try {
      return buildComputerUseTools({ backend });
    } finally {
      globalThis.Map = NativeMap;
    }
  })();
  const context = (turnId: string): MakaToolContext => ({
    sessionId: 'session',
    turnId,
    toolCallId: turnId,
    cwd: '/tmp',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  });
  const invoke = async (turnId: string) =>
    (await tools[0].impl({ action: 'list_apps' } as never, context(turnId))) as { text: string };

  for (let i = 0; i < 100; i++) tools.clearSession(`unknown-${i}`);
  assert.ok(maps.every((map) => map.size === 0));
  const first = invoke('turn-1');
  await firstEntered.promise;
  const stale = invoke('turn-2');
  tools.clearSession('session');
  const generations = maps.find((map) => map.get('session') === 1);
  assert.ok(generations, 'clear fences the active invocation queue');
  const fresh = invoke('turn-3');
  firstGate.resolve();
  assert.match((await first).text, /user_stopped/);
  assert.match((await stale).text, /user_stopped/);
  await freshEntered.promise;
  assert.equal(generations.get('session'), 1, 'old finally preserves the fresh queue tail');
  tools.clearSession('session');
  assert.equal(generations.get('session'), 2);
  const reused = invoke('turn-4');
  freshGate.resolve();
  assert.match((await fresh).text, /user_stopped/);
  assert.doesNotMatch((await reused).text, /user_stopped/);
  assert.equal(calls, 3);
  assert.equal(generations.size, 0, 'last queue tail releases its presentation fence');

  tools.clearSession('session');
  assert.equal(generations.size, 0, 'idle clear does not acquire a presentation fence');
  assert.match((await invoke('turn-4')).text, /user_stopped/);
  assert.doesNotMatch((await invoke('turn-5')).text, /user_stopped/);
  assert.equal(calls, 4);
});
