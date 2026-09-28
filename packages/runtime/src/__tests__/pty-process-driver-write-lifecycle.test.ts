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
  import { closeSync, constants, fstatSync, mkdtempSync, openSync, rmSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';

  const require = createRequire(import.meta.url);
  const fs = require('node:fs');
  const originalWriteSync = fs.writeSync;
  let firstWrite = true;
  fs.writeSync = (...args) => {
    if (firstWrite) {
      firstWrite = false;
      const error = new Error('backpressure');
      error.code = 'EAGAIN';
      throw error;
    }
    return originalWriteSync(...args);
  };
  syncBuiltinESMExports();
  const { PtyProcessDriver } = await import(process.env.DRIVER_MODULE_URL);

  const root = mkdtempSync(join(tmpdir(), 'maka-pty-driver-fd-reuse-'));
  const originalPath = join(root, 'original');
  const sentinelPath = join(root, 'sentinel');
  const retainedFds = [];
  let originalFd = openSync(originalPath, constants.O_RDWR | constants.O_CREAT, 0o600);
  let sentinelFd;
  let invariantFailure;
  const pty = {
    fd: originalFd,
    pid: 1,
    write() {},
    resize() {},
    kill() {},
    onData() { return { dispose() {} }; },
    onExit() { return { dispose() {} }; },
  };
  const driver = new PtyProcessDriver({
    stack: { spawn: () => pty },
    file: process.execPath,
    args: [],
    cwd: process.cwd(),
    env: process.env,
    cols: 80,
    rows: 24,
    onData() {},
    onExit() {},
    onInvariantFailure(error) { invariantFailure = error; },
  });

  try {
    driver.write('SECRET-PASSWORD\r');
    closeSync(originalFd);
    originalFd = -1;
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const fd = openSync(
        sentinelPath,
        constants.O_RDWR | constants.O_CREAT | (attempt === 0 ? constants.O_TRUNC : 0),
        0o600,
      );
      retainedFds.push(fd);
      if (fd === pty.fd) {
        sentinelFd = fd;
        break;
      }
      if (fd > pty.fd) break;
    }
    assert.notEqual(sentinelFd, undefined, 'retired PTY fd was not reused');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.match(invariantFailure?.message ?? '', /PTY input delivery failed/);
    assert.equal(fstatSync(sentinelFd).size, 0, 'private input reached the reused fd');
  } finally {
    driver.dispose();
    if (originalFd !== -1) closeSync(originalFd);
    for (const fd of retainedFds) closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
`;

test('drops queued private input when the Unix PTY fd is reused', {
  skip: process.platform === 'win32' ? 'Unix PTY file-descriptor lifecycle only' : false,
}, () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', CHILD_SOURCE], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, DRIVER_MODULE_URL },
  });

  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
});
