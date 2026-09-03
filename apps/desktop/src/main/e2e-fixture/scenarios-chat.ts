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

import type { SessionHeader, StoredMessage } from '@maka/core/session';
import {
  header,
  AGENT_GRAPH_SESSION_ID,
  PARTIAL_HISTORY_SESSION_ID,
  PROMPT_RAIL_PROMPT_COUNT,
  PROMPT_RAIL_SESSION_ID,
  TURN_SESSION_ID,
} from './seed-helpers.js';

export function agentGraphSession(now: number): SessionHeader {
  return {
    ...turnSession(now),
    id: AGENT_GRAPH_SESSION_ID,
    name: 'Agent Graph 布局示例',
    orchestrationMode: 'graph',
  };
}

export function turnSession(now: number): SessionHeader {
  return header({
    id: TURN_SESSION_ID,
    name: '模型管理与工具调用示例',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 9 * 60_000,
  });
}

export function turnMessages(now: number): StoredMessage[] {
  const turnId = 'turn-fixture-1';
  return [
    {
      type: 'user',
      id: 'msg-user-1',
      turnId,
      ts: now - 10 * 60_000,
      text: '检查项目状态，列出需要我优先处理的风险。',
    },
    {
      type: 'tool_call',
      id: 'tool-status',
      turnId,
      ts: now - 9 * 60_000 - 50_000,
      toolName: 'Bash',
      displayName: '检查测试状态',
      intent: '运行测试摘要并读取失败输出',
      args: { cmd: 'npm test --workspaces --if-present', cwd: '/workspace/maka' },
    },
    {
      type: 'tool_result',
      id: 'tool-status-result',
      turnId,
      ts: now - 9 * 60_000 - 42_000,
      toolUseId: 'tool-status',
      isError: false,
      durationMs: 8_240,
      content: {
        kind: 'terminal',
        cwd: '/workspace/maka',
        cmd: 'npm test --workspaces --if-present',
        status: 'completed',
        exitCode: 0,
        output: {
          mode: 'pipes',
          stdout: 'core 41 passing\nstorage 17 passing\nruntime 70 passing\ndesktop 74 passing\n',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
      },
    },
    {
      type: 'assistant',
      id: 'msg-assistant-1',
      turnId,
      ts: now - 9 * 60_000,
      text: '当前需要重点观察截图基线是否稳定、启用模型名单是否清晰，以及完整目录是否只在搜索时出现。',
      thinking: {
        text: [
          '**Calculating CRT Solution**',
          '',
          'First combine \\( n \\equiv 3 \\pmod 7 \\) with \\( n \\equiv 5 \\pmod {11} \\).',
          'Then solve \\( 7a \\equiv 2 \\pmod {11} \\), giving \\( a \\equiv 5 \\pmod {11} \\).',
        ].join('\n'),
      },
      modelId: 'glm-5.1',
    },
    {
      type: 'token_usage',
      id: 'usage-1',
      turnId,
      ts: now - 9 * 60_000 + 100,
      input: 1250,
      output: 320,
      cacheRead: 180,
      costUsd: 0.0042,
    },
  ];
}

export function promptRailSession(now: number): SessionHeader {
  return header({
    id: PROMPT_RAIL_SESSION_ID,
    name: '长对话提示词导航示例',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 60_000,
  });
}

/**
 * A plain multi-prompt conversation: no tools, no thinking, no usage rows.
 * `prompt-rail.spec.ts` measures the rail against this, so every turn is just
 * a prompt and a reply long enough to push the transcript past the scrollport.
 */
export function promptRailMessages(now: number): StoredMessage[] {
  const messages: StoredMessage[] = [];
  for (let index = 1; index <= PROMPT_RAIL_PROMPT_COUNT; index += 1) {
    const turnId = `turn-prompt-rail-${index}`;
    const ts = now - (PROMPT_RAIL_PROMPT_COUNT - index + 1) * 60_000;
    messages.push({
      type: 'user',
      id: `msg-prompt-rail-user-${index}`,
      turnId,
      ts,
      text: `第 ${index} 个问题：这一段的调用链路是怎样的？`,
    });
    messages.push({
      type: 'assistant',
      id: `msg-prompt-rail-assistant-${index}`,
      turnId,
      ts: ts + 1_000,
      text: `第 ${index} 段回答。`.repeat(40),
      modelId: 'glm-5.1',
    });
  }
  return messages;
}

export function partialHistorySession(now: number): SessionHeader {
  return header({
    id: PARTIAL_HISTORY_SESSION_ID,
    name: '超长对话历史范围示例',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 60_000,
  });
}

/**
 * Eight turns whose durable transcript is well over the Desktop range budget.
 * The whitespace is stored but collapses when rendered, keeping this a useful
 * visual fixture while forcing the initial open to contain only the latest
 * contiguous range.
 */
export function partialHistoryMessages(now: number): StoredMessage[] {
  const messages: StoredMessage[] = [];
  const rangePadding = ' '.repeat(180 * 1024);
  for (let index = 1; index <= 8; index += 1) {
    const turnId = `turn-partial-history-${index}`;
    const ts = now - (9 - index) * 60_000;
    messages.push({
      type: 'user',
      id: `msg-partial-history-user-${index}`,
      turnId,
      ts,
      text: `第 ${index} 个问题：请概括这一阶段的实现进展。`,
    });
    messages.push({
      type: 'assistant',
      id: `msg-partial-history-assistant-${index}`,
      turnId,
      ts: ts + 1_000,
      text: `第 ${index} 阶段已经完成关键实现，并通过了对应验证。${rangePadding}`,
      modelId: 'glm-5.1',
    });
  }
  return messages;
}
