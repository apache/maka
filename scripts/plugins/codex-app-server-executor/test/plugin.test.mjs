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
import { chmod, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
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
      clientBridge: {
        rpc(definition) {
          calls.push(`rpc:${definition.name}`);
        },
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
  assert.deepEqual(calls, [
    'effect:codex app-server process',
    'rpc:codex.app-server.models',
    'register',
  ]);
  assert.equal(provider.id, EXECUTOR_ID);
  assert.deepEqual(provider.capabilities, {
    thinking: true,
    toolActivity: true,
  });
});

test('client bundle registers Codex controls in the Composer toolbar', async () => {
  let moduleFactory;
  runInNewContext(await readFile(join(here, '..', 'client.js'), 'utf8'), {
    window: {
      __MakaModuleLoader__: {
        load(definition) {
          moduleFactory = definition.factory;
        },
      },
    },
  });
  assert.equal(typeof moduleFactory, 'function');
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useEffect() {},
    useState(value) {
      return [value, () => {}];
    },
  };
  const client = moduleFactory((id) => {
    assert.equal(id, 'react');
    return React;
  });
  let registration;
  let css = '';
  client.apply({
    style(value) {
      css = value;
    },
    remote: { call: async () => [] },
    slots: {
      register(options, component) {
        registration = { options, component };
        return () => {};
      },
    },
  });
  assert.equal(registration.options.name, 'conversation.composer.toolbar');
  assert.match(css, /codexExecutorControls/u);
  assert.doesNotThrow(() =>
    registration.component({ disabled: false, streaming: false, hasSession: false }),
  );
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

test('client lists Codex models and their supported reasoning efforts', async () => {
  const client = new CodexAppServerClient({ codexPath: fakeCodex }, logger);
  try {
    assert.deepEqual(await client.models(), [
      {
        model: 'gpt-fake',
        displayName: 'GPT Fake',
        description: 'Fixture model',
        isDefault: true,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Fast' },
          { reasoningEffort: 'medium', description: 'Balanced' },
        ],
      },
    ]);
  } finally {
    await client.close();
  }
});

test('client reuses a thread and projects rich events while declining approvals', async () => {
  const client = new CodexAppServerClient({ codexPath: fakeCodex }, logger);
  try {
    const first = executionContext();
    const firstResult = await client.execute(request('first prompt'), first.context);
    assert.equal(firstResult.status, 'completed');
    assert.match(firstResult.text, /threadStarts=1, .*approval=decline/u);
    assert.deepEqual(
      first.events.map((event) => event.type),
      ['tool_start', 'tool_progress', 'tool_result', 'thinking_delta', 'output_delta'],
    );
    assert.equal(first.events[0].activityKind, 'command');
    assert.equal(first.events[2].isError, true);

    const second = executionContext();
    const secondResult = await client.execute(request('second prompt'), second.context);
    assert.equal(secondResult.status, 'completed');
    assert.match(secondResult.text, /threadStarts=1, .*approval=decline/u);
  } finally {
    await client.close();
  }
});

test('Session model overrides the plugin fallback and every turn refreshes model and effort', async () => {
  const client = new CodexAppServerClient(
    { codexPath: fakeCodex, model: 'plugin-default' },
    logger,
  );
  try {
    const first = executionContext();
    const firstResult = await client.execute(
      request('first selection', { model: 'gpt-6-terra', reasoningEffort: 'low' }),
      first.context,
    );
    assert.equal(firstResult.status, 'completed');
    assert.match(firstResult.text, /threadStarts=1, threadModel=gpt-6-terra/u);
    assert.match(firstResult.text, /turnModel=gpt-6-terra, turnEffort=low/u);

    const second = executionContext();
    const secondResult = await client.execute(
      request('changed selection', { model: 'gpt-6-sol', reasoningEffort: 'ultra' }),
      second.context,
    );
    assert.equal(secondResult.status, 'completed');
    assert.match(secondResult.text, /threadStarts=1, threadModel=gpt-6-terra/u);
    assert.match(secondResult.text, /turnModel=gpt-6-sol, turnEffort=ultra/u);

    const restored = executionContext();
    const restoredResult = await client.execute(
      request('restore effort default', { model: 'gpt-6-sol', reasoningEffort: null }),
      restored.context,
    );
    assert.equal(restoredResult.status, 'completed');
    assert.match(restoredResult.text, /threadStarts=1, threadModel=gpt-6-terra/u);
    assert.match(restoredResult.text, /turnModel=gpt-6-sol, turnEffort=null/u);
  } finally {
    await client.close();
  }
});

test('plugin model remains the new-thread fallback when the Session has no model', async () => {
  const client = new CodexAppServerClient(
    { codexPath: fakeCodex, model: 'plugin-default' },
    logger,
  );
  try {
    const execution = executionContext();
    const result = await client.execute(request('fallback selection'), execution.context);
    assert.equal(result.status, 'completed');
    assert.match(result.text, /threadModel=plugin-default/u);
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

test('client settles cancellation when App Server omits turn/completed', async () => {
  const client = new CodexAppServerClient(
    { codexPath: fakeCodex, rpcTimeoutMs: 1000, disposeGraceMs: 100 },
    logger,
  );
  const abort = new AbortController();
  try {
    const execution = executionContext(abort.signal);
    const resultPromise = client.execute(
      request('WAIT_FOR_INTERRUPT OMIT_COMPLETION'),
      execution.context,
    );
    setTimeout(() => abort.abort(new Error('cancel test')), 100);
    const result = await resultPromise;
    assert.equal(result.status, 'cancelled');
  } finally {
    await client.close();
  }
});

test('malformed messages and closed response transports never throw into the Host', () => {
  let warnings = 0;
  const client = new CodexAppServerClient({}, { warn: () => warnings++ });
  assert.doesNotThrow(() => client.acceptLine('null'));
  assert.doesNotThrow(() =>
    client.respondToServerRequest({ id: 1, method: 'unsupported/request' }),
  );
  assert.equal(warnings, 2);
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
