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

import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import plugin, { CodexAppServerClient, EXECUTOR_ID, normalizeConfig } from '../index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fakeCodex = join(here, 'fixtures', 'fake-codex.mjs');
const logger = Object.freeze({ warn() {} });

function request(text, overrides = {}) {
  return {
    sessionId: 'session-1',
    turnId: `turn-${Math.random()}`,
    conversationKey: 'session-1',
    cwd: process.cwd(),
    text,
    ...overrides,
  };
}

function executionContext(signal = new AbortController().signal) {
  const events = [];
  return { context: { signal, emit: (event) => events.push(event) }, events };
}

test.before(async () => chmod(fakeCodex, 0o755));

test('package registers the main-compatible executor and lifecycle order', () => {
  const calls = [];
  let provider;
  plugin.host.apply(
    {
      logger: () => logger,
      effect(setup, label) {
        calls.push(`effect:${label}`);
        setup();
      },
      executors: {
        register(value) {
          calls.push('register');
          provider = value;
        },
      },
    },
    { codexPath: fakeCodex },
  );
  assert.deepEqual(calls, ['effect:codex app-server process', 'register']);
  assert.equal(provider.id, EXECUTOR_ID);
  assert.deepEqual(provider.capabilities, {
    thinking: true,
    toolActivity: true,
  });
});

test('configuration validates safe unattended defaults', () => {
  assert.deepEqual(normalizeConfig({}), {
    codexPath: 'codex',
    sandbox: 'read-only',
    ephemeralThreads: true,
    disposeGraceMs: 3000,
    rpcTimeoutMs: 30000,
    inheritEnvironmentCredentials: false,
  });
  assert.throws(() => normalizeConfig({ sandbox: 'unknown' }), /Unsupported Codex sandbox/u);
  assert.throws(() => normalizeConfig({ disposeGraceMs: 1 }), /disposeGraceMs/u);
  assert.throws(() => normalizeConfig({ rpcTimeoutMs: 1 }), /rpcTimeoutMs/u);
  assert.throws(
    () => normalizeConfig({ inheritEnvironmentCredentials: 'yes' }),
    /inheritEnvironmentCredentials/u,
  );
});

test('client reuses a thread and projects rich events while declining approvals', async () => {
  const client = new CodexAppServerClient({ codexPath: fakeCodex }, logger);
  try {
    const first = executionContext();
    const firstResult = await client.execute(request('first prompt'), first.context);
    assert.equal(firstResult.status, 'completed');
    assert.match(firstResult.text, /threadStarts=1, approval=decline/u);
    assert.deepEqual(
      first.events.map((event) => event.type),
      ['tool_start', 'tool_progress', 'tool_result', 'thinking_delta', 'output_delta'],
    );
    assert.equal(first.events[0].activityKind, 'command');
    assert.equal(first.events[2].isError, true);

    const second = executionContext();
    const secondResult = await client.execute(request('second prompt'), second.context);
    assert.equal(secondResult.status, 'completed');
    assert.match(secondResult.text, /threadStarts=1, approval=decline/u);
  } finally {
    await client.close();
  }
});

test('client interrupts an active Codex turn on Maka cancellation', async () => {
  const client = new CodexAppServerClient({ codexPath: fakeCodex }, logger);
  const abort = new AbortController();
  try {
    const execution = executionContext(abort.signal);
    const resultPromise = client.execute(request('WAIT_FOR_INTERRUPT'), execution.context);
    setTimeout(() => abort.abort(new Error('cancel test')), 50);
    const result = await resultPromise;
    assert.equal(result.status, 'cancelled');
  } finally {
    await client.close();
  }
});

test('attachments are rejected instead of being silently dropped', async () => {
  const client = new CodexAppServerClient({ codexPath: fakeCodex }, logger);
  try {
    const execution = executionContext();
    const result = await client.execute(
      request('inspect this', { attachments: [{ id: 'attachment-1' }] }),
      execution.context,
    );
    assert.deepEqual(result, {
      status: 'failed',
      message: 'Codex App Server Executor does not support Maka attachment inputs yet',
      code: 'codex_attachments_unsupported',
      recoverable: false,
    });
  } finally {
    await client.close();
  }
});
