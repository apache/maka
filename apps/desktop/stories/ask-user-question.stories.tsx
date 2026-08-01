import type { Meta, StoryObj } from '@storybook/react-vite';
import type { UserQuestionRequestEvent } from '@maka/core';
import { UserQuestionPrompt } from '@maka/ui';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Ask User Question',
  component: UserQuestionPrompt,
  parameters: {
    layout: 'fullscreen',
  },
  // The production slot is `display: contents` and the prompt caps itself at
  // `--maka-chat-measure`, so the only thing the frame owes it is a full-height
  // canvas pinning it to the composer's position at the bottom of the chat
  // column. A narrower column is a viewport, not a second story — the smoke
  // manifest renders this one at compact and floor.
  decorators: [
    (Story) => (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          padding: 'var(--space-6) 0',
          background: 'var(--surface-canvas)',
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof UserQuestionPrompt>;

export default meta;

type Story = StoryObj<typeof meta>;

const REQUEST: UserQuestionRequestEvent = {
  type: 'user_question_request',
  id: 'prototype-event',
  ts: Date.now(),
  turnId: 'prototype-turn',
  requestId: 'prototype-request',
  toolUseId: 'prototype-tool',
  questions: [
    {
      question: '首批发布范围选哪个？',
      options: [
        { label: '仅邀请用户', description: '先验证核心流程，再逐步扩大范围。' },
        { label: '公开测试', description: '允许所有访客注册，但保留 Beta 标识。' },
        { label: '正式发布', description: '面向所有访客并启动完整推广。' },
      ],
    },
    { question: '上线时间怎么安排？', options: [{ label: '本周' }, { label: '下周' }] },
    { question: '是否同步发布公告？', options: [{ label: '是' }, { label: '否' }] },
  ],
};

// Real path: chat → the agent calls AskUserQuestion → ChatComposerRegion hides the
// composer and the prompt takes over its slot, on the first of three questions.
export const PendingDecisions: Story = {
  args: {
    request: REQUEST,
    onRespond: () => {},
    onStop: () => {},
  },
};
