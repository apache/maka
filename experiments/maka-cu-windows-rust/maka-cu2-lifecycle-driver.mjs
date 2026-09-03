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

// Live maka.cu/2 lifecycle/conformance driver. It intentionally owns only the
// deterministic WinForms fixture; it never resolves or acts on a user app.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [helperExe, fixtureExe] = process.argv.slice(2);
if (!helperExe || !fixtureExe) {
  console.error('usage: node maka-cu2-lifecycle-driver.mjs <helper.exe> <fixture.exe>');
  process.exit(2);
}

const report = [];
let failures = 0;
function check(name, condition, note = '') {
  const result = condition ? 'PASS' : 'FAIL';
  report.push({ name, result, ...(note ? { note } : {}) });
  if (!condition) failures += 1;
  console.log(`${result} ${name}${note ? ` — ${note}` : ''}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rpc(exe, args = []) {
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  let nextId = 1;
  let closed = false;
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
      waiter.resolve(message);
    }
  });
  child.once('exit', (code, signal) => {
    closed = true;
    for (const waiter of pending.values())
      waiter.reject(new Error(`child exited code=${code} signal=${signal ?? 'none'}`));
    pending.clear();
  });
  function call(method, params = {}, timeoutMs = 20_000) {
    if (closed || child.stdin.destroyed) return Promise.reject(new Error('child stdin is closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      const waiter = pending.get(id);
      if (waiter) {
        const resolve0 = waiter.resolve;
        const reject0 = waiter.reject;
        waiter.resolve = (value) => {
          clearTimeout(timer);
          resolve0(value);
        };
        waiter.reject = (error) => {
          clearTimeout(timer);
          reject0(error);
        };
      }
    });
  }
  return { child, call };
}

function fixtureProcess(exe) {
  const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout });
  let identity;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture READY timeout')), 10_000);
    lines.on('line', (line) => {
      const match = /^READY (\d+) (\d+)$/.exec(line);
      if (!match || identity) return;
      clearTimeout(timer);
      identity = { pid: Number(match[1]), hwnd: Number(match[2]) };
      resolve(identity);
    });
    child.once('exit', (code) => reject(new Error(`fixture exited before READY (${code})`)));
  });
  const command = (value) => {
    child.stdin.write(`${value}\n`);
    if (value === 'shutdown') child.stdin.end();
  };
  return { child, ready, command, identity: () => identity };
}

async function closeChild(child) {
  if (!child || child.exitCode !== null) return;
  child.stdin?.end();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), wait(2_500)]);
  if (child.exitCode === null) child.kill();
}

const imageDir = await mkdtemp(join(tmpdir(), 'maka-cu2-images-'));
const helper = rpc(helperExe, ['host']);
const fixture = fixtureProcess(fixtureExe);
let session = `cu2-${process.pid}-${Date.now()}`;
let oldSnapshot;
let oldTarget;

try {
  const identity = await fixture.ready;
  const hello = await helper.call('host.hello', {
    protocol: 'maka.cu/2',
    host: { name: 'maka-cu2-driver', version: 'test' },
    hostPid: process.pid,
    imageDir,
    allowGlobalPointer: false,
  });
  check('host.hello protocol', hello.result?.protocol === 'maka.cu/2');
  check(
    'host.hello fails closed for global pointer',
    hello.result?.capabilities?.pointActions?.length === 0,
  );
  check(
    'host.hello advertises semantic element actions',
    hello.result?.capabilities?.elementActions?.includes('set_value') === true,
  );
  check(
    'host.hello declares a native release identity',
    hello.result?.executor?.name === 'maka-cu-windows-rust' &&
      typeof hello.result?.pid === 'number',
  );

  const begin = await helper.call('session.begin', { session, captureScope: 'window' });
  check('session.begin', begin.result?.ok === true && begin.result.session === session);
  const duplicateBegin = await helper.call('session.begin', { session, captureScope: 'window' });
  check('duplicate session.begin is rejected', duplicateBegin.error?.code === -32602);

  const windows = await helper.call('window.list', { session });
  const listed = windows.result?.windows ?? [];
  oldTarget = listed.find((item) => item.pid === identity.pid && item.windowId === identity.hwnd);
  check('window.list re-enumerates exact fixture PID/HWND', Boolean(oldTarget));
  check(
    'window.list preserves the fresh window title',
    typeof oldTarget?.title === 'string' && oldTarget.title.length > 0,
  );
  check(
    'window.list carries app identity and bounds',
    typeof oldTarget?.appId === 'string' &&
      oldTarget?.bounds?.width > 0 &&
      oldTarget?.bounds?.height > 0,
  );
  check(
    'window.list is front-to-back without zIndex ties',
    listed.every((item, index) => index === 0 || item.zIndex < listed[index - 1].zIndex),
  );

  const apps = await helper.call('apps.list', { session });
  check(
    'apps.list joins the fixture PID to the same appId',
    (apps.result?.apps ?? []).some(
      (item) => item.pid === identity.pid && item.appId === oldTarget?.appId,
    ),
  );

  const observed = await helper.call('observe', {
    session,
    target: { kind: 'window', pid: identity.pid, windowId: identity.hwnd },
    includeImage: true,
  });
  const snapshot = observed.result?.snapshot;
  oldSnapshot = snapshot;
  check(
    'observe returns a bound snapshot',
    observed.result?.ok === true &&
      snapshot?.target?.pid === identity.pid &&
      snapshot?.target?.windowId === identity.hwnd,
  );
  check(
    'observe carries process start time and window generation',
    snapshot?.target?.title === oldTarget?.title &&
      typeof snapshot?.target?.processStartTimeUtc === 'string' &&
      snapshot.target.processStartTimeUtc.startsWith('filetime:') &&
      typeof snapshot?.target?.windowGeneration === 'string' &&
      snapshot.target.windowGeneration.length > 0,
  );
  check('observe carries a bound target digest', snapshot?.windowDigest?.startsWith('sha256:'));
  check(
    'observe uses normalized semantic action names',
    (snapshot?.elements ?? []).every((element) =>
      (element.actions ?? []).every((action) =>
        ['press', 'set_value', 'select_text', 'confirm', 'pick', 'scroll_down'].includes(action),
      ),
    ),
  );
  const image = snapshot?.image;
  let imageBytes;
  if (image?.path) {
    imageBytes = await readFile(image.path);
    const actual = `sha256:${createHash('sha256').update(imageBytes).digest('hex')}`;
    check(
      'observe image is host-owned and hashable',
      imageBytes.length === image.byteLength &&
        actual === image.sha256 &&
        image.widthPx > 0 &&
        image.heightPx > 0,
    );
  } else {
    check('observe image is host-owned and hashable', false, 'no image returned');
  }

  const screenCapture = await helper.call('screen.capture', { session });
  if (screenCapture.result?.ok === true && screenCapture.result.image?.path) {
    const screenImage = screenCapture.result.image;
    const screenBytes = await readFile(screenImage.path);
    check(
      'screen.capture uses a selected display and host-owned image',
      typeof screenCapture.result.displayId === 'string' &&
        screenBytes.length === screenImage.byteLength &&
        `sha256:${createHash('sha256').update(screenBytes).digest('hex')}` === screenImage.sha256 &&
        screenImage.widthPx > 0 &&
        screenImage.heightPx > 0,
    );
  } else {
    check(
      'screen.capture uses a selected display and host-owned image',
      false,
      screenCapture.result?.error?.code ?? 'capture_failed',
    );
  }

  const input = (snapshot?.elements ?? []).find(
    (element) =>
      element.value !== null && element.value !== undefined && element.role.includes('Edit'),
  );
  const button = (snapshot?.elements ?? []).find((element) => element.actions?.includes('press'));
  check('observe exposes a ValuePattern input or Invoke button', Boolean(input || button));
  const targetElement = input ?? button;
  if (targetElement && snapshot) {
    const action = input
      ? { kind: 'set_value', value: `cu2-${Date.now()}` }
      : { kind: 'click', button: 'left', count: 1 };
    const dispatched = await helper.call('dispatch.element', {
      session,
      snapshotId: snapshot.snapshotId,
      toolCallId: 'cu2-dispatch-1',
      elementToken: targetElement.token,
      expectElementDigest: targetElement.digest,
      strictness: 'element',
      occlusionPolicy: 'same_app',
      action,
      observeAfter: { includeImage: false, settle: 'quiesce' },
    });
    check(
      'dispatch.element returns a complete outcome envelope',
      dispatched.result?.ok === true &&
        dispatched.result.outcome === 'ok' &&
        dispatched.result.effect === 'confirmed' &&
        dispatched.result.verification?.method,
    );
    const duplicate = await helper.call('dispatch.element', {
      session,
      snapshotId: snapshot.snapshotId,
      toolCallId: 'cu2-dispatch-duplicate',
      elementToken: targetElement.token,
      expectElementDigest: targetElement.digest,
      action,
    });
    check(
      'dispatch.element snapshot authority is one-use',
      duplicate.result?.ok === false && duplicate.result.error?.code === 'snapshot_unknown',
    );
  }

  const pointSnapshotResponse = await helper.call('observe', {
    session,
    target: { kind: 'window', pid: identity.pid, windowId: identity.hwnd },
    includeImage: false,
  });
  const pointSnapshot = pointSnapshotResponse.result?.snapshot;
  const point = await helper.call('dispatch.point', {
    session,
    snapshotId: pointSnapshot?.snapshotId,
    toolCallId: 'cu2-point',
    target: { pid: identity.pid, windowId: identity.hwnd },
    point: { x: 1, y: 1 },
  });
  check(
    'dispatch.point is fail-closed and does not mutate',
    point.result?.ok === false &&
      point.result.outcome === 'refused' &&
      point.result.error?.code === 'unsupported_action',
  );

  const beforeRecreate = await helper.call('observe', {
    session,
    target: { kind: 'window', pid: identity.pid, windowId: identity.hwnd },
    includeImage: false,
  });
  await fixture.command('recreate');
  await wait(250);
  const afterWindows = await helper.call('window.list', { session });
  check(
    'fixture recreation changes the HWND inventory',
    !(afterWindows.result?.windows ?? []).some(
      (item) => item.pid === identity.pid && item.windowId === identity.hwnd,
    ),
  );
  const stale = await helper.call('observe', {
    session,
    target: { kind: 'window', pid: identity.pid, windowId: identity.hwnd },
    includeImage: false,
  });
  check(
    'old HWND is refused after fixture recreation',
    stale.result?.ok === false && stale.result.error?.code === 'window_gone',
  );
  check(
    'fresh HWND is re-enumerated after recreation',
    (afterWindows.result?.windows ?? []).some(
      (item) => item.pid === identity.pid && item.windowId !== identity.hwnd,
    ),
  );
  void beforeRecreate;

  const ended = await helper.call('session.end', { session });
  check(
    'session.end reports scoped release counts',
    ended.result?.ok === true &&
      ended.result?.released?.snapshots >= 0 &&
      ended.result?.released?.streams === 0,
  );
  const endedAgain = await helper.call('session.end', { session });
  check('session.end is idempotent for an unknown session', endedAgain.result?.ok === true);

  const parentImageDir = await mkdtemp(join(tmpdir(), 'maka-cu2-parent-images-'));
  const declaredParent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1200)'], {
    stdio: 'ignore',
  });
  const parentBoundHelper = rpc(helperExe, ['host']);
  try {
    const parentHello = await parentBoundHelper.call('host.hello', {
      protocol: 'maka.cu/2',
      host: { name: 'maka-cu2-parent-death-driver', version: 'test' },
      hostPid: declaredParent.pid,
      imageDir: parentImageDir,
      allowGlobalPointer: false,
    });
    check('host.hello accepts the declared supervisor PID', parentHello.result?.ok === true);
    await wait(3_500);
    check(
      'helper exits after the declared supervisor dies',
      parentBoundHelper.child.exitCode !== null,
      `exitCode=${parentBoundHelper.child.exitCode}`,
    );
  } finally {
    await closeChild(parentBoundHelper.child);
    await closeChild(declaredParent);
    await rm(parentImageDir, { recursive: true, force: true });
  }

  const shutdown = await helper.call('shutdown');
  check(
    'shutdown returns bounded grace',
    shutdown.result?.ok === true && shutdown.result.graceMs > 0,
  );
} catch (error) {
  check(
    'driver completed without an unexpected exception',
    false,
    error instanceof Error ? error.message : String(error),
  );
} finally {
  try {
    await fixture.command('shutdown');
  } catch {
    /* cleanup below */
  }
  await closeChild(fixture.child);
  await closeChild(helper.child);
  await rm(imageDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ protocol: 'maka.cu/2', failures, tests: report }, null, 2));
process.exitCode = failures === 0 ? 0 : 1;
