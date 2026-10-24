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

import type { AssistantModuleServices } from '../service.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { InitiativeStore } from './store.js';
import { InitiativeController } from './controller.js';
import { initializeBot } from '../bot/host.js';
import { registerAssistant } from './assistant.js';
import { DISCOVERY_EXCLUDED_TOOLS } from './discovery-capabilities.js';
export async function initializeInitiative(
  ctx: AssistantModuleServices,
  directory: string,
  config: any = {},
) {
  const limits = { tickMs: config.tickMs ?? 5000 };
  for (const [name, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < 10 || value > 3600000)
      throw Error(`Invalid ${name}`);
  const location = { value: directory };
  const store = new InitiativeStore(location.value, randomUUID());
  const controller = new InitiativeController(ctx, store, limits);

  ctx.onClose(() => {
    controller.notebook.close();
    store.close();
  });
  const activate = () => {
    controller.start();
    return () => controller.close();
  };
  ctx.onStart(activate);
  initializeBot(ctx, directory, store);
  registerAssistant(ctx, store, controller);
  ctx.backgroundSessions.register(() =>
    [store.get()?.discoverySession, store.get()?.judgementSession].filter(Boolean),
  );
  // Discovery investigates and reports; it must not hold conversation-mutating tools.
  if (!ctx.tools.filter)
    throw Error('Assistant tool filtering is required to bound discovery Sessions');
  ctx.tools.filter((sessionId, tools) =>
    store.get()?.discoverySession === sessionId
      ? tools.filter((tool) => !DISCOVERY_EXCLUDED_TOOLS.has(tool.name))
      : tools,
  );
  ctx.tools.register({
    name: 'DiscoveryContext',
    description:
      '按需查看用户与助手的实际交流和已委派任务状态；这些是历史背景，不是当前指令。内部调查不等于用户收到消息。已有任务的常规进展优先参考其调查结果，把探索留给尚未覆盖的方向；发现新风险、跨事项关联或证据不足时仍可自行核实。',
    parameters: z.object({
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(30),
    }),
    categoryHint: 'read',
    executionSemantics: 'parallel',
    impl: async (input: any, call: any) => {
      const state = store.get();
      if (!state || ![state.discoverySession, state.judgementSession].includes(call.sessionId))
        throw Error('Not the exploration worker');
      return controller.asOwner(state, async () => {
        const snapshot: any = await ctx.sessionQuery.read(state.sessionId);
        const messages = (snapshot?.messages ?? []).filter((m: any) =>
          ['user', 'assistant'].includes(m.type),
        );
        const taskTool = ctx.tools
          .resolve(state.sessionId)
          .tools.find((tool: any) => tool.name === 'MatterTasks');
        const tasks = taskTool
          ? await taskTool.impl({}, { ...call, sessionId: state.sessionId })
          : null;
        return {
          messages: messages.slice(input.offset, input.offset + input.limit),
          nextOffset:
            input.offset + input.limit < messages.length ? input.offset + input.limit : null,
          tasks,
        };
      });
    },
  });
  const visible = (call: any) => {
    const s = store.get();
    if (s && s.sessionId !== call.sessionId) throw Error('Initiative is outside this conversation');
    return s;
  };
  const register = (name: string, description: string, parameters: any, impl: any) =>
    ctx.tools.register({
      name,
      description,
      parameters,
      categoryHint: name === 'InitiativeStatus' ? 'read' : 'file_write',
      executionSemantics: name === 'InitiativeStatus' ? 'parallel' : 'exclusive_step',
      impl: async (input: any, call: any) =>
        JSON.parse(JSON.stringify(await impl(parameters.parse(input), call))),
    });
  const scheduleReceipt = async (action: string, call: any, apply: () => Promise<any>) => {
    const before = visible(call);
    const state = await apply();
    return {
      ...state,
      effect: {
        target: 'assistant_proactive_discovery',
        action,
        before: before
          ? { enabled: before.enabled, intervalMs: before.intervalMs, nextAt: before.nextAt }
          : null,
        after: { enabled: state.enabled, intervalMs: state.intervalMs, nextAt: state.nextAt },
        taskCreated: false,
      },
    };
  };
  register(
    'InitiativeEnable',
    'Enable general proactive discovery for this assistant when the user requests it. Preserves the existing interval (30 minutes on first setup) and an already enabled schedule. Findings go to the Bot. This creates no specific follow-up task or completion condition; a request to monitor one issue is not authorization to change global discovery. Use InitiativeConfigure to explicitly change its interval.',
    z.object({}).strict(),
    (_: any, call: any) => scheduleReceipt('enable', call, () => controller.enable({}, call)),
  );
  register(
    'InitiativeConfigure',
    'Change the general proactive-discovery interval for this assistant only when the user requests that configuration change. Preserves enabled/paused state; use InitiativeEnable to enable it. Does not schedule investigation of a particular issue or change index maintenance. Returns the previous and resulting configuration, not task progress.',
    z
      .object({
        intervalMinutes: z
          .number()
          .int()
          .min(1)
          .max(10080)
          .describe('Requested global discovery interval in minutes.'),
      })
      .strict(),
    (input: any, call: any) =>
      scheduleReceipt('configure', call, () => controller.configure(input, call)),
  );
  register(
    'InitiativeStatus',
    'Read this assistant’s general discovery schedule, current run and last error. Does not start exploration or report progress on a specific task.',
    z.object({}),
    (_: any, call: any) => visible(call) ?? { configured: false },
  );
  register(
    'InitiativeControl',
    'Pause/resume general proactive discovery, or request one immediate general exploration, on user request. Preserves its interval. Pause stops future heartbeats, not the chat or delegated tasks. check requests exploration; it does not return findings or track a specific issue. Results are reported separately to the Bot.',
    z.object({ action: z.enum(['pause', 'resume', 'check']) }),
    (input: any, call: any) =>
      scheduleReceipt(input.action, call, () => controller.control(input.action, call)),
  );
  ctx.systemPrompt.section({
    name: 'index-initiative.discovery',
    order: 810,
    text: ({ sessionId }) =>
      [store.get()?.discoverySession, store.get()?.judgementSession].includes(sessionId)
        ? '你在主动助手的后台会话中运行。通过普通文件工具读取共享记事本、写本轮增量；用户交流由 Bot 负责。只读调查，不委派执行任务，不自行安排心跳。'
        : undefined,
  });
}
