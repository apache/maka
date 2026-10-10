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

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { PROACTIVE_TASK } from './prompt.js';
import type { InitiativeStore } from './store.js';
import type { InitiativeController } from './controller.js';

/** Product entry composed through plugin services; opening it does not start a model. */
export function registerAssistant(
  ctx: any,
  store: InitiativeStore,
  controller: InitiativeController,
) {
  const tool = (name: string) =>
    ctx.tools.resolve(store.get()?.sessionId, []).tools.find((t: any) => t.name === name);
  const invoke = (name: string, input: any = {}) => {
    const state = store.get(),
      target = tool(name);
    if (!state || !target) throw Error('所需插件尚未就绪：' + name);
    const call = {
      sessionId: state.sessionId,
      cwd: state.cwd,
      turnId: 'assistant-ui',
      toolCallId: randomUUID(),
      abortSignal: controller.abort.signal,
    };
    return ctx.agents.withInvocation(call, () => target.impl(target.parameters.parse(input), call));
  };
  const summary = async (input: any = {}) => {
    const includeMemory = input.includeMemory !== false;
    const state = store.get();
    const memory = tool('MemoryStatus');
    const tasks = tool('MatterOverview');
    let memoryState: any = { installed: !!memory, sources: [], indexes: [] };
    if (includeMemory && memory && state) {
      try {
        memoryState = { installed: true, ...(await invoke('MemoryStatus')) };
      } catch (error) {
        memoryState.error = String(error);
      }
    }
    let taskState: any = { installed: !!tasks, items: [], legacy: [] };
    if (tasks && state) {
      try {
        taskState = { installed: true, ...(await invoke('MatterOverview')) };
      } catch (error) {
        taskState.error = String(error);
      }
    }
    return {
      state,
      ...(includeMemory ? { memory: memoryState } : {}),
      tasks: taskState,
      hostRequired: true,
    };
  };
  ctx.clientBridge.rpc({ name: 'assistant.binding', invoke: () => ({ state: store.get() }) });
  ctx.clientBridge.rpc({ name: 'assistant.status', invoke: summary });
  ctx.clientBridge.rpc({
    name: 'assistant.bind',
    invoke: async (input: any) => {
      const { sessionId } = z.object({ sessionId: z.string().min(1).max(300) }).parse(input);
      controller.ready();
      if (store.get()) return store.get();
      // Use Host metadata, never a client-supplied cwd or a guessed Session identity.
      const snapshot = await ctx.sessionQuery.read(sessionId);
      if (!snapshot?.session?.cwd) throw Error('无法读取助手会话，请确认对应 Host 在线后重试。');
      return store.bind({ sessionId, cwd: snapshot.session.cwd }, PROACTIVE_TASK);
    },
  });
  ctx.clientBridge.rpc({
    name: 'assistant.control',
    invoke: async (input: any) => {
      const args = z
        .object({
          action: z.enum(['enable', 'pause', 'resume', 'check']),
          intervalMinutes: z.number().int().min(1).max(10080).optional(),
        })
        .parse(input);
      const state = store.get();
      if (!state) throw Error('请先打开个人助手。');
      if (args.action === 'enable') {
        await controller.enable(
          {
            instructions: state.instructions,
            intervalMinutes: args.intervalMinutes ?? state.intervalMs / 60000,
          },
          state,
        );
        // Explicit UI enable gives first-use feedback now, rather than after an invisible delay.
        return controller.control('check', state);
      }
      return controller.control(args.action, state);
    },
  });
  ctx.clientBridge.rpc({
    name: 'assistant.adopt-task',
    invoke: (input: any) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(input);
      controller.ready();
      const state = store.get();
      if (!state) throw Error('请先打开个人助手。');
      const tasks = tool('MatterOverview');
      if (!tasks) throw Error('请先安装持续跟进插件。');
      return invoke('MatterAdopt', { id });
    },
  });
}
