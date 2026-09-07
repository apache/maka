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
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { terminateProcess } from '../process-termination.js';

const WINDOWS_PROCESS_SETTLEMENT_MS = 5_000;

test('first-stage Windows termination removes a supervisor and its descendant', {
  skip: process.platform !== 'win32',
  timeout: 10_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-process-tree-'));
  const workerPidPath = join(root, 'worker.pid');
  const supervisor = spawn(
    process.execPath,
    [
      '-e',
      `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  windowsHide: true,
});
writeFileSync(process.argv[1], String(worker.pid));
setInterval(() => {}, 1000);
`,
      workerPidPath,
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  let workerPid: number | undefined;
  try {
    workerPid = await waitForWorkerPid(workerPidPath);
    assert.equal(await terminateProcess(supervisor, 'SIGTERM'), true);
    await waitForExit(supervisor);
    await waitForProcessToExit(workerPid);
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      await terminateProcess(supervisor, 'SIGKILL');
    }
    if (workerPid !== undefined && isProcessAlive(workerPid)) {
      try {
        process.kill(workerPid);
      } catch {
        // The worker may exit between the liveness check and cleanup.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForWorkerPid(path: string): Promise<number> {
  const deadline = Date.now() + WINDOWS_PROCESS_SETTLEMENT_MS;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(path, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {
      // The supervisor has not written its worker PID yet.
    }
    await delay(20);
  }
  throw new Error('supervisor did not report its worker PID');
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + WINDOWS_PROCESS_SETTLEMENT_MS;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await delay(20);
  }
  assert.ok(
    child.exitCode !== null || child.signalCode !== null,
    'supervisor did not exit after taskkill',
  );
}

async function waitForProcessToExit(pid: number): Promise<void> {
  const deadline = Date.now() + WINDOWS_PROCESS_SETTLEMENT_MS;
  while (isProcessAlive(pid) && Date.now() < deadline) await delay(20);
  assert.equal(isProcessAlive(pid), false, `descendant ${pid} survived tree termination`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
