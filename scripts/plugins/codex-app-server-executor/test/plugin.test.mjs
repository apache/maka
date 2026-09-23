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

test('client bundle merges Codex and native models in the Composer model selector', async () => {
  let moduleFactory;
  runInNewContext(await readFile(join(here, '..', 'client.js'), 'utf8'), {
    AbortController,
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
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useEffect() {},
    useCallback(callback) {
      return callback;
    },
    useRef(value) {
      return { current: value };
    },
    useState(value) {
      if (Array.isArray(value)) {
        return [
          [
            {
              model: 'gpt-6-astra',
              displayName: 'GPT-6-Astra',
              defaultReasoningEffort: 'high',
              supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
            },
          ],
          () => {},
        ];
      }
      if (value === true) return [false, () => {}];
      return [value, () => {}];
    },
  };
  const client = moduleFactory((id) => {
    if (id === 'react') return React;
    if (id === '@maka/ui/client-plugin') {
      return {
        ModelWheelPicker: 'ModelWheelPicker',
        Selector: 'Selector',
        SelectorOption: 'SelectorOption',
      };
    }
    assert.fail(`unexpected module: ${id}`);
  });
  let registration;
  let modelCalls = 0;
  client.apply({
    style() {},
    remote: {
      call: async () => {
        modelCalls += 1;
        return [];
      },
    },
    slots: {
      register(options, component) {
        registration = { options, component };
        return () => {};
      },
    },
  });
  assert.equal(registration.options.name, 'conversation.composer.model-selection');
  assert.equal(registration.options.select({ onExecutorTargetChange() {} }), true);
  assert.equal(registration.options.select({}), null);
  const rendered = registration.component({
    disabled: false,
    streaming: false,
    hasSession: false,
    modelChoices: [
      {
        connectionId: 'native-1',
        connectionSlug: 'native',
        model: 'native-model',
        label: 'Native model',
        providerLabel: 'OpenAI',
      },
    ],
    onExecutorTargetChange() {},
    renderNativeThinkingControl: () => 'native-thinking',
  });
  const controls = rendered.type(rendered.props);
  const modelPicker = controls.children[0];
  assert.equal(modelPicker.type, 'span');
  const selector = modelPicker.children[0];
  assert.equal(selector.type, 'Selector');
  assert.equal(
    JSON.stringify(
      selector.props.options.map(({ title, options }) => ({
        title,
        options: options.map(({ label, description }) => ({ label, description })),
      })),
    ),
    JSON.stringify([
      {
        title: 'OpenAI',
        options: [{ label: 'Native model' }],
      },
      {
        title: 'Codex',
        options: [{ label: 'GPT-6-Astra' }],
      },
    ]),
  );
  assert.equal(selector.props.className, 'maka-new-chat-model-selector');
  assert.equal(typeof selector.props.renderOption, 'function');
  assert.equal(typeof selector.props.renderValue, 'function');
  assert.equal(controls.children[1], 'native-thinking');
  assert.equal(modelCalls, 0, 'mounting the Composer must not start Codex');
  modelPicker.props.onPointerDownCapture();
  modelPicker.props.onPointerDownCapture();
  assert.equal(modelCalls, 1, 'the first open intent loads models exactly once');
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

test('client bounds model paging even when every App Server page is malformed', async () => {
  const client = new CodexAppServerClient({}, logger);
  let requests = 0;
  client.ensureStarted = async () => {};
  client.request = async () => {
    requests += 1;
    return { data: [{}], nextCursor: `cursor-${requests}` };
  };

  assert.deepEqual(await client.models(), []);
  assert.equal(requests, 10);
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
