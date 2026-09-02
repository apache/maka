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

// Small, measurement-only maka.cu/2 driver. It owns the WPF fixture and never
// attaches to a user browser or document. A cold handshake includes spawning
// the helper and waiting for host.hello; firstFrame includes the observe RPC
// and reading the host-owned image from disk.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [helperExe, fixtureExe, ...rest] = process.argv.slice(2);
const outIndex = rest.indexOf('--out');
const outputPath = outIndex >= 0 ? rest[outIndex + 1] : null;
if (!helperExe || !fixtureExe || (outIndex >= 0 && !outputPath)) {
  console.error('usage: node maka-cu2-performance-driver.mjs <helper.exe> <fixture.exe> [--out results.json]');
  process.exit(2);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function workingSetBytes(pid) {
  const result = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const line = result.stdout.trim().split(/\r?\n/).find((value) => value.includes(`"${pid}"`));
  if (!line) return null;
  const fields = line.match(/"(?:[^"]|"")*"/g)?.map((field) => field.slice(1, -1).replace(/""/g, '"'));
  const memory = fields?.at(-1)?.replace(/[^0-9]/g, '');
  return memory ? Number(memory) * 1024 : null;
}

function rpc(exe) {
  const child = spawn(exe, ['host'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  let nextId = 1;
  let closed = false;
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } catch {
      // stdout is expected to be JSON only; malformed lines are ignored here
      // and the request deadline reports the failure.
    }
  });
  child.once('exit', (code, signal) => {
    closed = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`helper exited code=${code} signal=${signal ?? 'none'}`));
    }
    pending.clear();
  });
  function call(method, params = {}, timeoutMs = 20_000) {
    if (closed || child.stdin.destroyed) return Promise.reject(new Error('helper stdin is closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  return { child, call };
}

function fixture(exe) {
  const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
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
    shutdown() {
      if (!child.stdin.destroyed) {
        child.stdin.write('shutdown\n');
        child.stdin.end();
      }
    },
  };
}

async function close(child) {
  if (!child || child.exitCode !== null) return;
  child.stdin?.end();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    wait(2_000),
  ]);
  if (child.exitCode === null) child.kill();
}

function requestShutdown(client) {
  if (!client.child.stdin.destroyed) {
    // The helper intentionally exits immediately after queuing the bounded
    // shutdown response. This measurement does not need that response; wait
    // for the process exit so an stdout flush race cannot become a benchmark
    // failure. A non-zero exit is still observed by close()/the caller.
    client.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 999999, method: 'shutdown', params: {} })}\n`);
  }
}

async function coldHandshake(run, imageDir) {
  const started = performance.now();
  const client = rpc(helperExe);
  let hello;
  try {
    hello = await client.call('host.hello', {
      protocol: 'maka.cu/2',
      host: { name: 'maka-cu2-performance-driver', version: 'test' },
      hostPid: process.pid,
      imageDir,
      allowGlobalPointer: false,
    });
    const elapsedMs = Number((performance.now() - started).toFixed(3));
    const workingSet = workingSetBytes(client.child.pid);
    const shutdownStarted = performance.now();
    requestShutdown(client);
    await close(client.child);
    return {
      run,
      helperPid: client.child.pid,
      helloOk: hello.result?.protocol === 'maka.cu/2',
      handshakeMs: elapsedMs,
      workingSetBytes: workingSet,
      shutdownMs: Number((performance.now() - shutdownStarted).toFixed(3)),
    };
  } catch (error) {
    await close(client.child);
    throw error;
  }
}

async function firstFrame(imageDir) {
  const ownedFixture = fixture(fixtureExe);
  const client = rpc(helperExe);
  try {
    const target = await ownedFixture.ready;
    const hello = await client.call('host.hello', {
      protocol: 'maka.cu/2',
      host: { name: 'maka-cu2-performance-driver', version: 'test' },
      hostPid: process.pid,
      imageDir,
      allowGlobalPointer: false,
    });
    if (hello.result?.protocol !== 'maka.cu/2') throw new Error('host.hello did not negotiate maka.cu/2');
    const session = `perf-${process.pid}-${Date.now()}`;
    await client.call('session.begin', { session, captureScope: 'window' });
    const windows = await client.call('window.list', { session });
    const listed = windows.result?.windows ?? [];
    const listedTarget = listed.find((item) => item.pid === target.pid && item.windowId === target.hwnd);
    if (!listedTarget) throw new Error('fixture target was not re-enumerated');
    const started = performance.now();
    const observed = await client.call('observe', {
      session,
      target: { kind: 'window', pid: target.pid, windowId: target.hwnd },
      includeImage: true,
    });
    const snapshot = observed.result?.snapshot;
    const image = snapshot?.image;
    const bytes = image?.path ? await readFile(image.path) : null;
    const elapsedMs = Number((performance.now() - started).toFixed(3));
    const imageOk = Boolean(
      bytes && image && bytes.length === image.byteLength &&
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` === image.sha256 &&
      image.widthPx > 0 && image.heightPx > 0,
    );
    const workingSet = workingSetBytes(client.child.pid);
    await client.call('session.end', { session });
    requestShutdown(client);
    await close(client.child);
    ownedFixture.shutdown();
    await close(ownedFixture.child);
    return {
      helperPid: client.child.pid,
      fixturePid: target.pid,
      fixtureHwnd: target.hwnd,
      targetReenumerated: true,
      firstFrameMs: elapsedMs,
      imageOk,
      imageBytes: bytes?.length ?? null,
      workingSetBytes: workingSet,
    };
  } catch (error) {
    ownedFixture.shutdown();
    await close(ownedFixture.child);
    await close(client.child);
    throw error;
  }
}

const imageDir = await mkdtemp(join(tmpdir(), 'maka-cu2-performance-images-'));
let result;
try {
  const handshakes = [];
  for (let run = 1; run <= 3; run++) handshakes.push(await coldHandshake(run, imageDir));
  const frame = await firstFrame(imageDir);
  const handshakeValues = handshakes.map((item) => item.handshakeMs);
  result = {
    schema: 'maka.cu.windows/performance-results/1',
    protocol: 'maka.cu/2',
    executor: 'rust-native-windows',
    helper: helperExe,
    fixture: fixtureExe,
    measurements: {
      coldStartHandshakeMs: handshakeValues,
      coldStartHandshakeAverageMs: Number((handshakeValues.reduce((sum, value) => sum + value, 0) / handshakeValues.length).toFixed(3)),
      helperWorkingSetBytes: handshakes.map((item) => item.workingSetBytes),
      firstFrameMs: frame.firstFrameMs,
      firstFrameWorkingSetBytes: frame.workingSetBytes,
    },
    handshakes,
    firstFrame: frame,
  };
  console.log(JSON.stringify(result, null, 2));
  if (outputPath) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
} finally {
  await rm(imageDir, { recursive: true, force: true });
}
