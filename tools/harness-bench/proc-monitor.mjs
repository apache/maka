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
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const logLimit = 256 * 1024;

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function sampleTree(rootPid, signal) {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,pcpu='], {
    signal,
    env: { ...process.env, LC_ALL: 'C' },
    maxBuffer: 8 * 1024 * 1024,
  });
  const children = new Map();
  let root;
  for (const line of stdout.trim().split('\n')) {
    const [pid, parent, rssKib, cpuPercent] = line.trim().split(/\s+/).map(Number);
    const entry = { pid, rssKib, cpuPercent };
    if (pid === rootPid) root = entry;
    const siblings = children.get(parent);
    if (siblings) siblings.push(entry);
    else children.set(parent, [entry]);
  }
  if (!root) return null;

  let rssKib = 0;
  let cpuPercent = 0;
  const tree = [root];
  for (const entry of tree) {
    rssKib += entry.rssKib;
    cpuPercent += entry.cpuPercent;
    const descendants = children.get(entry.pid);
    if (descendants) tree.push(...descendants);
  }
  return { rssKib, cpuPercent, processCount: tree.length };
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
  onStdoutLine, onStderrLine, signal,
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
  const startNs = process.hrtime.bigint();
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });

  const samples = [];
  const sampling = new AbortController();
  let peakRssKib = 0;
  let peakProcessCount = 0;
  let endNs;
  let failure;
  let stdinError = null;
  let termination = null;
  let sampleTimer;
  let sampleInFlight;
  let timeout;
  let injection;

  function kill() {
    if (!child.pid) return;
    try {
      killGroup(child.pid);
    } catch (error) {
      failure ??= error;
    }
  }

  function fail(error) {
    failure ??= error;
    if (endNs === undefined) kill();
  }

  function terminate(reason) {
    if (endNs !== undefined || termination || !child.pid) return;
    termination = reason;
    kill();
  }

  function abort() {
    terminate('aborted');
  }

  function sample() {
    const atNs = process.hrtime.bigint().toString();
    sampleInFlight = sampleTree(child.pid, sampling.signal).then(tree => {
      if (!tree) return;
      samples.push({ atNs, ...tree });
      peakRssKib = Math.max(peakRssKib, tree.rssKib);
      peakProcessCount = Math.max(peakProcessCount, tree.processCount);
    }).catch(error => {
      if (!sampling.signal.aborted) fail(new Error('Could not sample child process tree', { cause: error }));
    }).finally(() => {
      if (!sampling.signal.aborted) sampleTimer = setTimeout(sample, sampleIntervalMs);
    });
  }

  child.on('error', fail);
  child.once('spawn', sample);
  child.once('exit', () => {
    endNs = process.hrtime.bigint();
    clearTimeout(timeout);
    clearTimeout(injection);
    clearTimeout(sampleTimer);
    sampling.abort();
    // Descendants may still own the stdio pipes after the group leader exits.
    kill();
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
  if (timeoutMs !== undefined) timeout = setTimeout(() => terminate('timeout'), timeoutMs);
  if (sigkillAfterMs !== undefined) injection = setTimeout(() => terminate('sigkill'), sigkillAfterMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  try {
    const [exit, stdout, stderr] = await Promise.all([closed, ...outputs]);
    await sampleInFlight;
    if (failure) throw failure;
    return {
      ...exit,
      termination,
      stdinError,
      startNs: startNs.toString(),
      endNs: endNs.toString(),
      wallMs: Number(endNs - startNs) / 1e6,
      peakRssKib,
      peakProcessCount,
      samples,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    };
  } finally {
    clearTimeout(timeout);
    clearTimeout(injection);
    signal?.removeEventListener('abort', abort);
  }
}
