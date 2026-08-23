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

import type { SlashCommandIdForSurface } from '@maka/core/slash-command-catalog';
import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

type TuiCommandId = SlashCommandIdForSurface<'tui'>;

export interface TuiPrimaryGuidanceCopy {
  readonly welcome: {
    readonly tagline: string;
    readonly start: string;
    readonly session: string;
    readonly model: string;
    readonly setup: string;
  };
  readonly commands: Readonly<Record<TuiCommandId, string>>;
  readonly help: {
    readonly commandsHeading: string;
    readonly keybindingsHeading: string;
    readonly keybindings: readonly string[];
  };
}

const TUI_PRIMARY_GUIDANCE = {
  zh: {
    welcome: {
      tagline: '陪你把事做完',
      start: '输入消息开始对话',
      session: '切换或恢复会话',
      model: '切换模型',
      setup: '配置模型提供商',
    },
    commands: {
      compact: '压缩会话上下文',
      context: '查看最近一次请求的上下文用量',
      exit: '退出 Maka',
      goal: '查看自主目标状态',
      graph: '查看、启用、停用 Graph 模式，或执行一次 Graph 任务',
      help: '查看命令和快捷键',
      model: '选择模型',
      move: '将当前会话移到其他目录',
      new: '新建会话',
      permissions: '设置会话权限',
      recap: '用一句话总结当前会话',
      rename: '重命名当前会话',
      resume: '从安全边界恢复最近一次中断的执行',
      rewind: '回退到较早的对话轮次',
      session: '切换或恢复会话',
      setup: '配置模型提供商（API Key）',
      skill: '调用 Skill（也可直接输入 /skill:<name>）',
      swarm: '查看、启用、停用 Swarm 模式，或执行一次 Swarm 任务',
      thinking: '设置思考级别',
      transcript: '在 Maka 内浏览完整对话记录',
    },
    help: {
      commandsHeading: '命令',
      keybindingsHeading: '快捷键',
      keybindings: [
        '  Ctrl+O — 展开或折叠所有工具输出',
        '  Ctrl+T — 展开或折叠最近的思考块',
        '  使用终端或触控板滚动对话记录',
        '  Enter（任务运行中）— 将消息注入当前任务',
        '  Alt+Enter（任务运行中）— 将消息排入下一轮',
        '  Alt+↑ — 将已排队消息取回编辑器重新编辑',
        '  Esc Esc（任务运行中）— 中断当前任务',
        '  Esc Esc（空闲时）— 回退到较早的轮次',
        '  Ctrl+C — 停止任务、清空输入，或连续按两次退出',
        '  Ctrl+D — 输入为空时退出',
      ],
    },
  },
  en: {
    welcome: {
      tagline: 'Get things done together',
      start: 'Type a message to start',
      session: 'Switch or resume a session',
      model: 'Switch models',
      setup: 'Set up a model provider',
    },
    commands: {
      compact: 'Compact session context',
      context: 'Show latest request context usage',
      exit: 'Exit Maka',
      goal: 'Show autonomous goal status',
      graph: 'Show, enable, disable, or run one Graph turn',
      help: 'Show commands and keybindings',
      model: 'Select model',
      move: 'Move current session to another directory',
      new: 'Start a new session',
      permissions: 'Set session permissions',
      recap: 'One-sentence recap of the session so far',
      rename: 'Rename current session',
      resume: 'Resume latest interrupted run at a safe boundary',
      rewind: 'Rewind to an earlier turn',
      session: 'Resume session',
      setup: 'Set up a model provider (API key)',
      skill: 'Invoke a skill (or type /skill:<name> inline)',
      swarm: 'Show, enable, disable, or run one Swarm turn',
      thinking: 'Set thinking level',
      transcript: 'Browse the full transcript inside Maka',
    },
    help: {
      commandsHeading: 'Commands',
      keybindingsHeading: 'Keybindings',
      keybindings: [
        '  Ctrl+O — expand or collapse all tool output',
        '  Ctrl+T — expand or collapse the latest thinking block',
        '  Scroll the transcript with your terminal or trackpad',
        '  Enter (during a turn) — steer: inject a message into the running turn',
        '  Alt+Enter (during a turn) — queue a message for the next turn',
        '  Alt+↑ — take queued messages back into the editor to re-edit',
        '  Esc Esc (during a turn) — interrupt the turn',
        '  Esc Esc (when idle) — rewind to an earlier turn',
        '  Ctrl+C — stop the turn, clear input, or press twice to exit',
        '  Ctrl+D — exit when input is empty',
      ],
    },
  },
} satisfies UiCatalog<TuiPrimaryGuidanceCopy>;

export function getTuiPrimaryGuidance(locale: UiLocale): TuiPrimaryGuidanceCopy {
  return TUI_PRIMARY_GUIDANCE[locale];
}
