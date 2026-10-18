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

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validateImageBytes } from '@maka/runtime/image-file';
import {
  assistantAvatarSchema,
  assistantEmojiSchema,
  DEFAULT_ASSISTANT_AVATAR,
} from '../../protocol/personal-assistant.js';
import type { AssistantModuleServices } from '../service.js';
import type { BotStore } from './store.js';
import type { BotController } from './controller.js';

export function initializeAvatar(
  ctx: AssistantModuleServices,
  store: BotStore,
  bot: BotController,
  register: (name: string, description: string, parameters: any, impl: any) => void,
) {
  const current = () =>
    store.get('avatar') as ({ imageData?: string } & Record<string, unknown>) | undefined;
  const avatar = () => {
    const { imageData: _, ...metadata } = current() ?? {};
    return assistantAvatarSchema.safeParse(metadata).data ?? DEFAULT_ASSISTANT_AVATAR;
  };
  ctx.api.register('assistant.avatar', () => ({ avatar: avatar() }));
  // Bounded transfers keep large images out of the normal status polling and model transcript.
  ctx.api.register('assistant.avatar-image', (raw) => {
    const { id, offset } = z
      .object({ id: z.string(), offset: z.number().int().nonnegative().default(0) })
      .parse(raw);
    const saved = current();
    if (avatar().image?.id !== id || !saved?.imageData)
      throw Error('Avatar changed; refresh its metadata');
    if (offset >= saved.imageData.length) throw Error('Invalid avatar offset');
    const data = saved.imageData.slice(offset, offset + 192 * 1024);
    return {
      id,
      offset,
      data,
      nextOffset: offset + data.length < saved.imageData.length ? offset + data.length : null,
    };
  });
  register(
    'AssistantSetAvatar',
    '更换你自己的头像，入口和聊天消息同步显示，重启后保留。image 填生成或找到的图片的当前工具会话工作目录内的本地路径或公网 HTTP(S) 图片网址（PNG/JPEG/WebP/GIF，最多 2 MiB），不要传 base64。也可用 emoji 填一个 emoji；两者选一。background 可填 #RRGGBB。图片会保存副本；此工具只设置头像，生成或找图使用已有工具，必要时委派任务。不会发送消息。',
    z
      .object({
        emoji: assistantEmojiSchema.optional(),
        image: z.string().trim().min(1).max(8192).optional(),
        background: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .default('#E5EDFF'),
      })
      .strict()
      .refine(
        (value) => Boolean(value.emoji) !== Boolean(value.image),
        'Provide exactly one of emoji or image',
      ),
    async (
      input: { emoji?: string; image?: string; background: string },
      call: { sessionId: string; abortSignal: AbortSignal },
    ) => {
      let saved;
      if (input.image) {
        if (!ctx.readAvatarImage) throw Error('Image loading is unavailable on this Host');
        const worker = bot.worker();
        const owner = bot.owner();
        const result = await ctx.readAvatarImage(call.sessionId, input.image, call.abortSignal);
        call.abortSignal.throwIfAborted();
        bot.ready();
        if (bot.worker() !== worker || bot.owner() !== owner)
          throw Error('Assistant binding changed');
        const image = validateImageBytes(result.bytes, 'chat');
        const bytes = Buffer.from(image.bytes);
        const imageData = bytes.toString('base64');
        saved = {
          background: input.background,
          image: {
            id: createHash('sha256').update(bytes).digest('hex'),
            mimeType: image.mimeType,
            length: imageData.length,
          },
          imageData,
        };
      } else saved = { emoji: input.emoji, background: input.background };
      // One SQLite value makes image content and metadata an atomic replacement.
      store.set('avatar', saved);
      return { updated: true, avatar: avatar() };
    },
  );
}
