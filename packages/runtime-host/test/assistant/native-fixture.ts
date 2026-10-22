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

import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
export async function nativeFixture(
  Main: any,
  ctx: any,
  root: string,
  configs: any = {},
  paths: any = {},
  dependencies: any = {},
) {
  const data = new Main.HostPluginDataRuntime(join(root, 'control'));
  const platform = new Main.HostPluginPlatform(join(root, 'control'), {
    composition: new Main.MakaCompositionLoader({ root: ctx }),
    tools: ctx.tools,
    systemPrompt: ctx.systemPrompt,
    replacedPackages: [
      'dev.maka.memory-network',
      'dev.maka.proactive-matters',
      'dev.maka.index-initiative',
    ],
  });
  await platform.recover();
  const entries = [];
  for (const name of ['memory-network', 'proactive-matters', 'index-initiative']) {
    await data.mutate({ extensionId: 'dev.maka.' + name, scopeId: 'profile' }, 'storage', [
      { key: 'data-directory', value: paths[name] ?? join(root, 'dev.maka.' + name) },
    ]);
    entries.push({
      id: name,
      packageId: 'dev.maka.' + name,
      rootId: 'profile',
      children: [],
      config: configs[name] ?? { tickMs: 60000 },
    });
  }
  const directory = join(root, 'native');
  let service: any;
  const runtimeEvents: any[] = [];
  const initialize = async () => {
    service = new Main.PersonalAssistantService(directory, {
      readRuntimeEvents: async () => runtimeEvents,
      prepareBotWake: async () => 'ready',
      ...dependencies,
      stopSessions: async () => {},
      markBackgroundSessions: async () => {},
      agents: ctx.agents,
      llm: ctx.llm,
      sessionQuery: ctx.sessionQuery,
      sources: ctx.sources,
      resolveTools: (id: string, core: any) => ctx.tools.resolve(id, core),
    });
    await service.recover(data, entries);
    service.start();
    await service.call('assistant.set-enabled', { enabled: true });
  };
  await initialize();
  return {
    platform,
    filterTools: (sessionId: string, tools: any[]) => service.filterTools(sessionId, tools),
    tools: {
      resolve: (id: string, core: any[] = []) => {
        const resolved = ctx.tools.resolve(id, [...core, ...service.tools]);
        return {
          ...resolved,
          tools: resolved.tools.map((tool: any) => ({
            ...tool,
            impl: async (input: any, call: any) => {
              const prompt = await service.prompt({
                sessionId: call.sessionId,
                turnId: call.turnId,
                cwd: call.cwd,
              });
              for (const context of prompt.contexts ?? [])
                runtimeEvents.push({
                  sessionId: call.sessionId,
                  turnId: call.turnId,
                  role: 'system',
                  author: 'host',
                  content: { kind: 'text', runtimeContextName: context.name, text: context.text },
                });
              runtimeEvents.push({
                sessionId: call.sessionId,
                turnId: call.turnId,
                content: { kind: 'function_call', id: call.toolCallId },
              });
              return tool.impl(input, call);
            },
          })),
        };
      },
    },
    prompts: { assemble: (context: any, base?: string) => service.prompt(context, base) },
    turns: { evaluate: (context: any) => service.beforeFinish(context) },
    send: (sessionId: string, id: string, content: any) =>
      service.receiveUser(sessionId, id, content),
    remote: (method: string, input: any = {}) => service.call(method, input),
    restart: async (patch?: any) => {
      await service.close();
      if (patch) {
        const path = join(directory, 'assistant.json');
        const settings = JSON.parse(await readFile(path, 'utf8'));
        for (const [name, config] of Object.entries(patch)) settings[name].config = config;
        await writeFile(path, JSON.stringify(settings));
      }
      await initialize();
    },
    close: async () => {
      await service.close();
      await platform.close();
    },
  };
}
