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

import { mkdtemp, mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { nativeFixture } from '../../native-fixture.js';
import * as Main from '../.artifacts/main-api.mjs';
export const ID = 'dev.maka.proactive-matters';
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(check: () => any, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(10);
  }
  throw Error('Timed out waiting for assertion');
}
export class AgentDriver {
  sessions = new Map<string, any>();
  calls: any[] = [];
  onFollowup?: (id: string, prompt: string, turn: string) => void;
  add(id = 'session-1', running = true) {
    this.sessions.set(id, { running, waiters: [], turnId: 'turn-initial' });
  }
  end(id = 'session-1') {
    const s = this.sessions.get(id);
    s.running = false;
    for (const done of s.waiters.splice(0)) done();
  }
  runtime: any;
  constructor() {
    this.runtime = {
      create: async () => {
        throw Error('Plugin must not spawn another agent');
      },
      resume: async (o: any, inv: any) => {
        this.calls.push({ op: 'resume', id: o.sessionId, inv });
        if (!this.sessions.has(o.sessionId)) throw Error('Missing session');
        return { id: o.sessionId, sessionId: o.sessionId, root: true };
      },
      followup: async (id: string, prompt: string, inv: any) => {
        const s = this.sessions.get(id);
        if (!s) throw Error('Missing session');
        s.running = true;
        s.turnId = randomUUID();
        this.calls.push({ op: 'followup', id, prompt, inv });
        setTimeout(() => this.onFollowup?.(id, prompt, s.turnId), 0);
        return { disposition: 'turn_started', turnId: s.turnId };
      },
      snapshot: async (id: string) => ({
        agent: { status: this.sessions.get(id)?.running ? 'running' : 'idle' },
      }),
      whenIdle: async (id: string, signal: any) => {
        const s = this.sessions.get(id);
        if (!s.running) return;
        await new Promise<void>((done, reject) => {
          s.waiters.push(done);
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      },
      cancel: async (id: string) => {
        this.calls.push({ op: 'cancel', id });
        this.end(id);
      },
      get: async (id: string) => ({ id, sessionId: id, root: true }),
      list: async () => [],
      roots: async () => [],
      steer: async () => {},
      inject: async () => {},
      inbox: async () => [],
      result: async () => null,
      artifacts: async () => [],
      transcript: async () => [],
      dispose: async () => {},
    };
  }
}
export async function fixture(options: any = {}) {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), 'maka-followup-plugin-')));
  const control = join(root, 'control');
  const ctx = new Main.Context();
  const agents = new Main.PluginAgentService(ctx);
  const driver = options.driver ?? new AgentDriver();
  if (!options.driver) driver.add();
  agents.bindRuntime(driver.runtime);
  const query = new Main.PluginSessionQueryService(ctx, agents);
  query.bindRuntime({
    list: async () =>
      [...driver.sessions].map(([id, s]: any) => ({
        id,
        title: s.name,
        labels: s.labels,
        parentSessionId: s.parentSessionId,
        cwd: root,
      })),
    read: async (id: string) =>
      driver.sessions.has(id) ? { session: { id, cwd: root }, messages: [] } : undefined,
    search: async () => ({ items: [] }),
  });
  const reviewCalls: any[] = [];
  const llm = new Main.PluginLlmService(ctx, agents);
  llm.bindRuntime({
    generate: async (input: any) => {
      reviewCalls.push(JSON.parse(input.prompt));
      return options.review
        ? options.review(input)
        : {
            text: JSON.stringify({ approved: true, feedback: 'Fixture evidence accepted' }),
            modelId: 'fixture-review',
          };
    },
  });
  new Main.PluginSourceService(ctx, agents);
  new Main.PluginToolService(ctx, { agents });
  new Main.PluginSystemPromptService(ctx);
  const native = await nativeFixture(
    Main,
    ctx,
    root,
    { 'proactive-matters': { tickMs: 20, ...options.config } },
    { 'proactive-matters': join(root, 'data') },
    options.dependencies ?? {},
  );
  const { tools, prompts: systemPrompt, turns, remote, platform } = native;
  await until(async () => (await remote('matters.list')).ready);
  // Business-flow fixtures explicitly admit their coordinator; ordinary callers remain denied.
  if (!(await remote('matters.list')).matters.some((m: any) => m.sessionId === 'session-1'))
    await remote('matters.authorize-session', { sessionId: 'session-1' });
  const invoke = async (
    name: string,
    input: any = {},
    turn = 'turn-initial',
    session = 'session-1',
  ) => {
    if (name === 'MatterStart') await remote('matters.authorize-session', { sessionId: session });
    const tool = tools.resolve(session, []).tools.find((t: any) => t.name === name);
    if (!tool) throw Error('Missing tool ' + name);
    return tool.impl(tool.parameters.parse(input), {
      sessionId: session,
      turnId: turn,
      toolCallId: randomUUID(),
      cwd: root,
      abortSignal: new AbortController().signal,
      permissionMode: 'default',
    });
  };
  return {
    root,
    ctx,
    platform,
    driver,
    reviewCalls,
    filterTools: native.filterTools,
    tools,
    systemPrompt,
    turns,
    remote,
    invoke,
    close: native.close,
  };
}
