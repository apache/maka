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
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
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

test('standalone WPF snapshots require useful native bodies and matched privacy controls', {
  skip: process.env.MAKA_HISTORY_WINDOWS_WPF_TEST !== '1' ? 'requires MAKA_HISTORY_WINDOWS_WPF_TEST=1' : false,
  timeout: 180_000,
}, async (t) => {
  assert.equal(process.platform, 'win32', 'run sequentially in an unlocked Windows interactive session');
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'use Node 24');
  assert.ok(isAbsolute(helper), 'helper must be absolute');
  const parent = process.env.MAKA_HISTORY_WINDOWS_TEST_ROOT ?? tmpdir();
  assert.match(parent, /^[a-z]:\\/i, 'use an existing local NTFS directory');
  const root = await mkdtemp(join(parent, 'maka-history-wpf-'));
  const home = join(root, 'history');
  const token = randomUUID().replaceAll('-', '');
  const executable = join(root, `maka-history-wpf-${token}.exe`);
  const appId = `win32.${basename(executable, '.exe')}`;
  const fd = openSync(join(root, 'evidence.jsonl'), 'wx');
  const started = performance.now();
  const deadline = started + 120_000;
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

  function evidence(type, value = {}) {
    writeSync(fd, `${JSON.stringify({
      type, at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), ...value,
    })}\n`);
  }

  function healthy() {
    assert.ok(performance.now() < deadline, '120-second WPF work budget exhausted');
    if (fixtureError) throw fixtureError;
    assert.equal(fixtureResult, undefined, `fixture exited: ${JSON.stringify(fixtureResult)} ${stderr}`);
  }

  async function until(check, label, timeout = 3_000) {
    const end = Math.min(deadline, performance.now() + timeout);
    while (performance.now() < end) {
      healthy();
      const value = check();
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
    await writeFile(join(home, 'config.json'), `${JSON.stringify(value)}\n`);
    evidence('policy', value);
  }

  async function scenario(name, action) {
    if (selectionOnly && !name.startsWith('nonselectable')) return;
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

  const safety = setTimeout(() => fixture?.stdin.end(), 123_000);
  t.after(async () => {
    const errors = [];
    try {
      if (fixture) {
        fixture.stdin.end();
        let timer;
        try {
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
      assert.deepEqual(files.sort(), ['config.json', 'control.json', 'maka-settings.json']);
      evidence('snapshot-only.no-files', { files });
    } finally {
      clearTimeout(safety);
      evidence('fixture.output', { stdout: output, stderr });
      evidence('suite.finished', { root, cleanupErrors: errors.map((error) => error.message) });
      closeSync(fd);
      t.diagnostic(`Synthetic WPF evidence retained at ${root}`);
    }
    if (errors.length) throw new AggregateError(errors, 'WPF cleanup failed');
  });

  evidence('suite.started', { root, helper, executable, appId, node: process.version, peerDiagnostics });
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
    } catch (error) { fixtureError = error; }
  });
  await until(() => ready, 'WPF startup', 5_000);
  assert.equal(ready.processIdentifier, fixture.pid);
  assert.ok(Number.isSafeInteger(ready.windowID) && ready.windowID > 0);
  t.diagnostic(`Fixture session=${ready.sessionId}, enabled administrator=${ready.administrator}`);

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
