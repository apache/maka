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
import { openSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { runProcessWithBoundedTail } from '../shell-exec.js';
import { spawnOwnedProcess } from '../owned-child-process.js';

test('owned command retains argv, environment, binary descriptor payloads and nonzero exit status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-owned-descriptors-'));
  try {
    const source = join(directory, 'payload.bin');
    await writeFile(source, new Uint8Array([0, 255, 13, 10, 128]));
    const result = await runProcessWithBoundedTail(
      process.execPath,
      [
        '-e',
        `
      const fs=require('node:fs');
      process.stdout.write(JSON.stringify({env:process.env.OWNED_TEST, arg:process.argv[1],
        third:[...fs.readFileSync(3)], seventh:[...fs.readFileSync(7)]}));
      process.stderr.write('stderr stays separate');process.exit(23);
    `,
        'literal $HOME and \"quotes\"',
      ],
      {
        cwd: directory,
        timeoutMs: 5000,
        env: { ...process.env, OWNED_TEST: 'forwarded' },
        fdInputs: [
          { fd: 3, data: new Uint8Array([7, 0, 255]) },
          { fd: 7, sourceFd: openSync(source, 'r') },
        ],
      },
    );
    assert.equal(result.exitCode, 23);
    assert.deepEqual(JSON.parse(result.stdout), {
      env: 'forwarded',
      arg: 'literal $HOME and \"quotes\"',
      third: [7, 0, 255],
      seventh: [0, 255, 13, 10, 128],
    });
    assert.equal(result.stderr, 'stderr stays separate');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing owned executable rejects with its actual spawn error', async () => {
  await assert.rejects(
    runProcessWithBoundedTail(join(tmpdir(), 'maka-missing-program-43972'), [], {
      cwd: tmpdir(),
      timeoutMs: 5000,
    }),
    { code: 'ENOENT' },
  );
});

test('command NODE_OPTIONS applies once to the command, not to its supervisor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-owned-environment-'));
  try {
    const preload = join(directory, 'preload.cjs');
    await writeFile(preload, "process.stdout.write('PRELOAD\\n');");
    const result = await runProcessWithBoundedTail(
      process.execPath,
      ['-e', "process.stdout.write('COMMAND\\n')"],
      {
        cwd: directory,
        timeoutMs: 5000,
        env: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'PRELOAD\nCOMMAND\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('POSIX cancellation delivers SIGTERM exactly once to the owned command', {
  skip: process.platform === 'win32' ? 'POSIX detached process-group semantics required' : false,
}, async () => {
  const abort = new AbortController();
  const result = await runProcessWithBoundedTail(
    process.execPath,
    [
      '-e',
      `
    let count=0, timer;
    process.on('SIGTERM',()=>{count++; timer??=setTimeout(()=>{
      console.log('signals='+count);process.exit(0);
    },100);});
    console.log('ready');setInterval(()=>{},1000);
  `,
    ],
    {
      cwd: tmpdir(),
      timeoutMs: 5000,
      abortSignal: abort.signal,
      emitOutput: (_stream, data) => {
        if (data.includes('ready')) abort.abort();
      },
    },
  );
  assert.equal(result.aborted, true);
  assert.equal(result.stdout, 'ready\nsignals=1\n');
});

for (const signal of ['SIGPIPE', 'SIGUSR1'] as const) {
  // Node ignores SIGPIPE and reserves SIGUSR1 for its inspector, so a supervisor
  // that merely re-raised these would outlive its command.
  test(`supervisor mirrors a command that dies from ${signal}`, {
    skip: process.platform === 'win32' ? 'POSIX detached process-group semantics required' : false,
    timeout: 10_000,
  }, async () => {
    const { child, ready } = spawnOwnedProcess({
      program: '/bin/sh',
      args: ['-c', `kill -${signal.slice(3)} $$`],
      cwd: tmpdir(),
      shell: false,
      stdin: 'ignore',
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise((resolve) =>
      child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal })),
    );
    await ready;
    assert.deepEqual(await exited, { code: null, signal });
    assert.equal(stderr, '');
  });
}

test('unexpected POSIX supervisor death terminates its command and cannot report success', {
  skip: process.platform === 'win32' ? 'POSIX detached process-group semantics required' : false,
  timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-owned-supervisor-death-'));
  const marker = join(directory, 'started');
  const late = join(directory, 'late');
  const { child, ready } = spawnOwnedProcess({
    program: process.execPath,
    args: [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready');
      setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(late)}, 'late'), 1000);
      setInterval(() => {}, 1000);`,
    ],
    cwd: directory,
    shell: false,
    stdin: 'ignore',
  });
  child.on('error', () => {});
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  try {
    await ready;
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        await readFile(marker);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        assert.ok(Date.now() < deadline, 'command did not start');
        await delay(10);
      }
    }
    child.kill('SIGKILL');
    assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
    await delay(1200);
    await assert.rejects(readFile(late), { code: 'ENOENT' });
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
