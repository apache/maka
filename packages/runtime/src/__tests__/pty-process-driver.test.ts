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

import { PtyProcessDriver, type PtyProcessExit } from '../pty-process-driver.js';
import { loadPtyStack } from '../pty-stack.js';

const TEST_TIMEOUT_MS = 5_000;

test('PTY driver exposes the live child PID and acknowledges forced exit', async () => {
  const stack = await loadPtyStack();
  let resolveReady!: () => void;
  let resolveExit!: (exit: PtyProcessExit) => void;
  let rejectInvariant!: (error: Error) => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const invariantFailure = new Promise<never>((_, reject) => {
    rejectInvariant = reject;
  });
  const exited = new Promise<PtyProcessExit>((resolve) => {
    resolveExit = resolve;
  });
  const driver = new PtyProcessDriver({
    stack,
    file: process.execPath,
    args: ['-e', "process.stdout.write('READY\\n'); setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    env: process.env,
    cols: 80,
    rows: 24,
    onData: (data) => {
      if (data.includes('READY')) resolveReady();
    },
    onExit: resolveExit,
    onInvariantFailure: rejectInvariant,
  });

  try {
    await withTimeout(Promise.race([ready, invariantFailure]), 'PTY child did not become ready');
    assert.ok(Number.isSafeInteger(driver.pid) && driver.pid > 0);
    driver.kill('SIGKILL');
    await withTimeout(
      Promise.race([exited, invariantFailure]),
      'PTY child did not acknowledge exit',
    );
  } finally {
    try {
      driver.kill('SIGKILL');
    } catch {
      // The PTY may already have closed after acknowledging exit.
    }
    driver.dispose();
  }
});

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), TEST_TIMEOUT_MS);
      timer.unref();
    }),
  ]);
}
