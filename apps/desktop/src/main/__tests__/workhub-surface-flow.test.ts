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
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AstryxLocaleProvider, LocaleProvider } from '@maka/ui';
import {
  WorkHubCoordinationStatus,
  WorkHubProjectionRefreshGate,
  WorkHubSurfaceRouteGate,
  submitWorkHubSurfaceInput,
  visibleWorkHubConversation,
  workHubSurfaceFailure,
  workHubSubmissionClearsDraft,
} from '../../renderer/workhub-surface.js';
import {
  createLegacyWorkHubControllerForTests as createWorkHubController,
  WORKHUB_ROUTING_STRATEGY_ID,
  type WorkHubController,
  type WorkHubSubmitInput,
} from '../../renderer/workhub-controller.js';
import {
  createDesktopWorkHubSessionPort,
  type WorkHubDesktopSession,
} from '../../renderer/workhub-session-port.js';

test('surface turns Action Gate rejections into safe actionable failures', () => {
  assert.equal(
    workHubSurfaceFailure(
      new Error('WorkHub Session candidates changed; refresh before delegating'),
    ),
    'candidates_changed',
  );
  assert.equal(
    workHubSurfaceFailure(
      new Error('WorkHub linked correction requires persistent delegation support'),
    ),
    'linked_correction_unavailable',
  );
  assert.equal(
    workHubSurfaceFailure(new Error('Target Session is waiting for user input')),
    'target_waiting',
  );
  assert.equal(workHubSurfaceFailure(new Error('private transport detail')), 'delivery_failed');
});

test('surface route gate rejects same-frame duplicate operations and reopens after settle', async () => {
  const gate = new WorkHubSurfaceRouteGate();
  let release: (() => void) | undefined;
  const first = gate.run(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return 'first';
  });

  assert.equal(gate.pending, true);
  assert.equal(await gate.run(async () => 'duplicate'), undefined);
  release?.();
  assert.equal(await first, 'first');
  assert.equal(gate.pending, false);
  assert.equal(await gate.run(async () => 'next'), 'next');
});

test('Coordination lifecycle keeps a visible loading state and exposes failure recovery', () => {
  const renderStatus = (state: 'resolving' | 'failed') => renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(AstryxLocaleProvider, {
        children: createElement(WorkHubCoordinationStatus, {
          locale: 'en',
          state,
          onRetry: () => undefined,
        }),
      }),
    }),
  );
  const resolving = renderStatus('resolving');
  const failed = renderStatus('failed');

  assert.match(resolving, /Preparing WorkHub/);
  assert.match(resolving, /aria-busy="true"/);
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Check the default model/);
  assert.match(failed, />Retry</);
});

test('surface projection refresh gate rejects older reads after a newer refresh starts', () => {
  const gate = new WorkHubProjectionRefreshGate();
  const first = gate.begin();
  const second = gate.begin();

  assert.equal(first(), false);
  assert.equal(second(), true);
  gate.invalidate();
  assert.equal(second(), false);
});

test('surface keeps the Composer draft when routing fails or the target is waiting', () => {
  assert.equal(workHubSubmissionClearsDraft(undefined), false);
  assert.equal(workHubSubmissionClearsDraft({
    kind: 'waiting',
    strategyId: WORKHUB_ROUTING_STRATEGY_ID,
    requestId: 'waiting',
    text: '继续处理',
    target: { sessionId: 'payment' },
  }), false);
  assert.equal(workHubSubmissionClearsDraft({
    kind: 'discussion',
    strategyId: WORKHUB_ROUTING_STRATEGY_ID,
    requestId: 'discussion',
    text: '先讨论方向',
  }), true);
});

test('surface replaces a local discussion placeholder with its durable model answer', () => {
  const local = [{
    requestId: 'discussion-turn',
    text: 'What is next?',
    state: 'settled' as const,
    outcome: {
      kind: 'discussion' as const,
      strategyId: WORKHUB_ROUTING_STRATEGY_ID,
      requestId: 'discussion-turn',
      text: 'What is next?',
    },
  }];
  const durable = [{
    messageId: 'user-message',
    turnId: 'discussion-turn',
    text: 'What is next?',
    result: 'Slice 3 is next.',
    state: 'completed' as const,
    updatedAt: 10,
  }];

  assert.deepEqual(visibleWorkHubConversation(durable, local), {
    coordination: durable,
    local: [],
  });
});

test('surface keeps clarification and successful routing in WorkHub', async () => {
  const submissions: WorkHubSubmitInput[] = [];
  const controller: WorkHubController = {
    read: async () => ({ sessions: [], turns: [] }),
    openConversation: async (handler) => {
      handler([]);
      return { close: async () => undefined };
    },
    recordConversationTurn: async ({ turnId }) => ({ turnId }),
    resetVisitContext: () => {},
    subscribe: () => () => {},
    submit: async (input) => {
      submissions.push(input);
      if (!input.explicitTarget) {
        return {
          kind: 'clarification',
          strategyId: WORKHUB_ROUTING_STRATEGY_ID,
          requestId: input.requestId,
          text: input.text,
          options: [{
            target: { sessionId: 'payment' },
            projectName: 'billing',
            sessionName: '支付回调幂等性',
          }],
        };
      }
      return {
        kind: 'submitted',
        strategyId: WORKHUB_ROUTING_STRATEGY_ID,
        requestId: input.requestId,
        target: input.explicitTarget,
        turnId: 'turn-payment',
        evidence: 'explicit_target',
      };
    },
  };

  const clarification = await submitWorkHubSurfaceInput({
    controller,
    input: { requestId: 'request-1', text: '继续处理重复问题' },
  });
  assert.equal(clarification.kind, 'clarification');

  const submitted = await submitWorkHubSurfaceInput({
    controller,
    input: {
      requestId: 'request-1',
      text: '继续处理重复问题',
      explicitTarget: { sessionId: 'payment' },
    },
  });
  assert.equal(submitted.kind, 'submitted');
  assert.deepEqual(submissions[1]?.explicitTarget, { sessionId: 'payment' });
});

test('surface leaves discussion in WorkHub instead of creating a task view', async () => {
  const controller: WorkHubController = {
    read: async () => ({ sessions: [], turns: [] }),
    openConversation: async (handler) => {
      handler([]);
      return { close: async () => undefined };
    },
    recordConversationTurn: async ({ turnId }) => ({ turnId }),
    resetVisitContext: () => {},
    subscribe: () => () => {},
    submit: async (input) => ({
      kind: 'discussion',
      strategyId: WORKHUB_ROUTING_STRATEGY_ID,
      requestId: input.requestId,
      text: input.text,
    }),
  };

  const result = await submitWorkHubSurfaceInput({
    controller,
    input: { requestId: 'discussion', text: '这个方向的价值是什么？' },
  });

  assert.equal(result.kind, 'discussion');
});

test('real Session projection creates new guide topics and preserves origin ambiguity', async () => {
  let clock = 10;
  const sessions: WorkHubDesktopSession[] = [{
    id: 'login',
    name: '刷新令牌过期致重复登录的排查计划',
    labels: [],
    isArchived: false,
    status: 'active',
    projectId: 'project-router',
    lastMessageAt: clock,
    lastMessagePreview: '已经整理为检查清单',
  }];
  const prompts = new Map<string, string[]>([[
    'login',
    ['排查登录刷新令牌过期导致重复登录的问题，先只分析并列出计划，不修改文件。'],
  ]]);
  const created: string[] = [];
  const port = createDesktopWorkHubSessionPort({
    transcripts: {
      open: async () => {
        throw new Error('transcript is not used by this routing test');
      },
    },
    sessions: {
      list: async () => sessions,
      listTurns: async (sessionId) => (prompts.get(sessionId) ?? [])
        .map((userPromptPreview) => ({ userPromptPreview })),
      create: async ({ name }) => {
        const id = name.includes('支付回调') ? 'payment' : 'layout';
        const session: WorkHubDesktopSession = {
          id,
          name: id === 'payment' ? '支付回调幂等性' : '移动端窄屏布局',
          labels: [],
          isArchived: false,
          status: 'active',
          projectId: 'project-maka',
          lastMessageAt: ++clock,
        };
        created.push(id);
        sessions.push(session);
        prompts.set(id, []);
        return session;
      },
      send: async (sessionId, command) => {
        prompts.get(sessionId)?.push(command.text);
        const session = sessions.find((candidate) => candidate.id === sessionId);
        if (session) {
          session.lastMessageAt = ++clock;
          session.lastMessagePreview = command.text;
        }
        return { ok: true, turnId: command.turnId };
      },
      stop: async () => {},
      subscribeChanges: () => () => {},
    },
    projectName: (projectId) => projectId === 'project-router'
      ? 'maka-workhub-session-router'
      : 'maka-agent',
    newTurnId: () => `turn-${clock + 1}`,
  });
  const controller = createWorkHubController({ sessions: port });

  const payment = await controller.submit({
    requestId: 'setup-payment',
    text: '检查支付回调重复投递时的幂等性，先只分析风险和测试点，不修改文件。',
  });
  const layout = await controller.submit({
    requestId: 'setup-layout',
    text: '优化 WorkHub 在移动端窄屏下的消息布局，先给设计建议，不修改文件。',
  });
  await controller.submit({
    requestId: 'focus-login',
    text: '刷新令牌过期致重复登录的排查计划：补充观测日志字段。',
  });
  const ambiguous = await controller.submit({
    requestId: 'ambiguous-repeat',
    text: '继续处理重复问题',
  });

  assert.equal(payment.kind === 'submitted' ? payment.evidence : undefined, 'new_session');
  assert.equal(layout.kind === 'submitted' ? layout.evidence : undefined, 'new_session');
  assert.deepEqual(created, ['payment', 'layout']);
  assert.equal(ambiguous.kind, 'clarification');
  assert.deepEqual(ambiguous.kind === 'clarification'
    ? ambiguous.options.map((option) => option.target.sessionId)
    : [], ['login', 'payment']);
});
