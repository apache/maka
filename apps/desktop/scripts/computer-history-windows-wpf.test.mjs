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
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const helper = process.env.MAKA_HISTORY_WINDOWS_HELPER
  ?? fileURLToPath(new URL('../resources/bin/open-history.exe', import.meta.url));
const fixtureSource = fileURLToPath(new URL('./computer-history-windows-wpf.fixture.ps1', import.meta.url));
// Peer initialization may affect later UIA calls; keep diagnostics out of clean acceptance.
const peerDiagnostics = process.env.MAKA_HISTORY_WINDOWS_WPF_PEER_DIAGNOSTICS === '1';
const selectionOnly = process.env.MAKA_HISTORY_WINDOWS_WPF_SELECTION_TEST_ONLY === '1';
const visibleOnly = process.env.MAKA_HISTORY_WINDOWS_WPF_VISIBLE_TEST_ONLY === '1';
const recorderMode = process.env.MAKA_HISTORY_WINDOWS_WPF_RECORDER_TEST === '1';
const inputRequestPath = process.env.MAKA_HISTORY_WINDOWS_INPUT_REQUEST;

async function cleanupAll(steps) {
  const errors = [];
  for (const step of steps) {
    try { await step(); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'WPF fixture cleanup failed');
}

function publishInputReady(request, witness, path, now = Date.now(), write = writeFileSync,
  qpcNow = process.hrtime.bigint()) {
  assert.equal(witness.type, 'input.ready');
  assert.equal(witness.requestId, request.id);
  assert.equal(witness.field, request.field);
  assert.equal(witness.inputWindowID, request.inputWindowID);
  assert.deepEqual(witness.foreground, { processIdentifier: request.processIdentifier, windowID: request.windowID });
  assert.ok(Number.isSafeInteger(witness.witnessedAt));
  assert.equal(typeof witness.witnessedQpcNs, 'string');
  assert.match(witness.witnessedQpcNs, /^[1-9][0-9]{0,19}$/u);
  const observed = BigInt(witness.witnessedQpcNs);
  assert.ok(observed <= 0xffff_ffff_ffff_ffffn);
  assert.equal(typeof qpcNow, 'bigint');
  assert.ok(observed <= qpcNow && qpcNow - observed <= 750_000_000n,
  'input readiness must retain a fresh fixture-origin timestamp');
  assert.ok(Number.isSafeInteger(request.deadline) && now <= request.deadline,
    'input readiness exceeded the original request deadline');
  const publishedAt = request.publishedAt ?? now;
  assert.ok(Number.isSafeInteger(publishedAt) && publishedAt <= now);
  // Receipt time cannot renew a fixture witness or the first publication boundary.
  write(path, JSON.stringify({ ...request, publishedAt, foreground: witness.foreground,
    witnessedAt: witness.witnessedAt, witnessedQpcNs: witness.witnessedQpcNs }));
  request.publishedAt = publishedAt;
}

function retainPhysicalReceipt(trial, receipt, now = Date.now()) {
  assert.ok(trial && !trial.retired && trial.request.publishedAt, 'receipt outside a published request');
  assert.equal(trial.receipt, undefined, 'duplicate physical receipt');
  const request = trial.request;
  assert.equal(receipt.requestId, request.id);
  assert.equal(receipt.name, request.name);
  assert.equal(receipt.key, request.name === 'return' ? 'Return' : 'A');
  assert.equal(receipt.field, request.field);
  assert.equal(receipt.fieldAfter, trial.switchTo ?? request.field);
  assert.equal(receipt.processIdentifier, request.processIdentifier);
  assert.equal(receipt.windowID, request.windowID);
  assert.equal(receipt.inputWindowID, request.inputWindowID);
  assert.deepEqual(receipt.foreground, { processIdentifier: request.processIdentifier, windowID: request.windowID });
  assert.equal(receipt.control, request.name === 'shortcut');
  assert.equal(receipt.password, trial.password);
  assert.ok(Number.isSafeInteger(receipt.keyDownAt) && Number.isSafeInteger(receipt.settledAt));
  assert.ok(receipt.keyDownAt >= request.publishedAt && receipt.settledAt >= receipt.keyDownAt &&
    receipt.settledAt <= request.deadline && receipt.settledAt <= now,
  'receipt must belong to the current physical request interval');
  assert.equal(Date.parse(receipt.timestamp), receipt.settledAt);
  if (request.name === 'shortcut') {
    assert.equal(receipt.selectionStart, 0);
    assert.ok(Number.isSafeInteger(receipt.selectionLength) && receipt.selectionLength > 0,
      'Ctrl+A did not select the actual WPF field');
    assert.equal(receipt.selectionLength, receipt.bodyLength);
  }
  trial.receipt = receipt;
}

function reconcilePhysicalActions(events, trials, complete = false) {
  const matched = trials.map(() => []);
  for (const event of events.filter((event) => /^(keyboard|mouse)\./u.test(event.kind))) {
    const timestamp = Date.parse(event.timestamp);
    const owners = trials.flatMap((trial, index) => trial.receipt &&
      timestamp >= trial.request.publishedAt && timestamp <= trial.receipt.keyDownAt ? [index] : []);
    assert.equal(owners.length, 1, 'native action must belong to exactly one physical receipt interval');
    const index = owners[0];
    const trial = trials[index];
    assert.equal(trial.reject, false, 'rejected physical request persisted');
    const { request, includeText, sourceId } = trial;
    assert.equal(event.kind, request.name === 'return' ? 'keyboard.submit' : 'keyboard.shortcut');
    assert.equal(event.app?.processIdentifier, request.processIdentifier);
    assert.equal(event.window?.windowID, request.windowID);
    assert.equal(event.sourceId, sourceId, 'action changed its admitted body source');
    assert.deepEqual(event.keyboard?.target, { role: 'AXTextField' });
    assert.deepEqual(event.keyboard.modifiers, request.name === 'shortcut' ? ['control'] : []);
    assert.equal(event.keyboard.keyEquivalent, includeText ? request.name === 'return' ? 'return' : 'a' : undefined);
    assert.equal(event.contentState, includeText ? 'available' : 'metadataOnly');
    assert.equal(event.ax, undefined, 'key event cannot relabel a body observation');
    assert.equal(event.selection, undefined);
    if (includeText) assert.deepEqual(event.contentDomains, []);
    else assert.equal(event.contentDomains, undefined);
    matched[index].push(event);
    assert.equal(matched[index].length, 1, 'duplicate or delayed physical action');
    if (trial.event) assert.deepEqual(event, trial.event, 'persisted action changed after its receipt');
  }
  if (complete) {
    for (const [index, trial] of trials.entries()) {
      assert.ok(trial.receipt && trial.retired, 'physical request must be witnessed and retired');
      assert.equal(matched[index].length, trial.reject ? 0 : 1, 'sealed request/action count mismatch');
      if (!trial.reject) assert.deepEqual(matched[index][0], trial.event);
    }
  }
  return matched;
}

test('WPF readiness publication preserves observation time and the original request interval', () => {
  const request = { id: 'one', field: 'one', deadline: 3_000,
    processIdentifier: 10, windowID: 20, inputWindowID: 20 };
  const witness = { type: 'input.ready', requestId: 'one', field: 'one', inputWindowID: 20,
    foreground: { processIdentifier: 10, windowID: 20 }, witnessedAt: 1_000, witnessedQpcNs: '1000000000' };
  const writes = [];
  const write = (path, data) => { assert.equal(path, 'request.json'); writes.push(JSON.parse(data)); };
  publishInputReady(request, witness, 'request.json', 1_750, write, 1_750_000_000n);
  publishInputReady(request, { ...witness, witnessedAt: 2_900, witnessedQpcNs: '2900000000' },
    'request.json', 3_000, write, 3_000_000_000n);
  assert.deepEqual(writes.map(({ witnessedAt, publishedAt, deadline }) => ({ witnessedAt, publishedAt, deadline })), [
    { witnessedAt: 1_000, publishedAt: 1_750, deadline: 3_000 },
    { witnessedAt: 2_900, publishedAt: 1_750, deadline: 3_000 },
  ]);
  assert.equal(writes[0].id, request.id);
  assert.deepEqual(writes[0].foreground, witness.foreground);
  assert.equal(request.publishedAt, 1_750);
  assert.equal(witness.witnessedAt, 1_000);
  assert.equal(writes[0].witnessedQpcNs, witness.witnessedQpcNs);
  const publishedRequest = structuredClone(request);
  for (const [witnessedQpcNs, now] of [['2249999999', 3_000], ['3000000001', 3_000], ['3000000000', 3_001]]) {
    assert.throws(() => publishInputReady(request, { ...witness, witnessedQpcNs },
      'request.json', now, write, 3_000_000_000n));
    assert.deepEqual(request, publishedRequest);
  }
  assert.equal(writes.length, 2, 'rejected heartbeats cannot replace the last valid publication');
});

test('WPF actual readiness publisher rejects delayed, future and invalid witnesses without writing', () => {
  const request = { id: 'one', field: 'one', deadline: 3_000,
    processIdentifier: 10, windowID: 20, inputWindowID: 20 };
  const witness = { type: 'input.ready', requestId: 'one', field: 'one', inputWindowID: 20,
    foreground: { processIdentifier: 10, windowID: 20 }, witnessedAt: 2_000, witnessedQpcNs: '2000000000' };
  let writes = 0;
  const write = () => { writes++; };
  for (const delta of [
    ...['1000000000', '1249999999', '2000000001', undefined, 2000000000, '0', '-1',
      '01', '1e9', '18446744073709551616'].map(witnessedQpcNs => ({ witnessedQpcNs })),
    { witnessedAt: undefined }, { witnessedAt: NaN }, { witnessedAt: '2000' },
    { requestId: 'old' }, { field: 'two' }, { inputWindowID: 21 },
    { foreground: { processIdentifier: 11, windowID: 20 } },
  ]) {
    const pending = structuredClone(request);
    assert.throws(() => publishInputReady(pending, { ...witness, ...delta }, 'request.json', 2_000, write, 2_000_000_000n));
    assert.deepEqual(pending, request);
  }
  assert.throws(() => publishInputReady(request, witness, 'request.json', 3_001, write, 2_000_000_000n));
  assert.equal(writes, 0);
  assert.equal(request.publishedAt, undefined);

  const writeError = new Error('request write failed');
  assert.throws(() => publishInputReady(request, witness, 'request.json', 2_000, () => { throw writeError; }, 2_000_000_000n),
    (error) => error === writeError);
  assert.equal(request.publishedAt, undefined, 'failed writes cannot start a receipt interval');
});

test('WPF QPC freshness survives UTC disagreement without relaxing UTC publication or expiry', () => {
  const request = { id: 'one', field: 'one', deadline: 3_000,
    processIdentifier: 10, windowID: 20, inputWindowID: 20 };
  const witness = { type: 'input.ready', requestId: 'one', field: 'one', inputWindowID: 20,
    foreground: { processIdentifier: 10, windowID: 20 }, witnessedAt: 2_001,
    witnessedQpcNs: '9007199254740993' };
  const writes = [];
  const write = (_, data) => writes.push(JSON.parse(data));
  const observed = BigInt(witness.witnessedQpcNs);
  for (const witnessedAt of [2_001, 50_000, 1]) {
    publishInputReady(request, { ...witness, witnessedAt }, 'request.json', 2_000, write, observed);
  }
  assert.deepEqual(writes.map(value => value.witnessedAt), [2_001, 50_000, 1]);
  assert.ok(writes.every(value => value.witnessedQpcNs === witness.witnessedQpcNs && value.publishedAt === 2_000));
  for (const [now, qpcNow] of [[1_999, observed], [3_001, observed],
    [2_000, observed - 1n], [2_000, observed + 750_000_001n]]) {
    assert.throws(() => publishInputReady(request, witness, 'request.json', now, write, qpcNow));
  }
  publishInputReady(request, witness, 'request.json', 3_000, write, observed + 750_000_000n);
  assert.equal(writes.length, 4);
});

test('WPF physical receipts reject stale, duplicate and retired delivery', () => {
  const trial = { request: { id: 'one', name: 'return', field: 'one', publishedAt: 100, deadline: 200,
    processIdentifier: 10, windowID: 20, inputWindowID: 20 }, password: false, retired: false };
  const receipt = { requestId: 'one', name: 'return', key: 'Return', field: 'one', fieldAfter: 'one',
    processIdentifier: 10, windowID: 20, inputWindowID: 20, foreground: { processIdentifier: 10, windowID: 20 },
    control: false, password: false, keyDownAt: 120, settledAt: 150, timestamp: new Date(150).toISOString() };
  for (const delta of [
    { requestId: 'old' }, { keyDownAt: 99 }, { keyDownAt: 151 }, { settledAt: 201 },
    { keyDownAt: undefined }, { timestamp: 'invalid' }, { fieldAfter: 'two' }, { inputWindowID: 21 },
    { processIdentifier: 11 }, { password: true }, { control: true },
  ]) {
    assert.throws(() => retainPhysicalReceipt(structuredClone(trial), { ...receipt, ...delta }, 200));
  }
  assert.throws(() => retainPhysicalReceipt(undefined, receipt, 200));
  assert.throws(() => retainPhysicalReceipt({ ...trial, retired: true }, receipt, 200));
  assert.throws(() => retainPhysicalReceipt({ ...trial, request: { ...trial.request, publishedAt: undefined } }, receipt, 200));
  assert.throws(() => retainPhysicalReceipt(structuredClone(trial), receipt, 149));
  retainPhysicalReceipt(trial, receipt, 200);
  assert.throws(() => retainPhysicalReceipt(trial, receipt, 200));
  const shortcut = { ...structuredClone(trial), request: { ...trial.request, name: 'shortcut' }, receipt: undefined };
  const selected = { ...receipt, name: 'shortcut', key: 'A', control: true,
    selectionStart: 0, selectionLength: 4, bodyLength: 4 };
  assert.throws(() => retainPhysicalReceipt(shortcut, { ...selected, selectionLength: 3 }, 200));
  retainPhysicalReceipt(shortcut, selected, 200);
});

test('WPF request ledger rejects stale reuse, duplicates and late denied actions at seal', () => {
  const trial = { request: { id: 'one', name: 'return', publishedAt: 100, processIdentifier: 10, windowID: 20 },
    receipt: { keyDownAt: 150 }, sourceId: 'same-source', includeText: true, reject: false, retired: true };
  const event = { id: 1, timestamp: new Date(120).toISOString(), kind: 'keyboard.submit', sourceId: 'same-source',
    app: { processIdentifier: 10 }, window: { windowID: 20 }, contentState: 'available', contentDomains: [],
    keyboard: { target: { role: 'AXTextField' }, modifiers: [], keyEquivalent: 'return' } };
  trial.event = event;
  const next = { ...trial, request: { ...trial.request, id: 'two', publishedAt: 500 },
    receipt: { keyDownAt: 550 }, event: { ...event, id: 2, timestamp: new Date(520).toISOString() } };
  assert.equal(reconcilePhysicalActions([event, next.event], [trial, next], true).length, 2);
  assert.throws(() => reconcilePhysicalActions([event, { ...event, id: 99 }], [trial, next], true));
  assert.throws(() => reconcilePhysicalActions([event, next.event, { ...event, id: 99 }], [trial, next], true));
  assert.throws(() => reconcilePhysicalActions([event, next.event, { ...next.event, id: 3 }], [trial, next]));
  assert.throws(() => reconcilePhysicalActions([event], [trial, next], true));
  for (const delta of [
    { timestamp: new Date(99).toISOString() }, { timestamp: new Date(151).toISOString() },
    { kind: 'mouse.click' }, { sourceId: 'wrong' }, { ax: { text: 'unexpected' } },
    { keyboard: { ...event.keyboard, modifiers: ['control'] } },
  ]) {
    assert.throws(() => reconcilePhysicalActions([{ ...event, ...delta }], [trial], true));
  }
  const denied = { ...next, reject: true, event: undefined };
  reconcilePhysicalActions([event], [trial, denied], true);
  assert.throws(() => reconcilePhysicalActions([event, next.event], [trial, denied], true));
  assert.throws(() => reconcilePhysicalActions([event], [{ ...trial, retired: false }], true));
  assert.throws(() => reconcilePhysicalActions([event], [{ ...trial, receipt: undefined }], true));
  const metadata = { ...next, includeText: false, event: { ...next.event, contentState: 'metadataOnly',
    contentDomains: undefined, keyboard: { target: { role: 'AXTextField' }, modifiers: [] } } };
  reconcilePhysicalActions([metadata.event], [metadata], true);
  assert.throws(() => reconcilePhysicalActions([next.event], [metadata], true));
});

test('WPF completion and done write failures do not skip remaining cleanup', async () => {
  for (const label of ['completed', 'done']) {
    const calls = [];
    const writeError = new Error(`${label} write failed`);
    const disarmError = new Error('disarm failed');
    await assert.rejects(cleanupAll([
      () => { calls.push(label); throw writeError; },
      async () => { calls.push('disarm'); throw disarmError; },
      () => { calls.push('recorder EOF'); },
      () => { calls.push('fixture EOF'); },
      () => { calls.push('evidence close'); },
    ]), (error) => {
      assert.deepEqual(error.errors, [writeError, disarmError]);
      return true;
    });
    assert.deepEqual(calls, [label, 'disarm', 'recorder EOF', 'fixture EOF', 'evidence close']);
  }
});

test(recorderMode ? 'WPF recorder retains only admitted physical keyboard evidence' :
  'standalone WPF snapshots require useful native bodies and matched privacy controls', {
  skip: process.env.MAKA_HISTORY_WINDOWS_WPF_TEST !== '1' ? 'requires MAKA_HISTORY_WINDOWS_WPF_TEST=1' : false,
  timeout: recorderMode ? 240_000 : 180_000,
}, async (t) => {
  assert.equal(process.platform, 'win32', 'run sequentially in an unlocked Windows interactive session');
  if (recorderMode) {
    assert.equal(process.versions.node, '24.18.1', 'QPC readiness conversion is matched to Node 24.18.1');
    assert.equal(process.arch, 'x64', 'QPC readiness candidate requires matched 64-bit execution');
  }
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'use Node 24');
  assert.ok(isAbsolute(helper), 'helper must be absolute');
  if (recorderMode) {
    assert.ok(inputRequestPath && /^[a-z]:\\/i.test(inputRequestPath), 'recorder mode requires a local absolute external-driver request path');
    assert.ok(!peerDiagnostics && !selectionOnly && !visibleOnly, 'recorder mode cannot mix snapshot diagnostic selectors');
    closeSync(openSync(inputRequestPath, 'wx')); // Fresh path prevents a previous driver's done/request replay.
  }
  const parent = process.env.MAKA_HISTORY_WINDOWS_TEST_ROOT ?? tmpdir();
  assert.match(parent, /^[a-z]:\\/i, 'use an existing local NTFS directory');
  const root = await mkdtemp(join(parent, 'maka-history-wpf-'));
  const home = join(root, 'history');
  const token = randomUUID().replaceAll('-', '');
  const executable = join(root, `maka-history-wpf-${token}.exe`);
  const appId = `win32.${basename(executable, '.exe')}`;
  const fd = openSync(join(root, 'evidence.jsonl'), 'wx');
  const started = performance.now();
  const workBudget = recorderMode ? 200_000 : 120_000;
  const deadline = started + workBudget;
  const denied = `DENIED_${token}`;
  const replies = new Map();
  let fixture;
  let ready;
  let fixtureError;
  let fixtureResult;
  let closed;
  let sequence = 0;
  let output = '';
  let stderr = '';
  let recorder;
  let inputRequest;
  let recorderVerified = false;
  let numericCoveragePassed = false;
  const physicalTrials = [];
  const deniedBodies = [denied];

  function evidence(type, value = {}) {
    writeSync(fd, `${JSON.stringify({
      type, at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), ...value,
    })}\n`);
  }

  function healthy() {
    assert.ok(performance.now() < deadline, 'bounded WPF work budget exhausted');
    if (fixtureError) throw fixtureError;
    assert.equal(fixtureResult, undefined, `fixture exited: ${JSON.stringify(fixtureResult)} ${stderr}`);
    if (recorder) {
      assert.equal(recorder.result, undefined, `recorder exited: ${JSON.stringify(recorder.result)} ${recorder.stderr}`);
    }
  }

  async function until(check, label, timeout = 3_000) {
    const end = Math.min(deadline, performance.now() + timeout);
    while (performance.now() < end) {
      healthy();
      const value = await check();
      if (value) return value;
      await delay(50);
    }
    assert.fail(`Timed out waiting for ${label}`);
  }

  async function command(action, fields = {}) {
    healthy();
    const id = ++sequence;
    evidence('fixture.command', { id, action, ...fields });
    fixture.stdin.write(`${JSON.stringify({ id, action, ...fields })}\n`);
    const value = await until(() => replies.get(id), `WPF ${action}`);
    replies.delete(id);
    assert.equal(value.action, action);
    assert.equal(value.processIdentifier, ready.processIdentifier);
    assert.equal(value.windowID, ready.windowID);
    assert.deepEqual(value.foreground, { processIdentifier: ready.processIdentifier, windowID: ready.windowID });
    assert.equal(value.title, `Maka synthetic WPF ${token}`);
    if (fields.text !== undefined) assert.equal(value.text, fields.text);
    if (fields.mode !== undefined) assert.equal(value.mode, fields.mode);
    if (fields.enabled !== undefined) assert.equal(value.password, fields.enabled);
    return value;
  }

  async function invoke(args) {
    healthy();
    const begin = performance.now();
    try {
      const result = await run(helper, args, {
        env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: home },
        windowsHide: true, encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024,
      });
      evidence('native.result', { args, ...result, durationMs: performance.now() - begin });
      assert.equal(result.stderr, '');
      assert.ok(!result.stdout.includes(denied), 'denied-only password escaped in native output');
      return result.stdout;
    } catch (error) {
      evidence('native.error', {
        args, code: error.code, signal: error.signal, killed: error.killed,
        stdout: error.stdout, stderr: error.stderr, message: error.message,
        durationMs: performance.now() - begin,
      });
      throw error; // Provider errors and timeouts cannot prove privacy suppression.
    }
  }

  async function snapshot(expected) {
    const before = await command('inspect');
    assert.deepEqual(before, { ...expected, id: before.id, action: 'inspect' });
    const source = randomUUID();
    const value = JSON.parse(await invoke([
      'snapshot', '--parent-pid', String(process.pid), '--window', String(ready.windowID),
      '--pid', String(ready.processIdentifier), '--source', source,
    ]));
    const after = await command('inspect');
    assert.deepEqual(after, { ...before, id: after.id });
    if (peerDiagnostics) {
      const diagnostic = await command('inspect', { peers: true });
      assert.equal(diagnostic.metadataOnly, true);
      assert.equal(Object.hasOwn(diagnostic, 'text'), false);
      assert.equal(diagnostic.editorInstance, expected.editorInstance);
      assert.equal(diagnostic.peers.source, 'owned-wpf-peers');
      assert.ok(diagnostic.peers.nodes.length > 0 && diagnostic.peers.nodes.length <= 64);
      assert.ok(!JSON.stringify(diagnostic).includes(denied));
      evidence('fixture.peer-diagnostic', { diagnostic });
      t.diagnostic(`${expected.mode}: peer nodes=${diagnostic.peers.nodes.length}, truncated=${diagnostic.peers.truncated}`);
    }
    if (value !== null) {
      assert.equal(value.pid, ready.processIdentifier);
      assert.equal(value.windowId, ready.windowID);
      assert.equal(value.appId, appId);
      assert.equal(value.title, expected.title);
      assert.equal(value.sourceId, source);
      assert.equal(value.sourceKnown, true);
      assert.equal(value.private, false);
      assert.equal(value.secure, false);
      assert.deepEqual(value.domains, []);
      assert.equal(value.url, null);
    }
    return value;
  }

  function useful(value, text) {
    assert.ok(value, 'allowed WPF control suppressed: native family coverage is unsupported in this run');
    assert.ok(value.text?.replaceAll('\r\n', '\n').includes(text), 'native must capture the actual WPF body, not a title/name substitute');
    assert.ok(!value.title.includes(text), 'body marker must be absent from the window title');
    assert.ok(Buffer.byteLength(value.text) <= 32 * 1024, 'native text budget exceeded');
  }

  async function policy({ captureText = true, blocked = false } = {}) {
    const value = {
      captureText, showMenuBarIcon: false,
      observation: {
        defaultApplicationBehavior: 'do_not_observe', defaultURLBehavior: 'do_not_observe',
        allowlist: [{ scope: 'application', bundleID: appId }],
        blocklist: blocked ? [{ scope: 'application', bundleID: appId }] : [],
      },
    };
    const temporary = join(home, `config-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' });
    await rename(temporary, join(home, 'config.json'));
    evidence('policy', value);
  }

  function track(child, label) {
    const state = { child, stdout: '', stderr: '', result: undefined };
    child.stdout.setEncoding('utf8').on('data', (data) => { state.stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data) => { state.stderr += data; });
    child.stdin.on('error', (error) => { fixtureError = error; });
    state.closed = new Promise((resolve) => {
      child.once('error', (error) => { fixtureError = error; });
      child.once('exit', (code, signal) => { state.result = { code, signal }; });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    evidence('process.started', { label, processIdentifier: child.pid });
    return state;
  }

  async function closeOwned(state, label) {
    state.child.stdin.end();
    let timer;
    try {
      const result = await Promise.race([
        state.closed, new Promise((resolve) => { timer = setTimeout(() => resolve(null), 3_000); }),
      ]);
      if (result === null) {
        state.child.kill('SIGKILL');
        clearTimeout(timer);
        await Promise.race([
          state.closed, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} pipes did not close after termination`)), 2_000);
          }),
        ]);
        throw new Error(`${label} required forced termination`);
      }
      assert.deepEqual(result, { code: 0, signal: null });
      assert.equal(state.stderr, '', `${label} stderr`);
      return result;
    } finally {
      clearTimeout(timer);
      evidence('process.output', { label, stdout: state.stdout, stderr: state.stderr, result: state.result });
    }
  }

  async function json(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async function records(sealed = false) {
    let names;
    try { names = await readdir(join(home, 'segments')); }
    catch (error) {
      if (error.code === 'ENOENT' && !sealed) return [];
      throw error;
    }
    const segments = [];
    for (const name of names) {
      const directory = join(home, 'segments', name);
      const metadata = await json(join(directory, 'metadata.json'));
      if (!metadata) {
        assert.ok(!sealed, 'sealed segment metadata missing');
        continue;
      }
      segments.push({ directory, metadata });
    }
    segments.sort((a, b) => Date.parse(a.metadata.startedAt) - Date.parse(b.metadata.startedAt) ||
      a.directory.localeCompare(b.directory));
    const events = [];
    for (const { directory, metadata } of segments) {
      let contents;
      try { contents = await readFile(join(directory, 'events.jsonl'), 'utf8'); }
      catch (error) {
        if (error.code === 'ENOENT' && !sealed) continue;
        throw error;
      }
      if (sealed) assert.ok(!contents || contents.endsWith('\n'), 'sealed JSONL has a partial tail');
      const lines = contents.split('\n');
      lines.pop(); // An active writer may not have completed its last line.
      const values = lines.map((line) => JSON.parse(line));
      assert.equal(new Set(values.map((event) => event.id)).size, values.length);
      if (sealed) {
        assert.equal(metadata?.eventCount, values.length);
        assert.equal(metadata.endReason, 'finished');
        assert.ok(Number.isFinite(Date.parse(metadata.endedAt)));
        evidence('native.segment', { directory, metadata, events: values });
      }
      events.push(...values);
    }
    for (const event of events) {
      assert.ok(Number.isSafeInteger(event.id) && event.id > 0);
      assert.ok(Number.isFinite(Date.parse(event.timestamp)));
      assert.equal(event.app?.bundleIdentifier, appId, 'foreign application persisted');
      assert.equal(event.app?.processIdentifier, ready.processIdentifier);
      assert.equal(event.window?.windowID, ready.windowID);
      assert.match(event.sourceId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
      const serialized = JSON.stringify(event);
      assert.doesNotMatch(serialized, /"(?:runtimeId|documentRuntimeId|inputTarget|uia)"/u);
      for (const marker of deniedBodies) assert.ok(!serialized.includes(marker), 'denied-only body persisted');
    }
    return events;
  }

  async function running(state = 'running') {
    return until(async () => {
      const value = await json(join(home, 'runtime.json'));
      if (value?.state !== state) return false;
      assert.equal(value.processIdentifier, recorder.child.pid);
      assert.equal(value.captureFailures, 0, 'provider failures cannot prove suppression');
      assert.ok(!value.lastError && !value.captureError, 'recorder health error');
      return value;
    }, `healthy ${state} recorder`, 9_000);
  }

  async function suppressionCount() {
    let names;
    try { names = await readdir(join(home, 'segments')); }
    catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
    let count = 0;
    for (const name of names) {
      const metadata = await json(join(home, 'segments', name, 'metadata.json'));
      count += metadata?.suppressedEventCount ?? 0;
    }
    return count;
  }

  async function body(marker, since = 0, includeText = true) {
    const event = await until(async () => (await records()).slice(since).find((event) =>
      includeText ? event.ax?.text?.includes(marker) : event.contentState === 'metadataOnly'),
    includeText ? 'recorder useful body' : 'recorder metadata', 9_000);
    if (includeText) {
      assert.equal(event.contentState, 'available');
      assert.equal(event.ax.mode, 'fullTree');
      assert.deepEqual(event.contentDomains, []);
      assert.ok(!event.window.title.includes(marker));
    } else {
      assert.equal(event.ax, undefined);
      assert.equal(event.contentDomains, undefined);
      assert.equal(event.selection?.selectedText, undefined);
    }
    evidence('assertion.pass', { assertion: includeText ? 'recorder-body' : 'recorder-metadata', event });
    return event;
  }

  async function identity(field) {
    const reply = await command('identity');
    const value = reply.identity;
    assert.equal(value.field, field);
    assert.equal(value.automationId, `synthetic-editor-${field}`);
    assert.equal(value.framework, 'WPF');
    assert.equal(value.processIdentifier, ready.processIdentifier);
    assert.equal(value.windowID, ready.windowID);
    assert.equal(value.inputWindowID, ready.windowID);
    for (const id of [value.runtimeId, value.rootRuntimeId]) {
      assert.ok(Array.isArray(id) && id.length > 0 && id.length <= 32 && id.every(Number.isInteger));
    }
    return value;
  }

  async function leaseIdentity(expected) {
    // This proves the worker's exact field identity, separately from recorder JSONL.
    const source = randomUUID();
    const lease = track(spawn(helper, [
      'snapshot-lease', '--parent-pid', String(process.pid), '--window', String(ready.windowID),
      '--pid', String(ready.processIdentifier), '--source', source,
    ], {
      env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: home },
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    }), 'identity-lease');
    let frame;
    let error;
    const lines = createInterface({ input: lease.child.stdout });
    lines.on('line', (line) => {
      try {
        const value = JSON.parse(line);
        evidence('identity-lease.frame', { value });
        if (value.type === 'snapshot') frame = value;
      } catch (caught) { error = caught; }
    });
    try {
      const value = await until(() => {
        if (error) throw error;
        assert.equal(lease.result, undefined, `identity lease exited: ${lease.stderr}`);
        return frame;
      }, 'standalone exact UIA lease identity', 3_000);
      assert.equal(value.request, 0);
      const target = value.snapshot?.inputTarget;
      assert.equal(value.snapshot?.sourceId, source);
      assert.equal(target?.hwnd, ready.windowID);
      assert.equal(target.role, 'AXTextField');
      assert.deepEqual(target.uia?.runtimeId, expected.runtimeId);
      assert.deepEqual(target.uia?.documentRuntimeId, expected.rootRuntimeId);
      assert.deepEqual(await identity(expected.field), expected);
      evidence('assertion.pass', { assertion: 'standalone-lease-field-identity-only', expected });
    } finally {
      try { await closeOwned(lease, 'identity-lease'); }
      finally { lines.close(); }
    }
  }

  async function physical(name, witness, {
    reject = false, switchTo, includeText = true, paused = false, password = false, sourceId, holdMs = 0,
  } = {}) {
    if (holdMs) {
      const begin = performance.now();
      while (performance.now() - begin < holdMs) {
        await command('inspect');
        await delay(100);
      }
      assert.deepEqual(await identity(witness.field), witness);
      evidence('input.preparation-hold', { elapsedMs: performance.now() - begin, witness });
    }
    const since = (await records()).length;
    const beforeSuppression = password ? await suppressionCount() : undefined;
    const request = {
      id: randomUUID(), name, deadline: Date.now() + 12_000,
      processIdentifier: ready.processIdentifier, windowID: ready.windowID,
      inputWindowID: ready.windowID, field: witness.field,
      runtimeId: witness.runtimeId, rootRuntimeId: witness.rootRuntimeId,
    };
    assert.ok(reject || sourceId, 'accepted physical request needs its observed body source');
    const trial = { request, reject, switchTo, includeText, password, sourceId, retired: false };
    physicalTrials.push(trial);
    let failure;
    try {
      await command('arm', {
        requestId: request.id, name, field: witness.field, ...(switchTo ? { switchTo } : {}),
      });
      inputRequest = request;
      evidence('driver.request', { request, reject, switchTo, includeText, paused });
      const receipt = await until(() => trial.receipt, `physical ${name} receipt`, 12_000);
      inputRequest = undefined;
      writeFileSync(inputRequestPath, JSON.stringify({ id: request.id, completed: true, deadline: request.deadline }));
      const isKeyboard = (event) => event.kind === 'keyboard.submit' || event.kind === 'keyboard.shortcut';
      if (reject) {
        const end = performance.now() + 6_000;
        let suppressions = beforeSuppression;
        while (performance.now() < end) {
          healthy();
          const current = await records();
          reconcilePhysicalActions(current, physicalTrials);
          const additional = current.slice(since);
          assert.ok(!additional.some(isKeyboard), 'revoked physical key persisted');
          if (password || paused) assert.equal(additional.length, 0, 'denied context persisted');
          await running(paused ? 'paused' : 'running');
          if (password) suppressions = await suppressionCount();
          await delay(100);
        }
        if (password) assert.ok(suppressions > beforeSuppression, 'password suppression did not show native work');
      } else {
        const action = await until(async () => {
          await running();
          return reconcilePhysicalActions(await records(), physicalTrials).at(-1)[0];
        },
          `recorder physical ${name}`, 9_000);
        trial.event = action;
        evidence('recorder.action', { request, receipt, action });
      }
      evidence('assertion.pass', { assertion: reject ? 'physical-key-rejected' : 'physical-key-retained', request, receipt });
      return receipt;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      inputRequest = undefined;
      trial.retired = true;
      try {
        await cleanupAll([
          () => writeFileSync(inputRequestPath, JSON.stringify({ id: request.id, completed: true, deadline: request.deadline })),
          async () => { if (!fixtureError && fixtureResult === undefined) await command('disarm'); },
        ]);
      } catch (error) {
        if (failure) throw new AggregateError([failure, error], `${failure.message}; physical cleanup failed`);
        throw error;
      }
    }
  }

  async function recorderAcceptance() {
    await command('show', { mode: 'fields', text: `PLAIN_${token}` });
    await invoke(['pause']);
    recorder = track(spawn(helper, ['record', '--no-prompt', '--parent-pid', String(process.pid)], {
      env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: home },
      windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    }), 'recorder');
    await running('paused');
    assert.equal((await records()).length, 0);
    assert.equal(JSON.parse(await invoke(['status'])).recorderActive, true);
    await invoke(['resume']);
    await running();
    const first = await body(`PLAIN_${token}`);
    const one = await identity('one');
    await leaseIdentity(one);
    await physical('return', one, { sourceId: first.sourceId });
    await physical('shortcut', one, { sourceId: first.sourceId });
    await physical('return', one, { sourceId: first.sourceId, holdMs: 3_500 });

    await physical('return', one, { reject: true, switchTo: 'two' });
    const two = await identity('two');
    assert.notDeepEqual(two.runtimeId, one.runtimeId, 'same-host fields must have different UIA identities');
    assert.deepEqual(two.rootRuntimeId, one.rootRuntimeId);
    let since = (await records()).length;
    await command('edit', { text: `SECOND_${token}` });
    const second = await body(`SECOND_${token}`, since);
    await leaseIdentity(two);
    await physical('return', two, { sourceId: second.sourceId });
    await physical('shortcut', two, { sourceId: second.sourceId });
    evidence('recorder.source-transition', { first: first.sourceId, second: second.sourceId, one, two });

    since = (await records()).length;
    await command('edit', { text: `CHANGED_${token}` });
    const changed = await body(`CHANGED_${token}`, since);
    assert.deepEqual(await identity('two'), two, 'body edit changed field identity');
    await physical('return', two, { sourceId: changed.sourceId });

    const blockedBody = `PASSWORD_STATE_BODY_${token}`;
    deniedBodies.push(blockedBody);
    const secret = await command('password', { enabled: true, secret: denied, text: blockedBody });
    assert.equal(await snapshot(secret), null, 'matched password state must actually reject native capture');
    await physical('return', two, { reject: true, password: true });
    since = (await records()).length;
    await command('password', { enabled: false, text: `RECOVERED_${token}` });
    const recovered = await body(`RECOVERED_${token}`, since);
    assert.deepEqual(await identity('two'), two);
    await physical('return', two, { sourceId: recovered.sourceId });

    await invoke(['pause']);
    await running('paused');
    await physical('return', two, { reject: true, paused: true });
    const offBody = `TEXT_OFF_ONLY_${token}`;
    deniedBodies.push(offBody);
    await policy({ captureText: false });
    await command('edit', { text: offBody });
    since = (await records()).length;
    await invoke(['resume']);
    await running();
    const metadataBody = await body('', since, false);
    await physical('return', two, { includeText: false, sourceId: metadataBody.sourceId });
    const selectionSince = (await records()).length;
    const selectedReceipt = await physical('shortcut', two, { includeText: false, sourceId: metadataBody.sourceId });
    await t.test('coverage: metadata-only WPF numeric selection from physical Ctrl+A', {
      todo: 'Known gap: text-off WPF exact UTF-16 selection is not implemented; no safe text-free API established',
    }, async () => {
      try {
        const numericSelection = await until(async () => (await records()).slice(selectionSince).find((event) =>
          event.selection?.selectedRange?.location === selectedReceipt.selectionStart &&
          event.selection.selectedRange.length === selectedReceipt.selectionLength),
        'recorder numeric WPF selection matching physical Ctrl+A', 9_000);
        assert.equal(numericSelection.contentState, 'metadataOnly');
        assert.equal(numericSelection.selection.selectedText, undefined);
        assert.equal(numericSelection.ax, undefined);
        assert.equal(numericSelection.contentDomains, undefined);
        evidence('case.passed', {
          name: 'recorder-metadata-numeric-selection', numericSelection,
          fixtureSelection: { location: selectedReceipt.selectionStart, length: selectedReceipt.selectionLength },
        });
        numericCoveragePassed = true;
      } catch (error) {
        evidence('case.failed', { name: 'recorder-metadata-numeric-selection', message: error.message });
        throw error;
      }
    });
    const metadata = (await records()).slice(since);
    for (const event of metadata) {
      assert.equal(event.contentState, 'metadataOnly');
      assert.equal(event.selection?.selectedText, undefined);
      assert.equal(event.ax, undefined);
      assert.equal(event.contentDomains, undefined);
      if (event.selection?.selectedRange) {
        assert.ok(Number.isSafeInteger(event.selection.selectedRange.location));
        assert.ok(event.selection.selectedRange.location >= 0);
        assert.ok(Number.isSafeInteger(event.selection.selectedRange.length));
        assert.ok(event.selection.selectedRange.length >= 0);
      }
    }
    evidence('assertion.pass', {
      assertion: 'recorder-metadata-only-actions', events: metadata,
    });

    // Remove text-off-only content before permitting text again.
    await invoke(['pause']);
    await running('paused');
    await command('edit', { text: `MODE_RECOVERED_${token}` });
    await policy();
    since = (await records()).length;
    await invoke(['resume']);
    await running();
    const modeRecovered = await body(`MODE_RECOVERED_${token}`, since);
    await physical('return', two, { sourceId: modeRecovered.sourceId });
    const active = recorder;
    recorder = undefined;
    await closeOwned(active, 'recorder');
    assert.equal(active.stdout, '');
    const runtime = await json(join(home, 'runtime.json'));
    assert.equal(runtime.state, 'stopped');
    assert.equal(runtime.captureFailures, 0);
    assert.ok(!runtime.lastError);
    assert.ok(Number.isFinite(Date.parse(runtime.endedAt)));
    assert.equal(JSON.parse(await invoke(['status'])).recorderActive, false);
    const sealed = await records(true);
    assert.ok(sealed.length > 0);
    reconcilePhysicalActions(sealed, physicalTrials, true);
    evidence('recorder.actions-reconciled', {
      requests: physicalTrials.map(({ request, reject, event }) => ({
        id: request.id, reject, eventId: event?.id, publishedAt: request.publishedAt,
      })),
    });
    evidence('recorder.acceptance', {
      events: sealed.length, runtime, sealed: true, recorderCleanupVerified: true,
      keyPrivacyLifecyclePassed: true, numericCoveragePassed,
    });
    recorderVerified = true;
  }

  async function scenario(name, action) {
    if (selectionOnly && !name.startsWith('nonselectable')) return;
    if (visibleOnly && !name.startsWith('scrolled')) return;
    await t.test(name, async () => {
      evidence('case.started', { name });
      try {
        await policy();
        await action();
        evidence('case.passed', { name });
      } catch (error) {
        evidence('case.failed', { name, message: error.message, stack: error.stack });
        throw error;
      }
    });
  }

  const safety = setTimeout(() => { recorder?.child.stdin.end(); fixture?.stdin.end(); }, workBudget + 3_000);
  t.after(async () => {
    const errors = [];
    try {
      inputRequest = undefined;
      if (recorderMode) {
        try { writeFileSync(inputRequestPath, JSON.stringify({ done: true })); }
        catch (error) { errors.push(error); }
      }
      if (recorder) {
        const active = recorder;
        recorder = undefined;
        try { await closeOwned(active, 'recorder-cleanup'); }
        catch (error) { errors.push(error); }
      }
      if (fixture) {
        let timer;
        try {
          fixture.stdin.end();
          const result = await Promise.race([
            closed, new Promise((resolve) => { timer = setTimeout(() => resolve(null), 3_000); }),
          ]);
          if (result === null) {
            fixture.kill('SIGKILL'); // Exact owned ChildProcess only, never executable-name termination.
            throw new Error('WPF fixture required forced termination after EOF');
          }
          assert.deepEqual(result, { code: 0, signal: null });
          assert.equal(stderr, '');
        } catch (error) {
          errors.push(error);
        } finally {
          clearTimeout(timer);
          if (fixtureResult === undefined) fixture.kill('SIGKILL');
          let closeTimer;
          try {
            await Promise.race([
              closed, new Promise((_, reject) => {
                closeTimer = setTimeout(() => reject(new Error('WPF fixture pipes did not close')), 2_000);
              }),
            ]);
          } catch (error) { errors.push(error); }
          finally { clearTimeout(closeTimer); }
        }
      }
      const files = await readdir(home);
      if (!recorderMode) {
        assert.deepEqual(files.sort(), ['config.json', 'control.json', 'maka-settings.json']);
        evidence('snapshot-only.no-files', { files });
      } else {
        evidence('recorder.files', { files, recorderVerified, numericCoveragePassed });
      }
    } finally {
      clearTimeout(safety);
      await cleanupAll([
        () => evidence('fixture.output', { stdout: output, stderr }),
        () => evidence('suite.finished', { root, cleanupErrors: errors.map((error) => error.message) }),
        () => closeSync(fd),
        () => t.diagnostic(`Synthetic WPF evidence retained at ${root}`),
        () => { if (errors.length) throw new AggregateError(errors, 'WPF cleanup failed'); },
      ]);
    }
  });

  evidence('suite.started', { root, helper, executable, appId, node: process.version, peerDiagnostics, recorderMode });
  if (peerDiagnostics) t.diagnostic('Diagnostic run: own-peer inspection follows native snapshots and may initialize peers for subsequent calls.');
  t.diagnostic(`Evidence: ${join(root, 'evidence.jsonl')}`);
  await mkdir(home);
  await writeFile(join(home, 'maka-settings.json'), '{"enabled":true}\n', { flag: 'wx' });
  await writeFile(join(home, 'control.json'), '{"state":"running","revision":"wpf-canary"}\n', { flag: 'wx' });
  await policy();
  assert.equal((await invoke(['validate-home'])).trim(), 'history-home-valid');
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let built;
  try {
    built = await run(powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixtureSource,
      '-OutputAssembly', executable, '-TestOnly',
    ], { windowsHide: true, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
    evidence('fixture.build', built);
  } catch (error) {
    evidence('fixture.build-error', {
      code: error.code, stdout: error.stdout, stderr: error.stderr, message: error.message,
    });
    throw error;
  }
  assert.equal(built.stdout.trim(), 'synthetic-wpf-fixture-built');
  assert.equal(built.stderr, '');
  fixture = spawn(executable, [String(process.pid), token], { stdio: ['pipe', 'pipe', 'pipe'] });
  fixture.stdin.on('error', (error) => { fixtureError = error; });
  fixture.stdout.setEncoding('utf8').on('data', (data) => { output += data; });
  fixture.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
  closed = new Promise((resolve) => {
    fixture.once('error', (error) => { fixtureError = error; });
    fixture.once('exit', (code, signal) => { fixtureResult = { code, signal }; });
    fixture.once('close', (code, signal) => resolve({ code, signal }));
  });
  const lines = createInterface({ input: fixture.stdout });
  lines.on('line', (line) => {
    try {
      const value = JSON.parse(line);
      evidence('fixture.message', { value });
      if (value.type === 'error') throw new Error(value.message);
      if (value.type === 'ready') ready = value;
      if (value.type === 'ack') replies.set(value.id, value);
      if (value.type === 'input.ready' || value.type === 'input.received') {
        assert.equal(value.foreground?.processIdentifier, ready.processIdentifier);
        assert.equal(value.foreground?.windowID, ready.windowID);
        assert.equal(value.inputWindowID, ready.windowID);
        if (value.type === 'input.received') {
          assert.equal(inputRequest?.id, value.requestId, 'receipt outside the active physical request');
          retainPhysicalReceipt(physicalTrials.at(-1), value);
        }
        if (value.type === 'input.ready' && inputRequest && value.requestId === inputRequest.id) {
          publishInputReady(inputRequest, value, inputRequestPath);
        }
      }
    } catch (error) { fixtureError = error; }
  });
  await until(() => ready, 'WPF startup', 5_000);
  assert.equal(ready.processIdentifier, fixture.pid);
  assert.ok(Number.isSafeInteger(ready.windowID) && ready.windowID > 0);
  t.diagnostic(`Fixture session=${ready.sessionId}, enabled administrator=${ready.administrator}`);
  if (recorderMode) {
    try { await recorderAcceptance(); }
    catch (error) {
      evidence('case.failed', { name: 'recorder-key-privacy-lifecycle', message: error.message, stack: error.stack });
      throw error;
    }
    return;
  }

  await scenario('scrolled native documents capture visible tail and recover the top across UTF-16 text', async () => {
    for (const mode of ['richtextbox', 'textbox']) {
      const top = `TOP_${token}`;
      const tail = `TAIL_${token}_\u4e2d\u6587_\ud83d\udcbb`;
      const body = `${top}\n${'Mixed \u4e2d\u6587 \ud83d\udcbb 0123456789\n'.repeat(1500)}${tail}`;
      assert.ok(Buffer.byteLength(body.slice(0, body.indexOf(tail))) > 32 * 1024);
      await command('show', { mode, text: body });
      const first = await command('scroll', { position: 'home', witness: top });
      assert.equal(first.scroll.visible, true);
      assert.equal(first.scroll.offset, 0);
      let value = await snapshot(first);
      useful(value, top);
      assert.ok(!value.text.includes(tail), 'offscreen tail must not enter the top viewport');
      const end = await command('scroll', { position: 'end', witness: tail });
      assert.equal(end.editorInstance, first.editorInstance);
      assert.equal(end.scroll.visible, true, 'fixture must prove the tail is on screen');
      assert.ok(end.scroll.offset > end.scroll.viewport);
      value = await snapshot(end);
      useful(value, tail);
      assert.equal(value.textTruncated, true, 'viewport samples are partial document evidence');
      assert.ok(!value.text.includes(top), 'offscreen document prefix must not replace the visible tail');
      assert.ok(!value.text.includes('\ufffd'), 'UTF-16 boundaries must not split a surrogate pair');
      const restored = await command('scroll', { position: 'home', witness: top });
      assert.equal(restored.scroll.visible, true);
      value = await snapshot(restored);
      useful(value, top);
      assert.ok(!value.text.includes(tail), 'prior viewport text survived a scroll transition');
    }
  });
  await scenario('nonselectable controls retain body when optional selection is absent or unsupported', async () => {
    for (const mode of ['button', 'unsupported-selection']) {
      const body = `NONSELECTABLE_${token}_${mode}`;
      const first = await command('show', { mode, text: body });
      const value = await snapshot(first);
      useful(value, body);
      assert.equal(value.selection, null, 'unsupported selection must not manufacture a range');
      const edited = await command('edit', { text: `UPDATED_${body}` });
      useful(await snapshot(edited), edited.text);
      const probe = await command('inspect', { selectionProbe: true });
      assert.equal(probe.selectionCalls > 0, mode === 'unsupported-selection',
        'prove the synthetic provider was queried; do not pass by skipping optional selection');
    }
  });
  for (const mode of ['textbox', 'richtextbox']) {
    await scenario(`${mode} exposes body-only text and in-place edits`, async () => {
      const body = `BODY_${token}_${mode}`;
      const first = await command('show', { mode, text: body });
      useful(await snapshot(first), body);
      const edited = `EDIT_${token}_${mode}\n\u4e2d\u6587\u7b14\u8bb0 \ud83d\udcbb`;
      const next = await command('edit', { text: edited });
      assert.equal(next.editorInstance, first.editorInstance);
      const value = await snapshot(next);
      useful(value, edited);
      assert.ok(!value.text.includes(body), 'old document body survived an in-place edit');
    });
  }
  await scenario('visible PasswordBox suppresses matched body and removal recovers', async () => {
    const body = `MATCHED_${token}`;
    const first = await command('show', { mode: 'textbox', text: body });
    useful(await snapshot(first), body);
    const secret = await command('password', { enabled: true, secret: denied });
    assert.equal(secret.editorInstance, first.editorInstance);
    assert.equal(secret.text, body, 'password addition must not replace the allowed body');
    assert.equal(secret.passwordLength, denied.length);
    assert.equal(await snapshot(secret), null, 'password must suppress the whole snapshot, including its title');
    const recovered = await command('password', { enabled: false, text: `RECOVERED_${token}` });
    assert.equal(recovered.editorInstance, first.editorInstance);
    assert.equal(recovered.passwordLength, 0);
    useful(await snapshot(recovered), recovered.text);
  });
  await scenario('text-off retains admitted metadata and text-on recovers', async () => {
    const first = await command('show', { mode: 'textbox', text: `TEXT_POLICY_${token}` });
    useful(await snapshot(first), first.text);
    await policy({ captureText: false });
    const value = await snapshot(first);
    assert.ok(value, 'text-off must retain admitted WPF metadata');
    assert.ok(!value.text, 'text-off retained a body');
    await policy();
    useful(await snapshot(first), first.text);
  });
  await scenario('application exclusion overrides allowlist and removal recovers', async () => {
    const first = await command('show', { mode: 'textbox', text: `APP_POLICY_${token}` });
    useful(await snapshot(first), first.text);
    await policy({ blocked: true });
    assert.equal(await snapshot(first), null);
    await policy();
    useful(await snapshot(first), first.text);
  });
});
