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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ToolActivityItem, TurnTimelineItem } from '../materialize.js';
import {
  isProcessingRunning,
  processingHasError,
  summarizeProcessing,
} from '../processing-summary.js';
import type { FoldedTimelineChild } from '../timeline-fold.js';

function thinking(live = false): FoldedTimelineChild {
  return { kind: 'thinking', text: 'reasoning', messageId: 'thinking-1', live };
}

function tools(...items: ToolActivityItem[]): FoldedTimelineChild {
  return { kind: 'tools', items };
}

function tool(
  toolUseId: string,
  toolName: string,
  status: ToolActivityItem['status'],
  activityKind?: ToolActivityItem['activityKind'],
  intent?: string,
): ToolActivityItem {
  return {
    toolUseId,
    toolName,
    status,
    args: {},
    ...(activityKind ? { activityKind } : {}),
    ...(intent ? { intent } : {}),
  };
}

describe('processing summary', () => {
  test('summarizes settled activity without counting folded reasoning', () => {
    const entries = [
      thinking(),
      tools(
        tool('read-1', 'Read', 'completed', 'read'),
        tool('bash-1', 'Bash', 'errored', 'command'),
      ),
    ];

    assert.equal(summarizeProcessing(entries, 'zh'), '读取 1 个文件，运行 1 条命令，1 个失败');
    assert.equal(processingHasError(entries), true);
  });

  test('uses the latest running activity rather than replaying the raw tool log', () => {
    const entries = [
      tools(
        tool('read-1', 'Read', 'completed', 'read'),
        tool('bash-1', 'Bash', 'running', 'command', '运行类型检查'),
      ),
    ];

    assert.equal(summarizeProcessing(entries, 'zh'), '正在运行类型检查');
    assert.equal(isProcessingRunning(entries), true);
  });

  test('localizes a running tool when no intent is available', () => {
    const entries = [tools(tool('read-1', 'Read', 'running', 'read'))];

    assert.equal(summarizeProcessing(entries, 'zh'), '正在读取文件');
    assert.equal(summarizeProcessing(entries, 'en'), 'Reading a file');
  });

  test('shows thinking when it is the latest live activity', () => {
    const entries = [
      tools(tool('read-1', 'Read', 'running', 'read')),
      thinking(true),
    ];

    assert.equal(summarizeProcessing(entries, 'zh'), '正在深度思考');
  });
});

test('commentary text remains a boundary around folded activity', async () => {
  const { foldTimeline } = await import('../timeline-fold.js');
  const timeline: TurnTimelineItem[] = [
    {
      kind: 'text',
      text: '准备检查实现。',
      messageId: 'commentary-1',
      phase: 'commentary',
    },
    thinking(),
    tools(tool('read-1', 'Read', 'completed', 'read')),
    {
      kind: 'text',
      text: '已经定位到入口，接下来验证行为。',
      messageId: 'commentary-2',
      phase: 'commentary',
    },
    tools(tool('bash-1', 'Bash', 'completed', 'command')),
    {
      kind: 'text',
      text: '验证通过。',
      messageId: 'final-1',
      phase: 'final_answer',
    },
  ];

  const folded = foldTimeline(timeline);
  assert.deepEqual(folded.map((entry) => entry.kind), [
    'text',
    'processing',
    'text',
    'processing',
    'text',
  ]);
});
