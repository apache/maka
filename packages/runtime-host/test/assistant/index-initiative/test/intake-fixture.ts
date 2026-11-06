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
import { InitiativeStore } from '../../../../src/assistant/index-initiative/store.js';
import { DiscoveryRunner } from '../../../../src/assistant/index-initiative/runner.js';

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
    messages: any[] = [],
    history = new Map<string, any[]>();
  let q: QuickDiscoveryController;
  const admitted = new Set<string>();
  let terminalStatus = 'idle';
  let idle = async () => {};
  const agent = {
    sessionId: 'worker',
    snapshot: async () => ({ agent: { status: terminalStatus }, pendingInteractions: 0 }),
    followup: async (text: string, options: { messageId: string }) => {
      admitted.add(options.messageId);
      workerCalls++;
      prompts.push(text);
      return { disposition: 'turn_started' };
    },
    messageExecution: async (messageId: string) => ({
      state: admitted.has(messageId) ? 'owned' : 'not_admitted',
    }),
    whenIdle: async () => {
      try {
        await idle();
        terminalStatus = 'idle';
      } catch (error) {
        terminalStatus = 'blocked';
        throw error;
      }
    },
    cancel: async () => {},
  };
  const parentStore = new InitiativeStore(root, 'parent');
  parentStore.lease();
  parentStore.bind({ sessionId: 'owner', cwd: root });
  const parent = {
    runner: new DiscoveryRunner(parentStore, () => 0),
    abort: new AbortController(),
    bindingReady: Promise.resolve(),
    notebook: { continuation: () => [] },
    refreshNotebook: () => {},
    store: parentStore,
    asOwner: (_: any, fn: any) => fn(),
  };
  const ctx: any = {
    sessionQuery: {
      list: async () => sessions,
      historyList: async () =>
        [...history].map(([id, entries]) => ({
          id,
          historyRevision: JSON.stringify(entries),
        })),
      historyRead: async (id: string) => ({ session: { id }, messages: history.get(id) ?? [] }),
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
    failIdle: (message = 'worker unavailable') => {
      idle = async () => {
        throw Error(message);
      };
    },
    idle: () => {
      terminalStatus = 'idle';
      idle = async () => {};
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
    /** Append a real protocol frame to a session history the assistant can already see. */
    say: (sessionId: string, message: any) => {
      history.set(sessionId, [...(history.get(sessionId) ?? []), message]);
    },
    restart: async () => {
      await q.close();
      q.store.close();
      await start();
    },
    close: async () => {
      await q.close();
      q.store.close();
      parentStore.release();
      parentStore.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
