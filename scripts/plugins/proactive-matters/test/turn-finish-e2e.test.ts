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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import {
  createTestAiSdkBackend,
  createSessionEventMapMemory,
  mapSessionEventToRuntimeEvent,
} from '../.artifacts/live-api.mjs';
import { fixture, until } from './platform-helper.js';

test('plugin finish hook resumes the same Maka turn and lets MatterSettle finish it', async (t) => {
  const f = await fixture();
  t.after(async () => {
    f.driver.end();
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  });

  const turnId = 'turn-finish-e2e';
  const matter = await f.invoke(
    'MatterStart',
    { title: 'E2E follow-up', request: 'Record this task as waiting for review.' },
    turnId,
  );
  await f.invoke(
    'MatterWriteFile',
    {
      path: matter.files.draft,
      content: 'Reviewed current state.\nNext: check the review result.',
    },
    turnId,
  );

  const tools = f.tools.resolve('session-1', []).tools;
  let modelCalls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      modelCalls += 1;
      const chunks =
        modelCalls === 1
          ? [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'I will continue.' },
              { type: 'text-end', id: 'text-1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ]
          : modelCalls === 2
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'settle-call',
                  toolName: 'MatterSettle',
                  input: JSON.stringify({
                    expectedRevision: matter.revision,
                    stateFile: matter.files.draft,
                    disposition: 'wait',
                    waitingFor: '设计负责人完成验收',
                    wakes: [{ kind: 'at', at: Date.now() + 60_000 }],
                    reason: '等待负责人反馈',
                    summary: '记录了当前情况并保存下一步。',
                    next: '收到验收结果后重新判断',
                    update: '已检查当前情况，正在等待验收结果。',
                  }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'text-2' },
                { type: 'text-delta', id: 'text-2', delta: '已记录等待状态。' },
                { type: 'text-end', id: 'text-2' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                },
              ];
      return {
        stream: simulateReadableStream({
          chunks: chunks as any,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
  const ledger: any[] = [];
  const anchor: any = {
    id: 'user-e2e',
    invocationId: 'invocation-e2e',
    runId: 'run-e2e',
    sessionId: 'session-1',
    turnId,
    ts: Date.now(),
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: 'Follow this up.' },
  };
  ledger.push(anchor);
  const memory = createSessionEventMapMemory();
  const backend = createTestAiSdkBackend({
    sessionId: 'session-1',
    header: {
      id: 'session-1',
      workspaceRoot: f.root,
      cwd: f.root,
      createdAt: 1,
      name: 'E2E',
      titleIsManual: true,
      isFlagged: false,
      labels: [],
      isArchived: false,
      status: 'active',
      statusUpdatedAt: 1,
      hasUnread: false,
      backend: 'ai-sdk',
      llmConnectionId: 'mock',
      llmConnectionSlug: 'mock',
      connectionLocked: true,
      model: 'mock-model',
      permissionMode: 'bypass',
      schemaVersion: 1,
    },
    connection: { slug: 'mock', providerType: 'openai', defaultModel: 'mock-model' },
    apiKey: 'offline-test',
    modelId: 'mock-model',
    modelFactory: () => model,
    tools,
    newId: randomUUID,
    now: Date.now,
    maxSteps: 8,
    beforeTurnFinish: (context: any) => f.turns.evaluate(context),
    loadTurnRuntimeEvents: async () => [...ledger],
  });

  const events = [];
  for await (const event of backend.send({
    turnId,
    runId: 'run-e2e',
    invocationId: 'invocation-e2e',
    text: 'Follow this up.',
    context: [],
    headAnchorRuntimeEvent: anchor,
  } as any)) {
    events.push(event);
    const mapped = mapSessionEventToRuntimeEvent(
      event,
      {
        sessionId: 'session-1',
        turnId,
        runId: 'run-e2e',
        invocationId: 'invocation-e2e',
        now: Date.now,
      },
      memory,
    );
    if (mapped.partial !== true && mapped.content?.kind !== 'error') ledger.push(mapped);
  }

  f.driver.end();
  await until(async () => !(await f.remote('matters.list')).matters[0].activation);
  const result = await f.remote('matters.list');
  assert.equal(modelCalls, 3);
  assert.equal(events.filter((event: any) => event.type === 'complete').length, 1);
  assert.equal(result.matters[0].status, 'waiting');
  assert.equal(result.matters[0].waitingFor, '设计负责人完成验收');
  assert.equal(result.matters[0].activation, null);
  await backend.dispose();
});
