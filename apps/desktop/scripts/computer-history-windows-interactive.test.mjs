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
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const optedIn = process.env.MAKA_HISTORY_WINDOWS_INTERACTIVE_TEST === '1';
const helper = process.env.MAKA_HISTORY_WINDOWS_HELPER
  ?? fileURLToPath(new URL('../resources/bin/open-history.exe', import.meta.url));
const fixtureSource = fileURLToPath(new URL('./computer-history-windows-interactive.fixture.ps1', import.meta.url));

test('real Windows recorder accepts only controlled synthetic WinForms evidence', {
  skip: !optedIn ? 'requires MAKA_HISTORY_WINDOWS_INTERACTIVE_TEST=1' : false,
  timeout: 180_000,
}, async (t) => {
  assert.equal(process.platform, 'win32', 'interactive acceptance must run on Windows');
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'use Node 24');
  assert.ok(isAbsolute(helper), 'helper override must be absolute');
  const parent = process.env.MAKA_HISTORY_WINDOWS_TEST_ROOT ?? tmpdir();
  assert.ok(isAbsolute(parent), 'test root must be an existing absolute local NTFS directory');
  assert.match(parent, /^[a-z]:\\/i, 'use a local drive path, not a network or device namespace');
  const root = await mkdtemp(join(parent, 'maka-history-interactive-'));
  const evidencePath = join(root, 'evidence.jsonl');
  const evidenceFd = openSync(evidencePath, 'wx');
  const started = performance.now();
  const deadline = started + 160_000; // Reserve time for EOF, evidence and fixture cleanup.
  const token = randomUUID().replaceAll('-', '');
  const executable = join(root, `maka-history-fixture-${token}.exe`);
  const appId = `win32.${basename(executable, '.exe')}`;
  const homes = [];
  let fixture;
  let active;
  let foregroundRequired = false;
  let fixtureError;
  let latestForeground;
  let ready;
  let sequence = 0;
  const replies = new Map();
  const safetyTimer = setTimeout(() => {
    fixtureError = new Error('interactive acceptance safety deadline reached');
    active?.child.stdin.end();
    fixture?.child.stdin.end();
  }, 163_000);

  function evidence(type, value = {}) {
    writeSync(evidenceFd, `${JSON.stringify({
      type, at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), ...value,
    })}\n`);
  }

  function healthy() {
    assert.ok(performance.now() < deadline, '160-second acceptance budget exhausted');
    if (fixtureError) throw fixtureError;
    if (fixture) assert.equal(fixture.result, undefined, `fixture exited: ${fixture.stderr}`);
    if (active) assert.equal(active.result, undefined, `recorder exited: ${active.stderr}`);
    if (foregroundRequired && latestForeground) {
      assert.equal(latestForeground.processIdentifier, ready.processIdentifier, 'synthetic foreground was lost');
      assert.ok(Object.values(ready.windows).includes(latestForeground.windowID), 'unexpected fixture HWND');
    }
  }

  async function until(check, label, limit = 9_000) {
    const end = Math.min(deadline, performance.now() + limit);
    while (performance.now() < end) {
      healthy();
      const value = await check();
      if (value) return value;
      await delay(50);
    }
    assert.fail(`Timed out waiting for ${label}`);
  }

  async function invoke(home, args) {
    evidence('native.command', { home, args });
    try {
      const { stdout, stderr } = await run(helper, args, {
        env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: home },
        windowsHide: true, encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024,
      });
      evidence('native.result', { home, args, stdout, stderr, code: 0 });
      assert.equal(stderr, '');
      return stdout;
    } catch (error) {
      evidence('native.result', {
        home, args, stdout: error.stdout, stderr: error.stderr,
        code: error.code, signal: error.signal, message: error.message,
      });
      throw error;
    }
  }

  function track(child, label) {
    const tracked = { child, stdout: '', stderr: '', result: undefined };
    child.stdout.setEncoding('utf8').on('data', (data) => { tracked.stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data) => { tracked.stderr += data; });
    child.stdin.on('error', (error) => evidence('process.stdin-error', { label, message: error.message }));
    tracked.closed = new Promise((resolve) => {
      child.once('error', (error) => {
        tracked.result = { error: error.message };
        evidence('process.error', { label, ...tracked.result });
      });
      child.once('exit', (code, signal) => {
        tracked.result = { code, signal };
        evidence('process.exit', { label, ...tracked.result });
      });
      child.once('close', () => resolve(tracked.result));
    });
    evidence('process.spawn', { label, pid: child.pid });
    return tracked;
  }

  async function closeProcess(tracked, label) {
    if (!tracked.child.stdin.destroyed) tracked.child.stdin.end();
    let timer;
    let killTimer;
    try {
      const result = await Promise.race([
        tracked.closed,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 3_000);
        }),
      ]);
      if (result !== null) return result;
      // Only this directly-owned process; wait for closure and still fail.
      tracked.child.kill('SIGKILL');
      await Promise.race([
        tracked.closed,
        new Promise((_, reject) => {
          killTimer = setTimeout(() => reject(new Error(`${label} did not close after termination`)), 1_000);
        }),
      ]);
      throw new Error(`${label} required forced termination after stdin EOF`);
    } finally {
      clearTimeout(timer);
      clearTimeout(killTimer);
      evidence('process.output', { label, stdout: tracked.stdout, stderr: tracked.stderr });
    }
  }

  async function show(window, text, password = window === 'password', action = 'show') {
    healthy();
    const id = ++sequence;
    const command = { id, action, window, text, ...(window === 'password' ? { password } : {}) };
    evidence('fixture.command', command);
    fixture.child.stdin.write(`${JSON.stringify(command)}\n`);
    const reply = await until(() => replies.get(id), `fixture ${window} focus`, 3_000);
    replies.delete(id);
    assert.equal(reply.action, action);
    assert.equal(reply.windowID, ready.windows[window]);
    assert.equal(reply.processIdentifier, ready.processIdentifier);
    assert.equal(reply.foreground.windowID, reply.windowID);
    assert.equal(reply.foreground.processIdentifier, ready.processIdentifier);
    assert.equal(reply.text, text);
    assert.equal(reply.password, password);
    latestForeground = reply.foreground;
    return reply;
  }

  async function json(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async function segments(home, sealed = false) {
    let names;
    try { names = await readdir(join(home, 'segments')); }
    catch (error) {
      if (error.code === 'ENOENT' && !sealed) return [];
      throw error;
    }
    const values = [];
    for (const name of names) {
      const directory = join(home, 'segments', name);
      const metadata = await json(join(directory, 'metadata.json'));
      if (sealed) assert.ok(metadata, 'sealed segment metadata missing');
      if (metadata) values.push({ directory, metadata });
    }
    return values.sort((a, b) =>
      Date.parse(a.metadata.startedAt) - Date.parse(b.metadata.startedAt)
      || a.directory.localeCompare(b.directory));
  }

  async function segmentEvents(directory, sealed = false) {
    let contents;
    try { contents = await readFile(join(directory, 'events.jsonl'), 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT' && !sealed) return [];
      throw error;
    }
    // Polls may see a write in progress. A sealed file must have no partial tail.
    if (sealed && contents) assert.ok(contents.endsWith('\n'), 'partial sealed JSONL');
    const lines = contents.split('\n');
    lines.pop();
    const values = lines.map((line) => JSON.parse(line));
    assert.equal(new Set(values.map((event) => event.id)).size, values.length, 'IDs must be unique within a segment');
    return values;
  }

  async function events(home, sealed = false) {
    const values = [];
    for (const { directory } of await segments(home, sealed)) {
      values.push(...await segmentEvents(directory, sealed));
    }
    for (const event of values) {
      assert.ok(Number.isSafeInteger(event.id) && event.id > 0);
      assert.ok(Number.isFinite(Date.parse(event.timestamp)));
      assert.ok(['window.changed', 'ui.changed', 'selection.changed'].includes(event.kind));
      assert.equal(event.app.bundleIdentifier, appId, 'non-synthetic app persisted');
      assert.equal(event.app.processIdentifier, ready.processIdentifier, 'non-synthetic PID persisted');
      assert.ok(Object.values(ready.windows).includes(event.window.windowID), 'non-synthetic HWND persisted');
      assert.match(event.sourceId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
    }
    return values;
  }

  async function runtime(home, state) {
    return until(async () => {
      const value = await json(join(home, 'runtime.json'));
      if (value?.state !== state) return false;
      if (state !== 'stopped') assert.equal(value.processIdentifier, active.child.pid);
      evidence('native.runtime', { home, value });
      return value;
    }, `${state} runtime`);
  }

  async function startRecorder(name, captureText, blocked = false) {
    const home = join(root, name);
    await mkdir(home);
    homes.push(home);
    assert.equal((await invoke(home, ['validate-home'])).trim(), 'history-home-valid');
    assert.deepEqual(await readdir(home), [], 'native validation must be read-only');
    const config = {
      captureText, showMenuBarIcon: false,
      observation: {
        defaultApplicationBehavior: 'do_not_observe', defaultURLBehavior: 'do_not_observe',
        allowlist: [{ scope: 'application', bundleID: appId }],
        blocklist: blocked ? [{ scope: 'application', bundleID: appId }] : [],
      },
    };
    for (const [name, value] of Object.entries({
      'config.json': config,
      'control.json': { state: 'paused', resumeAt: null, revision: token },
      'maka-settings.json': { enabled: true },
    })) {
      await writeFile(join(home, name), `${JSON.stringify(value)}\n`, { flag: 'wx' });
      evidence('safety.input', { home, name, value });
    }
    const permission = JSON.parse(await invoke(home, ['permissions', '--no-prompt']));
    assert.equal(permission.accessibility, true, 'requires unlocked Default input desktop');
    assert.equal(permission.inputMonitoring, true);
    assert.equal(permission.permissionModel, 'interactive-session');
    assert.equal(permission.typedTextCapture, false);
    active = track(spawn(helper, ['record', '--no-prompt', '--parent-pid', String(process.pid)], {
      env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: home },
      windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    }), name);
    await runtime(home, 'paused');
    assert.equal((await events(home)).length, 0, 'paused startup recorded content');
    assert.equal(JSON.parse(await invoke(home, ['status'])).recorderActive, true);
    assert.equal(active.child.stdin.writableEnded, false);
    foregroundRequired = true;
    await invoke(home, ['resume']);
    await runtime(home, 'running');
    return home;
  }

  async function captured(home, window, text, after = 0, textEnabled = true) {
    const event = await until(async () => {
      const found = (await events(home)).slice(after).find((event) =>
        event.window.windowID === ready.windows[window]
        && (textEnabled ? event.ax?.text?.includes(text) : event.contentState === 'metadataOnly'));
      return found;
    }, `${window} ${textEnabled ? 'body text' : 'metadata'}`);
    if (textEnabled) {
      assert.equal(event.contentState, 'available');
      assert.equal(event.ax.mode, 'fullTree');
      assert.deepEqual(event.contentDomains, []);
      assert.ok(!event.window.title.includes(text), 'canary must be body text, not window metadata');
    } else {
      assert.equal(event.ax, undefined);
      assert.equal(event.contentDomains, undefined);
    }
    evidence('assertion.pass', { assertion: textEnabled ? 'useful-text' : 'text-off', home, event });
    return event;
  }

  async function suppressed(home, window, text) {
    await show(window, text);
    // This direct, real worker proof prevents old, not-yet-flushed suppression
    // counts from making an unexercised privacy case pass.
    const snapshot = await invoke(home, [
      'snapshot', '--parent-pid', String(process.pid),
      '--window', String(ready.windows[window]), '--pid', String(ready.processIdentifier),
      '--source', randomUUID(),
    ]);
    assert.equal(JSON.parse(snapshot), null, `${window} worker returned denied context`);
    const before = (await events(home)).length;
    const suppressionCount = async () => (await segments(home))
      .reduce((count, { metadata }) => count + metadata.suppressedEventCount, 0);
    const baseline = await suppressionCount();
    // Native metadata flushes every 5 seconds. A new suppression, healthy
    // running status and unchanged events witness work, not just elapsed time.
    const suppressedCount = await until(async () => {
      assert.equal((await events(home)).length, before, `${window} context was persisted`);
      const health = await json(join(home, 'runtime.json'));
      assert.equal(health.state, 'running');
      assert.equal(health.captureFailures, 0, 'provider failure cannot prove privacy suppression');
      const count = await suppressionCount();
      return count > baseline && count;
    }, `${window} suppression`, 11_000);
    const status = JSON.parse(await invoke(home, ['status']));
    assert.equal(status.state, 'running');
    assert.equal(status.captureError, undefined);
    evidence('assertion.pass', { assertion: `${window}-suppression`, home, before, baseline, suppressedCount });
    return before;
  }

  async function stopRecorder(home) {
    foregroundRequired = false;
    const recorder = active;
    active = undefined;
    const result = await closeProcess(recorder, basename(home));
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(recorder.stdout, '');
    assert.equal(recorder.stderr, '');
    const state = await json(join(home, 'runtime.json'));
    assert.equal(state.state, 'stopped');
    assert.ok(Number.isFinite(Date.parse(state.endedAt)));
    assert.equal(state.captureFailures, 0);
    assert.equal(JSON.parse(await invoke(home, ['status'])).recorderActive, false);
    const records = await events(home, true);
    const sealed = await segments(home, true);
    assert.ok(sealed.length > 0, 'recorder must create at least one segment');
    for (const { directory, metadata } of sealed) {
      assert.equal(metadata.eventCount, (await segmentEvents(directory, true)).length);
      assert.equal(metadata.endReason, 'finished');
      assert.ok(Number.isFinite(Date.parse(metadata.endedAt)));
    }
    evidence('assertion.pass', { assertion: 'stdin-eof-seals-and-releases', home, result, segments: sealed });
    return records;
  }

  // Preserve all files, including partial output on failure, without looking at
  // any personal history directory. Evidence is deliberately not auto-deleted.
  async function dumpHome(home) {
    async function visit(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) evidence('native.file', { home, path, contents: await readFile(path, 'utf8') });
      }
    }
    await visit(home);
  }

  t.diagnostic(`Synthetic evidence: ${evidencePath}`);
  evidence('run.start', { root, helper, node: process.version, platform: process.platform, token, appId });
  try {
    assert.equal((await invoke(root, ['validate-home'])).trim(), 'history-home-valid');
    evidence('helper.path', { path: helper });
    const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const built = await run(powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixtureSource,
      '-OutputAssembly', executable, '-TestOnly',
    ], { windowsHide: true, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
    evidence('fixture.build', built);
    assert.equal(built.stdout.trim(), 'synthetic-fixture-built');
    assert.equal(built.stderr, '');
    fixture = track(spawn(executable, [String(process.pid), token], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }), 'fixture');
    createInterface({ input: fixture.child.stdout }).on('line', (line) => {
      try {
        const value = JSON.parse(line);
        evidence('fixture.message', { value });
        if (value.type === 'error') throw new Error(value.message);
        if (value.type === 'ready') ready = value;
        if (value.type === 'ack' || value.type === 'unblocked') replies.set(value.id, value);
        if (value.foreground) {
          latestForeground = value.foreground;
          if (foregroundRequired) {
            assert.equal(value.foreground.processIdentifier, ready.processIdentifier, 'synthetic foreground was lost');
            assert.ok(Object.values(ready.windows).includes(value.foreground.windowID), 'unexpected fixture HWND');
          }
        }
      } catch (error) {
        fixtureError = error;
        active?.child.stdin.end();
      }
    });
    await until(() => ready, 'WinForms fixture ready', 5_000);
    assert.equal(ready.processIdentifier, fixture.child.pid);
    assert.equal(Object.keys(ready.windows).length, 4);
    assert.equal(new Set(Object.values(ready.windows)).size, 4);
    for (const hwnd of Object.values(ready.windows)) assert.ok(Number.isSafeInteger(hwnd) && hwnd > 0);

    const marker = (name) => `SYNTHETIC_${token}_${name}`;
    await show('one', marker('BODY_A'));
    const textHome = await startRecorder('text-on', true);
    const captureStarted = performance.now();
    const direct = JSON.parse(await invoke(textHome, [
      'snapshot', '--parent-pid', String(process.pid),
      '--window', String(ready.windows.one), '--pid', String(ready.processIdentifier),
      '--source', randomUUID(),
    ]));
    assert.ok(direct?.text?.includes(marker('BODY_A')), 'direct worker omitted synthetic body');
    evidence('assertion.pass', {
      assertion: 'direct-worker-body', durationMs: Math.round(performance.now() - captureStarted), direct,
    });
    const a = await captured(textHome, 'one', marker('BODY_A'));
    let count = (await events(textHome)).length;
    await show('one', marker('BODY_EDIT'), false, 'edit');
    const edited = await captured(textHome, 'one', marker('BODY_EDIT'), count);
    assert.equal(edited.window.windowID, a.window.windowID);
    assert.equal(edited.sourceId, a.sourceId, 'pure same-window edit must retain its source identity');
    assert.notEqual(edited.kind, 'window.changed', 'pure edit is a content change');
    evidence('assertion.pass', { assertion: 'same-window-edit-retains-source', a, edited });
    count = (await events(textHome)).length;
    await show('two', marker('BODY_B'));
    const b = await captured(textHome, 'two', marker('BODY_B'), count);
    assert.equal(a.window.title, b.window.title, 'two distinct HWNDs intentionally share a title');
    assert.notEqual(a.sourceId, b.sourceId);
    count = (await events(textHome)).length;
    await show('one', marker('BODY_RETURN'));
    const returned = await captured(textHome, 'one', marker('BODY_RETURN'), count);
    assert.notEqual(returned.sourceId, a.sourceId);
    assert.notEqual(returned.sourceId, b.sourceId);
    evidence('assertion.pass', { assertion: 'same-title-hwnd-focus-return', a, b, returned });

    count = (await events(textHome)).length;
    const longBody = `${marker('LONG_BODY')}\r\n${'\u4e2d\u6587\u7b14\u8bb0 \ud83d\udcbb abc '.repeat(5000)}`;
    await show('one', longBody);
    const longEvent = await captured(textHome, 'one', marker('LONG_BODY'), count);
    assert.ok(Buffer.byteLength(longEvent.ax.text) <= 28 * 1024);
    assert.ok(longEvent.ax.text.includes('\u4e2d\u6587\u7b14\u8bb0'));
    assert.ok(!longEvent.ax.text.includes('\ufffd'), 'UTF-8 truncation split a character');
    evidence('assertion.pass', { assertion: 'long-multilingual-body-bounded', bytes: Buffer.byteLength(longEvent.ax.text) });

    const denied = [];
    count = (await events(textHome)).length;
    await show('password', marker('BEFORE_PASSWORD'), false);
    await captured(textHome, 'password', marker('BEFORE_PASSWORD'), count);
    for (const window of ['password', 'private']) {
      denied.push(marker(`${window.toUpperCase()}_DENIED`));
      await suppressed(textHome, window, denied.at(-1));
      count = (await events(textHome)).length;
      await show('one', marker(`RECOVERY_${window.toUpperCase()}`));
      await captured(textHome, 'one', marker(`RECOVERY_${window.toUpperCase()}`), count);
    }
    count = (await events(textHome)).length;
    await show('password', marker('AFTER_PASSWORD'), false);
    await captured(textHome, 'password', marker('AFTER_PASSWORD'), count);
    evidence('assertion.pass', { assertion: 'password-state-toggle-recovers' });

    count = (await events(textHome)).length;
    await show('one', marker('BEFORE_BLOCK'));
    await captured(textHome, 'one', marker('BEFORE_BLOCK'), count);
    const beforeBlock = await runtime(textHome, 'running');
    assert.equal(beforeBlock.captureFailures, 0, 'block must start from a healthy recorder');
    const recorderPid = active.child.pid;
    const blockId = ++sequence;
    const blockCommand = { id: blockId, action: 'block' };
    evidence('fixture.command', blockCommand);
    fixture.child.stdin.write(`${JSON.stringify(blockCommand)}\n`);
    await until(() => replies.get(blockId)?.type === 'ack', 'fixture UI thread blocked');
    let failedHealth;
    let workerFailure;
    try {
      // A quiet recorder may wait for its 15-second heartbeat before trying.
      // Require its own failure before invoking the independent worker probe.
      failedHealth = await until(async () => {
        assert.notEqual(replies.get(blockId)?.type, 'unblocked', 'fixture released before failure proof');
        const value = await json(join(textHome, 'runtime.json'));
        assert.equal(value.state, 'running');
        assert.equal(value.processIdentifier, recorderPid);
        return value.captureFailures > 0
          && Date.parse(value.updatedAt) > Date.parse(beforeBlock.updatedAt)
          && value;
      }, 'recorder failure while UI thread is blocked', 20_000);
      evidence('assertion.pass', { assertion: 'blocked-recorder-reports-failure', home: textHome, value: failedHealth });
      const probeStarted = performance.now();
      await assert.rejects(invoke(textHome, [
        'snapshot', '--parent-pid', String(process.pid),
        '--window', String(ready.windows.one), '--pid', String(ready.processIdentifier),
        '--source', randomUUID(),
      ]), (error) => {
        assert.equal(error.code, 1, 'blocked worker must explicitly reject capture');
        assert.equal(error.stdout, '', 'failed worker must not return a snapshot');
        // A blocked provider may time out or become unavailable. Both must
        // remain explicit failures, never a successful null suppression.
        assert.match(error.stderr, /^uia_(?:capture_timeout|provider_unavailable)\r?\n?$/);
        workerFailure = error.stderr.trim();
        return true;
      });
      assert.ok(performance.now() - probeStarted < 3000, 'blocked provider exceeded hard worker budget');
      assert.notEqual(replies.get(blockId)?.type, 'unblocked', 'fixture released before worker failure proof');
    } finally {
      if (!fixture.child.stdin.destroyed && !fixture.child.stdin.writableEnded) {
        const command = { id: blockId, action: 'unblock' };
        evidence('fixture.command', command);
        fixture.child.stdin.write(`${JSON.stringify(command)}\n`);
      }
    }
    await until(() => replies.get(blockId)?.type === 'unblocked', 'fixture UI thread recovered');
    replies.delete(blockId);
    count = (await events(textHome)).length;
    await show('one', marker('AFTER_BLOCK'));
    const recoveryStarted = performance.now();
    const recoveredEvent = await captured(textHome, 'one', marker('AFTER_BLOCK'), count);
    const bodyRecoveryMs = Math.round(performance.now() - recoveryStarted);
    let lastRecoverySample;
    // Health publishes every five seconds when failures are already zero.
    // Require a fresh sample separately from the normal nine-second body bound.
    const recoveredHealth = await until(async () => {
      const value = await json(join(textHome, 'runtime.json'));
      const signature = JSON.stringify(value);
      if (signature !== lastRecoverySample) {
        evidence('recovery.runtime', {
          home: textHome, recoveryElapsedMs: Math.round(performance.now() - recoveryStarted), value,
        });
        lastRecoverySample = signature;
      }
      assert.equal(value.state, 'running');
      assert.equal(value.processIdentifier, recorderPid, 'recovery must use the same recorder');
      return value.captureFailures === 0
        && Date.parse(value.updatedAt) > Date.parse(failedHealth.updatedAt)
        && Date.parse(value.updatedAt) >= Date.parse(recoveredEvent.timestamp)
        && value;
    }, 'fresh zero-failure runtime after recovered content');
    evidence('assertion.pass', {
      assertion: 'unresponsive-provider-bounded-and-recovers',
      beforeBlock, failedHealth, workerFailure, recoveredHealth, recoveredEvent,
      bodyRecoveryMs, recoveryElapsedMs: Math.round(performance.now() - recoveryStarted),
    });
    await invoke(textHome, ['pause']);
    const paused = await runtime(textHome, 'paused');
    const pausedCount = (await events(textHome)).length;
    denied.push(marker('PAUSED_DENIED'));
    await show('two', denied.at(-1));
    await until(async () => {
      assert.equal((await events(textHome)).length, pausedCount, 'paused recorder wrote events');
      const value = await json(join(textHome, 'runtime.json'));
      assert.equal(value.state, 'paused');
      return Date.parse(value.updatedAt) > Date.parse(paused.updatedAt);
    }, 'paused heartbeat after synthetic focus/value change', 7_000);
    evidence('assertion.pass', { assertion: 'pause-no-writes', pausedCount });
    await show('one', marker('RESUMED_BODY'));
    await invoke(textHome, ['resume']);
    await runtime(textHome, 'running');
    await captured(textHome, 'one', marker('RESUMED_BODY'), pausedCount);
    const textEvents = await stopRecorder(textHome);
    for (const text of denied) assert.ok(!JSON.stringify(textEvents).includes(text), `denied body persisted: ${text}`);
    assert.ok(!textEvents.some((event) => event.window.windowID === ready.windows.private), 'private metadata persisted');

    await show('one', marker('TEXT_OFF_A'));
    const metadataHome = await startRecorder('text-off', false);
    await captured(metadataHome, 'one', marker('TEXT_OFF_A'), 0, false);
    count = (await events(metadataHome)).length;
    await show('two', marker('TEXT_OFF_B'));
    await captured(metadataHome, 'two', marker('TEXT_OFF_B'), count, false);
    const metadataEvents = await stopRecorder(metadataHome);
    for (const event of metadataEvents) {
      assert.equal(event.contentState, 'metadataOnly');
      assert.equal(event.ax, undefined);
      assert.equal(event.contentDomains, undefined);
    }
    for (const text of [marker('TEXT_OFF_A'), marker('TEXT_OFF_B')]) {
      assert.ok(!JSON.stringify(metadataEvents).includes(text), 'text-off body persisted');
    }

    await show('one', marker('APP_DENIED'));
    const excludedHome = await startRecorder('app-excluded', true, true);
    await suppressed(excludedHome, 'one', marker('APP_DENIED'));
    assert.deepEqual(await stopRecorder(excludedHome), []);
    evidence('assertion.pass', { assertion: 'application-block-wins-over-allowlist' });
    evidence('matrix.pass');
  } catch (error) {
    evidence('run.fail', { message: error.message, stack: error.stack, stdout: error.stdout, stderr: error.stderr });
    throw error;
  } finally {
    foregroundRequired = false;
    const cleanupErrors = [];
    if (active) {
      try { await closeProcess(active, 'recorder-cleanup'); }
      catch (error) { cleanupErrors.push(error); }
      active = undefined;
    }
    if (fixture) {
      try {
        assert.deepEqual(await closeProcess(fixture, 'fixture-cleanup'), { code: 0, signal: null });
        assert.equal(fixture.stderr, '');
      }
      catch (error) { cleanupErrors.push(error); }
    }
    for (const home of homes) {
      try { await dumpHome(home); }
      catch (error) { cleanupErrors.push(error); }
    }
    clearTimeout(safetyTimer);
    evidence('run.end', { cleanupErrors: cleanupErrors.map((error) => error.message), evidencePath });
    closeSync(evidenceFd);
    assert.equal(cleanupErrors.length, 0, `cleanup/evidence failed: ${cleanupErrors.map((error) => error.message).join('; ')}`);
  }
});
