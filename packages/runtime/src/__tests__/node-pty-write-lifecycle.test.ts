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

const CHILD_SOURCE = String.raw`
  import { createRequire } from 'node:module';
  import {
    closeSync,
    constants,
    fstatSync,
    mkdtempSync,
    openSync,
    rmSync,
  } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';

  const require = createRequire(import.meta.url);
  const fs = require('node:fs');
  const { spawn: spawnPty } = await import('node-pty');
  const root = mkdtempSync(join(tmpdir(), 'maka-node-pty-write-lifecycle-'));
  const sentinelPath = join(root, 'sentinel');
  const sentinelFds = [];
  let terminal;

  try {
    terminal = spawnPty(
      process.execPath,
      ['-e', 'process.stdin.pause(); setInterval(() => {}, 1000)'],
      { cols: 80, rows: 24 },
    );
    const terminalFd = terminal.fd;

    // Hold the unpatched writer at its raw-fd submission boundary. Replaying that
    // request only after fd reuse models the dangerous libuv schedule without
    // coupling PTY teardown to starvation of the process-wide worker pool.
    const originalWrite = fs.write;
    let deferredRawWrite;
    fs.write = (...args) => {
      if (deferredRawWrite !== undefined) {
        throw new Error('Expected at most one raw PTY write before the lifecycle fence');
      }
      deferredRawWrite = args;
    };
    try {
      terminal.write('R'.repeat(4 * 1024 * 1024));
    } finally {
      fs.write = originalWrite;
    }

    setTimeout(() => terminal.kill('SIGKILL'), 5);
    await new Promise((resolve) => terminal.onExit(resolve));

    // Retain any lower-numbered descriptors until the retired PTY fd is reused.
    let sentinelFd;
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const fd = openSync(
        sentinelPath,
        constants.O_RDWR |
          constants.O_CREAT |
          (sentinelFds.length === 0 ? constants.O_TRUNC : 0),
        0o600,
      );
      sentinelFds.push(fd);
      if (fd === terminalFd) {
        sentinelFd = fd;
        break;
      }
      if (fd > terminalFd) break;
    }
    if (sentinelFd === undefined) {
      throw new Error('Could not reuse retired PTY fd ' + terminalFd);
    }

    if (deferredRawWrite !== undefined) {
      const [fd, buffer, offset] = deferredRawWrite;
      await new Promise((resolve, reject) => {
        originalWrite(fd, buffer, offset, (error) => (error ? reject(error) : resolve()));
      });
    }

    if (fstatSync(sentinelFd).size !== 0) {
      throw new Error('Queued PTY input reached the reused sentinel fd');
    }
    console.log('sentinel-ok');
  } finally {
    try {
      terminal?.kill('SIGKILL');
    } catch {}
    for (const fd of sentinelFds) closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
`;

test('does not carry queued Unix PTY writes past native exit', {
  skip: process.platform === 'win32' ? 'Unix PTY file-descriptor lifecycle only' : false,
}, () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', CHILD_SOURCE], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'sentinel-ok');
  assert.doesNotMatch(result.stderr, /Unhandled pty write error/);
});
