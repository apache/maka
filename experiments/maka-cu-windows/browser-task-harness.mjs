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

// Language-blind Chromium/UIA fixture harness. Browser actions are dispatched
// only through the helper RPC; the loopback page is an independent oracle.
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  applicationEvidence,
  classifyDispatchedTask,
  createOracleStore,
  boundNavigationCompleted,
  pageAClicked,
  pageAHasCompatValue,
  pageAHasValue,
  pageAScrolled,
} from './oracle-state.mjs';

const argv = process.argv.slice(2);
const foregroundWaitIndex = argv.indexOf('--foreground-wait-ms');
const foregroundWaitMs = foregroundWaitIndex >= 0 ? Number(argv[foregroundWaitIndex + 1]) : 0;
if (foregroundWaitIndex >= 0) argv.splice(foregroundWaitIndex, 2);
if (!Number.isInteger(foregroundWaitMs) || foregroundWaitMs < 0 || foregroundWaitMs > 30000) throw new Error('invalid foreground-wait-ms (0..30000)');
const outIndex = argv.indexOf('--out');
const outputPath = resolve(outIndex >= 0 ? argv[outIndex + 1] : 'browser-task-results.json');
if (outIndex >= 0) argv.splice(outIndex, 2);
const observeOnly = argv.includes('--observe-only');
if (observeOnly) argv.splice(argv.indexOf('--observe-only'), 1);
const oneHelper = argv.includes('--one-helper');
if (oneHelper) argv.splice(argv.indexOf('--one-helper'), 1);
const modesIndex = argv.indexOf('--modes');
const selectedModeNames = modesIndex >= 0 ? argv[modesIndex + 1].split(',').map((name) => name.trim()).filter(Boolean) : null;
if (modesIndex >= 0) argv.splice(modesIndex, 2);
const tasksIndex = argv.indexOf('--tasks');
const selectedTaskNames = tasksIndex >= 0 ? argv[tasksIndex + 1].split(',').map((name) => name.trim()).filter(Boolean) : null;
if (tasksIndex >= 0) argv.splice(tasksIndex, 2);
const wakeIndex = argv.indexOf('--wake-ms');
const wakeMs = wakeIndex >= 0 ? Math.min(5000, Math.max(1, Number(argv[wakeIndex + 1]) || 0)) : 0;
if (wakeIndex >= 0) argv.splice(wakeIndex, 2);
const wakeProbeIndex = argv.indexOf('--wake-probe');
const wakeProbePath = resolve(wakeProbeIndex >= 0 ? argv[wakeProbeIndex + 1] : 'experiments/maka-cu-windows/out/handoff-wake/UiaWakeProbe.exe');
if (wakeProbeIndex >= 0) argv.splice(wakeProbeIndex, 2);
const settleIndex = argv.indexOf('--settle-ms');
const settleMs = settleIndex >= 0 ? Math.min(5000, Math.max(1, Number(argv[settleIndex + 1]) || 0)) : 0;
if (settleIndex >= 0) argv.splice(settleIndex, 2);
const preUiaIndex = argv.indexOf('--pre-uia-ms');
const preUiaMs = preUiaIndex >= 0 ? Number(argv[preUiaIndex + 1]) : 0;
if (preUiaIndex >= 0) argv.splice(preUiaIndex, 2);
const repeatIndex = argv.indexOf('--repetitions');
const repetitions = repeatIndex >= 0 ? Number(argv[repeatIndex + 1]) : 1;
if (repeatIndex >= 0) argv.splice(repeatIndex, 2);
if (!Number.isInteger(preUiaMs) || preUiaMs < 0 || preUiaMs > 5000 || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error('invalid pre-uia-ms or repetitions');
const [firstHelper, secondHelper] = argv;
if (!firstHelper || (!oneHelper && !secondHelper)) {
  console.error('usage: node browser-task-harness.mjs <helper-1.exe> [helper-2.exe] [--out result.json] [--one-helper] [--observe-only] [--modes name] [--tasks name,name]');
  process.exit(2);
}

const startedAt = new Date().toISOString();
const completedSubjects = [];
let runningOracle = null;
const ALL_MODES = [
  { name: 'default', args: [] },
  { name: 'force-renderer-accessibility', args: ['--force-renderer-accessibility'] },
  { name: 'force-renderer-accessibility-complete', args: ['--force-renderer-accessibility=complete'] },
  {
    name: 'force-renderer-accessibility-complete-anti-occlusion',
    args: [
      '--force-renderer-accessibility=complete',
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
    note: 'complete plus cua#1620 anti-occlusion flags; case study, not proven root cause for this harness',
  },
];
const ACTION_TIMEOUT_MS = 20_000;
const BROWSER_WAIT_MS = 30_000;
const ACTION_TASK_NAMES = ['chromium_set_text_and_readback', 'chromium_scroll_capability', 'chromium_semantic_click_and_status_readback', 'chromium_compat_type_text_authorized', 'chromium_compat_press_enter_authorized_navigation'];
const KNOWN_TASK_NAMES = ['chromium_observe_page_controls', ...ACTION_TASK_NAMES];
const TASK_NAMES = selectedTaskNames ?? (observeOnly ? ['chromium_observe_page_controls'] : KNOWN_TASK_NAMES);
if (TASK_NAMES.some((name) => !KNOWN_TASK_NAMES.includes(name))) {
  console.error(`unknown --tasks value; known: ${KNOWN_TASK_NAMES.join(',')}`);
  process.exit(2);
}
const wantTask = (name) => TASK_NAMES.includes(name);
const modes = selectedModeNames
  ? selectedModeNames.map((name) => ALL_MODES.find((mode) => mode.name === name) ?? null)
  : ALL_MODES;
if (modes.some((mode) => mode == null)) {
  console.error(`unknown --modes value; known: ${ALL_MODES.map((mode) => mode.name).join(',')}`);
  process.exit(2);
}
const helperCount = oneHelper ? 1 : 2;
const deadline = Date.now() + Math.max(180_000, helperCount * modes.length * repetitions * 90_000);
const chromeCandidates = [
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
];
const chromePath = chromeCandidates.find(existsSync) ?? null;
const pagePath = resolve('experiments/maka-cu-windows/fixture/web-task-fixture.html');
const fixtureHtml = readFileSync(pagePath, 'utf8');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
const dependencyClosure = (absolute) => {
  const files = readdirSync(resolve(absolute, '..'), { withFileTypes: true }).filter((entry) => entry.isFile() && (/\.(?:exe|dll)$/i.test(entry.name) || /(?:runtimeconfig|deps)\.json$/i.test(entry.name))).map((entry) => resolve(absolute, '..', entry.name)).sort((a, b) => a.localeCompare(b));
  const details = files.map((file) => { const stats = statSync(file); return { path: file, sizeBytes: stats.size, sha256: hash(file) }; });
  const closureSha256 = createHash('sha256').update(details.map((item) => `${item.path}\0${item.sizeBytes}\0${item.sha256}\n`).join('')).digest('hex').toUpperCase();
  return { files: details, totalSizeBytes: details.reduce((total, item) => total + item.sizeBytes, 0), closureSha256 };
};
const artifact = (path) => {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return { path: absolute, exists: false, sizeBytes: null, sha256: null, lastWrite: null };
  const stats = statSync(absolute);
  return { path: absolute, exists: true, sizeBytes: stats.size, sha256: hash(absolute), sha256Meaning: 'entrypoint file only; dependencyClosure describes same-directory runtime files', lastWrite: stats.mtime.toISOString(), dependencyClosure: dependencyClosure(absolute) };
};
const inputFingerprints = ['browser-task-harness.mjs', 'oracle-state.mjs', 'fixture/web-task-fixture.html'].map(file => {
  const path = resolve('experiments/maka-cu-windows', file);
  return { path, sha256: hash(path) };
});
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const remaining = () => Math.max(0, deadline - Date.now());

function processTree(rootPid, profile) {
  try {
    const script = '$rows=@(Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | Select-Object ProcessId,ParentProcessId,CommandLine); $rows | ConvertTo-Json -Compress';
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    const rows = raw.trim() ? JSON.parse(raw) : [];
    const list = Array.isArray(rows) ? rows : [rows];
    const root = Number(rootPid); const ids = new Set(list.some((row) => Number(row.ProcessId) === root) ? [root] : []);
    if (profile) {
      for (const row of list) {
        const command = String(row.CommandLine ?? '');
        if (command.includes(profile)) ids.add(Number(row.ProcessId));
      }
    }
    let changed = true;
    while (changed) { changed = false; for (const row of list) if (ids.has(Number(row.ParentProcessId)) && !ids.has(Number(row.ProcessId))) { ids.add(Number(row.ProcessId)); changed = true; } }
    return { ids: [...ids].filter((id) => id > 0), rows: list, queryFailed: false };
  } catch { return { ids: [], rows: [], queryFailed: true }; }
}

function selectTarget(lastWindows, run) {
  const titled = lastWindows.filter((item) => item.title?.includes(run) && item.newHwnd);
  const inTree = titled.filter((item) => item.pidInTree);
  if (inTree.length === 1) return inTree[0];
  return null;
}

function runWakeProbe(hwnd, waitMs) {
  if (!existsSync(wakeProbePath)) return { ok: false, error: 'wake_probe_missing', path: wakeProbePath };
  try {
    const raw = execFileSync(wakeProbePath, [String(hwnd), String(waitMs)], { encoding: 'utf8', windowsHide: true, timeout: waitMs + 4000 });
    const line = raw.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '{}';
    return { ok: true, raw: line, ...(JSON.parse(line)) };
  } catch (error) {
    return { ok: false, error: error.message ?? String(error), stdout: error.stdout?.toString?.() ?? null };
  }
}

function foregroundWindow(hwnd, activate = true) {
  try {
    const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class W { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); }'; ${activate ? `[void][W]::ShowWindow([IntPtr]${Number(hwnd)}, 9); $activated = [W]::SetForegroundWindow([IntPtr]${Number(hwnd)});` : '$activated = $null;'} $foreground = [W]::GetForegroundWindow().ToInt64(); @{ activated=$activated; foregroundHwnd=$foreground; targetIsForeground=($foreground -eq ${Number(hwnd)}); minimized=[W]::IsIconic([IntPtr]${Number(hwnd)}) } | ConvertTo-Json -Compress`;
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 3000 }).trim());
  } catch (error) {
    return `error:${error.message ?? error}`;
  }
}

function desktopState() {
  // Read-only gate. Do not activate windows on the lock/security desktop.
  const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class DesktopStateProbe { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }'; $fgHandle = [DesktopStateProbe]::GetForegroundWindow(); [uint32]$fgPid = 0; [void][DesktopStateProbe]::GetWindowThreadProcessId($fgHandle, [ref]$fgPid); $fgProcess = Get-Process -Id $fgPid -ErrorAction SilentlyContinue; @{ foregroundHwnd=$fgHandle.ToInt64(); processName=$fgProcess.ProcessName; locked=($fgProcess.ProcessName -in @('LockApp','LogonUI')); unknown=($null -eq $fgProcess) } | ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim());
}

function chromeRows() {
  try {
    const script = '$rows=@(Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | Select-Object ProcessId,CommandLine); $rows | ConvertTo-Json -Compress';
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    const rows = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(rows) ? rows : [rows];
  } catch { throw new Error('Chrome process query failed; refusing unverified cleanup'); }
}

function pidsMatching(predicate) {
  return chromeRows().filter((row) => predicate(String(row.CommandLine ?? ''))).map((row) => Number(row.ProcessId)).filter((id) => id > 0);
}

function killPids(pids) {
  for (const pid of [...new Set(pids)]) {
    try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'pipe', timeout: 5000 }); } catch {}
  }
}

function leftoverTestChromePids() {
  return pidsMatching((command) => command.includes('\\Temp\\maka-cu-') || command.includes('/Temp/maka-cu-'));
}

async function waitGone(listPids, timeout = 8_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (listPids().length === 0) return true;
    await sleep(150);
  }
  return listPids().length === 0;
}

async function ensureSingleTestChrome() {
  const desktop = desktopState();
  if (desktop.locked || desktop.unknown) throw Object.assign(new Error('interactive desktop unavailable; no UI actions attempted'), { blocked: true, reason: desktop.locked ? 'environment_desktop_locked' : 'environment_desktop_unknown', desktop });
  // Never kill another test run merely because its profile uses our prefix.
  if (leftoverTestChromePids().length) throw Object.assign(new Error('another test Chrome still running; not owned by this run'), { blocked: true, reason: 'environment_blocked_chrome_not_released' });
}

function windowsForTree(listWindows, tree, baseline) {
  return (listWindows.result?.windows ?? []).map((item) => ({ ...item, pidInTree: tree.ids.includes(Number(item.pid)), newHwnd: !baseline.has(Number(item.hwnd)) }));
}

function helperFor(path) {
  const resolved = resolve(path); const command = resolved.toLowerCase().endsWith('.dll') ? 'dotnet' : resolved; const commandArgs = command === 'dotnet' ? [resolved] : [];
  const child = spawn(command, commandArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  let nextId = 1; const pending = new Map(); const rpcTrace = [];
  lines.on('line', (line) => { let message; try { message = JSON.parse(line); } catch { return; } const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); clearTimeout(waiter.timer); rpcTrace.push({ id: message.id, response: message }); waiter.resolve(message); });
  child.once('exit', () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('helper exited')); } pending.clear(); });
  let activeDeadline = deadline;
  const call = (method, params = {}, timeout = ACTION_TIMEOUT_MS) => new Promise((resolveCall, rejectCall) => {
    const id = nextId++; const request = { jsonrpc: '2.0', id, method, params }; const budget = Math.min(timeout, Math.max(1, activeDeadline - Date.now()), Math.max(1, remaining())); const timer = setTimeout(() => { pending.delete(id); rejectCall(new Error(`${method} timeout`)); }, budget);
    rpcTrace.push({ id, sentAt: Date.now(), request }); pending.set(id, { resolve: resolveCall, reject: rejectCall, timer }); child.stdin.write(`${JSON.stringify(request)}\n`);
  });
  return { child, call, rpcTrace, setDeadline: (value) => { activeDeadline = value; } };
}

async function stopHelper(helper) {
  if (!helper || helper.child.exitCode !== null) return;
  try { await helper.call('shutdown', {}, 3000); } catch { try { helper.child.kill(); } catch {} }
  await sleep(250); if (helper.child.exitCode === null) try { helper.child.kill(); } catch {}
}

function startOracle() {
  const store = createOracleStore();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && (url.pathname === '/page-a' || url.pathname === '/page-b')) { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(fixtureHtml); return; }
    if (request.method === 'POST' && url.pathname === '/oracle') {
      let body = ''; request.on('data', (chunk) => { body += chunk; if (body.length > 64 * 1024) request.destroy(); });
      request.on('end', () => { try { const event = JSON.parse(body); if (!store.ingest(event)) { response.writeHead(400); response.end(); return; } response.writeHead(204); response.end(); } catch { response.writeHead(400); response.end(); } }); return;
    }
    if (request.method === 'GET' && url.pathname === '/oracle') {
      const state = store.get(url.searchParams.get('run'));
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ...state, application: applicationEvidence(state) }));
      return;
    }
    response.writeHead(404); response.end();
  });
  return { server, store, ready: new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolveReady(server.address().port)); }) };
}

async function oracleState(oracle, run) { return oracle.store.get(run); }
async function waitOracle(oracle, run, predicate, timeout = 20_000) {
  const end = Math.min(Date.now() + timeout, deadline);
  while (Date.now() < end) { const state = await oracleState(oracle, run); if (predicate(state)) return { pass: true, state }; await sleep(100); }
  return { pass: false, state: await oracleState(oracle, run) };
}

function nodesOf(observation) { return [...(observation?.result?.elements ?? []), ...(observation?.result?.tree?.nodes ?? [])]; }
function candidateEvidence(observation) { return nodesOf(observation).map((item) => ({ token: item.token, name: item.name, automationId: item.automationId, controlType: item.controlType, runtimeId: item.runtimeId, rawDepth: item.rawDepth, parentRuntimeId: item.parentRuntimeId, observationSource: item.observationSource, patterns: item.patterns, actions: item.actions, value: item.value, scrollState: item.scrollState })).slice(0, 200); }
function findNode(observation, name, action) { return nodesOf(observation).find((item) => item.name === name && (!action || item.actions?.includes(action) || item.patterns?.includes(action))); }
function pageControlEvidence(observation) {
  const required = [
    { name: 'Web text input', automationId: 'web-input', action: 'set_value' },
    { name: 'Web scroll region', automationId: 'scroll', action: 'scroll' },
    { name: 'Apply semantic click', automationId: 'web-button', action: 'click_element' },
    { name: 'Compat text input', automationId: 'compat-input', action: 'set_value' },
  ];
  const found = required.map((item) => ({ ...item, node: nodesOf(observation).find(node => node.name === item.name && node.automationId === item.automationId && node.actions?.includes(item.action)) ?? null }));
  return { found, missing: found.filter((item) => !item.node).map((item) => item.name), present: found.filter((item) => item.node).map((item) => item.name) };
}

function notAvailable(name, observation, action) {
  const nodes = nodesOf(observation); const sameName = nodes.filter((node) => node.name === name);
  const tree = observation?.result?.tree ?? {};
  const reason = sameName.length > 0 ? `unsupported_${action}_pattern` : tree.truncated ? 'environment_blocked_observation_truncated' : 'unsupported_provider_element';
  return { executionState: 'blocked', contractConformance: 'not_tested', capability: 'unsupported', reason, dispatched: false, observationEvidence: { target: observation?.result?.target ?? null, tree, candidates: candidateEvidence(observation) } };
}

async function runTask(name, fn, tasks) {
  const at = Date.now();
  try { const detail = await fn(); tasks.push({ name, durationMs: Date.now() - at, ...detail }); }
  catch (error) { tasks.push({ name, durationMs: Date.now() - at, executionState: 'fail', contractConformance: 'fail', dispatched: false, error: error.message }); }
}

function padTasks(tasks, reason = 'harness_deadline_exceeded') {
  for (const name of TASK_NAMES) if (!tasks.some((task) => task.name === name)) tasks.push({ name, durationMs: 0, executionState: 'blocked', contractConformance: 'not_tested', dispatched: false, reason });
  return tasks;
}

async function runMode(helperPath, label, mode, oracle, port) {
  const timing = { preUiaMs, settleMs, limitation: 'No target UIA calls from this harness before firstTargetDiscoveryAt; external accessibility clients are not controlled. list_windows may itself touch UIA.' };
  const started = Date.now(); const runDeadline = Math.min(deadline, started + 120_000); const run = `${label}-${mode.name}-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`; const tasks = []; let helper; let browser; let profile; let target; let baseline = new Set(); let observations = [];
  if (remaining() <= 0) return { label, mode: mode.name, run, chromeArgs: mode.args, tasks: padTasks(tasks), executionState: 'blocked', contractConformance: 'not_tested', reason: 'harness_deadline_exceeded', artifact: artifact(helperPath), durationMs: 0 };
  const args = [`--user-data-dir=${profile ?? ''}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', ...(mode.args), '--new-window', `http://127.0.0.1:${port}/page-a?run=${encodeURIComponent(run)}`, '--window-size=800,600'];
  let timedOut = false; const watchdog = setTimeout(() => { timedOut = true; try { helper?.child.kill(); } catch {} if (browser?.pid) { try { execFileSync('taskkill.exe', ['/PID', String(browser.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }); } catch {} } }, Math.max(1, runDeadline - Date.now()));
  try {
    if (!chromePath) throw Object.assign(new Error('Chrome executable unavailable'), { blocked: true, reason: 'environment_chrome_unavailable' });
    profile = mkdtempSync(join(tmpdir(), `maka-cu-${run}-`)); args[0] = `--user-data-dir=${profile}`;
    helper = helperFor(helperPath); helper.setDeadline(runDeadline); const init = await helper.call('initialize'); const before = await helper.call('list_windows');
    baseline = new Set((before.result?.windows ?? []).map((item) => Number(item.hwnd)));
    browser = spawn(chromePath, args, { stdio: 'ignore', windowsHide: false });
    timing.browserSpawnedAt = Date.now();
    const pageReady = await waitOracle(oracle, run, (state) => state.events.includes('ready'), BROWSER_WAIT_MS);
    if (!pageReady.pass) throw Object.assign(new Error('fixture not ready before UIA discovery'), { blocked: true });
    timing.pageReadyReceivedAt = Date.now();
    if (preUiaMs > 0) await sleep(preUiaMs);
    timing.firstTargetDiscoveryAt = Date.now();
    const spawnPid = browser.pid; let lastWindows = []; const waitEnd = Math.min(Date.now() + BROWSER_WAIT_MS, deadline); let oracleReady = false;
    while (Date.now() < waitEnd && remaining() > 0) {
      const listed = await helper.call('list_windows'); const tree = processTree(spawnPid, profile); lastWindows = windowsForTree(listed, tree, baseline);
      target = selectTarget(lastWindows, run);
      if (target) break;
      const ready = await waitOracle(oracle, run, (state) => state.events.includes('ready'), 50); oracleReady ||= ready.pass; await sleep(250);
    }
    if (!target) throw Object.assign(new Error(`Chromium fixture target not uniquely observable; run=${run}`), { blocked: true, reason: 'environment_blocked_target_identity', targetEvidence: { spawnPid, lastWindows, baselineHwnds: [...baseline] } });
    const ready = await waitOracle(oracle, run, (state) => state.events.includes('ready'), 5_000); if (!ready.pass) throw Object.assign(new Error('fixture page did not report ready'), { blocked: true, reason: 'environment_blocked_fixture_not_ready' });
    const observe = async () => { const sentAt = Date.now(); const value = await helper.call('observe', { hwnd: target.hwnd }); observations.push({ sentAt, receivedAt: Date.now(), target: value.result?.target ?? null, tree: value.result?.tree ?? null, candidates: candidateEvidence(value), error: value.error }); return value; };
    const act = (observation, node, op, extra = {}) => helper.call('act', { snapshotId: observation.result.snapshotId, elementToken: node.token, op, ...extra });
    const compatAct = async (observation, node, op, value) => { const auth = await helper.call('authorize_compat', { snapshotId: observation.result.snapshotId, elementToken: node.token, op, ...(op === 'compat_type_text' ? { value } : {}) }); if (auth.error) return auth; return act(observation, node, op, { authorizationToken: auth.result.authorizationToken, ...(op === 'compat_type_text' ? { value } : {}) }); };
    const desktopBeforeActivation = desktopState();
    if (desktopBeforeActivation.locked || desktopBeforeActivation.unknown) throw Object.assign(new Error('desktop unavailable before activation'), { blocked: true, reason: 'environment_desktop_unavailable', desktop: desktopBeforeActivation });
    let broughtForward = foregroundWindow(target.hwnd);
    if (broughtForward?.targetIsForeground !== true && foregroundWaitMs > 0) {
      const foregroundDeadline = Math.min(runDeadline, Date.now() + foregroundWaitMs);
      const attempts = [{ at: Date.now(), state: broughtForward }];
      console.error(`WAIT_FOR_FOREGROUND run=${run} hwnd=${target.hwnd}: click the test Chrome title bar; no input is dispatched until the exact HWND is foreground.`);
      while (broughtForward?.targetIsForeground !== true && Date.now() + 3250 < foregroundDeadline) {
        await sleep(250);
        // Read only while waiting for the user; do not simulate keys, attach
        // input threads, disable foreground restrictions, or redirect input.
        broughtForward = foregroundWindow(target.hwnd, false);
        attempts.push({ at: Date.now(), state: broughtForward });
      }
      if (Date.now() >= foregroundDeadline) broughtForward = { ...broughtForward, targetIsForeground: false, waitExpired: true };
      timing.foregroundWait = { maxMillis: foregroundWaitMs, attempts };
    }
    if (broughtForward?.targetIsForeground !== true) throw Object.assign(new Error('test window did not become foreground'), { blocked: true, reason: 'environment_foreground_not_acquired', desktop: broughtForward });
    if (wantTask('chromium_observe_page_controls')) await runTask('chromium_observe_page_controls', async () => {
      const summarize = (observation) => {
        const pageControls = pageControlEvidence(observation);
        const tree = observation?.result?.tree ?? {};
        return {
          pageControls,
          truncated: tree.truncated === true,
          truncatedReasons: tree.truncatedReasons ?? [],
          nodeCount: tree.nodeCount ?? null,
          elapsedMs: tree.elapsedMs ?? null,
          rawDescendantCount: tree.rawDescendantCount ?? null,
          candidates: candidateEvidence(observation),
        };
      };
      const beforeObs = await observe();
      const before = summarize(beforeObs);
      let wake = null;
      let after = null;
      if (wakeMs > 0) {
        wake = runWakeProbe(target.hwnd, wakeMs);
        after = summarize(await observe());
      } else if (settleMs > 0) {
        wake = { ok: true, subscribed: false, waitMs: settleMs, kind: 'settle_only_no_subscription' };
        await sleep(settleMs);
        after = summarize(await observe());
      }
      const judged = after ?? before;
      let reason = 'page_controls_observed';
      if (judged.pageControls.missing.length > 0) {
        reason = judged.truncated ? 'observation_truncated' : 'page_controls_not_observed';
      }
      const added = after
        ? after.pageControls.present.filter((name) => !before.pageControls.present.includes(name))
        : [];
      return {
        executionState: judged.pageControls.missing.length === 0 ? 'pass' : 'blocked',
        contractConformance: 'not_tested',
        dispatched: false,
        reason,
        windowState: { hwnd: target.hwnd, pid: target.pid, title: target.title, className: target.className, isOffscreen: target.isOffscreen, broughtForward },
        wake,
        before,
        after,
        controlsAddedAfterWake: added,
        treeAttachment: {
          truncated: judged.truncated,
          truncatedReasons: judged.truncatedReasons,
          nodeCount: judged.nodeCount,
          elapsedMs: judged.elapsedMs,
          rawDescendantCount: judged.rawDescendantCount,
          missingPageControls: judged.pageControls.missing,
        },
        pageControls: judged.pageControls,
        observationEvidence: { target: (after ? null : beforeObs)?.result?.target ?? beforeObs?.result?.target ?? null, tree: { truncated: judged.truncated, nodeCount: judged.nodeCount, elapsedMs: judged.elapsedMs, rawDescendantCount: judged.rawDescendantCount } },
      };
    }, tasks);
    if (wantTask('chromium_set_text_and_readback')) await runTask('chromium_set_text_and_readback', async () => {
        const beforeObs = await observe(); const node = findNode(beforeObs, 'Web text input', 'set_value'); if (!node) return notAvailable('Web text input', beforeObs, 'set_value');
        const response = await act(beforeObs, node, 'set_value', { value: 'chromium-matrix-text' });
        const oracleResult = await waitOracle(oracle, run, (state) => pageAHasValue(state, 'chromium-matrix-text'), 3_000);
        const readbacks = [];
        // Reads only: never replay SetValue, even if its own outcome is unknown.
        for (const delayMs of [0, 250, 750]) {
          if (delayMs) await sleep(delayMs);
          const readback = await observe();
          const targetMatches = ['hwnd', 'pid', 'processStartTimeUtc', 'windowGeneration'].every(key => readback.result?.target?.[key] === beforeObs.result?.target?.[key]);
          const matchingNodes = nodesOf(readback).filter(item => item.automationId === 'web-input');
          const sameElement = matchingNodes.find(item => node.runtimeId?.length && JSON.stringify(item.runtimeId) === JSON.stringify(node.runtimeId) && item.actions?.includes('set_value'));
          readbacks.push({ delayMs, target: readback.result?.target, targetMatches, sameElementIdentity: !!sameElement, valueMatches: targetMatches && !!sameElement && sameElement.value === 'chromium-matrix-text', nodes: matchingNodes, error: readback.error });
        }
        return { ...classifyDispatchedTask({ helperResponse: response, applicationCompleted: oracleResult.pass }), readbacks, oracle: { ...oracleResult, application: applicationEvidence(oracleResult.state) } };
      }, tasks);
    if (wantTask('chromium_scroll_capability')) await runTask('chromium_scroll_capability', async () => {
        const beforeObs = await observe();
        const node = nodesOf(beforeObs).find(item => item.name === 'Web scroll region' && item.automationId === 'scroll' && item.actions?.includes('scroll') && item.patterns?.includes('Scroll') && item.runtimeId?.length);
        if (!node) return notAvailable('Web scroll region', beforeObs, 'directional_scroll');
        const beforeState = await oracleState(oracle, run);
        const beforeScrollTop = applicationEvidence(beforeState).scrollTopOnPageA;
        const requestEvidence = { target: beforeObs.result.target, snapshotId: beforeObs.result.snapshotId, element: node, op: 'scroll', direction: 'vertical', amount: 'large_increment' };
        const response = await act(beforeObs, node, 'scroll', { direction: 'vertical', amount: 'large_increment' });
        const oracleResult = await waitOracle(oracle, run, (state) => pageAScrolled(state, beforeScrollTop), 3_000);
        const usedScrollItemFallback = response.result?.outcome?.verification === 'scroll_item_dispatched';
        const readbacks = [];
        for (const delayMs of [0, 250, 750]) {
          if (delayMs) await sleep(delayMs);
          const requestedAt = Date.now();
          const observation = await observe();
          const targetMatches = ['hwnd', 'pid', 'processStartTimeUtc', 'windowGeneration'].every(key => observation.result?.target?.[key] === beforeObs.result?.target?.[key]);
          const sameElement = nodesOf(observation).find(item => node.runtimeId?.length && JSON.stringify(item.runtimeId) === JSON.stringify(node.runtimeId) && item.patterns?.includes('Scroll'));
          readbacks.push({ delayMs, requestedAt, receivedAt: Date.now(), targetMatches, sameElementIdentity: !!sameElement, scrollState: sameElement?.scrollState, error: observation.error });
        }
        return { ...classifyDispatchedTask({ helperResponse: response, applicationCompleted: oracleResult.pass && !usedScrollItemFallback }), requestEvidence, beforeScrollTop, usedScrollItemFallback, readbacks, oracle: { ...oracleResult, application: applicationEvidence(oracleResult.state) } };
      }, tasks);
    if (wantTask('chromium_semantic_click_and_status_readback')) await runTask('chromium_semantic_click_and_status_readback', async () => {
        const beforeObs = await observe();
        const node = nodesOf(beforeObs).find(item => item.name === 'Apply semantic click' && item.automationId === 'web-button' && item.actions?.includes('click_element') && item.patterns?.includes('Invoke') && item.runtimeId?.length);
        if (!node) return notAvailable('Apply semantic click', beforeObs, 'click_element');
        const beforeState = await oracleState(oracle, run);
        const beforeClickCount = applicationEvidence(beforeState).clickCountOnPageA;
        const requestEvidence = { target: beforeObs.result.target, snapshotId: beforeObs.result.snapshotId, element: node, op: 'click_element' };
        const response = await act(beforeObs, node, 'click_element');
        const oracleResult = await waitOracle(oracle, run, (state) => pageAClicked(state, beforeClickCount), 3_000);
        // Observe a short additional window for duplicate application effects;
        // never issue another click to make an unknown result look successful.
        await sleep(250);
        const settledState = await oracleState(oracle, run);
        const completed = oracleResult.pass && pageAClicked(settledState, beforeClickCount);
        return { ...classifyDispatchedTask({ helperResponse: response, applicationCompleted: completed }), requestEvidence, beforeClickCount, duplicateCheckMs: 250, oracle: { ...oracleResult, pass: completed, state: settledState, application: applicationEvidence(settledState) } };
      }, tasks);
    if (wantTask('chromium_compat_type_text_authorized')) await runTask('chromium_compat_type_text_authorized', async () => {
        const beforeObs = await observe(); const node = nodesOf(beforeObs).find(n => n.name === 'Compat text input' && n.automationId === 'compat-input' && n.runtimeId?.length && n.patterns?.includes('Value')); if (!node) return notAvailable('Compat text input', beforeObs, 'compat_type_text');
        const requestEvidence = { target: beforeObs.result.target, snapshotId: beforeObs.result.snapshotId, element: node, op: 'compat_type_text', value: 'compat-browser-text' };
        const response = await compatAct(beforeObs, node, 'compat_type_text', 'compat-browser-text');
        const oracleResult = await waitOracle(oracle, run, (state) => pageAHasCompatValue(state, 'compat-browser-text'), 3_000);
        const readbacks = [];
        for (const delayMs of [0, 250, 750]) {
          if (delayMs) await sleep(delayMs);
          const observed = await observe();
          const targetMatches = ['hwnd', 'pid', 'processStartTimeUtc', 'windowGeneration'].every(key => observed.result?.target?.[key] === beforeObs.result?.target?.[key]);
          const sameElement = nodesOf(observed).find(n => JSON.stringify(n.runtimeId) === JSON.stringify(node.runtimeId) && n.patterns?.includes('Value'));
          readbacks.push({ delayMs, targetMatches, sameElementIdentity: !!sameElement, value: sameElement?.value, error: observed.error });
        }
        return { ...classifyDispatchedTask({ helperResponse: response, applicationCompleted: oracleResult.pass }), requestEvidence, readbacks, oracle: { ...oracleResult, application: applicationEvidence(oracleResult.state) } };
      }, tasks);
    if (wantTask('chromium_compat_press_enter_authorized_navigation')) await runTask('chromium_compat_press_enter_authorized_navigation', async () => {
        const beforeObs = await observe(); const node = nodesOf(beforeObs).find(n => n.name === 'Compat text input' && n.automationId === 'compat-input' && n.runtimeId?.length && n.patterns?.includes('Value')); if (!node) return notAvailable('Compat text input', beforeObs, 'compat_press_enter');
        const beforeState = await oracleState(oracle, run);
        if (!pageAHasCompatValue(beforeState, 'compat-browser-text') || node.value !== 'compat-browser-text') return { executionState: 'blocked', contractConformance: 'not_tested', dispatched: false, reason: 'navigation_input_prerequisite_not_met', observationEvidence: { target: beforeObs.result.target, element: node }, oracle: beforeState };
        const requestEvidence = { target: beforeObs.result.target, snapshotId: beforeObs.result.snapshotId, element: node, op: 'compat_press_enter' };
        const binding = { run, value: 'compat-browser-text', sourceUrl: `http://127.0.0.1:${port}/page-a?run=${encodeURIComponent(run)}`, destinationUrl: `http://127.0.0.1:${port}/page-b?run=${encodeURIComponent(run)}` };
        const response = await compatAct(beforeObs, node, 'compat_press_enter');
        const oracleResult = await waitOracle(oracle, run, (state) => boundNavigationCompleted(state, binding), 8_000);
        await sleep(250);
        const settled = await oracleState(oracle, run);
        const completed = boundNavigationCompleted(settled, binding);
        return { ...classifyDispatchedTask({ helperResponse: response, applicationCompleted: completed }), requestEvidence, binding, duplicateCheckMs: 250, oracle: { ...oracleResult, pass: completed, state: settled, application: applicationEvidence(settled) } };
      }, tasks);
    padTasks(tasks); const executionState = tasks.some((task) => task.executionState === 'fail') ? 'fail' : tasks.some((task) => task.executionState === 'unknown') ? 'unknown' : tasks.some((task) => task.executionState === 'blocked') ? 'blocked' : 'pass';
    const contractConformance = tasks.some((task) => task.contractConformance === 'fail') ? 'fail' : tasks.every((task) => task.contractConformance === 'pass') ? 'pass' : 'not_tested';
    return { label, mode: mode.name, timing, chromeArgs: args, run, target, spawnPid, init: init.result ?? null, observations, rpcTrace: helper.rpcTrace, tasks, executionState, contractConformance, artifact: artifact(helperPath), durationMs: Date.now() - started, oracle: await oracleState(oracle, run) };
  } catch (error) {
    padTasks(tasks, error.reason ?? (timedOut ? 'harness_watchdog_timeout' : 'harness_setup_failed')); return { label, mode: mode.name, timing, chromeArgs: args, run, target, spawnPid: browser?.pid ?? null, observations, rpcTrace: helper?.rpcTrace ?? [], tasks, executionState: error.blocked || timedOut ? 'blocked' : 'fail', contractConformance: error.blocked || timedOut ? 'not_tested' : 'fail', error: timedOut ? 'harness_watchdog_timeout' : error.message, reason: error.reason, desktop: error.desktop, targetEvidence: error.targetEvidence, artifact: artifact(helperPath), durationMs: Date.now() - started, oracle: await oracleState(oracle, run) };
  } finally {
    clearTimeout(watchdog);
    await stopHelper(helper);
    const matching = () => profile ? pidsMatching((command) => command.includes(profile)) : [];
    const ownedPids = matching();
    killPids(ownedPids.includes(browser?.pid) ? [browser.pid] : ownedPids);
    await waitGone(matching, 8_000);
    if (matching().length > 0) killPids(matching());
    await waitGone(matching, 5_000);
    if (profile && matching().length === 0) { try { rmSync(profile, { recursive: true, force: true }); } catch {} }
  }
}

async function main() {
  await ensureSingleTestChrome();
  const oracle = startOracle(); runningOracle = oracle;
  const port = await oracle.ready; const subjects = completedSubjects;
  const helpers = oneHelper ? [firstHelper] : [firstHelper, secondHelper];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
  for (const [index, helper] of helpers.entries()) {
    for (const mode of modes) {
      await ensureSingleTestChrome();
      subjects.push(await runMode(helper, `subject-${index + 1}-repeat-${repetition}`, mode, oracle, port));
      await ensureSingleTestChrome();
    }
  }
  }
  await new Promise((resolveClose) => oracle.server.close(resolveClose));
  runningOracle = null;
  const allTasks = subjects.flatMap((subject) => subject.tasks ?? []); const count = (items, field) => ({ pass: items.filter((item) => item[field] === 'pass').length, fail: items.filter((item) => item[field] === 'fail').length, blocked: items.filter((item) => item[field] === 'blocked').length, unknown: items.filter((item) => item[field] === 'unknown').length, not_tested: items.filter((item) => item[field] === 'not_tested').length, total: items.length });
  const result = { schema: 'maka.cu.windows/browser-task-results/5', startedAt, finishedAt: new Date().toISOString(), host: { platform: process.platform, arch: process.arch, node: process.version }, fixture: artifact(pagePath), oracle: { bind: '127.0.0.1', port, independent: true, perPageEvidence: true }, observeOnly, modes: modes.map((mode) => ({ name: mode.name, args: mode.args })), subjects, summary: { subjects: { execution: count(subjects, 'executionState'), contractConformance: count(subjects, 'contractConformance') }, tasks: { execution: count(allTasks, 'executionState'), contractConformance: count(allTasks, 'contractConformance') } }, distributionReady: false };
  result.inputFingerprints = inputFingerprints;
  result.experiment = { preUiaMs, settleMs, repetitions };
  const { writeFileSync } = await import('node:fs'); writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  for (const subject of subjects) console.log(`${subject.executionState.toUpperCase()} ${subject.label}/${subject.mode} tasks=${(subject.tasks ?? []).filter((task) => task.executionState === 'pass').length}/${(subject.tasks ?? []).length}`);
  console.log(`RESULTS ${outputPath}`);
  process.exitCode = result.summary.subjects.execution.fail === 0 && result.summary.subjects.execution.blocked === 0 && result.summary.subjects.execution.unknown === 0 ? 0 : 1;
}
main().catch(async (error) => {
  console.error(error.message);
  if (runningOracle) {
    runningOracle.server.closeAllConnections();
    await new Promise(resolveClose => runningOracle.server.close(resolveClose));
  }
  const { writeFileSync } = await import('node:fs');
  writeFileSync(outputPath, `${JSON.stringify({ schema: 'maka.cu.windows/browser-task-results/5', startedAt, finishedAt: new Date().toISOString(), inputFingerprints, harnessError: error.message, reason: error.reason, desktop: error.desktop, subjects: completedSubjects, executionState: error.blocked ? 'blocked' : 'fail', distributionReady: false }, null, 2)}\n`);
  process.exitCode = 1;
});
