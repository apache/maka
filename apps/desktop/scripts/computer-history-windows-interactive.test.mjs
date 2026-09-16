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
import { closeSync, openSync, writeFileSync, writeSync } from 'node:fs';
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
const inputRequestPath = process.env.MAKA_HISTORY_WINDOWS_INPUT_REQUEST;
const inputOnly = process.env.MAKA_HISTORY_WINDOWS_INPUT_ONLY === '1';
const richEdit = process.env.MAKA_HISTORY_WINDOWS_RICH_EDIT_TEST === '1';
const metadataInput = process.env.MAKA_HISTORY_WINDOWS_METADATA_INPUT_TEST === '1';
const helper = process.env.MAKA_HISTORY_WINDOWS_HELPER
  ?? fileURLToPath(new URL('../resources/bin/open-history.exe', import.meta.url));
const fixtureSource = fileURLToPath(new URL('./computer-history-windows-interactive.fixture.ps1', import.meta.url));

function retainPhysicalReceipt(trial, value) {
  assert.ok(trial && !trial.retired && trial.request.publishedAt, 'receipt outside a published request');
  const request = trial.request;
  assert.equal(value.requestId, request.id, 'late receipt belongs to another request');
  assert.equal(value.phase, trial.receipts.length === 0 ? 'press' : 'release');
  assert.ok(trial.receipts.length < 2, 'duplicate physical receipt');
  assert.ok(Number.isSafeInteger(value.at) && value.at >= request.publishedAt && value.at <= request.deadline);
  assert.ok(!trial.receipts.length || value.at >= trial.receipts[0].at);
  assert.equal(value.processIdentifier, request.processIdentifier);
  assert.equal(value.windowID, request.windowID);
  assert.equal(value.inputWindowID, request.inputWindowID);
  assert.deepEqual(value.foreground, {
    windowID: request.windowID, processIdentifier: request.processIdentifier,
  });
  assert.equal(value.contextPreserved, true);
  assert.equal(value.hiddenPresent, trial.rich);
  if (request.name === 'return' || request.name === 'shortcut') {
    assert.equal(value.key, request.name === 'return' ? 'Enter' : 'A');
    if (value.phase === 'press') assert.equal(value.control, request.name === 'shortcut');
    assert.equal(value.button, null);
  } else {
    assert.equal(value.key, null);
    assert.equal(value.button, 'Left');
  }
  trial.receipts.push(value);
}

function validatePhysicalActions(rows, trials, complete = false) {
  const matched = trials.map(() => []);
  for (const event of rows.filter(row => /^(keyboard|mouse)\./.test(row.kind))) {
    const time = Date.parse(event.timestamp);
    const index = trials.findIndex(trial => time >= trial.request.publishedAt
      && time <= (trial.receipts[1]?.at ?? trial.request.deadline));
    assert.ok(index >= 0, 'action outside its physical receipt lifetime');
    const trial = trials[index];
    assert.equal(event.kind, trial.kind, 'unexpected physical action kind');
    assert.equal(event.sourceId, trial.sourceId, 'physical action changed source');
    assert.equal(event.window.windowID, trial.request.windowID);
    assert.equal(event.app.processIdentifier, trial.request.processIdentifier);
    assert.equal(event.ax, undefined);
    assert.equal(event.selection, undefined);
    const target = event.keyboard?.target ?? event.mouse?.target;
    assert.equal(target?.identifier, trial.metadata ? undefined : `hwnd:${trial.request.inputWindowID}`);
    assert.equal(target?.role, trial.rich ? 'AXDocument' : 'AXTextField');
    assert.equal(event.contentState, trial.metadata ? 'metadataOnly' : 'available');
    if (event.keyboard) {
      assert.equal(event.keyboard.keyEquivalent, trial.metadata ? undefined : trial.key);
      assert.deepEqual(event.keyboard.modifiers, trial.request.name === 'shortcut' ? ['control'] : []);
    } else {
      assert.equal(event.mouse.button, 'left');
    }
    matched[index].push(event);
    assert.equal(matched[index].length, 1, 'duplicate or delayed physical action');
  }
  if (complete) {
    for (const [index, trial] of trials.entries()) {
      assert.equal(trial.receipts.length, 2, 'press and release receipts are required');
      assert.equal(trial.retired, true, 'request must be explicitly retired');
      assert.equal(matched[index].length, 1, 'physical request must persist exactly once');
    }
  }
  return matched;
}

test('physical receipts reject missing, stale, duplicate and retired delivery', () => {
  const trial = {
    request: { id: 'request-one', name: 'return', publishedAt: 100, deadline: 1000,
      processIdentifier: 10, windowID: 20, inputWindowID: 30 },
    rich: true, receipts: [], retired: false,
  };
  const receipt = {
    requestId: 'request-one', phase: 'press', at: 120, key: 'Enter', control: false, button: null,
    processIdentifier: 10, windowID: 20, inputWindowID: 30,
    foreground: { windowID: 20, processIdentifier: 10 },
    contextPreserved: true, hiddenPresent: true,
  };
  assert.throws(() => retainPhysicalReceipt(undefined, receipt));
  for (const delta of [
    { requestId: 'previous' }, { at: 99 }, { at: 1001 }, { phase: 'release' },
    { inputWindowID: 31 }, { contextPreserved: false }, { hiddenPresent: false },
  ]) {
    assert.throws(() => retainPhysicalReceipt(structuredClone(trial), { ...receipt, ...delta }));
  }
  retainPhysicalReceipt(trial, receipt);
  assert.throws(() => retainPhysicalReceipt(trial, receipt));
  retainPhysicalReceipt(trial, { ...receipt, phase: 'release', at: 150 });
  assert.equal(trial.receipts.length, 2);
  assert.throws(() => retainPhysicalReceipt(trial, { ...receipt, phase: 'release', at: 160 }));
  trial.retired = true;
  assert.throws(() => retainPhysicalReceipt(trial, receipt));
});

test('physical action ledger catches delayed duplicates through sealed readback', () => {
  const trial = {
    request: { id: 'first', name: 'return', publishedAt: 100, deadline: 1000,
      processIdentifier: 10, windowID: 20, inputWindowID: 30 },
    kind: 'keyboard.submit', key: 'return', sourceId: 'source-one',
    rich: true, metadata: false, receipts: [{ at: 120 }, { at: 150 }], retired: true,
  };
  const event = {
    id: 1, timestamp: new Date(120).toISOString(), kind: 'keyboard.submit', sourceId: 'source-one',
    app: { processIdentifier: 10 }, window: { windowID: 20 }, contentState: 'available',
    keyboard: { keyEquivalent: 'return', modifiers: [], target: { identifier: 'hwnd:30', role: 'AXDocument' } },
  };
  assert.equal(validatePhysicalActions([event], [trial], true)[0].length, 1);
  assert.throws(() => validatePhysicalActions([], [trial], true));
  assert.throws(() => validatePhysicalActions([event], [{ ...trial, receipts: [] }], true));
  assert.throws(() => validatePhysicalActions([event], [{ ...trial, retired: false }], true));
  for (const delta of [
    { id: 99, timestamp: new Date(99).toISOString() }, { timestamp: new Date(151).toISOString() },
    { sourceId: 'new-source' }, { kind: 'mouse.click' }, { ax: { text: 'unexpected' } },
  ]) {
    assert.throws(() => validatePhysicalActions([{ ...event, ...delta }], [trial], true));
  }
  const next = { ...structuredClone(trial),
    request: { ...trial.request, id: 'next', publishedAt: 500, deadline: 1500 },
    receipts: [{ at: 520 }, { at: 550 }],
  };
  const nextEvent = { ...event, id: 2, timestamp: new Date(520).toISOString() };
  assert.equal(validatePhysicalActions([event, nextEvent], [trial, next], true).length, 2);
  assert.throws(() => validatePhysicalActions([event, nextEvent, { ...event, id: 3 }], [trial, next], true));
  const metadata = { ...trial, metadata: true };
  const metadataEvent = { ...event, contentState: 'metadataOnly',
    keyboard: { modifiers: [], target: { role: 'AXDocument' } } };
  assert.equal(validatePhysicalActions([metadataEvent], [metadata], true)[0].length, 1);
  assert.throws(() => validatePhysicalActions([event], [metadata], true));
  const drag = { ...trial, kind: 'mouse.drag', key: undefined,
    request: { ...trial.request, name: 'drag' } };
  const mouse = { ...event, kind: 'mouse.drag', keyboard: undefined,
    mouse: { button: 'left', target: { identifier: 'hwnd:30', role: 'AXDocument' } } };
  assert.equal(validatePhysicalActions([mouse], [drag], true)[0].length, 1);
  assert.throws(() => validatePhysicalActions([mouse, { ...mouse, id: 2, kind: 'mouse.click' }], [drag], true));
});

test('real Windows recorder accepts only controlled synthetic WinForms evidence', {
  skip: !optedIn ? 'requires MAKA_HISTORY_WINDOWS_INTERACTIVE_TEST=1' : false,
  timeout: 180_000,
}, async (t) => {
  assert.equal(process.platform, 'win32', 'interactive acceptance must run on Windows');
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'use Node 24');
  if (richEdit) {
    assert.ok(inputOnly && inputRequestPath, 'Rich Edit acceptance requires the isolated input-only driver');
  }
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
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const appId = `win32.${basename(executable, '.exe')}`;
  const homes = [];
  let fixture;
  let active;
  let foregroundRequired = false;
  let fixtureError;
  let latestForeground;
  let ready;
  let sequence = 0;
  let inputRequest;
  let physicalTrial;
  let physicalBaseline;
  let physicalComplete = false;
  const physicalTrials = [];
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

  async function measureIdleRecorder(milliseconds) {
    const pid = active.child.pid;
    const { stdout, stderr } = await run(powershell, [
      '-NoProfile', '-NonInteractive', '-Command', `
        $ErrorActionPreference = 'Stop'
        $source = 'maka-idle-${randomUUID()}'
        $watcher = Register-WmiEvent -Query 'SELECT * FROM Win32_ProcessStartTrace WHERE ParentProcessID = ${pid}' -SourceIdentifier $source
        try {
          $recorder = [Diagnostics.Process]::GetProcessById(${pid})
          $cpu = $recorder.TotalProcessorTime.TotalMilliseconds
          $clock = [Diagnostics.Stopwatch]::StartNew()
          Start-Sleep -Milliseconds ${milliseconds}
          $recorder.Refresh()
          $cpuMs = $recorder.TotalProcessorTime.TotalMilliseconds - $cpu
          $elapsedMs = $clock.Elapsed.TotalMilliseconds
          $workers = @(Get-Event -SourceIdentifier $source -ErrorAction SilentlyContinue |
            ForEach-Object { $_.SourceEventArgs.NewEvent } |
            Where-Object { $_.ProcessName -eq 'open-history.exe' } |
            ForEach-Object { [int]$_.ProcessID })
          [ordered]@{ processId = ${pid}; elapsedMs = $elapsedMs; cpuMs = $cpuMs
            oneCorePercent = 100 * $cpuMs / $elapsedMs; workerProcessIds = $workers } |
            ConvertTo-Json -Compress
        } finally {
          Unregister-Event -SourceIdentifier $source -ErrorAction SilentlyContinue
          Get-Event -SourceIdentifier $source -ErrorAction SilentlyContinue | Remove-Event
          if ($watcher -is [System.Management.Automation.Job]) { Remove-Job $watcher -Force }
        }
      `,
    ], { windowsHide: true, encoding: 'utf8', timeout: milliseconds + 5_000, maxBuffer: 16 * 1024 });
    assert.equal(stderr, '');
    healthy();
    const metric = JSON.parse(stdout);
    assert.equal(metric.processId, pid);
    assert.ok(metric.elapsedMs >= milliseconds && metric.elapsedMs < milliseconds + 2_000);
    assert.ok(metric.cpuMs >= 0);
    assert.ok(metric.workerProcessIds.length <= 4, 'idle admission started workers faster than the rate gate');
    const { elapsedMs, ...rest } = metric;
    evidence('input.idle-metrics', { ...rest, sampleElapsedMs: elapsedMs });
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

  async function show(window, text, password = window === 'password', action = 'show', extra = {}) {
    healthy();
    const id = ++sequence;
    const command = { id, action, window, text, ...(window === 'password' ? { password } : {}), ...extra };
    evidence('fixture.command', command);
    fixture.child.stdin.write(`${JSON.stringify(command)}\n`);
    const reply = await until(() => replies.get(id), `fixture ${window} focus`, 3_000);
    replies.delete(id);
    assert.equal(reply.action, action);
    assert.equal(reply.windowID, ready.windows[window]);
    assert.equal(reply.processIdentifier, ready.processIdentifier);
    assert.equal(reply.foreground.windowID, reply.windowID);
    assert.equal(reply.foreground.processIdentifier, ready.processIdentifier);
    if (action !== 'privacy') assert.equal(reply.text, text + (extra.hidden ?? ''));
    assert.equal(reply.password, password);
    latestForeground = reply.foreground;
    return reply;
  }

  async function inputCommand(action, request) {
    const id = ++sequence;
    fixture.child.stdin.write(`${JSON.stringify({
      id, action, window: 'one', requestId: request.id, name: request.name, deadline: request.deadline,
    })}\n`);
    const reply = await until(() => replies.get(id), `${action} acknowledgement`, 3_000);
    replies.delete(id);
    assert.equal(reply.action, action);
    assert.equal(reply.requestId, request.id);
    assert.equal(reply.contextPreserved, true);
    assert.equal(reply.hiddenPresent, richEdit);
    assert.deepEqual(reply.foreground, {
      windowID: request.windowID, processIdentifier: request.processIdentifier,
    });
    return reply;
  }

  function retireInputRequest(request, done = false) {
    inputRequest = undefined;
    // Keep the ID so existing drivers that sent it wait for the next request.
    // A driver that has not sent it sees the expired deadline and must stop.
    writeFileSync(inputRequestPath, JSON.stringify({ ...request, retired: true, deadline: 0, done }));
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
      assert.ok(['window.changed', 'ui.changed', 'selection.changed',
        'keyboard.submit', 'keyboard.shortcut', 'mouse.click', 'mouse.contextMenu', 'mouse.drag'].includes(event.kind));
      assert.equal(event.app.bundleIdentifier, appId, 'non-synthetic app persisted');
      assert.equal(event.app.processIdentifier, ready.processIdentifier, 'non-synthetic PID persisted');
      assert.ok(Object.values(ready.windows).includes(event.window.windowID), 'non-synthetic HWND persisted');
      assert.match(event.sourceId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
    }
    if (physicalBaseline?.home === home) {
      validatePhysicalActions(values.slice(physicalBaseline.index), physicalTrials, physicalComplete);
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
      if (richEdit) {
        const health = await json(join(home, 'runtime.json'));
        assert.equal(health?.captureFailures, 0, 'Rich recorder failed before body acceptance');
      }
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
    return assertSuppressed(home, window);
  }

  async function assertSuppressed(home, window) {
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
        if (value.type === 'input.received') retainPhysicalReceipt(physicalTrial, value);
        if (value.foreground) {
          latestForeground = value.foreground;
          if (inputRequest && inputRequestPath && value.type === 'heartbeat') {
            assert.deepEqual(value.foreground, {
              windowID: inputRequest.windowID, processIdentifier: inputRequest.processIdentifier,
            });
            assert.ok(Number.isSafeInteger(value.at) && Date.now() - value.at <= 750);
            inputRequest.publishedAt ??= Date.now();
            writeFileSync(inputRequestPath, JSON.stringify({
              ...inputRequest, foreground: value.foreground, witnessedAt: value.at,
              pointer: value.pointer, pointerWindowID: value.pointerWindowID,
            }));
          }
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
    const initial = await show('one', marker('BODY_A'), false, 'show',
      richEdit ? { hidden: marker('HIDDEN_RICH_RUN') } : {});
    const textHome = await startRecorder('text-on', true);
    let directHome = textHome;
    const directArgs = [
      'snapshot', '--parent-pid', String(process.pid),
      '--window', String(ready.windows.one), '--pid', String(ready.processIdentifier),
      '--source', randomUUID(),
    ];
    let coldRichBody;
    let probeControl;
    let resumeBoundary = 0;
    if (richEdit) {
      assert.match(initial.inputClass,
        /^(?:RichEdit20W|RICHEDIT50W|WindowsForms10\.(?:RichEdit20W|RICHEDIT50W)\..+)$/);
      assert.ok(initial.siblingWindowID > 0 && initial.siblingWindowID !== initial.inputWindowID);
      assert.equal(initial.siblingVisible, true);
      assert.equal(initial.siblingFocused, false);
      assert.equal(initial.privacyVisible, false);
      // The recorder must prove cold capture before any auxiliary UIA client.
      coldRichBody = await captured(textHome, 'one', marker('BODY_A'));
      assert.equal(coldRichBody.ax.truncated, true);
      assert.ok(coldRichBody.ax.text.includes(marker('RICH_SIBLING_BODY')));
      assert.ok(!JSON.stringify(coldRichBody).includes(marker('HIDDEN_RICH_RUN')));
      evidence('assertion.pass', { assertion: 'rich-cold-recorder-body', event: coldRichBody });
      await invoke(textHome, ['pause']);
      const paused = await runtime(textHome, 'paused');
      assert.equal(paused.captureFailures, 0);
      // Published paused state follows pending-worker retirement and sealing.
      resumeBoundary = (await events(textHome, true)).length;
      await assert.rejects(invoke(textHome, directArgs), (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /^capture_not_admitted\r?\n?$/);
        return true;
      });
      // Snapshot admission needs running control without restarting the recorder.
      directHome = join(root, 'rich-direct-probe');
      await mkdir(directHome);
      homes.push(directHome);
      assert.equal((await invoke(directHome, ['validate-home'])).trim(), 'history-home-valid');
      assert.deepEqual(await readdir(directHome), []);
      for (const name of ['config.json', 'maka-settings.json']) {
        const contents = await readFile(join(textHome, name));
        await writeFile(join(directHome, name), contents, { flag: 'wx' });
        assert.deepEqual(await readFile(join(directHome, name)), contents);
      }
      probeControl = { state: 'running', resumeAt: null, revision: randomUUID() };
      await writeFile(join(directHome, 'control.json'), `${JSON.stringify(probeControl)}\n`, { flag: 'wx' });
      evidence('assertion.pass', {
        assertion: 'rich-direct-probe-isolated-control',
        recorderHome: textHome, directHome, probeControl, resumeBoundary,
      });
      // Legacy UIA metadata is diagnostic only: CUIAutomation8 can expose a
      // different provider type for this same native HWND.
      const { stdout, stderr } = await run(powershell, [
        '-NoProfile', '-NonInteractive', '-Mta', '-Command', `
          $ErrorActionPreference = 'Stop'
          Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
          $element = [System.Windows.Automation.AutomationElement]::FocusedElement
          $current = $element.Current
          $children = @()
          $child = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetFirstChild($element)
          while ($null -ne $child -and $children.Count -lt 16) {
            $state = $child.Current
            $children += [ordered]@{
              controlTypeId = $state.ControlType.Id
              className = $state.ClassName
              frameworkId = $state.FrameworkId
              nativeWindowHandle = $state.NativeWindowHandle
              processId = $state.ProcessId
              isPassword = $state.IsPassword
              isOffscreen = $state.IsOffscreen
            }
            $child = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetNextSibling($child)
          }
          [ordered]@{
            controlTypeId = $current.ControlType.Id
            controlType = $current.ControlType.ProgrammaticName
            className = $current.ClassName
            frameworkId = $current.FrameworkId
            nativeWindowHandle = $current.NativeWindowHandle
            processId = $current.ProcessId
            isPassword = $current.IsPassword
            isOffscreen = $current.IsOffscreen
            patterns = @($element.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
            children = $children
            childrenOverflow = $null -ne $child
          } | ConvertTo-Json -Depth 5 -Compress
        `,
      ], { windowsHide: true, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 });
      assert.equal(stderr, '');
      const provider = JSON.parse(stdout);
      evidence('rich-edit.provider', { provider, fixture: initial });
      assert.equal(provider.processId, ready.processIdentifier);
      assert.equal(provider.nativeWindowHandle, initial.inputWindowID);
      assert.equal(provider.isPassword, false);
      assert.equal(provider.isOffscreen, false);
      assert.ok(['Win32', 'WinForm'].includes(provider.frameworkId));
      assert.equal(provider.childrenOverflow, false);
      const visibleProbe = process.env.MAKA_HISTORY_WINDOWS_RICH_VISIBLE_PROBE;
      if (visibleProbe) {
        assert.ok(isAbsolute(visibleProbe));
        assert.equal(basename(visibleProbe), 'maka-rich-visible-probe.exe');
        try {
          const { stdout, stderr } = await run(visibleProbe, [
            String(ready.processIdentifier), String(initial.windowID),
            String(initial.inputWindowID), token,
          ], {
            env: { ...process.env, MAKA_RICH_PROBE_TEST_ONLY: '1', OPEN_COMPUTER_HISTORY_HOME: directHome },
            windowsHide: true, encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024,
          });
          evidence('rich-edit.visible-probe', { code: 0, result: JSON.parse(stdout), stderr });
        } catch (error) {
          evidence('rich-edit.visible-probe', {
            code: error.code, signal: error.signal,
            stdout: error.stdout, stderr: error.stderr, message: error.message,
          });
        }
      }
    }
    const captureStarted = performance.now();
    const direct = JSON.parse(await invoke(directHome, directArgs));
    if (richEdit) {
      assert.ok(direct, 'native RichEdit target requires an admitted snapshot');
      assert.deepEqual(direct.inputTarget, { hwnd: initial.inputWindowID, role: 'AXDocument' });
      assert.ok(direct.text?.includes(marker('BODY_A')), 'RichEdit visible body was omitted');
      assert.equal(direct.textTruncated, true, 'partial visible runs must not claim complete text');
      assert.ok(!JSON.stringify(direct).includes(marker('HIDDEN_RICH_RUN')));
      assert.ok(direct.text.includes(marker('RICH_SIBLING_BODY')), 'visible sibling body was omitted');
      assert.equal(direct.selection, null);
      evidence('assertion.pass', {
        assertion: 'rich-edit-focused-target-with-unfocused-sibling',
        target: direct.inputTarget, siblingWindowID: initial.siblingWindowID,
      });
    } else {
      assert.ok(direct?.text?.includes(marker('BODY_A')), 'direct worker omitted synthetic body');
    }
    evidence('assertion.pass', {
      assertion: richEdit ? 'rich-edit-visible-body-hidden-run-omitted' : 'direct-worker-body',
      durationMs: Math.round(performance.now() - captureStarted), direct,
    });
    if (richEdit) {
      const paused = await json(join(textHome, 'runtime.json'));
      assert.equal(paused.state, 'paused', 'auxiliary probes require an isolated recorder');
      assert.equal(paused.captureFailures, 0);
      assert.equal((await events(textHome, true)).length, resumeBoundary, 'paused probes recorded events');
      assert.deepEqual((await readdir(directHome)).sort(), [
        'config.json', 'control.json', 'maka-settings.json',
      ], 'direct probe must not create recorder state or segments');
      for (const name of ['config.json', 'maka-settings.json']) {
        assert.deepEqual(await readFile(join(directHome, name)), await readFile(join(textHome, name)));
      }
      assert.deepEqual(await json(join(directHome, 'control.json')), probeControl);
      await invoke(textHome, ['resume']);
      await runtime(textHome, 'running');
    }
    const a = await captured(textHome, 'one', marker('BODY_A'), resumeBoundary);
    if (richEdit) {
      assert.equal(a.ax.truncated, true);
      assert.ok(a.ax.text.includes(marker('RICH_SIBLING_BODY')));
      assert.ok(!JSON.stringify(a).includes(marker('HIDDEN_RICH_RUN')));
      assert.notEqual(a.sourceId, coldRichBody.sourceId, 'resume must establish a fresh input source');
      evidence('assertion.pass', { assertion: 'rich-resumed-recorder-body', event: a, resumeBoundary });
    }
    const appId = a.app.bundleIdentifier;
    const applications = JSON.parse(await invoke(textHome, ['applications', appId, 'win32.maka-history-missing']));
    assert.equal(applications.length, 2);
    assert.deepEqual(Object.keys(applications[0]).sort(), ['bundleIdentifier', 'iconDataUrl', 'name', 'resolution']);
    assert.equal(applications[0].resolution, 'resolved');
    assert.equal(applications[0].bundleIdentifier, appId);
    assert.equal(applications[0].name, 'Maka synthetic history fixture');
    assert.deepEqual(applications[1], {
      bundleIdentifier: 'win32.maka-history-missing', name: 'win32.maka-history-missing', iconDataUrl: null,
      resolution: 'not_running',
    });
    {
      assert.equal(typeof applications[0].iconDataUrl, 'string', 'synthetic executable icon was not extracted');
      assert.ok(applications[0].iconDataUrl.startsWith('data:image/png;base64,'));
      const png = Buffer.from(applications[0].iconDataUrl.split(',')[1], 'base64');
      assert.ok(png.length <= 48 * 1024);
      assert.equal(png.readUInt32BE(16), 48);
      assert.equal(png.readUInt32BE(20), 48);
      assert.equal(png[24], 8);
      assert.equal(png[25], 6);
    }
    evidence('assertion.pass', { assertion: 'application-metadata', applications });
    async function setCaptureText(enabled) {
      const path = join(textHome, 'config.json');
      const config = await json(path);
      config.captureText = enabled;
      await writeFile(path, `${JSON.stringify(config)}\n`);
    }
    let metadataObserved;
    if (metadataInput) {
      assert.ok(inputOnly && inputRequestPath && !richEdit);
      await invoke(textHome, ['pause']);
      await runtime(textHome, 'paused');
      await setCaptureText(false);
      const content = `HEAD\u4e2d\ud83d\udcbb\r\n${'x'.repeat(70000)}${marker('NUMERIC_ONLY')}`;
      await show('one', content, false, 'edit');
      async function counts() {
        const id = ++sequence;
        fixture.child.stdin.write(`${JSON.stringify({ id, action: 'readCounts', window: 'one' })}\n`);
        return until(() => replies.get(id), 'fixture body-read counters', 3000);
      }
      for (const [start, length] of [[70000, 0], [70001, 9], [5, 2]]) {
        await show('one', content, false, 'select', { start, length });
        const before = await counts();
        // Both recorder and one-shot worker observe only numeric metadata.
        await invoke(textHome, ['resume']);
        const value = JSON.parse(await invoke(textHome, [
          'snapshot', '--parent-pid', String(process.pid),
          '--window', String(ready.windows.one), '--pid', String(ready.processIdentifier),
          '--source', randomUUID(),
        ]));
        const after = await counts();
        assert.equal(value?.text, null);
        assert.equal(value?.selection?.start, start);
        assert.equal(value?.selection?.length, length);
        assert.equal(value.selection.selectedText, undefined);
        assert.equal(after.bodyReads, before.bodyReads, 'metadata capture called WM_GETTEXT on Edit');
        assert.ok(after.selectionReads >= before.selectionReads + 2, 'numeric range was not rechecked');
        const event = await until(async () => (await events(textHome)).find(event =>
          event.selection?.selectedRange?.location === start &&
          event.selection.selectedRange.length === length), 'numeric range in real JSONL');
        assert.equal(event.contentState, 'metadataOnly');
        assert.equal(event.selection.selectedText, undefined);
        assert.equal(event.ax, undefined);
        evidence('assertion.pass', { assertion: 'numeric-selection-no-body-read', start, length, before, after, event });
        await invoke(textHome, ['pause']);
        await runtime(textHome, 'paused');
      }
      await show('one', marker('METADATA_ACTION_BODY'), false, 'edit');
      const since = (await events(textHome)).length;
      await invoke(textHome, ['resume']);
      metadataObserved = await captured(textHome, 'one', '', since, false);
    }
    if (inputRequestPath) {
      assert.ok(isAbsolute(inputRequestPath));
      // Keep the hidden-run Rich document throughout its physical action cases.
      const reply = richEdit ? initial : await show('one', marker('INPUT_BODY'), false, 'edit');
      const observed = metadataInput ? metadataObserved : richEdit ? a :
        await captured(textHome, 'one', marker('INPUT_BODY'));
      physicalBaseline = { home: textHome, index: (await events(textHome)).length };
      const cases = [
        { name: 'return', kind: 'keyboard.submit', key: 'return' },
        { name: 'shortcut', kind: 'keyboard.shortcut', key: 'a' },
        { name: 'return', kind: 'keyboard.submit', key: 'return', idleMs: 6_000 },
        { name: 'drag', kind: 'mouse.drag' },
        { name: 'click', kind: 'mouse.click' },
      ];
      for (const item of cases) {
        if (item.idleMs) {
          await measureIdleRecorder(item.idleMs);
        }
        await events(textHome); // Recheck earlier requests for delayed duplicates.
        const request = {
          id: randomUUID(), name: item.name, deadline: Date.now() + 12_000,
          processIdentifier: ready.processIdentifier, windowID: ready.windows.one,
          inputWindowID: reply.inputWindowID, point: reply.inputPoint,
        };
        physicalTrial = {
          request, kind: item.kind, key: item.key, sourceId: observed.sourceId,
          metadata: metadataInput, rich: richEdit, receipts: [], retired: false,
        };
        physicalTrials.push(physicalTrial);
        const armed = await inputCommand('inputArm', request);
        assert.equal(armed.inputWindowID, reply.inputWindowID);
        inputRequest = request;
        await until(() => physicalTrial.receipts.length === 2, `physical ${item.name} press/release`, 12_000);
        retireInputRequest(request);
        const retired = await inputCommand('inputRetire', request);
        assert.equal(retired.released, true);
        physicalTrial.retired = true;
        const action = await until(async () => {
          const rows = (await events(textHome)).slice(physicalBaseline.index);
          return validatePhysicalActions(rows, physicalTrials).at(-1)[0];
        }, `virtual-device ${item.name}`, Math.max(1, request.deadline + 2_000 - Date.now()));
        assert.equal(action.sourceId, observed.sourceId);
        assert.equal(action.ax, undefined, 'action cannot relabel a body observation');
        assert.equal(action.selection, undefined);
        const target = action.keyboard?.target ?? action.mouse?.target;
        assert.equal(target.identifier, metadataInput ? undefined : `hwnd:${reply.inputWindowID}`);
        if (metadataInput) {
          assert.equal(action.contentState, 'metadataOnly');
          assert.equal(action.keyboard?.keyEquivalent, undefined);
          assert.equal(action.contentDomains, undefined);
        }
        assert.equal(target.role, richEdit ? 'AXDocument' : 'AXTextField');
        if (item.name === 'shortcut') assert.ok(action.keyboard.modifiers.includes('control'));
        if (item.name === 'drag') {
          assert.deepEqual(action.mouse.origin, action.mouse.destination);
          assert.equal(action.mouse.origin.element.identifier, metadataInput ? undefined : `hwnd:${reply.inputWindowID}`);
          assert.equal(action.mouse.origin.window.windowID, ready.windows.one);
          assert.equal(action.mouse.clickCount, undefined);
        }
        evidence('assertion.pass', {
          assertion: `${richEdit ? 'rich-edit-' : ''}native-input-${item.name}${item.idleMs ? '-after-idle' : ''}`,
          request, receipts: physicalTrial.receipts, retired, action,
        });
        physicalTrial = undefined;
      }
      physicalComplete = true;
      await events(textHome);
      await writeFile(inputRequestPath, JSON.stringify({ done: true }));
      if (inputOnly) {
        if (metadataInput) {
          const since = (await events(textHome)).length;
          await setCaptureText(true);
          await show('one', marker('TEXT_MODE_RECOVERED'), false, 'edit');
          await captured(textHome, 'one', marker('TEXT_MODE_RECOVERED'), since);
          const disabledSince = (await events(textHome)).length;
          await setCaptureText(false);
          await show('one', marker('TEXT_MODE_DISABLED'), false, 'edit');
          await captured(textHome, 'one', '', disabledSince, false);
          evidence('assertion.pass', { assertion: 'both-text-mode-transitions-recover' });
        }
        if (richEdit) {
          const mixedText = marker('MIXED_EDIT_SELECTION');
          const mixedSince = (await events(textHome)).length;
          const mixed = await show('two', mixedText);
          assert.equal(mixed.siblingVisible, true);
          assert.equal(mixed.siblingFocused, false);
          await show('two', mixedText, false, 'select', { start: 0, length: mixedText.length });
          const mixedSnapshot = JSON.parse(await invoke(textHome, [
            'snapshot', '--parent-pid', String(process.pid),
            '--window', String(ready.windows.two), '--pid', String(ready.processIdentifier),
            '--source', randomUUID(),
          ]));
          assert.equal(mixedSnapshot?.selection?.selectedText, mixedText);
          assert.equal(mixedSnapshot.selection.truncated, false);
          assert.ok(mixedSnapshot.text.includes(mixedText));
          assert.ok(mixedSnapshot.text.includes(marker('RICH_SIBLING_BODY')));
          assert.equal(mixedSnapshot.textTruncated, true);
          const mixedEvent = await captured(textHome, 'two', mixedText, mixedSince);
          assert.equal(mixedEvent.window.title, a.window.title);
          assert.notEqual(mixedEvent.sourceId, a.sourceId);
          evidence('assertion.pass', { assertion: 'ordinary-edit-selection-beside-rich-sibling' });
          const hidden = marker('HIDDEN_RICH_RUN');
          const returnedSince = (await events(textHome)).length;
          await show('one', marker('BODY_A'), false, 'show', { hidden });
          const returned = await captured(textHome, 'one', marker('BODY_A'), returnedSince);
          assert.notEqual(returned.sourceId, a.sourceId);
          assert.notEqual(returned.sourceId, mixedEvent.sourceId);
          evidence('assertion.pass', { assertion: 'rich-same-title-hwnd-focus-return', a, mixedEvent, returned });
          const editedSince = (await events(textHome)).length;
          await show('one', marker('RICH_EDITED'), false, 'edit',
            { hidden: marker('HIDDEN_RICH_EDITED') });
          const edited = await captured(textHome, 'one', marker('RICH_EDITED'), editedSince);
          assert.equal(edited.sourceId, returned.sourceId);
          assert.notEqual(edited.kind, 'window.changed');
          assert.equal(edited.ax.truncated, true);
          assert.ok(!JSON.stringify(edited).includes(marker('HIDDEN_RICH_EDITED')));
          evidence('assertion.pass', { assertion: 'rich-visible-body-edit', event: edited });
          const visible = await show('one', marker('BODY_A'), false, 'privacy',
            { hidden, visible: true });
          assert.equal(visible.privacyVisible, true);
          await show('one', marker('RICH_PRIVACY_ONLY'), false, 'edit', { hidden });
          await assertSuppressed(textHome, 'one');
          await show('one', marker('RICH_RECOVERED'), false, 'edit', { hidden });
          const recoverySince = (await events(textHome)).length;
          const restored = await show('one', marker('RICH_RECOVERED'), false, 'privacy',
            { hidden, visible: false });
          assert.equal(restored.privacyVisible, false);
          const recovered = JSON.parse(await invoke(textHome, [
            'snapshot', '--parent-pid', String(process.pid),
            '--window', String(ready.windows.one), '--pid', String(ready.processIdentifier),
            '--source', randomUUID(),
          ]));
          assert.deepEqual(recovered?.inputTarget, direct.inputTarget);
          assert.equal(recovered.selection, null);
          assert.ok(recovered.text?.includes(marker('RICH_RECOVERED')));
          assert.equal(recovered.textTruncated, true);
          for (const value of [hidden, marker('RICH_PRIVACY_ONLY'), marker('RICH_PASSWORD')]) {
            assert.ok(!JSON.stringify(recovered).includes(value));
          }
          await captured(textHome, 'one', marker('RICH_RECOVERED'), recoverySince);
          evidence('assertion.pass', { assertion: 'rich-sibling-password-suppression-and-recovery' });
          await invoke(textHome, ['pause']);
          await runtime(textHome, 'paused');
          await setCaptureText(false);
          await show('one', marker('RICH_METADATA_ONLY'), false, 'edit',
            { hidden: marker('HIDDEN_RICH_METADATA') });
          const metadataSince = (await events(textHome)).length;
          await invoke(textHome, ['resume']);
          await captured(textHome, 'one', '', metadataSince, false);
          const metadataSnapshot = JSON.parse(await invoke(textHome, [
            'snapshot', '--parent-pid', String(process.pid),
            '--window', String(ready.windows.one), '--pid', String(ready.processIdentifier),
            '--source', randomUUID(),
          ]));
          assert.ok(metadataSnapshot);
          assert.equal(metadataSnapshot.text, null);
          assert.equal(metadataSnapshot.selection, null);
          for (const event of (await events(textHome)).slice(metadataSince)) {
            assert.equal(event.contentState, 'metadataOnly');
            assert.equal(event.ax, undefined);
            assert.equal(event.selection, undefined);
          }
          await invoke(textHome, ['pause']);
          await runtime(textHome, 'paused');
          await show('one', marker('RICH_TEXT_RESTORED'), false, 'edit', { hidden });
          await setCaptureText(true);
          const textSince = (await events(textHome)).length;
          await invoke(textHome, ['resume']);
          const textRestored = await captured(textHome, 'one', marker('RICH_TEXT_RESTORED'), textSince);
          assert.equal(textRestored.ax.truncated, true);
          evidence('assertion.pass', { assertion: 'rich-both-text-mode-transitions-recover' });
        }
        const records = await stopRecorder(textHome);
        if (richEdit) {
          assert.ok(records.some(event => event.ax?.text?.includes(marker('BODY_A'))));
          assert.ok(records.some(event => event.ax?.text?.includes(marker('RICH_TEXT_RESTORED'))));
          for (const value of [marker('HIDDEN_RICH_RUN'), marker('HIDDEN_RICH_EDITED'),
            marker('HIDDEN_RICH_METADATA'), marker('RICH_METADATA_ONLY'),
            marker('RICH_PRIVACY_ONLY'), marker('RICH_PASSWORD')]) {
            assert.ok(!JSON.stringify(records).includes(value), 'excluded RichEdit content persisted');
          }
        }
        return;
      }
    }
    let count = (await events(textHome)).length;
    await show('one', marker('BODY_EDIT'), false, 'edit');
    const edited = await captured(textHome, 'one', marker('BODY_EDIT'), count);
    assert.equal(edited.window.windowID, a.window.windowID);
    assert.equal(edited.sourceId, a.sourceId, 'pure same-window edit must retain its source identity');
    assert.notEqual(edited.kind, 'window.changed', 'pure edit is a content change');
    evidence('assertion.pass', { assertion: 'same-window-edit-retains-source', a, edited });
    for (const start of [2, 5]) {
      count = (await events(textHome)).length;
      const id = ++sequence;
      fixture.child.stdin.write(`${JSON.stringify({ id, action: 'select', window: 'one', start, length: 5 })}\n`);
      const reply = await until(() => replies.get(id), 'fixture selection', 3_000);
      replies.delete(id);
      assert.equal(reply.selectionStart, start);
      assert.equal(reply.selectedText, marker('BODY_EDIT').slice(start, start + 5));
      const selected = await until(async () => (await events(textHome)).slice(count).find((event) =>
        event.selection?.selectedText === reply.selectedText
        && event.selection.selectedRange?.location === start),
      'source-admitted selection event');
      assert.equal(selected.kind, 'selection.changed');
      assert.equal(selected.sourceId, edited.sourceId);
      assert.equal(selected.selection.truncated, false);
      evidence('assertion.pass', { assertion: 'selection-retains-source-and-position', selected });
    }
    {
      const selectedText = `${'a'.repeat(5000)}${marker('SELECTION_TAIL')}\u4e2d\u6587\ud83d\udcbb`;
      count = (await events(textHome)).length;
      await show('one', `HEAD${selectedText}END`, false, 'edit');
      const clearId = ++sequence;
      fixture.child.stdin.write(`${JSON.stringify({
        id: clearId, action: 'select', window: 'one', start: 0, length: 0,
      })}\n`);
      const cleared = await until(() => replies.get(clearId), 'clear long body selection', 3_000);
      replies.delete(clearId);
      assert.equal(cleared.selectedText, '');
      const bodySnapshot = JSON.parse(await invoke(textHome, [
        'snapshot', '--parent-pid', String(process.pid),
        '--window', String(ready.windows.one), '--pid', String(ready.processIdentifier),
        '--source', edited.sourceId,
      ]));
      assert.equal(bodySnapshot?.selection?.selectedText, undefined);
      assert.equal(bodySnapshot.selection.start, 0);
      assert.equal(bodySnapshot.selection.length, 0);
      assert.ok(bodySnapshot.text.includes(`HEAD${selectedText}END`),
        'plain native Edit body must retain its tail beyond the UIA 4096-unit scalar cap');
      const bodyEvent = await captured(textHome, 'one', marker('SELECTION_TAIL'), count);
      assert.equal(bodyEvent.sourceId, edited.sourceId);
      assert.equal(bodyEvent.selection?.selectedText, undefined);
      evidence('assertion.pass', { assertion: 'plain-edit-body-tail-without-selection', bodySnapshot, bodyEvent });
      count = (await events(textHome)).length;
      const id = ++sequence;
      fixture.child.stdin.write(`${JSON.stringify({
        id, action: 'select', window: 'one', start: 4, length: selectedText.length,
      })}\n`);
      const reply = await until(() => replies.get(id), 'long fixture selection', 3_000);
      replies.delete(id);
      assert.equal(reply.selectedText, selectedText);
      const selectionSnapshot = JSON.parse(await invoke(textHome, [
        'snapshot', '--parent-pid', String(process.pid),
        '--window', String(ready.windows.one), '--pid', String(ready.processIdentifier),
        '--source', edited.sourceId,
      ]));
      evidence('selection.direct', {
        snapshot: selectionSnapshot,
        runtime: JSON.parse(await readFile(join(textHome, 'runtime.json'), 'utf8')),
      });
      assert.equal(selectionSnapshot?.selection?.selectedText, selectedText,
        'direct worker must preserve the admitted long selection');
      assert.equal(selectionSnapshot.selection.start, 4);
      const selected = await until(async () => (await events(textHome)).slice(count).find((event) =>
        event.selection?.selectedText === selectedText && event.selection.selectedRange?.location === 4),
      'selection witness beyond 4 KiB');
      assert.equal(selected.sourceId, edited.sourceId);
      assert.equal(selected.selection.truncated, false);
      assert.ok(Buffer.byteLength(selected.selection.selectedText) > 4096);
      assert.ok(Buffer.byteLength(selected.selection.selectedText) <= 8192);
      assert.ok(Buffer.byteLength(selected.ax.text) + Buffer.byteLength(selected.selection.selectedText) <= 28 * 1024);
      evidence('assertion.pass', { assertion: 'selection-eight-kib-tail', selected });
    }
    for (const testCase of [
      {
        name: 'selection-utf8-budget', prefix: 'HEAD',
        selection: `${'a'.repeat(8190)}\ud83d\udcbb${marker('OVER_SELECTION_BUDGET')}`,
        expected: 'a'.repeat(8190),
      },
      {
        name: 'selection-offset-budget', prefix: `${marker('OFFSET_BODY')}${'a'.repeat(33 * 1024)}`,
        selection: marker('OFFSET_SELECTION'),
      },
    ]) {
      await show('one', `${testCase.prefix}${testCase.selection}END`, false, 'edit');
      const id = ++sequence;
      fixture.child.stdin.write(`${JSON.stringify({
        id, action: 'select', window: 'one',
        start: testCase.prefix.length, length: testCase.selection.length,
      })}\n`);
      const reply = await until(() => replies.get(id), testCase.name, 3_000);
      replies.delete(id);
      assert.equal(reply.selectionStart, testCase.prefix.length);
      assert.equal(reply.selectedText, testCase.selection);
      const snapshot = JSON.parse(await invoke(textHome, [
        'snapshot', '--parent-pid', String(process.pid),
        '--window', String(ready.windows.one), '--pid', String(ready.processIdentifier),
        '--source', edited.sourceId,
      ]));
      assert.ok(snapshot?.text?.length, 'optional selection budget must preserve admitted body');
      if (testCase.expected) {
        assert.equal(snapshot.selection.selectedText, testCase.expected);
        assert.equal(snapshot.selection.start, 4);
        assert.equal(snapshot.selection.truncated, true);
        assert.ok(Buffer.byteLength(snapshot.text) + Buffer.byteLength(snapshot.selection.selectedText) <= 28 * 1024);
      } else {
        assert.equal(snapshot.selection?.selectedText, undefined);
        assert.equal(snapshot.selection.start, testCase.prefix.length);
        assert.equal(snapshot.selection.length, testCase.selection.length);
      }
      evidence('assertion.pass', { assertion: testCase.name, snapshot });
    }
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
    count = (await events(textHome)).length;
    await show('one', marker('AGGREGATE_BUDGET'), false, 'show', { budget: true });
    const clipped = await captured(textHome, 'one', marker('AGGREGATE_BUDGET'), count);
    assert.ok(clipped.ax.text.includes('SYNTHETIC_BUDGET_'));
    assert.equal(clipped.ax.truncated, true, 'upstream aggregate clipping provenance was lost');
    assert.ok(Buffer.byteLength(clipped.ax.text) <= 28 * 1024);
    evidence('assertion.pass', { assertion: 'upstream-aggregate-clipping', bytes: Buffer.byteLength(clipped.ax.text) });
    await show('one', marker('AFTER_BUDGET'), false, 'show', { budget: false });

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
    const pausedSegments = await segments(textHome, true);
    for (const { metadata } of pausedSegments) {
      assert.equal(metadata.endReason, 'finished', 'pause must seal every earlier segment');
      assert.ok(metadata.endedAt);
    }
    denied.push(marker('PAUSED_DENIED'));
    await show('two', denied.at(-1));
    await until(async () => {
      assert.equal((await events(textHome)).length, pausedCount, 'paused recorder wrote events');
      const value = await json(join(textHome, 'runtime.json'));
      assert.equal(value.state, 'paused');
      assert.deepEqual(await segments(textHome, true), pausedSegments, 'pause created or rewrote segments');
      return Date.parse(value.updatedAt) > Date.parse(paused.updatedAt);
    }, 'paused heartbeat after synthetic focus/value change', 7_000);
    evidence('assertion.pass', { assertion: 'pause-no-writes', pausedCount });
    await show('one', marker('RESUMED_BODY'));
    await invoke(textHome, ['resume']);
    await runtime(textHome, 'running');
    await captured(textHome, 'one', marker('RESUMED_BODY'), pausedCount);
    assert.equal((await segments(textHome)).length, pausedSegments.length + 1, 'resume must open one fresh segment');
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
    inputRequest = undefined;
    if (inputRequestPath) {
      try { await writeFile(inputRequestPath, JSON.stringify({ done: true })); }
      catch (error) { cleanupErrors.push(error); }
    }
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
    if (fixtureError) cleanupErrors.push(fixtureError);
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
