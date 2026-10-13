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
import test from 'node:test';

import { PipeProcessDriver, type PipeProcessExit } from '../pipe-process-driver.js';

test('reports a partial stdin delivery failure before the child exit', async () => {
  const failures: Error[] = [];
  const events: string[] = [];
  let resolveExit!: (exit: PipeProcessExit) => void;
  const exited = new Promise<PipeProcessExit>((resolve) => {
    resolveExit = resolve;
  });
  const driver = new PipeProcessDriver({
    plan: {
      file: process.execPath,
      args: [
        '-e',
        [
          "const fs = require('node:fs');",
          'fs.closeSync(0);',
          'setTimeout(() => process.exit(0), 50);',
        ].join(' '),
      ],
      useShellOption: false,
      stdin: 'x'.repeat(8 * 1024 * 1024),
    },
    cwd: process.cwd(),
    outputDrainMs: 1_000,
    onData() {},
    onRootExit() {},
    onFailure(error) {
      events.push('failure');
      failures.push(error);
    },
    onExit(exit) {
      events.push('exit');
      resolveExit(exit);
    },
  });

  try {
    driver.writeInputs();
    await driver.ready;
    const exit = await exited;
    assert.equal(exit.exitCode, 0);
    assert.equal(failures.length, 1);
    // Windows reports a pipe whose last reader exited as EOF.
    assert.match(
      String((failures[0] as NodeJS.ErrnoException).code),
      /EPIPE|EOF|ERR_STREAM_DESTROYED/,
    );
    assert.deepEqual(events, ['failure', 'exit']);
  } finally {
    driver.dispose();
  }
});

test('reports the command PID apart from its supervisor and lets a signal to it end the command', async () => {
  let resolveExit!: (exit: PipeProcessExit) => void;
  const exited = new Promise<PipeProcessExit>((resolve) => {
    resolveExit = resolve;
  });
  let resolveReported!: (pid: number) => void;
  const reported = new Promise<number>((resolve) => {
    resolveReported = resolve;
  });
  let stdout = '';
  const driver = new PipeProcessDriver({
    plan: {
      file: process.execPath,
      args: ['-e', "process.stdout.write(process.pid + '\\n'); setInterval(() => {}, 1000);"],
      useShellOption: false,
    },
    cwd: process.cwd(),
    outputDrainMs: 1_000,
    onData(stream, data) {
      if (stream !== 'stdout') return;
      stdout += data;
      if (stdout.endsWith('\n')) resolveReported(Number.parseInt(stdout, 10));
    },
    onRootExit() {},
    onFailure(error) {
      throw error;
    },
    onExit: resolveExit,
  });

  try {
    driver.writeInputs();
    await driver.ready;
    const commandPid = await reported;
    assert.equal(driver.commandPid, commandPid);
    assert.notEqual(driver.commandPid, driver.pid);
    // Signalling only the reported PID, as `kill <pid>` would, reaches the command.
    process.kill(commandPid, 'SIGTERM');
    const exit = await exited;
    if (process.platform !== 'win32') assert.equal(exit.signal, 'SIGTERM');
  } finally {
    driver.kill('SIGKILL');
    driver.dispose();
  }
});
