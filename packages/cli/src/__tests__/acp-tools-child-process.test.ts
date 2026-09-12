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
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  methods,
  RequestError,
  type CreateElicitationRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { mcpProxyToolName } from '@maka/runtime/mcp-tools';
import { withAcpChildProcessHarness } from './acp-child-process-harness.js';

const MODEL_ID = 'acp-tools-fixture';
const CAPACITY_FILLER = 'ACP_CAPACITY_FILLER';
const legacyFixture = fileURLToPath(import.meta.resolve('@maka/mcp/test-only/stdio-server'));
const environmentFixture = fileURLToPath(
  new URL('./acp-environment-mcp-fixture.js', import.meta.url),
);
const formFixture = fileURLToPath(
  new URL('./form-stdio-server.js', import.meta.resolve('@maka/mcp/test-only/form-server')),
);

describe('ACP tools through the official SDK, child process and Runtime Host', () => {
  test('ask authorizes the exact MCP Session scope and settles the authoritative result before end_turn', {
    timeout: 60_000,
  }, async () => {
    const marker = 'ACP_ECHO_TOOL';
    const sentinel = 'acp-echo-authoritative-result';
    const model = await startToolModel([{ marker, tool: 'echo', args: { value: sentinel } }]);
    try {
      await withAcpChildProcessHarness(
        async (harness) => {
          const permissions: RequestPermissionRequest[] = [];
          const updates: SessionNotification[] = [];
          await harness.withClient(
            async ({ context }) => {
              await context.request(methods.agent.initialize, { protocolVersion: 1 });
              const created = await context.request(methods.agent.session.new, {
                cwd: harness.workspaceRoot,
                mcpServers: [
                  { name: 'fixture', command: process.execPath, args: [legacyFixture], env: [] },
                ],
              });
              assert.equal(
                created.configOptions?.find((option) => option.id === 'permission_mode')
                  ?.currentValue,
                'ask',
              );
              assert.deepEqual(
                await context.request(methods.agent.session.prompt, {
                  sessionId: created.sessionId,
                  prompt: [{ type: 'text', text: marker }],
                }),
                { stopReason: 'end_turn' },
              );
              assert.equal(permissions.length, 1, harness.stdout);
              assert.equal(permissions[0].sessionId, created.sessionId);
              assert.equal(permissions[0].options[0].kind, 'allow_always');
              assert.match(permissions[0].options[0].name, /this Session/);
              assert.match(JSON.stringify(permissions[0].toolCall.content), /mcp_tool/);
              assertToolSettled(updates, created.sessionId, sentinel);
              assert.ok(
                model.results(marker).some((result) => result.includes(sentinel)),
                model.diagnostics(),
              );
              assert.deepEqual(
                await context.request(methods.agent.session.close, {
                  sessionId: created.sessionId,
                }),
                {},
              );
            },
            (app) =>
              app
                .onNotification(methods.client.session.update, ({ params }) => {
                  updates.push(params);
                })
                .onRequest(methods.client.session.requestPermission, ({ params }) => {
                  permissions.push(params);
                  return { outcome: { outcome: 'selected', optionId: params.options[0].optionId } };
                }),
          );
          await harness.closeStdin();
          assert.deepEqual(await harness.waitForExit(), { code: 0, signal: null });
        },
        {
          startRuntimeHost: true,
          timeoutMs: 45_000,
          model: { id: MODEL_ID, thinkingLevels: [], baseUrl: model.baseUrl },
        },
      );
    } finally {
      await model.close();
    }
  });

  test('tool results settle at the full 16-subscription capacity without opening another subscription', {
    timeout: 90_000,
  }, async () => {
    const marker = 'ACP_CAPACITY_TOOL';
    const sentinel = 'acp-capacity-authoritative-result';
    const model = await startToolModel([{ marker, tool: 'echo', args: { value: sentinel } }]);
    try {
      await withAcpChildProcessHarness(
        async (harness) => {
          const permissions: RequestPermissionRequest[] = [];
          const updates: SessionNotification[] = [];
          await harness.withClient(
            async ({ context }) => {
              await context.request(methods.agent.initialize, { protocolVersion: 1 });
              const sessionIds: string[] = [];
              for (let index = 0; index < 15; index += 1) {
                const filler = await context.request(methods.agent.session.new, {
                  cwd: harness.workspaceRoot,
                  mcpServers: [],
                });
                sessionIds.push(filler.sessionId);
                assert.deepEqual(
                  await context.request(methods.agent.session.prompt, {
                    sessionId: filler.sessionId,
                    prompt: [{ type: 'text', text: `${CAPACITY_FILLER} ${index}` }],
                  }),
                  { stopReason: 'end_turn' },
                );
              }
              // Completed prompts retain their attachment until session/close.
              // Only the final Session starts an MCP process.
              const target = await context.request(methods.agent.session.new, {
                cwd: harness.workspaceRoot,
                mcpServers: [
                  { name: 'fixture', command: process.execPath, args: [legacyFixture], env: [] },
                ],
              });
              sessionIds.push(target.sessionId);
              assert.deepEqual(
                await context.request(methods.agent.session.prompt, {
                  sessionId: target.sessionId,
                  prompt: [{ type: 'text', text: marker }],
                }),
                { stopReason: 'end_turn' },
              );
              assert.equal(permissions.length, 1, harness.stdout);
              assert.equal(permissions[0].sessionId, target.sessionId);
              assertToolSettled(updates, target.sessionId, sentinel);
              assert.ok(
                model.results(marker).some((result) => result.includes(sentinel)),
                model.diagnostics(),
              );

              // Verify the limit is actually occupied, so closing a filler
              // attachment implicitly cannot turn this into a false positive.
              const overflow = await context.request(methods.agent.session.new, {
                cwd: harness.workspaceRoot,
                mcpServers: [],
              });
              sessionIds.push(overflow.sessionId);
              await assert.rejects(
                context.request(methods.agent.session.prompt, {
                  sessionId: overflow.sessionId,
                  prompt: [{ type: 'text', text: CAPACITY_FILLER }],
                }),
                (error: unknown) => {
                  assert.ok(error instanceof RequestError);
                  assert.deepEqual(error.data, {
                    source: 'runtime_host',
                    operation: 'subscription.open',
                    code: 'operation_conflict',
                  });
                  return true;
                },
              );
              await Promise.all(
                sessionIds.map((sessionId) =>
                  context.request(methods.agent.session.close, { sessionId }),
                ),
              );
            },
            (app) =>
              app
                .onNotification(methods.client.session.update, ({ params }) => {
                  updates.push(params);
                })
                .onRequest(methods.client.session.requestPermission, ({ params }) => {
                  permissions.push(params);
                  return { outcome: { outcome: 'selected', optionId: params.options[0].optionId } };
                }),
          );
          await harness.closeStdin();
          assert.deepEqual(await harness.waitForExit(), { code: 0, signal: null });
        },
        {
          startRuntimeHost: true,
          timeoutMs: 75_000,
          model: { id: MODEL_ID, thinkingLevels: [], baseUrl: model.baseUrl },
        },
      );
    } finally {
      await model.close();
    }
  });

  test('modern stdio inputRequired becomes a typed ACP form and resumes the same MCP call', {
    timeout: 60_000,
  }, async () => {
    const marker = 'ACP_FORM_TOOL';
    const model = await startToolModel([{ marker, tool: 'ask_user', args: {} }]);
    const values = { name: 'Ada', email: 'ada@example.com', confirm: true };
    try {
      await withAcpChildProcessHarness(
        async (harness) => {
          const forms: CreateElicitationRequest[] = [];
          const permissions: RequestPermissionRequest[] = [];
          const updates: SessionNotification[] = [];
          await harness.withClient(
            async ({ context }) => {
              await context.request(methods.agent.initialize, {
                protocolVersion: 1,
                clientCapabilities: { elicitation: { form: {} } },
              });
              const created = await context.request(methods.agent.session.new, {
                cwd: harness.workspaceRoot,
                mcpServers: [
                  { name: 'fixture', command: process.execPath, args: [formFixture], env: [] },
                ],
              });
              assert.deepEqual(
                await context.request(methods.agent.session.prompt, {
                  sessionId: created.sessionId,
                  prompt: [{ type: 'text', text: marker }],
                }),
                { stopReason: 'end_turn' },
              );
              assert.equal(permissions.length, 1, harness.stdout);
              assert.equal(forms.length, 1, harness.stdout);
              const form = forms[0];
              assert.equal(form.mode, 'form');
              assert.ok('sessionId' in form);
              assert.equal(form.sessionId, created.sessionId);
              const schema = 'requestedSchema' in form ? form.requestedSchema : undefined;
              assert.ok(schema && typeof schema === 'object' && 'properties' in schema);
              assert.deepEqual(Object.keys(schema.properties as object), [
                'name',
                'email',
                'confirm',
              ]);
              assertToolSettled(updates, created.sessionId, 'Form completed');
              const results = model.results(marker).join('\n');
              assert.match(results, /Ada/);
              assert.match(results, /ada@example.com/);
              assert.match(results, /true/);
              assert.doesNotMatch(
                harness.stdout + harness.stderr + results,
                /stdio-private-continuation-state/,
              );
              assert.deepEqual(
                await context.request(methods.agent.session.close, {
                  sessionId: created.sessionId,
                }),
                {},
              );
            },
            (app) =>
              app
                .onNotification(methods.client.session.update, ({ params }) => {
                  updates.push(params);
                })
                .onRequest(methods.client.session.requestPermission, ({ params }) => {
                  permissions.push(params);
                  return { outcome: { outcome: 'selected', optionId: params.options[0].optionId } };
                })
                .onRequest(methods.client.elicitation.create, ({ params }) => {
                  forms.push(params);
                  return { action: 'accept', content: values };
                }),
          );
        },
        {
          startRuntimeHost: true,
          timeoutMs: 45_000,
          model: { id: MODEL_ID, thinkingLevels: [], baseUrl: model.baseUrl },
        },
      );
    } finally {
      await model.close();
    }
  });

  test('same-named servers keep different Session environments and grants after one Session closes', {
    timeout: 60_000,
  }, async () => {
    const alphaFingerprint = '8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8';
    const betaFingerprint = 'f44e64e75f3948e9f73f8dfa94721c4ce8cbb4f265c4790c702b2d41cfbf2753';
    const model = await startToolModel([
      {
        marker: 'ACP_ENV_ALPHA',
        tool: 'environment',
        args: { names: ['ACP_SESSION_FINGERPRINT'] },
      },
      { marker: 'ACP_ENV_BETA', tool: 'environment', args: { names: ['ACP_SESSION_FINGERPRINT'] } },
      {
        marker: 'ACP_ENV_BETA_AGAIN',
        tool: 'environment',
        args: { names: ['ACP_SESSION_FINGERPRINT'] },
      },
    ]);
    try {
      await withAcpChildProcessHarness(
        async (harness) => {
          const updates: SessionNotification[] = [];
          const permissions: RequestPermissionRequest[] = [];
          await harness.withClient(
            async ({ context }) => {
              await context.request(methods.agent.initialize, { protocolVersion: 1 });
              const sessions = await Promise.all(
                ['alpha', 'beta'].map((value) =>
                  context.request(methods.agent.session.new, {
                    cwd: harness.workspaceRoot,
                    mcpServers: [
                      {
                        name: 'fixture',
                        command: process.execPath,
                        args: [environmentFixture, '--environment'],
                        env: [{ name: 'ACP_SESSION_SENTINEL', value }],
                      },
                    ],
                  }),
                ),
              );
              const [alpha, beta] = sessions;
              const completed = await Promise.all(
                sessions.map((session, index) =>
                  context.request(methods.agent.session.prompt, {
                    sessionId: session.sessionId,
                    prompt: [
                      { type: 'text', text: index === 0 ? 'ACP_ENV_ALPHA' : 'ACP_ENV_BETA' },
                    ],
                  }),
                ),
              );
              assert.deepEqual(completed, [{ stopReason: 'end_turn' }, { stopReason: 'end_turn' }]);
              assertToolSettled(updates, alpha.sessionId, alphaFingerprint);
              assertToolSettled(updates, beta.sessionId, betaFingerprint);
              assert.ok(!toolOutput(updates, alpha.sessionId).includes(betaFingerprint));
              assert.ok(!toolOutput(updates, beta.sessionId).includes(alphaFingerprint));
              assert.deepEqual(
                new Set(permissions.map((permission) => permission.sessionId)),
                new Set(sessions.map((session) => session.sessionId)),
              );
              assert.equal(permissions.length, 2);
              await context.request(methods.agent.session.close, { sessionId: alpha.sessionId });
              assert.deepEqual(
                await context.request(methods.agent.session.prompt, {
                  sessionId: beta.sessionId,
                  prompt: [{ type: 'text', text: 'ACP_ENV_BETA_AGAIN' }],
                }),
                { stopReason: 'end_turn' },
              );
              assert.equal(
                permissions.length,
                2,
                'the surviving Session retains its exact tool grant',
              );
              assert.ok(
                model
                  .results('ACP_ENV_BETA_AGAIN')
                  .some((result) => result.includes(betaFingerprint)),
                model.diagnostics(),
              );
              await context.request(methods.agent.session.close, { sessionId: beta.sessionId });
            },
            (app) =>
              app
                .onNotification(methods.client.session.update, ({ params }) => {
                  updates.push(params);
                })
                .onRequest(methods.client.session.requestPermission, ({ params }) => {
                  permissions.push(params);
                  return { outcome: { outcome: 'selected', optionId: params.options[0].optionId } };
                }),
          );
        },
        {
          startRuntimeHost: true,
          timeoutMs: 45_000,
          model: { id: MODEL_ID, thinkingLevels: [], baseUrl: model.baseUrl },
        },
      );
    } finally {
      await model.close();
    }
  });

  test('cancels and closes a Turn while the SDK client never answers its permission request', {
    timeout: 60_000,
  }, async () => {
    const marker = 'ACP_CANCEL_PERMISSION';
    const model = await startToolModel([
      { marker, tool: 'echo', args: { value: 'must-not-execute' } },
    ]);
    let permissionEntered!: () => void;
    const permissionPending = new Promise<void>((resolve) => {
      permissionEntered = resolve;
    });
    try {
      await withAcpChildProcessHarness(
        async (harness) => {
          await harness.withClient(
            async ({ context }) => {
              await context.request(methods.agent.initialize, { protocolVersion: 1 });
              const created = await context.request(methods.agent.session.new, {
                cwd: harness.workspaceRoot,
                mcpServers: [
                  { name: 'fixture', command: process.execPath, args: [legacyFixture], env: [] },
                ],
              });
              const prompt = context.request(methods.agent.session.prompt, {
                sessionId: created.sessionId,
                prompt: [{ type: 'text', text: marker }],
              });
              await permissionPending;
              await context.notify(methods.agent.session.cancel, { sessionId: created.sessionId });
              assert.deepEqual(await prompt, { stopReason: 'cancelled' });
              assert.deepEqual(
                await context.request(methods.agent.session.close, {
                  sessionId: created.sessionId,
                }),
                {},
              );
              assert.deepEqual(model.results(marker), []);
            },
            (app) =>
              app.onRequest(methods.client.session.requestPermission, () => {
                permissionEntered();
                return new Promise<RequestPermissionResponse>(() => undefined);
              }),
          );
          await harness.closeStdin();
          assert.deepEqual(await harness.waitForExit(), { code: 0, signal: null });
        },
        {
          startRuntimeHost: true,
          timeoutMs: 45_000,
          model: { id: MODEL_ID, thinkingLevels: [], baseUrl: model.baseUrl },
        },
      );
    } finally {
      await model.close();
    }
  });
});

function assertToolSettled(
  updates: readonly SessionNotification[],
  sessionId: string,
  sentinel: string,
): void {
  const results = updates.filter(
    ({ sessionId: id, update }) =>
      id === sessionId &&
      update.sessionUpdate === 'tool_call_update' &&
      update.status === 'completed',
  );
  assert.ok(
    results.some((result) => JSON.stringify(result.update).includes(sentinel)),
    JSON.stringify(updates),
  );
  const ids = updates.flatMap(({ sessionId: id, update }) =>
    id === sessionId && update.sessionUpdate === 'tool_call' ? [update.toolCallId] : [],
  );
  assert.equal(new Set(ids).size, ids.length, 'each tool has exactly one card');
}

function toolOutput(updates: readonly SessionNotification[], sessionId: string): string {
  return JSON.stringify(
    updates
      .filter(
        ({ sessionId: id, update }) =>
          id === sessionId &&
          update.sessionUpdate === 'tool_call_update' &&
          update.status === 'completed',
      )
      .map(({ update }) => update),
  );
}

interface ToolModelRoute {
  readonly marker: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

/** The same real OpenAI-compatible SSE flow used by the remote TUI MCP integration. */
async function startToolModel(routes: readonly ToolModelRoute[]) {
  const steps = new Map<string, number>();
  const results = new Map<string, string[]>();
  const requests: unknown[] = [];
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    void readBody(request)
      .then((body) => {
        const input = JSON.parse(body) as Record<string, unknown>;
        if (input.stream !== true) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              id: 'summary',
              object: 'chat.completion',
              created: 1,
              model: MODEL_ID,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'ACP MCP test' },
                  finish_reason: 'stop',
                },
              ],
            }),
          );
          return;
        }
        const messages = Array.isArray(input.messages)
          ? (input.messages as Array<Record<string, unknown>>)
          : [];
        const latestUserMessage = [...messages]
          .reverse()
          .find((message) => message.role === 'user');
        if (
          latestUserMessage &&
          JSON.stringify(latestUserMessage.content).includes(CAPACITY_FILLER)
        ) {
          respondEvents(response, [
            modelChunk(
              CAPACITY_FILLER,
              { role: 'assistant', content: 'Subscription retained.' },
              null,
            ),
            modelChunk(CAPACITY_FILLER, {}, 'stop'),
          ]);
          return;
        }
        let route: ToolModelRoute | undefined;
        for (const message of [...messages].reverse()) {
          if (message.role !== 'user') continue;
          const text = JSON.stringify(message.content);
          route = [...routes]
            .sort((a, b) => b.marker.length - a.marker.length)
            .find((candidate) => text.includes(candidate.marker));
          if (route) break;
        }
        assert.ok(route, `No fixture route in ${body}`);
        const step = (steps.get(route.marker) ?? 0) + 1;
        steps.set(route.marker, step);
        const names = toolNames(input);
        requests.push({ marker: route.marker, step, tools: names });
        if (step === 1) {
          assert.ok(names.includes('tool_search'));
          respondTool(response, route.marker, step, 'tool_search', {
            query: mcpProxyToolName('fixture', route.tool),
          });
        } else if (step === 2) {
          const tool = mcpProxyToolName('fixture', route.tool);
          assert.ok(names.includes(tool), `Missing ${tool}: ${names.join(', ')}`);
          respondTool(response, route.marker, step, tool, route.args);
        } else {
          results.set(
            route.marker,
            messages
              .filter((message) => message.role === 'tool')
              .map((message) => JSON.stringify(message.content)),
          );
          respondEvents(response, [
            modelChunk(
              route.marker,
              { role: 'assistant', content: 'ACP MCP execution completed.' },
              null,
            ),
            modelChunk(route.marker, {}, 'stop'),
          ]);
        }
      })
      .catch((error: unknown) => {
        errors.push(error);
        response.destroy(error as Error);
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    results: (marker: string) => results.get(marker) ?? [],
    diagnostics: () => JSON.stringify({ requests, errors: errors.map(String) }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

function toolNames(input: Record<string, unknown>): string[] {
  return (Array.isArray(input.tools) ? input.tools : []).flatMap(
    (tool: { function?: { name?: unknown } }) =>
      typeof tool.function?.name === 'string' ? [tool.function.name] : [],
  );
}

function respondTool(
  response: ServerResponse,
  marker: string,
  step: number,
  name: string,
  args: Record<string, unknown>,
): void {
  respondEvents(response, [
    modelChunk(
      marker,
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `${marker}-call-${step}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      null,
    ),
    modelChunk(marker, {}, 'tool_calls'),
  ]);
}

function modelChunk(
  id: string,
  delta: Record<string, unknown>,
  finishReason: 'tool_calls' | 'stop' | null,
) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: 1,
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason
      ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
      : {}),
  };
}

function respondEvents(response: ServerResponse, events: readonly unknown[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
