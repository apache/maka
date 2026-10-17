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
import { initializeAvatar } from './avatar.js';
import { BotStore } from './store.js';
import { BotController } from './controller.js';
import type { AssistantModuleServices } from '../service.js';
import type { InitiativeStore } from '../index-initiative/store.js';

export const BOT_ROLE = `以用户的个人助手的角度思考问题，要贴心。你可以直接使用已有的工具处理事情，搞不定的复杂或者耗时的问题通过 MatterDelegate 委派工作，尽量避免自己陷入长时间阻塞。

用户消息、主动发现、任务和索引的后台反馈通过 Inbox 送达。你需要将每一条消息都处理，按你的判断选择合适的方式处理，

你需要向用户传达重要发现和进展。后台的失败、阻塞和澄清请求也由你接住，处理或向用户寻求帮助。

你负责索引的创建、来源和维护配置，以及主动发现的启停和周期。委派的工作由执行者推进和等待，结果返回给你，由你与用户交流。

只有 SendUser 会向用户发消息，普通文本不会发送。加工信息，减少用户理解成本，像日常聊天一样自然、直接地说话，合理划分 message，不丢掉该让用户知道的信息。可以保持安静。

通过 InboxCheck 接收消息，没有需要继续处理的事情就调用 Sleep；新消息会再次唤醒你。发送和休眠彼此独立，普通文本不能结束循环。`;

export function initializeBot(
  ctx: AssistantModuleServices,
  directory: string,
  binding: InitiativeStore,
) {
  const store = new BotStore(directory);
  const bot = new BotController(ctx, binding, store);
  ctx.bot.register({
    owner: () => bot.owner(),
    worker: () => bot.worker(),
    hasUserMessage: (id) => store.hasUserMessage(id),
    status: () => ({
      sessionId: bot.worker() ?? null,
      error: store.get('error') ?? null,
      wakeError: store.get('wakeError') ?? null,
      sleeping: bot.isSleeping(),
      working: bot.isWorking(),
    }),
    receive: (id, content) => bot.receive(id, content),
    post: (input) => bot.post(input),
  });
  ctx.backgroundSessions.register(() => (bot.worker() ? [bot.worker()!] : []));
  ctx.onClose(() => store.close());
  ctx.onStart(() => {
    bot.start();
    return () => bot.close();
  });
  const register = (
    name: string,
    description: string,
    parameters: any,
    impl: any,
    read = false,
    finishTurnOnSuccess = false,
  ) =>
    ctx.tools.register({
      name,
      description,
      parameters,
      categoryHint: read ? 'read' : 'file_write',
      executionSemantics: read ? 'parallel' : 'exclusive_step',
      ...(finishTurnOnSuccess
        ? { finishTurnOnSuccess: true, nesting: 'direct_only' as const }
        : {}),
      impl: (raw: any, call: any) => {
        bot.ready();
        if (call.sessionId !== bot.worker()) throw Error('Tool belongs to the assistant Bot');
        return impl(parameters.parse(raw), call);
      },
    });
  initializeAvatar(ctx, store, bot, register);
  register(
    'InboxCheck',
    '接收一批尚未投递的 Inbox 消息，自动记录投递位置。hasMore=true 表示仍有未读批次，继续调用直到收完；正文的 nextOffset 表示需用 InboxRead 续读。读取不标记任务完成，也不要求回复。无需先调用 InboxList；无新消息时由 Sleep 等待唤醒。中断恢复可能重投同一消息。',
    z.object({ limit: z.number().int().min(1).max(100).default(50) }),
    (input: any, call: any) => bot.checkInbox(call.toolCallId, input.limit),
  );
  register(
    'InboxList',
    '按需浏览 Inbox 历史目录，可按类型筛选和分页。不改变新消息投递位置；接收新消息直接用 InboxCheck。',
    z.object({
      after: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(100).default(30),
      type: z.enum(['user_message', 'discovery', 'task_update', 'system_event']).optional(),
    }),
    (input: any) => store.list(input),
    true,
  );
  register(
    'InboxRead',
    '按 ID 回查 Inbox 消息正文或续读长消息；不改变新消息投递位置。',
    z.object({
      id: z.string(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(48000).default(24000),
    }),
    (input: any) => store.read(input.id, input.offset, input.limit),
    true,
  );
  register(
    'SendUser',
    '向用户发送一批聊天消息，messages 按顺序显示为独立气泡。每项填写 text（完整正文）；summary（简短摘要）可选。短消息直接发正文，不必写摘要。较长消息需要填写独立摘要，用户默认看到摘要，点击展开正文；摘要由你概括，不是截断正文。需要你从用户的观看体验来看需不需要摘要。messageId 标识这批发送，重试时复用。发送后循环继续。',
    z
      .object({
        messageId: z.string().min(1).max(200),
        messages: z
          .array(
            z
              .object({
                summary: z.string().trim().min(1).max(2000).optional(),
                text: z.string().trim().min(1).max(48000),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict()
      .refine(
        (value) =>
          value.messages.reduce(
            (sum, message) => sum + (message.summary?.length ?? 0) + message.text.length,
            0,
          ) <= 48000,
        'Messages must total at most 48000 characters',
      ),
    async (input: { messageId: string; messages: { summary?: string; text: string }[] }) => {
      const messageIds = store.queueVisibleBatch(input.messageId, input.messages);
      await bot.flush();
      return { sent: true, messageIds };
    },
  );
  register(
    'Sleep',
    '结束本轮并休眠，新 Inbox 消息自动唤醒，不支持设置唤醒时间。还有未投递消息时返回 sleeping=false 和原因，循环继续；成功休眠不要求先发送消息，也不代表后台任务已完成。',
    z.object({}),
    (_: any, call: any) => bot.sleep(call.turnId),
    false,
    true,
  );
  register(
    'AssistantConversation',
    '读取用户可见的助手交流历史，理解既有约定、避免重复。内部工具执行不等于用户已经收到消息。',
    z.object({
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(30),
    }),
    async (input: any) =>
      ctx.agents.withInvocation(bot.invocation(), async () => {
        const snapshot: any = await ctx.sessionQuery.read(bot.owner()!);
        const messages = (snapshot.messages ?? snapshot.history ?? []).filter(
          (m: any) => m.type === 'user' || m.type === 'assistant',
        );
        return {
          items: messages.slice(input.offset, input.offset + input.limit),
          nextOffset:
            input.offset + input.limit < messages.length ? input.offset + input.limit : null,
        };
      }),
    true,
  );
  ctx.systemPrompt.section({
    name: 'assistant.bot',
    order: 810,
    text: ({ sessionId }) => (bot.worker() === sessionId ? BOT_ROLE : undefined),
  });
  ctx.systemPrompt.context({
    name: 'assistant.bot-clock',
    order: 810,
    text: ({ sessionId }) =>
      bot.worker() === sessionId ? `UTC: ${new Date().toISOString()}` : undefined,
  });
  ctx.turns.beforeFinish({
    name: 'assistant.bot-sleep',
    check: ({ sessionId, turnId }) =>
      sessionId === bot.worker() ? bot.beforeFinish(turnId) : { allow: true },
  });
  return bot;
}
