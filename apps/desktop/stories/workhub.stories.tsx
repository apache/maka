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

import { useState } from 'react';
import { ToastProvider, LocaleProvider, AstryxLocaleProvider, ChatSurfaceLayout } from '@maka/ui';
import type { StoredMessage, SessionSummary } from '@maka/core/session';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within, waitFor } from 'storybook/test';
import { WorkHubRoot, WorkHubServicesProvider, type WorkHubServices, type WorkHubTranscriptSnapshot } from '../src/renderer/features/workhub/index.js';
import { WorkHubConversation, WorkHubHighlightContext } from '../src/renderer/features/workhub/testing.js';
import { desktopSessionKey } from '../src/shared/runtime-host-identity.js';

// Real host: a persistent WebContentsView mounts WorkHubRoot once and moves between windows.
const sessionId = desktopSessionKey({ hostId: 'story-host', sessionId: 'maka_workhub_coordination' });
const targetId = desktopSessionKey({ hostId: 'story-host', sessionId: 'payments' });
const writes = { answer: fn(), model: fn(), upload: fn(), open: fn(), question: fn() };
const choices = ['model-a', 'model-b'].map((model, index) => ({
  connectionId: 'connection-test', connectionSlug: 'test', connectionName: 'Test', providerType: 'openai' as const,
  providerLabel: 'OpenAI', model, label: model, isDefault: index === 0, thinkingLevels: [],
}));
function makeServices(failFirst: boolean, withHistory: boolean, coloredHistory: boolean, selectTarget = false, question = false): WorkHubServices {
  let failures = failFirst ? 1 : 0;
  let session: SessionSummary & { revision: number } = {
    id: sessionId, name: 'WorkHub', revision: 1, isFlagged: false, isArchived: false, labels: [], hasUnread: false,
    status: 'active', runningTurnIds: [], backend: 'ai-sdk', llmConnectionId: 'connection-test', llmConnectionSlug: 'test', connectionLocked: false,
    model: 'model-a', permissionMode: 'ask',
  };
  const target = { ...session, id: targetId, name: '支付回调幂等性', cwd: '/projects/maka' };
  let messages: StoredMessage[] = withHistory ? [
    { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: '继续支付回调幂等性，补充重复投递测试点。' },
    { type: 'assistant', id: 'answer-1', turnId: 'turn-1', ts: 2, modelId: 'model-a', text: '已将任务交给支付回调工作。完整说明保留在工作台。\n\n' + '重复请求需要保持同一响应。'.repeat(70) + '\n\nEND_OF_FULL_RESPONSE' },
    { type: 'workhub_coordination', kind: 'delegation_assigned', id: 'link-1', turnId: 'turn-1', coordinationTurnId: 'turn-1', ts: 3, schemaVersion: 1, actionId: 'action-1', actionFingerprint: `sha256:${'0'.repeat(64)}`, disposition: 'delegate_existing', userText: '继续支付回调幂等性，补充重复投递测试点。', targetSessionId: targetId, targetSessionName: target.name, targetTurnId: 'target-turn', targetMessageId: 'target-message', delegationId: 'delegation-1' },
  ] : [];
  const secondTarget = { ...target, id: desktopSessionKey({ hostId: 'story-host', sessionId: 'release' }), name: '发布检查清单', cwd: '/projects/desktop' };
  if (coloredHistory) {
    const link = messages.find((message) => message.type === 'workhub_coordination' && message.kind === 'delegation_assigned')!;
    messages = [target, secondTarget, target].flatMap((work, index): StoredMessage[] => {
      const turnId = `turn-${index + 1}`;
      return [
        { type: 'user', id: `user-${index}`, turnId, ts: index * 3, text: index === 2 ? '继续补充异常场景。' : `请检查${work.name}。` },
        { type: 'assistant', id: `answer-${index}`, turnId, ts: index * 3 + 1, modelId: 'model-a', text: '任务已交给对应 Work。' },
        { ...link, id: `link-${index}`, turnId, coordinationTurnId: turnId, targetSessionId: work.id, targetSessionName: work.name } as StoredMessage,
      ];
    });
    messages.push({ type: 'user', id: 'unlinked', turnId: 'unlinked-turn', ts: 20, text: '先讨论一下整体计划。' });
  }
  const questionRequest: import('@maka/core/events').UserQuestionRequestEvent = {
    type: 'user_question_request', id: 'question-event', ts: 1, turnId: 'question-turn', requestId: 'question-request', toolUseId: 'question-tool',
    questions: [{ question: '首批发布范围选哪个？', options: [{ label: '仅邀请用户' }, { label: '公开测试' }] }],
  };
  if (question) session = { ...session, runningTurnIds: ['question-turn'] };
  if (question) messages = [{ type: 'user', id: 'question-user', turnId: 'question-turn', ts: 1, text: '帮我安排发布。' }, { type: 'turn_state', id: 'question-running', turnId: 'question-turn', ts: 2, status: 'running' }];
  let interactionUpdate: Parameters<WorkHubServices['subscribeActiveInteractions']>[0] | undefined;
  let updateTranscript: ((snapshot: WorkHubTranscriptSnapshot) => void) | undefined;
  let updateSessions: (() => void) | undefined;
  let updateExecution: Parameters<WorkHubServices['observe']>[4];
  let questionPending = question;
  const publishExecution = () => updateExecution?.({ type: 'host_execution', available: true, rootTurn: questionPending ? { sessionId, turnId: 'question-turn', runId: 'question-run', status: 'waiting_for_user' } : null });
  const publish = () => { publishExecution(); updateTranscript?.({ messages, hasOlder: false, hasNewer: false, ready: true }); };
  return {
    retractQueueEntry: async () => {}, promoteQueueEntry: async () => {},
    updateQueueEntry: async () => {}, reorderQueueEntries: async () => {},
    enqueueMessage: async () => 'admitted',
    surface: 'workhub', initialLocale: 'zh-CN', subscribeAppearance: () => () => {},
    presentation: { ready: async () => {}, progressReady: async () => {}, resizeProgress: async () => {}, expandProgress: async () => {}, getSnapshot: async () => ({ placement: 'docked', floatingVisible: false, shortcutRegistered: true, rendererCrashed: false }), setHost: async () => {}, setConversationLayout: async () => {}, detach: async () => {}, dock: async () => {}, hide: async () => {}, openSession: async (id) => { writes.open(id); }, subscribe: () => () => {}, onViewportInset: () => () => {}, onFocusComposer: () => () => {}, onOpenMain: () => () => {} },
    control: { getSnapshot: async () => ({ revision: 0, phase: 'idle', canUndo: false }), subscribe: () => () => {}, stop: async () => {}, undo: async () => {} },
    resolve: async () => sessionId, subscribeHosts: () => () => {}, subscribeAvailability: () => () => {},
    getSession: async () => session,
    listSessions: async () => coloredHistory ? [target, secondTarget] : [target], subscribeSessions: (handler) => { updateSessions = handler; return () => { updateSessions = undefined; }; }, modelChoices: async () => choices,
    delegationFeedback: async (references) => references.map(({ id }) => ({
      id,
      state: coloredHistory && id === 'link-1' ? 'waiting_for_user' as const : coloredHistory && id === 'link-2' ? 'running' as const : 'completed' as const,
      resultPreview: '重复投递测试已通过，支付回调保持同一响应。',
    })),
    attachments: { pickFiles: async () => ({ ok: true, files: [{ approvalId: 'file-1', name: 'requirements.txt', size: 12, mimeType: 'text/plain' }] }), previewApproval: async () => ({ ok: false, reason: 'not-image' }) },
    readAttachmentBytes: async () => { throw new Error('Not an image'); },
    prepareAttachments: async (id, items) => { writes.upload(id, items); return [{ name: 'requirements.txt', kind: 'other', mimeType: 'text/plain', bytes: 12, ref: { kind: 'session_file', sessionId: 'maka_workhub_coordination', relativePath: 'artifact-1' } }]; },
    listActiveInteractions: async () => questionPending ? [questionRequest] : [],
    subscribeActiveInteractions: (handler) => { interactionUpdate = handler; return () => { interactionUpdate = undefined; }; },
    respondToUserQuestion: async (id, response) => {
      writes.question(id, response);
      if (failures-- > 0) throw new Error('Temporary Host failure');
      questionPending = false;
      session = { ...session, runningTurnIds: [] }; updateSessions?.();
      interactionUpdate?.({ sessionId, interactions: [] });
      messages = [...messages, { type: 'assistant', id: 'question-answer', turnId: 'question-turn', ts: 3, modelId: 'model-a', text: '按公开测试安排发布。' }, { type: 'turn_state', id: 'question-complete', turnId: 'question-turn', ts: 4, status: 'completed' }];
      publish();
    },
    answer: async (id, input) => {
      writes.answer(id, input);
      if (selectTarget && !input.selection) return { kind: 'selection_required', turnId: input.turnId, request: {
        requestId: 'selection-request', candidateSetId: `sha256:${'0'.repeat(64)}`,
        candidates: [target, secondTarget].map((candidate, index) => ({ candidateRef: `candidate-${index}`, sessionId: candidate.id, sessionName: candidate.name, workspace: { target: { kind: 'host_path' as const, path: candidate.cwd }, hostCwd: candidate.cwd }, state: 'active' as const, updatedAt: 1 })),
      } };
      if (failures-- > 0) throw new Error('Temporary Host failure');
      messages = [...messages, { type: 'user', id: input.turnId, turnId: input.turnId, ts: 4, text: input.text, attachments: input.attachments }, { type: 'assistant', id: `${input.turnId}-answer`, turnId: input.turnId, ts: 5, modelId: 'model-a', text: '已收到。' }, { type: 'turn_state', id: `${input.turnId}-done`, turnId: input.turnId, ts: 6, status: 'completed' }];
      publish(); return { kind: 'admitted', turnId: input.turnId };
    },
    configureModel: async (id, input) => {
      writes.model(id, input); session = { ...session, revision: session.revision + 1, model: input.modelTarget.model }; updateSessions?.();
      return { kind: 'committed', session: { ...session, workspace: { target: { kind: 'host_path', path: '/projects/maka' }, hostCwd: '/projects/maka' }, createdAt: 0, activityAt: 0, labelsTruncated: false, llmConnectionId: 'connection-test', collaborationMode: 'agent', orchestrationMode: 'default' } };
    },
    observe: (_id, _event, _error, _phase, execution) => { updateExecution = execution; publishExecution(); return () => { updateExecution = undefined; }; },
    openTranscript: async (_id, handler) => { updateTranscript = handler; publish(); return { observationChanged: () => {}, prefetchHistory: async () => false, retain: () => {}, loadLatest: async () => {}, close: async () => { updateTranscript = undefined; } }; },
    stop: async () => {
      questionPending = false;
      session = { ...session, runningTurnIds: [] }; updateSessions?.();
      interactionUpdate?.({ sessionId, interactions: [] });
      messages = [...messages, { type: 'turn_state', id: 'question-abort', turnId: 'question-turn', ts: 4, status: 'aborted' }];
      publish(); return [];
    },

  };
}
function Surface({ failFirst = false, history = false, colors = false, selectTarget = false, question = false }: { failFirst?: boolean; history?: boolean; colors?: boolean; selectTarget?: boolean; question?: boolean }) {
  const [services] = useState(() => makeServices(failFirst, history, colors, selectTarget, question));
  return <LocaleProvider locale="zh-CN"><AstryxLocaleProvider><ToastProvider><WorkHubServicesProvider services={services}><div style={{ height: '100dvh' }}><WorkHubRoot /></div></WorkHubServicesProvider></ToastProvider></AstryxLocaleProvider></LocaleProvider>;
}
const meta = { title: 'Product/WorkHub', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const FullConversationAndWorkIdentity: Story = {
  render: () => <Surface history />,
  play: async ({ canvasElement }) => {
    Object.values(writes).forEach((spy) => spy.mockClear());
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText(/END_OF_FULL_RESPONSE/)).toBeInTheDocument());
    await waitFor(() => expect(canvasElement.querySelector('.workhub-delegation-status')).toHaveTextContent('已完成'));
    expect(canvasElement.querySelector('.workhub-result-card')).toBeNull();
    await userEvent.click(canvasElement.querySelector('.workhub-turn-label') as HTMLElement);
    await waitFor(() => expect(writes.open).toHaveBeenCalledWith(targetId));
    const navigation = canvasElement.querySelector('.workhub-navigation-item') as HTMLElement;
    await userEvent.hover(navigation);
    await waitFor(() => expect(canvasElement.querySelector('.workhub-turn-label')).toHaveAttribute('data-work-highlighted', 'true'));
  },
};
export const FullConversationNarrow: Story = { ...FullConversationAndWorkIdentity, parameters: { viewport: { defaultViewport: 'tablet' } } };
export const StandardComposer: Story = {
  render: () => <Surface />,
  play: async ({ canvasElement }) => {
    Object.values(writes).forEach((spy) => spy.mockClear());
    const canvas = within(canvasElement); const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(canvas.getByRole('button', { name: /切换当前任务模型/ })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: /切换当前任务模型/ }));
    const wheel = canvas.getByRole('listbox', { name: /切换当前任务模型/ });
    await expect(within(wheel).getByRole('option', { name: /model-a/, selected: true })).toBeInTheDocument();
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(writes.model).toHaveBeenCalledWith(sessionId, expect.objectContaining({ expectedRevision: 1, modelTarget: expect.objectContaining({ model: 'model-b' }) })));
    await waitFor(() => expect(within(wheel).getByRole('option', { name: /model-b/, selected: true })).toBeInTheDocument());
    await userEvent.keyboard('{Escape}');
    await userEvent.click(canvas.getByRole('button', { name: '添加上下文' }));
    await userEvent.click(page.getByRole('menuitem', { name: /添加文件/ }));
    const editor = canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor); await userEvent.type(editor, 'Review requirements'); await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(writes.answer).toHaveBeenCalledWith(sessionId, expect.objectContaining({ text: 'Review requirements', attachments: [expect.objectContaining({ name: 'requirements.txt' })] })));
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-composer-attachment-token')).toHaveLength(0));
  },
};
export const ComposerRetainsFailedAttachment: Story = {
  render: () => <Surface failFirst />,
  play: async ({ canvasElement }) => {
    Object.values(writes).forEach((spy) => spy.mockClear());
    const canvas = within(canvasElement); const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(canvas.getByRole('button', { name: /切换当前任务模型/ })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: '添加上下文' }));
    await userEvent.click(page.getByRole('menuitem', { name: /添加文件/ }));
    const editor = canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor); await userEvent.type(editor, 'Review requirements'); await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent('Temporary Host failure'));
    expect(editor).toHaveTextContent('Review requirements');
    expect(canvasElement.querySelectorAll('.maka-composer-attachment-token')).toHaveLength(1);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(writes.answer).toHaveBeenCalledTimes(2));
    expect(writes.upload).toHaveBeenCalledTimes(1);
    expect(writes.answer.mock.calls[0]?.[1].turnId).toBe(writes.answer.mock.calls[1]?.[1].turnId);
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-composer-attachment-token')).toHaveLength(0));
  },
};

export const ColoredWorkHistory: Story = {
  render: () => <Surface history colors />,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelectorAll('[data-turn-accent="true"]')).toHaveLength(3));
    const turns = canvasElement.querySelectorAll<HTMLElement>('[data-turn-accent="true"]');
    const stripeColor = (turn: HTMLElement) => getComputedStyle(turn.querySelector('.maka-user-message')!).borderRightColor;
    expect(stripeColor(turns[0]!)).toBe(stripeColor(turns[2]!));
    expect(stripeColor(turns[0]!)).not.toBe(stripeColor(turns[1]!));
    expect(turns[0]!.querySelector('.workhub-turn-label')).toHaveTextContent('maka / 支付回调幂等性');
    expect(turns[1]!.querySelector('.workhub-turn-label')).toHaveTextContent('desktop / 发布检查清单');
    expect(canvasElement.querySelector('[data-transcript-turn-id="unlinked-turn"]')).not.toHaveAttribute('data-turn-accent');
    for (const [index, turn] of turns.entries()) {
      expect(turn.querySelectorAll('.workhub-turn-label')).toHaveLength(2);
      const status = turn.querySelector('.maka-user-message .workhub-delegation-status')!;
      expect(status).toHaveTextContent(['已完成', '等待用户', '进行中'][index]!);
      expect(turn.querySelector('.maka-assistant-answer .workhub-delegation-status')).toBeNull();
      expect(canvasElement.querySelector('.workhub-result-card')).toBeNull();
      expect(getComputedStyle(turn.querySelector('.workhub-turn-label span')!).fontSize).toBe('11px');
      const prompt = getComputedStyle(turn.querySelector('.maka-user-message')!);
      const answer = getComputedStyle(turn.querySelector('.maka-assistant-answer')!);
      expect(prompt.borderRightWidth).toBe('3px');
      expect(prompt.borderLeftWidth).toBe('0px');
      expect(answer.borderLeftWidth).toBe('3px');
      expect(answer.borderRightWidth).toBe('0px');
      expect(getComputedStyle(turn).borderLeftWidth).toBe('0px');
    }
    const metadataRights = [...canvasElement.querySelectorAll('.maka-user-message .maka-message-meta')].map((element) => element.getBoundingClientRect().right);
    expect(metadataRights).toHaveLength(4);
    expect(Math.max(...metadataRights) - Math.min(...metadataRights)).toBeLessThan(1);
    const label = turns[0]!.querySelector<HTMLElement>('.workhub-turn-label')!;
    await userEvent.hover(label);
    await waitFor(() => expect(turns[2]!.querySelector('.workhub-turn-label')).toHaveAttribute('data-work-highlighted', 'true'));
    const dark = canvasElement.ownerDocument.documentElement.classList.contains('dark');
    await waitFor(() => expect(getComputedStyle(label).color).toMatch(dark ? /^okl(?:ch|ab)\(0\.85 / : /^okl(?:ch|ab)\(0\.48 /));
    await userEvent.click(label);
    expect(writes.open).toHaveBeenCalledWith(targetId);
    await userEvent.unhover(label);
  },
};

export const TargetSelection: Story = {
  render: () => <Surface selectTarget />,
  play: async ({ canvasElement }) => {
    const editor = canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor);
    await userEvent.type(editor, '继续支付相关的工作，把异常场景补齐。');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvasElement.querySelector('.workhub-target-selector')).toBeInTheDocument());
    expect(canvasElement.querySelector('.maka-turn-processing')).toBeNull();
    expect(canvasElement.querySelector('.workhub-delegation-status')).toHaveTextContent('等待');
  },
};

export const KeyboardTargetSelection: Story = {
  render: () => <Surface selectTarget />,
  play: async (context) => {
    Object.values(writes).forEach((spy) => spy.mockClear());
    await TargetSelection.play!(context);
    const canvas = within(context.canvasElement);
    expect(canvas.getByRole('button', { name: '确认目标' })).toBeDisabled();
    await userEvent.keyboard('2');
    await waitFor(() => expect(canvas.getAllByRole('radio')[1]).toBeChecked());
    expect(writes.answer).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(context.canvasElement.querySelector('.workhub-target-selector')).toBeNull());
    expect(writes.answer).toHaveBeenLastCalledWith(sessionId, expect.objectContaining({ text: '继续支付相关的工作，把异常场景补齐。', selection: { requestId: 'selection-request', kind: 'existing', candidateRef: 'candidate-1' } }));
    const editor = context.canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    await waitFor(() => expect(editor).toHaveTextContent(''));
    await userEvent.click(editor); await userEvent.type(editor, '需要进一步说明'); await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(context.canvasElement.querySelector('.workhub-target-selector')).toBeInTheDocument());
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(canvas.getAllByRole('radio')[0]).toBeChecked());
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(canvas.getAllByRole('radio')[1]).toBeChecked());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(context.canvasElement.querySelector('.workhub-target-selector')).toBeNull());
    expect(editor).toHaveTextContent('需要进一步说明');
    expect(writes.answer).toHaveBeenCalledTimes(3);
  },
};

export const TargetSelectionFailure: Story = {
  render: () => <Surface selectTarget failFirst />,
  play: async (context) => {
    await TargetSelection.play!(context);
    await userEvent.keyboard('1{Enter}');
    await waitFor(() => expect(context.canvasElement.querySelector('.workhub-target-selector')).toBeNull());
    const editor = context.canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    expect(editor).toHaveTextContent('继续支付相关的工作，把异常场景补齐。');
    expect(within(context.canvasElement).getByRole('alert')).toHaveTextContent('Temporary Host failure');
    expect(context.canvasElement.querySelector('.workhub-delegation-status')).toHaveTextContent('失败');
  },
};

export const QuestionLifecycle: Story = {
  render: () => <Surface question failFirst />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('heading', { name: '首批发布范围选哪个？' })).toBeInTheDocument());
    expect(canvasElement.querySelector('.workhub-delegation-status')).toHaveTextContent('等待');
    expect(canvasElement.querySelector('.maka-turn-processing')).toBeNull();
    await userEvent.keyboard('2{Enter}');
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent('Temporary Host failure'));
    await waitFor(() => expect(canvas.getAllByRole('radio')[1]).toBeChecked());
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvasElement.querySelector('.maka-user-question-prompt')).toBeNull());
    expect(canvasElement.querySelector('.workhub-delegation-status')).toHaveTextContent('已完成');
    expect(canvas.getByText('按公开测试安排发布。')).toBeInTheDocument();
    expect(writes.question).toHaveBeenLastCalledWith(sessionId, expect.objectContaining({ requestId: 'question-request' }));
  },
};

export const QuestionStopped: Story = {
  render: () => <Surface question />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector('.maka-user-question-prompt')).toBeInTheDocument());
    await userEvent.click(canvas.getByRole('button', { name: '停止' }));
    await waitFor(() => expect(canvasElement.querySelector('.maka-user-question-prompt')).toBeNull());
    expect(canvasElement.querySelector('.workhub-delegation-status')).toHaveTextContent('中止');
  },
};

export const FilterWorkConversations: Story = {
  render: () => <Surface history colors />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-transcript-turn')).toHaveLength(4));
    writes.open.mockClear();
    await userEvent.click(canvasElement.querySelector('.maka-user-message .workhub-message-rail') as HTMLElement);
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-transcript-turn')).toHaveLength(2));
    expect(canvas.queryByText('请检查发布检查清单。')).toBeNull();
    expect(canvas.queryByText('先讨论一下整体计划。')).toBeNull();
    expect(canvas.getByText('继续补充异常场景。')).toBeInTheDocument();
    expect(writes.open).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole('button', { name: '显示全部对话' }));
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-transcript-turn')).toHaveLength(4));
    const rail = canvasElement.querySelectorAll('.workhub-navigation-item')[1] as HTMLElement;
    await userEvent.click(rail);
    await waitFor(() => expect(canvasElement.querySelector('[data-search-highlight="true"]')).toHaveTextContent('请检查发布检查清单。'));
    expect(canvasElement.querySelectorAll('.maka-transcript-turn')).toHaveLength(4);
    expect(writes.open).not.toHaveBeenCalled();
    await userEvent.click(rail);
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-transcript-turn')).toHaveLength(1));
    expect(canvas.getByText('请检查发布检查清单。')).toBeInTheDocument();
    expect(writes.open).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole('button', { name: '显示全部对话' }));
    const answerRail = canvasElement.querySelector('.maka-assistant-answer .workhub-message-rail') as HTMLElement;
    answerRail.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-transcript-turn')).toHaveLength(2));
    await userEvent.click(canvas.getByRole('button', { name: '显示全部对话' }));
    await userEvent.click(rail);
    await waitFor(() => expect(canvasElement.querySelector('[data-search-highlight="true"]')).toHaveTextContent('请检查发布检查清单。'));
    expect(canvasElement.querySelectorAll('.maka-transcript-turn')).toHaveLength(4);
    (rail.querySelector('button') as HTMLButtonElement).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-transcript-turn')).toHaveLength(1));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-transcript-turn')).toHaveLength(4));
    expect(writes.open).not.toHaveBeenCalled();
  },
};

function PagedWorkConversation() {
  const [loaded, setLoaded] = useState(false);
  const [selectedWork, selectWork] = useState<{ sessionId: string; name: string } | undefined>({ sessionId: targetId, name: '支付回调幂等性' });
  const messages: StoredMessage[] = [
    ...(loaded ? [{ type: 'user' as const, id: 'older', turnId: 'older-turn', ts: 1, text: '请检查支付回调幂等性。' }] : []),
    { type: 'user', id: 'latest', turnId: 'latest-turn', ts: 2, text: '继续补充异常场景。' },
    { type: 'user', id: 'discussion', turnId: 'discussion-turn', ts: 3, text: '先讨论一下整体计划。' },
  ];
  return <LocaleProvider locale="zh-CN"><AstryxLocaleProvider><ToastProvider>
    <WorkHubHighlightContext.Provider value={{ sessionId: undefined, highlight: () => {}, navigateWork: () => {}, selectedWork, selectWork, toggleWork: (work) => selectWork((current) => current?.sessionId === work.sessionId ? undefined : work) }}>
      <ChatSurfaceLayout composer={null}><div className="workhub-surface"><WorkHubConversation messages={messages} onOpenWork={() => {}} onNew={() => {}} scrollBehavior="auto"
        activeSession={{ id: sessionId, name: 'WorkHub', isFlagged: false, isArchived: false, labels: [], hasUnread: false, status: 'active', runningTurnIds: [], backend: 'ai-sdk', llmConnectionId: 'connection-test', llmConnectionSlug: 'test', connectionLocked: false, model: 'model-a', permissionMode: 'ask' }}
        hasOlderHistory={!loaded} onPrefetchHistory={async () => { setLoaded(true); return true; }}
        workLinks={['older-turn', 'latest-turn'].map((coordinationTurnId) => ({ id: coordinationTurnId, coordinationTurnId, targetSessionId: targetId, targetSessionName: '支付回调幂等性' }))} />
      </div></ChatSurfaceLayout>
    </WorkHubHighlightContext.Provider>
  </ToastProvider></AstryxLocaleProvider></LocaleProvider>;
}
export const FilterWorkHistoryPages: Story = {
  render: () => <PagedWorkConversation />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText('继续补充异常场景。')).toBeInTheDocument());
    expect(canvas.queryByText('请检查支付回调幂等性。')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: '更早的历史' }));
    await waitFor(() => expect(canvas.getByText('请检查支付回调幂等性。')).toBeInTheDocument());
    expect(canvas.queryByText('先讨论一下整体计划。')).toBeNull();
    expect(canvas.queryByRole('button', { name: '更早的历史' })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: '显示全部对话' }));
    await waitFor(() => expect(canvas.getByText('先讨论一下整体计划。')).toBeInTheDocument());
  },
};
export const FilterWorkConversationsNarrow: Story = { ...FilterWorkConversations, parameters: { viewport: { defaultViewport: 'tablet' } } };

export const WorkFilterHoverAndToggle: Story = {
  render: () => <Surface history colors />,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-transcript-turn')).toHaveLength(4));
    writes.open.mockClear();
    const transcriptElement = canvasElement.querySelector('[data-turn-source-count]');
    const stripe = () => canvasElement.querySelector('.maka-user-message .workhub-message-rail') as HTMLElement;
    const color = () => getComputedStyle(canvasElement.querySelector('.maka-user-message')!).borderRightColor;
    const original = color();
    await userEvent.hover(stripe());
    await waitFor(() => expect(color()).not.toBe(original));
    expect(canvasElement.querySelector('.workhub-navigation-item')).toHaveAttribute('data-work-highlighted', 'true');
    await userEvent.unhover(stripe());
    await waitFor(() => expect(color()).toBe(original));
    await userEvent.click(stripe());
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-transcript-turn')).toHaveLength(2));
    await userEvent.click(canvasElement.querySelector('.maka-assistant-answer .workhub-message-rail') as HTMLElement);
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-transcript-turn')).toHaveLength(4));
    await userEvent.click(stripe());
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-transcript-turn')).toHaveLength(2));
    await userEvent.click(canvasElement.querySelector('.workhub-navigation-item') as HTMLElement);
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-transcript-turn')).toHaveLength(4));
    await userEvent.click(canvasElement.querySelector('.workhub-navigation-item') as HTMLElement);
    await userEvent.click(canvasElement.querySelector('.workhub-navigation-item') as HTMLElement);
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-transcript-turn')).toHaveLength(2));
    await userEvent.click(canvasElement.querySelector('.workhub-navigation-item') as HTMLElement);
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-transcript-turn')).toHaveLength(4));
    expect(writes.open).not.toHaveBeenCalled();
    expect(canvasElement.querySelector('[data-turn-source-count]')).toBe(transcriptElement);
  },
};

export const SendWhileWorkFiltered: Story = {
  render: () => <Surface history colors />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector('.workhub-message-rail')).not.toBeNull());
    await userEvent.click(canvasElement.querySelector('.workhub-message-rail') as HTMLElement);
    const editor = canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor);
    await userEvent.keyboard('FILTERED_SEND_PROBE{Enter}');
    await waitFor(() => expect(canvas.getByText('FILTERED_SEND_PROBE')).toBeInTheDocument());
    await waitFor(() => expect(canvas.getByText('已收到。')).toBeInTheDocument());
    expect(canvas.queryByRole('button', { name: '显示全部对话' })).toBeNull();
  },
};

export const RetryWhileWorkFiltered: Story = {
  render: () => <Surface history colors failFirst />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    writes.answer.mockClear();
    await waitFor(() => expect(canvasElement.querySelector('.workhub-message-rail')).not.toBeNull());
    const editor = canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor);
    await userEvent.keyboard('FILTERED_RETRY_PROBE{Enter}');
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent('Temporary Host failure'));
    await userEvent.click(canvasElement.querySelector('.workhub-message-rail') as HTMLElement);
    await waitFor(() => expect(canvas.getByRole('button', { name: '显示全部对话' })).toBeInTheDocument());
    await userEvent.click(canvas.getByRole('button', { name: /^重试$/ }));
    await waitFor(() => expect(writes.answer).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(canvas.getByText('已收到。')).toBeInTheDocument());
    expect(canvas.getByText('FILTERED_RETRY_PROBE', { selector: '.maka-user-message *' })).toBeInTheDocument();
    expect(canvas.queryByRole('button', { name: '显示全部对话' })).toBeNull();
  },
};
