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
import { mkdtemp, rm, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as Main from '../.artifacts/main-api.mjs';
const ID = 'dev.maka.memory-network';

export async function fixture(bundle = true, config: any = {}) {
  const root = await mkdtemp(join(tmpdir(), 'memory-host-'));
  const ctx = new Main.Context(),
    agents = new Main.PluginAgentService(ctx);
  const llm = new Main.PluginLlmService(ctx, agents);
  const llmCalls: any[] = [];
  let extractRunner = async (input: any) => ({
    text: 'Extracted content',
    modelId: 'fixture-model',
    finishReason: 'stop',
  });
  llm.bindRuntime({
    generate: async (input: any) => {
      llmCalls.push(input);
      return extractRunner(input);
    },
  });
  const sessions = new Map([
    ['chat-a', [{ id: 'a', type: 'user', text: 'Need to contact the equipment vendor' }]],
    ['chat-b', [{ id: 'b', type: 'user', text: 'Delivery is due next week' }]],
  ]);
  let incognito = false;
  let historyError = false;
  const reads: string[] = [];
  let workerRunner: ((id: string, prompt: string) => Promise<void>) | undefined;
  let beforeWorker: (() => Promise<void>) | undefined;
  const query = new Main.PluginSessionQueryService(ctx, agents);
  new Main.PluginSourceService(ctx, agents);
  const sources = ctx.extend({
    maka: {
      rootId: 'profile',
      packageId: 'test-sources',
      entryId: 'test-sources',
      generation: 1,
    },
  }).sources;
  const allowed = () => {
    if (incognito) throw Error('Incognito blocks history');
    return [...sessions.keys()].map((id) => ({
      id,
      historyRevision: JSON.stringify(sessions.get(id)),
    }));
  };
  query.bindRuntime({
    list: async () => [],
    read: async () => undefined,
    search: async () => ({ items: [] }),
    historyList: async (caller) => {
      assert.ok(caller.invocation.sessionId);
      return allowed();
    },
    historyRead: async (id, caller) => {
      if (historyError) throw Error('Source temporarily unavailable');
      assert.ok(caller.invocation.sessionId);
      allowed();
      reads.push(id);
      return { session: { id }, messages: sessions.get(id) };
    },
  });
  const workers = new Map<string, { task?: Promise<void>; status?: string }>();
  let cancellations = 0;
  agents.bindRuntime({
    create: async (options: any) => {
      assert.equal(options.background, true);
      const id = randomUUID();
      workers.set(id, {});
      return { id, sessionId: id, root: false };
    },
    resume: async ({ sessionId }: any) => ({ id: sessionId, sessionId, root: false }),
    snapshot: async (id: string) => ({
      agent: { status: workers.get(id)?.status ?? 'active' },
    }),
    whenIdle: async (id: string, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      let onAbort!: () => void;
      try {
        await Promise.race([
          workers.get(id)?.task,
          new Promise((_, reject) => {
            onAbort = () => reject(signal!.reason);
            signal?.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
    followup: async (id: string, prompt: string) => {
      const indexId = /Organize index ([^. ]+)/.exec(prompt)![1];
      const worker = workers.get(id)!;
      worker.task = (async () => {
        await beforeWorker?.();
        if (workerRunner) return workerRunner(id, prompt);
        const summary = await invokeAs(id, 'MemoryIndexRead', { indexId });
        const page = await invokeAs(id, 'MemoryHistory', {
          from: summary.range.from,
          to: summary.range.to,
          mode: 'messages',
          types: ['user', 'assistant'],
          limit: 500,
        });
        const text = page.items.map((x: any) => x.message.text).join(' ');
        const todo = summary.index.name === 'Candidate Todo';
        const key = todo ? 'vendor' : 'events';
        const old = await invokeAs(id, 'MemoryIndexContent', { indexId, key });
        const result = await invokeAs(id, 'MemoryIndexWrite', {
          indexId,
          key,
          expectedRevision: old.revision,
          text:
            todo && text.includes('contacted yesterday')
              ? ''
              : old.text +
                '\n' +
                page.items.map((x: any) => `${x.message.text} ${x.citation}`).join('\n'),
        });
        await invokeAs(id, 'MemoryIndexCheckpoint', {
          indexId,
          rangeId: summary.range.rangeId,
          expectedRevision: result.revision,
          notes: 'Organized the source range with citations.',
          complete: true,
        });
      })();
      return { disposition: 'turn_started' };
    },
    cancel: async () => {
      cancellations++;
    },
  });
  const storage = new Main.PluginStorageService(ctx);
  const dataRuntime = new Main.HostPluginDataRuntime(join(root, 'control'));
  storage.bindRuntime(dataRuntime);
  new Main.PluginCredentialService(ctx).bindRuntime(dataRuntime);
  await dataRuntime.mutate({ extensionId: ID, scopeId: 'profile' }, 'storage', [
    { key: 'data-directory', value: join(root, 'data') },
  ]);
  const tools = new Main.PluginToolService(ctx, { agents }),
    systemPrompt = new Main.PluginSystemPromptService(ctx);
  const bridge = new Main.PluginClientBridgeService(ctx),
    composition = new Main.MakaCompositionLoader({ root: ctx });
  const platform = new Main.HostPluginPlatform(join(root, 'control'), {
    composition,
    tools,
    systemPrompt,
    clientBridge: bridge,
  });
  await platform.recover();
  const pkg = join(root, 'package');
  await mkdir(join(pkg, 'dist'), { recursive: true });
  await copyFile(resolve('dist/host.mjs'), join(pkg, 'dist/host.mjs'));
  await copyFile('maka.extension.json', join(pkg, 'maka.extension.json'));
  const patch = JSON.parse(await readFile('maka.composition.json', 'utf8'));
  patch[0].entry.config = { dataDirectory: join(root, 'data'), ...config };
  await writeFile(join(pkg, 'maka.composition.json'), JSON.stringify(patch));
  const installed = await platform.installPackage(
    bundle ? resolve('release/memory-network.maka-extension') : pkg,
  );
  assert.deepEqual(installed.failures, []);
  const invokeAs = async (sessionId: string, name: string, input: any) => {
    const tool = tools.resolve(sessionId, []).tools.find((x: any) => x.name === name);
    assert.ok(tool, name);
    const result = await tool.impl(tool.parameters.parse(name === 'MemoryIndexCreate' ? { background: false, ...input } : input), {
      sessionId,
      turnId: 'turn-1',
      toolCallId: randomUUID(),
      cwd: root,
      abortSignal: new AbortController().signal,
      permissionMode: 'default',
    });
    assert.deepEqual(
      result,
      JSON.parse(JSON.stringify(result)),
      'Tool output must survive canonical ledger JSON without changing shape',
    );
    return result;
  };
  return {
    root,
    platform,
    ctx,
    tools,
    systemPrompt,
    sessions,
    reads,
    llmCalls,
    setExtractRunner: (fn: typeof extractRunner) => {
      extractRunner = fn;
    },
    query,
    sources,
    invokeAs,
    workers,
    cancellations: () => cancellations,
    setWorkerRunner: (fn: (id: string, prompt: string) => Promise<void>) => {
      workerRunner = fn;
    },
    setBeforeWorker: (fn?: () => Promise<void>) => {
      beforeWorker = fn;
    },
    invoke: (name: string, input: any) => invokeAs('agent-chat', name, input),
    setHistoryError: (value: boolean) => {
      historyError = value;
    },
    setIncognito: (value: boolean) => {
      incognito = value;
    },
    close: async () => {
      await platform.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
