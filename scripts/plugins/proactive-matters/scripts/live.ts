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
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture as platformFixture, AgentDriver, sleep } from '../test/platform-helper.js';
import { createHandoffFixture } from '../test/handoff-fixture.mjs';
import { buildHandoffTools } from '../test/handoff-tools.js';
import {
  createTestAiSdkBackend,
  getAIModel,
  createSessionEventMapMemory,
  mapSessionEventToRuntimeEvent,
} from '../.artifacts/live-api.mjs';
const key = process.env.MAKA_SCENARIO_API_KEY;
if (!key) throw Error('Provide MAKA_SCENARIO_API_KEY in the process environment');
const modelId = process.env.MAKA_SCENARIO_MODEL ?? 'deepseek-flash';
await mkdir('.artifacts/live', { recursive: true });
const root = await mkdtemp(resolve('.artifacts/live/handoff-'));
const startedAt = Date.now();
const report: any = {
  ok: false,
  main: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  modelId,
  startedAt,
  turns: [],
  usage: [],
  errors: [],
};
const redact = (s: string) => s.split(key).join('[REDACTED]');
const log = (event: string, detail: any = {}) =>
  process.stdout.write(JSON.stringify({ event, at: Date.now() - startedAt, ...detail }) + '\n');
const world = await createHandoffFixture({ root, startedAt });
const driver = new AgentDriver();
driver.add();
let backend: any, f: any;
let current: Promise<void> | undefined;
let requests = 0;
const ledger: any[] = [];
const header = {
  id: 'session-1',
  workspaceRoot: root,
  cwd: root,
  createdAt: startedAt,
  name: '插件交付跟进',
  titleIsManual: true,
  isFlagged: false,
  labels: [],
  isArchived: false,
  status: 'active',
  statusUpdatedAt: startedAt,
  hasUnread: false,
  backend: 'ai-sdk',
  llmConnectionId: 'live',
  llmConnectionSlug: 'live',
  connectionLocked: true,
  model: modelId,
  permissionMode: 'bypass',
  schemaVersion: 1,
};
async function run(text: string, turnId: string) {
  const runId = randomUUID(),
    invocationId = randomUUID();
  const anchor = {
    id: randomUUID(),
    invocationId,
    runId,
    sessionId: 'session-1',
    turnId,
    ts: Date.now(),
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text },
  };
  const prior = [...ledger];
  ledger.push(anchor);
  const memory = createSessionEventMapMemory();
  const turn: any = {
    turnId,
    startedAt: Date.now(),
    tools: [],
    wake: text.startsWith('Runtime wake'),
  };
  report.turns.push(turn);
  log('turn', { turn: report.turns.length, wake: turn.wake });
  try {
    for await (const event of backend.send({
      turnId,
      runId,
      invocationId,
      text,
      context: [],
      runtimeContext: prior,
      headAnchorRuntimeEvent: anchor,
    })) {
      if (event.type === 'tool_start') {
        turn.tools.push({
          name: event.toolName,
          args: event.args,
          at: Date.now(),
        });
        log('tool', { name: event.toolName });
      }
      if (event.type === 'error') {
        report.errors.push(redact(event.message));
        log('runtime-error', { message: redact(event.message) });
      }
      if (event.type === 'tool_result' && event.isError)
        log('tool-error', { text: String(event.content).slice(0, 800) });
      if (event.type === 'token_usage') report.usage.push(event);
      const mapped = mapSessionEventToRuntimeEvent(
        event,
        { sessionId: 'session-1', turnId, runId, invocationId, now: Date.now },
        memory,
      );
      if (mapped.partial !== true && mapped.content?.kind !== 'error') ledger.push(mapped);
      if (!['text_delta', 'thinking_delta'].includes(event.type))
        await appendFile(join(root, 'trace.jsonl'), redact(JSON.stringify(event)) + '\n');
    }
  } catch (e) {
    report.errors.push(redact(String(e)));
  } finally {
    turn.endedAt = Date.now();
    driver.end();
    log('turn-ended');
  }
}
try {
  f = await platformFixture({ root, driver, timeout: 120000 });
  backend = createTestAiSdkBackend({
    sessionId: 'session-1',
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
    maxSteps: 32,
    tools: [...f.tools.resolve('session-1', []).tools, ...buildHandoffTools(world)],
    loadTurnRuntimeEvents: async (id: string) => ledger.filter((e) => e.turnId === id),
    systemPrompt: async (c: any) =>
      f.systemPrompt.assemble(
        c,
        'You are Maka. Carry out the user objective using the available tools. Respond in Chinese. Do not invent observations. Short state snapshots and concise progress reports are sufficient.',
      ),
    modelFactory: (input: any) =>
      getAIModel({
        ...input,
        fetch: async (url: any, init: any) => {
          requests++;
          if (requests > 85) throw Error('Live model request budget exceeded');
          const body = JSON.parse(init.body);
          const t = report.turns.at(-1);
          if (t && !t.providerHistory) {
            t.providerHistory = {
              messages: body.messages?.length,
              priorToolResults: body.messages?.filter((m: any) => m.role === 'tool').length,
            };
          }
          return fetch(url, init);
        },
      }),
  });
  driver.onFollowup = (id, prompt, turn) => {
    current = run(prompt, turn);
  };
  driver.runtime.cancel = async () => {
    await backend.stop?.();
    await current;
    driver.end();
  };
  const request = `帮我持续跟进品牌升级项目 brand-refresh 的设计交付（项目任务 BRAND-42）。当前最终稿文件完整、设计负责人视觉验收通过后，在 ${world.date} 15:00–17:00（Asia/Shanghai）找一个我和设计负责人都空闲的半小时，在我的日历里创建一场验收会议，附上那份已确认的稿件，再把项目任务更新为 ready_for_review，并关联稿件和会议。现在只安排，不发送邀请或其他消息。资料没齐先继续跟进；重要进展再告诉我，六分钟内还没全部办好就说明卡在哪里。`;
  current = run(request, 'turn-initial');
  let amended = false;
  while (Date.now() - startedAt < 420000) {
    await sleep(250);
    const view = await f.remote('matters.list');
    const m = view.matters[0];
    if (!amended && Date.now() - startedAt >= 60000 && m) {
      amended = true;
      await f.remote('matters.message', {
        id: m.id,
        text: '验收加上无障碍检查，必须针对最新稿通过。前面那个旧版别用了。会议时间范围不变，不要发邀请。',
      });
      log('user-amendment');
    }
    if (m?.status === 'completed' && !m.activation) break;
    if (m?.status === 'paused') {
      throw Error('Matter paused: ' + m.lastError);
    }
  }
  await current;
  report.final = await f.remote('matters.list');
  const m = report.final.matters[0];
  const w = world.snapshot();
  assert.equal(m?.status, 'completed');
  assert.equal(w.events.length, 1);
  assert.equal(w.events[0].fileId, 'design-v3');
  assert.equal(w.events[0].sendInvites, false);
  assert.equal(w.taskWrites.length, 1);
  assert.equal(w.task.status, 'ready_for_review');
  assert.equal(w.task.fileId, 'design-v3');
  assert.equal(w.task.calendarEventId, w.events[0].id);
  assert.ok(w.slotRace && w.lostConfirmation && w.taskConflict);
  assert.ok(w.taskWrites[0].at - startedAt < 360000);
  assert.ok(report.turns.some((t: any) => t.wake));
  assert.ok(report.turns.slice(1).every((t: any) => t.providerHistory.priorToolResults > 0));
  assert.deepEqual(m.wakes, []);
  const calls = w.calls.length,
    turns = report.turns.length;
  world.publishLaterChange();
  await sleep(6000);
  assert.equal(world.calls.length, calls);
  assert.equal(report.turns.length, turns);
  assert.equal(report.errors.length, 0);
  report.ok = true;
} catch (e) {
  report.errors.push(redact(String(e)));
  log('failed', { error: redact(String(e)) });
  process.exitCode = 1;
} finally {
  if (f) {
    report.final = await f.remote('matters.list').catch(() => report.final);
    await f.close();
  }
  await backend?.dispose();
  report.world = world.snapshot();
  report.requests = requests;
  report.endedAt = Date.now();
  await writeFile(join(root, 'report.json'), redact(JSON.stringify(report, null, 2)), {
    mode: 0o600,
  });
  await world.close();
  log('finished', { ok: report.ok, report: join(root, 'report.json') });
}
