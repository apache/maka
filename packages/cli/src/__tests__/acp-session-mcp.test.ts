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
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RequestError, type NewSessionRequest } from '@agentclientprotocol/sdk';
import { MCP_CONFIG_VERSION } from '@maka/core/mcp';
import { deferred, waitFor, withTimeout } from '@maka/core/test-only/async-primitives';
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
  type ClientCapabilityProvider,
  type ClientCapabilityRegistrationOptions,
  type RuntimeHostConnectionAvailability,
} from '@maka/runtime-host/client';
import { AcpSessionMcp, createAcpMcpConfig, type AcpMcpConnection } from '../acp/session-mcp.js';
import { AcpSessionRegistry, type AcpSessionRegistryConnection } from '../acp/session-registry.js';

const fixturePath = fileURLToPath(import.meta.resolve('@maka/mcp/test-only/stdio-server'));
const sessionId = 'session-mcp-fixture';

test('ACP stdio configuration copies cwd, arguments and explicit environment into the existing MCP model', () => {
  const server = stdioServer('/workspace', 'fixture');
  server.env.push({ name: 'EXPLICIT_SETTING', value: 'enabled' });
  const config = createAcpMcpConfig({
    cwd: '/workspace',
    mcpServers: [server],
    _meta: { ignored: true },
  });
  assert.deepEqual(config, {
    version: MCP_CONFIG_VERSION,
    mcpServers: {
      fixture: {
        enabled: true,
        protocol: 'auto',
        command: process.execPath,
        args: [fixturePath],
        cwd: '/workspace',
        env: { MAKA_MCP_STDIO_EVENT_LOG: '/workspace/fixture.jsonl', EXPLICIT_SETTING: 'enabled' },
      },
    },
  });
  server.args.push('--crash');
  server.env[0]!.value = 'changed';
  const normalized = config.mcpServers.fixture;
  assert.ok(normalized && 'command' in normalized);
  assert.deepEqual(normalized.args, [fixturePath]);
  assert.equal(normalized.env?.MAKA_MCP_STDIO_EVENT_LOG, '/workspace/fixture.jsonl');
});

test('invalid ACP stdio configurations fail as invalid params before resource preparation', () => {
  const valid = stdioServer('/workspace', 'fixture');
  const badServers: unknown[] = [
    null,
    'not-an-array',
    ['not-a-server'],
    [null],
    [valid, { ...valid }],
    [{ ...valid, name: '' }],
    [{ ...valid, name: '__proto__' }],
    [{ ...valid, name: 'constructor' }],
    [{ ...valid, command: 'node' }],
    [{ ...valid, command: '/node\0bad' }],
    [{ ...valid, type: 'stdio' }],
    [{ name: 'remote', type: 'http', url: 'https://example.com/mcp', headers: [] }],
    [{ name: 'remote', type: 'sse', url: 'https://example.com/mcp', headers: [] }],
    [{ ...valid, args: undefined }],
    [{ ...valid, args: 'one argument' }],
    [{ ...valid, args: [42] }],
    [{ ...valid, args: ['bad\0argument'] }],
    [{ ...valid, env: undefined }],
    [{ ...valid, env: {} }],
    [{ ...valid, env: [null] }],
    [
      {
        ...valid,
        env: [
          { name: 'KEY', value: 'one' },
          { name: 'KEY', value: 'two' },
        ],
      },
    ],
    [{ ...valid, env: [{ name: '', value: 'value' }] }],
    [{ ...valid, env: [{ name: 'BAD=KEY', value: 'value' }] }],
    [{ ...valid, env: [{ name: 'BAD\0KEY', value: 'value' }] }],
    [{ ...valid, env: [{ name: 'KEY', value: 42 }] }],
    [{ ...valid, env: [{ name: 'KEY', value: 'bad\0value' }] }],
  ];
  for (const mcpServers of badServers) {
    assert.throws(
      () => createAcpMcpConfig({ cwd: '/workspace', mcpServers } as NewSessionRequest),
      (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.code, -32602);
        assert.equal(errorData(error).field, 'mcpServers');
        return true;
      },
      JSON.stringify(mcpServers),
    );
  }
});

test('Session preparation waits for scoped publication and reconnect reuses its MCP processes', {
  timeout: 20_000,
}, async (t) => {
  const root = await temporaryRoot();
  const host = fakeHost();
  const accepted = deferred();
  host.replace = () => accepted.promise;
  const server = stdioServer(root, 'fixture', '--environment');
  server.env.push(
    { name: 'MAKA_MCP_STDIO_FIXTURE_VALUE', value: 'session-setting' },
    { name: 'MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL', value: 'must-not-reach-mcp' },
  );
  const mcp = new AcpSessionMcp(
    sessionId,
    createAcpMcpConfig({ cwd: root, mcpServers: [server] }),
    host.connection,
  );
  t.after(async () => {
    accepted.resolve();
    await mcp.close();
    await rm(root, { recursive: true, force: true });
  });
  let prepared = false;
  const preparing = mcp.prepare().then(() => {
    prepared = true;
  });
  await waitFor(() => host.replacements.length === 1, { timeoutMs: 5_000, pollMs: 10 });
  assert.equal(prepared, false);
  assert.deepEqual(host.replacements[0]?.options, { sessionId });
  const provider = host.replacements[0]!.provider;
  assert.ok(provider.offers().length > 0);
  for (const offer of provider.offers()) {
    assert.equal(offer.admission, 'mcp');
    assert.equal(offer.affinity, 'session');
    assert.equal(offer.hostPathAccess, 'none');
  }
  accepted.resolve();
  await preparing;
  await mcp.ready();
  assert.equal(host.replacements.length, 1);
  assert.deepEqual(await invokeEnvironment(provider), {
    MAKA_MCP_STDIO_FIXTURE_VALUE: '[redacted]',
    MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL: null,
  });
  const starts = (await fixtureEvents(root, 'fixture')).filter((event) => event.event === 'start');
  assert.ok(starts.length > 0);
  assert.ok(starts.every((event) => event.cwd === root && event.fixtureEnv === 'session-setting'));
  host.emit({ kind: 'unavailable' });
  await assert.rejects(mcp.ready(), isMcpError('mcp_publication_failed'));
  host.emit({ kind: 'connected', hostEpoch: 'host-1', connectionId: 'connection-2' });
  await mcp.ready();
  assert.equal(host.replacements.length, 2);
  assert.deepEqual(
    host.replacements.map((replacement) => replacement.options),
    [{ sessionId }, { sessionId }],
  );
  assert.deepEqual(
    (await fixtureEvents(root, 'fixture')).filter((event) => event.event === 'start'),
    starts,
  );
  await mcp.close();
  await mcp.close();
  assert.deepEqual(host.unregisters, [{ sessionId }]);
  assert.equal(host.listenerCount(), 0);
  await assertFixtureExited(root, 'fixture');
});

test('one failed MCP discovery closes every prepared server without publishing a partial group', {
  timeout: 20_000,
}, async (t) => {
  const root = await temporaryRoot();
  const host = fakeHost();
  const config = createAcpMcpConfig({
    cwd: root,
    mcpServers: [stdioServer(root, 'healthy'), stdioServer(root, 'broken', '--crash')],
  });
  const mcp = new AcpSessionMcp(sessionId, config, host.connection);
  t.after(async () => {
    await mcp.close();
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(mcp.prepare(), isMcpError('mcp_not_ready'));
  assert.deepEqual(host.replacements, []);
  assert.deepEqual(host.unregisters, []);
  assert.equal(host.listenerCount(), 0);
  await assertFixtureExited(root, 'healthy');
  await assertFixtureExited(root, 'broken');
});

test('abort during MCP startup closes the child before preparation completes', {
  timeout: 15_000,
}, async (t) => {
  const root = await temporaryRoot();
  const host = fakeHost();
  const controller = new AbortController();
  const mcp = new AcpSessionMcp(
    sessionId,
    createAcpMcpConfig({ cwd: root, mcpServers: [stdioServer(root, 'slow', '--slow-start')] }),
    host.connection,
  );
  t.after(async () => {
    controller.abort();
    await mcp.close();
    await rm(root, { recursive: true, force: true });
  });
  const rejected = assert.rejects(
    mcp.prepare(controller.signal),
    isMcpError('mcp_preparation_failed'),
  );
  await waitForFixtureStart(root, 'slow');
  controller.abort();
  await withTimeout(rejected, 5_000, 'aborted preparation did not release startup');
  assert.equal(host.listenerCount(), 0);
  assert.deepEqual(host.replacements, []);
  assert.deepEqual(host.unregisters, []);
  await assertFixtureExited(root, 'slow');
});

test('failed Host publication fails preparation and releases discovered MCP processes', {
  timeout: 20_000,
}, async (t) => {
  const root = await temporaryRoot();
  const host = fakeHost();
  host.replace = async () => {
    throw new Error('registration rejected');
  };
  const mcp = new AcpSessionMcp(
    sessionId,
    createAcpMcpConfig({ cwd: root, mcpServers: [stdioServer(root, 'fixture')] }),
    host.connection,
  );
  t.after(async () => {
    await mcp.close();
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(mcp.prepare(), isMcpError('mcp_publication_failed'));
  assert.equal(host.replacements.length, 1);
  assert.deepEqual(host.unregisters, []);
  assert.equal(host.listenerCount(), 0);
  await assertFixtureExited(root, 'fixture');
});

test('ready aborts locally while a reconnect publication is pending and close awaits withdrawal', {
  timeout: 20_000,
}, async (t) => {
  const root = await temporaryRoot();
  const host = fakeHost();
  const accepted = deferred();
  const mcp = new AcpSessionMcp(
    sessionId,
    createAcpMcpConfig({ cwd: root, mcpServers: [stdioServer(root, 'fixture')] }),
    host.connection,
  );
  t.after(async () => {
    accepted.resolve();
    await mcp.close();
    await rm(root, { recursive: true, force: true });
  });
  await mcp.prepare();
  host.replace = () => accepted.promise;
  host.emit({ kind: 'connected', hostEpoch: 'host-2', connectionId: 'connection-2' });
  const controller = new AbortController();
  const rejection = assert.rejects(mcp.ready(controller.signal), { name: 'AbortError' });
  controller.abort();
  await withTimeout(rejection, 1_000, 'ready waited for Host delivery after abort');
  let closed = false;
  const closing = mcp.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  accepted.resolve();
  await closing;
  assert.deepEqual(host.unregisters, [{ sessionId }]);
  await assertFixtureExited(root, 'fixture');
});

test('a dispatched create with unknown outcome retains its published MCP scope until the returned Session is closed', {
  timeout: 20_000,
}, async (t) => {
  const root = await temporaryRoot();
  const host = fakeHost();
  const operations: string[] = [];
  const registry = new AcpSessionRegistry({
    newSessionId: () => sessionId,
    connect: async () =>
      registryConnection(host, async (operation) => {
        operations.push(operation);
        throw new RuntimeHostRequestInterruptedError(
          'session.create',
          'command',
          'dispatched',
          'connection_lost',
        );
      }),
  });
  t.after(async () => {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(
    registry.create({ cwd: root, mcpServers: [stdioServer(root, 'fixture')] }),
    (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(errorData(error).sessionId, sessionId);
      assert.equal(errorData(error).dispatch, 'dispatched');
      return true;
    },
  );
  assert.deepEqual(operations, ['session.create']);
  assert.equal(host.replacements.length, 1);
  assert.deepEqual(host.unregisters, []);
  assert.equal(host.listenerCount(), 1);
  assert.ok(
    (await fixtureEvents(root, 'fixture')).some(
      (event) => event.event === 'start' && processExists(event.pid),
    ),
  );
  await registry.close({ sessionId });
  assert.deepEqual(host.unregisters, [{ sessionId }]);
  assert.deepEqual(operations, ['session.create']);
  await assertFixtureExited(root, 'fixture');
});

test('a known Host create failure withdraws the already prepared scope and leaves no Session ownership', {
  timeout: 20_000,
}, async (t) => {
  const root = await temporaryRoot();
  const host = fakeHost();
  const registry = new AcpSessionRegistry({
    newSessionId: () => sessionId,
    connect: async () =>
      registryConnection(host, async () => {
        throw new RuntimeHostOperationError('session.create', 'operation_conflict', 'rejected');
      }),
  });
  t.after(async () => {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(
    registry.create({ cwd: root, mcpServers: [stdioServer(root, 'fixture')] }),
    RequestError,
  );
  assert.equal(host.replacements.length, 1);
  assert.deepEqual(host.unregisters, [{ sessionId }]);
  await assert.rejects(
    registry.close({ sessionId }),
    (error: unknown) => error instanceof RequestError && error.code === -32602,
  );
  assert.equal(host.listenerCount(), 0);
  await assertFixtureExited(root, 'fixture');
});

test('ACP EOF during MCP startup aborts preparation before any Session create dispatch', {
  timeout: 15_000,
}, async (t) => {
  const root = await temporaryRoot();
  const host = fakeHost();
  const operations: string[] = [];
  const registry = new AcpSessionRegistry({
    newSessionId: () => sessionId,
    connect: async () =>
      registryConnection(host, async (operation) => {
        operations.push(operation);
        return {};
      }),
  });
  t.after(async () => {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const rejected = assert.rejects(
    registry.create({ cwd: root, mcpServers: [stdioServer(root, 'slow', '--slow-start')] }),
    RequestError,
  );
  await waitForFixtureStart(root, 'slow');
  await withTimeout(
    Promise.all([registry.dispose(), rejected]),
    5_000,
    'EOF did not cancel MCP preparation',
  );
  assert.deepEqual(operations, []);
  assert.deepEqual(host.replacements, []);
  assert.deepEqual(host.unregisters, []);
  assert.equal(host.listenerCount(), 0);
  await assertFixtureExited(root, 'slow');
});

function stdioServer(root: string, name: string, ...flags: string[]) {
  return {
    name,
    command: process.execPath,
    args: [fixturePath, ...flags],
    env: [{ name: 'MAKA_MCP_STDIO_EVENT_LOG', value: join(root, `${name}.jsonl`) }],
  };
}

function fakeHost() {
  const listeners = new Set<(availability: RuntimeHostConnectionAvailability) => void>();
  const host = {
    replacements: [] as {
      provider: ClientCapabilityProvider;
      options: number | ClientCapabilityRegistrationOptions | undefined;
    }[],
    unregisters: [] as (number | ClientCapabilityRegistrationOptions | undefined)[],
    replace: async (): Promise<void> => undefined,
    listenerCount: () => listeners.size,
    emit: (availability: RuntimeHostConnectionAvailability) => {
      for (const listener of listeners) listener(availability);
    },
    connection: undefined as unknown as AcpMcpConnection,
  };
  host.connection = {
    replaceClientCapabilities: async (provider, options) => {
      host.replacements.push({ provider, options });
      await host.replace();
      return { registrationId: 'registration', revision: host.replacements.length };
    },
    unregisterClientCapabilities: async (options) => {
      host.unregisters.push(options);
      return { registrationId: 'registration', revision: host.replacements.length + 1 };
    },
    subscribeConnectionAvailability: (listener) => {
      listeners.add(listener);
      listener({ kind: 'connected', hostEpoch: 'host-1', connectionId: 'connection-1' });
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return host;
}

function registryConnection(
  host: ReturnType<typeof fakeHost>,
  request: (operation: string) => Promise<unknown>,
): AcpSessionRegistryConnection {
  return {
    ...host.connection,
    reconnecting: true,
    request: request as AcpSessionRegistryConnection['request'],
    close: async () => undefined,
    openSessionSubscription: async () => {
      throw new Error('unexpected subscription');
    },
    openSessionSubscriptionOnce: async () => {
      throw new Error('unexpected subscription');
    },
  };
}

async function invokeEnvironment(provider: ClientCapabilityProvider): Promise<unknown> {
  const offer = provider
    .offers()
    .find((candidate) => candidate.tools.some((tool) => tool.name === 'environment'));
  const tool = offer?.tools.find((candidate) => candidate.name === 'environment');
  assert.ok(offer && tool && provider.call);
  const result = await provider.call(
    {
      kind: 'client.capability.call',
      invocationId: 'invocation',
      registrationId: 'registration',
      offerId: offer.offerId,
      serverId: tool.serverId,
      toolName: tool.name,
      arguments: { names: ['MAKA_MCP_STDIO_FIXTURE_VALUE', 'MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL'] },
      sessionId,
      turnId: 'turn',
      toolCallId: 'tool-call',
    },
    {
      signal: new AbortController().signal,
      accept: async (evidence) => {
        assert.deepEqual(evidence, { kind: 'none' });
      },
      requestInteraction: async () => {
        throw new Error('unexpected interaction');
      },
    },
  );
  const content = result.content[0];
  assert.ok(content?.type === 'text');
  return JSON.parse(content.text);
}

function isMcpError(code: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof RequestError);
    assert.equal(errorData(error).code, code);
    assert.equal(errorData(error).sessionId, sessionId);
    return true;
  };
}

function errorData(error: RequestError): Record<string, unknown> {
  assert.ok(error.data && typeof error.data === 'object');
  return error.data as Record<string, unknown>;
}

async function temporaryRoot(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'maka-acp-mcp-')));
}

interface FixtureEvent {
  event: string;
  pid: number;
  cwd?: string;
  fixtureEnv?: string;
}

async function fixtureEvents(root: string, name: string): Promise<FixtureEvent[]> {
  try {
    const content = await readFile(join(root, `${name}.jsonl`), 'utf8');
    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FixtureEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function waitForFixtureStart(root: string, name: string): Promise<void> {
  await waitFor(
    async () => (await fixtureEvents(root, name)).some((event) => event.event === 'start'),
    {
      timeoutMs: 5_000,
      pollMs: 10,
      message: `${name} fixture did not start`,
    },
  );
}

async function assertFixtureExited(root: string, name: string): Promise<void> {
  await waitFor(
    async () => {
      const events = await fixtureEvents(root, name);
      const starts = events.filter((event) => event.event === 'start');
      return (
        starts.length > 0 &&
        starts.every(
          (start) =>
            events.some((event) => event.event === 'exit' && event.pid === start.pid) &&
            !processExists(start.pid),
        )
      );
    },
    { timeoutMs: 5_000, pollMs: 10, message: `${name} MCP fixture leaked a child process` },
  );
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
