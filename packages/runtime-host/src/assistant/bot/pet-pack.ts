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
import type { AssistantModuleServices } from '../service.js';
import { PET_PACK_REQUIREMENTS } from './pet-requirements.js';

const parameters = z
  .object({
    action: z.enum(['requirements', 'list', 'status', 'select', 'create', 'remove']),
    petId: z.string().trim().min(1).optional().describe('select/remove 时填写宠物 ID。'),
    manifest: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('完整的 maka.pet/v1 配置，格式可用 requirements 查看。'),
    spriteSheetPath: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('调用者工作区内已生成或下载的 PNG/WebP 图集路径；不是 URL 或 Base64。'),
  })
  .strict();

export function initializePetPack(ctx: AssistantModuleServices) {
  ctx.tools.register({
    name: 'AssistantPetPack',
    description:
      '创建并安装桌面宠物包。requirements 查看素材和动作格式，list 查看当前 Host 已安装的包，status 查看当前选择，select 用 petId 切换到已安装的宠物并启用助手模式。create 提交 manifest 与 spriteSheetPath，由代码读取本地图集并校验安装。remove 用 petId 删除此 Host 的已安装包；删除当前宠物会清除选择并收起宠物，不删除工作区原始素材。素材如何生成或下载由你决定。与聊天头像和表情包独立，不自动启用或切换宠物。同 ID 同内容重试可复用；不同内容请换新 ID。',
    parameters,
    discovery: 'direct',
    categoryHint: 'file_write',
    executionSemantics: 'exclusive_step',
    async impl(raw, call) {
      const input = parameters.parse(raw);
      call.abortSignal.throwIfAborted();
      if (input.action === 'requirements') return { requirements: PET_PACK_REQUIREMENTS };
      if (!ctx.petPacks) throw Error('This Host does not provide pet pack storage.');
      if (input.action === 'status') return ctx.petPacks.status();
      if (input.action === 'remove') {
        if (!input.petId) throw Error('remove requires petId.');
        return ctx.petPacks.remove(input.petId, call.abortSignal);
      }
      if (input.action === 'select') {
        if (!input.petId) throw Error('select requires petId.');
        return ctx.petPacks.select(input.petId, call.abortSignal);
      }
      if (input.action === 'list') return { packs: await ctx.petPacks.list() };
      if (!input.manifest || !input.spriteSheetPath)
        throw Error('create requires manifest and spriteSheetPath.');
      return ctx.petPacks.create(
        call.sessionId,
        { manifest: input.manifest, spriteSheetPath: input.spriteSheetPath },
        call.abortSignal,
      );
    },
  });
}
