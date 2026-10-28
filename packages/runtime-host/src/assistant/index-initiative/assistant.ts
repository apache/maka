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
import type { InitiativeStore } from './store.js';
import type { InitiativeController } from './controller.js';

/** Built-in product entry; opening it does not start a model. */
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
    if (!state || !target) throw Error('所需服务尚未就绪：' + name);
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
    let sourceState: any = { installed: !!tool('FeishuSyncStatus') };
    if (includeMemory && sourceState.installed && state) {
      try {
        sourceState = { ...sourceState, ...(await invoke('FeishuSyncStatus')) };
      } catch (error) {
        sourceState.error = String(error);
      }
    }
    let session: any, sessionError: string | undefined;
    if (state) {
      try {
        session = await controller.asOwner(state, () => ctx.sessionQuery.read(state.sessionId));
      } catch (error) {
        sessionError = String(error);
      }
    }
    return {
      state,
      bot: ctx.bot.status(),
      ...(includeMemory ? { sourceSync: sourceState } : {}),
      readiness: {
        conversation: state ? 'bound' : 'not_bound',
        memory: !!memory,
        tasks: !!tasks,
        model: session?.session?.model ?? null,
        connection: session?.session?.llmConnectionSlug ?? null,
        executor: session?.session?.executorId ?? null,
        sessionError: sessionError ?? null,
        sessionAvailable: !!session,
        notice:
          '模型沿用当前聊天配置；请在聊天模型选择器确认连接。来源注册不代表授权或同步成功，历史导入可选。',
      },
      ...(includeMemory ? { memory: memoryState } : {}),
      tasks: taskState,
      // What background discovery and Matter activations cost and whether they reported
      // (#6309). Observability only: nothing in the scheduler reads it.
      cost: ctx.runCost?.summary() ?? null,
      hostRequired: true,
    };
  };
  // Fixed tool allowlist. The client cannot invoke arbitrary tools or supply a Session identity.
  ctx.api.register('assistant.recover', (input: any) => {
    const args = z
      .discriminatedUnion('kind', [
        z.object({
          kind: z.literal('task'),
          id: z.string(),
          action: z.enum(['pause', 'resume', 'cancel', 'check']),
        }),
        z.object({ kind: z.literal('delegation'), taskKey: z.string() }),
        z.object({ kind: z.literal('feedback'), notificationId: z.string() }),
        z.object({
          kind: z.literal('source'),
          action: z.enum(['enable', 'pause', 'check']),
          intervalMinutes: z.number().int().min(5).max(1440).optional(),
        }),
        z.object({
          kind: z.literal('index'),
          indexId: z.string(),
          action: z.enum(['resume', 'pause', 'maintain']),
        }),
      ])
      .parse(input);
    controller.ready();
    if (args.kind === 'task')
      return invoke('MatterTaskControl', { id: args.id, action: args.action });
    if (args.kind === 'delegation')
      return invoke('MatterDelegationRecover', { taskKey: args.taskKey });
    if (args.kind === 'feedback')
      return invoke('MatterFeedbackRetry', { notificationId: args.notificationId });
    if (args.kind === 'source')
      return invoke('FeishuSyncControl', {
        action: args.action,
        ...(args.intervalMinutes ? { intervalMinutes: args.intervalMinutes } : {}),
      });
    if (args.action === 'maintain')
      return invoke('MemoryIndexMaintain', { indexId: args.indexId, background: true });
    return invoke('MemoryIndexControl', { indexId: args.indexId, action: args.action });
  });
  // A read-only reference is resolved with the selected chat's identity, never
  // the default Host's assistant binding. Ordinary chats can cite originals too.
  ctx.api.register('assistant.original', async (input: unknown) => {
    const args = z
      .object({
        sessionId: z.string().min(1).max(300),
        ref: z.string().min(1).max(1000),
        latest: z.boolean().default(false),
        offset: z.number().int().min(0).default(0),
      })
      .strict()
      .parse(input);
    const readCall = {
      sessionId: args.sessionId,
      cwd: process.cwd(),
      turnId: 'original-reader',
      toolCallId: randomUUID(),
      abortSignal: controller.abort.signal,
    };
    const snapshot = await ctx.agents.withInvocation(readCall, () =>
      ctx.sessionQuery.read(args.sessionId),
    );
    if (!snapshot?.session?.cwd)
      throw Error('无法读取引用所属会话，请确认 Host 在线且仍有访问权限。');
    const target = ctx.tools
      .resolve(args.sessionId, [])
      .tools.find((t: any) => t.name === 'MemoryOriginal');
    if (!target) throw Error('记忆服务尚未就绪。');
    const call = { ...readCall, cwd: snapshot.session.cwd };
    const original = await ctx.agents.withInvocation(call, () =>
      target.impl(target.parameters.parse({ ref: args.ref, latest: args.latest }), call),
    );
    const message = original.message;
    const body = message?.displayText ?? message?.text ?? message ?? original.content ?? '';
    const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    const end = Math.min(text.length, args.offset + 24000);
    return {
      ref: original.ref ?? args.ref,
      source: original.source,
      status: original.status ?? 'ok',
      title: original.object?.title ?? original.source,
      revision: original.object?.revision ?? null,
      createdAt: original.object?.createdAt ?? original.message?.ts ?? null,
      observedAt: original.observedAt ?? null,
      isLatestRevision: original.isLatestRevision ?? null,
      latestRef: original.latestRef ?? original.latestRevisionRefs?.[0] ?? null,
      notice: original.notice ?? '历史原文仅供核对，引用版本不会被新内容替换。',
      text: text.slice(args.offset, end),
      offset: args.offset,
      nextOffset: end < text.length ? end : null,
      totalCharacters: text.length,
    };
  });
  ctx.api.register('assistant.allocate-workspace', async (input: unknown) => {
    z.object({}).strict().parse(input);
    controller.ready();
    if (!ctx.allocateWorkspace) throw Error('Assistant workspace allocation is unavailable');
    return ctx.allocateWorkspace();
  });
  ctx.api.register('assistant.binding', () => ({ state: store.get(), bot: ctx.bot.status() }));
  ctx.api.register('assistant.status', summary);
  ctx.api.register('assistant.bind', async (input: any) => {
    await controller.bindingReady;
    const { sessionId } = z.object({ sessionId: z.string().min(1).max(300) }).parse(input);
    controller.ready();
    if (store.get()) return store.get();
    // Bootstrap only a read invocation for the explicitly selected native Session.
    // Persist its Host cwd; process.cwd() is never used to run assistant work.
    const snapshot = await ctx.agents.withInvocation(
      {
        sessionId,
        cwd: process.cwd(),
        turnId: 'assistant-bind',
        toolCallId: randomUUID(),
        abortSignal: controller.abort.signal,
      },
      () => ctx.sessionQuery.read(sessionId),
    );
    if (!snapshot?.session?.cwd) throw Error('无法读取助手会话，请确认对应 Host 在线后重试。');
    return store.bind({ sessionId, cwd: snapshot.session.cwd });
  });
  ctx.api.register('assistant.control', async (input: any) => {
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
          intervalMinutes: args.intervalMinutes ?? state.intervalMs / 60000,
        },
        state,
      );
      // Explicit UI enable gives first-use feedback now, rather than after an invisible delay.
      return controller.control('check', state);
    }
    return controller.control(args.action, state);
  });
  ctx.api.register('assistant.adopt-task', (input: any) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(input);
    controller.ready();
    const state = store.get();
    if (!state) throw Error('请先打开个人助手。');
    const tasks = tool('MatterOverview');
    if (!tasks) throw Error('持续跟进服务尚未就绪。');
    return invoke('MatterAdopt', { id });
  });
}
