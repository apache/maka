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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuickDiscoveryController } from '../../../../src/assistant/index-initiative/quick.js';

export async function intakeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'maka-intake-'));
  let now = Date.now(),
    fail = false,
    allow = true,
    scope = 1,
    modelCalls = 0,
    workerCalls = 0;
  const feed: any[] = [],
    prompts: string[] = [],
    delivered = new Map(),
    sessions: any[] = [],
    sourceCalls: any[] = [],
    messages: any[] = [];
  let q: QuickDiscoveryController;
  const agent = {
    sessionId: 'worker',
    snapshot: async () => ({ agent: { status: 'idle' } }),
    followup: async (text: string) => {
      workerCalls++;
      prompts.push(text);
      return { disposition: 'turn_started' };
    },
    messageExecution: async () => ({ state: 'owned' }),
    whenIdle: async () => {},
    cancel: async () => {},
  };
  const parent = {
    abort: new AbortController(),
    bindingReady: Promise.resolve(),
    refreshNotebook: () => {},
    store: { get: () => ({ sessionId: 'owner', cwd: root }) },
    asOwner: (_: any, fn: any) => fn(),
  };
  const ctx: any = {
    sessionQuery: {
      list: async () => sessions,
      historyList: async () => [],
      historyRead: async () => ({ messages: [] }),
      read: async () => ({ messages }),
    },
    sources: {
      list: () => [{ id: 'mail', scope: { scope }, changes: true }],
      changes: async (_: string, cursor?: string, limit = 50) => {
        sourceCalls.push(cursor);
        if (fail) throw Error('offline');
        const after = cursor ? Number(cursor) : feed.length;
        const items = feed.slice(after, after + limit);
        return {
          items,
          cursor: String(after + items.length),
          more: after + items.length < feed.length,
        };
      },
      authorize: async (_: string, objects: any[]) => (allow ? objects.map((o) => o.id) : []),
      activityToken: async () => String(feed.length),
    },
    agents: {
      create: async (input: any) => {
        sessions.push({ id: 'worker', ...input });
        return agent;
      },
      resume: async () => agent,
    },
    bot: {
      post: (_: string, m: any) => {
        delivered.set(m.id, m);
        return true;
      },
    },
    llm: {
      budget: async () => ({
        modelId: 'fixture',
        maxInputTokens: 64000,
        maxOutputTokens: 2048,
        estimate: 'utf8-conservative',
      }),
      generate: async (_input: any) => {
        modelCalls++;
        return { modelId: 'fixture', text: JSON.stringify('客户安排可能有变化') };
      },
    },
  };
  const start = async () => {
    q = new QuickDiscoveryController(ctx, parent, root, () => now);
    q.start(3600000);
    await q.control({ action: 'enable', eventIntake: true });
  };
  await start();
  return {
    get q() {
      return q;
    },
    root,
    ctx,
    parent,
    agent,
    feed,
    prompts,
    delivered,
    messages,
    sourceCalls,
    advance: (n = 6000) => {
      now += n;
    },
    fail: (v: boolean) => {
      fail = v;
    },
    allow: (v: boolean) => {
      allow = v;
    },
    scope: () => {
      scope++;
    },
    counts: () => ({ modelCalls, workerCalls }),
    add: (id: string, text = id, group = 'chat') => {
      feed.push({
        id,
        group,
        occurredAt: now,
        object: { id, revision: '1', kind: 'message', locator: { id } },
        content: text,
      });
    },
    restart: async () => {
      await q.close();
      q.store.close();
      await start();
    },
    close: async () => {
      await q.close();
      q.store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
