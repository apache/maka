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

import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChatMessageBubble } from '@astryxdesign/core';
import { Markdown } from '../src/markdown.js';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Markdown',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function ProseFrame(props: { children: React.ReactNode; width?: number }) {
  return (
    <div
      data-maka-e2e-fixture="true"
      style={{
        background: 'var(--surface-canvas)',
        padding: 24,
      }}
    >
      <div style={{ margin: '0 auto', maxWidth: props.width ?? 720, width: '100%' }}>
        {props.children}
      </div>
    </div>
  );
}

// The two stories above render markdown at document density, which is the Daily
// Review's mode — not the transcript's. The transcript passes
// `density="compact"` (chat-turn.tsx), a different block rhythm AND a different
// heading scale, so neither story showed what a chat turn actually looks like.
// This one does.
//
// The frame is written out rather than imported: the real host is `ChatTurn`,
// which needs a full TurnViewModel and a runtime to build one. What is
// reproduced here is the part that reaches markdown — the `.maka-turn` wrapper
// and the assistant bubble. Nothing in the markdown rhythm keys on `.maka-turn`
// any more (it keys on Astryx's `data-density`), so the wrapper is here for
// frame fidelity, not to make the styles apply.
//
// Real path: chat → any assistant turn whose reply uses nested headings and a
// list — i.e. the ordinary long answer, rendered as the transcript renders it.
export const TranscriptTurn: Story = {
  render: () => (
    <ProseFrame>
      <div className="maka-turn">
        <ChatMessageBubble variant="ghost" className="maka-chat-message-bubble maka-chat-message-bubble-assistant">
          <Markdown
            density="compact"
            text={[
              '## 改动思路',
              '',
              '这次把会话列表收敛成置顶和最近两段，状态只保留在行图标上。好处是**所有会话都遵循同一条时间排序规则**。',
              '',
              '### 具体做法',
              '',
              '主要做了三件事：',
              '',
              '1. 置顶会话固定在最上方；',
              '2. 其余会话按最近活动时间排序；',
              '3. 运行中、等待和阻塞等状态只显示为低干扰行图标。',
              '',
              '#### 边界情况',
              '',
              '按项目视图仍然保留项目折叠，扁平化只作用于按时间视图。',
              '',
              '> 注意：新增状态只需补一个行图标。',
              '',
              '如果后续要加新状态，只需补充对应的行图标，不再扩张侧栏信息架构。',
            ].join('\n')}
          />
        </ChatMessageBubble>
      </div>
    </ProseFrame>
  ),
};

// Real path: 每日回顾 → a generated report that mixes headings, emphasis, a list,
// a quote and a table. This is the document density — the Daily Review panel is
// the caller that leaves `density` unset. (It was annotated as a chat answer,
// but chat passes `density="compact"`; see TranscriptTurn above.)
export const RichAssistantAnswer: Story = {
  render: () => (
    <ProseFrame>
      <ChatMessageBubble variant="ghost" className="maka-chat-message-bubble maka-chat-message-bubble-assistant">
        <Markdown
          text={[
            '## 改动思路',
            '',
            '这次把会话列表收敛成置顶和最近两段，状态只保留在行图标上。好处是**所有会话都遵循同一条时间排序规则**，不会因为生命周期变化突然跳到别的分组。',
            '',
            '主要做了三件事：',
            '',
            '1. 置顶会话固定在最上方；',
            '2. 其余会话按最近活动时间排序；',
            '3. 运行中、等待和阻塞等状态只显示为低干扰行图标。',
            '',
            '> 注意：按项目视图仍然保留项目折叠，扁平化只作用于按时间视图。',
            '',
            '| 行状态 | 视觉标识 | 是否改变分组 |',
            '| --- | --- | --- |',
            '| running | 旋转图标 | 否 |',
            '| waiting_for_user | 等待图标 | 否 |',
            '| blocked | 警示图标 | 否 |',
            '| active | 无图标 | 否 |',
            '',
            '如果后续要加新状态，只需补充对应的行图标，不再扩张侧栏信息架构。',
          ].join('\n')}
        />
      </ChatMessageBubble>
    </ProseFrame>
  ),
};

// Real path: 每日回顾 → a long generated report, pinned at the 680px prose measure
// to check vertical rhythm across many blocks at document density.
export const LongFormArticle: Story = {
  render: () => (
    <ProseFrame width={680}>
      <ChatMessageBubble variant="ghost" className="maka-chat-message-bubble maka-chat-message-bubble-assistant">
        <Markdown
          text={[
            '# Storybook 表面覆盖：为什么单独可看很重要',
            '',
            '当一次改动同时影响多个状态时，靠手动把桌面 app 驱动到每条路径太慢，也容易漏。把每个可见状态固定成 Storybook 的一帧，reviewer 可以逐个点开核对，回归截图也能自动比对。',
            '',
            '## 范围',
            '',
            '这次补的主要是高频但此前没有 story 的页面：',
            '',
            '- 权限弹窗（8 种 reason + 3 种 health）',
            '- 顶层布局（侧栏 + 主区 + overlay 堆叠）',
            '- 首次启动引导',
            '',
            '## 非目标',
            '',
            '`AppShell` 这个集成根不在 Storybook 里整体挂载。它深度依赖桌面 preload 的 IPC，整体挂载需要造一整套 mock，维护成本高、容易脆。改为用真实的子组件拼出布局，能稳定反映页面长什么样。',
            '',
            '| 页面 | 方式 | 原因 |',
            '| --- | --- | --- |',
            '| 权限弹窗 | 直接挂载 | 叶子组件，props 驱动 |',
            '| 顶层布局 | 组合子组件 | 避开 IPC 耦合 |',
            '| 设置各页 | 桥接 mock | 已有 `ConnectionsBridge` 模式 |',
            '',
            '## 验证',
            '',
            '写完后跑一次 `npm run build-storybook`，确认所有 story 编译通过；再视情况补回归截图。',
            '',
            '### 截图基线怎么补',
            '',
            '新 story 落地后跑一遍采集脚本，把首轮产物当作基线入库。',
            '',
            '#### 已知噪声',
            '',
            '字体渲染在不同 GPU 下有亚像素差异，比对时用容差阈值。',
            '',
            // hr; `***` instead of triple-dash so the storybook-baseline token
            // scan doesn't read the quoted literal as a custom-property token.
            '***',
            '',
            '以上是全部范围；有疑问先在 issue 里讨论再动手。',
          ].join('\n')}
        />
      </ChatMessageBubble>
    </ProseFrame>
  ),
};
