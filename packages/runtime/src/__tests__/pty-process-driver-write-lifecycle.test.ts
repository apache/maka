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
import { test } from 'node:test';

const DRIVER_MODULE_URL = new URL('../pty-process-driver.js', import.meta.url).href;
const CHILD_SOURCE = String.raw`
  import assert from 'node:assert/strict';
  import { createRequire, syncBuiltinESMExports } from 'node:module';
  import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';

  const require = createRequire(import.meta.url);
  const fs = require('node:fs');
  const { spawn: spawnPty } = require('node-pty');
  const originalWriteSync = fs.writeSync;
  let blockedFd;
  fs.writeSync = (...args) => {
    if (args[0] === blockedFd) {
      const error = new Error('backpressure');
      error.code = 'EAGAIN';
      throw error;
    }
    return originalWriteSync(...args);
  };
  syncBuiltinESMExports();
  const { PtyProcessDriver } = await import(process.env.DRIVER_MODULE_URL);

  const root = mkdtempSync(join(tmpdir(), 'maka-pty-driver-fd-reuse-'));
  const closeFlag = join(root, 'close');
  const terminals = [];
  let terminal;
  let sentinel;
  let exited = false;
  let invariantFailure;
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const driver = new PtyProcessDriver({
    stack: { spawn: (...args) => { terminal = spawnPty(...args); return terminal; } },
    file: '/bin/sh',
    args: ['-c', 'trap "" HUP; printf READY; while [ ! -f "$1" ]; do sleep 0.01; done; exec 0<&- 1>&- 2>&-; sleep 30', 'fixture', closeFlag],
    cwd: process.cwd(),
    env: process.env,
    cols: 80,
    rows: 24,
    onData(data) { if (data.includes('READY')) ready(); },
    onExit() { exited = true; },
    onInvariantFailure(error) { invariantFailure = error; },
  });

  try {
    await started;
    assert.equal(driver.supportsInputFence, true, 'pinned writer patch must be installed');
    const originalFd = terminal.fd;
    blockedFd = originalFd;
    // Hold the retry until the other PTY owns exactly the retired fd number.
    const originalSetTimeout = globalThis.setTimeout;
    let retry;
    globalThis.setTimeout = (fn, ms, ...args) => {
      if (ms === 1) { retry = () => fn(...args); return originalSetTimeout(() => {}, 1000); }
      return originalSetTimeout(fn, ms, ...args);
    };
    if (process.env.FIRST_WRITE !== '1') driver.write('SECRET-PASSWORD\r');
    globalThis.setTimeout = originalSetTimeout;
    if (process.env.FIRST_WRITE !== '1') assert.ok(retry, 'secret must be queued under backpressure');
    const closed = new Promise(resolve => terminal._socket.once('close', resolve));
    writeFileSync(closeFlag, 'close');
    // Linux reads EIO immediately; macOS may defer it until process exit.
    // Close the actual read stream there to exercise the same pre-exit window.
    if (process.platform === 'darwin') terminal._socket.destroy();
    await closed;
    assert.equal(exited, false, 'exercise EIO before child exit');
    let output = '';
    for (let attempt = 0; attempt < 32; attempt++) {
      const next = spawnPty(process.execPath, ['-e',
        'process.stdin.setRawMode(true); process.stdin.on("data", data => process.stdout.write("B-GOT:" + data)); process.stdout.write("B-READY");'
      ], { cols: 80, rows: 24 });
      terminals.push(next);
      next.onData(data => { if (next === sentinel) output += data; });
      if (next.fd === originalFd || process.platform === 'darwin') { sentinel = next; break; }
    }
    assert.ok(sentinel, 'second real PTY must reuse the original fd');
    if (process.platform === 'linux') assert.equal(sentinel.fd, originalFd);
    while (!output.includes('B-READY')) await new Promise(resolve => setTimeout(resolve, 5));
    fs.writeSync = originalWriteSync;
    syncBuiltinESMExports();
    if (process.env.FIRST_WRITE === '1') {
      assert.throws(() => driver.write('FIRST-SECRET\r'), /input is closed/);
    } else {
      retry();
    }
    assert.throws(() => driver.resize(132, 43), /input is closed/);
    sentinel.write('SAFE\r');
    while (!output.includes('B-GOT:SAFE')) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(output.includes('SECRET'), false, 'private input reached the other PTY');
    await assert.rejects(driver.drainInput(AbortSignal.timeout(1000)), /input is closed/);
    assert.throws(() => driver.write('SECOND-SECRET\r'), /input is closed/);
    assert.equal(invariantFailure, undefined, 'normal input closure is not an integrity failure');
  } finally {
    driver.dispose();
    terminal?.kill('SIGKILL');
    for (const pty of terminals) pty.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
`;

test('closed PTY input cannot reach a replacement PTY (same fd on Linux) before child exit', {
  skip: process.platform === 'win32' ? 'Unix PTY file-descriptor lifecycle only' : false,
}, () => {
  for (const firstWrite of ['0', '1']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', CHILD_SOURCE], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, DRIVER_MODULE_URL, FIRST_WRITE: firstWrite },
    });

    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
  }
});
