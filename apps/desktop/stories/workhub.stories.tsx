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

import { ToastProvider } from '@maka/ui';
import { useState } from 'react';
import type { SessionSummary } from '@maka/core/session';
import { WorkHubComposerServicesProvider } from '../src/renderer/features/workhub/index.js';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within, waitFor } from 'storybook/test';
import { WorkHubCoordinationFailure } from '../src/renderer/workhub-controller';
import type {
  WorkHubController,
  WorkHubCoordinationTurn,
  WorkHubProjection,
} from '../src/renderer/workhub-controller';
import { WorkHubSurface } from '../src/renderer/workhub-surface';

// Fidelity convention (#1433): every story names the real app path that
// reaches it. See apps/desktop/stories/FIDELITY.md.
//
// Real host: app-shell.tsx mounts <WorkHubSurface> in the conversation column
// when WorkHub is enabled and a Coordination Session exists. The surface takes
// its `controller` as a prop — the same seam production fills with
// `createWorkHubController` — so a story serves one pinned projection and
// conversation instead of driving a live Coordination Session.

const TARGET_SESSION_ID = 'session-workhub-target';
const SESSION_NAME = '支付回调幂等性';
const PROJECT_NAME = 'maka-agent';
const LOCALE = 'zh-CN';

const meta = {
  title: 'Product/WorkHub',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function submittedTurn(): WorkHubCoordinationTurn {
  return {
    messageId: 'message-1',
    turnId: 'turn-1',
    text: `继续${SESSION_NAME}，补充重复投递测试点。`,
    state: 'running',
    assignment: {
      actionId: 'action-1',
      delegationId: 'delegation-1',
      targetSessionId: TARGET_SESSION_ID,
      targetSessionName: SESSION_NAME,
      targetMessageId: 'target-message-1',
      targetTurnId: 'target-turn-1',
      feedbackState: 'running',
      linkState: 'active',
    },
    updatedAt: 1,
  };
}

function projection(): WorkHubProjection {
  return {
    sessions: [
      {
        target: { sessionId: TARGET_SESSION_ID },
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        archived: false,
        state: 'running',
        updatedAt: 1,
      },
    ],
    turns: [],
  };
}

function controller(turns: readonly WorkHubCoordinationTurn[]): WorkHubController {
  return {
    read: async () => projection(),
    submit: async () => {
      throw new Error('submission is not part of these stories');
    },
    openConversation: async (handler) => {
      handler(turns);
      return { close: async () => {} };
    },
    requestClarification: async ({ turnId }) => ({ turnId }),
    subscribe: () => () => {},
    resetVisitContext: () => {},
  };
}

const openRailSession = fn();

function Surface(props: { turns: readonly WorkHubCoordinationTurn[]; onOpenSession?: (sessionId: string) => void; fixture?: WorkHubController }) {
  return (
    <div className="maka-detail-with-artifacts" style={{ height: '100dvh' }}>
      <div className="mainColumn">
        <WorkHubSurface
          controller={props.fixture ?? controller(props.turns)}
          leaseScope="session-workhub-coordination"
          locale={LOCALE}
          onOpenSession={props.onOpenSession ?? (() => {})}
        />
      </div>
    </div>
  );
}

// Real path: WorkHub routed a prompt to an existing Session and reports where
// the work went. The target's project name is a `<small>` inside the Button's
// own label column, so it has to stay inside the control's box: a project name
// that overflows the button reads as loose text under an unrelated row.
export const SubmittedWorkKeepsTargetMetadataInside: Story = {
  render: () => <Surface turns={[submittedTurn()]} />,
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(canvasElement.querySelector('.workhub-submitted-session small')).not.toBeNull();
    });
    const button = canvasElement.querySelector<HTMLElement>('.workhub-submitted > button');
    const project = canvasElement.querySelector<HTMLElement>('.workhub-submitted-session small');
    if (!button || !project) throw new Error('submitted work control is missing');

    expect(project.textContent).toBe(PROJECT_NAME);
    expect(button.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(
      project.getBoundingClientRect().bottom,
    );

    // #4914: WorkHub's conversation is one surface — the user bubble rounds
    // like the composer plate beneath it, both resolving Astryx's
    // `--radius-chat`. `density="compact"` on WorkHub's chat primitives had
    // pinned the bubble to `--radius-container` (12px) while the composer
    // stayed 28px, splitting a transcript and a dock on the same surface by
    // more than 2x. Compared against the real composer plate, not a literal,
    // so an upstream `--radius-chat` change moves both or fails here.
    const bubble = canvasElement.querySelector<HTMLElement>(
      '.workhub-projected-turn .workhub-user-bubble',
    );
    const plate = canvasElement.querySelector('.maka-composer-astryx')?.firstElementChild;
    if (!bubble || !plate) throw new Error('WorkHub bubble or composer plate is missing');
    const bubbleRadius = getComputedStyle(bubble).borderTopLeftRadius;
    expect(bubbleRadius).not.toBe('0px');
    expect(bubbleRadius).toBe(getComputedStyle(plate).borderTopLeftRadius);
  },
};

// Real path: the production WorkHubSurface derives the Rail from Session facts.
// Filtering and responsive geometry need a renderer, not an Electron/Host fixture.
const anchorRailPlay: NonNullable<Story['play']> = async ({ canvasElement }) => {
  openRailSession.mockClear();
  const canvas = within(canvasElement);
  const rail = await canvas.findByRole('complementary', { name: '工作导航' });
  const navigation = within(rail);
  await expect(await navigation.findByRole('button', { name: new RegExp(SESSION_NAME) })).toBeVisible();
  const sessionEntry = navigation.getByRole('button', { name: new RegExp(SESSION_NAME) });
  await userEvent.click(sessionEntry);
  await expect(openRailSession).toHaveBeenCalledTimes(1);
  await expect(openRailSession).toHaveBeenLastCalledWith('session-workhub-target');
  sessionEntry.focus();
  await userEvent.keyboard('{Enter}');
  await expect(openRailSession).toHaveBeenCalledTimes(2);
  await expect(openRailSession).toHaveBeenLastCalledWith('session-workhub-target');
  await userEvent.click(navigation.getByRole('button', { name: '待处理' }));
  await expect(navigation.getByText('此筛选下没有工作')).toBeVisible();
  await expect(navigation.queryByRole('button', { name: new RegExp(SESSION_NAME) })).toBeNull();
  await userEvent.click(navigation.getByRole('button', { name: '全部' }));
  await expect(await navigation.findByRole('button', { name: new RegExp(SESSION_NAME) })).toBeVisible();
  const conversation = canvasElement.querySelector<HTMLElement>('.workhub-conversation-shell');
  const composer = canvasElement.querySelector<HTMLElement>('.workhub-surface .maka-composer-editor');
  if (!conversation || !composer) throw new Error('WorkHub conversation or composer missing');
  const railBox = rail.getBoundingClientRect();
  const conversationBox = conversation.getBoundingClientRect();
  const composerBox = composer.getBoundingClientRect();
  if (window.innerWidth <= 1240) {
    expect(railBox.bottom).toBeLessThanOrEqual(conversationBox.top + 1);
  } else {
    expect(railBox.right).toBeLessThanOrEqual(conversationBox.left);
    expect(Math.abs(composerBox.left + composerBox.width / 2 -
      (conversationBox.left + conversationBox.width / 2))).toBeLessThanOrEqual(4);
  }
};

export const AnchorRailFiltersAndReflows: Story = {
  render: () => <Surface turns={[submittedTurn()]} onOpenSession={openRailSession} />,
  play: anchorRailPlay,
};

// The render smoke runner selects its narrow viewport from this story ID.
export const AnchorRailFiltersAndReflowsNarrow: Story = {
  ...AnchorRailFiltersAndReflows,
};

// Production scroll container and message frames: enough real turns to require
// scrolling, with two messages sharing a Turn ID to exercise message identity.
const promptRailTurns: WorkHubCoordinationTurn[] = Array.from({ length: 14 }, (_, index) => ({
  messageId: `prompt-${index}`,
  turnId: `conversation-${Math.floor(index / 2)}`,
  text: `第 ${index + 1} 次讨论：支付回调的并发与重试`,
  result: '已检查当前处理路径。需要同时覆盖重复投递、并发请求和失败后的重试，确认每个请求只产生一次业务变更。',
  state: 'completed',
  updatedAt: index,
}));

let publishPromptTurns: (turns: readonly WorkHubCoordinationTurn[]) => void = () => {};
const promptController: WorkHubController = {
  ...controller(promptRailTurns),
  openConversation: async (handler) => {
    publishPromptTurns = handler;
    handler(promptRailTurns);
    return { close: async () => { publishPromptTurns = () => {}; } };
  },
};

const promptRailPlay: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const root = canvasElement.querySelector<HTMLElement>('[data-chat-scroll-container]');
  if (!root) throw new Error('WorkHub scroll container missing');
  await waitFor(() => expect(canvasElement.querySelectorAll('.maka-prompt-rail-tick')).toHaveLength(14));
  await waitFor(() => expect(canvasElement.querySelectorAll('.workhub-turn[data-turn-id]')).toHaveLength(14));
  const ticks = Array.from(canvasElement.querySelectorAll<HTMLButtonElement>('.maka-prompt-rail-tick'));
  const frames = Array.from(canvasElement.querySelectorAll<HTMLElement>('.workhub-turn[data-turn-id]'));
  expect(new Set(frames.map((frame) => frame.dataset.turnId)).size).toBe(14);
  expect(root.scrollHeight).toBeGreaterThan(root.clientHeight);
  await userEvent.click(ticks[0]!);
  await waitFor(() => {
    expect(ticks[0]).toHaveAttribute('aria-current', 'true');
    expect(Math.abs(frames[0]!.getBoundingClientRect().top - root.getBoundingClientRect().top)).toBeLessThan(4);
  });
  const navigation = within(await within(canvasElement).findByRole('complementary', { name: '工作导航' }));
  await userEvent.click(navigation.getByRole('button', { name: '待处理' }));
  expect(canvasElement.querySelectorAll('.maka-prompt-rail-tick')).toHaveLength(14);
  await userEvent.click(navigation.getByRole('button', { name: '全部' }));
  ticks[6]!.focus();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => {
    expect(ticks[6]).toHaveAttribute('aria-current', 'true');
    expect(Math.abs(frames[6]!.getBoundingClientRect().top - root.getBoundingClientRect().top)).toBeLessThan(4);
  });
  // A reader wheel gesture releases the shared rail's short jump hold.
  root.dispatchEvent(new WheelEvent('wheel', { deltaY: root.scrollHeight, bubbles: true }));
  root.scrollTo({ top: root.scrollHeight, behavior: 'instant' });
  await waitFor(() => expect(ticks[13]).toHaveAttribute('aria-current', 'true'));
  // Leave a middle prompt selected for visual evidence of the rail and target.
  await userEvent.click(ticks[6]!);
  await waitFor(() => expect(ticks[6]).toHaveAttribute('aria-current', 'true'));
  // Simulate ordinary Coordination transcript updates while the reader is
  // inspecting an earlier message: growth must not pull them back to the tail.
  for (let chunk = 1; chunk <= 3; chunk += 1) {
    publishPromptTurns(promptRailTurns.map((turn, index) => index === 13
      ? { ...turn, state: 'running', result: `${turn.result}\n${'新增流式结果。'.repeat(chunk * 80)}` }
      : turn));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await waitFor(() => {
      expect(ticks[6]).toHaveAttribute('aria-current', 'true');
      expect(Math.abs(frames[6]!.getBoundingClientRect().top - root.getBoundingClientRect().top)).toBeLessThan(4);
    });
  }
};

export const ConversationPromptAnchors: Story = {
  render: () => <Surface turns={promptRailTurns} fixture={promptController} />,
  play: promptRailPlay,
};

export const ConversationPromptAnchorsNarrow: Story = {
  ...ConversationPromptAnchors,
};

// Repeated messages for one work must highlight together, independently of
// intervening work. This is the same durable assignment seam as production.
export const WorkIdentityAcrossTurns: Story = {
  render: () => {
    const first = submittedTurn();
    const other: WorkHubCoordinationTurn = {
      ...first, messageId: 'other-message', turnId: 'other-turn',
      text: '检查另一个工作的界面布局。',
      assignment: { ...first.assignment!, targetSessionId: 'other-work', targetSessionName: '界面布局' },
    };
    const followup = { ...first, messageId: 'followup-message', turnId: 'followup-turn', text: '继续支付回调，检查失败重试。' };
    return <Surface turns={[first, other, followup]} />;
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelectorAll('.workhub-bound-turn')).toHaveLength(3));
    const turns = Array.from(canvasElement.querySelectorAll<HTMLElement>('.workhub-bound-turn'));
    const rail = turns[0]!.querySelector<HTMLElement>('.workhub-work-rail')!;
    await userEvent.hover(rail);
    await waitFor(() => expect(turns.map(turn => turn.dataset.workHighlighted)).toEqual(['true', 'false', 'true']));
    await userEvent.unhover(rail);
    await waitFor(() => expect(turns.map(turn => turn.dataset.workHighlighted)).toEqual(['false', 'false', 'false']));
    const ticks = Array.from(canvasElement.querySelectorAll<HTMLElement>('.maka-prompt-rail-tick'));
    expect(ticks).toHaveLength(3);
    const navigation = canvasElement.querySelector<HTMLElement>('.workhub-navigation-item')!;
    await userEvent.hover(navigation);
    await waitFor(() => {
      expect(turns.map(turn => turn.dataset.workHighlighted)).toEqual(['true', 'false', 'true']);
      expect(ticks.map(tick => tick.dataset.highlighted)).toEqual(['true', undefined, 'true']);
      expect(getComputedStyle(ticks[0]!).color).toBe(getComputedStyle(ticks[2]!).color);
      expect(getComputedStyle(navigation.querySelector('.workhub-navigation-label')!).color)
        .toBe(getComputedStyle(ticks[0]!).color);
      expect(getComputedStyle(ticks[0]!).color).not.toBe(getComputedStyle(ticks[1]!).color);
    });
    await userEvent.unhover(navigation);
    await userEvent.hover(ticks[1]!);
    await waitFor(() => {
      expect(turns.map(turn => turn.dataset.workHighlighted)).toEqual(['false', 'true', 'false']);
      expect(navigation.dataset.workHighlighted).toBe('false');
    });
    await userEvent.unhover(ticks[1]!);
    ticks[0]!.focus();
    await waitFor(() => expect(navigation.dataset.workHighlighted).toBe('true'));
    ticks[0]!.blur();
    await userEvent.hover(rail);
    await waitFor(() => {
      expect(navigation.dataset.workHighlighted).toBe('true');
      expect(ticks.map(tick => tick.dataset.highlighted)).toEqual(['true', undefined, 'true']);
    });
    await userEvent.unhover(rail);
  },
};

const composerWrites = { model: fn(), permission: fn(), send: fn(), upload: fn() };
const composerModels = ['model-a', 'model-b'].map((model, index) => ({
  connectionId: 'connection-test', connectionSlug: 'test', providerType: 'openai' as const,
  providerLabel: 'OpenAI', model, label: model, isDefault: index === 0, thinkingLevels: [],
}));
function ConfiguredComposerSurface({ failFirst = false }: { failFirst?: boolean }) {
  const [failures] = useState(() => ({ remaining: failFirst ? 1 : 0 }));
  const [session, setSession] = useState<SessionSummary>({
    id: TARGET_SESSION_ID, name: SESSION_NAME, isFlagged: false, isArchived: false, labels: [],
    hasUnread: false, status: 'active', backend: 'ai-sdk', llmConnectionId: 'connection-test',
    llmConnectionSlug: 'test', connectionLocked: false, model: 'model-a', permissionMode: 'ask',
  });
  const [fixture] = useState<WorkHubController>(() => ({
    ...controller([submittedTurn()]),
    submit: async (input) => {
      composerWrites.send(input);
      if (failures.remaining-- > 0) throw new WorkHubCoordinationFailure('host_not_ready', 'Temporary Host failure');
      return { kind: 'discussion', requestId: input.requestId, text: input.text, strategyId: 'wh-r2.4-session-context-continuity' };
    },
  }));
  return <ToastProvider><WorkHubComposerServicesProvider services={{
    attachments: {
      pickFiles: async () => ({ ok: true, files: [{ approvalId: 'file-1', name: 'requirements.txt', size: 12, mimeType: 'text/plain' }] }),
      previewApproval: async () => ({ ok: false, reason: 'not-image' }),
    },
    prepareAttachments: async (sessionId, items) => {
      composerWrites.upload(sessionId, items);
      return [{ name: 'requirements.txt', kind: 'other', mimeType: 'text/plain', bytes: 12, ref: { kind: 'session_file', sessionId: 'maka_workhub_coordination', relativePath: 'artifact-1' } }];
    },
    setModelConfiguration: async (sessionId, model) => {
      composerWrites.model(sessionId, model);
      setSession((current) => ({ ...current, ...model, thinkingLevel: undefined }));
    },
    setPermissionMode: async (sessionId, permissionMode) => {
      composerWrites.permission(sessionId, permissionMode);
      setSession((current) => ({ ...current, permissionMode }));
    },
  }}>
    <div className="maka-detail-with-artifacts" style={{ height: '100dvh' }}><div className="mainColumn">
      <WorkHubSurface controller={fixture} leaseScope="composer-story" locale={LOCALE} onOpenSession={() => {}} composerServices={{
        sessions: [session], modelChoices: composerModels,
        defaults: { model: { llmConnectionId: 'connection-test', llmConnectionSlug: 'test', model: 'model-a' }, permissionMode: 'ask' },
        confirmBypass: async () => true, onOpenModelSettings: () => {},
      }} />
    </div></div>
  </WorkHubComposerServicesProvider></ToastProvider>;
}

// Production Composer, with only native file picking and Host writes replaced.
export const StandardComposer: Story = {
  render: () => <ConfiguredComposerSurface />,
  play: async ({ canvasElement }) => {
    Object.values(composerWrites).forEach((spy) => spy.mockClear());
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('combobox', { name: '当前 Work' })).toBeEnabled());
    await expect(canvas.getByText('模型与权限用于新 Work')).toBeVisible();
    await expect(canvas.getByRole('button', { name: '添加上下文' })).toBeEnabled();
    await userEvent.click(canvas.getByRole('combobox', { name: '当前 Work' }));
    await userEvent.click(within(canvasElement.ownerDocument.body).getByRole('option', { name: SESSION_NAME }));
    await expect(canvas.getByText('模型与权限用于此 Work')).toBeVisible();
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: /切换当前任务模型/ }));
    await userEvent.click(page.getByRole('menuitemradio', { name: 'model-b' }));
    await waitFor(() => expect(composerWrites.model).toHaveBeenCalledWith(TARGET_SESSION_ID, expect.objectContaining({ model: 'model-b' })));
    await userEvent.click(canvas.getByRole('button', { name: /权限模式/ }));
    await userEvent.click(page.getByRole('menuitemradio', { name: '完全权限' }));
    await waitFor(() => expect(composerWrites.permission).toHaveBeenCalledWith(TARGET_SESSION_ID, 'bypass'));
    await userEvent.click(canvas.getByRole('combobox', { name: '当前 Work' }));
    await userEvent.click(page.getByRole('option', { name: '自动识别工作' }));
    await userEvent.click(canvas.getByRole('button', { name: /选择新任务模型/ }));
    await userEvent.click(page.getByRole('menuitemradio', { name: 'model-b' }));
    await userEvent.click(canvas.getByRole('button', { name: '添加上下文' }));
    await userEvent.click(page.getByRole('menuitem', { name: /添加文件/ }));
    await waitFor(() => expect(canvas.getByText('requirements.txt')).toBeVisible());
    const editor = canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor);
    await userEvent.type(editor, 'Review requirements');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(composerWrites.send).toHaveBeenCalledWith(expect.objectContaining({
      newWorkDefaults: expect.objectContaining({ model: expect.objectContaining({ model: 'model-b' }), permissionMode: 'ask' }),
      attachments: [expect.objectContaining({ name: 'requirements.txt' })],
    })));
    expect(composerWrites.send.mock.lastCall?.[0].explicitTarget).toBeUndefined();
    expect(composerWrites.model).toHaveBeenCalledTimes(1);
    expect(composerWrites.permission).toHaveBeenCalledTimes(1);
    const composer = canvasElement.querySelector('.maka-composer-astryx') as HTMLElement;
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-composer-attachment-token')).toHaveLength(0));
    await userEvent.click(canvas.getByRole('button', { name: '添加上下文' }));
    await userEvent.click(page.getByRole('menuitem', { name: /添加文件/ }));
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-composer-attachment-token')).toHaveLength(1));
    await userEvent.click(editor);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(composerWrites.send).toHaveBeenCalledTimes(2));
    expect(composerWrites.send.mock.lastCall?.[0].text).toBe('请查看附件。');
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-composer-attachment-token')).toHaveLength(0));
    const scopeBox = canvasElement.querySelector('.workhub-composer-scope')!.getBoundingClientRect();
    const plateBox = composer.firstElementChild!.getBoundingClientRect();
    expect(Math.abs(scopeBox.left - plateBox.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(scopeBox.right - plateBox.right)).toBeLessThanOrEqual(1);
    const conversationBox = canvasElement.querySelector('.workhub-conversation-shell')!.getBoundingClientRect();
    expect(Math.abs(conversationBox.left - plateBox.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(conversationBox.right - plateBox.right)).toBeLessThanOrEqual(1);
    canvasElement.dataset.workhubComposerVerified = 'true';

  },
};

export const StandardComposerNarrow: Story = { ...StandardComposer, parameters: { viewport: { defaultViewport: 'tablet' } } };

export const ComposerRetainsFailedAttachment: Story = {
  render: () => <ConfiguredComposerSurface failFirst />,
  play: async ({ canvasElement }) => {
    Object.values(composerWrites).forEach((spy) => spy.mockClear());
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(canvas.getByRole('combobox', { name: '当前 Work' })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: '添加上下文' }));
    await userEvent.click(page.getByRole('menuitem', { name: /添加文件/ }));
    const editor = canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor);
    await userEvent.type(editor, 'Review requirements');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvasElement.querySelector('.workhub-turn[data-state="failed"]')).not.toBeNull());
    const composer = canvasElement.querySelector('.maka-composer-astryx') as HTMLElement;
    expect(within(composer).getByText('requirements.txt')).toBeVisible();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(composerWrites.send).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-composer-attachment-token')).toHaveLength(0));
    expect(composerWrites.upload).toHaveBeenCalledTimes(1);
    expect(composerWrites.send.mock.calls[0]?.[0].requestId).toBe(composerWrites.send.mock.calls[1]?.[0].requestId);
    canvasElement.dataset.workhubComposerVerified = 'true';
  },
};

// Real path: a completed Coordination Run projects host action receipts through
// the shared transcript, with clarification text and a navigable resume target.
export const CoordinationActionReceipts: Story = {
  render: () => <Surface turns={[
    { messageId: 'clarification-receipt', turnId: 'clarification-action', text: '继续刚才的任务',
      state: 'completed', result: '你是指支付回调幂等性任务吗？', updatedAt: 1 },
    { messageId: 'resume-receipt', turnId: 'resume-action', text: `继续${SESSION_NAME}`,
      state: 'completed', resume: { disposition: 'resume_work', outcome: 'resume_started', targetSessionId: TARGET_SESSION_ID, targetTurnId: 'resumed-target-turn' }, updatedAt: 2 },
  ]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('你是指支付回调幂等性任务吗？')).toBeVisible();
    await expect(await canvas.findByText('已让中断的工作继续：')).toBeVisible();
  },
};
