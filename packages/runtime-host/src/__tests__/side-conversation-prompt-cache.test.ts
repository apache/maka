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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SIDE_CONVERSATION_BOUNDARY_MARKER,
  SIDE_CONVERSATION_SESSION_LABEL,
} from '@maka/core/side-conversation';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import type { InteractiveExecutionStoresWriter } from '@maka/storage/execution-stores';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import type { TurnSnapshot, SessionCatalogProjection } from '../protocol/index.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';

const MODEL_ID = 'side-conversation-cache-model';
const API_KEY = 'side-conversation-cache-key';
const RESPONSE_TEXT = 'Side conversation cache regression response.';

interface ProviderRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

test('side conversation fork preserves the parent provider prefix before the fork-owned turn', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-side-conversation-prompt-cache-'));
  const root = join(base, 'interactive');
  const project = join(base, 'project');
  const provider = await startProvider();
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const context: ConnectionContext = {
    hostEpoch: 'side-conversation-prompt-cache-epoch',
    connectionId: 'side-conversation-prompt-cache-client',
    principal: 'local_os_user',
    acquireResidency: () => ({ release() {} }),
  };
  let composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>> | undefined;
  try {
    await mkdir(project);
    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'side-conversation-cache-provider',
        name: 'Side conversation cache provider',
        providerType: 'moonshot',
        baseUrl: provider.baseUrl,
        enabled: true,
        enabledModelIds: [MODEL_ID],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) return;
    assert.equal(
      (
        await policy.credentialVault.set({
          locator: {
            scope: 'connection',
            connectionId: connection.connectionId,
            kind: 'api_key',
          },
          expected: null,
          secret: API_KEY,
        })
      ).kind,
      'committed',
    );
    await publishConnectionModel(policy, connection.connectionId, MODEL_ID);

    const execution = await openInteractiveExecutionStoresForWrite(owner.lease);
    const parentSession = await execution.sessionStore.create({
      cwd: project,
      llmConnectionId: connection.connectionId,
      llmConnectionSlug: 'side-conversation-cache-provider',
      model: MODEL_ID,
      permissionMode: 'bypass',
    });

    composition = await createExecutionRuntimeHostComposition({
      owner,
      hostEpoch: context.hostEpoch,
      acquireResidency: context.acquireResidency,
      retainUntilProcessExit: () => undefined,
      requestDrain: () => undefined,
    });
    await composition.recover();

    const parentTurnId = 'parent-turn-1';
    const parentTerminal = await waitForTerminal(
      composition,
      parentSession.id,
      parentTurnId,
      await startTurn(
        composition,
        parentSession.id,
        parentTurnId,
        'Summarize the workspace in one sentence.',
        context,
      ),
      context,
    );
    assert.equal(parentTerminal.status, 'completed');

    const parentStreamRequests = streamProviderRequests(provider.requests);

    const forkSessionId = 'side-conversation-fork';
    const branch = await branchSideConversation({
      composition,
      context,
      execution,
      sourceSessionId: parentSession.id,
      targetSessionId: forkSessionId,
      sourceTurnId: parentTurnId,
    });
    assert.ok(branch.labels.includes(SIDE_CONVERSATION_SESSION_LABEL));

    const parentStreamCountBeforeFork = parentStreamRequests.length;
    const forkTurnId = 'fork-turn-1';
    const forkTerminal = await waitForTerminal(
      composition,
      forkSessionId,
      forkTurnId,
      await startTurn(
        composition,
        forkSessionId,
        forkTurnId,
        'What did I just ask in this side chat?',
        context,
      ),
      context,
    );
    assert.equal(forkTerminal.status, 'completed');

    const streamRequestsAfterFork = streamProviderRequests(provider.requests);
    assert.ok(streamRequestsAfterFork.length > parentStreamRequests.length);
    const forkFirstRequest = firstMainTurnStreamRequest(
      streamRequestsAfterFork,
      parentStreamRequests.length,
    );
    const parentLastRequest = streamRequestsAfterFork[parentStreamRequests.length - 1];
    assert.ok(parentLastRequest, 'Parent Session did not emit a streaming provider request');
    assert.equal(isAuxiliaryProviderRequest(parentLastRequest.body), false);

    const parentTools = parentLastRequest.body.tools;
    const forkTools = forkFirstRequest.body.tools;
    assert.deepEqual(forkTools, parentTools);

    const parentSystem = systemPromptText(parentLastRequest.body);
    const forkSystem = systemPromptText(forkFirstRequest.body);
    assert.equal(forkSystem, parentSystem);
    assert.doesNotMatch(forkSystem, new RegExp(SIDE_CONVERSATION_BOUNDARY_MARKER));

    const parentMessages = providerMessages(parentLastRequest.body);
    const forkMessages = providerMessages(forkFirstRequest.body);
    assert.ok(forkMessages.length > parentMessages.length);
    assert.deepEqual(forkMessages.slice(0, parentMessages.length), parentMessages);

    const extensionMessages = forkMessages.slice(parentMessages.length);
    const boundaryUserMessages = extensionMessages.filter(
      (message) =>
        message.role === 'user' && messageText(message).includes(SIDE_CONVERSATION_BOUNDARY_MARKER),
    );
    assert.equal(boundaryUserMessages.length, 1);
    const divergentMessage = extensionMessages.at(-1);
    assert.equal(divergentMessage?.role, 'user');
    const divergentContent = messageText(divergentMessage);
    assert.match(divergentContent, new RegExp(SIDE_CONVERSATION_BOUNDARY_MARKER));
    assert.match(divergentContent, /What did I just ask in this side chat\?/);
  } finally {
    await composition?.close();
    await owner?.close();
    await provider.close();
    await rm(base, { recursive: true, force: true });
  }
});

async function branchSideConversation(input: {
  composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>>;
  context: ConnectionContext;
  execution: InteractiveExecutionStoresWriter;
  sourceSessionId: string;
  targetSessionId: string;
  sourceTurnId: string;
}): Promise<SessionCatalogProjection> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = await input.execution.sessionStore.readCatalogRecord(input.sourceSessionId);
    const branch = await input.composition.handlers['session.branch.create'](
      {
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.targetSessionId,
        sourceTurnId: input.sourceTurnId,
        expectedSourceRevision: record.revision,
        intent: 'side_conversation',
      },
      input.context,
    );
    if (!branch.ok) {
      assert.fail(`Side conversation branch failed: ${JSON.stringify(branch)}`);
    }
    if (branch.result.kind === 'committed') {
      if ('kind' in branch.result.session) {
        assert.fail('Fork Session catalog projection was unsupported');
      }
      return branch.result.session;
    }
    if (branch.result.kind === 'source_revision_conflict') {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      continue;
    }
    assert.fail(`Side conversation branch failed: ${JSON.stringify(branch.result)}`);
  }
  assert.fail('Side conversation branch never observed a stable source revision');
}

async function startTurn(
  composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>>,
  sessionId: string,
  turnId: string,
  text: string,
  context: ConnectionContext,
): Promise<TurnSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const started = await composition.handlers['turn.start'](
      { sessionId, turnId, content: { text } },
      context,
    );
    if (started.ok) {
      if (started.result.kind === 'started') return started.result.turn;
      throw new Error(`Side conversation turn start was blocked: ${JSON.stringify(started)}`);
    }
    if (started.error.code !== 'session_busy') {
      throw new Error(`Side conversation turn start failed: ${JSON.stringify(started.error)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Side conversation Session did not become idle');
}

async function waitForTerminal(
  composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>>,
  sessionId: string,
  turnId: string,
  initial: TurnSnapshot,
  context: ConnectionContext,
): Promise<TurnSnapshot> {
  let snapshot = initial;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (isTerminal(snapshot)) return snapshot;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const queried = await composition.handlers['turn.query']({ sessionId, turnId }, context);
    assert.equal(queried.ok, true);
    snapshot = queried.result;
  }
  throw new Error('Side conversation turn did not become terminal');
}

function isTerminal(snapshot: TurnSnapshot): boolean {
  return (
    snapshot.status === 'completed' ||
    snapshot.status === 'failed' ||
    snapshot.status === 'cancelled'
  );
}

async function publishConnectionModel(
  policy: RuntimePolicyStoresWriter,
  connectionId: string,
  modelId: string,
): Promise<void> {
  const prepared = await policy.operations.beginModelFetch(connectionId);
  assert.equal(prepared.kind, 'ready');
  if (prepared.kind !== 'ready') throw new Error('Model discovery was not ready');
  const committed = await policy.operations.completeModelFetch(prepared.ticket, {
    models: [
      {
        id: modelId,
        capabilities: { chat: true, functionCalling: true },
        contextWindow: 32_768,
        maxOutputTokens: 256,
      },
    ],
    source: 'fetched',
    fetchedAt: Date.now(),
  });
  assert.equal(committed.kind, 'committed');
}

function streamProviderRequests(requests: readonly ProviderRequest[]): ProviderRequest[] {
  return requests.filter((request) => request.body.stream === true);
}

function isAuxiliaryProviderRequest(body: Record<string, unknown>): boolean {
  const serialized = JSON.stringify(body);
  return (
    /Perform the first stage of long-term-memory extraction/.test(serialized) ||
    /context summarization assistant/.test(serialized)
  );
}

function firstMainTurnStreamRequest(
  requests: readonly ProviderRequest[],
  start: number,
): ProviderRequest {
  for (let index = start; index < requests.length; index += 1) {
    const request = requests[index];
    if (!request || isAuxiliaryProviderRequest(request.body)) {
      continue;
    }
    return request;
  }
  assert.fail('Fork Session did not emit a main streaming provider request');
}

function providerMessages(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const messages = body.messages;
  assert.ok(Array.isArray(messages), JSON.stringify(body));
  return messages.filter(
    (message): message is Record<string, unknown> =>
      Boolean(message) && typeof message === 'object' && !Array.isArray(message),
  );
}

function systemPromptText(body: Record<string, unknown>): string {
  return providerMessages(body)
    .filter((message) => message.role === 'system')
    .map((message) => messageText(message))
    .join('\n\n');
}

function messageText(message: Record<string, unknown> | undefined): string {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content
    .flatMap((part) => {
      if (!part || typeof part !== 'object') return [];
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? [text] : [];
    })
    .join('\n');
}

async function startProvider(): Promise<{
  readonly baseUrl: string;
  readonly requests: ProviderRequest[];
  close(): Promise<void>;
}> {
  const requests: ProviderRequest[] = [];
  const server = createServer((request, response) => {
    void handleProviderRequest(request, response, requests).catch((error) => {
      response.destroy(error as Error);
    });
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => closeServer(server),
  };
}

async function handleProviderRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: ProviderRequest[],
): Promise<void> {
  assert.equal(request.method, 'POST');
  const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
  requests.push({ url: request.url ?? '', body });
  if (body.stream !== true) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl-side-conversation-summary',
        object: 'chat.completion',
        created: 1,
        model: MODEL_ID,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: RESPONSE_TEXT },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }),
    );
    return;
  }
  respondProviderText(response, RESPONSE_TEXT);
}

function respondProviderText(response: ServerResponse, text: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-side-conversation',
      object: 'chat.completion.chunk',
      created: 1,
      model: MODEL_ID,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-side-conversation',
      object: 'chat.completion.chunk',
      created: 1,
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
    })}\n\n`,
  );
  response.end('data: [DONE]\n\n');
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
