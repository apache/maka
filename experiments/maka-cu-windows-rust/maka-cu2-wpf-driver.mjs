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

/*
 * Live maka.cu/2 WPF semantic matrix. The only application this driver owns
 * is the deterministic WpfTaskFixture; it never attaches to the user's apps.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [helperExe, fixtureExe, outPath] = process.argv.slice(2);
if (!helperExe || !fixtureExe || !outPath) {
  console.error('usage: node maka-cu2-wpf-driver.mjs <helper.exe> <fixture.exe> <out.json>');
  process.exit(2);
}

const tests = [];
let failures = 0;
let unknown = 0;
let blocked = 0;
function record(name, status, note = '') {
  tests.push({ name, status, ...(note ? { note } : {}) });
  if (status === 'fail') failures += 1;
  if (status === 'unknown') unknown += 1;
  if (status === 'blocked') blocked += 1;
  console.log(`${status.toUpperCase()} ${name}${note ? ` — ${note}` : ''}`);
}
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rpc(exe, args) {
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
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  return { child, call };
}

function fixtureProcess(exe) {
  const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture READY timeout')), 10_000);
    lines.on('line', (line) => {
      const match = /^READY (\d+) (\d+)$/.exec(line);
      if (!match) return;
      clearTimeout(timer);
      resolve({ pid: Number(match[1]), hwnd: Number(match[2]) });
    });
    child.once('exit', (code) => reject(new Error(`fixture exited before READY (${code})`)));
  });
  return {
    child,
    ready,
    shutdown: () => {
      child.stdin.write('shutdown\n');
      child.stdin.end();
    },
  };
}

async function close(child) {
  if (!child || child.exitCode !== null) return;
  child.stdin?.end();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), wait(2500)]);
  if (child.exitCode === null) child.kill();
}

const imageDir = await mkdtemp(join(tmpdir(), 'maka-cu2-wpf-images-'));
const helper = rpc(helperExe, ['host']);
const fixture = fixtureProcess(fixtureExe);
const session = `cu2-wpf-${process.pid}-${Date.now()}`;
let identity;
try {
  identity = await fixture.ready;
  const hello = await helper.call('host.hello', {
    protocol: 'maka.cu/2',
    host: { name: 'maka-cu2-wpf-driver', version: 'test' },
    hostPid: process.pid,
    imageDir,
    allowGlobalPointer: false,
  });
  record('host.hello', hello.result?.protocol === 'maka.cu/2' ? 'pass' : 'fail');
  const begin = await helper.call('session.begin', { session, captureScope: 'window' });
  record('session.begin', begin.result?.ok === true ? 'pass' : 'fail');
  const listed = (await helper.call('window.list', { session })).result?.windows ?? [];
  const target = listed.find(
    (window) => window.pid === identity.pid && window.windowId === identity.hwnd,
  );
  record('fresh WPF PID/HWND target', target ? 'pass' : 'fail');
  const observe = async () => {
    const response = await helper.call('observe', {
      session,
      target: { kind: 'window', pid: identity.pid, windowId: identity.hwnd },
      includeImage: false,
    });
    return response.result?.snapshot;
  };
  const find = (snapshot, id, predicate = () => true) =>
    (snapshot?.elements ?? []).find((element) => element.axIdentifier === id && predicate(element));
  async function dispatch(snapshot, element, action, name) {
    if (!element) {
      record(name, 'blocked', 'semantic element not exposed by UIA');
      return null;
    }
    const response = await helper.call('dispatch.element', {
      session,
      snapshotId: snapshot.snapshotId,
      toolCallId: `wpf-${name}`,
      elementToken: element.token,
      expectElementDigest: element.digest,
      strictness: 'element',
      occlusionPolicy: 'same_app',
      action,
      observeAfter: { includeImage: false, settle: 'quiesce' },
    });
    const result = response.result;
    if (result?.outcome === 'ok' && result.effect === 'confirmed') record(name, 'pass');
    else if (result?.outcome === 'unknown' || result?.error?.code === 'outcome_unknown')
      record(name, 'unknown', result?.error?.message ?? 'helper outcome unknown');
    else if (
      result?.error?.code === 'element_not_actionable' ||
      result?.error?.code === 'unsupported_action'
    )
      record(name, 'blocked', result.error.code);
    else record(name, 'fail', result?.error?.code ?? 'dispatch failed');
    return result?.snapshot ?? snapshot;
  }

  let snapshot = await observe();
  record('observe exposes WPF input', find(snapshot, 'wpf-input') ? 'pass' : 'blocked');
  snapshot = await dispatch(
    snapshot,
    find(snapshot, 'wpf-input'),
    { kind: 'set_value', value: 'maka-wpf-value' },
    'semantic set_value',
  );
  snapshot = await observe();
  const inputAfter = find(snapshot, 'wpf-input');
  record(
    'set_value readback is visible',
    inputAfter?.value === 'maka-wpf-value' ? 'pass' : 'fail',
    inputAfter?.value ?? 'missing',
  );
  snapshot = await dispatch(
    snapshot,
    inputAfter,
    { kind: 'select_text', text: 'wpf' },
    'semantic select_text',
  );

  snapshot = await dispatch(
    snapshot,
    find(snapshot, 'wpf-button'),
    { kind: 'click', button: 'left', count: 1 },
    'semantic button click',
  );
  snapshot = await observe();
  record(
    'button oracle reports clicked',
    find(snapshot, 'wpf-status')?.title === 'clicked' ? 'pass' : 'fail',
    find(snapshot, 'wpf-status')?.title ?? 'missing',
  );

  const alpha = (snapshot?.elements ?? []).find((element) => element.title === 'Alpha');
  snapshot = await dispatch(
    snapshot,
    alpha,
    { kind: 'click', button: 'left', count: 1 },
    'semantic list selection',
  );
  snapshot = await observe();
  record(
    'list selection oracle reports Alpha',
    find(snapshot, 'wpf-status')?.title === 'selected:Alpha' ? 'pass' : 'fail',
    find(snapshot, 'wpf-status')?.title ?? 'missing',
  );

  snapshot = await dispatch(
    snapshot,
    find(snapshot, 'wpf-button'),
    { kind: 'secondary_action', action: 'press' },
    'secondary_action press',
  );
  snapshot = await observe();
  record(
    'secondary_action oracle reports clicked',
    find(snapshot, 'wpf-status')?.title === 'clicked' ? 'pass' : 'fail',
    find(snapshot, 'wpf-status')?.title ?? 'missing',
  );

  snapshot = await dispatch(
    snapshot,
    find(snapshot, 'wpf-toggle'),
    { kind: 'click', button: 'left', count: 1 },
    'semantic toggle click',
  );
  snapshot = await observe();
  record(
    'toggle oracle reports on',
    find(snapshot, 'wpf-status')?.title === 'toggled:on' ? 'pass' : 'fail',
    find(snapshot, 'wpf-status')?.title ?? 'missing',
  );

  const scroll = find(snapshot, 'wpf-scroll');
  await dispatch(
    snapshot,
    scroll,
    { kind: 'scroll', direction: 'down', pages: 1 },
    'semantic scroll down',
  );

  snapshot = await observe();
  const enter = await helper.call('dispatch.key', {
    session,
    snapshotId: snapshot.snapshotId,
    toolCallId: 'wpf-enter',
    focusToken: snapshot.focusedElementToken ?? find(snapshot, 'wpf-input')?.token,
    expectElementDigest:
      (snapshot.elements ?? []).find((element) => element.token === snapshot.focusedElementToken)
        ?.digest ?? find(snapshot, 'wpf-input')?.digest,
    // The wire carries the closed protocol vocabulary; the host-side parser
    // is the layer that maps caller spelling `Enter` to `Return`.
    action: { kind: 'key', key: 'Return', modifiers: [] },
  });
  record(
    'Enter helper remains honest unknown',
    enter.result?.outcome === 'unknown' ? 'unknown' : 'fail',
    'page oracle is not rewritten as helper verified',
  );
  const end = await helper.call('session.end', { session });
  record('session.end', end.result?.ok === true ? 'pass' : 'fail');
  await helper.call('shutdown', {});
} catch (error) {
  record('driver execution', 'fail', error.message);
} finally {
  fixture.shutdown();
  await close(fixture.child);
  await close(helper.child);
}

const result = {
  schema: 'maka.cu.windows/generic-wpf-results/1',
  executor: 'rust-native-windows',
  protocol: 'maka.cu/2',
  target: { pid: identity?.pid ?? null, hwnd: identity?.hwnd ?? null, fixture: fixtureExe },
  summary: {
    pass: tests.filter((test) => test.status === 'pass').length,
    fail: failures,
    blocked,
    unknown,
  },
  tests,
};
await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
process.exitCode = failures ? 1 : 0;
