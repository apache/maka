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
import { ToastProvider, LocaleProvider, AstryxLocaleProvider } from '@maka/ui';
import type { StoredMessage, SessionSummary } from '@maka/core/session';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within, waitFor } from 'storybook/test';
import { WorkHubRoot, WorkHubServicesProvider, type WorkHubServices, type WorkHubTranscriptSnapshot } from '../src/renderer/features/workhub/index.js';
import { desktopSessionKey } from '../src/shared/runtime-host-identity.js';

// Real host: a persistent WebContentsView mounts WorkHubRoot once and moves between windows.
const sessionId = desktopSessionKey({ hostId: 'story-host', sessionId: 'maka_workhub_coordination' });
const targetId = desktopSessionKey({ hostId: 'story-host', sessionId: 'payments' });
const writes = { answer: fn(), model: fn(), upload: fn(), open: fn() };
const choices = ['model-a', 'model-b'].map((model, index) => ({
  connectionId: 'connection-test', connectionSlug: 'test', connectionName: 'Test', providerType: 'openai' as const,
  providerLabel: 'OpenAI', model, label: model, isDefault: index === 0, thinkingLevels: [],
}));
function makeServices(failFirst: boolean, withHistory: boolean): WorkHubServices {
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
  let updateTranscript: ((snapshot: WorkHubTranscriptSnapshot) => void) | undefined;
  let updateSessions: (() => void) | undefined;
  const publish = () => updateTranscript?.({ messages, hasOlder: false, hasNewer: false, ready: true });
  return {
    surface: 'workhub', initialLocale: 'zh-CN', subscribeAppearance: () => () => {},
    presentation: { ready: async () => {}, getSnapshot: async () => ({ placement: 'docked', floatingVisible: false, shortcutRegistered: true, rendererCrashed: false }), setHost: async () => {}, setConversationLayout: async () => {}, detach: async () => {}, dock: async () => {}, hide: async () => {}, openSession: async (id) => { writes.open(id); }, subscribe: () => () => {}, onFocusComposer: () => () => {}, onOpenMain: () => () => {} },
    control: { getSnapshot: async () => ({ revision: 0, phase: 'idle', canUndo: false }), subscribe: () => () => {}, stop: async () => {}, undo: async () => {} },
    resolve: async () => sessionId, subscribeHosts: () => () => {}, subscribeAvailability: () => () => {},
    getSession: async () => session,
    listSessions: async () => [target], subscribeSessions: (handler) => { updateSessions = handler; return () => { updateSessions = undefined; }; }, modelChoices: async () => choices,
    attachments: { pickFiles: async () => ({ ok: true, files: [{ approvalId: 'file-1', name: 'requirements.txt', size: 12, mimeType: 'text/plain' }] }), previewApproval: async () => ({ ok: false, reason: 'not-image' }) },
    readAttachmentBytes: async () => { throw new Error('Not an image'); },
    prepareAttachments: async (id, items) => { writes.upload(id, items); return [{ name: 'requirements.txt', kind: 'other', mimeType: 'text/plain', bytes: 12, ref: { kind: 'session_file', sessionId: 'maka_workhub_coordination', relativePath: 'artifact-1' } }]; },
    answer: async (id, input) => {
      writes.answer(id, input);
      if (failures-- > 0) throw new Error('Temporary Host failure');
      messages = [...messages, { type: 'user', id: input.turnId, turnId: input.turnId, ts: 4, text: input.text, attachments: input.attachments }, { type: 'assistant', id: `${input.turnId}-answer`, turnId: input.turnId, ts: 5, modelId: 'model-a', text: '已收到。' }, { type: 'turn_state', id: `${input.turnId}-done`, turnId: input.turnId, ts: 6, status: 'completed' }];
      publish(); return { kind: 'admitted', turnId: input.turnId };
    },
    configureModel: async (id, input) => {
      writes.model(id, input); session = { ...session, revision: session.revision + 1, model: input.modelTarget.model }; updateSessions?.();
      return { kind: 'committed', session: { ...session, workspace: { target: { kind: 'host_path', path: '/projects/maka' }, hostCwd: '/projects/maka' }, createdAt: 0, activityAt: 0, labelsTruncated: false, llmConnectionId: 'connection-test', collaborationMode: 'agent', orchestrationMode: 'default' } };
    },
    observe: () => () => {},
    openTranscript: async (_id, handler) => { updateTranscript = handler; publish(); return { observationChanged: () => {}, loadOlder: async () => {}, loadLatest: async () => {}, close: async () => { updateTranscript = undefined; } }; },
    stop: async () => {},
  };
}
function Surface({ failFirst = false, history = false }: { failFirst?: boolean; history?: boolean }) {
  const [services] = useState(() => makeServices(failFirst, history));
  return <LocaleProvider locale="zh-CN"><AstryxLocaleProvider><ToastProvider><WorkHubServicesProvider services={services}><div style={{ height: '100dvh' }}><WorkHubRoot /></div></WorkHubServicesProvider></ToastProvider></AstryxLocaleProvider></LocaleProvider>;
}
const meta = { title: 'Product/WorkHub', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const FullConversationAndWorkIdentity: Story = {
  render: () => <Surface history />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText(/END_OF_FULL_RESPONSE/)).toBeInTheDocument());
    await expect(canvasElement.querySelector('.workhub-message-identity')).toHaveAttribute('data-work-session-id', targetId);
    const navigation = canvasElement.querySelector('.workhub-navigation-item') as HTMLElement;
    await userEvent.hover(navigation);
    await waitFor(() => expect(canvasElement.querySelector('.workhub-message-identity')).toHaveAttribute('data-work-highlighted', 'true'));
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
    await userEvent.click(page.getByRole('menuitemradio', { name: 'model-b' }));
    await waitFor(() => expect(writes.model).toHaveBeenCalledWith(sessionId, expect.objectContaining({ expectedRevision: 1, modelTarget: expect.objectContaining({ model: 'model-b' }) })));
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
