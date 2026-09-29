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

export async function fixture(bundle = true) {
  const root = await mkdtemp(join(tmpdir(), 'memory-host-'));
  const ctx = new Main.Context(),
    agents = new Main.PluginAgentService(ctx);
  const sessions = new Map([
    ['chat-a', [{ id: 'a', type: 'user', text: 'Need to contact the equipment vendor' }]],
    ['chat-b', [{ id: 'b', type: 'user', text: 'Delivery is due next week' }]],
  ]);
  let incognito = false;
  const query = new Main.PluginSessionQueryService(ctx, agents);
  const allowed = () => {
    if (incognito) throw Error('Incognito blocks history');
    return [...sessions.keys()].map((id) => ({ id }));
  };
  query.bindRuntime({
    list: async () => [],
    read: async () => undefined,
    search: async () => ({ items: [] }),
    historyList: async (caller) => {
      assert.equal(caller.invocation.sessionId, 'agent-chat');
      return allowed();
    },
    historyRead: async (id, caller) => {
      assert.equal(caller.invocation.sessionId, 'agent-chat');
      allowed();
      return { session: { id }, messages: sessions.get(id) };
    },
  });
  const storage = new Main.PluginStorageService(ctx);
  const dataRuntime = new Main.HostPluginDataRuntime(join(root, 'control'));
  storage.bindRuntime(dataRuntime);
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
  patch[0].entry.config = { dataDirectory: join(root, 'data') };
  await writeFile(join(pkg, 'maka.composition.json'), JSON.stringify(patch));
  const installed = await platform.installPackage(
    bundle ? resolve('release/memory-network.maka-extension') : pkg,
  );
  assert.deepEqual(installed.failures, []);
  const invoke = async (name: string, input: any) => {
    const tool = tools.resolve('agent-chat', []).tools.find((x: any) => x.name === name);
    assert.ok(tool, name);
    return tool.impl(tool.parameters.parse(input), {
      sessionId: 'agent-chat',
      turnId: 'turn-1',
      toolCallId: randomUUID(),
      cwd: root,
      abortSignal: new AbortController().signal,
      permissionMode: 'default',
    });
  };
  return {
    root,
    ctx,
    tools,
    systemPrompt,
    sessions,
    invoke,
    setIncognito: (value: boolean) => {
      incognito = value;
    },
    close: async () => {
      await platform.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
