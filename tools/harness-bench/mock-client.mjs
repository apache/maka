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

import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';

const buildCommand = 'cargo build --release -p maka-mock-ai --bin maka-mock-ai';

export function resolveMockAiBinary(repoRoot, explicitPath) {
  if (explicitPath !== undefined) {
    const binary = resolve(explicitPath);
    try {
      if (!statSync(binary).isFile()) throw new Error('expected an executable file');
      accessSync(binary, constants.X_OK);
    } catch (cause) {
      throw new Error(`Cannot execute maka-mock-ai at ${binary}: ${cause.message}`, { cause });
    }
    return binary;
  }

  const name = process.platform === 'win32' ? 'maka-mock-ai.exe' : 'maka-mock-ai';
  const candidates = ['release', 'debug'].map(profile => resolve(repoRoot, 'target', profile, name));
  for (const binary of candidates) {
    try {
      if (!statSync(binary).isFile()) continue;
      accessSync(binary, constants.X_OK);
      return binary;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw new Error(`Cannot find an executable maka-mock-ai at ${candidates.join(' or ')}. Run ${buildCommand}.`);
}

// The Rust router uses raw path components and query values as IDs.
function pathId(id) {
  const path = `/s/${id}/x`;
  if (typeof id !== 'string' || !id || /[/\\?#]/.test(id)
      || new URL(path, 'http://localhost').pathname !== path) {
    throw new TypeError(`Invalid mock-ai path ID: ${id}`);
  }
  return id;
}

class MockAdminError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} returned HTTP ${status}: ${body}`);
    this.name = 'MockAdminError';
    this.status = status;
    this.body = body;
  }
}

export class MockAdminClient {
  #origin;

  constructor(baseUrl) {
    this.#origin = new URL(baseUrl).origin;
  }

  async #request(path, { method = 'GET', body, status = 200, text = false, signal } = {}) {
    const request = { method, redirect: 'error', signal };
    if (body !== undefined) {
      request.headers = { 'content-type': 'application/json' };
      request.body = JSON.stringify(body);
    }
    const response = await fetch(new URL(path, this.#origin), request);
    if (response.status !== status) {
      throw new MockAdminError(method, path, response.status, await response.text());
    }
    return text ? response.text() : response.json();
  }

  health({ signal } = {}) {
    return this.#request('/admin/health', { signal });
  }

  registerSession({
    runId, sessionId, harness, logicalLane, scenario, launchMode, workspace,
    credentialBinding, clientSessionAliases,
  }) {
    return this.#request('/admin/sessions', {
      method: 'POST',
      status: 201,
      body: {
        run_id: pathId(runId),
        session_id: pathId(sessionId),
        harness,
        logical_lane: logicalLane,
        scenario,
        launch_mode: launchMode,
        workspace,
        credential_binding: credentialBinding,
        client_session_aliases: clientSessionAliases,
      },
    });
  }

  listSessions({ run, cursor, limit } = {}) {
    const params = new URLSearchParams();
    if (cursor !== undefined && cursor !== null) params.set('cursor', cursor);
    if (limit !== undefined) params.set('limit', limit);
    if (run !== undefined) {
      if (typeof run !== 'string' || /[&#]/.test(run)
          || new URL(`http://localhost/?run=${run}`).search !== `?run=${run}`) {
        throw new TypeError(`Invalid mock-ai run filter: ${run}`);
      }
      return this.#request(`/admin/sessions?run=${run}${params.size ? `&${params}` : ''}`);
    }
    return this.#request(`/admin/sessions${params.size ? `?${params}` : ''}`);
  }

  // The optional finalization carries the result of the proof-bearing POST.
  async getSessionDetailAll(sessionId, { finalization } = {}) {
    const path = `/admin/sessions/${pathId(sessionId)}`;
    const items = [];
    let after = 0;
    while (true) {
      const page = await this.#request(`${path}?after=${after}&limit=500`);
      const { nextCursor, summary } = page;
      items.push(...page.items);
      // Only items are paged. nextCursor also acknowledges dropped attempts.
      if (!Number.isSafeInteger(nextCursor) || nextCursor < after || nextCursor > summary.attempts) {
        throw new Error(`Invalid mock-ai cursor for ${sessionId}: ${after} -> ${nextCursor}`);
      }
      if (nextCursor === summary.attempts) {
        if (finalization && (!summary.finalized || finalization.runId !== summary.runId
            || finalization.sessionId !== summary.sessionId || finalization.cursor !== summary.cursor)) {
          throw new Error(`Finalization does not match mock-ai session ${sessionId}`);
        }
        return { ...page, items, scenarioCompleted: finalization?.scenarioCompleted === true };
      }
      if (nextCursor === after) {
        throw new Error(`Mock-ai cursor did not advance for ${sessionId}: ${after}`);
      }
      after = nextCursor;
    }
  }

  recordObservation(sessionId, observation) {
    return this.#request(`/admin/sessions/${pathId(sessionId)}/observations`, {
      method: 'POST', body: observation,
    });
  }

  async finalizeSession(sessionId, proof) {
    const summary = await this.#request(`/admin/sessions/${pathId(sessionId)}/finalize`, {
      method: 'POST', body: proof,
    });
    return { ...summary, scenarioCompleted: proof !== undefined && proof !== null };
  }

  deleteSession(sessionId, { cursor, after }) {
    const query = new URLSearchParams({ cursor, after });
    return this.#request(`/admin/sessions/${pathId(sessionId)}?${query}`, { method: 'DELETE' });
  }

  reset() {
    return this.#request('/admin/reset', { method: 'POST' });
  }

  metrics() {
    return this.#request('/admin/metrics');
  }

  violations() {
    return this.#request('/admin/violations');
  }

  prometheus() {
    return this.#request('/metrics', { text: true });
  }
}

export class MockAiProcess {
  #child;
  #closed;
  #exit;
  #error;
  #origin;
  #log = '';
  #stopping;

  constructor(binary, args) {
    this.#child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.#child.on('error', error => { this.#error = error; });
    this.#closed = new Promise(resolveClose => {
      this.#child.once('close', (code, signal) => {
        this.#exit = { code, signal };
        resolveClose(this.#exit);
      });
    });

    for (const stream of [this.#child.stdout, this.#child.stderr]) {
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      lines.on('line', raw => {
        const line = stripVTControlCharacters(raw);
        this.#log = `${this.#log}${line}\n`.slice(-16_384);
        const match = /maka-mock-ai listening origin=(https?:\/\/\S+)/.exec(line);
        if (match) this.#origin = new URL(match[1]).origin;
      });
      lines.on('error', error => { this.#error = error; });
    }
  }

  get baseUrl() {
    return this.#origin;
  }

  scopedUrl(runId, sessionId, suffix = '/v1') {
    const tail = suffix && !suffix.startsWith('/') ? `/${suffix}` : suffix;
    return `${this.baseUrl}/s/${pathId(runId)}/${pathId(sessionId)}${tail}`;
  }

  async waitUntilReady() {
    const deadline = performance.now() + 10_000;
    let lastError;
    while (performance.now() < deadline) {
      if (this.#error || this.#exit) {
        const reason = this.#error?.message ?? this.#exit.signal ?? `exit ${this.#exit.code}`;
        throw new Error(`maka-mock-ai exited during startup (${reason})\n${this.#log}`, {
          cause: this.#error,
        });
      }
      if (this.#origin) {
        try {
          const health = await new MockAdminClient(this.#origin).health({
            signal: AbortSignal.timeout(500),
          });
          if (health.ok !== true) throw new Error('Expected mock-ai health to report ok: true');
          if (!this.#exit && !this.#error) return this;
        } catch (error) {
          if (!(error instanceof TypeError) && error.name !== 'TimeoutError') {
            throw new Error(`maka-mock-ai health check failed: ${error.message}\n${this.#log}`, { cause: error });
          }
          lastError = error;
        }
      }
      await delay(50);
    }
    throw new Error(`maka-mock-ai startup timed out\n${this.#log}`, { cause: lastError });
  }

  stop() {
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }

  async #stop() {
    if (this.#exit || !this.#child.pid) return this.#closed;
    // The binary shuts down gracefully on SIGINT.
    this.#child.kill('SIGINT');
    const force = setTimeout(() => this.#child.kill('SIGKILL'), 5_000);
    try {
      return await this.#closed;
    } finally {
      clearTimeout(force);
    }
  }
}

export async function startMockAi({
  binary, scenarioPath, listen = '127.0.0.1:0', strictBenchmark = true,
  latencyProfile, providerDialect, maxConcurrent, rpm, itpm, extraArgs = [],
}) {
  const args = ['--listen', listen, '--admin'];
  if (strictBenchmark) args.push('--strict-benchmark');
  for (const [flag, value] of [
    ['--scenario', scenarioPath],
    ['--latency-profile', latencyProfile],
    ['--provider-dialect', providerDialect],
    ['--max-concurrent', maxConcurrent],
    ['--rpm', rpm],
    ['--itpm', itpm],
  ]) {
    if (value !== undefined) args.push(flag, String(value));
  }
  const mock = new MockAiProcess(binary, [...args, ...extraArgs]);
  try {
    return await mock.waitUntilReady();
  } catch (error) {
    await mock.stop();
    throw error;
  }
}
