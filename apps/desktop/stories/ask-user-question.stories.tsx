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
import type { UserQuestionRequestEvent } from '@maka/core/events';
import type { UserQuestionResponse } from '@maka/core/user-question';
import { expect, userEvent, within, waitFor } from 'storybook/test';
import { UserQuestionPrompt } from '@maka/ui';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Ask User Question',
  component: UserQuestionPrompt,
  parameters: {
    layout: 'fullscreen',
  },
  // The prompt's root carries the `composer` class, and `.mainColumn` zeroes
  // that class's top padding in production. Without that ancestor the story
  // would render the prompt var(--space-2) lower than the app does, so the
  // frame reproduces the two wrappers the renderer puts around the composer
  // slot rather than approximating them with a bare canvas.
  //
  // A narrower column is a viewport, not a second story. Responsive behaviour
  // belongs in the real desktop harness rather than a duplicate catalog entry.
  decorators: [
    (Story) => (
      <div
        className="maka-panel maka-panel-detail"
        style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="maka-detail-with-artifacts">
          <div className="mainColumn" style={{ justifyContent: 'flex-end' }}>
            <Story />
          </div>
        </div>
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

// Real path: chat → the agent calls AskUserQuestion → the prompt appears in the
// composer's place, on the first of three questions.
//
// Scope: the prompt, not the takeover. ChatComposerRegion is what hides the
// Composer while an interaction owns the slot, and this story does not mount it,
// so nothing here would fail if the prompt and the Composer rendered together.
// That host contract has no coverage today; it belongs to a region-level test,
// not to a story about how the prompt itself reads.
export const PendingDecisions: Story = {
  args: {
    request: REQUEST,
    onRespond: () => {},
    onStop: () => {},
  },
};

export const KeyboardChoices: Story = {
  ...PendingDecisions,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The panel takes focus when it mounts, and these shortcuts are handled on
    // it rather than on the document. A key sent before that focus lands is
    // delivered to <body> and dropped, which is a slow-runner race rather than
    // a product one, so wait for the panel to actually hold focus first.
    await waitFor(() =>
      expect(document.activeElement).toBe(canvasElement.querySelector('.maka-choice-panel')));
    // A question may be left unanswered: Next stays enabled with nothing
    // selected and the response carries a null answer.
    expect(canvas.getByRole('button', { name: '下一题' })).toBeEnabled();
    await userEvent.keyboard('2');
    await waitFor(() => expect(canvas.getByRole('option', { name: /公开测试/ })).toHaveAttribute('aria-selected', 'true'));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.getByRole('heading', { name: '上线时间怎么安排？' })).toBeInTheDocument());
    // Escape moves focus to the answer input — the free-form answer is typed
    // straight into the composer.
    await userEvent.keyboard('{Escape}');
    const input = canvas.getByRole('textbox');
    await waitFor(() => expect(document.activeElement).toBe(input));
    await userEvent.type(input, '123');
    expect(input).toHaveTextContent('123');
    // Enter inside the input commits the typed answer and advances.
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.getByRole('heading', { name: '是否同步发布公告？' })).toBeInTheDocument());
  },
};

const responses: UserQuestionResponse[] = [];

// Real path: WorkHub → AskUserQuestion → a typed answer on the last question →
// the Host rejects the response. WorkHub rethrows into the prompt (chat toasts
// instead), so the alert shows in place and the answer stays editable for
// retry rather than being wiped by the submit.
export const SubmitFailure: Story = {
  args: {
    request: REQUEST,
    onRespond: (response) => {
      responses.push(response);
      return Promise.reject(new Error('Temporary Host failure'));
    },
    onStop: () => {},
  },
  play: async ({ canvasElement }) => {
    responses.length = 0;
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(document.activeElement).toBe(canvasElement.querySelector('.maka-choice-panel')));
    await userEvent.keyboard('1{Enter}');
    await waitFor(() => expect(canvas.getByRole('heading', { name: '上线时间怎么安排？' })).toBeInTheDocument());
    await waitFor(() =>
      expect(document.activeElement).toBe(canvasElement.querySelector('.maka-choice-panel')));
    await userEvent.keyboard('1{Enter}');
    await waitFor(() => expect(canvas.getByRole('heading', { name: '是否同步发布公告？' })).toBeInTheDocument());
    const input = canvas.getByRole('textbox');
    await userEvent.click(input);
    await userEvent.type(input, '下周再说');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent('Temporary Host failure'));
    expect(input).toHaveTextContent('下周再说');
    expect(responses.at(-1)).toMatchObject({ requestId: 'prototype-request', answers: ['仅邀请用户', '本周', '下周再说'] });
  },
};
