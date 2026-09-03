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
  WorkHubCoordinationTurnView,
  WorkHubProjectionRefreshGate,
  WorkHubSurfaceRouteGate,
  submitAndRecordWorkHubSurfaceInput,
  submitLeasedWorkHubSurfaceInput,
  submitWorkHubSurfaceInput,
  visibleWorkHubConversation,
  workHubAmbiguousCommandPrompt,
  workHubSurfaceFailure,
  workHubSubmissionClearsDraft,
} from '../../renderer/workhub-surface.js';
import {
  createWorkHubController,
  WORKHUB_ROUTING_STRATEGY_ID,
  type WorkHubController,
  type WorkHubCoordinationTurn,
  type WorkHubDelegationExecutionState,
  type WorkHubSubmitInput,
} from '../../renderer/workhub-controller.js';
import { WorkHubSendLease } from '../../renderer/workhub-send-lease.js';
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
      new Error('WorkHub linked correction requires an active durable delegation'),
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
  const renderStatus = (state: 'resolving' | 'failed') =>
    renderToStaticMarkup(
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

test('durable delegation renders every projected target state as a navigable result', () => {
  const states: Array<[WorkHubDelegationExecutionState, string]> = [
    ['accepted', 'Accepted'],
    ['running', 'Running'],
    ['waiting_for_user', 'Waiting for you'],
    ['completed', 'Completed'],
    ['failed', 'Failed'],
    ['aborted', 'Aborted'],
    ['recovering', 'Recovering'],
  ];
  for (const [state, label] of states) {
    const turn: WorkHubCoordinationTurn = {
      messageId: 'assignment-1',
      turnId: 'action-1',
      text: 'Continue payments',
      state: 'completed',
      assignment: {
        actionId: 'action-1',
        delegationId: 'delegation-1',
        targetSessionId: 'payment',
        targetSessionName: 'Payments',
        targetMessageId: 'payment-message',
        targetTurnId: 'payment-turn',
        feedbackState: state,
        linkState: 'active',
      },
      updatedAt: 10,
    };
    const markup = renderToStaticMarkup(
      createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(AstryxLocaleProvider, {
          children: createElement(WorkHubCoordinationTurnView, {
            turn,
            projection: { sessions: [], turns: [] },
            locale: 'en',
            onOpenSession: () => undefined,
          }),
        }),
      }),
    );
    assert.match(markup, /<button/u);
    assert.match(markup, /Payments/u);
    assert.match(markup, /Active link/u);
    assert.match(markup, new RegExp(label, 'u'));
    assert.match(markup, new RegExp(`data-state="${state}"`, 'u'));
    assert.match(markup, /data-link-state="active"/u);
  }
});

test('durable delegation renders terminal link state instead of stale execution feedback', () => {
  const terminalLinks = [
    ['superseded', 'Superseded link', '已被更正'],
    ['aborted', 'Aborted replacement', '更正已中止'],
    ['stopped', 'Stopped link', '已停止关联'],
  ] as const;
  for (const [linkState, english, chinese] of terminalLinks) {
    const turn: WorkHubCoordinationTurn = {
      messageId: `assignment-${linkState}`,
      turnId: `action-${linkState}`,
      text: 'Continue payments',
      state: 'completed',
      assignment: {
        actionId: `action-${linkState}`,
        delegationId: `delegation-${linkState}`,
        targetSessionId: 'payment',
        targetSessionName: 'Payments',
        targetMessageId: 'payment-message',
        targetTurnId: 'payment-turn',
        // Link authority must win even if the target execution projection is stale.
        feedbackState: 'running',
        linkState,
      },
      updatedAt: 10,
    };
    const render = (locale: 'en' | 'zh') => renderToStaticMarkup(
      createElement(LocaleProvider, {
        locale,
        children: createElement(AstryxLocaleProvider, {
          children: createElement(WorkHubCoordinationTurnView, {
            turn,
            projection: { sessions: [], turns: [] },
            locale,
            onOpenSession: () => undefined,
          }),
        }),
      }),
    );
    const englishMarkup = render('en');
    const chineseMarkup = render('zh');

    assert.match(englishMarkup, new RegExp(english, 'u'));
    assert.doesNotMatch(englishMarkup, />Running</u);
    assert.match(englishMarkup, new RegExp(`data-state="${linkState}"`, 'u'));
    assert.match(englishMarkup, new RegExp(`data-link-state="${linkState}"`, 'u'));
    assert.match(chineseMarkup, new RegExp(chinese, 'u'));
  }
});

test('durable creation explicitly announces the new work', () => {
  const turn: WorkHubCoordinationTurn = {
    messageId: 'created-assignment',
    turnId: 'created-action',
    text: 'Fix login stability',
    state: 'completed',
    assignment: {
      actionId: 'created-action',
      delegationId: 'created-delegation',
      targetSessionId: 'login',
      targetSessionName: 'Login stability',
      targetMessageId: 'login-message',
      targetTurnId: 'login-turn',
      feedbackState: 'accepted',
      linkState: 'active',
      createdNew: true,
    },
    updatedAt: 10,
  };
  const render = (locale: 'en' | 'zh') => renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale,
      children: createElement(AstryxLocaleProvider, {
        children: createElement(WorkHubCoordinationTurnView, {
          turn,
          projection: { sessions: [], turns: [] },
          locale,
          onOpenSession: () => undefined,
        }),
      }),
    }),
  );

  assert.match(render('en'), /Created new work:/u);
  assert.match(render('zh'), /已创建新工作：/u);
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
  assert.equal(
    workHubSubmissionClearsDraft({
      kind: 'waiting',
      strategyId: WORKHUB_ROUTING_STRATEGY_ID,
      requestId: 'waiting',
      text: '继续处理',
      target: { sessionId: 'payment' },
    }),
    false,
  );
  assert.equal(
    workHubSubmissionClearsDraft({
      kind: 'discussion',
      strategyId: WORKHUB_ROUTING_STRATEGY_ID,
      requestId: 'discussion',
      text: '先讨论方向',
    }),
    true,
  );
});

test('surface replaces a local discussion placeholder with its durable model answer', () => {
  const local = [
    {
      requestId: 'discussion-turn',
      text: 'What is next?',
      state: 'settled' as const,
      outcome: {
        kind: 'discussion' as const,
        strategyId: WORKHUB_ROUTING_STRATEGY_ID,
        requestId: 'discussion-turn',
        text: 'What is next?',
      },
    },
  ];
  const durable = [
    {
      messageId: 'user-message',
      turnId: 'discussion-turn',
      text: 'What is next?',
      result: 'Slice 3 is next.',
      state: 'completed' as const,
      updatedAt: 10,
    },
  ];

  assert.deepEqual(visibleWorkHubConversation(durable, local), {
    coordination: durable,
    local: [],
  });
});

test('surface replaces a submitted placeholder with its durable assignment state', () => {
  const local = [{
    requestId: 'replacement-action',
    text: 'Switch to Login',
    state: 'settled' as const,
    outcome: {
      kind: 'submitted' as const,
      strategyId: WORKHUB_ROUTING_STRATEGY_ID,
      requestId: 'replacement-action',
      target: { sessionId: 'login' },
      turnId: 'login-turn',
      evidence: 'explicit_target' as const,
    },
  }];
  const durable: WorkHubCoordinationTurn[] = [{
    messageId: 'assignment',
    turnId: 'replacement-action',
    text: 'Switch to Login',
    state: 'completed',
    assignment: {
      actionId: 'replacement-action',
      delegationId: 'login-delegation',
      targetSessionId: 'login',
      targetSessionName: 'Login',
      targetMessageId: 'login-message',
      targetTurnId: 'login-turn',
      feedbackState: 'accepted',
      linkState: 'active',
    },
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
          options: [
            {
              target: { sessionId: 'payment' },
              projectName: 'billing',
              sessionName: '支付回调幂等性',
            },
          ],
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

test('ambiguous creation is durably clarified before a fresh imperative creates work', async () => {
  const actions: Array<{ disposition: string; userText: string; assistantText?: string }> = [];
  const controller = createWorkHubController({
    sessions: {
      list: async () => [],
      recentTurns: async () => [],
      delegationFeedback: async () => [],
      routingEvidence: async () => [],
      subscribe: () => () => {},
    },
    coordination: {
      open: async () => ({ close: async () => undefined }),
      record: async (input) => ({ turnId: input.turnId }),
      candidates: async () => ({
        candidateSetId: `sha256:${'a'.repeat(64)}`,
        candidates: [],
      }),
      act: async (input) => {
        actions.push({
          disposition: input.proposal.disposition,
          userText: input.userText,
          ...(input.proposal.disposition === 'clarify'
            ? { assistantText: input.proposal.assistantText }
            : {}),
        });
        if (input.proposal.disposition === 'clarify') {
          return { disposition: 'clarify', coordinationTurnId: input.actionId };
        }
        if (input.proposal.disposition === 'create_new') {
          return {
            disposition: 'create_new',
            targetSessionId: 'created-login',
            targetTurnId: input.actionId,
          };
        }
        throw new Error(`Unexpected disposition: ${input.proposal.disposition}`);
      },
    },
  });

  const ambiguousTexts = [
    'Explain how to diagnose login, then fix it.',
    'Show me how to diagnose login, then fix it.',
    'Walk me through how to diagnose login, then fix it.',
    '教我如何诊断登录，然后修复它。',
  ];
  for (const [index, text] of ambiguousTexts.entries()) {
    const ambiguous = await submitAndRecordWorkHubSurfaceInput({
      controller,
      request: { requestId: `ambiguous-request-${index}`, text },
      recordedUserText: text,
      summary: () => workHubAmbiguousCommandPrompt('en'),
      onSummaryError: () => assert.fail('clarification should be durable'),
    });
    assert.equal(ambiguous.kind, 'clarification', text);
    assert.equal(
      ambiguous.kind === 'clarification' ? ambiguous.reason : undefined,
      'ambiguous_command',
      text,
    );
  }
  assert.deepEqual(
    actions,
    ambiguousTexts.map((userText) => ({
      disposition: 'clarify',
      userText,
      assistantText: workHubAmbiguousCommandPrompt('en'),
    })),
  );

  const submitted = await submitAndRecordWorkHubSurfaceInput({
    controller,
    request: { requestId: 'direct-request', text: 'Fix login.' },
    recordedUserText: 'Fix login.',
    summary: () => 'unused',
    onSummaryError: () => assert.fail('submitted work is projected from its assignment'),
  });
  assert.equal(submitted.kind, 'submitted');
  assert.equal(
    submitted.kind === 'submitted' ? submitted.evidence : undefined,
    'new_session',
  );
  assert.equal(actions.at(-1)?.disposition, 'create_new');
  assert.equal(actions.at(-1)?.userText, 'Fix login.');
  assert.notEqual(actions[0]?.userText, actions[1]?.userText);
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
  const sessions: WorkHubDesktopSession[] = [
    {
      id: 'login',
      name: '刷新令牌过期致重复登录的排查计划',
      labels: [],
      isArchived: false,
      status: 'active',
      projectId: 'project-router',
      lastMessageAt: clock,
      lastMessagePreview: '已经整理为检查清单',
    },
  ];
  const prompts = new Map<string, string[]>([
    [
      'login',
      ['排查登录刷新令牌过期导致重复登录的问题，先只分析并列出计划，不修改文件。'],
    ],
  ]);
  const created: string[] = [];
  const createSession = async ({ name }: { name: string }) => {
    const id = name.includes('支付回调') ? 'payment' : 'layout';
    const createdSession: WorkHubDesktopSession = {
      id,
      name: id === 'payment' ? '支付回调幂等性' : '移动端窄屏布局',
      labels: [],
      isArchived: false,
      status: 'active',
      projectId: 'project-maka',
      lastMessageAt: ++clock,
    };
    created.push(id);
    sessions.push(createdSession);
    prompts.set(id, []);
    return createdSession;
  };
  const send = async (
    sessionId: string,
    command: { type: 'send'; turnId: string; text: string },
  ) => {
    prompts.get(sessionId)?.push(command.text);
    const target = sessions.find((candidate) => candidate.id === sessionId);
    if (target) {
      target.lastMessageAt = ++clock;
      target.lastMessagePreview = command.text;
    }
    return { ok: true as const, turnId: command.turnId };
  };
  const port = createDesktopWorkHubSessionPort({
    transcripts: {
      open: async () => {
        throw new Error('transcript is not used by this routing test');
      },
    },
    sessions: {
      list: async () => sessions,
      listTurns: async (sessionId) =>
        (prompts.get(sessionId) ?? []).map((userPromptPreview) => ({ userPromptPreview })),
      queryMessageExecutions: async () => ({ resolutions: [] }),
      create: createSession,
      send,
      stop: async () => {},
      subscribeChanges: () => () => {},
    },
    projectName: (projectId) =>
      projectId === 'project-router' ? 'maka-workhub-session-router' : 'maka-agent',
  });
  const controller = createWorkHubController({
    sessions: port,
    coordination: {
      open: async () => ({ close: async () => undefined }),
      record: async (input) => ({ turnId: input.turnId }),
      candidates: async () => ({
        candidateSetId: `sha256:${'a'.repeat(64)}`,
        candidates: sessions.map((entry) => ({
          candidateRef: `candidate-${entry.id}`,
          sessionId: entry.id,
          sessionName: entry.name,
          workspace: {
            target: { kind: 'host_path' as const, path: `/workspace/${entry.id}` },
            hostCwd: `/workspace/${entry.id}`,
          },
          state: entry.status,
          updatedAt: entry.lastMessageAt ?? 0,
        })),
      }),
      act: async (input) => {
        if (input.proposal.disposition === 'answer_here') {
          return { disposition: 'answer_here', coordinationTurnId: input.actionId };
        }
        if (input.proposal.disposition === 'clarify') {
          return { disposition: 'clarify', coordinationTurnId: input.actionId };
        }
        if (input.proposal.disposition === 'create_new') {
          const target = await createSession({ name: input.proposal.title });
          const admitted = await send(target.id, {
            type: 'send',
            turnId: input.actionId,
            text: input.userText,
          });
          return {
            disposition: 'create_new',
            targetSessionId: target.id,
            targetTurnId: admitted.turnId,
          };
        }
        if (input.proposal.disposition === 'replace') {
          if (input.proposal.target.disposition === 'create_new') {
            const target = await createSession({ name: input.proposal.target.title });
            const admitted = await send(target.id, {
              type: 'send',
              turnId: input.actionId,
              text: input.userText,
            });
            return {
              disposition: 'replace',
              replacementDisposition: 'create_new',
              targetSessionId: target.id,
              targetTurnId: admitted.turnId,
            };
          }
          const targetSessionId = input.proposal.target.candidateRef.replace(
            /^candidate-/u,
            '',
          );
          const admitted = await send(targetSessionId, {
            type: 'send',
            turnId: input.actionId,
            text: input.userText,
          });
          return {
            disposition: 'replace',
            replacementDisposition: 'delegate_existing',
            targetSessionId,
            targetTurnId: admitted.turnId,
          };
        }
        if (input.proposal.disposition === 'stop_work') {
          return {
            disposition: 'stop_work',
            outcome: 'cancelled_pending',
            targetSessionId: input.proposal.expects.targetSessionId,
          };
        }
        const targetSessionId = input.proposal.candidateRef.replace(/^candidate-/u, '');
        const admitted = await send(targetSessionId, {
          type: 'send',
          turnId: input.actionId,
          text: input.userText,
        });
        return {
          disposition: 'delegate_existing',
          targetSessionId,
          targetTurnId: admitted.turnId,
        };
      },
    },
  });

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
  assert.deepEqual(
    ambiguous.kind === 'clarification'
      ? ambiguous.options.map((option) => option.target.sessionId)
      : [],
    ['login', 'payment'],
  );
});

test('action identity survives reload while edited text remains current', () => {
  const { storage } = memoryStorage();
  const first = new WorkHubSendLease({
    scope: 'host-a',
    storage,
    createId: () => 'action-1',
  });
  assert.deepEqual(first.acquireAttempt('Continue payments'), {
    requestId: 'action-1',
    text: 'Continue payments',
    retrying: false,
  });

  const restarted = new WorkHubSendLease({
    scope: 'host-a',
    storage,
    createId: () => 'action-2',
  });
  assert.deepEqual(restarted.acquireAttempt('Investigate login instead'), {
    requestId: 'action-1',
    text: 'Investigate login instead',
    retrying: true,
  });
});

test('draft and action identity have independent Host-scoped lifecycles', () => {
  const { storage } = memoryStorage();
  const hostA = new WorkHubSendLease({ scope: 'host-a', storage, createId: () => 'action-a' });
  const hostB = new WorkHubSendLease({ scope: 'host-b', storage, createId: () => 'action-b' });
  hostA.write('workhub', 'A draft');
  hostB.write('workhub', 'B draft');
  assert.equal(hostA.acquire('A send'), 'action-a');
  assert.equal(hostB.acquire('B send'), 'action-b');
  hostA.complete('action-a');
  assert.equal(hostA.read('workhub'), 'A draft');
  assert.equal(hostB.read('workhub'), 'B draft');
  assert.equal(hostB.acquire('B retry'), 'action-b');
});

test('successful delegated submission needs no renderer summary write', async () => {
  let records = 0;
  const controller = fakeController({
    submit: async (input) => ({
      kind: 'submitted',
      strategyId: WORKHUB_ROUTING_STRATEGY_ID,
      requestId: input.requestId,
      target: { sessionId: 'payments' },
      turnId: 'payments-turn',
      evidence: 'explicit_target',
    }),
    record: async ({ turnId }) => {
      records += 1;
      return { turnId };
    },
  });
  const result = await submitAndRecordWorkHubSurfaceInput({
    controller,
    request: { requestId: 'action-1', text: 'Continue payments' },
    recordedUserText: 'Continue payments',
    summary: () => 'Sent to Payments',
    onSummaryError: () => assert.fail('no summary write is expected'),
  });
  assert.equal(result.kind, 'submitted');
  assert.equal(records, 0);
});

test('lease retires only after an acknowledged submission', async () => {
  const { storage } = memoryStorage();
  let sends = 0;
  const lease = new WorkHubSendLease({
    scope: 'host-a',
    storage,
    createId: () => `action-${sends + 1}`,
  });
  lease.write('workhub', 'Continue payments');
  const cleared = await submitLeasedWorkHubSurfaceInput({
    lease,
    text: 'Continue payments',
    submit: async (attempt) => {
      sends += 1;
      return {
        kind: 'submitted',
        strategyId: WORKHUB_ROUTING_STRATEGY_ID,
        requestId: attempt.requestId,
        target: { sessionId: 'payments' },
        turnId: 'payments-turn',
        evidence: 'explicit_target',
      };
    },
  });
  assert.equal(cleared, true);
  assert.equal(lease.acquire('Next work'), 'action-2');
});

test('clarification choice retires its action without clearing the Composer draft', async () => {
  const { storage } = memoryStorage();
  const lease = new WorkHubSendLease({
    scope: 'host-a',
    storage,
    createId: () => 'action-choice',
  });
  lease.write('workhub', 'Unrelated draft');

  const clearsComposer = await submitLeasedWorkHubSurfaceInput({
    lease,
    text: 'Unrelated draft',
    preserveDraft: true,
    submit: async (attempt) => ({
      kind: 'submitted',
      strategyId: WORKHUB_ROUTING_STRATEGY_ID,
      requestId: attempt.requestId,
      target: { sessionId: 'payments' },
      turnId: 'payments-turn',
      evidence: 'explicit_target',
    }),
  });

  assert.equal(clearsComposer, false);
  assert.equal(lease.read('workhub'), 'Unrelated draft');
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  };
}

function fakeController(input: {
  submit: WorkHubController['submit'];
  record: WorkHubController['recordConversationTurn'];
}): WorkHubController {
  return {
    read: async () => ({ sessions: [], turns: [] }),
    submit: input.submit,
    openConversation: async () => ({ close: async () => undefined }),
    recordConversationTurn: input.record,
    subscribe: () => () => undefined,
    resetVisitContext: () => undefined,
  };
}
