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
import { desktopSessionKey } from '../src/shared/runtime-host-identity.js';

// Real host: a persistent WebContentsView mounts WorkHubRoot once and moves between windows.
const sessionId = desktopSessionKey({ hostId: 'story-host', sessionId: 'maka_workhub_coordination' });
const targetId = desktopSessionKey({ hostId: 'story-host', sessionId: 'payments' });
const writes = { panel: fn(), answer: fn(), model: fn(), upload: fn(), open: fn(), question: fn(), form: fn() };
const choices = ['model-a', 'model-b'].map((model, index) => ({
  connectionId: 'connection-test', connectionSlug: 'test', connectionName: 'Test', providerType: 'openai' as const,
  providerLabel: 'OpenAI', model, label: model, contextWindow: 100_000, isDefault: index === 0, thinkingLevels: ['low', 'high'] as ThinkingLevel[],
}));
const repairChoices = [
  ['coding-plan', 'Coding Plan', 'qwen3.8-32b', 'Qwen 3.8 32B'],
  ['deepseek', 'DeepSeek', 'deepseek-v4-pro', 'DeepSeek V4 Pro'],
  ['anthropic', 'Anthropic', 'claude-sonnet-4.5', 'Claude Sonnet 4.5'],
  ['openai', 'OpenAI', 'gpt-5.4', 'GPT-5.4'],
  ['google', 'Google', 'gemini-3-pro', 'Gemini 3 Pro'],
  ['moonshot', 'Moonshot', 'kimi-k2.5', 'Kimi K2.5'],
].map(([connectionSlug, connectionName, model, label], index) => ({
  connectionId: `connection-${connectionSlug}`, connectionSlug, connectionName,
  providerType: 'openai' as const, providerLabel: connectionName, model, label,
  contextWindow: 100_000, isDefault: index === 0, thinkingLevels: [] as ThinkingLevel[],
}));
function makeServices(failFirst: boolean, withHistory: boolean | 'usage', coloredHistory: boolean, selectTarget = false, question = false, progress = false, repairModel = false): WorkHubServices {
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
  const publish = () => { publishExecution(); updateTranscript?.({ messages, hasOlder: false, ready: true }); };
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
    presentation: { ready: async () => {}, progressReady: async () => {}, resizeProgress: async () => {}, expandProgress: async () => {}, getSnapshot: async () => ({ placement: progress ? 'floating' : 'docked', floatingVisible: progress, progressRequest: progress ? 1 : undefined, shortcutRegistered: true, rendererCrashed: false, workbar: { collapsed: true, placement: 'right' } }), setHost: async () => {}, setConversationLayout: async () => {}, detach: async () => {}, dock: async () => {}, hide: async () => {}, openUsage: async () => { writes.panel('inspector'); }, toggleWorkbar: async () => { writes.panel('toggle'); }, openSession: async (id) => { writes.open(id); }, openSettings: async () => {}, subscribe: () => () => {}, onViewportInset: () => () => {}, onFocusComposer: () => () => {}, onOpenMain: () => () => {} },
    control: { getSnapshot: async () => ({ revision: 0, phase: 'idle', canUndo: false }), subscribe: () => () => {}, stop: async () => {}, undo: async () => {} },
    bindBrowserSession: () => {},
    resolve: async () => sessionId, subscribeHosts: () => () => {}, subscribeAvailability: () => () => {},
    getSession: async () => session,
    listSessions: async () => coloredHistory ? [target, secondTarget] : [target], subscribeSessions: (handler) => { updateSessions = handler; return () => { updateSessions = undefined; }; }, modelChoices: async () => repairModel ? repairChoices : choices,
    setDefaultModel: async () => {},
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
      if (selectTarget || repairModel) {
        pendingForm = { type: 'form_request', id: `form-${input.turnId}`, requestId: `selection-${input.turnId}`, turnId: input.turnId,
          ts: 5, toolUseId: repairModel ? 'repair-target-model' : 'select-and-delegate',
          message: repairModel
            ? '任务“支付回调幂等性”使用的模型“qwen3.8-27b-sglang”已不可用。请选择替代模型以继续。'
            : '选择要继续的工作', requester: { name: 'WorkHub' },
          fields: [repairModel
            ? { kind: 'string', name: 'targetModel', label: '替代模型', required: true, presentation: 'model_picker', minLength: 1 }
            : { kind: 'single_select', name: 'target', label: '工作 / 工作区', required: true,
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
    openTranscript: async (_id, handler) => { updateTranscript = handler; publish(); return { observationChanged: () => {}, loadEarlier: async () => {}, close: async () => { updateTranscript = undefined; } }; },
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
function Surface({ failFirst = false, history = false, colors = false, selectTarget = false, question = false, progress = false, repairModel = false }: { failFirst?: boolean; history?: boolean | 'usage'; colors?: boolean; selectTarget?: boolean; question?: boolean; progress?: boolean; repairModel?: boolean }) {
  const [progressHeight, setProgressHeight] = useState(112);
  const [services] = useState(() => {
    const services = makeServices(failFirst, history, colors, selectTarget, question, progress, repairModel);
    // Storybook has no BrowserWindow: honor the production renderer's native
    // height request and use the native progress card's 360px width.
    if (progress) services.presentation.resizeProgress = async (_request, height) => { setProgressHeight(height); };
    return services;
  });
  return <LocaleProvider locale="zh-CN"><AstryxLocaleProvider><ToastProvider><WorkHubServicesProvider services={services}><div style={{ height: progress ? progressHeight : '100dvh', width: progress ? 360 : undefined, maxWidth: '100%' }}><WorkHubRoot /></div></WorkHubServicesProvider></ToastProvider></AstryxLocaleProvider></LocaleProvider>;
}
const meta = { title: 'Product/WorkHub', parameters: { layout: 'fullscreen' }, beforeEach: () => {
  Object.values(writes).forEach((spy) => spy.mockClear());
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
    const trigger = canvas.getByRole('button', { name: '打开用量追踪' });
    await userEvent.click(trigger);
    await waitFor(() => expect(writes.panel).toHaveBeenCalledWith('inspector'));
    expect(canvasElement.querySelector('.maka-session-workbar')).toBeNull();
    expect(canvas.getByText(/接下来会核对并发回调的处理结果/)).toBeVisible();
    expect(conversation.isConnected).toBe(true);
    expect(editor).toHaveTextContent('再检查一下并发回调。');
  },
};
// Real path: the docked WorkHub composer opens its model picker before sending.
export const StandardComposer: Story = {
  render: () => <Surface />,
  play: async ({ canvasElement }) => {
    Object.values(writes).forEach((spy) => spy.mockClear());
    const canvas = within(canvasElement); const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(canvas.getByRole('button', { name: /切换当前任务模型/ })).toBeEnabled());
    await waitFor(() => expect(canvas.getByRole('button', { name: '打开用量追踪' }).textContent).toContain('1%'));
    await userEvent.click(canvas.getByRole('button', { name: /切换当前任务模型/ }));
    await userEvent.click(page.getByRole('option', { name: /model-b/ }));
    await waitFor(() => expect(writes.model).toHaveBeenCalledWith(sessionId, expect.objectContaining({ expectedRevision: 1, modelTarget: expect.objectContaining({ model: 'model-b' }) })));
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
    await waitFor(() => expect(canvas.getByRole('combobox', { name: '思考级别: 默认' })).toBeEnabled());
    const usage = canvas.getByRole('button', { name: '打开用量追踪' });
    await waitFor(() => expect(usage.textContent).toContain('1%'));
    await userEvent.click(canvas.getByRole('combobox', { name: '思考级别: 默认' }));
    await userEvent.click(page.getByRole('option', { name: /^高$/ }));
    await waitFor(() => expect(canvas.getByRole('combobox', { name: '思考级别: 高' })).toBeEnabled());
    await expect(writes.model).toHaveBeenCalledWith(sessionId, expect.objectContaining({ thinkingLevel: 'high' }));
    await userEvent.click(canvas.getByRole('combobox', { name: '思考级别: 高' }));
    await userEvent.click(page.getByRole('option', { name: /^默认$/ }));
    await waitFor(() => expect(canvas.getByRole('combobox', { name: '思考级别: 默认' })).toBeEnabled());
    await expect(writes.model).toHaveBeenLastCalledWith(sessionId, expect.objectContaining({ expectedRevision: 2, thinkingLevel: null }));
    await userEvent.click(canvas.getByRole('combobox', { name: '思考级别: 默认' }));
    await expect(page.getByRole('option', { name: /^默认$/ })).toHaveAttribute('aria-selected', 'true');
  },
};
// Real path: a floating WorkHub progress card → edit its composer → open the model picker.
export const ProgressModelPicker: Story = {
  render: () => <Surface progress />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector('.workHubLive')).toHaveAttribute('data-progress', 'true'));
    expect(canvas.queryByRole('combobox', { name: /思考级别/ })).toBeNull();
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

// The docked renderer reserves distinct targets for prompt navigation and the
// Workbar edge. Measure those targets rather than a platform scrollbar width.
async function expectPromptRailClearance(canvasElement: HTMLElement) {
  await waitFor(() => {
    const rail = canvasElement.querySelector<HTMLElement>('.maka-prompt-rail')!;
    expect(rail).toBeVisible();
    const box = rail.getBoundingClientRect();
    const edge = canvasElement.querySelector('.maka-workbar-edge')!.getBoundingClientRect();
    const scroller = canvasElement.querySelector('[data-chat-scroll-container]')!.getBoundingClientRect();
    const composer = canvasElement.querySelector('.maka-composer')!.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);
    expect(box.right).toBeLessThan(edge.left);
    expect(box.top).toBeGreaterThanOrEqual(scroller.top);
    expect(box.bottom).toBeLessThanOrEqual(composer.top);
    const ticks = rail.querySelectorAll<HTMLElement>('[data-prompt-turn-id]');
    expect(ticks).toHaveLength(4);
    for (const tick of ticks) {
      const hit = tick.getBoundingClientRect();
      expect(tick.contains(document.elementFromPoint(hit.x + hit.width / 2, hit.y + hit.height / 2))).toBe(true);
    }
    const body = canvasElement.querySelector('.workhub-body')!;
    expect(body.scrollWidth - body.clientWidth).toBeLessThanOrEqual(1);
  });
  // At full desktop width, WorkHub must reach the same shared reading measure
  // as Sessions; applying transcript gutters twice makes this narrower.
  if (window.innerWidth >= 1600) {
    // The rail settles before the virtualized transcript mounts its rows.
    await waitFor(() => expect(canvasElement.querySelector('.maka-turn')).not.toBeNull());
    const turn = canvasElement.querySelector('.maka-turn')!;
    const measure = document.createElement('div');
    measure.style.cssText = 'position: absolute; visibility: hidden; height: 0; width: var(--maka-reading-measure)';
    turn.append(measure);
    const readingWidth = measure.getBoundingClientRect().width;
    measure.remove();
    expect(Math.abs(turn.getBoundingClientRect().width - readingWidth)).toBeLessThanOrEqual(1);
  }
}

// Real path: WorkHub with delegated Turns from two ordinary Sessions and asynchronously read execution feedback.
export const ColoredWorkHistory: Story = {
  render: () => <Surface history colors />,
  play: async ({ canvasElement }) => {
    await expectPromptRailClearance(canvasElement);
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

// Real path: a selected target's saved model disappeared, so WorkHub asks before changing that Session and delegating.
export const TargetModelRepair: Story = {
  render: () => <Surface repairModel />,
  play: async ({ canvasElement }) => {
    const editor = canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor);
    await userEvent.type(editor, '继续支付回调幂等性，补充重复投递测试点。');
    await userEvent.keyboard('{Enter}');
    const prompt = await within(canvasElement).findByText(/qwen3\.8-27b-sglang.*已不可用/);
    expect(prompt).toBeVisible();
    await userEvent.click(within(canvasElement).getByRole('button', { name: '替代模型' }));
    const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(page.getByRole('listbox', { name: '替代模型' })).toBeVisible());
    await waitFor(() => expect(page.getByRole('option', { name: /Qwen 3.8 32B/ })).toBeVisible());
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
    const formPrompt = context.canvasElement.querySelector('.maka-form-interaction-prompt') as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(formPrompt.querySelector('.maka-choice-panel')));
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await waitFor(() => expect(within(formPrompt).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true'));
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

// Real path: WorkHub asks its Host a question; the first response fails on the
// wire, the selection survives, and Enter retries to completion.
export const QuestionLifecycle: Story = {
  render: () => <Surface question failFirst />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('heading', { name: '首批发布范围选哪个？' })).toBeInTheDocument());
    expect(canvasElement.querySelector('.workhub-delegation-status')).toHaveTextContent('等待');
    expect(canvasElement.querySelector('.maka-turn-processing')).toBeNull();
    // The panel's digit/Enter shortcuts live on its own keydown, so focus must
    // have landed there before keys are sent.
    const prompt = canvasElement.querySelector('.maka-user-question-prompt') as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(prompt.querySelector('.maka-choice-panel')));
    await userEvent.keyboard('2{Enter}');
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent('Temporary Host failure'));
    await waitFor(() => expect(within(prompt).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true'));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvasElement.querySelector('.maka-user-question-prompt')).toBeNull());
    expect(canvasElement.querySelector('.workhub-delegation-status')).toHaveTextContent('已完成');
    expect(canvas.getByText('按公开测试安排发布。')).toBeInTheDocument();
    expect(writes.question).toHaveBeenLastCalledWith(sessionId, expect.objectContaining({ requestId: 'question-request' }));
  },
};

// Real path: WorkHub asks its Host a question; the prompt stays in the composer slot until answered or stopped.
export const QuestionPending: Story = {
  render: () => <Surface question />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('heading', { name: '首批发布范围选哪个？' })).toBeInTheDocument());
    expect(canvasElement.querySelector('.workhub-delegation-status')).toHaveTextContent('等待');
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
    await expectPromptRailClearance(canvasElement);
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
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(4));
    const answerRail = canvasElement.querySelector('.maka-assistant-answer .workhub-message-rail') as HTMLElement;
    answerRail.focus();
    expect(answerRail).toHaveFocus();
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
        hasEarlierHistory={!loaded} onLoadEarlierHistory={() => setLoaded(true)}
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
    await userEvent.click(canvas.getByRole('button', { name: '载入更早的记录' }));
    await waitFor(() => expect(canvas.getByText('请检查支付回调幂等性。')).toBeInTheDocument());
    expect(canvas.queryByText('先讨论一下整体计划。')).toBeNull();
    expect(canvas.queryByRole('button', { name: '载入更早的记录' })).toBeNull();
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
