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
 * Live maka.cu/2 Chromium matrix. Chrome always receives a fresh temporary
 * profile and is terminated only through the process tree owned by this run.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  applicationEvidence,
  createOracleStore,
  pageAHasValue,
  pageAClicked,
  pageAScrolled,
} from '../maka-cu-windows/oracle-state.mjs';

const [helperExe, outPath] = process.argv.slice(2);
if (!helperExe || !outPath) {
  console.error('usage: node maka-cu2-browser-driver.mjs <helper.exe> <out.json>');
  process.exit(2);
}
const chromeCandidates = [
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
];
const chromeExe = chromeCandidates.find((candidate) => existsSync(candidate));
const pagePath = resolve('experiments/maka-cu-windows/fixture/web-task-fixture.html');
const pageHtml = await readFile(pagePath, 'utf8');
const run = `rust-cu2-${process.pid}-${Date.now()}`;
const oracle = createOracleStore();
const tests = [];
function record(name, status, note = '') {
  tests.push({ name, status, ...(note ? { note } : {}) });
  console.log(`${status.toUpperCase()} ${name}${note ? ` — ${note}` : ''}`);
}
function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}
async function waitOracle(predicate, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const state = oracle.get(run);
    if (predicate(state)) return state;
    await wait(100);
  }
  return oracle.get(run);
}
function processTree(rootPid, profile) {
  try {
    const script =
      '$rows=@(Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | Select-Object ProcessId,ParentProcessId,CommandLine); $rows | ConvertTo-Json -Compress';
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const ids = new Set(rows.some((row) => Number(row.ProcessId) === rootPid) ? [rootPid] : []);
    for (const row of rows)
      if (String(row.CommandLine ?? '').includes(profile)) ids.add(Number(row.ProcessId));
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows)
        if (ids.has(Number(row.ParentProcessId)) && !ids.has(Number(row.ProcessId))) {
          ids.add(Number(row.ProcessId));
          changed = true;
        }
    }
    return ids;
  } catch {
    return new Set();
  }
}
function killOwnedChrome(rootPid, profile) {
  const ids = processTree(rootPid, profile);
  if (ids.size === 0) return;
  for (const pid of ids) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5000,
      });
    } catch {}
  }
}
function rpc(exe) {
  const child = spawn(exe, ['host'], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
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
      waiter.resolve(message);
    }
  });
  child.once('exit', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('helper exited'));
    pending.clear();
  });
  function call(method, params = {}, timeoutMs = 20_000) {
    const id = nextId++;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) rejectCall(new Error(`${method} timeout`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveCall(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectCall(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  return { child, call };
}
function findElement(snapshot, name, action) {
  return (snapshot?.elements ?? []).find(
    (element) => element.title === name && (!action || element.actions?.includes(action)),
  );
}
function outcomeStatus(response) {
  const result = response?.result;
  if (result?.outcome === 'ok' && result.effect === 'confirmed') return 'pass';
  if (result?.outcome === 'unknown' || result?.error?.code === 'outcome_unknown') return 'unknown';
  if (
    result?.error?.code === 'element_not_actionable' ||
    result?.error?.code === 'unsupported_action'
  )
    return 'blocked';
  return 'fail';
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && (url.pathname === '/page-a' || url.pathname === '/page-b')) {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(pageHtml);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/oracle') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      try {
        if (!oracle.ingest(JSON.parse(body))) throw new Error('invalid event');
        response.writeHead(204);
        response.end();
      } catch {
        response.writeHead(400);
        response.end();
      }
    });
    return;
  }
  response.writeHead(404);
  response.end();
});
let helper;
let browser;
let profile;
let session;
let identity;
try {
  if (!chromeExe) {
    record('Chromium environment', 'blocked', 'Chrome executable unavailable');
    throw new Error('environment_chrome_unavailable');
  }
  const desktop = JSON.parse(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CuDesktop { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }'; $h=[CuDesktop]::GetForegroundWindow(); [uint32]$p=0; [void][CuDesktop]::GetWindowThreadProcessId($h,[ref]$p); $proc=Get-Process -Id $p -ErrorAction SilentlyContinue; @{hwnd=$h.ToInt64(); processName=$proc.ProcessName; locked=($proc.ProcessName -in @('LockApp','LogonUI')); unknown=($null -eq $proc)} | ConvertTo-Json -Compress",
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 },
    ),
  );
  if (!desktop || desktop.locked || desktop.unknown || !Number.isFinite(Number(desktop.hwnd))) {
    record(
      'Chromium environment',
      'blocked',
      desktop?.locked ? 'desktop locked' : 'interactive desktop unavailable',
    );
    throw new Error('environment_desktop_unavailable');
  }
  profile = await mkdtemp(join(tmpdir(), `maka-cu2-browser-${run}-`));
  const port = await new Promise((resolvePort, rejectPort) => {
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => resolvePort(server.address().port));
  });
  helper = rpc(helperExe);
  const hello = await helper.call('host.hello', {
    protocol: 'maka.cu/2',
    host: { name: 'maka-cu2-browser-driver', version: 'test' },
    hostPid: process.pid,
    imageDir: profile,
    allowGlobalPointer: false,
  });
  record('host.hello', hello.result?.protocol === 'maka.cu/2' ? 'pass' : 'fail');
  session = `cu2-browser-${process.pid}-${Date.now()}`;
  record(
    'session.begin',
    (await helper.call('session.begin', { session, captureScope: 'window' })).result?.ok === true
      ? 'pass'
      : 'fail',
  );
  const before = (await helper.call('window.list', { session })).result?.windows ?? [];
  const baseline = new Set(before.map((window) => Number(window.windowId)));
  browser = spawn(
    chromeExe,
    [
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--force-renderer-accessibility=complete',
      '--new-window',
      `http://127.0.0.1:${port}/page-a?run=${encodeURIComponent(run)}`,
      '--window-size=800,600',
    ],
    { stdio: 'ignore', windowsHide: false },
  );
  await waitOracle((state) => state.events.includes('ready'), 30_000);
  const waitEnd = Date.now() + 30_000;
  while (Date.now() < waitEnd) {
    const listed = (await helper.call('window.list', { session })).result?.windows ?? [];
    const tree = processTree(browser.pid, profile);
    const candidates = listed.filter(
      (window) =>
        tree.has(Number(window.pid)) &&
        !baseline.has(Number(window.windowId)) &&
        String(window.title ?? '').includes(run),
    );
    if (candidates.length === 1) {
      identity = { pid: Number(candidates[0].pid), hwnd: Number(candidates[0].windowId) };
      break;
    }
    await wait(250);
  }
  record(
    'fresh Chromium PID/HWND target',
    identity ? 'pass' : 'blocked',
    identity ? '' : 'temporary profile window not uniquely observable',
  );
  if (!identity) throw new Error('environment_blocked_target_identity');
  const observe = async () =>
    (
      await helper.call('observe', {
        session,
        target: { kind: 'window', pid: identity.pid, windowId: identity.hwnd },
        includeImage: false,
      })
    ).result?.snapshot;
  let snapshot = await observe();
  // Chromium publishes its renderer accessibility tree asynchronously. Wait
  // for two equal consecutive window digests before quoting an element; this
  // is still a fresh observation and never relaxes the PID/HWND/digest check.
  let stableDigestCount = 0;
  for (let attempt = 0; attempt < 20 && stableDigestCount < 2; attempt += 1) {
    await wait(100);
    const next = await observe();
    if (next?.windowDigest && next.windowDigest === snapshot?.windowDigest) stableDigestCount += 1;
    else stableDigestCount = 0;
    snapshot = next ?? snapshot;
  }
  record(
    'observe web controls',
    ['Web text input', 'Web scroll region', 'Apply semantic click'].every((name) =>
      (snapshot?.elements ?? []).some((element) => element.title === name),
    )
      ? 'pass'
      : 'blocked',
  );
  const dispatch = async (element, action, name) => {
    if (!element) {
      record(name, 'blocked', 'semantic control not exposed by Chromium UIA');
      return null;
    }
    const response = await helper.call('dispatch.element', {
      session,
      snapshotId: snapshot.snapshotId,
      toolCallId: `browser-${name}`,
      elementToken: element.token,
      expectElementDigest: element.digest,
      strictness: 'element',
      occlusionPolicy: 'same_app',
      action,
      observeAfter: { includeImage: false, settle: 'quiesce' },
    });
    record(
      name,
      outcomeStatus(response),
      response.result?.error ? JSON.stringify(response.result.error) : '',
    );
    return response;
  };
  const value = `cu2-${Date.now()}`;
  // set_value is a semantic action, not a secondary action advertised in the
  // element.actions closed set. The editable role/value is the capability
  // signal; do not require a non-wire action name here.
  const setValueResponse = await dispatch(
    findElement(snapshot, 'Web text input'),
    { kind: 'set_value', value },
    'Chromium semantic set_value',
  );
  if (outcomeStatus(setValueResponse) === 'blocked') {
    record(
      'Chromium page oracle confirms value',
      'blocked',
      'helper did not expose a safe writable UIA route',
    );
  } else {
    record(
      'Chromium page oracle confirms value',
      pageAHasValue(await waitOracle((state) => pageAHasValue(state, value)), value)
        ? 'pass'
        : 'fail',
    );
  }
  snapshot = await observe();
  await dispatch(
    findElement(snapshot, 'Web text input'),
    { kind: 'select_text', text: 'cu2' },
    'Chromium semantic select_text',
  );
  snapshot = await observe();
  const beforeClicks = applicationEvidence(oracle.get(run)).clickCountOnPageA;
  await dispatch(
    findElement(snapshot, 'Apply semantic click', 'press'),
    { kind: 'click', button: 'left', count: 1 },
    'Chromium semantic click',
  );
  record(
    'Chromium page oracle confirms click',
    pageAClicked(await waitOracle((state) => pageAClicked(state, beforeClicks)), beforeClicks)
      ? 'pass'
      : 'fail',
  );
  snapshot = await observe();
  const beforeScroll = applicationEvidence(oracle.get(run)).scrollTopOnPageA;
  await dispatch(
    findElement(snapshot, 'Web scroll region', 'scroll_down'),
    { kind: 'scroll', direction: 'down', pages: 1 },
    'Chromium semantic scroll',
  );
  record(
    'Chromium page oracle confirms scroll',
    pageAScrolled(await waitOracle((state) => pageAScrolled(state, beforeScroll)), beforeScroll)
      ? 'pass'
      : 'fail',
  );
  snapshot = await observe();
  const compat = findElement(snapshot, 'Compat text input');
  const enterResponse = await helper.call('dispatch.key', {
    session,
    snapshotId: snapshot.snapshotId,
    toolCallId: 'browser-enter',
    focusToken: snapshot.focusedElementToken ?? compat?.token,
    expectElementDigest:
      (snapshot.elements ?? []).find(
        (element) => element.token === (snapshot.focusedElementToken ?? compat?.token),
      )?.digest ?? compat?.digest,
    action: { kind: 'key', key: 'Return', modifiers: [] },
  });
  record(
    'Chromium Enter helper remains unknown',
    enterResponse.result?.outcome === 'unknown' ? 'unknown' : 'fail',
    'page navigation oracle is never promoted to helper verified',
  );
  record(
    'session.end',
    (await helper.call('session.end', { session })).result?.ok === true ? 'pass' : 'fail',
  );
  await helper.call('shutdown', {});
} catch (error) {
  if (
    !tests.some((test) => test.name === 'Chromium environment') &&
    !tests.some((test) => test.name === 'fresh Chromium PID/HWND target')
  )
    record('Chromium driver', 'blocked', error.message);
} finally {
  server.close();
  if (helper?.child.exitCode === null) {
    try {
      helper.child.kill();
    } catch {}
  }
  if (browser?.pid) killOwnedChrome(browser.pid, profile);
  if (profile) {
    try {
      await rm(profile, { recursive: true, force: true });
    } catch {}
  }
}
const result = {
  schema: 'maka.cu.windows/generic-chromium-results/1',
  protocol: 'maka.cu/2',
  executor: 'rust-native-windows',
  temporaryProfile: profile,
  target: identity,
  host: { platform: process.platform, arch: process.arch, node: process.version },
  summary: {
    pass: tests.filter((test) => test.status === 'pass').length,
    fail: tests.filter((test) => test.status === 'fail').length,
    blocked: tests.filter((test) => test.status === 'blocked').length,
    unknown: tests.filter((test) => test.status === 'unknown').length,
  },
  tests,
};
await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.summary.fail ? 1 : 0;
