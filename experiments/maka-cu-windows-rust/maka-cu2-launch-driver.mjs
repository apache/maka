#!/usr/bin/env node
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

/* Deterministic maka.cu/2 apps.launch check; the launched process is only the WPF fixture. */
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [helperExe, fixtureExe, outPath] = process.argv.slice(2);
if (!helperExe || !fixtureExe || !outPath) process.exit(2);
const fixturePath = resolve(fixtureExe);
const imageDir = await mkdtemp(join(tmpdir(), 'maka-cu2-launch-images-'));
const child = spawn(helperExe, ['host'], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
const lines = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const waiter = pending.get(message.id);
  if (waiter) {
    pending.delete(message.id);
    waiter(message);
  }
});
function call(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timeout`));
    }, 20_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
const tests = [];
function record(name, pass, note = '') {
  tests.push({ name, status: pass ? 'pass' : 'fail', ...(note ? { note } : {}) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${note ? ` — ${note}` : ''}`);
}
let launchedPid = null;
let session = `cu2-launch-${process.pid}-${Date.now()}`;
try {
  const hello = await call('host.hello', {
    protocol: 'maka.cu/2',
    host: { name: 'maka-cu2-launch-driver', version: 'test' },
    hostPid: process.pid,
    imageDir,
    allowGlobalPointer: false,
  });
  record('host.hello', hello.result?.protocol === 'maka.cu/2');
  record(
    'session.begin',
    (await call('session.begin', { session, captureScope: 'window' })).result?.ok === true,
  );
  const launched = await call('apps.launch', { session, app: fixturePath, waitForWindowMs: 8_000 });
  launchedPid = Number(launched.result?.pid) || null;
  record(
    'apps.launch resolves fixture pid and appId',
    launched.result?.ok === true &&
      launchedPid > 0 &&
      launched.result.appId === `win32:${fixtureExe.toLowerCase()}`,
  );
  record(
    'apps.launch waits for a window',
    launched.result?.windows?.length > 0 &&
      ['window_appeared', 'timeout', 'not_requested'].includes(launched.result?.waited?.reason),
    JSON.stringify(launched.result?.waited ?? null),
  );
  record(
    'apps.launch reports foreground observation',
    typeof launched.result?.foregroundTaken === 'boolean',
  );
  record('session.end', (await call('session.end', { session })).result?.ok === true);
  await call('shutdown');
} catch (error) {
  record('launch driver', false, error.message);
} finally {
  if (launchedPid) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(launchedPid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5000,
      });
    } catch {}
  }
  if (child.exitCode === null) {
    try {
      child.kill();
    } catch {}
  }
  await rm(imageDir, { recursive: true, force: true });
}
const result = {
  schema: 'maka.cu.windows/generic-launch-results/1',
  protocol: 'maka.cu/2',
  executor: 'rust-native-windows',
  launchedPid,
  summary: {
    pass: tests.filter((test) => test.status === 'pass').length,
    fail: tests.filter((test) => test.status === 'fail').length,
  },
  tests,
};
await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.summary.fail ? 1 : 0;
