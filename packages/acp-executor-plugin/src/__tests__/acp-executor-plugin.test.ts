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
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { methods, type ClientApp, type ClientConnection } from '@agentclientprotocol/sdk';
import type { PluginExecutorContext } from '@maka/runtime/plugin-executor-service';
import {
  AcpExecutor,
  type AcpAgentAdapter,
  type AcpConnectionFactory,
  type AcpConversationStateStore,
} from '../index.js';

const adapter: AcpAgentAdapter<{ executable: string; model?: string }> = {
  id: 'fixture-acp',
  displayName: 'Fixture',
  configure: (config) => ({
    launch: {
      executable: config.executable,
      ...(config.model ? { initialConfig: { model: config.model } } : {}),
    },
  }),
};

test('runtime retains one ACP process and Session across prompts', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable, model: 'fast' },
    {
      createConnection: protocol.factory,
    },
  );
  const events: unknown[] = [];
  const context = executorContext(events);
  try {
    assert.deepEqual(await executor.execute(request('first'), context), {
      status: 'completed',
      text: 'reply:first',
    });
    assert.deepEqual(await executor.execute(request('second'), context), {
      status: 'completed',
      text: 'reply:second',
    });
    assert.equal(protocol.connections, 1);
    assert.equal(protocol.sessions, 1);
    assert.equal(protocol.prompts, 2);
    assert.equal(protocol.selectedModel, 'fast');
    assert.equal(
      (
        events.find((event) => (event as { type: string }).type === 'tool_result') as {
          content: { kind: string; paths: string[]; diff: string };
        }
      ).content.kind,
      'file_diff',
    );
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
  assert.equal(protocol.disposals, 1);
});

test('runtime rejects a historical conversation after process continuity was lost', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  const marked = new Set<string>();
  const state: AcpConversationStateStore = {
    has: async (key, cwd) => marked.has(`${key}\0${cwd}`),
    mark: async (key, cwd) => {
      marked.add(`${key}\0${cwd}`);
    },
  };
  const first = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    {
      createConnection: protocol.factory,
      state,
    },
  );
  try {
    assert.equal((await first.execute(request('first'), executorContext([]))).status, 'completed');
    await first.dispose();
    const restarted = new AcpExecutor(
      adapter,
      { executable: fixture.executable },
      {
        createConnection: protocol.factory,
        state,
      },
    );
    try {
      assert.deepEqual(await restarted.execute(request('second'), executorContext([])), {
        status: 'failed',
        message: 'ACP conversation is history-only after the Plugin or Host was restarted',
        code: 'acp_history_only',
        recoverable: false,
      });
      assert.equal(protocol.connections, 1);
    } finally {
      await restarted.dispose();
    }
  } finally {
    await first.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('runtime forwards cancellation to ACP and waits for settlement', async () => {
  const fixture = await executableFixture();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let cancellations = 0;
  const factory: AcpConnectionFactory = (input) => {
    input.configureClient(chainableApp());
    return {
      connection: {
        agent: {
          request: async (method: string) => {
            if (method === methods.agent.initialize) return { protocolVersion: 1 };
            if (method === methods.agent.session.new) return { sessionId: 'acp-session' };
            if (method === methods.agent.session.prompt) {
              started();
              await settled;
              return { stopReason: 'cancelled' };
            }
            throw new Error(`Unexpected ACP method: ${method}`);
          },
          notify: async () => {
            cancellations += 1;
            settle();
          },
        },
        close: () => undefined,
      } as unknown as ClientConnection,
      failed: new Promise<never>(() => undefined),
      dispose: async () => undefined,
    };
  };
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    { createConnection: factory },
  );
  const abort = new AbortController();
  const execution = executor.execute(request('cancel'), executorContext([], abort.signal));
  await ready;
  abort.abort(new Error('user_stop'));
  try {
    assert.deepEqual(await execution, { status: 'cancelled' });
    assert.equal(cancellations, 1);
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function request(text: string) {
  return {
    sessionId: 'session-a',
    turnId: `turn-${text}`,
    conversationKey: 'session-a',
    cwd: process.cwd(),
    text,
  };
}

function executorContext(
  events: unknown[],
  signal = new AbortController().signal,
): PluginExecutorContext {
  return {
    signal,
    emit: (event) => events.push(event),
    requestPermission: async (request) => {
      assert.equal(request.title, 'Allow edit?');
      return { outcome: 'selected', optionId: 'allow_once' };
    },
  };
}

async function executableFixture() {
  const root = await mkdtemp(join(tmpdir(), 'maka-acp-runtime-'));
  const executable = join(root, 'agent');
  await writeFile(executable, 'fixture');
  await chmod(executable, 0o700);
  return { root, executable };
}

function chainableApp() {
  const app = {
    onNotification() {
      return app;
    },
    onRequest() {
      return app;
    },
  };
  return app as unknown as ClientApp;
}

function fakeProtocol(): {
  readonly factory: AcpConnectionFactory;
  connections: number;
  sessions: number;
  prompts: number;
  disposals: number;
  selectedModel?: string;
} {
  const fixture = {
    connections: 0,
    sessions: 0,
    prompts: 0,
    disposals: 0,
    selectedModel: undefined as string | undefined,
    factory: undefined as unknown as AcpConnectionFactory,
  };
  fixture.factory = (input) => {
    fixture.connections += 1;
    const notifications = new Map<string, (input: { params: never }) => unknown>();
    const requests = new Map<string, (input: { params: never }) => unknown>();
    const app = {
      onNotification(method: string, handler: (input: { params: never }) => unknown) {
        notifications.set(method, handler);
        return app;
      },
      onRequest(method: string, handler: (input: { params: never }) => unknown) {
        requests.set(method, handler);
        return app;
      },
    } as unknown as ClientApp;
    input.configureClient(app);
    const connection = {
      agent: {
        request: async (method: string, params: Record<string, unknown>) => {
          if (method === methods.agent.initialize) return { protocolVersion: 1 };
          if (method === methods.agent.session.new) {
            fixture.sessions += 1;
            return {
              sessionId: 'acp-session',
              configOptions: [
                {
                  type: 'select',
                  id: 'model',
                  name: 'Model',
                  currentValue: 'default',
                  options: [
                    { value: 'default', name: 'Default' },
                    { value: 'fast', name: 'Fast' },
                  ],
                },
              ],
            };
          }
          if (method === methods.agent.session.setConfigOption) {
            fixture.selectedModel = String(params.value);
            return { configOptions: [] };
          }
          if (method === methods.agent.session.prompt) {
            fixture.prompts += 1;
            const text = (params.prompt as Array<{ text: string }>)[0]!.text;
            await requests.get(methods.client.session.requestPermission)?.({
              params: {
                sessionId: 'acp-session',
                toolCall: { toolCallId: `tool-${text}`, title: 'Allow edit?' },
                options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
              } as never,
            });
            notifications.get(methods.client.session.update)?.({
              params: {
                sessionId: 'acp-session',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: `reply:${text}` },
                },
              } as never,
            });
            notifications.get(methods.client.session.update)?.({
              params: {
                sessionId: 'acp-session',
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: `tool-${text}`,
                  title: 'Edit file',
                  kind: 'edit',
                  status: 'in_progress',
                },
              } as never,
            });
            notifications.get(methods.client.session.update)?.({
              params: {
                sessionId: 'acp-session',
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: `tool-${text}`,
                  status: 'completed',
                  content: [{ type: 'diff', path: 'README.md', oldText: 'old', newText: 'new' }],
                },
              } as never,
            });
            return { stopReason: 'end_turn' };
          }
          throw new Error(`Unexpected ACP method: ${method}`);
        },
        notify: async () => undefined,
      },
      close: () => undefined,
    } as unknown as ClientConnection;
    return {
      connection,
      failed: new Promise<never>(() => undefined),
      dispose: async () => {
        fixture.disposals += 1;
      },
    };
  };
  return fixture;
}
