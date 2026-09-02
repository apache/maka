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

// Lifecycle driver for the maka-cu-windows spike (checks 4-6 + identity +
// parent-death), per the updated apache/maka#4318. Requires the built helper
// exe and the built fixture exe:
//
//   node lifecycle-driver.mjs <helper-exe> <fixture-exe>
//
// Scenarios (each prints PASS/FAIL):
//   C4   WGC CreateForWindow capture + occlusion (cover must not leak pixels)
//   C5a  cancellation after dispatch: request settles with actual outcome
//   C5b  cancellation before dispatch: deterministic via debug_sleep queueing,
//        typed cancelled outcome, no mutation (textbox stays empty)
//   C5c  control plane responsive while provider call blocked (frozen fixture)
//   C6   hung-provider recovery: supervisor kills helper, restart advances
//        generation, old snapshots invalid, fresh observe/act/readback works
//   ID   window recreation -> old snapshot fails closed (stale target)
//   PD   parent death: abrupt kill and stdin-EOF both exit the helper within
//        the declared deadline

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const helperExe = process.argv[2];
const fixtureExe = process.argv[3];
if (!helperExe || !fixtureExe) {
  console.error('usage: node lifecycle-driver.mjs <helper-exe> <fixture-exe>');
  process.exit(2);
}

const HANDSHAKE_MS = 10000;
const REQUEST_MS = 20000;
const CANCEL_GRACE_MS = 2000;
const FIXTURE_TITLE = 'maka-cu-windows-fixture';

const report = [];
let failures = 0;
const ownedHelpers = new Set();
const ownedFixtures = new Set();
const check = (name, ok, note = '') => {
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? '  — ' + note : ''}`);
  if (!ok) failures++;
};

function makeHelper() {
  const child = spawn(helperExe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  ownedHelpers.add(child);
  child.once('exit', () => ownedHelpers.delete(child));
  const rl = createInterface({ input: child.stdout });
  let nextId = 1;
  const pending = new Map();
  rl.on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg);
      pending.delete(msg.id);
    }
  });
  child.on('exit', (code, signal) => {
    for (const { reject } of pending.values()) reject(new Error(`helper exited code=${code} signal=${signal ?? 'none'}`));
    pending.clear();
  });
  const call = (method, params = {}, timeoutMs = REQUEST_MS) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      if (child.stdin.destroyed) { reject(new Error('stdin closed')); return; }
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
    });
  const kill = async (label, deadlineMs = CANCEL_GRACE_MS) => {
    const t0 = Date.now();
    const exited = new Promise((res) => child.once('exit', (code) => res(code)));
    child.kill();
    const code = await Promise.race([exited, new Promise((res) => setTimeout(() => res('timeout'), deadlineMs + 3000))]);
    return { code, elapsedMs: Date.now() - t0 };
  };
  return { child, call, kill, nextId: () => nextId };
}

function makeFixture() {
  const child = spawn(fixtureExe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  ownedFixtures.add(child);
  child.once('exit', () => ownedFixtures.delete(child));
  const rl = createInterface({ input: child.stdout });
  let size = null;
  let captureSize = null;
  let identity = null;
  let firstReady;
  const ready = new Promise((res) => { firstReady = res; });
  const sizeP = new Promise((res) => {
    const check = () => { if (size) res(size); };
    child.on('fixture-size', check);
  });
  const captureSizeP = new Promise((res) => {
    const check = () => { if (captureSize) res(captureSize); };
    child.on('fixture-capture-size', check);
  });
  const lineWaiters = [];
  const newIdentityWaiters = [];
  rl.on('line', (l) => {
    const m = l.match(/^READY (\d+) (\d+)$/);
    if (m) {
      const next = { pid: +m[1], hwnd: +m[2] };
      const previous = identity;
      identity = next;
      if (!previous) firstReady(next);
      for (let i = newIdentityWaiters.length - 1; i >= 0; i--) {
        if (!previous || next.hwnd === previous.hwnd) continue;
        const waiter = newIdentityWaiters.splice(i, 1)[0];
        waiter(next);
      }
    }
    const sm = l.match(/^SIZE (\d+) (\d+)/);
    if (sm) {
      size = { w: +sm[1], h: +sm[2] };
      child.emit('fixture-size');
    }
    const cm = l.match(/^CAPTURE_SIZE (\d+) (\d+)/);
    if (cm) {
      captureSize = { w: +cm[1], h: +cm[2] };
      child.emit('fixture-capture-size');
    }
    for (let i = lineWaiters.length - 1; i >= 0; i--) {
      if (!l.startsWith(lineWaiters[i].prefix)) continue;
      const waiter = lineWaiters.splice(i, 1)[0];
      waiter.resolve(l);
    }
  });
  const waitForLine = (prefix, timeoutMs = 3000) => new Promise((resolve, reject) => {
    const waiter = { prefix, resolve, reject };
    lineWaiters.push(waiter);
    setTimeout(() => {
      const i = lineWaiters.indexOf(waiter);
      if (i >= 0) { lineWaiters.splice(i, 1); reject(new Error(`fixture ACK timeout: ${prefix}`)); }
    }, timeoutMs);
  });
  const waitForNewIdentity = (oldHwnd, timeoutMs = 5000) => new Promise((resolve, reject) => {
    const waiter = (next) => { if (next.hwnd !== oldHwnd) resolve(next); };
    newIdentityWaiters.push(waiter);
    setTimeout(() => {
      const i = newIdentityWaiters.indexOf(waiter);
      if (i >= 0) { newIdentityWaiters.splice(i, 1); reject(new Error('fixture recreate READY timeout')); }
    }, timeoutMs);
  });
  const cmd = async (c) => {
    if (c === 'shutdown') { child.stdin.write(c + '\n'); return null; }
    const expected = { freeze: 'FROZEN', unfreeze: 'UNFROZEN', cover: 'COVERED', uncover: 'UNCOVERED' }[c];
    const ack = expected ? waitForLine(expected) : null;
    const recreated = c === 'recreate' ? waitForNewIdentity(identity?.hwnd) : null;
    child.stdin.write(c + '\n');
    if (recreated) { identity = await recreated; return identity; }
    if (ack) await ack;
    return null;
  };
  return { child, ready, size: () => size, captureSize: () => captureSize, identity: () => identity, sizeP, captureSizeP, cmd, waitForNewIdentity };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sleep = wait;

function findNode(tree, pred) {
  return (tree?.nodes ?? []).find(pred);
}
async function findFixture(h, identity, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    const listed = await h.call('list_windows');
    const found = (listed.result?.windows ?? []).find((w) =>
      w.title === FIXTURE_TITLE && w.pid === identity.pid && w.hwnd === identity.hwnd);
    if (found) return found;
    await sleep(100);
  }
  return null;
}
function decodePng(frame) {
  const b = Buffer.from(frame.base64, 'base64');
  if (!b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  let width = 0, height = 0, colorType = 0, bitDepth = 0;
  const idat = [];
  for (let p = 8; p + 12 <= b.length;) {
    const n = b.readUInt32BE(p); const type = b.toString('ascii', p + 4, p + 8);
    const data = b.subarray(p + 8, p + 8 + n); p += n + 12;
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    if (type === 'IDAT') idat.push(data);
  }
  if (bitDepth !== 8 || colorType !== 6 || width <= 0 || height <= 0) return null;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  let green = 0;
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    if (raw[row] !== 0) return null; // this spike encoder deliberately uses filter 0
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 4;
      if (raw[i] >= 35 && raw[i] <= 70 && raw[i + 1] >= 185 && raw[i + 1] <= 220 && raw[i + 2] >= 35 && raw[i + 2] <= 70 && raw[i + 3] >= 240) green++;
    }
  }
  return { width, height, sentinelPixels: green };
}
// Cached render nodes carry no patterns/value; the actionable live nodes do.
const inputNode = (tree) => findNode(tree, (n) => n.automationId === 'fixture-input' && (n.patterns?.length ?? 0) > 0);

try {
  // ---- fixture up ---------------------------------------------------------
  const fx = makeFixture();
  const fixtureIdentity = await fx.ready;
  await fx.sizeP;
  await fx.captureSizeP;
  check('fixture ready', fx.size() !== null && fx.captureSize() !== null && fixtureIdentity.hwnd > 0, `pid=${fixtureIdentity.pid} hwnd=#${fixtureIdentity.hwnd} outer=${fx.size().w}x${fx.size().h} capture=${fx.captureSize().w}x${fx.captureSize().h}`);

  // ---- helper up ----------------------------------------------------------
  const h1 = makeHelper();
  const hello = await h1.call('initialize', {}, HANDSHAKE_MS);
  const gen1 = hello.result?.generation;
  check('initialize', hello.result?.protocol === 'maka.cu.windows/0', `generation=${gen1} signature=${hello.result?.signature} ready=${hello.result?.distributionReady}`);

  const list = await h1.call('list_windows');
  const fxWin = (list.result?.windows ?? []).find((w) => w.title === FIXTURE_TITLE && w.pid === fixtureIdentity.pid && w.hwnd === fixtureIdentity.hwnd);
  check('list_windows finds fixture', !!fxWin, fxWin ? `hwnd=#${fxWin.hwnd}` : 'not found');
  if (!fxWin) { await h1.child.kill(); process.exit(1); }

  const obs1 = await h1.call('observe', { hwnd: fxWin.hwnd });
  check('observe fixture', !obs1.error, obs1.error?.message ?? `nodes=${obs1.result.tree.nodeCount}`);
  const snap1 = obs1.result.snapshotId;
  const target1 = obs1.result.target;
  const gen1w = target1.windowGeneration;
  check('target identity (hwnd+pid+start+windowGeneration)', !!target1.processStartTimeUtc && typeof gen1w === 'string' && gen1w.length === 16, JSON.stringify(target1));
  const inputNode1 = inputNode(obs1.result.tree);
  check('fixture textbox actionable (ValuePattern)', !!inputNode1 && inputNode1.patterns?.includes('Value'), inputNode1?.controlType ?? 'missing');

  // ---- C4: WGC capture + occlusion ----------------------------------------
  const cap0 = await h1.call('capture', { hwnd: fxWin.hwnd, windowGeneration: gen1w });
  const c0 = cap0.result;
  const baselineFrame = c0?.frame;
  const baselinePng = baselineFrame ? decodePng(baselineFrame) : null;
  const sizeMatch0 = c0?.frame?.width === fx.captureSize().w && c0?.frame?.height === fx.captureSize().h;
  check('C4 capture CreateForWindow', c0?.status === 'available' && c0?.path === 'wgc_createforwindow', `response=${JSON.stringify(cap0)} path=${c0?.path} size=${c0?.frame?.width}x${c0?.frame?.height} bytes=${c0?.frame?.bytes} elapsed=${c0?.frame?.elapsedMs}ms`);
  check('C4 frame is PNG base64', c0?.frame?.format === 'png' && typeof c0?.frame?.base64 === 'string' && Buffer.from(c0.frame.base64, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `format=${c0?.frame?.format} payload=${c0?.frame?.base64?.length ?? 0}`);
  check('C4 frame size == DWM capture bounds', sizeMatch0, `capture=${c0?.frame?.width}x${c0?.frame?.height} expected=${fx.captureSize().w}x${fx.captureSize().h} outer=${fx.size().w}x${fx.size().h}`);
  check('C4 decoded PNG contains fixture sentinel', !!baselinePng && baselinePng.sentinelPixels > 500, baselinePng ? `${baselinePng.width}x${baselinePng.height} sentinelPixels=${baselinePng.sentinelPixels}` : 'PNG decode failed');

  if (baselineFrame) {
    await fx.cmd('cover');
    const cap1 = await h1.call('capture', { hwnd: fxWin.hwnd, windowGeneration: gen1w });
    const c1 = cap1.result;
    const coveredPng = c1?.frame ? decodePng(c1.frame) : null;
    const occluded = c1?.status === 'available' && c1?.frame && coveredPng && baselinePng
      && c1.frame.width === baselineFrame.width && c1.frame.height === baselineFrame.height
      && coveredPng.sentinelPixels === baselinePng.sentinelPixels;
    check('C4 occlusion: cover does not leak pixels', occluded,
      `size=${c1?.frame?.width}x${c1?.frame?.height} sentinel=${coveredPng?.sentinelPixels ?? 'decode-failed'} baseline=${baselinePng?.sentinelPixels ?? 'decode-failed'} (stable fixture pixels)`);
    await fx.cmd('uncover');
    const cap2 = await h1.call('capture', { hwnd: fxWin.hwnd, windowGeneration: gen1w });
    const afterPng = cap2.result?.frame ? decodePng(cap2.result.frame) : null;
    check('C4 capture stable after uncover', !!afterPng && afterPng.sentinelPixels === baselinePng?.sentinelPixels, `sentinel=${afterPng?.sentinelPixels ?? 'decode-failed'} baseline=${baselinePng?.sentinelPixels ?? 'decode-failed'}`);
  } else {
    check('C4 occlusion: cover does not leak pixels', false, 'baseline capture unavailable; occlusion not exercised');
  }

  // ---- C5a: cancellation after dispatch settles with actual outcome --------
  // The fixture-only delay begins after ValuePattern.SetValue and readback,
  // making this a real in-flight post-dispatch cancellation.
  const setRequestId = h1.nextId();
  const setP = h1.call('act', { snapshotId: snap1, elementToken: inputNode1.token, op: 'set_value', value: 'settled-1', debugPostDispatchDelayMs: 700 });
  await sleep(120);
  const cancelAfterDispatch = await h1.call('$/cancel', { id: setRequestId });
  check('C5a $/cancel reaches in-flight op', cancelAfterDispatch.result?.cancelled === true && cancelAfterDispatch.result?.pendingRequestId !== null, `pending=${cancelAfterDispatch.result?.pendingRequestId}`);
  const setRes = await setP;
  const sOut = setRes.result?.outcome;
  check('C5a original request settles actual outcome', sOut?.status === 'verified' && sOut?.verification === 'value_readback_match' && sOut?.effect === 'value_set', `status=${sOut?.status} verification=${sOut?.verification} effect=${sOut?.effect}`);
  const obsAfter = await h1.call('observe', { hwnd: fxWin.hwnd });
  const inputAfter = inputNode(obsAfter.result.tree);
  check('C5a mutation visible via readback', inputAfter?.value === 'settled-1', `value="${inputAfter?.value}"`);
  const snapA = obsAfter.result.snapshotId;
  const inputA = inputAfter;

  // ---- C5b: cancellation before dispatch (deterministic) -------------------
  // Block the lane briefly with debug_sleep, queue an act behind it, cancel.
  const sleepP = h1.call('debug_sleep', { ms: 500 });
  await sleep(120); // ensure debug_sleep is running on the lane
  const actRequestId = h1.nextId();
  const actP = h1.call('act', { snapshotId: snapA, elementToken: inputA.token, op: 'set_value', value: 'mutated?' });
  await sleep(80);
  const cancelBusy = await h1.call('$/cancel', { id: actRequestId });
  check('C5b $/cancel while op queued', cancelBusy.result?.cancelled === true && cancelBusy.result?.pendingRequestId !== null, `pending=${cancelBusy.result?.pendingRequestId}`);
  const actSettled = await actP;
  const actOut = actSettled.result?.outcome;
  check('C5b queued act settles refused (cancelled before dispatch)', actOut?.status === 'refused' && actOut?.reason === 'cancelled_before_dispatch', `status=${actOut?.status} reason=${actOut?.reason}`);
  await sleepP;
  const obsNoMut = await h1.call('observe', { hwnd: fxWin.hwnd });
  const inputNoMut = inputNode(obsNoMut.result.tree);
  check('C5b no mutation occurred', inputNoMut?.value === 'settled-1', `value="${inputNoMut?.value}" (must remain settled-1)`);

  // ---- C5c + C6: blocked provider -> cancel grace -> kill -> restart --------
  const preHang = await h1.call('observe', { hwnd: fxWin.hwnd });
  const preHangInput = inputNode(preHang.result.tree);
  await fx.cmd('freeze'); // FROZEN is emitted after the UI thread enters wait
  let blockedSettled = false;
  const blockedObs = h1.call('observe', { hwnd: fxWin.hwnd }).then((v) => { blockedSettled = true; return v; }, (e) => { blockedSettled = true; return e; });
  await sleep(400);
  const tCancel = Date.now();
  const cancelBlocked = await h1.call('$/cancel');
  check('C5c control plane responsive while provider blocked', cancelBlocked.result?.cancelled === true && Date.now() - tCancel < CANCEL_GRACE_MS, `ack in ${Date.now() - tCancel}ms`);
  // blocked observe cannot settle within grace -> supervisor terminates helper
  await sleep(CANCEL_GRACE_MS);
  check('C6 blocked request remains unsettled through grace', !blockedSettled, `settled=${blockedSettled}`);
  let fixtureAliveDuringHang = false;
  try { process.kill(fixtureIdentity.pid, 0); fixtureAliveDuringHang = true; } catch {}
  check('C6 target fixture survives blocked helper', fixtureAliveDuringHang, `pid=${fixtureIdentity.pid}`);
  const killed = await h1.kill('hung-helper');
  check('C6 helper terminated after cancel grace', killed.code !== 'timeout', `exit=${killed.code} in ${killed.elapsedMs}ms`);
  await blockedObs;
  await fx.cmd('unfreeze');

  // restart: generation advances, old snapshot invalid, fresh work succeeds
  const h2 = makeHelper();
  const hello2 = await h2.call('initialize', {}, HANDSHAKE_MS);
  const gen2 = hello2.result?.generation;
  check('C6 restart advances helper generation', gen2 !== gen1, `gen ${gen1} -> ${gen2}`);
  const obsOld = await h2.call('act', { snapshotId: preHang.result.snapshotId, elementToken: preHangInput.token, op: 'set_value', value: 'x' });
  check('C6 old snapshot invalid after restart', obsOld.error?.message === 'snapshot_spent_or_unknown', obsOld.error?.message ?? 'accepted(!)');
  const list2 = await h2.call('list_windows');
  const fxWin2 = (list2.result?.windows ?? []).find((w) => w.title === FIXTURE_TITLE && w.pid === fixtureIdentity.pid && w.hwnd === fixtureIdentity.hwnd);
  const obs2 = await h2.call('observe', { hwnd: fxWin2.hwnd });
  const input2 = inputNode(obs2.result.tree);
  const act2 = await h2.call('act', { snapshotId: obs2.result.snapshotId, elementToken: input2.token, op: 'set_value', value: 'after-restart' });
  check('C6 fresh observe/act/readback after restart', act2.result?.outcome?.status === 'verified' && act2.result?.outcome?.verification === 'value_readback_match', `status=${act2.result?.outcome?.status}`);
  const obs2b = await h2.call('observe', { hwnd: fxWin2.hwnd });
  const input2b = inputNode(obs2b.result.tree);
  const mixedToken = await h2.call('act', { snapshotId: obs2b.result.snapshotId, elementToken: input2.token, op: 'set_value', value: 'must-refuse' });
  check('C6 cross-snapshot token fails closed', mixedToken.error?.message === 'element_token_unknown_in_snapshot', mixedToken.error?.message ?? 'accepted(!)');

  // ---- ID: window recreation fails closed ----------------------------------
  const obsId = await h2.call('observe', { hwnd: fxWin2.hwnd });
  const snapId3 = obsId.result.snapshotId;
  const input3 = inputNode(obsId.result.tree);
  const oldHwnd = fixtureIdentity.hwnd;
  await fx.cmd('recreate');
  const recreatedIdentity = fx.identity();
  check('ID recreate returned a different HWND', recreatedIdentity.pid === fixtureIdentity.pid && recreatedIdentity.hwnd !== oldHwnd, `old=#${oldHwnd} new=#${recreatedIdentity.hwnd}`);
  const act3 = await h2.call('act', { snapshotId: snapId3, elementToken: input3.token, op: 'set_value', value: 'should-fail' });
  check('ID window recreation -> stale target fails closed', act3.error?.message === 'stale_target_revalidate_failed', act3.error?.message ?? 'accepted(!)');
  const fxWin3 = await findFixture(h2, recreatedIdentity);
  check('ID recreated fixture remains alive', !!fxWin3, fxWin3 ? `hwnd=#${fxWin3.hwnd}` : 'not found');
  const obs3 = fxWin3 ? await h2.call('observe', { hwnd: fxWin3.hwnd }) : { error: { message: 'fixture_not_found' } };
  check('ID new window requires new explicit selection', !obs3.error && obs3.result.snapshotId !== snapId3, `new snapshot=${obs3.result?.snapshotId !== snapId3}`);

  // ---- PD: parent death ----------------------------------------------------
  const shutdown2 = await h2.call('shutdown');
  check('PD setup helper shutdown', shutdown2.result?.ok === true);
  await new Promise((res) => h2.child.once('exit', res));
  // Run the helper under a short-lived host process. That host starts a real
  // blocked observe, then exits abruptly; this driver only observes helper
  // disappearance and never kills that helper PID itself.
  await fx.cmd('freeze');
  const probePath = fileURLToPath(new URL('./parent-probe.mjs', import.meta.url));
  const probe = spawn(process.execPath, [probePath, helperExe, String(fxWin3.hwnd)], { stdio: ['ignore', 'pipe', 'inherit'] });
  let probeOutput = '';
  probe.stdout.on('data', (b) => { probeOutput += b.toString(); });
  const probeExit = await new Promise((res) => probe.once('exit', (c) => res(c)));
  const helperPidMatch = probeOutput.match(/HELPER (\d+)/);
  const abruptPid = helperPidMatch ? Number(helperPidMatch[1]) : null;
  let abruptAlive = abruptPid !== null;
  const pdStart = Date.now();
  while (abruptAlive && Date.now() - pdStart < CANCEL_GRACE_MS + 1500) {
    try { process.kill(abruptPid, 0); await sleep(100); } catch { abruptAlive = false; }
  }
  check('PD probe observed handshake and blocked observe', probeExit === 77 && /HOST_STAGE initialized/.test(probeOutput) && /HOST_STAGE observe_sent/.test(probeOutput), `hostExit=${probeExit} stages=${probeOutput.replaceAll('\\n', ' ').trim()}`);
  check('PD abrupt host death exits blocked helper', probeExit === 77 && !abruptAlive, `helper=${abruptPid ?? 'unknown'} residual=${abruptAlive} elapsed=${Date.now() - pdStart}ms`);
  await fx.cmd('unfreeze');
  const h3 = makeHelper();
  await h3.call('initialize', {}, HANDSHAKE_MS);
  const eofBefore = Date.now();
  h3.child.stdin.end();
  const eofExit = await new Promise((res) => { h3.child.once('exit', (c) => res(c)); setTimeout(() => res('timeout'), CANCEL_GRACE_MS + 2000); });
  check('PD stdin EOF exits helper within deadline', eofExit !== 'timeout', `exit=${eofExit} in ${Date.now() - eofBefore}ms`);

  // ---- shutdown ------------------------------------------------------------
  fx.cmd('shutdown');
  await new Promise((r) => { fx.child.once('exit', r); setTimeout(r, 3000); });
} catch (err) {
  check('lifecycle driver flow', false, err.message);
}

// Every run owns only this fixture and its helpers. Clean up even when a
// capture/provider call aborts the flow, so a failed experiment cannot leave
// an executable locked or a visible fixture behind.
for (const child of [...ownedHelpers, ...ownedFixtures]) {
  if (!child.killed) child.kill();
}

console.log('\n--- lifecycle spike report ---');
for (const line of report) console.log(line);
console.log(`failures=${failures}`);
process.exitCode = failures > 0 ? 1 : 0;
