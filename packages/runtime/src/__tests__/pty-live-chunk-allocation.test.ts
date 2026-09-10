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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IPty } from 'node-pty';
import { waitFor } from '@maka/core/test-only/async-primitives';
import { createSqliteShellRunStore } from '@maka/storage/shell-run-store';
import { ShellRunProcessManager } from '../shell-run-manager.js';
import type { ShellRunPtyDataEvent } from '../shell-run-contract.js';
import { loadPtyStack } from '../pty-stack.js';

test('live PTY chunking preserves code-point boundaries without expanding output into arrays', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'maka-pty-live-chunks-'));
  const store = createSqliteShellRunStore(cwd);
  const stack = await loadPtyStack();
  const originalSpawn = stack.spawn;
  const originalFrom = Array.from;
  const events: ShellRunPtyDataEvent[] = [];
  let onData: ((data: string) => void) | undefined;
  let onExit: ((exit: { exitCode: number }) => void) | undefined;
  const pty: IPty = {
    pid: 0,
    cols: 80,
    rows: 24,
    process: 'controlled-output',
    handleFlowControl: false,
    onData: (listener) => {
      onData = listener;
      return {
        dispose: () => {
          onData = undefined;
        },
      };
    },
    onExit: (listener) => {
      onExit = listener;
      return {
        dispose: () => {
          onExit = undefined;
        },
      };
    },
    write() {},
    resize() {},
    clear() {},
    pause() {},
    resume() {},
    kill: () => onExit?.({ exitCode: 0 }),
  };
  const manager = new ShellRunProcessManager({
    store,
    newId: () => 'chunk-test',
    now: Date.now,
    onPtyData: (event) => events.push(event),
  });
  const inputs = ['', 'A', '\r\n\x1b[31mRED\x1b[0m'];
  for (const length of [4095, 4096, 4097, 8191, 8192, 8193]) {
    inputs.push('x'.repeat(length), '🦊'.repeat(length));
    inputs.push(`${'a'.repeat(length)}\ud800X\udc00🦊中e\u0301`);
  }
  // Exercise both the JSON-encoded size ceiling and multiple publishes per callback.
  inputs.push('\x00'.repeat(16384), '🦊中'.repeat(12000));
  const expected: Array<{ sequence: number; data: string }> = [];
  let sequence = 0;
  for (const input of inputs) {
    const points = Array.from(input);
    let pending = '';
    for (let offset = 0; offset < points.length; offset += 4096) {
      const chunk = points.slice(offset, offset + 4096).join('');
      if (pending && Buffer.byteLength(JSON.stringify(pending + chunk)) > 40 * 1024) {
        expected.push({ sequence, data: pending });
        pending = '';
      }
      sequence++;
      pending += chunk;
      if (Buffer.byteLength(JSON.stringify(pending)) >= 32 * 1024) {
        expected.push({ sequence, data: pending });
        pending = '';
      }
    }
    if (pending) expected.push({ sequence, data: pending });
  }
  let expandedSlots = 0;
  try {
    stack.spawn = () => pty;
    const run = await manager.runBackgroundBash({
      sessionId: 'session',
      sourceTurnId: 'turn',
      sourceToolCallId: 'tool',
      cwd,
      command: 'controlled-output',
      pty: true,
      emitOutput() {},
    });
    assert.equal(run.kind, 'shell_run');
    Array.from = function (this: unknown, ...args: Parameters<typeof Array.from>) {
      const result = Reflect.apply(originalFrom, this, args);
      if (typeof args[0] === 'string' && new Error().stack?.includes('splitPtyData')) {
        expandedSlots += result.length;
      }
      return result;
    } as typeof Array.from;
    let consumed = '';
    for (const input of inputs) {
      assert.ok(onData);
      onData(input);
      consumed += input;
      if (input) {
        await waitFor(() => events.map((event) => event.data).join('') === consumed, {
          timeoutMs: 5000,
          message: 'PTY publish timer did not flush the callback',
        });
      }
      const replay = manager.getLivePtySnapshot('session', run.ref);
      assert.ok(replay);
      assert.equal(replay.buffer, consumed.slice(-16000));
    }
    // Terminal exit must still publish its pending tail before disposing the driver.
    assert.ok(onData);
    onData('FINAL');
    expected.push({ sequence: sequence + 1, data: 'FINAL' });
    onExit?.({ exitCode: 0 });
    await waitFor(() => manager.liveCount() === 0, {
      timeoutMs: 5000,
      message: 'PTY terminal settlement did not release the live run',
    });
    const terminal = await manager.inspectResource('session', run.ref);
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.output.mode, 'pty');
    assert.deepEqual(
      events.map(({ sequence: value, data }) => ({ sequence: value, data })),
      expected,
    );
    assert.ok(events.every((event) => Buffer.byteLength(JSON.stringify(event.data)) <= 40 * 1024));
    assert.equal(onData, undefined);
    assert.equal(onExit, undefined);
    assert.equal(expandedSlots, 0, 'raw callback code points must not be materialized as an array');
  } finally {
    Array.from = originalFrom;
    await manager.terminateAll();
    stack.spawn = originalSpawn;
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
