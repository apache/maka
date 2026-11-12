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

import type { SessionHeader, StoredMessage, TurnStateMessage } from '@maka/core/session';
import type { SessionTodoItem } from '@maka/core/session-todo';
import { header } from './seed-helpers.js';

/**
 * The check-in corpus: one Session per case the design names, dated against
 * the real clock so they fall inside the look-back window. Each `expect` says
 * what a correct check-in does with it; the cases without a card are the ones
 * that measure false positives.
 */
export const CHECKIN_FIXTURE_CONNECTION = 'checkin-model';
export const CHECKIN_FIXTURE_MODEL = 'deepseek-flash';

const HOUR = 60 * 60 * 1000;

export interface CheckinFixtureSession {
  readonly header: SessionHeader;
  readonly messages: StoredMessage[];
  readonly todos?: SessionTodoItem[];
  readonly expect: 'resume' | 'continue' | 'answer' | 'no card';
}

export function checkinSessions(now: number): CheckinFixtureSession[] {
  return [
    seed(now, {
      id: 'checkin-failed-run',
      name: '给上传客户端加重试',
      hoursAgo: 2,
      expect: 'resume',
      user: '给上传客户端加上指数退避重试，最多 3 次，再补上对应的单元测试。',
      assistant: '已经在 src/upload/client.ts 里加上了指数退避重试，接下来补单元测试。',
      end: {
        status: 'failed',
        errorClass: 'tool_step_cap_reached',
        failureMessage: 'Reached the tool step limit for this turn.',
      },
    }),
    seed(now, {
      id: 'checkin-open-todo',
      name: '整理 0.3.0 发布清单',
      hoursAgo: 5,
      expect: 'continue',
      user: '帮我整理 0.3.0 的发布清单，然后按清单一项项完成。',
      assistant: '清单已经建好。我先完成了前两项：更新 CHANGELOG、提升版本号。',
      end: { status: 'completed' },
      todos: [
        { content: '更新 CHANGELOG', status: 'completed' },
        { content: '提升版本号到 0.3.0', status: 'completed' },
        { content: '构建并签名 macOS 安装包', status: 'pending' },
        { content: '在 Windows 上做一次冒烟测试', status: 'pending' },
      ],
    }),
    seed(now, {
      id: 'checkin-stated-remaining',
      name: '修复登录页布局',
      hoursAgo: 9,
      expect: 'continue',
      user: '修复登录页在 Chrome、Firefox 和 Safari 上的布局问题。',
      assistant:
        'Chrome 和 Firefox 的布局已经修好了。Safari 上表单滚动后输入框错位的问题还没处理，需要再看一下 iOS Safari 的视口单位。',
      end: { status: 'completed' },
    }),
    seed(now, {
      id: 'checkin-waiting-approval',
      name: '清理旧日志',
      hoursAgo: 20,
      expect: 'answer',
      user: '清理 logs 目录里 30 天以前的日志。',
      assistant: '找到 1,284 个超过 30 天的日志文件，共 2.3 GB。删除之前需要你确认。',
      waiting: true,
    }),
    seed(now, {
      id: 'checkin-untested-change',
      name: '抽出日期格式化函数',
      hoursAgo: 26,
      // Delivered work with a weakness is not unfinished: no card.
      expect: 'no card',
      user: '把各个页面里重复的日期格式化逻辑抽成一个工具函数。',
      assistant: '已经抽到 src/utils/date.ts，替换了 4 个文件里的重复实现。我还没有运行测试。',
      end: { status: 'completed' },
    }),
    seed(now, {
      id: 'checkin-finished',
      name: '写 README 安装章节',
      hoursAgo: 30,
      expect: 'no card',
      user: '给 README 写一个安装章节。',
      assistant:
        '安装章节已经写好。macOS 和 Windows 的步骤我都照着文档走了一遍，命令都能直接运行。',
      end: { status: 'completed' },
    }),
    seed(now, {
      id: 'checkin-user-stopped',
      name: '批量重命名图片',
      hoursAgo: 40,
      expect: 'no card',
      user: '把 assets/photos 下的图片按拍摄日期批量重命名。',
      assistant: '开始处理 assets/photos，共 312 张图片……',
      end: { status: 'aborted', abortSource: 'renderer.stop_button' },
    }),
    seed(now, {
      id: 'checkin-question-only',
      name: 'useEffect 依赖数组',
      hoursAgo: 50,
      expect: 'no card',
      user: 'React 的 useEffect 依赖数组为什么不能漏写？',
      assistant:
        '漏写依赖时，effect 读到的是旧闭包里的值：状态更新了，effect 却不会重新执行，结果不同步。ESLint 的 exhaustive-deps 规则就是为了提醒这一点。',
      end: { status: 'completed' },
    }),
  ];
}

function seed(
  now: number,
  input: {
    id: string;
    name: string;
    hoursAgo: number;
    expect: CheckinFixtureSession['expect'];
    user: string;
    assistant: string;
    end?: Pick<TurnStateMessage, 'status' | 'errorClass' | 'failureMessage' | 'abortSource'>;
    waiting?: boolean;
    todos?: SessionTodoItem[];
  },
): CheckinFixtureSession {
  const at = now - input.hoursAgo * HOUR;
  const turnId = `${input.id}-turn-1`;
  const session = header({
    id: input.id,
    name: input.name,
    connection: CHECKIN_FIXTURE_CONNECTION,
    model: CHECKIN_FIXTURE_MODEL,
    now: at,
    lastMessageAt: at,
  });
  const messages: StoredMessage[] = [
    { type: 'user', id: `${input.id}-user-1`, turnId, ts: at - 60_000, text: input.user },
    {
      type: 'assistant',
      id: `${input.id}-assistant-1`,
      turnId,
      ts: at - 1_000,
      text: input.assistant,
      modelId: CHECKIN_FIXTURE_MODEL,
    },
  ];
  if (input.end) {
    messages.push({
      type: 'turn_state',
      id: `${input.id}-turn-state-1`,
      turnId,
      ts: at,
      ...input.end,
      ...(input.end.status === 'aborted' ? { abortedAt: at } : {}),
    });
  }
  return {
    header: input.waiting ? { ...session, status: 'waiting_for_user' } : session,
    messages,
    ...(input.todos ? { todos: input.todos } : {}),
    expect: input.expect,
  };
}
