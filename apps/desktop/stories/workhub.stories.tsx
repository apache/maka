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
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { StoredMessage, SessionSummary } from '@maka/core/session';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within, waitFor } from 'storybook/test';
import { WorkHubRoot, WorkHubServicesProvider, type WorkHubServices, type WorkHubTranscriptSnapshot } from '../src/renderer/features/workhub/index.js';
import { WorkHubConversation, WorkHubHighlightContext } from '../src/renderer/features/workhub/testing.js';
import { WorkbarServicesProvider, WorkbarWorkspace } from '../src/renderer/features/workbar';
import { createFakeWorkbarServices } from '../src/renderer/features/workbar/testing.js';
import { desktopSessionKey } from '../src/shared/runtime-host-identity.js';

// Real host: a persistent WebContentsView mounts WorkHubRoot once and moves between windows.
const sessionId = desktopSessionKey({ hostId: 'story-host', sessionId: 'maka_workhub_coordination' });
const targetId = desktopSessionKey({ hostId: 'story-host', sessionId: 'payments' });
const writes = { answer: fn(), model: fn(), upload: fn(), open: fn(), question: fn(), form: fn() };
const choices = ['model-a', 'model-b'].map((model, index) => ({
  connectionId: 'connection-test', connectionSlug: 'test', connectionName: 'Test', providerType: 'openai' as const,
  providerLabel: 'OpenAI', model, label: model, contextWindow: 100_000, isDefault: index === 0, thinkingLevels: ['low', 'high'] as ThinkingLevel[],
}));
function makeServices(failFirst: boolean, withHistory: boolean | 'usage', coloredHistory: boolean, selectTarget = false, question = false, progress = false): WorkHubServices {
  let failures = failFirst ? 1 : 0;
  let session: SessionSummary & { revision: number } = {
    id: sessionId, name: 'WorkHub', revision: 1, isFlagged: false, isArchived: false, labels: [], hasUnread: false,
    status: 'active', runningTurnIds: [], backend: 'ai-sdk', llmConnectionId: 'connection-test', llmConnectionSlug: 'test', connectionLocked: false,
    model: 'model-a', permissionMode: 'ask',
  };
  const target = { ...session, id: targetId, name: '支付回调幂等性', cwd: '/projects/maka' };
  let messages: StoredMessage[] = withHistory ? [
    { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: '继续支付回调幂等性，补充重复投递测试点。' },
    { type: 'assistant', id: 'answer-1', turnId: 'turn-1', ts: 2, modelId: 'model-a', text: withHistory === 'usage' ? '已补充重复投递测试：同一支付回调多次到达时，只记录一次支付结果，并返回一致的响应。\n\n接下来会核对并发回调的处理结果。' : '已将任务交给支付回调工作。完整说明保留在工作台。\n\n' + '重复请求需要保持同一响应。'.repeat(70) + '\n\nEND_OF_FULL_RESPONSE' },
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
  let pendingForm: import('@maka/core/events').FormRequestEvent | undefined;
  const publishExecution = () => updateExecution?.({ type: 'host_execution', available: true, rootTurn: pendingForm ? { sessionId, turnId: pendingForm.turnId, runId: 'selection-run', status: 'waiting_for_user' } : questionPending ? { sessionId, turnId: 'question-turn', runId: 'question-run', status: 'waiting_for_user' } : null });
  const publish = () => { publishExecution(); updateTranscript?.({ messages, hasOlder: false, hasNewer: false, ready: true }); };
  return {
    inspector: {
      context: async () => ({ ok: true, data: { status: 'available', completedAt: 1, modelId: session.model, providerId: 'openai', inputTokens: 1000, contextWindow: 100_000 } }),
      trace: async () => ({ ok: true, data: { trace: { schemaVersion: 1, sessionId, turns: [], coverage: { modelCalls: 'none', turnsMissingModelCalls: [], unreadableRecords: 0, oversizedRuns: 0, turnsWithFewerModelCallsThanSteps: [] } }, nextCursor: null } }),
      summary: async () => ({ ok: true, data: {
        range: { from: 1, to: 2 }, totalRequests: 1, totalCostUsd: 0.002, totalDurationMs: 3400,
        totalTokens: { input: 1000, output: 120, cacheMiss: 400, cacheRead: 600, cacheWrite: 0, reasoning: 40, total: 1120 },
        cacheHitRequests: 1, cacheCreateRequests: 0, errorRequests: 0,
        provenance: { coverage: { attempts: 1, pricedAttempts: 1, unpricedAttempts: 0, usageReportedAttempts: 1, usagePartialAttempts: 0, usageMissingAttempts: 0 }, legacyRecords: 0, unreadableRecords: 0, pendingRepairs: 0 },
      } }),
      subscribeSessionEvents: () => () => {},
      subscribeUsageChanges: () => () => {},
    },
    retractQueueEntry: async () => {}, promoteQueueEntry: async () => {},
    updateQueueEntry: async () => {}, reorderQueueEntries: async () => {},
    enqueueMessage: async () => 'admitted',
    surface: 'workhub', initialLocale: 'zh-CN', subscribeAppearance: () => () => {},
    presentation: { ready: async () => {}, progressReady: async () => {}, resizeProgress: async () => {}, expandProgress: async () => {}, getSnapshot: async () => ({ placement: progress ? 'floating' : 'docked', floatingVisible: progress, progressRequest: progress ? 1 : undefined, shortcutRegistered: true, rendererCrashed: false }), setHost: async () => {}, setConversationLayout: async () => {}, detach: async () => {}, dock: async () => {}, hide: async () => {}, openSession: async (id) => { writes.open(id); }, subscribe: () => () => {}, onViewportInset: () => () => {}, onFocusComposer: () => () => {}, onOpenMain: () => () => {} },
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
    listActiveInteractions: async () => pendingForm ? [pendingForm] : questionPending ? [questionRequest] : [],
    subscribeActiveInteractions: (handler) => { interactionUpdate = handler; return () => { interactionUpdate = undefined; }; },
    respondToUserForm: async (id, response) => {
      writes.form(id, response);
      if (failures-- > 0) throw new Error('Temporary Host failure');
      const turnId = pendingForm!.turnId;
      pendingForm = undefined;
      interactionUpdate?.({ sessionId, interactions: [] });
      messages = [...messages, { type: 'turn_state', id: `${turnId}-done`, turnId, ts: 6, status: 'completed' }];
      publish();
    },
    respondToUserQuestion: async (id, response) => {
      writes.question(id, response);
      if (failures-- > 0) throw new Error('Temporary Host failure');
      questionPending = false;
      pendingForm = undefined;
      session = { ...session, runningTurnIds: [] }; updateSessions?.();
      interactionUpdate?.({ sessionId, interactions: [] });
      messages = [...messages, { type: 'assistant', id: 'question-answer', turnId: 'question-turn', ts: 3, modelId: 'model-a', text: '按公开测试安排发布。' }, { type: 'turn_state', id: 'question-complete', turnId: 'question-turn', ts: 4, status: 'completed' }];
      publish();
    },
    answer: async (id, input) => {
      writes.answer(id, input);
      if (selectTarget) {
        pendingForm = { type: 'form_request', id: `form-${input.turnId}`, requestId: `selection-${input.turnId}`, turnId: input.turnId,
          ts: 5, toolUseId: 'select-and-delegate', message: '选择要继续的工作', requester: { name: 'WorkHub' },
          fields: [{ kind: 'single_select', name: 'target', label: '工作 / 工作区', required: true,
            options: [{ value: 'candidate-0', label: '支付回调幂等性 / maka' }, { value: 'candidate-1', label: '发布检查清单 / desktop' }] }] };
        messages = [...messages, { type: 'user', id: input.turnId, turnId: input.turnId, ts: 4, text: input.text }];
        interactionUpdate?.({ sessionId, interactions: [pendingForm] });
        publish(); return { kind: 'admitted', turnId: input.turnId };
      }
      if (failures-- > 0) throw new Error('Temporary Host failure');
      messages = [...messages, { type: 'user', id: input.turnId, turnId: input.turnId, ts: 4, text: input.text, attachments: input.attachments }, { type: 'assistant', id: `${input.turnId}-answer`, turnId: input.turnId, ts: 5, modelId: 'model-a', text: '已收到。' }, { type: 'turn_state', id: `${input.turnId}-done`, turnId: input.turnId, ts: 6, status: 'completed' }];
      publish(); return { kind: 'admitted', turnId: input.turnId };
    },
    configureModel: async (id, input) => {
      writes.model(id, input); session = { ...session, revision: session.revision + 1, model: input.modelTarget.model, thinkingLevel: input.thinkingLevel ?? undefined }; updateSessions?.();
      return { kind: 'committed', session: { ...session, workspace: { target: { kind: 'host_path', path: '/projects/maka' }, hostCwd: '/projects/maka' }, createdAt: 0, activityAt: 0, labelsTruncated: false, llmConnectionId: 'connection-test', collaborationMode: 'agent', orchestrationMode: 'default' } };
    },
    observe: (_id, _event, _error, _phase, execution) => { updateExecution = execution; publishExecution(); return () => { updateExecution = undefined; }; },
    openTranscript: async (_id, handler) => { updateTranscript = handler; publish(); return { observationChanged: () => {}, prefetchHistory: async () => false, retain: () => {}, loadLatest: async () => {}, close: async () => { updateTranscript = undefined; } }; },
    stop: async () => {
      questionPending = false;
      pendingForm = undefined;
      session = { ...session, runningTurnIds: [] }; updateSessions?.();
      interactionUpdate?.({ sessionId, interactions: [] });
      messages = [...messages, { type: 'turn_state', id: 'question-abort', turnId: 'question-turn', ts: 4, status: 'aborted' }];
      publish(); return [];
    },

  };
}
function Surface({ failFirst = false, history = false, colors = false, selectTarget = false, question = false, progress = false }: { failFirst?: boolean; history?: boolean | 'usage'; colors?: boolean; selectTarget?: boolean; question?: boolean; progress?: boolean }) {
  const [progressHeight, setProgressHeight] = useState(112);
  const [services] = useState(() => {
    const services = makeServices(failFirst, history, colors, selectTarget, question, progress);
    // Storybook has no BrowserWindow: honor the production renderer's native
    // height request and use the native progress card's 360px width.
    if (progress) services.presentation.resizeProgress = async (_request, height) => { setProgressHeight(height); };
    return services;
  });
  const [workbarServices] = useState(() => createFakeWorkbarServices({ inspector: services.inspector }));
  return <LocaleProvider locale="zh-CN"><AstryxLocaleProvider><ToastProvider><WorkbarServicesProvider services={workbarServices}><WorkHubServicesProvider services={services}><div style={{ height: progress ? progressHeight : '100dvh', width: progress ? 360 : undefined, maxWidth: '100%' }}><WorkHubRoot workspace={WorkbarWorkspace} /></div></WorkHubServicesProvider></WorkbarServicesProvider></ToastProvider></AstryxLocaleProvider></LocaleProvider>;
}
const meta = { title: 'Product/WorkHub', parameters: { layout: 'fullscreen' }, beforeEach: () => {
  for (const key of Object.keys(localStorage)) if (key.startsWith('workhub:')) localStorage.removeItem(key);
} } satisfies Meta;
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
// Real path: WorkHub composer usage → the same Workbar used by ordinary sessions.
export const UsageInspector: Story = {
  render: () => <Surface history="usage" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/接下来会核对并发回调的处理结果/);
    const conversation = canvasElement.querySelector('.workhub-conversation-shell')!;
    const editor = canvasElement.querySelector('[contenteditable="true"]')!;
    await userEvent.click(editor);
    await userEvent.type(editor, '再检查一下并发回调。');
    const answer = canvas.getByText(/接下来会核对并发回调的处理结果/);
    const trigger = canvas.getByRole('button', { name: '打开用量追踪' });
    await userEvent.click(trigger);
    const close = await canvas.findByRole('button', { name: '收起任务工作栏' });
    const panel = close.closest('.maka-session-workbar')!;
    await waitFor(() => {
      const panelRect = panel.getBoundingClientRect();
      const mainRect = canvasElement.querySelector('.mainColumn')!.getBoundingClientRect();
      if (matchMedia('(max-width: 990px)').matches) expect(panelRect.top).toBeGreaterThanOrEqual(mainRect.bottom);
      else expect(panelRect.left).toBeGreaterThanOrEqual(mainRect.right);
    });
    expect(answer.isConnected).toBe(true);
    expect(conversation.isConnected).toBe(true);
    expect(editor).toHaveTextContent('再检查一下并发回调。');
    await userEvent.click(close);
    expect(answer.isConnected).toBe(true);
    expect(editor).toHaveTextContent('再检查一下并发回调。');
    await userEvent.click(canvas.getByRole('button', { name: '展开任务工作栏' }));
    await expect(canvas.findByRole('tab', { name: '追踪' })).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: '打开或关闭工作栏的面' }));
    const page = within(canvasElement.ownerDocument.body);
    for (const name of ['变更', '终端', '工作看板', '浏览器', '生成文件', '追踪', '侧边对话']) {
      await expect(page.findByRole('menuitem', { name })).resolves.toBeEnabled();
    }
    await userEvent.keyboard('{Escape}');
  },
};
// Real path: the docked WorkHub composer opens its model wheel before sending.
export const StandardComposer: Story = {
  render: () => <Surface />,
  play: async ({ canvasElement }) => {
    Object.values(writes).forEach((spy) => spy.mockClear());
    const canvas = within(canvasElement); const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(canvas.getByRole('button', { name: /切换当前任务模型/ })).toBeEnabled());
    await waitFor(() => expect(canvas.getByRole('button', { name: '打开用量追踪' }).textContent).toContain('1%'));
    const trigger = canvas.getByRole('button', { name: /切换当前任务模型/ });
    const layout = () => Array.from(canvasElement.querySelectorAll('.maka-composer-editor, .maka-composer button')).map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    });
    const before = layout();
    const anchor = trigger.getBoundingClientRect();
    await userEvent.click(trigger);
    const wheel = canvas.getByRole('listbox', { name: /切换当前任务模型/ });
    await waitFor(() => expect(wheel).toHaveFocus());
    expect(layout()).toEqual(before);
    expect(trigger).not.toBeVisible();
    const expanded = wheel.getBoundingClientRect();
    const center = Math.max(expanded.height / 2, Math.min(innerHeight - expanded.height / 2, (anchor.top + anchor.bottom) / 2));
    expect(Math.abs((expanded.top + expanded.bottom) / 2 - center)).toBeLessThanOrEqual(1);
    await expect(within(wheel).getByRole('option', { name: /model-a/, selected: true })).toBeInTheDocument();
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(writes.model).toHaveBeenCalledWith(sessionId, expect.objectContaining({ expectedRevision: 1, modelTarget: expect.objectContaining({ model: 'model-b' }) })));
    await waitFor(() => expect(within(wheel).getByRole('option', { name: /model-b/, selected: true })).toBeInTheDocument());
    expect(layout()).toEqual(before);
    await waitFor(() => {
      const selected = wheel.querySelector('[aria-selected="true"]')!.getBoundingClientRect();
      const viewport = wheel.getBoundingClientRect();
      expect(Math.abs((selected.top + selected.bottom - viewport.top - viewport.bottom) / 2)).toBeLessThanOrEqual(1);
    });
    const activeLabel = wheel.querySelector('[data-active="true"] .maka-model-wheel-label')!;
    const otherLabel = wheel.querySelector('[data-active="false"] .maka-model-wheel-label')!;
    await waitFor(() => expect(new DOMMatrix(getComputedStyle(activeLabel).transform).a).toBeGreaterThan(new DOMMatrix(getComputedStyle(otherLabel).transform).a));
    expect(getComputedStyle(wheel).outlineStyle).toBe('solid');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(layout()).toEqual(before);
    await userEvent.click(trigger);
    await waitFor(() => expect(canvas.getByRole('listbox')).toHaveFocus());
    await userEvent.tab();
    await waitFor(() => expect(canvas.queryByRole('listbox')).not.toBeInTheDocument());
    expect(canvasElement.ownerDocument.activeElement).not.toBe(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: '添加上下文' }));
    await userEvent.click(page.getByRole('menuitem', { name: /添加文件/ }));
    const editor = canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor); await userEvent.type(editor, 'Review requirements'); await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(writes.answer).toHaveBeenCalledWith(sessionId, expect.objectContaining({ text: 'Review requirements', attachments: [expect.objectContaining({ name: 'requirements.txt' })] })));
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-composer-attachment-token')).toHaveLength(0));
  },
};
// Real path: WorkHub composer → thinking level → choose an override or restore the default.
export const ThinkingLevelPicker: Story = {
  render: () => <Surface />,
  play: async ({ canvasElement }) => {
    Object.values(writes).forEach((spy) => spy.mockClear());
    const canvas = within(canvasElement); const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(canvas.getByRole('button', { name: '思考级别: 默认' })).toBeEnabled());
    const usage = canvas.getByRole('button', { name: '打开用量追踪' });
    await waitFor(() => expect(usage.textContent).toContain('1%'));
    await userEvent.click(usage);
    await userEvent.click(await canvas.findByRole('button', { name: '收起任务工作栏' }));
    await userEvent.click(canvas.getByRole('button', { name: '思考级别: 默认' }));
    await userEvent.click(page.getByRole('menuitemradio', { name: /^高$/ }));
    await waitFor(() => expect(canvas.getByRole('button', { name: '思考级别: 高' })).toBeEnabled());
    await expect(writes.model).toHaveBeenCalledWith(sessionId, expect.objectContaining({ thinkingLevel: 'high' }));
    await userEvent.click(canvas.getByRole('button', { name: '思考级别: 高' }));
    await userEvent.click(page.getByRole('menuitemradio', { name: /^默认$/ }));
    await waitFor(() => expect(canvas.getByRole('button', { name: '思考级别: 默认' })).toBeEnabled());
    await expect(writes.model).toHaveBeenLastCalledWith(sessionId, expect.objectContaining({ expectedRevision: 2, thinkingLevel: null }));
    await userEvent.click(canvas.getByRole('button', { name: '思考级别: 默认' }));
    await expect(page.getByRole('menuitemradio', { name: /^默认$/ })).toHaveAttribute('aria-checked', 'true');
  },
};
// Real path: a floating WorkHub progress card → edit its composer → open the model picker.
export const ProgressModelPicker: Story = {
  render: () => <Surface progress />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector('.workHubLive')).toHaveAttribute('data-progress', 'true'));
    const editor = canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor);
    await userEvent.type(editor, 'Keep this draft readable while choosing a model.');
    const trigger = await canvas.findByRole('button', { name: /切换当前任务模型/ });
    await userEvent.click(trigger);
    const wheel = await canvas.findByRole('listbox');
    await waitFor(() => expect(wheel).toHaveFocus());
    const surface = wheel.closest('.maka-model-wheel-expanded')!;
    const pixels = new OffscreenCanvas(1, 1).getContext('2d')!;
    pixels.fillStyle = getComputedStyle(surface).backgroundColor;
    pixels.fillRect(0, 0, 1, 1);
    expect(pixels.getImageData(0, 0, 1, 1).data[3]).toBeGreaterThanOrEqual(230);
    expect(pixels.getImageData(0, 0, 1, 1).data[3]).toBeLessThan(255);
    expect(editor).toHaveTextContent('Keep this draft readable while choosing a model.');
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

// Real path: WorkHub with delegated Turns from two ordinary Sessions and asynchronously read execution feedback.
export const ColoredWorkHistory: Story = {
  render: () => <Surface history colors />,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelectorAll('[data-turn-accent="true"]')).toHaveLength(3));
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-user-message .workhub-message-rail')).toHaveLength(3));
    const turns = canvasElement.querySelectorAll<HTMLElement>('[data-turn-accent="true"]');
    const stripeColor = (turn: HTMLElement) => getComputedStyle(turn.querySelector('.maka-user-message .workhub-message-rail')!, '::before').backgroundColor;
    expect(stripeColor(turns[0]!)).toBe(stripeColor(turns[2]!));
    expect(stripeColor(turns[0]!)).not.toBe(stripeColor(turns[1]!));
    expect(turns[0]!.querySelector('.workhub-turn-label')).toHaveTextContent('maka / 支付回调幂等性');
    expect(turns[1]!.querySelector('.workhub-turn-label')).toHaveTextContent('desktop / 发布检查清单');
    expect(canvasElement.querySelector('[data-transcript-turn-id="unlinked-turn"]')).not.toHaveAttribute('data-turn-accent');
    for (const [index, turn] of turns.entries()) {
      expect(turn.querySelectorAll('.workhub-turn-label')).toHaveLength(2);
      const status = turn.querySelector('.maka-user-message .workhub-delegation-status')!;
      await waitFor(() => expect(status).toHaveTextContent(['已完成', '等待用户', '进行中'][index]!));
      expect(turn.querySelector('.maka-assistant-answer .workhub-delegation-status')).toBeNull();
      expect(canvasElement.querySelector('.workhub-result-card')).toBeNull();
      expect(getComputedStyle(turn.querySelector('.workhub-turn-label span')!).fontSize).toBe('11px');
      const prompt = getComputedStyle(turn.querySelector('.maka-user-message')!);
      const answer = getComputedStyle(turn.querySelector('.maka-assistant-answer')!);
      expect(prompt.borderRightWidth).toBe('4px');
      expect(prompt.borderLeftWidth).toBe('0px');
      expect(answer.borderLeftWidth).toBe('4px');
      expect(answer.borderRightWidth).toBe('0px');
      expect(getComputedStyle(turn).borderLeftWidth).toBe('0px');
      // The icon-button's square aspect must not shrink the full-height hit
      // target. The sender-side bar must also reach the message's outer edge.
      for (const sender of ['user', 'assistant']) {
        const message = turn.querySelector<HTMLElement>(`.maka-${sender === 'user' ? 'user-message' : 'assistant-answer'}`)!;
        const rail = message.querySelector<HTMLElement>('.workhub-message-rail')!;
        const bounds = message.getBoundingClientRect();
        const hit = rail.getBoundingClientRect();
        expect(Math.abs(hit.height - bounds.height)).toBeLessThan(1);
        expect(Math.abs(sender === 'user' ? hit.right - bounds.right : hit.left - bounds.left)).toBeLessThan(1);
      }
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

// Real path: WorkHub asks its Host to select_and_delegate; the admitted Turn publishes a pending single-select Form.
export const TargetSelection: Story = {
  render: () => <Surface selectTarget />,
  play: async ({ canvasElement }) => {
    const editor = canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor);
    await userEvent.type(editor, '继续支付相关的工作，把异常场景补齐。');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvasElement.querySelector('.maka-form-interaction-prompt')).toBeInTheDocument());
    expect(canvasElement.querySelector('.maka-turn-processing')).toBeNull();
    expect(canvasElement.querySelector('.workhub-delegation-status')).toHaveTextContent('等待');
  },
};

// Real path: In the same Host Form, confirm a target with digits/Enter, then cancel another request with Escape.
export const KeyboardTargetSelection: Story = {
  render: () => <Surface selectTarget />,
  play: async (context) => {
    Object.values(writes).forEach((spy) => spy.mockClear());
    await TargetSelection.play!(context);
    await userEvent.keyboard('2{Enter}');
    await waitFor(() => expect(writes.form).toHaveBeenCalledWith(sessionId, expect.objectContaining({ action: 'accept', values: { target: 'candidate-1' } })));
    const editor = context.canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    await waitFor(() => expect(context.canvasElement.querySelector('.maka-form-interaction-prompt')).toBeNull());
    await userEvent.click(editor); await userEvent.type(editor, '需要进一步说明'); await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(context.canvasElement.querySelector('.maka-form-interaction-prompt')).toBeInTheDocument());
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await waitFor(() => expect(within(context.canvasElement).getAllByRole('radio')[1]).toBeChecked());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(context.canvasElement.querySelector('.maka-form-interaction-prompt')).toBeNull());
    expect(writes.form).toHaveBeenLastCalledWith(sessionId, expect.objectContaining({ action: 'cancel' }));
    expect(writes.answer).toHaveBeenCalledTimes(2);
  },
};

// Real path: A pending Host Form stays visible with its choice after a transport failure; the same response can be retried.
export const TargetSelectionFailure: Story = {
  render: () => <Surface selectTarget failFirst />,
  play: async (context) => {
    await TargetSelection.play!(context);
    await userEvent.keyboard('1{Enter}');
    await waitFor(() => expect(within(context.canvasElement).getByRole('alert')).toHaveTextContent('Temporary Host failure'));
    expect(context.canvasElement.querySelector('.maka-form-interaction-prompt')).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(context.canvasElement.querySelector('.maka-form-interaction-prompt')).toBeNull());
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
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(4));
    writes.open.mockClear();
    await userEvent.click(canvasElement.querySelector('.maka-user-message .workhub-message-rail') as HTMLElement);
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(2));
    expect(canvas.queryByText('请检查发布检查清单。')).toBeNull();
    expect(canvas.queryByText('先讨论一下整体计划。')).toBeNull();
    expect(canvas.getByText('继续补充异常场景。')).toBeInTheDocument();
    expect(writes.open).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole('button', { name: '显示全部对话' }));
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(4));
    const rail = canvasElement.querySelectorAll('.workhub-navigation-item')[1] as HTMLElement;
    await userEvent.click(rail);
    await waitFor(() => expect(canvasElement.querySelector('[data-search-highlight="true"]')).toHaveTextContent('请检查发布检查清单。'));
    expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(4);
    expect(writes.open).not.toHaveBeenCalled();
    await userEvent.click(rail);
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(1));
    expect(canvas.getByText('请检查发布检查清单。')).toBeInTheDocument();
    expect(writes.open).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole('button', { name: '显示全部对话' }));
    const answerRail = canvasElement.querySelector('.maka-assistant-answer .workhub-message-rail') as HTMLElement;
    answerRail.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(2));
    await userEvent.click(canvas.getByRole('button', { name: '显示全部对话' }));
    await userEvent.click(rail);
    await waitFor(() => expect(canvasElement.querySelector('[data-search-highlight="true"]')).toHaveTextContent('请检查发布检查清单。'));
    expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(4);
    (rail.querySelector('button') as HTMLButtonElement).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(1));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(4));
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
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(4));
    writes.open.mockClear();
    const transcriptElement = canvasElement.querySelector('[data-turn-source-count]');
    const stripe = () => canvasElement.querySelector('.maka-user-message .workhub-message-rail') as HTMLElement;
    const color = () => getComputedStyle(stripe(), '::before').backgroundColor;
    const original = color();
    const originalWidth = stripe().getBoundingClientRect().width;
    const paint = () => getComputedStyle(stripe(), '::before');
    expect(paint().width).toBe('4px');
    expect(parseFloat(paint().borderTopLeftRadius)).toBeGreaterThan(0);
    await userEvent.hover(stripe());
    await waitFor(() => expect(color()).not.toBe(original));
    await waitFor(() => expect(paint().transform).toBe('matrix(1.5, 0, 0, 1, 0, 0)'));
    expect(getComputedStyle(stripe()).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(stripe().getBoundingClientRect().width).toBe(originalWidth);
    expect(canvasElement.querySelector('.maka-assistant-answer .workhub-message-rail')).toHaveAttribute('data-work-highlighted', 'true');
    expect(canvasElement.querySelector('.workhub-navigation-item')).toHaveAttribute('data-work-highlighted', 'true');
    await userEvent.unhover(stripe());
    await waitFor(() => expect(color()).toBe(original));
    await userEvent.click(stripe());
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(2));
    await userEvent.click(canvasElement.querySelector('.maka-assistant-answer .workhub-message-rail') as HTMLElement);
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(4));
    await userEvent.click(stripe());
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(2));
    await userEvent.click(canvasElement.querySelector('.workhub-navigation-item') as HTMLElement);
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(4));
    await userEvent.click(canvasElement.querySelector('.workhub-navigation-item') as HTMLElement);
    await userEvent.click(canvasElement.querySelector('.workhub-navigation-item') as HTMLElement);
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(2));
    await userEvent.click(canvasElement.querySelector('.workhub-navigation-item') as HTMLElement);
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(4));
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
