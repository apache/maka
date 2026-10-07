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
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as Main from '../.artifacts/main-api.mjs';

export async function fixture(options: any = {}) {
  const root = await mkdtemp(join(tmpdir(), 'initiative-test-'));
  const ctx = new Main.Context(), agents = new Main.PluginAgentService(ctx);
  const tools = new Main.PluginToolService(ctx, { agents }), prompts = new Main.PluginSystemPromptService(ctx);
  const turns = new Main.PluginTurnFinishService(ctx), query = new Main.PluginSessionQueryService(ctx, agents);
  const sessions = new Map<string, any[]>([
    ['project', [{ id: 'deadline', type: 'user', text: 'Demo is Friday; prepare a backup checklist if delivery slips.' }]],
    ['supplier', [{ id: 'promise', type: 'assistant', text: 'Supplier promises delivery Thursday.' }]],
  ]);
  query.bindRuntime({ list: async () => [], read: async () => undefined, search: async () => ({ items: [] }),
    historyList: async () => [...sessions].map(([id, messages]) => ({ id, title: id, historyRevision: JSON.stringify(messages) })),
    historyRead: async (id: string) => ({ session: { id }, messages: sessions.get(id) }),
  });
  const workers = new Map<string, any>(); let runner: any; let indexRunner: any; let beforeRun: any; let queued = false; let cancels = 0;
  const invokeAs = async (sessionId: string, name: string, input: any, turnId = 'foreground') => {
    const tool = tools.resolve(sessionId, []).tools.find((t: any) => t.name === name); assert.ok(tool, name);
    return tool.impl(tool.parameters.parse(input), { sessionId, turnId, toolCallId: randomUUID(), cwd: root, abortSignal: new AbortController().signal, permissionMode: 'default' });
  };
  agents.bindRuntime({
    create: async (input: any) => { assert.equal(input.background, true); const id = randomUUID(); workers.set(id, { status: 'idle' }); return { id, sessionId: id, root: false }; },
    resume: async ({ sessionId }: any) => ({ id: sessionId, sessionId, root: false }),
    snapshot: async (id: string) => ({ agent: { status: workers.get(id)?.status ?? 'idle' } }),
    cancel: async (id: string) => { cancels++; workers.get(id).status = 'idle'; },
    whenIdle: async (id: string, signal: AbortSignal) => {
      signal?.throwIfAborted();
      let onAbort: any;
      try { await Promise.race([workers.get(id)?.task, new Promise((_, reject) => { onAbort = () => reject(signal.reason); signal?.addEventListener('abort', onAbort, { once: true }); })]); }
      finally { signal?.removeEventListener('abort', onAbort); }
    },
    followup: async (id: string, prompt: string) => {
      const w = workers.get(id), turnId = randomUUID(); w.status = queued ? 'idle' : 'running';
      w.task = (async () => {
        await beforeRun?.(prompt); w.status = 'running';
        const invoke = (name: string, input: any) => invokeAs(id, name, input, turnId);
        if (prompt.startsWith('Organize index')) {
          const indexId = /Organize index ([^. ]+)/.exec(prompt)![1];
          const index = await invoke('MemoryIndexRead', { indexId });
          if (indexRunner) { await indexRunner({ index, invoke }); return; }
          const page = await invoke('MemoryHistory', { from: index.range.from, to: index.range.to, mode: 'messages', recordId: index.index.name === 'Project context' ? 'project' : 'supplier' });
          const saved = await invoke('MemoryIndexWrite', { indexId, key: 'evidence', expectedRevision: index.index.revision, text: page.items.map((m: any) => m.message.text + ' ' + m.citation).join('\n') });
          await invoke('MemoryIndexCheckpoint', { indexId, rangeId: index.range.rangeId, expectedRevision: saved.revision, notes: 'Fixture index built', complete: true });
        } else await runner({ id, prompt, turnId, invoke, finish: () => turns.evaluate({ sessionId: id, turnId, signal: new AbortController().signal }) });
      })().finally(() => { w.status = 'idle'; });
      void w.task.catch(() => {});
      return { disposition: queued ? 'followup' : 'turn_started', turnId };
    },
  });
  const storage = new Main.PluginStorageService(ctx), data = new Main.HostPluginDataRuntime(join(root, 'control')); storage.bindRuntime(data);
  const bridge = new Main.PluginClientBridgeService(ctx), composition = new Main.MakaCompositionLoader({ root: ctx });
  const platform = new Main.HostPluginPlatform(join(root, 'control'), { composition, tools, systemPrompt: prompts, clientBridge: bridge });
  await platform.recover();
  const install = async (directory: string, id: string, config: any, bundle?: string) => {
    await data.mutate({ extensionId: id, scopeId: 'profile' }, 'storage', [{ key: 'data-directory', value: join(root, id) }]);
    const target = join(root, id + '-package'); await mkdir(join(target, 'dist'), { recursive: true });
    for (const file of ['maka.extension.json', 'dist/host.mjs']) await copyFile(join(directory, file), join(target, file));
    const patch = JSON.parse(await readFile(join(directory, 'maka.composition.json'), 'utf8')); patch[0].entry.config = config;
    await writeFile(join(target, 'maka.composition.json'), JSON.stringify(patch));
    const result = await platform.installPackage(bundle ?? target); assert.deepEqual(result.failures, []);
  };
  await install(resolve('../memory-network'), 'dev.maka.memory-network', { tickMs: 60000, runTimeoutMs: 5000 });
  await install(resolve('.'), 'dev.maka.index-initiative', { tickMs: options.tickMs ?? 10, runTimeoutMs: options.runTimeoutMs ?? 5000 }, options.bundle);
  return { root, ctx, tools, turns, prompts, workers, sessions, invokeAs, cancels: () => cancels,
    invoke: (name: string, input: any = {}) => invokeAs('owner', name, input),
    setIndexRunner: (fn: any) => { indexRunner = fn; },
    setRunner: (fn: any) => { runner = fn; }, setGate: (fn: any, q = false) => { beforeRun = fn; queued = q; },
    close: async () => { await platform.close(); if (!options.keep) await rm(root, { recursive: true, force: true }); },
  };
}
export async function until(fn: () => any, timeout = 5000) {
  const start = Date.now(); while (!await fn()) { if (Date.now() - start > timeout) throw Error('Test condition timed out'); await new Promise(r => setTimeout(r, 10)); }
}
export function checkpoint(s: any, overrides: any = {}) {
  return { activationId: s.active.id, revision: s.revision, summary: 'No relevant change; quiet check', notebook: 'Remember the previous decision and check for fresh evidence.', bookmarks: {}, records: [], update: '', nextCheckAt: new Date(Date.now() + 3600000).toISOString(), nextReason: 'Check for new evidence later', ...overrides };
}
