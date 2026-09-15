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
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, toNamespacedPath } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
// Node 24 strips this module's erasable types, exercising the shipped source
// without a stale dist copy, an app build, or a separate pipe implementation.
import { acquireWindowsHistoryOwnership } from '../src/main/computer-history-windows-ownership.ts';

const run = promisify(execFile);
const helper = fileURLToPath(new URL('../resources/bin/open-history.exe', import.meta.url));
const windowsOnly = { skip: process.platform !== 'win32', timeout: 60_000 };

function invoke(home, args) {
  // Missing/broken staged helpers fail the Windows test.
  return run(helper, args, {
    env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: home },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024,
  });
}

async function status(home) {
  const { stdout } = await invoke(home, ['status']);
  const value = JSON.parse(stdout);
  assert.equal(typeof value.recorderActive, 'boolean');
  return value.recorderActive;
}

async function validateHome(home) {
  const { stdout, stderr } = await invoke(home, ['validate-home']);
  assert.match(stdout, /^history-home-valid\r?\n$/);
  assert.equal(stderr, '');
}

test('application metadata never requires or touches history storage', windowsOnly, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-history-native-applications-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = join(root, 'must-not-be-created');
  for (const home of [undefined, missing, String.raw`\\maka-history-invalid\no-share`]) {
    const env = { ...process.env };
    delete env.OPEN_COMPUTER_HISTORY_HOME;
    if (home !== undefined) env.OPEN_COMPUTER_HISTORY_HOME = home;
    const { stdout, stderr } = await run(helper, ['applications', 'win32.maka-history-missing'], {
      env, windowsHide: true, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
    });
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), [{
      bundleIdentifier: 'win32.maka-history-missing', name: 'win32.maka-history-missing', iconDataUrl: null,
    }]);
    assert.deepEqual(await readdir(root), []);
  }
});

test('native home validation is read-only before and during Node ownership', windowsOnly, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'maka-history-native-validation-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await validateHome(home);
  assert.deepEqual(await readdir(home), [], 'validation must not create history or consent');

  const owner = await acquireWindowsHistoryOwnership(home);
  try {
    // A validator that acquires recorder admission would fail while Node owns it.
    for (const path of [home, toNamespacedPath(home)]) await validateHome(path);
    await assert.rejects(acquireWindowsHistoryOwnership(home), { code: 'EADDRINUSE' });
    assert.equal(await status(home), true, 'validation must preserve Node ownership');
    assert.deepEqual(await readdir(home), []);
  } finally {
    await owner.close();
  }
  await validateHome(home);
  assert.equal(await status(home), false);
  assert.deepEqual(await readdir(home), []);
});

for (const [name, home] of [
  ['UNC', String.raw`\\maka-history-validator.invalid\missing-share\history`],
  ['verbatim UNC', String.raw`\\?\UNC\maka-history-validator.invalid\missing-share\history`],
]) {
  test(`native home validation rejects nonexistent ${name} in the path parser`, windowsOnly, async () => {
    // Pass only the environment string: never stat, resolve or map this network
    // path. Native windows_drive_root rejects the prefix before filesystem I/O.
    await assert.rejects(invoke(home, ['validate-home']), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.killed, false, 'network timeout must not count as path rejection');
      assert.equal(error.signal, null);
      assert.equal(error.stdout, '');
      assert.equal(error.stderr.trim(), 'history_home_must_be_a_local_drive_path');
      return true;
    });
  });
}

test('native status observes Node ownership across helper exit, aliases and release', windowsOnly, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-history-native-parity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'History');
  const other = join(root, 'Other');
  await mkdir(home);
  await mkdir(other);
  const aliases = [home, join(root, 'history'), toNamespacedPath(home)];

  assert.equal(await status(home), false);
  assert.deepEqual(await readdir(home), [], 'read-only status must leave a fresh home empty');
  // Reacquisition also proves the read-only status probe released its instance.
  for (let iteration = 0; iteration < 2; iteration++) {
    const owner = await acquireWindowsHistoryOwnership(home);
    try {
      for (const alias of aliases) {
        assert.equal(await status(alias), true, `native must observe Node owner: ${alias}`);
      }
      assert.equal(await status(other), false, 'a distinct directory has independent admission');
      await assert.rejects(acquireWindowsHistoryOwnership(home), { code: 'EADDRINUSE' });
      assert.equal(await status(home), true, 'exited status helpers must not release Node admission');
    } finally {
      await owner.close();
    }
    assert.equal(await status(home), false);
  }
  assert.deepEqual(await readdir(home), [], 'ownership/status must not create history or consent');
  assert.deepEqual(await readdir(other), []);
});

for (const scenario of [
  { name: 'disabled recording with the actual parent', parent: process.pid, held: false, code: 1, error: 'recording_disabled' },
  { name: 'recording with a non-parent PID', parent: process.ppid, held: false, code: 1, error: 'invalid_parent' },
  { name: 'recording while Node owns admission', parent: process.pid, held: true, code: 75, error: 'recorder_occupied' },
]) {
  test(`native rejects ${scenario.name} before creating segments`, windowsOnly, async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'maka-history-native-rejected-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const settings = '{"enabled":false}\n';
    await writeFile(join(home, 'maka-settings.json'), settings);
    const owner = scenario.held ? await acquireWindowsHistoryOwnership(home) : undefined;
    try {
      const pending = invoke(home, [
        'record', '--no-prompt', '--parent-pid', String(scenario.parent),
      ]);
      // execFile spawns directly, so process.pid really is the native parent.
      // Keep stdin piped and open: EOF must not be the reason recording stops.
      assert.ok(pending.child.stdin);
      assert.equal(pending.child.stdin.writableEnded, false);
      await assert.rejects(pending, (error) => {
        assert.equal(error.code, scenario.code);
        assert.equal(error.killed, false, 'a timeout/forced kill must not count as rejection');
        assert.equal(error.signal, null);
        assert.equal(error.stdout, '');
        assert.equal(error.stderr.trim(), scenario.error);
        return true;
      });
      assert.equal(await status(home), scenario.held, 'a rejected child must not change ownership');
    } finally {
      await owner?.close();
    }
    assert.equal(await status(home), false);
    assert.deepEqual(await readdir(home), ['maka-settings.json'], 'no segments or runtime output');
    assert.equal(await readFile(join(home, 'maka-settings.json'), 'utf8'), settings);
  });
}

test('Node, native status and validation reject junction homes and junction ancestors', windowsOnly, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-history-native-junction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'Target');
  const alias = join(root, 'Alias');
  await mkdir(join(target, 'History'), { recursive: true });
  await symlink(target, alias, 'junction');
  for (const home of [alias, join(alias, 'History')]) {
    await assert.rejects(acquireWindowsHistoryOwnership(home), /real directories/);
    for (const command of ['status', 'validate-home']) {
      await assert.rejects(invoke(home, [command]), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /history_home_must_be_a_real_directory/);
        return true;
      });
    }
  }
});

test('paused native recorder releases ownership on stdin EOF and seals an empty segment', windowsOnly, async (t) => {
  const home = await pausedHome();
  const recorder = trackProcess(t, spawn(helper, [
    'record', '--no-prompt', '--parent-pid', String(process.pid),
  ], {
    env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: home },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }), home);

  await waitForPaused(home, recorder, recorder.child.pid);
  assert.equal(recorder.child.stdin.writableEnded, false);
  recorder.child.stdin.end();
  const [result] = await withinDeadline(Promise.all([recorder.exited, recorder.closed]), 'stdin EOF exit');
  assert.deepEqual(result, { code: 0, signal: null });
  assert.equal(recorder.stdout(), '');
  assert.equal(recorder.stderr(), '');
  await assertStoppedAndEmpty(home);
});

const pausedParentSource = String.raw`
  const { spawn } = require('node:child_process');
  const child = spawn(process.argv[1], [
    'record', '--no-prompt', '--parent-pid', String(process.pid),
  ], {
    env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: process.argv[2] },
    windowsHide: true,
    // libuv otherwise force-kills this child when Node's Job handle closes.
    // Leave that Job to exercise Parent::alive and the final store flush.
    detached: true,
    stdio: [3, 'inherit', 'inherit'],
  });
  child.on('spawn', () => process.send({ pid: child.pid }));
  child.on('error', (error) => { console.error(error); process.exit(1); });
  child.on('exit', (code) => process.exit(code ?? 1));
`;

test('paused native recorder exits and releases ownership when only its Node parent dies', windowsOnly, async (t) => {
  const home = await pausedHome();
  const parent = trackProcess(t, spawn(process.execPath, ['-e', pausedParentSource, helper, home], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'ipc'],
  }), home, 3);
  const [message] = await withinDeadline(once(parent.child, 'message'), 'native child PID');
  const nativePid = message.pid;
  assert.ok(Number.isSafeInteger(nativePid) && nativePid > 1);
  assert.notEqual(nativePid, parent.child.pid);
  await waitForPaused(home, parent, nativePid);

  // Node destroys child.stdin on exit, but not this extra inherited fd 3.
  // Keeping its write side here isolates Parent::alive from stdin EOF.
  // No taskkill /T or native PID signal is used.
  assert.equal(parent.input.writableEnded, false);
  assert.equal(parent.child.kill('SIGKILL'), true);
  const result = await withinDeadline(parent.exited, 'owned Node parent exit');
  assert.notEqual(result.code, 0);
  // Inherited stdout/stderr remain open in native after Node's exit. Their
  // closure, plus the read-only process probe, witnesses the grandchild exit.
  // Native may already have exited here; do not assert fd 3 is still open.
  await withinDeadline(parent.closed, 'orphaned native child output closure');
  await waitUntil(() => {
    try { process.kill(nativePid, 0); return false; }
    catch (error) {
      if (error.code === 'ESRCH') return true;
      throw error;
    }
  }, 'orphaned native child exit');
  assert.equal(parent.stdout(), '');
  assert.equal(parent.stderr(), '');
  await assertStoppedAndEmpty(home);
});

const pausedFiles = {
  'control.json': JSON.stringify({ state: 'paused', resumeAt: null, revision: 'synthetic-indefinite-pause' }),
  'config.json': JSON.stringify({
    captureText: false,
    showMenuBarIcon: false,
    observation: {
      defaultApplicationBehavior: 'do_not_observe',
      defaultURLBehavior: 'do_not_observe',
      allowlist: [],
      blocklist: [],
    },
  }),
  'maka-settings.json': JSON.stringify({ enabled: true }),
};

async function pausedHome() {
  const home = await mkdtemp(join(tmpdir(), 'maka-history-native-paused-'));
  // All safety inputs exist before spawning; no resume or live capture command.
  try {
    for (const [name, contents] of Object.entries(pausedFiles)) {
      await writeFile(join(home, name), contents);
    }
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
  return home;
}

function trackProcess(t, child, home, inputFd = 0) {
  const input = child.stdio[inputFd];
  let result;
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (data) => { stdout = (stdout + data).slice(-65_536); });
  child.stderr.setEncoding('utf8').on('data', (data) => { stderr = (stderr + data).slice(-65_536); });
  const exited = new Promise((resolve) => {
    child.once('error', (error) => { result = { error }; resolve(result); });
    child.once('exit', (code, signal) => { result = { code, signal }; resolve(result); });
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => {
    // Only owned handles are cleaned up. For an orphaned native child, stdin
    // EOF is a second graceful stop path if the parent-death assertion failed.
    if (!input.destroyed) input.end();
    if (!result) child.kill('SIGKILL');
    await withinDeadline(closed, 'owned process cleanup');
    // Do not remove safety files while a failed lifecycle could still be alive.
    await rm(home, { recursive: true, force: true });
  });
  return { child, input, exited, closed, result: () => result, stdout: () => stdout, stderr: () => stderr };
}

async function waitForPaused(home, process, nativePid) {
  await waitUntil(async () => {
    assert.equal(process.result(), undefined, `recorder exited before readiness: ${process.stderr()}`);
    let runtime;
    try { runtime = JSON.parse(await readFile(join(home, 'runtime.json'), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    assert.equal(runtime.state, 'paused');
    assert.equal(runtime.processIdentifier, nativePid);
    return true;
  }, 'native paused readiness');
  assert.equal(await status(home), true);
  // The native owner's one-instance limit maps to EBUSY in libuv; a Node
  // owner permits more instances and FIRST_PIPE_INSTANCE maps to EADDRINUSE.
  await assert.rejects(acquireWindowsHistoryOwnership(home), { code: 'EBUSY' });
}

async function assertStoppedAndEmpty(home) {
  assert.equal(await status(home), false);
  const successor = await acquireWindowsHistoryOwnership(home);
  await successor.close();
  const runtime = JSON.parse(await readFile(join(home, 'runtime.json'), 'utf8'));
  assert.equal(runtime.state, 'stopped');
  assert.equal(runtime.captureFailures, 0);
  assert.ok(Number.isFinite(Date.parse(runtime.endedAt)));
  // Native status intentionally still reports the persisted indefinite pause;
  // runtime.json, not control.json, must record the stopped process lifecycle.
  for (const [name, contents] of Object.entries(pausedFiles)) {
    assert.equal(await readFile(join(home, name), 'utf8'), contents, `${name} must remain unchanged`);
  }
  const segments = await readdir(join(home, 'segments'));
  assert.equal(segments.length, 1);
  for (const id of segments) {
    const segment = join(home, 'segments', id);
    assert.equal((await readFile(join(segment, 'events.jsonl'))).length, 0, 'paused recorder wrote content');
    const metadata = JSON.parse(await readFile(join(segment, 'metadata.json'), 'utf8'));
    assert.equal(metadata.eventCount, 0);
    assert.equal(metadata.suppressedEventCount, 0);
    assert.equal(metadata.endReason, 'finished');
    assert.ok(Number.isFinite(Date.parse(metadata.endedAt)));
  }
}

async function waitUntil(check, label) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function withinDeadline(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
