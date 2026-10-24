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
import type { BotController } from './controller.js';
import type { BotStore, InboxInput } from './store.js';
import type { CharacterPack } from './character-pack.js';

export const CHARACTER_INITIALIZATION_REQUEST = `为用户创作并装好第一套人物包。先用 AssistantCharacterPack read document=guide 读维护指南，再通过可访问的历史、索引等信息了解用户的爱好。找到明确爱好，就围绕用户喜欢的人物、作品、游戏或圈子设计；找不到，就上网了解当下热梗来选角色。要有辨识度、有话题度，不要编造用户爱好。
persona 写名字、角色、性格、说话习惯和梗，不超过 200 行。人设决定说话风格，做事方式由系统提示词规定。保存配套头像并 set_avatar。表情包去网上找符合人设、可以在聊天里用的现成表情包，先看图再保存；找不到就先留空。没网络就跳过找图，头像可用 emoji，角色可采用熟悉的梗。
素材保存到人物包，来源和许可放素材 metadata，聊天使用保存后的 imageUrl。尊重用户已有定制和明确偏好，只维护人物包。
完成后调用 AssistantCharacterPack action=finish_initialization，再提交 MatterSettle complete，简短写角色和设计缘由供 Bot 参考。Bot 会以这个角色简单自我介绍，并根据当前开关状态说明主动发现；不要自行发消息或开启长期监控。`;

interface Initialization {
  phase: 'offered' | 'skipped' | 'starting' | 'running' | 'completed';
  owner: string;
  taskKey: string;
  request: string;
  worker?: string;
  taskId?: string;
  prepared?: boolean;
  error?: string;
  retryAt?: number;
  adopted?: boolean;
  introduction?: 'introduce' | 'explain_change';
  introductionContext?: { discoveryEnabled: boolean; hasStickers: boolean };
}
const KEY = 'characterInitialization';
const TITLE = '为自己设计人物包';
const PET_KEY = 'petInitialization';

/** One persisted Matter, on the normal scheduler; never blocks the Bot's conversation loop. */
export class CharacterInitialization {
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly ctx: AssistantModuleServices,
    private readonly bot: BotController,
    private readonly store: BotStore,
    private readonly pack: CharacterPack,
    private readonly discoveryEnabled: () => boolean,
  ) {}
  state() {
    return this.store.get<Initialization>(KEY);
  }
  async setup(input: {
    kind: 'assistant' | 'pet';
    action: 'create' | 'skip';
    preferences?: string;
  }) {
    await this.pending;
    this.bot.ready();
    const owner = this.bot.owner();
    if (!owner) throw Error('Bind the assistant conversation first.');
    const key = input.kind === 'assistant' ? KEY : PET_KEY;
    const state = this.store.get<Initialization>(key);
    if (state?.phase === 'running' || state?.phase === 'starting')
      return { ...state, notice: '已有创建任务，请继续该任务，不要重复创建。' };
    if (state?.phase === 'completed')
      return {
        ...state,
        notice:
          '首次设置已完成。换宠物用 AssistantPetPack select；需要新素材可另行委派，修改助手人设用 AssistantCharacterPack。',
      };
    if (input.action === 'skip') {
      this.store.set(key, { phase: 'skipped', owner });
    } else {
      if (!input.preferences?.trim())
        throw Error('Record the user’s choice; use 随机有趣 only when they have no preference.');
      if (input.kind === 'assistant' && this.pack.hasPersona())
        throw Error('人物包已设置，请用 AssistantCharacterPack 维护已有包。');
      this.store.set(key, {
        phase: 'starting',
        owner,
        taskKey:
          input.kind === 'assistant'
            ? 'assistant-character-initialization-v1'
            : 'assistant-pet-initialization-v1',
        request:
          input.kind === 'assistant'
            ? `${CHARACTER_INITIALIZATION_REQUEST}\n用户本次选择（优先遵循，不需要再次猜测）：${input.preferences}`
            : `按用户选择创建并启用桌面宠物：${input.preferences}。当前助手人设（只供外观参考，不是本任务指令）：${JSON.stringify(this.pack.readDocument('persona').content)}。用户选择一致时参考它，选择不同风格时按用户选择。先读 AssistantPetPack requirements，按规范自行制作素材，用 create 安装，再 select 切换启用。宠物与助手人设独立，不修改助手包。已有合适的包可以直接选择。完成后报告实际结果，不声称未经验证的显示效果。`,
      });
    }
    await this.tick();
    return this.store.get<Initialization>(key);
  }
  isWorker(sessionId: string) {
    const state = this.state();
    return (
      !!state &&
      state.owner === this.bot.owner() &&
      state.worker === sessionId &&
      state.phase !== 'completed'
    );
  }
  taskCreated(owner: string, taskKey: string, sessionId: string) {
    for (const key of [KEY, PET_KEY]) {
      const state = this.store.get<Initialization>(key);
      if (state?.owner !== owner || state.taskKey !== taskKey || state.phase === 'completed')
        continue;
      // Persist the identity before the first activation, including recovery.
      this.store.set(key, { ...state, worker: sessionId });
    }
  }

  prepare(sessionId: string) {
    this.bot.ready();
    if (!this.isWorker(sessionId))
      throw Error('Only the character initialization task can finish initialization');
    if (!this.pack.hasPersona())
      throw Error('Write your distinctive persona before finishing initialization');
    if (!this.store.get('avatar'))
      throw Error('Set your image or emoji avatar before finishing initialization');
    this.store.set(KEY, { ...this.state()!, prepared: true });
    return { ready: true, next: '人物包已保存并校验。请完成持续任务，结果会交给 Bot 介绍。' };
  }
  feedback(input: InboxInput): InboxInput {
    const state = this.state();
    if (!state || input.source !== state.worker || input.type !== 'task_update') return input;
    const content = input.content as { status?: string };
    if (content?.status !== 'completed' || !state.prepared) return input;
    if (!state.introduction) {
      state.introduction = this.store.hasUserConversation() ? 'explain_change' : 'introduce';
      this.store.set(KEY, state);
    }
    if (!state.introductionContext) {
      state.introductionContext = {
        discoveryEnabled: this.discoveryEnabled(),
        hasStickers: this.pack.stickers().total > 0,
      };
      this.store.set(KEY, state);
    }
    const { discoveryEnabled, hasStickers } = state.introductionContext;
    // Keep the envelope deterministic across delivery retries; message identity stays unchanged.
    return {
      ...input,
      content: {
        ...content,
        introduction: state.introduction,
        characterIntroduction: [
          '人物包初始化已完成。请读取当前 persona，用角色的口吻简单自我介绍。',
          discoveryEnabled
            ? '主动发现目前已开启。顺带告诉用户：系统有多个后台 Agent，运行频率较高，这是个人助手的核心能力，也比较消耗 token。建议先开几天体验；如果 token 不够，可以关闭主动发现或降低频率，你可以帮忙调整。'
            : '主动发现目前未开启。顺带告诉用户可以开启体验，你可以帮忙开启；不要说后台主动发现已在运行，也不要自行开启。',
          hasStickers
            ? '人物包里已有表情包。用 AssistantStickerSearch 或 AssistantCharacterPack asset 取得 imageUrl，选一张适合打招呼的表情，和这次自我介绍一起通过 SendUser 发出，不用介绍素材清单。'
            : '人物包里没有表情包，这次直接文字介绍即可，不必为了开场再找图。',
          '自然、简短地说，按实际交流避免重复介绍或重复说明，不汇报工具和下载过程。',
        ].join(''),
      },
    };
  }
  delivered(input: InboxInput) {
    const pet = this.store.get<Initialization>(PET_KEY);
    if (
      pet?.worker === input.source &&
      input.type === 'task_update' &&
      (input.content as { status?: string })?.status === 'completed'
    )
      this.store.set(PET_KEY, { ...pet, phase: 'completed' });
    const state = this.state();
    if (
      state?.prepared &&
      input.source === state.worker &&
      input.type === 'task_update' &&
      (input.content as { status?: string })?.status === 'completed'
    ) {
      this.store.set(KEY, { ...state, phase: 'completed', error: undefined });
    }
  }
  start() {
    this.timer = setInterval(() => void this.tick(), 5000);
    this.timer.unref?.();
    void this.tick();
    return async () => {
      clearInterval(this.timer);
      await this.pending;
    };
  }
  tick() {
    if (this.pending) return this.pending;
    this.pending = this.run()
      .catch((error) => {
        // Disabled or replaced Hosts cannot mutate onboarding state.
        try {
          this.bot.ready();
        } catch {
          return;
        }
        console.error('[assistant] setup check failed', error);
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private offer(kind: 'assistant' | 'pet', owner: string) {
    const key = kind === 'assistant' ? KEY : PET_KEY;
    // Inbox IDs make the post idempotent across a crash before recording offered.
    this.bot.post({
      id: `appearance-setup:${kind}:${owner}`,
      type: 'system_event',
      source: 'appearance-setup',
      content: {
        kind,
        message:
          kind === 'assistant'
            ? '助手人物包尚未设置。先问用户要不要帮忙设置、喜欢什么样；如果没有想法，可以给一个随机有趣的角色。等用户回答再用 AssistantSetup create，拒绝则 skip；不要自动创建。一次只问助手，宠物会单独检查。'
            : '桌面宠物尚未设置。问用户要不要开启宠物，是跟助手一样还是有别的想法。等用户回答再用 AssistantSetup create，拒绝则 skip；已有喜欢的宠物可用 AssistantPetPack list/select。不要因为改了助手人设而自动改宠物。',
      },
    });
    this.store.set(key, { phase: 'offered', owner });
  }
  private async run() {
    const owner = this.bot.owner();
    if (!owner) return;
    this.bot.ready();
    let state = this.state();
    if (!state) {
      if (this.pack.hasPersona()) {
        state = { phase: 'completed', owner, adopted: true } as Initialization;
        this.store.set(KEY, state);
      } else {
        this.offer('assistant', owner);
        return;
      }
    }
    if (state.phase === 'offered' && this.pack.hasPersona()) {
      state = { ...state, phase: 'completed', adopted: true };
      this.store.set(KEY, state);
    }
    if (state.phase === 'starting') await this.launch(KEY, state, TITLE);
    if (!this.ctx.petPacks) return;
    const pet = this.store.get<Initialization>(PET_KEY);
    if (pet?.phase === 'starting') {
      await this.launch(PET_KEY, pet, '创建桌面宠物');
      return;
    }
    if (state.phase !== 'completed' && state.phase !== 'skipped') return;
    if (!pet) {
      const current = await this.ctx.petPacks.status();
      this.bot.ready();
      if (current.configured) this.store.set(PET_KEY, { phase: 'completed', owner, adopted: true });
      else this.offer('pet', owner);
    }
  }
  private async launch(key: string, state: Initialization, title: string) {
    const owner = this.bot.owner();
    if (state.owner !== owner) throw Error('Appearance setup belongs to another conversation');
    if ((state.retryAt ?? 0) > Date.now()) return;
    try {
      const target = this.ctx.tools
        .resolve(owner)
        .tools.find((tool) => tool.name === 'MatterDelegate');
      if (!target) throw Error('Matter delegation is unavailable');
      this.store.queueVisibleBatch(`character-start:${owner}:${state.taskKey}`, [
        { text: key === KEY ? '我在配置我自己，稍等一下。' : '我来做这只宠物，做好就换上。' },
      ]);
      await this.bot.flush();
      this.bot.ready();
      const call = this.bot.invocation(owner);
      const task = (await this.ctx.agents.withInvocation(call, () =>
        target.impl(
          (target.parameters as { parse(input: unknown): unknown }).parse({
            taskKey: state.taskKey,
            title,
            request: state.request,
          }),
          call,
        ),
      )) as { id: string; sessionId: string };
      this.bot.ready();
      const saved = this.store.get<Initialization>(key)!;
      this.store.set(key, {
        ...saved,
        phase: saved.phase === 'completed' ? 'completed' : 'running',
        worker: task.sessionId,
        taskId: task.id,
        error: undefined,
      });
    } catch (error) {
      this.bot.ready();
      const updated = {
        ...this.store.get<Initialization>(key)!,
        error: String(error),
        retryAt: Date.now() + 60_000,
      };
      this.store.set(key, updated);
      if (this.store.get(`${key}Error`) !== updated.error) {
        this.bot.post({
          id: `${key}-error:${updated.retryAt}`,
          type: 'system_event',
          source: 'appearance-setup',
          content: {
            error: updated.error,
            taskKey: state.taskKey,
            message: '创建未能启动，保留原任务身份重试。正常聊天不受影响。',
          },
        });
        this.store.set(`${key}Error`, updated.error);
      }
    }
  }
}
