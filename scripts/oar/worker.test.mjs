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
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { runtimes } from '../../plugins/agent/oar-executor/worker/runtimes.mjs';
import { scriptedRuntime } from '@botiverse/oar/testing';
import { Channel } from '../../plugins/agent/oar-executor/worker/channel.mjs';
import {
  HostTools,
  hostToolsRefusal,
} from '../../plugins/agent/oar-executor/worker/host-tools.mjs';
import {
  catalog,
  execute,
  setup,
  status,
} from '../../plugins/agent/oar-executor/worker/execution.mjs';

function fixture(turn, configure = () => {}) {
  const source = scriptedRuntime({ turn });
  const observed = { disposed: 0, options: null };
  const runtime = {
    id: 'fixture',
    execution: 'process',
    installation: () => source.installation(),
    withPlacement(placement) {
      assert.equal(placement, 'isolated');
      return {
        async session(installation, options) {
          observed.options = options;
          const { effort, mcpServers, ...supported } = options;
          const session = await source.session(installation, supported, {
            requested: 'isolated',
            placement: 'isolated',
          });
          const dispose = session.dispose.bind(session);
          session.dispose = async () => {
            observed.disposed += 1;
            await dispose();
            configure();
          };
          return { ...session, placement: 'isolated' };
        },
      };
    },
  };
  const controller = new AbortController();
  const messages = [];
  const opened = Promise.withResolvers();
  const host = {
    signal: controller.signal,
    abort: (error) => controller.abort(error),
    publish(message) {
      messages.push(message);
      if (message.kind === 'opened') opened.resolve(message);
    },
    committed: async () => {},
  };
  return { runtime, observed, controller, messages, opened, host };
}

const request = {
  cwd: '/workspace',
  model: 'native-model',
  effort: 'vendor-specific-effort',
  resume: 'native-session',
  instructions: 'Keep native instructions.',
  message: 'hello',
};

test('native identity must commit before prompting; final output must commit before disposal', async () => {
  let prompts = 0;
  const f = fixture((turn) => {
    prompts += 1;
    turn.say('完整 answer');
  });
  const identity = Promise.withResolvers();
  const output = Promise.withResolvers();
  const outputWaiting = Promise.withResolvers();
  let commits = 0;
  f.host.committed = async () => {
    commits += 1;
    if (commits === 1) await identity.promise;
    if (commits === 2) {
      outputWaiting.resolve();
      await output.promise;
    }
  };
  const running = execute(f.runtime, request, f.host);
  const opened = await Promise.race([
    f.opened.promise,
    running.then(() => assert.fail('Execution ended before opening')),
  ]);
  assert.equal(opened.sessionId, 'native-session');
  assert.equal(prompts, 0);
  identity.resolve();
  await outputWaiting.promise;
  assert.equal(prompts, 1);
  assert.equal(f.observed.disposed, 0);
  output.resolve();
  assert.deepEqual(await running, { kind: 'completed', text: '完整 answer' });
  assert.equal(f.observed.disposed, 1);
  assert.deepEqual(f.observed.options, {
    cwd: '/workspace',
    model: 'native-model',
    effort: 'vendor-specific-effort',
    resume: 'native-session',
    appendSystemPrompt: 'Keep native instructions.',
  });
  assert.equal(
    f.messages
      .filter((m) => m.kind === 'event' && m.event.kind === 'text_delta')
      .map((m) => m.event.text)
      .join(''),
    '完整 answer',
  );
});

test('cancellation before the identity acknowledgement never sends a prompt', async () => {
  let prompts = 0;
  const f = fixture(() => {
    prompts += 1;
  });
  const identity = Promise.withResolvers();
  f.host.committed = () => identity.promise;
  const running = execute(f.runtime, request, f.host);
  await Promise.race([
    f.opened.promise,
    running.then(() => assert.fail('Execution ended before opening')),
  ]);
  f.controller.abort();
  identity.resolve();
  assert.deepEqual(await running, { kind: 'aborted', text: '' });
  assert.equal(prompts, 0);
  assert.equal(f.observed.disposed, 1);
});

test('an observer write failure stops the turn and is not swallowed by OAR', async () => {
  const f = fixture((turn) => {
    turn.say('first');
    turn.say('second');
  });
  const publish = f.host.publish;
  f.host.publish = (message) => {
    if (message.kind === 'event' && message.event.kind === 'text_delta')
      throw new Error('persistence pipe failed');
    publish(message);
  };
  assert.deepEqual(await execute(f.runtime, request, f.host), {
    kind: 'failed',
    reason: 'persistence pipe failed',
  });
  assert.equal(f.observed.disposed, 1);
  assert.equal(f.controller.signal.aborted, true);
});

test('a completed turn does not conceal failed physical disposal', async () => {
  const f = fixture(
    (turn) => turn.say('done'),
    () => {
      throw new Error('owned process still running');
    },
  );
  await assert.rejects(execute(f.runtime, request, f.host), (error) => {
    assert.match(error.message, /cleanup.*unconfirmed/);
    assert.equal(error.cause.message, 'owned process still running');
    return true;
  });
});

test('partial UTF-8 pipe writes preserve complete messages and wait for a durable acknowledgement', async () => {
  const chunks = [];
  const channel = new Channel((bytes) => {
    const count = Math.min(7, bytes.length);
    chunks.push(Buffer.from(bytes.subarray(0, count)));
    return count;
  });
  channel.publish({ kind: 'event', text: '中文🚀'.repeat(100) });
  const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.deepEqual(message, {
    sequence: 1,
    kind: 'event',
    text: '中文🚀'.repeat(100),
  });
  let committed = false;
  const waiting = channel.committed().then(() => {
    committed = true;
  });
  await Promise.resolve();
  assert.equal(committed, false);
  channel.acknowledge(1);
  await waiting;
  assert.equal(committed, true);
  assert.throws(() => channel.acknowledge(2), /Invalid/);
});

test('consumer loss rejects the outstanding durable handshake', async () => {
  const channel = new Channel((bytes) => bytes.length);
  channel.publish({ kind: 'opened', sessionId: 'native' });
  const waiting = channel.committed();
  channel.fail(new Error('Host disconnected'));
  await assert.rejects(waiting, /Host disconnected/);
  assert.throws(() => channel.publish({ kind: 'event' }), /Host disconnected/);
});

test('discovery preserves OAR absence and authentication states without invoking an installer', async () => {
  let installed = false;
  const runtime = {
    id: 'vendor',
    installation: async () => ({ kind: 'not_found' }),
    install: async () => {
      installed = true;
    },
  };
  assert.deepEqual(await catalog(runtime, '/workspace'), {
    runtime: 'vendor',
    installation: { kind: 'not_found' },
  });
  assert.equal(installed, false);
  runtime.installation = async () => ({
    kind: 'available',
    via: 'executable',
    command: '/vendor',
  });
  runtime.listModels = async (_installation, options) => {
    assert.equal(options.cwd, '/workspace');
    return { kind: 'unauthenticated', detail: 'Sign in through the vendor' };
  };
  const result = await catalog(runtime, '/workspace');
  assert.deepEqual(result.models, {
    kind: 'unauthenticated',
    detail: 'Sign in through the vendor',
  });
});

test('settings metadata lists exactly the shipped OAR runtimes without machine discovery', async () => {
  const metadata = JSON.parse(
    await readFile(
      new URL('../../plugins/agent/oar-executor/runtimes.json', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(
    metadata,
    [...runtimes.values()].map((runtime) => ({ id: runtime.id, name: runtime.brand.name })),
  );
});

test('catalog keeps vendor installation and model failures local to their runtime', async () => {
  const available = { kind: 'available', via: 'bundled' };
  const records = await Promise.all([
    catalog(
      {
        id: 'bad-install',
        installation: async () => {
          throw new Error('probe failed');
        },
      },
      '/workspace',
    ),
    catalog(
      {
        id: 'claude',
        installation: async () => available,
        listModels: async () => {
          throw new Error('claude exited before answering list_models');
        },
      },
      '/workspace',
    ),
    catalog(
      {
        id: 'codex',
        installation: async () => available,
        listModels: async () => ({ kind: 'ok', models: [{ id: 'healthy-model' }] }),
      },
      '/workspace',
    ),
  ]);
  assert.deepEqual(records, [
    { runtime: 'bad-install', installation: { kind: 'error', detail: 'probe failed' } },
    {
      runtime: 'claude',
      installation: available,
      models: { kind: 'error', detail: 'claude exited before answering list_models' },
    },
    {
      runtime: 'codex',
      installation: available,
      models: { kind: 'ok', models: [{ id: 'healthy-model' }] },
    },
  ]);
});

async function discoveryWorker(request) {
  // Replace only the runtime providers; exercise the production stdin/stdout worker.
  const runtimeUrl = new URL(
    '../../plugins/agent/oar-executor/worker/runtimes.mjs',
    import.meta.url,
  ).href;
  const source = `export const runtimes = new Map([
    ['codex', {id:'codex',brand:{name:'Codex'},installation:async()=>({kind:'available'}),authStatus:async()=>({kind:'logged_in',source:'fixture'}),listModels:async()=>({kind:'ok',models:[{id:'healthy-model'}]})}],
    ['claude', {id:'claude',brand:{name:'Claude'},installation:async()=>({kind:'available'}),listModels:async()=>{throw new Error('claude exited before answering list_models')}}],
    ['unselected', {id:'unselected',installation:()=>{throw new Error('unselected runtime must never be probed')}}]
  ]);`;
  const hook = `import {registerHooks} from 'node:module';registerHooks({load(url,context,next){return url===${JSON.stringify(runtimeUrl)}?{format:'module',source:${JSON.stringify(source)},shortCircuit:true}:next(url,context)}});`;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'data:text/javascript,' + encodeURIComponent(hook),
      fileURLToPath(new URL('../../plugins/agent/oar-executor/worker/main.mjs', import.meta.url)),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  child.stdin.write(`${JSON.stringify(request)}\n`);
  assert.equal(await exited, 0, stderr);
  return JSON.parse(stdout).value;
}

test('worker discovery only probes explicitly selected runtimes and retains a healthy sibling', async () => {
  const records = await discoveryWorker({
    kind: 'catalog',
    runtimes: ['codex', 'claude'],
    cwd: '/workspace',
  });
  assert.deepEqual(
    records.map((record) => record.runtime),
    ['codex', 'claude'],
  );
  assert.deepEqual(records[0].models, { kind: 'ok', models: [{ id: 'healthy-model' }] });
  assert.deepEqual(records[1].models, {
    kind: 'error',
    detail: 'claude exited before answering list_models',
  });
  assert.deepEqual(
    await discoveryWorker({ kind: 'status', runtimes: ['codex'], cwd: '/workspace' }),
    [
      {
        id: 'codex',
        name: 'Codex',
        installation: { kind: 'available' },
        authentication: { kind: 'authenticated', source: 'fixture' },
        models: { kind: 'ready', count: 1 },
        canInstall: false,
        installLines: [],
      },
    ],
  );
  const unknown = await discoveryWorker({
    kind: 'catalog',
    runtimes: ['codex', 'cluade'],
    cwd: '/workspace',
  });
  assert.deepEqual(unknown[0].models, { kind: 'ok', models: [{ id: 'healthy-model' }] });
  assert.deepEqual(unknown[1], {
    runtime: 'cluade',
    installation: { kind: 'unsupported', reason: 'Unknown OAR runtime: cluade' },
  });
  const unknownStatus = await discoveryWorker({
    kind: 'status',
    runtimes: ['cluade'],
    cwd: '/workspace',
  });
  assert.equal(unknownStatus[0].installation.kind, 'unsupported');
  assert.equal(unknownStatus[0].installation.detail, 'Unknown OAR runtime: cluade');
  for (const kind of ['catalog', 'status']) {
    assert.deepEqual(await discoveryWorker({ kind, runtimes: [], cwd: '/workspace' }), []);
    assert.deepEqual(await discoveryWorker({ kind, cwd: '/workspace' }), []);
  }
});

test('setup delegates only supported OAR installation operations and never substitutes a registry installer', async () => {
  const runtime = {
    id: 'no-installer',
    installation: async () => ({ kind: 'not_found' }),
  };
  assert.deepEqual(await setup(runtime, { action: 'probe' }), {
    installation: { kind: 'not_found' },
    canInstall: false,
    lines: [],
  });
  assert.deepEqual(await setup(runtime, { action: 'install' }), {
    kind: 'unsupported',
    detail: 'OAR does not provide install for no-installer',
  });
  let calls = 0;
  runtime.install = async (options) => {
    calls += 1;
    assert.deepEqual(options, { line: 'v2' });
    return {
      kind: 'installed',
      installation: { kind: 'available', via: 'bundled' },
      output: 'installed',
    };
  };
  assert.equal(
    (await setup(runtime, { action: 'install', options: { line: 'v2' } })).kind,
    'installed',
  );
  assert.equal(calls, 1);
});

test('undeclared or non-isolated execution is refused, not treated as settled', async () => {
  const f = fixture(() => assert.fail('must not prompt'));
  f.runtime.execution = 'in_process';
  await assert.rejects(execute(f.runtime, request, f.host), /does not declare process ownership/);
  assert.equal(f.observed.disposed, 0);
});

test('cancellation releases the producer without inventing a durable acknowledgement', async () => {
  const channel = new Channel((bytes) => bytes.length);
  const abort = new AbortController();
  channel.publish({ kind: 'opened', sessionId: 'native' });
  const cancelled = channel.committed(abort.signal);
  abort.abort();
  await cancelled;
  let committed = false;
  const actual = channel.committed().then(() => {
    committed = true;
  });
  await Promise.resolve();
  assert.equal(committed, false);
  channel.acknowledge(1);
  await actual;
  assert.equal(committed, true);
});

test('an unavailable installation is a known rejection before any native session opens', async () => {
  const f = fixture(() => assert.fail('No prompt may be delivered'));
  f.runtime.installation = async () => ({ kind: 'not_found' });
  const result = await execute(f.runtime, request, f.host);
  assert.equal(result.kind, 'rejected');
  assert.equal(result.code, 'unavailable');
  assert.equal(f.observed.options, null);
  assert.deepEqual(f.messages, []);
});

test('unknown runtime input is rejected without poisoning physical cleanup', async () => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../plugins/agent/oar-executor/worker/main.mjs', import.meta.url))],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  child.stdin.write(
    `${JSON.stringify({ kind: 'execute', runtime: 'not-a-runtime', cwd: process.cwd(), message: 'must not run' })}\n`,
  );
  assert.equal(await exited, 0, stderr);
  const frames = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, 'result');
  assert.equal(frames[0].result.kind, 'rejected');
  assert.equal(frames[0].result.code, 'unsupported');
});

test('status observes native authentication independently of models and refreshes every time', async () => {
  let signedIn = false;
  let authReads = 0;
  const installation = {
    kind: 'available',
    via: 'executable',
    command: '/fixture',
    version: '1.2',
  };
  const runtime = {
    id: 'fixture',
    brand: { name: 'Fixture' },
    installation: async () => installation,
    authStatus: async (observed) => {
      assert.equal(observed, installation);
      authReads += 1;
      return signedIn
        ? {
            kind: 'logged_in',
            source: 'native status',
            account: { email: 'private@example.com' },
          }
        : {
            kind: 'logged_out',
            source: 'native status',
            detail: 'Sign in with the native CLI',
          };
    },
    listModels: async (observed, options) => {
      assert.equal(observed, installation);
      assert.deepEqual(options, { cwd: '/workspace' });
      return { kind: 'ok', models: [{ id: 'model' }] };
    },
    install: () => {
      throw new Error('status must not install');
    },
    installLines: [{ line: 'v2', description: 'Version 2' }],
  };
  const first = await status(runtime, '/workspace');
  assert.deepEqual(first, {
    id: 'fixture',
    name: 'Fixture',
    installation: { kind: 'available', version: '1.2' },
    authentication: {
      kind: 'unauthenticated',
      source: 'native status',
      detail: 'Sign in with the native CLI',
    },
    models: { kind: 'ready', count: 1 },
    canInstall: true,
    installLines: [{ line: 'v2', description: 'Version 2' }],
  });
  signedIn = true;
  assert.deepEqual((await status(runtime, '/workspace')).authentication, {
    kind: 'authenticated',
    source: 'native status',
  });
  assert.equal(authReads, 2);
  await catalog(runtime, '/workspace');
  assert.equal(authReads, 2, 'model search must not refresh credentials');
});

test('status retains unavailable runtimes and independent probe failures', async () => {
  const base = { id: 'fixture', brand: { name: 'Fixture' } };
  const broken = async () => {
    throw new Error('native probe failed');
  };
  const records = await Promise.all([
    status(
      {
        ...base,
        installation: async () => ({ kind: 'not_found' }),
        authStatus: broken,
        listModels: broken,
      },
      '/workspace',
    ),
    status(
      {
        ...base,
        installation: async () => ({ kind: 'unsupported', reason: 'platform' }),
      },
      '/workspace',
    ),
    status({ ...base, installation: broken }, '/workspace'),
    status(
      {
        ...base,
        installation: async () => ({ kind: 'available', via: 'bundled' }),
        authStatus: broken,
        listModels: async () => ({ kind: 'ok', models: [] }),
      },
      '/workspace',
    ),
    status(
      {
        ...base,
        installation: async () => ({ kind: 'available' }),
        authStatus: async () => ({ kind: 'logged_in', source: 'native' }),
        listModels: broken,
      },
      '/workspace',
    ),
  ]);
  assert.deepEqual(
    records.map((record) => record.installation),
    [
      { kind: 'not_found' },
      { kind: 'unsupported', detail: 'platform' },
      { kind: 'error', detail: 'native probe failed' },
      { kind: 'available' },
      { kind: 'available' },
    ],
  );
  assert.deepEqual(
    records.slice(0, 3).map((record) => record.models),
    Array(3).fill({ kind: 'unavailable' }),
  );
  assert.deepEqual(records[0].authentication, {
    kind: 'unknown',
    detail: 'Authentication was not probed because the runtime is unavailable.',
  });
  assert.deepEqual(records[3].authentication, {
    kind: 'error',
    detail: 'native probe failed',
  });
  assert.deepEqual(records[3].models, { kind: 'ready', count: 0 });
  assert.deepEqual(records[4].authentication, {
    kind: 'authenticated',
    source: 'native',
  });
  assert.deepEqual(records[4].models, {
    kind: 'error',
    detail: 'native probe failed',
  });
});

test('status preserves unknown authentication and unsupported native capabilities honestly', async () => {
  const runtime = {
    id: 'fixture',
    brand: { name: 'Fixture' },
    installation: async () => ({ kind: 'available' }),
    authStatus: async () => ({
      kind: 'unknown',
      detail: 'Not validated',
      source: 'config',
      configured: ['environment'],
    }),
    listModels: async () => ({
      kind: 'unauthenticated',
      detail: 'Login required',
    }),
  };
  const unknown = await status(runtime, '/workspace');
  assert.deepEqual(unknown.authentication, {
    kind: 'unknown',
    detail: 'Not validated',
    source: 'config',
    configured: ['environment'],
  });
  assert.deepEqual(unknown.models, {
    kind: 'unauthenticated',
    detail: 'Login required',
  });
  delete runtime.authStatus;
  runtime.listModels = async () => ({
    kind: 'unsupported',
    reason: 'No native model list',
  });
  const unsupported = await status(runtime, '/workspace');
  assert.deepEqual(unsupported.authentication, { kind: 'unsupported' });
  assert.deepEqual(unsupported.models, {
    kind: 'unsupported',
    detail: 'No native model list',
  });
  assert.equal(unsupported.canInstall, false);
  assert.deepEqual(unsupported.installLines, []);
});

const toolDefinition = {
  name: 'SkillSearch',
  description: 'Search Maka skills.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};
const toolReply = (text) => ({ content: [{ type: 'text', text }] });

function hostToolsFixture() {
  const controller = new AbortController();
  const frames = [];
  const tools = new HostTools({ publish: (frame) => frames.push(frame) }, controller.signal);
  return { controller, frames, tools };
}

test('Host calls correlate concurrent replies independently of output acknowledgements', async () => {
  const f = hostToolsFixture();
  const first = f.tools
    .definitions([toolDefinition])[0]
    .handler({ query: 'one' }, { signal: new AbortController().signal });
  const second = f.tools.call('SkillSearch', { query: 'two' }, new AbortController().signal);
  assert.deepEqual(f.frames, [
    { kind: 'tool_call', callId: 1, name: 'SkillSearch', input: { query: 'one' } },
    { kind: 'tool_call', callId: 2, name: 'SkillSearch', input: { query: 'two' } },
  ]);
  const failure = { ...toolReply('denied'), isError: true };
  f.tools.receive({ callId: 2, result: failure });
  f.tools.receive({ callId: 1, result: toolReply('found') });
  assert.deepEqual(await second, failure);
  assert.deepEqual(await first, toolReply('found'));
  assert.throws(() => f.tools.receive({ callId: 1, result: toolReply('duplicate') }), /Unknown/);
  await f.tools.close();
});

test('Host cancellation requests withdrawal and close waits for the original settlement', async () => {
  const f = hostToolsFixture();
  const call = new AbortController();
  const pending = f.tools.call('AskUserQuestion', {}, call.signal);
  call.abort();
  f.controller.abort();
  assert.deepEqual(
    f.frames.map((frame) => frame.kind),
    ['tool_call', 'tool_cancel'],
  );
  let closed = false;
  const closing = f.tools.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  await assert.rejects(
    f.tools.call('SkillSearch', {}, new AbortController().signal),
    /before dispatch/,
  );
  const outcome = { ...toolReply('withdrawn'), isError: true };
  f.tools.receive({ callId: 1, result: outcome });
  assert.deepEqual(await pending, outcome);
  await closing;
  assert.equal(f.frames.length, 2);
});

test('Host input failure releases all reply waiters without inventing a settled result', async () => {
  const f = hostToolsFixture();
  const pending = f.tools.call('SkillSearch', {}, new AbortController().signal);
  const failed = assert.rejects(pending, /Host disconnected/);
  f.tools.fail(new Error('Host disconnected'));
  await failed;
  await assert.rejects(f.tools.close(), /Host disconnected/);
});

async function mcp(server, body, headers = server.headers) {
  return await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('execution exposes only supplied Host schemas over authenticated MCP and closes the server', async () => {
  const f = fixture(async (turn) => {
    const [server] = f.observed.options.mcpServers;
    assert.equal(
      (await mcp(server, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {})).status,
      401,
    );
    const listed = await (
      await mcp(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    ).json();
    assert.deepEqual(listed.result.tools, [toolDefinition]);
    const result = await (
      await mcp(server, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'SkillSearch', arguments: { query: 'plugins' } },
      })
    ).json();
    assert.deepEqual(result.result, toolReply('skill-match'));
    turn.say('used Host skill search');
  });
  f.host.tools = new HostTools(
    {
      publish(frame) {
        assert.equal(frame.name, 'SkillSearch');
        assert.deepEqual(frame.input, { query: 'plugins' });
        queueMicrotask(() =>
          f.host.tools.receive({ callId: frame.callId, result: toolReply('skill-match') }),
        );
      },
    },
    f.controller.signal,
  );
  const result = await execute(f.runtime, { ...request, tools: [toolDefinition] }, f.host);
  assert.equal(result.kind, 'completed');
  assert.equal(result.text, 'used Host skill search');
  const [server] = f.observed.options.mcpServers;
  await assert.rejects(fetch(server.url));
  assert.equal(f.observed.disposed, 1);
});

test('MCP-refusing runtimes report unavailable Host tools without breaking ordinary execution', async () => {
  const f = fixture((turn) => turn.say('ordinary runtime output'));
  f.runtime.refusedSessionOptions = { mcpServers: 'Native sessions do not support MCP' };
  assert.equal(hostToolsRefusal(f.runtime), 'Native sessions do not support MCP');
  const result = await execute(f.runtime, { ...request, tools: [toolDefinition] }, f.host);
  assert.equal(result.kind, 'completed');
  assert.equal(f.observed.options.mcpServers, undefined);
  assert.deepEqual(
    f.messages.find((frame) => frame.kind === 'host_tools_unavailable'),
    {
      kind: 'host_tools_unavailable',
      reason: 'Native sessions do not support MCP',
    },
  );
});
