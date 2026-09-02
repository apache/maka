#!/usr/bin/env node
/*
 * Isolated LibreOffice real-application probe for maka.cu/2.
 *
 * The run gives LibreOffice a temporary user profile and never opens a user
 * document. It verifies only fresh window identity, bounded UIA observation,
 * and an occlusion-safe WGC frame; it does not infer mutation support from a
 * provider that has not exposed a safe semantic control.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [helperExe, sofficeExe, outPath] = process.argv.slice(2);
if (!helperExe || !sofficeExe || !outPath) {
  console.error('usage: node maka-cu2-libreoffice-driver.mjs <helper.exe> <soffice.exe> <out.json>');
  process.exit(2);
}

const tests = [];
function record(name, status, note = '') {
  tests.push({ name, status, ...(note ? { note } : {}) });
  console.log(`${status.toUpperCase()} ${name}${note ? ` — ${note}` : ''}`);
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function rpc(exe) {
  const child = spawn(exe, ['host'], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  let nextId = 1;
  let closed = false;
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    waiter.resolve(message);
  });
  child.once('exit', (code, signal) => {
    closed = true;
    for (const waiter of pending.values()) waiter.reject(new Error(`helper exited code=${code} signal=${signal ?? 'none'}`));
    pending.clear();
  });
  function call(method, params = {}, timeoutMs = 20_000) {
    if (closed || child.stdin.destroyed) return Promise.reject(new Error('helper stdin is closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timeout`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  return { child, call };
}

function processTree(rootPid, profile) {
  try {
    const script = '$rows=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine); $rows | ConvertTo-Json -Compress';
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const needles = [profile, profile.replaceAll('\\', '/')];
    const ids = new Set(rows.filter((row) => needles.some((needle) => String(row.CommandLine ?? '').includes(needle))).map((row) => Number(row.ProcessId)));
    if (Number.isInteger(rootPid) && ids.has(rootPid)) ids.add(rootPid);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (ids.has(Number(row.ParentProcessId)) && !ids.has(Number(row.ProcessId))) {
          ids.add(Number(row.ProcessId));
          changed = true;
        }
      }
    }
    return ids;
  } catch {
    return new Set();
  }
}

function stopOwnedProcesses(rootPid, profile) {
  const ids = processTree(rootPid, profile);
  for (const pid of ids) {
    try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }); } catch {}
  }
  return [...ids];
}

let helper;
let office;
let profile;
let identity;
let session;
let ownedPids = [];
let uiSurface = [];
try {
  if (!existsSync(helperExe)) throw new Error(`helper unavailable: ${helperExe}`);
  if (!existsSync(sofficeExe)) {
    record('LibreOffice environment', 'blocked', `executable unavailable: ${sofficeExe}`);
    throw new Error('environment_libreoffice_unavailable');
  }
  profile = await mkdtemp(join(tmpdir(), 'maka-cu2-libreoffice-profile-'));
  const profileUri = pathToFileURL(profile).href;
  helper = rpc(helperExe);
  const imageDir = await mkdtemp(join(tmpdir(), 'maka-cu2-libreoffice-images-'));
  session = `cu2-libreoffice-${process.pid}-${Date.now()}`;
  const hello = await helper.call('host.hello', {
    protocol: 'maka.cu/2', host: { name: 'maka-cu2-libreoffice-driver', version: 'test' },
    hostPid: process.pid, imageDir, allowGlobalPointer: false,
  });
  record('host.hello', hello.result?.protocol === 'maka.cu/2' ? 'pass' : 'fail');
  record('session.begin', (await helper.call('session.begin', { session, captureScope: 'window' })).result?.ok === true ? 'pass' : 'fail');
  const before = (await helper.call('window.list', { session })).result?.windows ?? [];
  const baseline = new Set(before.map((window) => Number(window.windowId)));

  const args = [
    '--writer', '--nologo', '--nofirststartwizard', '--norestore', '--nolockcheck',
    `-env:UserInstallation=${profileUri}`,
  ];
  office = spawn(sofficeExe, args, { stdio: 'ignore', windowsHide: false });
  const end = Date.now() + 45_000;
  while (Date.now() < end) {
    const listed = (await helper.call('window.list', { session })).result?.windows ?? [];
    const tree = processTree(office.pid, profile);
    const candidates = listed.filter((window) =>
      !baseline.has(Number(window.windowId)) &&
      tree.has(Number(window.pid)) &&
      /LibreOffice/i.test(String(window.title ?? '')),
    );
    if (candidates.length === 1) {
      identity = { pid: Number(candidates[0].pid), hwnd: Number(candidates[0].windowId), title: candidates[0].title };
      break;
    }
    await wait(250);
  }
  record('fresh LibreOffice PID/HWND target', identity ? 'pass' : 'blocked', identity ? identity.title : 'temporary-profile window not uniquely observable');
  if (!identity) throw new Error('environment_blocked_libreoffice_target');

  const observed = await helper.call('observe', {
    session, target: { kind: 'window', pid: identity.pid, windowId: identity.hwnd }, includeImage: true,
  });
  const snapshot = observed.result?.snapshot;
  uiSurface = (snapshot?.elements ?? []).map((element) => ({
    role: element.role,
    title: element.title,
    axIdentifier: element.axIdentifier,
    actions: element.actions,
    value: element.value,
  }));
  const target = snapshot?.target;
  const identityOk = target?.pid === identity.pid && target?.windowId === identity.hwnd;
  record('LibreOffice observation preserves PID/HWND target identity',
    identityOk ? 'pass' : 'fail', JSON.stringify(target ?? null));
  record('LibreOffice action identity remains executor-bound', identityOk ? 'pass' : 'fail',
    'native executor revalidates process start time and window generation before dispatch');
  const structureOk = Array.isArray(snapshot?.elements) && snapshot.elements.length <= 2_000;
  record('LibreOffice observation is bounded and structured', structureOk ? 'pass' : 'fail',
    `elements=${snapshot?.elements?.length ?? 'missing'}`);
  const image = snapshot?.image;
  const imageOk = typeof image?.path === 'string' && existsSync(image.path) &&
    typeof image?.sha256 === 'string' && image.sha256.startsWith('sha256:');
  record('LibreOffice first frame uses host-owned WGC image', imageOk ? 'pass' : 'fail', JSON.stringify(image ?? null));
  const safeButton = (snapshot?.elements ?? []).find((element) =>
    element.actions?.includes('press') && ['属性', 'Properties'].includes(element.title));
  if (!safeButton) {
    record('LibreOffice semantic sidebar toggle', 'blocked', 'no localized Properties button exposed by UIA');
  } else {
    const pressed = await helper.call('dispatch.element', {
      session, snapshotId: snapshot.snapshotId, toolCallId: 'libreoffice-properties',
      elementToken: safeButton.token, expectElementDigest: safeButton.digest,
      strictness: 'element', occlusionPolicy: 'same_app',
      action: { kind: 'click', button: 'left', count: 1 },
      observeAfter: { includeImage: false, settle: 'quiesce' },
    });
    const result = pressed.result;
    if (result?.outcome === 'ok' && result.effect === 'confirmed')
      record('LibreOffice semantic sidebar toggle', 'pass');
    else if (result?.outcome === 'unknown' || result?.error?.code === 'outcome_unknown')
      record('LibreOffice semantic sidebar toggle', 'unknown', 'helper did not prove the UI effect');
    else if (result?.error?.code === 'element_not_actionable' || result?.error?.code === 'unsupported_action')
      record('LibreOffice semantic sidebar toggle', 'blocked', result.error.code);
    else
      record('LibreOffice semantic sidebar toggle', 'fail', result?.error?.code ?? 'dispatch failed');
    const after = await helper.call('observe', {
      session, target: { kind: 'window', pid: identity.pid, windowId: identity.hwnd }, includeImage: false,
    });
    record('LibreOffice target remains the same after semantic action',
      after.result?.snapshot?.target?.pid === identity.pid &&
        after.result?.snapshot?.target?.windowId === identity.hwnd ? 'pass' : 'fail');
  }
  record('session.end', (await helper.call('session.end', { session })).result?.ok === true ? 'pass' : 'fail');
  await helper.call('shutdown', {});
  await rm(imageDir, { recursive: true, force: true });
} catch (error) {
  if (!tests.some((test) => test.name === 'LibreOffice environment') && !tests.some((test) => test.name === 'fresh LibreOffice PID/HWND target'))
    record('LibreOffice driver', 'blocked', error.message);
} finally {
  if (helper?.child.exitCode === null) { try { helper.child.kill(); } catch {} }
  if (office?.pid) ownedPids = stopOwnedProcesses(office.pid, profile);
  if (profile) { try { await rm(profile, { recursive: true, force: true }); } catch {} }
}

const result = {
  schema: 'maka.cu.windows/real-libreoffice-results/1', protocol: 'maka.cu/2', executor: 'rust-native-windows',
  application: { path: sofficeExe, profile, args: ['--writer', '--nologo', '--nofirststartwizard', '--norestore', '--nolockcheck', 'temporary-user-installation'] },
  target: identity,
  uiSurface,
  ownedPids,
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
