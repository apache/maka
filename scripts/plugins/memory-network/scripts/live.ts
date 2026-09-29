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

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fixture } from '../test/host-fixture.js';
import {
  createTestAiSdkBackend,
  getAIModel,
  createSessionEventMapMemory,
  mapSessionEventToRuntimeEvent,
} from '../.artifacts/live-api.mjs';
const key = process.env.MAKA_SCENARIO_API_KEY;
if (!key) throw Error('Set MAKA_SCENARIO_API_KEY in the environment');
const modelId = process.env.MAKA_SCENARIO_MODEL ?? 'deepseek-flash';
const f = await fixture(true),
  ledger: any[] = [],
  report: any = { modelId, startedAt: Date.now(), turns: [], ok: false };
const header = {
  id: 'agent-chat',
  workspaceRoot: f.root,
  cwd: f.root,
  createdAt: Date.now(),
  name: 'Memory network live',
  titleIsManual: true,
  isFlagged: false,
  labels: [],
  isArchived: false,
  status: 'active',
  statusUpdatedAt: Date.now(),
  hasUnread: false,
  backend: 'ai-sdk',
  llmConnectionId: 'live',
  llmConnectionSlug: 'live',
  connectionLocked: true,
  model: modelId,
  permissionMode: 'bypass',
  schemaVersion: 1,
};
let requests = 0;
const backend = createTestAiSdkBackend({
  sessionId: 'agent-chat',
  header,
  apiKey: key,
  modelId,
  connection: {
    slug: 'live',
    providerType: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: modelId,
  },
  newId: randomUUID,
  now: Date.now,
  maxSteps: 24,
  tools: f.tools.resolve('agent-chat', []).tools,
  systemPrompt: async (c: any) =>
    f.systemPrompt.assemble(
      c,
      'You are Maka. Use the tools to complete the requested memory organization. Do not invent evidence. Respond concisely.',
    ),
  modelFactory: (input: any) =>
    getAIModel({
      ...input,
      fetch: async (url: any, init: any) => {
        if (++requests > 50) throw Error('Live request budget exceeded');
        return fetch(url, init);
      },
    }),
  loadTurnRuntimeEvents: async (id: string) => ledger.filter((e) => e.turnId === id),
});
async function run(text: string) {
  const turnId = randomUUID(),
    runId = randomUUID(),
    invocationId = randomUUID();
  const anchor = {
    id: randomUUID(),
    sessionId: 'agent-chat',
    turnId,
    runId,
    invocationId,
    ts: Date.now(),
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text },
  };
  const prior = [...ledger];
  ledger.push(anchor);
  const memory = createSessionEventMapMemory(),
    events: any[] = [];
  report.turns.push(events);
  for await (const event of backend.send({
    turnId,
    runId,
    invocationId,
    text,
    context: [],
    runtimeContext: prior,
    headAnchorRuntimeEvent: anchor,
  })) {
    if (!['text_delta', 'thinking_delta'].includes(event.type)) events.push(event);
    if (event.type === 'tool_start') console.log(JSON.stringify({ tool: event.toolName }));
    if (event.type === 'error') throw Error(event.message);
    const mapped = mapSessionEventToRuntimeEvent(
      event,
      { sessionId: 'agent-chat', turnId, runId, invocationId, now: Date.now },
      memory,
    );
    if (mapped.partial !== true && mapped.content?.kind !== 'error') ledger.push(mapped);
  }
}
const timer = setTimeout(() => void backend.stop?.(), 180000);
try {
  await run(
    'Create two indexes from the available Session history: name one "todo" for unresolved candidate follow-ups, and the other "timeline" for what happened. Organize all batches and cite original fragments in every entry. For the vendor lead, open the original and inspect its backlinks after building both indexes. Do not perform any external action.',
  );
  const initial = (await f.invoke('MemoryIndexList', {})).indexes;
  assert.equal(initial.length, 2);
  const todo = initial.find((i: any) => i.name === 'todo');
  assert.ok(todo);
  const oldCandidates = (await f.invoke('MemoryIndexEntries', { indexId: todo.id })).items;
  assert.ok(oldCandidates.length > 0);
  const contactIds = oldCandidates
    .filter((e: any) => /contact.*vendor|联系.*供应商/i.test(e.body))
    .map((e: any) => e.id);
  assert.ok(contactIds.length > 0, 'initial contact candidate exists');
  f.sessions.get('chat-b')!.push({
    id: 'new-update',
    type: 'user',
    text: 'Vendor contacted yesterday; do not contact them again. Delivery remains due next week.',
  });
  await run(
    'New source history is now available. Refresh both indexes. Our remaining actionable candidate is checking delivery next week. The vendor contact is already done: verify the new original, remove that candidate rather than merely labeling it pending, preserve the historical timeline and all original evidence. Finish all unorganized batches.',
  );
  const indexes = (await f.invoke('MemoryIndexList', {})).indexes;
  report.indexes = [];
  for (const i of indexes) {
    const read = await f.invoke('MemoryIndexRead', { indexId: i.id });
    assert.equal(read.items.length, 0);
    report.indexes.push({ ...i, entries: read.entries.items });
  }
  const entries = report.indexes.find((i: any) => i.name === 'todo').entries;
  assert.ok(entries.length > 0, 'delivery follow-up remains');
  assert.ok(
    !entries.some((e: any) => contactIds.includes(e.id)),
    'completed contact must be removed',
  );
  assert.ok(
    report.turns.flat().some((e) => e.type === 'tool_start' && e.toolName === 'MemoryOriginal'),
  );
  report.ok = true;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await backend.dispose();
  await f.close();
  report.requests = requests;
  report.endedAt = Date.now();
  await mkdir('.artifacts/live', { recursive: true });
  const path = '.artifacts/live/report-' + report.startedAt + '.json';
  await writeFile(path, JSON.stringify(report, null, 2).split(key).join('[REDACTED]'), {
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: report.ok, error: report.error, report: path }));
}
