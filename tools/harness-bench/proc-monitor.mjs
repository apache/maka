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

import { execFile, spawn } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const logLimit = 256 * 1024;

function sendSignal(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export function killProcessGroup(pid, signal = 'SIGKILL') {
  if (pid) sendSignal(-pid, signal);
}

async function processTable() {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,state=,rss=,pcpu='], {
    env: { LC_ALL: 'C' },
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim().split('\n').map(line => {
    const [pid, parent, group, state, rssKib, cpuPercent] = line.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), group: Number(group),
      live: !state.startsWith('Z'), rssKib: Number(rssKib), cpuPercent: Number(cpuPercent) };
  });
}

async function stateBytes(path) {
  try {
    const entry = await lstat(path);
    if (entry.isFile()) return entry.size;
    if (!entry.isDirectory()) return 0;
    let total = 0;
    for (const name of await readdir(path)) total += await stateBytes(join(path, name));
    return total;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return 0;
  }
}

export class ClusterMonitor {
  #roots = new Map();
  #timer;
  #sample;
  #diskSample;
  #peakRssKib = 0;
  #peakProcessCount = 0;
  #diskPeaks = new Map();
  #controller = new AbortController();
  #closed = false;
  #error;
  #cleanupErrors = [];

  constructor({ signal, maxClusterRssGib = Infinity, sampleIntervalMs = 100, stateDirs = new Map() } = {}) {
    this.signal = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal;
    this.limitKib = maxClusterRssGib * 1024 ** 2;
    this.stateDirs = stateDirs;
    this.abort = () => {
      for (const root of this.#roots.values()) this.terminate(root);
    };
    this.signal.addEventListener('abort', this.abort, { once: true });
    this.#timer = setInterval(() => this.#tick(), sampleIntervalMs);
  }

  terminate(root) {
    if (!root || root.killed) return;
    root.killed = true;
    const targets = [-root.pid, ...root.escaped];
    for (const target of targets) {
      try {
        sendSignal(target, 'SIGKILL');
      } catch (error) {
        this.#cleanupErrors.push(error);
      }
    }
  }

  watch(pid) {
    if (!pid) return;
    const root = { pid, escaped: [], samples: [], peakRssKib: 0, peakProcessCount: 0, killed: false };
    this.#roots.set(pid, root);
    if (this.signal.aborted) this.terminate(root);
    else this.#tick();
    return root;
  }

  release(root) {
    if (!root) return;
    this.terminate(root);
    this.#roots.delete(root.pid);
  }

  #tick() {
    if (this.#closed || this.signal.aborted) return;
    if (!this.#sample && this.#roots.size) {
      this.#sample = this.#sampleProcesses().catch(error => this.#fail(error))
        .finally(() => { this.#sample = undefined; });
    }
    if (!this.#diskSample && this.stateDirs.size) {
      this.#diskSample = this.#sampleDisk().catch(error => this.#fail(error))
        .finally(() => { this.#diskSample = undefined; });
    }
  }

  #fail(error) {
    this.#error ??= error;
    this.#controller.abort(new Error('cluster_monitor_failed', { cause: error }));
  }

  async #sampleProcesses() {
    const atNs = process.hrtime.bigint().toString();
    const table = await processTable();
    const children = Map.groupBy(table, row => row.parent);
    const groups = Map.groupBy(table, row => row.group);
    const byPid = new Map(table.map(row => [row.pid, row]));
    const cluster = new Map();
    for (const root of this.#roots.values()) {
      const tree = new Map();
      const queue = [...(groups.get(root.pid) ?? []), ...root.escaped.map(pid => byPid.get(pid)).filter(Boolean)];
      for (const row of queue) {
        if (tree.has(row.pid)) continue;
        tree.set(row.pid, row);
        for (const child of children.get(row.pid) ?? []) queue.push(child);
      }
      root.escaped = [];
      let rssKib = 0;
      let cpuPercent = 0;
      let processCount = 0;
      for (const row of tree.values()) {
        if (!row.live) continue;
        cluster.set(row.pid, row);
        if (row.group !== root.pid) root.escaped.push(row.pid);
        rssKib += row.rssKib;
        cpuPercent += row.cpuPercent;
        processCount++;
      }
      root.samples.push({ atNs, rssKib, cpuPercent, processCount });
      root.peakRssKib = Math.max(root.peakRssKib, rssKib);
      root.peakProcessCount = Math.max(root.peakProcessCount, processCount);
    }
    const rssKib = [...cluster.values()].reduce((total, row) => total + row.rssKib, 0);
    this.#peakRssKib = Math.max(this.#peakRssKib, rssKib);
    this.#peakProcessCount = Math.max(this.#peakProcessCount, cluster.size);
    if (rssKib > this.limitKib) this.#controller.abort(new Error('cluster_rss_limit_exceeded'));
  }

  async #sampleDisk() {
    await Promise.all([...this.stateDirs].map(async ([name, path]) => {
      const bytes = await stateBytes(path);
      this.#diskPeaks.set(name, Math.max(bytes, this.#diskPeaks.get(name) ?? 0));
    }));
  }

  async close() {
    this.#closed = true;
    clearInterval(this.#timer);
    this.signal.removeEventListener('abort', this.abort);
    this.abort();
    await Promise.all([this.#sample, this.#diskSample]);
    await this.#sampleDisk();
    if (this.#cleanupErrors.length) {
      throw new Error('Could not kill benchmark processes: ' + this.#cleanupErrors.map(error => error.message).join(', '));
    }
    if (this.#error) throw this.#error;
    return {
      peakClusterRssMib: this.#peakRssKib / 1024,
      peakClusterProcessCount: this.#peakProcessCount,
      diskStateMib: Object.fromEntries([...this.#diskPeaks].map(([name, bytes]) => [name, bytes / 1024 ** 2])),
    };
  }
}

async function collectOutput(stream, onLine) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  stream.on('data', chunk => {
    chunks.push(chunk);
    bytes += chunk.length;
    while (bytes > logLimit) {
      truncated = true;
      const excess = bytes - logLimit;
      if (chunks[0].length <= excess) {
        bytes -= chunks.shift().length;
      } else {
        chunks[0] = chunks[0].subarray(excess);
        bytes -= excess;
      }
    }
  });
  if (onLine) {
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) await onLine(line);
  } else {
    await finished(stream, { cleanup: true });
  }
  return { text: Buffer.concat(chunks, bytes).toString('utf8'), truncated };
}

export async function runMonitoredProcess({
  command, args = [], cwd, env, stdinText, timeoutMs, sampleIntervalMs = 100, sigkillAfterMs,
  onStdoutLine, onStderrLine, signal, monitor, onTimeout,
}) {
  for (const [name, value, minimum] of [
    ['sampleIntervalMs', sampleIntervalMs, 1],
    ['timeoutMs', timeoutMs, 0],
    ['sigkillAfterMs', sigkillAfterMs, 0],
  ]) {
    if (value !== undefined && (!Number.isFinite(value) || value < minimum || value > 2 ** 31 - 1)) {
      throw new RangeError(`Invalid ${name}: ${value}`);
    }
  }
  if (stdinText !== undefined && typeof stdinText !== 'string') {
    throw new TypeError('stdinText must be a string');
  }
  signal?.throwIfAborted();
  monitor?.signal.throwIfAborted();
  const startNs = process.hrtime.bigint();
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  const ownedMonitor = monitor ? undefined : new ClusterMonitor({ signal, sampleIntervalMs });
  monitor ??= ownedMonitor;
  signal = monitor.signal;
  let endNs;
  let failure;
  let stdinError = null;
  let termination = null;
  let timeout;
  let injection;

  function fail(error) {
    failure ??= error;
    monitor.terminate(observation);
  }

  function terminate(reason) {
    if (endNs !== undefined || termination || !child.pid) return;
    termination = reason;
    monitor.terminate(observation);
  }

  function abort() {
    const reason = signal.reason?.message;
    terminate(['cluster_rss_limit_exceeded', 'timeout'].includes(reason) ? reason : 'aborted');
  }

  child.on('error', fail);
  const observation = monitor.watch(child.pid);
  child.once('exit', () => {
    endNs = process.hrtime.bigint();
    clearTimeout(timeout);
    clearTimeout(injection);
    monitor.release(observation);
  });
  const closed = new Promise(resolveClose => {
    child.once('close', (code, signal) => resolveClose({ code, signal }));
  });

  const outputs = [
    [child.stdout, onStdoutLine],
    [child.stderr, onStderrLine],
  ].map(([stream, onLine]) => collectOutput(stream, onLine).catch(error => {
    fail(error);
    stream.resume();
  }));
  if (child.stdin) {
    child.stdin.on('error', error => {
      stdinError = error.message;
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') fail(error);
    });
    child.stdin.end(stdinText);
  }
  if (timeoutMs !== undefined) timeout = setTimeout(() => {
    terminate('timeout');
    onTimeout?.();
  }, timeoutMs);
  if (sigkillAfterMs !== undefined) injection = setTimeout(() => terminate('sigkill'), sigkillAfterMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  try {
    const [exit, stdout, stderr] = await Promise.all([closed, ...outputs]);
    if (failure) throw failure;
    return {
      ...exit,
      termination,
      stdinError,
      startNs: startNs.toString(),
      endNs: endNs.toString(),
      wallMs: Number(endNs - startNs) / 1e6,
      peakRssKib: observation?.peakRssKib ?? 0,
      peakProcessCount: observation?.peakProcessCount ?? 0,
      samples: observation?.samples ?? [],
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    };
  } finally {
    clearTimeout(timeout);
    clearTimeout(injection);
    signal.removeEventListener('abort', abort);
    await ownedMonitor?.close();
  }
}
