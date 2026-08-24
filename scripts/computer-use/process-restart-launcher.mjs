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

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');
const harnessPath = join(here, 'process-restart-harness.mjs');
const monitorPath = join(here, 'real-e2e-monitor.swift');
const labRoot = '/Users/haoqing/Documents/Learning/codex-computer-use-lab';
const statePath = join(labRoot, 'test-app', 'runtime', 'state.json');
const SOAK_ROUNDS = 5;
const FIXTURE_BUNDLE_ID = 'com.openai.codex.cualab';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function runChild(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? ['ignore', 'inherit', 'inherit'],
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${file} failed (${signal ?? code})`));
    });
  });
}

async function runFixtureScript(name, options = {}) {
  await runChild(join(labRoot, 'test-app', name), [], options);
}

async function runBuilds() {
  for (const workspace of ['@maka/core', '@maka/runtime', '@maka/computer-use']) {
    await runChild('npm', ['--workspace', workspace, 'run', 'build'], {
      cwd: repoRoot,
    });
  }
  await runChild(process.execPath, ['scripts/computer-use.mjs', 'prepare'], { cwd: repoRoot });
}

async function frontmostApplication() {
  const script = [
    'tell application "System Events"',
    'set frontProcess to first application process whose frontmost is true',
    'return (unix id of frontProcess as text) & tab & (bundle identifier of frontProcess as text)',
    'end tell',
  ].join('\n');
  let output = '';
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-e', script], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`failed to capture frontmost application (${code})`));
    });
  });
  const [pid, bundleIdentifier] = output.trim().split('\t');
  if (!Number.isInteger(Number(pid)) || !bundleIdentifier) {
    throw new Error(`invalid frontmost application identity: ${output.trim()}`);
  }
  return { pid: Number(pid), bundleIdentifier };
}

async function restoreFrontmost(application) {
  const escaped = application.bundleIdentifier.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const script = [
    'tell application "System Events"',
    `if exists (first application process whose unix id is ${application.pid}) then`,
    `set frontmost of first application process whose unix id is ${application.pid} to true`,
    'else',
    `tell application id "${escaped}" to activate`,
    'end if',
    'end tell',
  ].join('\n');
  await runChild('/usr/bin/osascript', ['-e', script], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

async function pointerLocation() {
  let output = '';
  await new Promise((resolve, reject) => {
    const child = spawn('swift', [monitorPath, '--snapshot'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`failed to capture desktop snapshot (${code})`));
    });
  });
  const [kind, , , xText, yText] = output.trim().split('\t');
  const x = Number(xText);
  const y = Number(yText);
  if (kind !== 'READY' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`invalid desktop snapshot: ${output.trim()}`);
  }
  return { x, y };
}

async function terminateChild(child, label, timeoutMs = 3_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  if (await Promise.race([exited.then(() => true), delay(timeoutMs).then(() => false)])) {
    return;
  }
  child.kill('SIGKILL');
  if (!(await Promise.race([exited.then(() => true), delay(timeoutMs).then(() => false)]))) {
    throw new Error(`${label} did not exit after SIGKILL`);
  }
}

async function waitForJson(path, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await delay(50);
  }
  throw new Error(`${label} timeout`);
}

async function waitForRestartedState(oldPID, oldWebContentPID, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      const newPID = state?.oop?.hostPID;
      const newWebContentPID = state?.oop?.webContentPID;
      if (
        Number.isInteger(newPID) &&
        newPID > 0 &&
        newPID !== oldPID &&
        Number.isInteger(newWebContentPID) &&
        newWebContentPID > 0 &&
        newWebContentPID !== oldWebContentPID
      ) {
        try {
          process.kill(newPID, 0);
          return state;
        } catch {
          // The state raced process exit; wait for the next launched instance.
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await delay(50);
  }
  throw new Error(
    `fixture restart state did not advance from host/WebContent ` + `${oldPID}/${oldWebContentPID}`,
  );
}

async function waitForInitialState(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      const hostPID = state?.oop?.hostPID;
      const webContentPID = state?.oop?.webContentPID;
      if (
        Number.isInteger(hostPID) &&
        hostPID > 0 &&
        Number.isInteger(webContentPID) &&
        webContentPID > 0
      ) {
        process.kill(hostPID, 0);
        return state;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH' && !(error instanceof SyntaxError))
        throw error;
    }
    await delay(50);
  }
  throw new Error('initial fixture state did not publish live host/WebContent PIDs');
}

function startFocusMonitor() {
  const child = spawn(
    'swift',
    [monitorPath, '--concurrent-user', '0', '--deny-frontmost-bundle', FIXTURE_BUNDLE_ID],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let buffer = '';
  let stderr = '';
  let readyResolve;
  let readyReject;
  let failureResolve;
  let readySettled = false;
  let failureSettled = false;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const failure = new Promise((resolve) => {
    failureResolve = resolve;
  });
  const fail = (error) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (!readySettled) {
      readySettled = true;
      readyReject(normalized);
    }
    if (!failureSettled) {
      failureSettled = true;
      failureResolve(normalized);
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
      const [kind, ...fields] = line.split('\t');
      if (kind === 'READY') {
        readySettled = true;
        readyResolve({
          frontmostPID: Number(fields[1]),
          pointer: { x: Number(fields[2]), y: Number(fields[3]) },
          physicalInputAgeSeconds: Number(fields[4]),
          bundleIdentifier: fields[5],
        });
      } else if (kind === 'CHANGE' || kind === 'ERROR') {
        fail(new Error(fields.join('\t') || line));
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.on('error', fail);
  child.on('exit', (code, signal) => {
    if (!failureSettled && code !== 0 && signal !== 'SIGTERM') {
      fail(
        new Error(
          `focus monitor exited (${signal ?? code})` +
            `${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
        ),
      );
    }
  });
  return {
    child,
    ready,
    failure,
    stop: () => terminateChild(child, 'restart focus monitor'),
  };
}

async function run() {
  const originalFrontmost = await frontmostApplication();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'maka-cu-restart-e2e-'));
  let fixtureTouched = false;
  let caffeinate;
  let harness;
  let monitor;
  try {
    caffeinate = spawn('/usr/bin/caffeinate', ['-dimsu'], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await runBuilds();
    fixtureTouched = true;
    await runFixtureScript('stop.sh');
    await runFixtureScript('reset.sh');
    const pointerBefore = await pointerLocation();
    monitor = startFocusMonitor();
    await Promise.race([
      monitor.ready,
      delay(10_000).then(() => {
        throw new Error('restart focus monitor startup timeout');
      }),
    ]);
    await runFixtureScript('launch.sh', {
      env: { ...process.env, CUA_LAB_BACKGROUND: '1' },
    });
    const oldState = await waitForInitialState();
    const oldPID = oldState?.oop?.hostPID;
    if (!Number.isInteger(oldPID) || oldPID <= 0) {
      throw new Error('old synthetic fixture did not publish a valid PID');
    }
    harness = spawn(process.execPath, [harnessPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MAKA_CU_RESTART_OLD_PID: String(oldPID),
        MAKA_CU_RESTART_SOAK_ROUNDS: String(SOAK_ROUNDS),
        MAKA_CU_RESTART_TEMP_DIR: temporaryDirectory,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const exit = new Promise((resolve, reject) => {
      harness.once('error', reject);
      harness.once('exit', (code, signal) => resolve({ code, signal }));
    });
    let currentPID = oldPID;
    for (let round = 1; round <= SOAK_ROUNDS; round += 1) {
      const requestPath = join(temporaryDirectory, `restart-request-${round}.json`);
      const completePath = join(temporaryDirectory, `restart-complete-${round}.json`);
      const request = await Promise.race([
        waitForJson(requestPath, `restart request ${round}`),
        exit.then((result) => {
          throw new Error(
            `restart harness exited before round ${round} ` + `(${result.signal ?? result.code})`,
          );
        }),
        monitor.failure.then((error) => {
          throw error;
        }),
      ]);
      if (request.round !== round || request.oldPID !== currentPID) {
        throw new Error(`restart request ${round} identity mismatch`);
      }
      if (!Number.isInteger(request.oldWebContentPID) || request.oldWebContentPID <= 0) {
        throw new Error(`restart request ${round} has no old WebContent PID`);
      }
      await runFixtureScript('stop.sh');
      await runFixtureScript('launch.sh', {
        env: { ...process.env, CUA_LAB_BACKGROUND: '1' },
      });
      const newState = await waitForRestartedState(currentPID, request.oldWebContentPID);
      const newPID = newState?.oop?.hostPID;
      if (!Number.isInteger(newPID) || newPID <= 0 || currentPID === newPID) {
        throw new Error(
          `fixture restart ${round} did not create a new process: ` + `${currentPID} -> ${newPID}`,
        );
      }
      await writeFile(
        completePath,
        `${JSON.stringify({
          round,
          oldPID: currentPID,
          newPID,
          newWebContentPID: newState.oop.webContentPID,
        })}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      currentPID = newPID;
    }
    const result = await Promise.race([
      exit,
      monitor.failure.then((error) => {
        throw error;
      }),
    ]);
    if (result.code !== 0) {
      throw new Error(`restart soak E2E failed (${result.signal ?? result.code})`);
    }
    const pointerAfter = await pointerLocation();
    const displacement = Math.hypot(
      pointerAfter.x - pointerBefore.x,
      pointerAfter.y - pointerBefore.y,
    );
    process.stdout.write(`Synthetic fixture never became frontmost across ${SOAK_ROUNDS} rounds\n`);
    process.stdout.write(`Concurrent user pointer displacement observed: ${displacement}\n`);
  } finally {
    await terminateChild(harness, 'restart E2E harness').catch(() => {});
    await monitor?.stop().catch(() => {});
    if (fixtureTouched) await runFixtureScript('stop.sh').catch(() => {});
    const finalFrontmost = await frontmostApplication().catch(() => undefined);
    if (finalFrontmost?.bundleIdentifier === FIXTURE_BUNDLE_ID) {
      await restoreFrontmost(originalFrontmost).catch(() => {});
    }
    await terminateChild(caffeinate, 'restart caffeinate').catch(() => {});
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('Computer Use process restart E2E failed:', error);
  process.exitCode = 1;
});
