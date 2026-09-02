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
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import type { WorkHubCoordinationActInput } from '@maka/runtime-host/protocol';
import {
  createWorkHubController as createGatedWorkHubController,
  WORKHUB_ROUTING_STRATEGY_ID,
  type WorkHubSessionFacts,
  type WorkHubSessionPort,
  type WorkHubCoordinationTurn,
} from '../../renderer/workhub-controller.js';
import {
  createWorkHubRoutePolicy,
  workHubNewSessionName,
} from '../../renderer/workhub-route-policy.js';

const appShellUrl = [
  new URL('../../renderer/app-shell.tsx', import.meta.url),
  new URL('../../../src/renderer/app-shell.tsx', import.meta.url),
].find((candidate) => existsSync(candidate));

if (!appShellUrl) throw new Error('Could not locate renderer/app-shell.tsx');

test('binds the controller to the immutable WH-R2.4 strategy ID', () => {
  assert.equal(WORKHUB_ROUTING_STRATEGY_ID, 'wh-r2.4-session-context-continuity');
});

test('binds the WorkHub controller to one Coordination identity rather than project refreshes', () => {
  const source = readFileSync(appShellUrl, 'utf8');

  assert.doesNotMatch(source, /workHubControllerRef\s*=\s*useRef/u);
  assert.match(
    source,
    /const workHubController\s*=\s*useMemo\([\s\S]*?\[workHubCoordinationGeneration, workHubCoordinationSessionId\],\s*\)/u,
  );
  assert.match(source, /workHubProjectsRef\.current\s*=\s*projects/u);
  assert.doesNotMatch(
    source,
    /useMemo\(\(\)\s*=>\s*createWorkHubController\([\s\S]*?\),\s*\[projects\]\)/u,
  );
});

function session(
  sessionId: string,
  overrides: Partial<WorkHubSessionFacts> = {},
): WorkHubSessionFacts {
  return {
    target: { sessionId },
    projectName: 'maka',
    sessionName: sessionId,
    kind: 'ordinary',
    archived: false,
    state: 'active',
    updatedAt: 1,
    ...overrides,
  };
}

interface TestSessionPort extends WorkHubSessionPort {
  create(input: { name: string }): Promise<WorkHubSessionFacts>;
  submit(
    target: { sessionId: string },
    text: string,
    turnId: string,
  ): Promise<{ turnId: string; steered?: true }>;
}

function port(sessions: WorkHubSessionFacts[]): TestSessionPort {
  let nextTurnId = 0;
  return {
    list: async () => sessions,
    recentTurns: async () => [],
    delegationFeedback: async (references) =>
      references.map(({ delegationId }) => ({ delegationId, state: 'accepted' })),
    routingEvidence: async () => [],
    create: async () => {
      throw new Error('create is not used by this read test');
    },
    submit: async (_target, _text, turnId) => ({
      turnId: turnId || `reserved-turn-${++nextTurnId}`,
    }),
    subscribe: () => () => {},
  };
}

function createWorkHubController({ sessions }: { sessions: TestSessionPort }) {
  let candidateByRef = new Map<string, WorkHubSessionFacts>();
  return createGatedWorkHubController({
    sessions,
    coordination: {
      open: async () => ({ close: async () => undefined }),
      record: async (input) => ({ turnId: input.turnId }),
      candidates: async () => {
        const candidates = (await sessions.list())
          .filter((entry) => entry.kind === 'ordinary' && !entry.archived)
          .map((entry) => ({
            candidateRef: `candidate-${entry.target.sessionId}`,
            sessionId: entry.target.sessionId,
            sessionName: entry.sessionName,
            workspace: {
              target: { kind: 'host_path' as const, path: `/workspace/${entry.target.sessionId}` },
              hostCwd: `/workspace/${entry.target.sessionId}`,
            },
            state: entry.state,
            updatedAt: entry.updatedAt,
          }));
        const byId = new Map(
          (await sessions.list()).map((entry) => [entry.target.sessionId, entry]),
        );
        candidateByRef = new Map(candidates.flatMap((candidate) => {
          const entry = byId.get(candidate.sessionId);
          return entry ? [[candidate.candidateRef, entry] as const] : [];
        }));
        return {
          candidateSetId: `sha256:${'a'.repeat(64)}`,
          candidates,
        };
      },
      act: async (input) => {
        if (input.proposal.disposition === 'answer_here') {
          return {
            disposition: 'answer_here',
            coordinationTurnId: input.actionId,
          };
        }
        if (input.proposal.disposition === 'clarify') {
          return {
            disposition: 'clarify',
            coordinationTurnId: input.actionId,
          };
        }
        if (input.proposal.disposition === 'create_new') {
          const created = await sessions.create({ name: input.proposal.title });
          const admitted = await sessions.submit(created.target, input.userText, input.actionId);
          return {
            disposition: 'create_new',
            targetSessionId: created.target.sessionId,
            targetTurnId: admitted.turnId,
            ...(admitted.steered ? { steered: true as const } : {}),
          };
        }
        if (input.proposal.disposition === 'replace') {
          if (input.proposal.target.disposition === 'create_new') {
            const created = await sessions.create({ name: input.proposal.target.title });
            const admitted = await sessions.submit(created.target, input.userText, input.actionId);
            return {
              disposition: 'replace',
              replacementDisposition: 'create_new',
              targetSessionId: created.target.sessionId,
              targetTurnId: admitted.turnId,
              ...(admitted.steered ? { steered: true as const } : {}),
            };
          }
          const replacementTarget = candidateByRef.get(input.proposal.target.candidateRef);
          if (!replacementTarget) throw new Error('unknown test replacement candidate');
          const admitted = await sessions.submit(
            replacementTarget.target,
            input.userText,
            input.actionId,
          );
          return {
            disposition: 'replace',
            replacementDisposition: 'delegate_existing',
            targetSessionId: replacementTarget.target.sessionId,
            targetTurnId: admitted.turnId,
            ...(admitted.steered ? { steered: true as const } : {}),
          };
        }
        const target = candidateByRef.get(input.proposal.candidateRef);
        if (!target) throw new Error('unknown test candidate');
        const admitted = await sessions.submit(target.target, input.userText, input.actionId);
        return {
          disposition: 'delegate_existing',
          targetSessionId: target.target.sessionId,
          targetTurnId: admitted.turnId,
          ...(admitted.steered ? { steered: true as const } : {}),
        };
      },
    },
  });
}

function coordinationAssignmentTurn(): WorkHubCoordinationTurn {
  return {
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
      feedbackState: 'accepted',
      linkState: 'active',
    },
    updatedAt: 10,
  };
}

test('conversation acknowledges a durable assignment before projecting target execution', async () => {
  const sessions = port([session('payment')]);
  let onSessionChanged: (() => void) | undefined;
  let feedbackState: 'completed' | 'waiting_for_user' = 'completed';
  sessions.subscribe = (handler) => {
    onSessionChanged = handler;
    return () => {
      onSessionChanged = undefined;
    };
  };
  sessions.delegationFeedback = async (references) =>
    references.map(({ delegationId }) => ({ delegationId, state: feedbackState }));
  const assignment = coordinationAssignmentTurn();
  const snapshots: string[] = [];
  const controller = createGatedWorkHubController({
    sessions,
    coordination: {
      open: async (handler) => {
        handler([assignment], [{
          actionId: assignment.assignment!.actionId,
          targetSessionId: assignment.assignment!.targetSessionId,
          sequence: 0,
        }]);
        return { close: async () => undefined };
      },
      record: async (input) => ({ turnId: input.turnId }),
      candidates: async () => ({ candidateSetId: `sha256:${'a'.repeat(64)}`, candidates: [] }),
      act: async () => ({ disposition: 'answer_here', coordinationTurnId: 'unused' }),
    },
  });

  const handle = await controller.openConversation((turns) => {
    snapshots.push(turns[0]?.assignment?.feedbackState ?? 'missing');
  }, () => undefined);
  await Promise.resolve();

  assert.deepEqual(snapshots.slice(0, 2), ['accepted', 'completed']);

  feedbackState = 'waiting_for_user';
  onSessionChanged?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(snapshots.at(-1), 'waiting_for_user');

  await handle.close();
});

test('conversation feedback never lets an older refresh overwrite newer target state', async () => {
  const sessions = port([session('payment')]);
  let onSessionChanged: (() => void) | undefined;
  sessions.subscribe = (handler) => {
    onSessionChanged = handler;
    return () => undefined;
  };
  type Feedback = Awaited<ReturnType<WorkHubSessionPort['delegationFeedback']>>;
  const pending: Array<{
    references: Parameters<WorkHubSessionPort['delegationFeedback']>[0];
    resolve(feedback: Feedback): void;
  }> = [];
  sessions.delegationFeedback = (references) =>
    new Promise((resolve) => pending.push({ references, resolve }));
  const snapshots: string[] = [];
  const controller = createGatedWorkHubController({
    sessions,
    coordination: {
      open: async (handler) => {
        const assignment = coordinationAssignmentTurn();
        handler([assignment], [{
          actionId: assignment.assignment!.actionId,
          targetSessionId: assignment.assignment!.targetSessionId,
          sequence: 0,
        }]);
        return { close: async () => undefined };
      },
      record: async (input) => ({ turnId: input.turnId }),
      candidates: async () => ({ candidateSetId: `sha256:${'b'.repeat(64)}`, candidates: [] }),
      act: async () => ({ disposition: 'answer_here', coordinationTurnId: 'unused' }),
    },
  });

  const handle = await controller.openConversation((turns) => {
    snapshots.push(turns[0]?.assignment?.feedbackState ?? 'missing');
  }, () => undefined);
  assert.equal(pending.length, 1);
  onSessionChanged?.();
  assert.equal(pending.length, 2);

  pending[1]!.resolve(pending[1]!.references.map(({ delegationId }) => ({
    delegationId,
    state: 'completed',
  })));
  await Promise.resolve();
  await Promise.resolve();
  pending[0]!.resolve(pending[0]!.references.map(({ delegationId }) => ({
    delegationId,
    state: 'failed',
  })));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(snapshots.at(-1), 'completed');
  assert.equal(snapshots.includes('failed'), false);
  await handle.close();
});

test('read exposes existing ordinary Sessions as factual Work summaries', async () => {
  const controller = createWorkHubController({
    sessions: port([
      session('login', {
        sessionName: '登录刷新令牌',
        state: 'running',
        latestResult: '已定位到刷新竞争条件',
        updatedAt: 30,
      }),
      session('payment', {
        projectName: 'billing',
        sessionName: '支付回调幂等性',
        archived: true,
        latestResult: '处理支付回调重复投递',
        updatedAt: 20,
      }),
      session('hub-internal', { kind: 'internal', updatedAt: 50 }),
      session('child-agent', { kind: 'subagent', updatedAt: 40 }),
    ]),
  });

  const projection = await controller.read();

  assert.deepEqual(projection.sessions, [
    {
      target: { sessionId: 'login' },
      projectName: 'maka',
      sessionName: '登录刷新令牌',
      archived: false,
      state: 'running',
      latestResult: '已定位到刷新竞争条件',
      updatedAt: 30,
    },
    {
      target: { sessionId: 'payment' },
      projectName: 'billing',
      sessionName: '支付回调幂等性',
      archived: true,
      state: 'active',
      latestResult: '处理支付回调重复投递',
      updatedAt: 20,
    },
  ]);
  assert.deepEqual(projection.turns, []);
});

test('read does not rebuild WorkHub conversation from ordinary Session turns', async () => {
  const sessions = port([
    session('login', { sessionName: '登录刷新令牌', updatedAt: 30 }),
    session('internal', { kind: 'internal', updatedAt: 40 }),
  ]);
  const requestedTargets: string[][] = [];
  sessions.recentTurns = async (targets) => {
    requestedTargets.push(targets.map((target) => target.sessionId));
    return [{
      messageId: 'user-1',
      target: { sessionId: 'login' },
      turnId: 'turn-login',
      text: '检查刷新令牌竞争条件',
      state: 'completed',
      result: '已定位到并发刷新窗口',
      updatedAt: 20,
    }];
  };

  const projection = await createWorkHubController({ sessions }).read();

  assert.deepEqual(requestedTargets, []);
  assert.deepEqual(projection.turns, []);
});

test('archived Sessions stay inspectable but are excluded from routing targets', async () => {
  const evidenceTargets: string[][] = [];
  const submitted: string[] = [];
  const sessions = port([
    session('archived-payment', {
      sessionName: '支付回调幂等性',
      archived: true,
      updatedAt: 30,
    }),
    session('active-login', {
      sessionName: '登录刷新令牌',
      updatedAt: 20,
    }),
  ]);
  sessions.routingEvidence = async (targets) => {
    evidenceTargets.push(targets.map((target) => target.sessionId));
    return [];
  };
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'unexpected' };
  };
  const controller = createWorkHubController({ sessions });

  const projection = await controller.read();
  const result = await controller.submit({
    requestId: 'archived-target',
    text: '支付回调幂等性现在是什么状态？',
  });

  assert.equal(projection.sessions.some((entry) => entry.archived), true);
  assert.deepEqual(evidenceTargets, [['active-login']]);
  assert.equal(result.kind, 'discussion');
  assert.deepEqual(submitted, []);
});

test('submit sends an explicitly targeted request to that Session', async () => {
  const submitted: Array<{ sessionId: string; text: string }> = [];
  const sessions = port([session('payment', { sessionName: '支付回调幂等性' })]);
  sessions.submit = async (target, text) => {
    submitted.push({ sessionId: target.sessionId, text });
    return { turnId: 'turn-payment' };
  };
  const controller = createWorkHubController({ sessions });

  const result = await controller.submit({
    requestId: 'request-1',
    text: '补充重复投递测试',
    explicitTarget: { sessionId: 'payment' },
  });

  assert.deepEqual(result, {
    kind: 'submitted',
    strategyId: WORKHUB_ROUTING_STRATEGY_ID,
    requestId: 'request-1',
    target: { sessionId: 'payment' },
    turnId: 'turn-payment',
    evidence: 'explicit_target',
  });
  assert.deepEqual(submitted, [
    { sessionId: 'payment', text: '补充重复投递测试' },
  ]);
});

test('submit routes a unique complete Session name without asking', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('login', { sessionName: '登录刷新令牌' }),
    session('payment', { projectName: 'billing', sessionName: '支付回调幂等性' }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-exact' };
  };
  const controller = createWorkHubController({ sessions });

  const result = await controller.submit({
    requestId: 'request-exact',
    text: '在支付回调幂等性里补充重复投递测试',
  });

  assert.deepEqual(result, {
    kind: 'submitted',
    strategyId: WORKHUB_ROUTING_STRATEGY_ID,
    requestId: 'request-exact',
    target: { sessionId: 'payment' },
    turnId: 'turn-exact',
    evidence: 'exact_session_name',
  });
  assert.deepEqual(submitted, ['payment']);
});

test('a unique longer Session name outranks a generic contained Session name', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('layout', { sessionName: '优化WorkHub移动端消息布局' }),
    session('generic', { sessionName: 'WorkHub' }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-layout' };
  };

  const result = await createWorkHubController({ sessions }).submit({
    requestId: 'request-layout',
    text: '优化WorkHub移动端消息布局：补充横屏注意点。',
  });

  assert.equal(result.kind, 'submitted');
  assert.deepEqual(submitted, ['layout']);
});

test('a short Latin Session name does not match inside another word', async () => {
  const submitted: string[] = [];
  const created: string[] = [];
  const sessions = port([
    session('ai', { sessionName: 'AI' }),
  ]);
  sessions.create = async ({ name }) => {
    created.push(name);
    return session('parser-new', { sessionName: name });
  };
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-parser' };
  };

  const result = await createWorkHubController({ sessions }).submit({
    requestId: 'request-parser',
    text: '修复 repair parser 的错误',
  });

  assert.equal(result.kind, 'submitted');
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'new_session');
  assert.deepEqual(created, ['修复 repair parser 的错误']);
  assert.deepEqual(submitted, ['parser-new']);
});

test('a one-character Latin discriminator prevents routing to a different Session name', async () => {
  for (const { existingName, requestedName } of [
    { existingName: 'GPT-4', requestedName: 'GPT-3' },
    { existingName: 'Project A', requestedName: 'Project B' },
  ]) {
    const submitted: string[] = [];
    const sessions = port([
      session('existing', { sessionName: existingName }),
    ]);
    sessions.create = async ({ name }) => session('new', { sessionName: name });
    sessions.submit = async (target) => {
      submitted.push(target.sessionId);
      return { turnId: 'turn-new' };
    };

    const result = await createWorkHubController({ sessions }).submit({
      requestId: `request-${requestedName}`,
      text: `请处理 ${requestedName} 的问题`,
    });

    assert.equal(result.kind, 'submitted');
    assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'new_session');
    assert.deepEqual(submitted, ['new']);
  }
});

test('submit asks the user when weak relevance matches more than one Session', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('login', {
      sessionName: '登录刷新令牌',
      latestResult: '处理刷新令牌过期造成的重复登录',
      updatedAt: 20,
    }),
    session('payment', {
      projectName: 'billing',
      sessionName: '支付回调幂等性',
      latestResult: '处理支付回调重复投递',
      updatedAt: 30,
    }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'unexpected' };
  };
  const controller = createWorkHubController({ sessions });

  const result = await controller.submit({
    requestId: 'request-ambiguous',
    text: '继续处理重复问题',
  });

  assert.deepEqual(result, {
    kind: 'clarification',
    strategyId: WORKHUB_ROUTING_STRATEGY_ID,
    requestId: 'request-ambiguous',
    text: '继续处理重复问题',
    options: [
      {
        target: { sessionId: 'payment' },
        projectName: 'billing',
        sessionName: '支付回调幂等性',
      },
      {
        target: { sessionId: 'login' },
        projectName: 'maka',
        sessionName: '登录刷新令牌',
      },
    ],
  });
  assert.deepEqual(submitted, []);
});

test('submit keeps origin prompts as stable evidence after latest results change', async () => {
  const sessions = port([
    session('login', {
      sessionName: '登录刷新令牌',
      latestResult: '已经整理为检查清单',
      updatedAt: 20,
    }),
    session('payment', {
      sessionName: '支付回调幂等性',
      latestResult: '已经把风险按高、中、低分组',
      updatedAt: 30,
    }),
  ]);
  sessions.routingEvidence = async () => [
    {
      target: { sessionId: 'login' },
      originPrompt: '排查刷新令牌过期导致的重复登录',
    },
    {
      target: { sessionId: 'payment' },
      originPrompt: '检查支付回调重复投递时的幂等性',
    },
  ];
  sessions.submit = async () => ({ turnId: 'turn-focus-login' });
  const controller = createWorkHubController({ sessions });
  await controller.submit({
    requestId: 'request-focus-login',
    text: '先看登录',
    explicitTarget: { sessionId: 'login' },
  });

  const result = await controller.submit({
    requestId: 'request-origin-ambiguity',
    text: '继续处理重复问题',
  });

  assert.equal(result.kind, 'clarification');
  assert.deepEqual(result.kind === 'clarification'
    ? result.options.map((option) => option.target.sessionId)
    : [], ['payment', 'login']);
});

test('submit creates a new executable topic instead of following one weak old clue', async () => {
  const createdNames: string[] = [];
  const sessions = port([
    session('login', {
      sessionName: '登录刷新令牌',
      latestResult: '已经整理为检查清单',
    }),
  ]);
  sessions.routingEvidence = async () => [{
    target: { sessionId: 'login' },
    originPrompt: '排查刷新令牌过期导致的重复登录',
  }];
  sessions.create = async ({ name }) => {
    createdNames.push(name);
    return session('payment-new', { sessionName: name });
  };
  sessions.submit = async () => ({ turnId: 'turn-payment-new' });
  const controller = createWorkHubController({ sessions });
  const text = '检查支付回调重复投递时的幂等性，先只分析风险和测试点，不修改文件。';

  const result = await controller.submit({ requestId: 'request-payment-new', text });

  assert.equal(result.kind, 'submitted');
  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'payment-new',
  });
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'new_session');
  assert.deepEqual(createdNames, ['检查支付回调重复投递时的幂等性']);
});

test('submit does not treat a project name as strong topic evidence', async () => {
  const createdNames: string[] = [];
  const sessions = port([
    session('login', {
      projectName: 'maka-workhub-session-router',
      sessionName: '登录刷新令牌',
    }),
  ]);
  sessions.routingEvidence = async () => [{
    target: { sessionId: 'login' },
    originPrompt: '排查刷新令牌过期导致的重复登录',
  }];
  sessions.create = async ({ name }) => {
    createdNames.push(name);
    return session('layout-new', { sessionName: name });
  };
  sessions.submit = async () => ({ turnId: 'turn-layout-new' });
  const controller = createWorkHubController({ sessions });
  const text = '优化 WorkHub 在移动端窄屏下的消息布局，先给设计建议，不修改文件。';

  const result = await controller.submit({ requestId: 'request-layout-new', text });

  assert.equal(result.kind, 'submitted');
  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'layout-new',
  });
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'new_session');
  assert.deepEqual(createdNames, ['优化 WorkHub 在移动端窄屏下的消息布局']);
});

test('submit follows an unambiguous reference to the most recent Work', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('login', { sessionName: '登录刷新令牌' }),
    session('payment', { sessionName: '支付回调幂等性' }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: `turn-${submitted.length}` };
  };
  const controller = createWorkHubController({ sessions });
  await controller.submit({
    requestId: 'request-focus',
    text: '先处理支付',
    explicitTarget: { sessionId: 'payment' },
  });

  const result = await controller.submit({
    requestId: 'request-pronoun',
    text: '继续它',
  });

  assert.deepEqual(result, {
    kind: 'submitted',
    strategyId: WORKHUB_ROUTING_STRATEGY_ID,
    requestId: 'request-pronoun',
    target: { sessionId: 'payment' },
    turnId: 'turn-2',
    evidence: 'recent_focus',
  });
  assert.deepEqual(submitted, ['payment', 'payment']);
});

test('read seeds current and previous focus from pre-existing ordinary Sessions', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('login', { sessionName: '登录刷新令牌', updatedAt: 20 }),
    session('payment', { sessionName: '支付回调幂等性', updatedAt: 30 }),
    session('archived', { archived: true, updatedAt: 40 }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: `turn-${submitted.length}` };
  };
  const controller = createWorkHubController({ sessions });

  await controller.read();
  const current = await controller.submit({
    requestId: 'request-current-seed',
    text: '继续这个工作',
  });
  const previous = await controller.submit({
    requestId: 'request-previous-seed',
    text: '回到上一个工作',
  });

  assert.deepEqual(current.kind === 'submitted' ? current.target : undefined, {
    sessionId: 'payment',
  });
  assert.deepEqual(previous.kind === 'submitted' ? previous.target : undefined, {
    sessionId: 'login',
  });
  assert.deepEqual(submitted, ['payment', 'login']);
});

test('read prefers the Session active when WorkHub opens over raw recency', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('login', { sessionName: '登录刷新令牌', updatedAt: 20 }),
    session('payment', { sessionName: '支付回调幂等性', updatedAt: 30 }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-login' };
  };
  const controller = createWorkHubController({ sessions });

  await controller.read({ focus: { sessionId: 'login' } });
  const result = await controller.submit({
    requestId: 'request-active-seed',
    text: '继续这个工作',
  });

  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'login',
  });
  assert.deepEqual(submitted, ['login']);
});

test('a stale opening read cannot overwrite a newer WorkHub focus', async () => {
  const pendingReads: Array<{
    resolve(value: WorkHubSessionFacts[]): void;
    promise: Promise<WorkHubSessionFacts[]>;
  }> = [];
  const sessions = port([]);
  sessions.list = () => {
    let resolve!: (value: WorkHubSessionFacts[]) => void;
    const promise = new Promise<WorkHubSessionFacts[]>((next) => {
      resolve = next;
    });
    pendingReads.push({ resolve, promise });
    return promise;
  };
  const submitted: string[] = [];
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-newer-focus' };
  };
  const controller = createWorkHubController({ sessions });
  const older = controller.read({ focus: { sessionId: 'payment' } });
  const newer = controller.read({ focus: { sessionId: 'login' } });
  const facts = [
    session('login', { updatedAt: 20 }),
    session('payment', { updatedAt: 30 }),
  ];

  pendingReads[1]!.resolve(facts);
  await newer;
  pendingReads[0]!.resolve([facts[1]!]);
  await older;
  sessions.list = async () => facts;
  const result = await controller.submit({
    requestId: 'request-after-stale-read',
    text: '继续这个工作',
  });

  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'login',
  });
  assert.deepEqual(submitted, ['login']);
});

test('an unavailable opening focus falls back to recent routable Sessions', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('archived', { archived: true, updatedAt: 40 }),
    session('login', { updatedAt: 20 }),
    session('payment', { updatedAt: 30 }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-fallback' };
  };
  const controller = createWorkHubController({ sessions });

  await controller.read({ focus: { sessionId: 'archived' } });
  const result = await controller.submit({
    requestId: 'request-fallback-focus',
    text: '继续这个工作',
  });

  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'payment',
  });
  assert.deepEqual(submitted, ['payment']);
});

test('focus falls back when the current Session is archived after WorkHub opens', async () => {
  let catalog = [
    session('login', { updatedAt: 20 }),
    session('payment', { updatedAt: 30 }),
  ];
  const sessions = port(catalog);
  sessions.list = async () => catalog;
  const submitted: string[] = [];
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-focus-fallback' };
  };
  const controller = createWorkHubController({ sessions });
  await controller.read();
  catalog = catalog.map((entry) => entry.target.sessionId === 'payment'
    ? { ...entry, archived: true }
    : entry);

  const result = await controller.submit({
    requestId: 'request-after-current-archive',
    text: '继续这个工作',
  });

  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'login',
  });
  assert.deepEqual(submitted, ['login']);
});

test('resetVisitContext discards focus from a previous WorkHub mount', async () => {
  let catalog = [
    session('login', { updatedAt: 20 }),
    session('payment', { updatedAt: 30 }),
  ];
  const sessions = port(catalog);
  sessions.list = async () => catalog;
  const submitted: string[] = [];
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: `turn-${submitted.length}` };
  };
  const controller = createWorkHubController({ sessions });
  await controller.read({ focus: { sessionId: 'login' } });
  controller.resetVisitContext();
  catalog = catalog.map((entry) => entry.target.sessionId === 'payment'
    ? { ...entry, updatedAt: 40 }
    : entry);
  await controller.read();

  const result = await controller.submit({
    requestId: 'request-after-remount',
    text: '继续这个工作',
  });

  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'payment',
  });
});

test('an in-flight submit cannot restore visit focus after WorkHub unmounts', async () => {
  const sessions = port([
    session('login', { updatedAt: 20 }),
    session('payment', { updatedAt: 30 }),
  ]);
  let signalSubmitStarted!: () => void;
  const submitStarted = new Promise<void>((resolve) => {
    signalSubmitStarted = resolve;
  });
  let finishSubmit!: (value: { turnId: string }) => void;
  const pendingTurn = new Promise<{ turnId: string }>((resolve) => {
    finishSubmit = resolve;
  });
  sessions.submit = async () => {
    signalSubmitStarted();
    return pendingTurn;
  };
  const controller = createWorkHubController({ sessions });
  await controller.read({ focus: { sessionId: 'login' } });
  const inFlight = controller.submit({
    requestId: 'request-before-unmount',
    text: '继续这个工作',
  });
  await submitStarted;
  controller.resetVisitContext();
  finishSubmit({ turnId: 'turn-login' });
  await inFlight;

  const submitted: string[] = [];
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-after-remount' };
  };
  await controller.read();
  const result = await controller.submit({
    requestId: 'request-after-in-flight',
    text: '继续这个工作',
  });

  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'payment',
  });
  assert.deepEqual(submitted, ['payment']);
});

test('an old submit resolves against the visit focus captured before an await', async () => {
  const catalog = [
    session('login', { updatedAt: 20 }),
    session('payment', { updatedAt: 30 }),
  ];
  const sessions = port(catalog);
  const controller = createWorkHubController({ sessions });
  await controller.read({ focus: { sessionId: 'login' } });

  let signalListStarted!: () => void;
  const listStarted = new Promise<void>((resolve) => {
    signalListStarted = resolve;
  });
  let finishOldList!: (value: WorkHubSessionFacts[]) => void;
  const oldList = new Promise<WorkHubSessionFacts[]>((resolve) => {
    finishOldList = resolve;
  });
  let blockNextList = true;
  sessions.list = async () => {
    if (!blockNextList) return catalog;
    blockNextList = false;
    signalListStarted();
    return oldList;
  };
  const submitted: string[] = [];
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-' + target.sessionId };
  };

  const oldSubmission = controller.submit({
    requestId: 'request-old-visit',
    text: '继续这个工作',
  });
  await listStarted;
  controller.resetVisitContext();
  await controller.read({ focus: { sessionId: 'payment' } });
  finishOldList(catalog);

  const result = await oldSubmission;
  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'login',
  });
  assert.deepEqual(submitted, ['login']);
});

test('submit routes strong core evidence instead of reusing recent focus', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('login', {
      sessionName: '登录稳定性',
      latestResult: '处理刷新令牌重复登录',
    }),
    session('payment', {
      sessionName: '支付稳定性',
      latestResult: '处理支付回调重复投递',
    }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: `turn-${submitted.length}` };
  };
  const controller = createWorkHubController({ sessions });
  await controller.submit({
    requestId: 'request-login-focus',
    text: '先看登录',
    explicitTarget: { sessionId: 'login' },
  });

  const result = await controller.submit({
    requestId: 'request-topic-shift',
    text: '继续处理支付回调重复投递',
  });

  assert.deepEqual(result, {
    kind: 'submitted',
    strategyId: WORKHUB_ROUTING_STRATEGY_ID,
    requestId: 'request-topic-shift',
    target: { sessionId: 'payment' },
    turnId: 'turn-2',
    evidence: 'core_entity',
  });
  assert.deepEqual(submitted, ['login', 'payment']);
});

test('submit routes unique strong core evidence without asking', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('login', {
      sessionName: '登录稳定性',
      latestResult: '处理刷新令牌过期导致的重复登录',
    }),
    session('payment', {
      sessionName: '支付稳定性',
      latestResult: '处理支付回调重复投递',
    }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-core' };
  };
  const controller = createWorkHubController({ sessions });

  const result = await controller.submit({
    requestId: 'request-core',
    text: '刷新令牌过期时，重复登录的观测日志应该记录哪些字段？',
  });

  assert.equal(result.kind, 'submitted');
  if (result.kind !== 'submitted') return;
  assert.deepEqual(result.target, { sessionId: 'login' });
  assert.equal(result.evidence, 'core_entity');
  assert.equal(result.strategyId, 'wh-r2.4-session-context-continuity');
  assert.deepEqual(submitted, ['login']);
});

test('submit ignores shared boilerplate when an executable request names a new topic', async () => {
  const createdNames: string[] = [];
  const sessions = port([
    session('login', {
      sessionName: '登录刷新令牌',
      latestResult: '排查登录刷新令牌，先只分析风险和测试点，不修改文件',
    }),
  ]);
  sessions.create = async ({ name }) => {
    createdNames.push(name);
    return session('payment-new', { sessionName: name });
  };
  sessions.submit = async () => ({ turnId: 'turn-payment-new' });
  const controller = createWorkHubController({ sessions });
  const text = '请创建新任务，检查支付回调重复投递；先只分析风险和测试点，不修改文件。';

  const result = await controller.submit({ requestId: 'request-new-topic', text });

  assert.equal(result.kind, 'submitted');
  if (result.kind !== 'submitted') return;
  assert.deepEqual(result.target, { sessionId: 'payment-new' });
  assert.equal(result.evidence, 'new_session');
  assert.equal(result.strategyId, 'wh-r2.4-session-context-continuity');
  assert.deepEqual(createdNames, ['检查支付回调重复投递']);
});

test('submit keeps a foreign two-character clue behind clarification', async () => {
  const sessions = port([
    session('login', { sessionName: '登录稳定性', updatedAt: 10 }),
    session('payment', { sessionName: '支付稳定性', updatedAt: 20 }),
  ]);
  const controller = createWorkHubController({ sessions });

  const result = await controller.submit({
    requestId: 'request-weak',
    text: '继续登录',
  });

  assert.equal(result.kind, 'clarification');
  assert.equal(result.strategyId, 'wh-r2.4-session-context-continuity');
});

test('submit treats explicit user uncertainty as clarification instead of a new Session', async () => {
  const created: string[] = [];
  const sessions = port([
    session('login', { sessionName: '登录稳定性', updatedAt: 20 }),
    session('payment', { sessionName: '支付稳定性', updatedAt: 30 }),
  ]);
  sessions.create = async ({ name }) => {
    created.push(name);
    return session('unexpected');
  };
  const controller = createWorkHubController({ sessions });

  const result = await controller.submit({
    requestId: 'request-uncertain',
    text: '继续处理稳定性问题，但我不确定具体是哪一个。',
  });

  assert.equal(result.kind, 'clarification');
  assert.deepEqual(result.kind === 'clarification'
    ? result.options.map((option) => option.target.sessionId)
    : [], ['payment', 'login']);
  assert.deepEqual(created, []);
});

test('English target uncertainty uses clarification as the routing safety valve', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('parser', { sessionName: 'Parser Cleanup', updatedAt: 20 }),
    session('profile', { sessionName: 'Profile Settings', updatedAt: 30 }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'unexpected' };
  };

  const result = await createWorkHubController({ sessions }).submit({
    requestId: 'english-uncertainty',
    text: "I'm not sure which one this belongs to; continue the cleanup.",
  });

  assert.equal(result.kind, 'clarification');
  assert.deepEqual(result.kind === 'clarification'
    ? result.options.map((option) => option.target.sessionId)
    : [], ['parser', 'profile']);
  assert.deepEqual(submitted, []);
});

test('English routing matches whole words instead of substrings in another identity', async () => {
  const submitted: string[] = [];
  const created: string[] = [];
  const sessions = port([
    session('profile', { sessionName: 'Profile Settings' }),
  ]);
  sessions.create = async ({ name }) => {
    created.push(name);
    return session('parser-new', { sessionName: name });
  };
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-parser' };
  };

  const result = await createWorkHubController({ sessions }).submit({
    requestId: 'english-word-boundary',
    text: 'check the file parser',
  });

  assert.equal(result.kind, 'submitted');
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'new_session');
  assert.deepEqual(created, ['check the file parser']);
  assert.deepEqual(submitted, ['parser-new']);
});

test('English core evidence requires a distinctive word or multiple whole-word matches', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('parser', {
      sessionName: 'Parser Cleanup',
      latestResult: 'Tokenizer regression isolated in parser recovery',
    }),
    session('profile', {
      sessionName: 'Profile Settings',
      latestResult: 'Account preferences are ready',
    }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-parser' };
  };

  const result = await createWorkHubController({ sessions }).submit({
    requestId: 'english-core-evidence',
    text: 'fix the parser tokenizer crash',
  });

  assert.equal(result.kind, 'submitted');
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'core_entity');
  assert.deepEqual(submitted, ['parser']);
});

test('waiting Session rejects a second root request without calling submit', async () => {
  let submitted = false;
  const sessions = port([
    session('login', {
      sessionName: '排查令牌过期重复登录问题',
      state: 'waiting_for_user',
    }),
  ]);
  sessions.submit = async () => {
    submitted = true;
    return { turnId: 'unexpected' };
  };
  const controller = createWorkHubController({ sessions });

  const result = await controller.submit({
    requestId: 'request-waiting',
    text: '排查令牌过期重复登录问题：补充一条等待状态下的新请求。',
  });

  assert.deepEqual(result, {
    kind: 'waiting',
    strategyId: WORKHUB_ROUTING_STRATEGY_ID,
    requestId: 'request-waiting',
    text: '排查令牌过期重复登录问题：补充一条等待状态下的新请求。',
    target: { sessionId: 'login' },
  });
  assert.equal(submitted, false);
});

test('submit returns to the previous focused Session', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('login', { sessionName: '登录刷新令牌' }),
    session('payment', { sessionName: '支付回调幂等性' }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: `turn-${submitted.length}` };
  };
  const controller = createWorkHubController({ sessions });
  await controller.submit({
    requestId: 'request-login',
    text: '先看登录',
    explicitTarget: { sessionId: 'login' },
  });
  await controller.submit({
    requestId: 'request-payment',
    text: '再看支付',
    explicitTarget: { sessionId: 'payment' },
  });

  const result = await controller.submit({
    requestId: 'request-previous',
    text: '回到上一个工作',
  });

  assert.equal(result.kind, 'submitted');
  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, { sessionId: 'login' });
  assert.deepEqual(submitted, ['login', 'payment', 'login']);
});

test('submit lets strong foreign core evidence override a vague focus word', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('login', {
      sessionName: '登录稳定性',
      latestResult: '处理刷新令牌过期导致的重复登录',
    }),
    session('payment', {
      sessionName: '支付稳定性',
      latestResult: '处理支付回调重复投递',
    }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: `turn-${submitted.length}` };
  };
  const controller = createWorkHubController({ sessions });
  await controller.submit({
    requestId: 'request-payment-focus',
    text: '先看支付',
    explicitTarget: { sessionId: 'payment' },
  });

  const result = await controller.submit({
    requestId: 'request-foreign-core',
    text: '继续处理刷新令牌过期',
  });

  assert.equal(result.kind, 'submitted');
  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, { sessionId: 'login' });
  assert.deepEqual(submitted, ['payment', 'login']);
});

test('submit keeps unmatched non-executable conversation in WorkHub', async () => {
  let created = false;
  const actions: unknown[] = [];
  const sessions = port([]);
  sessions.create = async () => {
    created = true;
    return session('unexpected');
  };
  const controller = createGatedWorkHubController({
    sessions,
    coordination: {
      open: async () => ({ close: async () => undefined }),
      record: async (input) => ({ turnId: input.turnId }),
      candidates: async () => ({
        candidateSetId: `sha256:${'a'.repeat(64)}`,
        candidates: [],
      }),
      act: async (input) => {
        actions.push(input);
        return {
          disposition: 'answer_here',
          coordinationTurnId: 'coordination-turn',
        };
      },
    },
  });

  const result = await controller.submit({
    requestId: 'request-discussion',
    text: '你觉得统一入口最重要的价值是什么？',
  });

  assert.deepEqual(result, {
    kind: 'discussion',
    strategyId: WORKHUB_ROUTING_STRATEGY_ID,
    requestId: 'request-discussion',
    text: '你觉得统一入口最重要的价值是什么？',
  });
  assert.equal(created, false);
  assert.deepEqual(actions, [
    {
      actionId: 'request-discussion',
      userText: '你觉得统一入口最重要的价值是什么？',
      proposal: { disposition: 'answer_here' },
    },
  ]);
});

test('production submission delegates only through the Runtime-owned candidate reference', async () => {
  const actions: unknown[] = [];
  const sessions = port([session('payment')]);
  sessions.submit = async () => {
    throw new Error('renderer direct submit must not be used');
  };
  const controller = createGatedWorkHubController({
    sessions,
    coordination: {
      open: async () => ({ close: async () => undefined }),
      record: async (input) => ({ turnId: input.turnId }),
      candidates: async () => ({
        candidateSetId: `sha256:${'b'.repeat(64)}`,
        candidates: [{
          candidateRef: 'candidate-payment',
          sessionId: 'payment',
          sessionName: 'payment',
          workspace: {
            target: { kind: 'host_path', path: '/workspace/payment' },
            hostCwd: '/workspace/payment',
          },
          state: 'active',
          updatedAt: 1,
        }],
      }),
      act: async (input) => {
        actions.push(input);
        return {
          disposition: 'delegate_existing',
          targetSessionId: 'payment',
          targetTurnId: 'target-turn',
        };
      },
    },
  });

  const result = await controller.submit({
    requestId: 'delegate-action',
    text: '继续支付工作',
    explicitTarget: { sessionId: 'payment' },
  });

  assert.equal(result.kind, 'submitted');
  assert.equal(result.kind === 'submitted' ? result.turnId : undefined, 'target-turn');
  assert.deepEqual(actions, [{
    actionId: 'delegate-action',
    userText: '继续支付工作',
    candidateSetId: `sha256:${'b'.repeat(64)}`,
    proposal: {
      disposition: 'delegate_existing',
      candidateRef: 'candidate-payment',
    },
  }]);
});

test('production retry reaches durable Action Gate replay while target is waiting', async () => {
  const actions: unknown[] = [];
  const sessions = port([
    session('payment', { state: 'waiting_for_user' }),
  ]);
  const controller = createGatedWorkHubController({
    sessions,
    coordination: {
      open: async () => ({ close: async () => undefined }),
      record: async (input) => ({ turnId: input.turnId }),
      candidates: async () => ({
        candidateSetId: `sha256:${'c'.repeat(64)}`,
        candidates: [{
          candidateRef: 'candidate-payment',
          sessionId: 'payment',
          sessionName: 'payment',
          workspace: {
            target: { kind: 'host_path', path: '/workspace/payment' },
            hostCwd: '/workspace/payment',
          },
          state: 'waiting_for_user',
          updatedAt: 2,
        }],
      }),
      act: async (input) => {
        actions.push(input);
        return {
          disposition: 'delegate_existing',
          targetSessionId: 'payment',
          targetTurnId: 'already-committed-turn',
        };
      },
    },
  });

  const result = await controller.submit({
    requestId: 'summary-recovery-action',
    text: '继续支付工作',
    explicitTarget: { sessionId: 'payment' },
    retryAction: true,
  });

  assert.equal(result.kind, 'submitted');
  assert.equal(result.kind === 'submitted' ? result.turnId : undefined, 'already-committed-turn');
  assert.equal(actions.length, 1);
});

test('production sends an explicit correction as a linked replacement', async () => {
  const actions: unknown[] = [];
  const sessions = port([session('source'), session('target')]);
  const controller = createGatedWorkHubController({
    sessions,
    coordination: {
      open: async () => ({ close: async () => undefined }),
      record: async (input) => ({ turnId: input.turnId }),
      candidates: async () => ({
        candidateSetId: `sha256:${'d'.repeat(64)}`,
        candidates: [
          {
            candidateRef: 'candidate-source',
            sessionId: 'source',
            sessionName: 'source',
            workspace: {
              target: { kind: 'host_path', path: '/workspace/source' },
              hostCwd: '/workspace/source',
            },
            state: 'active',
            updatedAt: 1,
          },
          {
            candidateRef: 'candidate-target',
            sessionId: 'target',
            sessionName: 'target',
            workspace: {
              target: { kind: 'host_path', path: '/workspace/target' },
              hostCwd: '/workspace/target',
            },
            state: 'active',
            updatedAt: 2,
          },
        ],
      }),
      act: async (input) => {
        actions.push(input);
        return {
          disposition: 'replace',
          replacementDisposition: 'delegate_existing',
          targetSessionId: 'target',
          targetTurnId: 'replacement-turn',
        };
      },
    },
  });

  const result = await controller.submit({
    requestId: 'linked-correction',
    text: 'No, use target instead',
    explicitTarget: { sessionId: 'target' },
    correction: { from: { sessionId: 'source' }, sourceActionId: 'source-action' },
  });

  assert.equal(result.kind, 'submitted');
  assert.deepEqual(actions, [
    {
      actionId: 'linked-correction',
      userText: 'No, use target instead',
      candidateSetId: `sha256:${'d'.repeat(64)}`,
      confirmation: { kind: 'user_correction' },
      proposal: {
        disposition: 'replace',
        replacesActionId: 'source-action',
        target: {
          disposition: 'delegate_existing',
          candidateRef: 'candidate-target',
        },
      },
    },
  ]);
});

const PRODUCTION_CORRECTION_CREATION_CASES = [
  ['production-correction-with-create-en', 'No, create a new session called Login instead'],
  [
    'production-correction-with-polite-create-en',
    'No, please create a new session called Login instead',
  ],
  [
    'production-correction-with-em-dash-en',
    'No — create a new session called Login instead',
  ],
  ['production-correction-with-create-zh', '不是这个，创建一个新会话叫登录稳定性'],
  ['production-correction-with-polite-create-zh', '不是这个，请创建一个新会话叫Login'],
  ['production-correction-with-alternate-cue-zh', '不对，创建一个新会话叫Login'],
] as const;

test('production natural-language corrections retain the prior delegation link', async () => {
  const actions: WorkHubCoordinationActInput[] = [];
  const sessions = port([
    session('login', {
      sessionName: '登录稳定性',
      latestResult: '刷新令牌过期导致重复登录',
      updatedAt: 20,
    }),
    session('payment', {
      sessionName: '支付稳定性',
      latestResult: '支付回调重复投递',
      updatedAt: 30,
    }),
  ]);
  const candidateSetId = `sha256:${'e'.repeat(64)}`;
  const candidates = [
    {
      candidateRef: 'candidate-login',
      sessionId: 'login',
      sessionName: '登录稳定性',
      workspace: {
        target: { kind: 'host_path' as const, path: '/workspace/login' },
        hostCwd: '/workspace/login',
      },
      state: 'active' as const,
      updatedAt: 20,
    },
    {
      candidateRef: 'candidate-payment',
      sessionId: 'payment',
      sessionName: '支付稳定性',
      workspace: {
        target: { kind: 'host_path' as const, path: '/workspace/payment' },
        hostCwd: '/workspace/payment',
      },
      state: 'active' as const,
      updatedAt: 30,
    },
  ];
  const controller = createGatedWorkHubController({
    sessions,
    coordination: {
      open: async () => ({ close: async () => undefined }),
      record: async (input) => ({ turnId: input.turnId }),
      candidates: async () => ({ candidateSetId, candidates }),
      act: async (input) => {
        actions.push(input);
        if (input.proposal.disposition === 'replace') {
          if (input.proposal.target.disposition === 'create_new') {
            return {
              disposition: 'replace',
              replacementDisposition: 'create_new',
              targetSessionId: `created-${input.actionId}`,
              targetTurnId: `turn-${input.actionId}`,
            };
          }
          return {
            disposition: 'replace',
            replacementDisposition: 'delegate_existing',
            targetSessionId: input.proposal.target.candidateRef === 'candidate-login'
              ? 'login'
              : 'payment',
            targetTurnId: 'runtime-login-turn',
          };
        }
        if (input.proposal.disposition !== 'delegate_existing') {
          throw new Error('unexpected test disposition');
        }
        return {
          disposition: 'delegate_existing',
          targetSessionId: input.proposal.candidateRef === 'candidate-login'
            ? 'login'
            : 'payment',
          targetTurnId: input.actionId === 'production-wrong-payment'
            ? 'runtime-payment-turn'
            : 'runtime-login-turn',
        };
      },
    },
  });
  await controller.read();
  await controller.submit({
    requestId: 'production-wrong-payment',
    text: '继续这个工作，补充验收项',
  });

  const corrected = await controller.submit({
    requestId: 'production-natural-correction',
    text: '不是这个，换成登录稳定性，补充刷新令牌失败判定',
  });
  assert.equal(corrected.kind, 'submitted');

  const [creationRequestId, creationText] = PRODUCTION_CORRECTION_CREATION_CASES[0];
  assert.equal(
    (await controller.submit({ requestId: creationRequestId, text: creationText })).kind,
    'submitted',
  );

  assert.equal(actions.length, 3);
  assert.deepEqual(actions[1], {
    actionId: 'production-natural-correction',
    userText: '不是这个，换成登录稳定性，补充刷新令牌失败判定',
    candidateSetId,
    confirmation: { kind: 'user_correction' },
    proposal: {
      disposition: 'replace',
      replacesActionId: 'production-wrong-payment',
      target: {
        disposition: 'delegate_existing',
        candidateRef: 'candidate-login',
      },
    },
  });
  assert.deepEqual(
    actions.slice(2).map((action) => action.proposal.disposition),
    ['replace'],
  );
});

test('production correction-shaped creation stays create_new without an existing focus', async () => {
  const dispositions: string[] = [];
  const controller = createGatedWorkHubController({
    sessions: port([]),
    coordination: {
      open: async () => ({ close: async () => undefined }),
      record: async (input) => ({ turnId: input.turnId }),
      candidates: async () => ({
        candidateSetId: `sha256:${'c'.repeat(64)}`,
        candidates: [],
      }),
      act: async (input) => {
        dispositions.push(input.proposal.disposition);
        return {
          disposition: 'create_new',
          targetSessionId: `runtime-created-${dispositions.length}`,
          targetTurnId: `runtime-turn-${dispositions.length}`,
        };
      },
    },
  });

  for (const [requestId, text] of PRODUCTION_CORRECTION_CREATION_CASES) {
    const result = await controller.submit({ requestId: `without-focus-${requestId}`, text });
    assert.equal(result.kind, 'submitted');
  }

  assert.deepEqual(dispositions, Array(PRODUCTION_CORRECTION_CREATION_CASES.length)
    .fill('create_new'));
});

test('production clarification is persisted through the typed Action Gate disposition', async () => {
  const actions: unknown[] = [];
  const controller = createGatedWorkHubController({
    sessions: port([]),
    coordination: {
      open: async () => ({ close: async () => undefined }),
      record: async () => {
        throw new Error('legacy summary recording must not persist clarification');
      },
      candidates: async () => ({
        candidateSetId: `sha256:${'c'.repeat(64)}`,
        candidates: [],
      }),
      act: async (input) => {
        actions.push(input);
        return {
          disposition: 'clarify',
          coordinationTurnId: 'clarification-turn',
        };
      },
    },
  });

  assert.deepEqual(await controller.recordConversationTurn({
    turnId: 'clarification-action',
    userText: '继续稳定性问题',
    assistantText: '请选择目标 Session',
    disposition: 'clarify',
  }), { turnId: 'clarification-turn' });
  assert.deepEqual(actions, [{
    actionId: 'clarification-action',
    userText: '继续稳定性问题',
    proposal: {
      disposition: 'clarify',
      assistantText: '请选择目标 Session',
    },
  }]);
});

test('production creation leaves Session identity and workspace authority to main and Runtime', async () => {
  const actions: unknown[] = [];
  const sessions = port([]);
  sessions.create = async () => {
    throw new Error('renderer direct create must not be used');
  };
  const controller = createGatedWorkHubController({
    sessions,
    coordination: {
      open: async () => ({ close: async () => undefined }),
      record: async (input) => ({ turnId: input.turnId }),
      candidates: async () => ({
        candidateSetId: `sha256:${'c'.repeat(64)}`,
        candidates: [],
      }),
      act: async (input) => {
        actions.push(input);
        return {
          disposition: 'create_new',
          targetSessionId: 'runtime-created',
          targetTurnId: 'runtime-turn',
        };
      },
    },
  });

  const result = await controller.submit({
    requestId: 'create-action',
    text: '请创建新任务，检查支付回调重复投递。',
  });

  assert.equal(result.kind, 'submitted');
  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'runtime-created',
  });
  assert.deepEqual(actions, [{
    actionId: 'create-action',
    userText: '请创建新任务，检查支付回调重复投递。',
    proposal: {
      disposition: 'create_new',
      title: '检查支付回调重复投递',
    },
  }]);
});

test('submit treats a design question containing an action word as discussion', async () => {
  let created = false;
  const sessions = port([]);
  sessions.create = async () => {
    created = true;
    return session('unexpected');
  };
  const controller = createWorkHubController({ sessions });

  const result = await controller.submit({
    requestId: 'request-design-question',
    text: '我们应该怎么实现统一入口？',
  });

  assert.equal(result.kind, 'discussion');
  assert.equal(created, false);
});

test('an executable English request may contain what without becoming discussion', async () => {
  const created: string[] = [];
  const sessions = port([]);
  sessions.create = async ({ name }) => {
    created.push(name);
    return session('parser-fix', { sessionName: name });
  };
  sessions.submit = async () => ({ turnId: 'turn-parser-fix' });

  const result = await createWorkHubController({ sessions }).submit({
    requestId: 'english-what-object',
    text: 'fix what is broken in the parser',
  });

  assert.equal(result.kind, 'submitted');
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'new_session');
  assert.deepEqual(created, ['fix what is broken in the parser']);
});

test('submit creates an ordinary Session for a clear unmatched executable goal', async () => {
  const createdNames: string[] = [];
  const submitted: Array<{ sessionId: string; text: string }> = [];
  const sessions = port([]);
  sessions.create = async ({ name }) => {
    createdNames.push(name);
    return session('invoice-export', { sessionName: name });
  };
  sessions.submit = async (target, text) => {
    submitted.push({ sessionId: target.sessionId, text });
    return { turnId: 'turn-invoice-export' };
  };
  const controller = createWorkHubController({ sessions });

  const result = await controller.submit({
    requestId: 'request-new-work',
    text: '实现导出发票 PDF 功能',
  });

  assert.deepEqual(result, {
    kind: 'submitted',
    strategyId: WORKHUB_ROUTING_STRATEGY_ID,
    requestId: 'request-new-work',
    target: { sessionId: 'invoice-export' },
    turnId: 'turn-invoice-export',
    evidence: 'new_session',
  });
  assert.deepEqual(createdNames, ['实现导出发票 PDF 功能']);
  assert.deepEqual(submitted, [
    { sessionId: 'invoice-export', text: '实现导出发票 PDF 功能' },
  ]);
});

test('explicit new-Session intent outranks generic evidence from existing work', async () => {
  const created: string[] = [];
  const sessions = port([
    session('login', { sessionName: '登录稳定性测试计划' }),
    session('payment', { sessionName: '支付回调测试计划' }),
  ]);
  sessions.create = async ({ name }) => {
    created.push(name);
    return session('new-session', { sessionName: name });
  };
  sessions.submit = async () => ({ turnId: 'turn-new-session' });

  const result = await createWorkHubController({ sessions }).submit({
    requestId: 'request-explicit-new',
    text: '创建一个全新的普通 Session，标题为 R2.3 新建工作验收，只记录测试计划。',
  });

  assert.equal(result.kind, 'submitted');
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'new_session');
  assert.deepEqual(created, ['R2.3 新建工作验收']);
});

test('English explicit creation extracts the requested Session name', async () => {
  const created: string[] = [];
  const sessions = port([]);
  sessions.create = async ({ name }) => {
    created.push(name);
    return session('parser-cleanup', { sessionName: name });
  };
  sessions.submit = async () => ({ turnId: 'turn-parser-cleanup' });

  const result = await createWorkHubController({ sessions }).submit({
    requestId: 'english-explicit-new',
    text: 'Create a new session called Parser Cleanup.',
  });

  assert.equal(result.kind, 'submitted');
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'new_session');
  assert.deepEqual(created, ['Parser Cleanup']);
});

test('Chinese explicit creation strips Session naming introducers', () => {
  assert.deepEqual(
    [
      '创建一个新的 Session，名为登录稳定性',
      '新建工作叫支付回调幂等性',
      '开一个任务命名为消息恢复',
      '不对，请创建一个新的 Session 标题为登录稳定性',
      '错了，新建一个会话名称为支付任务',
      '不对，不要创建一个新会话叫登录；而是创建一个新会话叫支付。',
    ].map((text) => workHubNewSessionName(text)),
    ['登录稳定性', '支付回调幂等性', '消息恢复', '登录稳定性', '支付任务', '支付'],
  );
  assert.equal(
    workHubNewSessionName(
      'No, create a new Session called Payments, and add documentation containing the example new Session called Fraud.',
    ),
    'Payments',
  );
  assert.equal(workHubNewSessionName('Create a new Session called U.S. Payments'), 'U.S. Payments');
  assert.equal(workHubNewSessionName('Create a new Session called Dr. Login'), 'Dr. Login');
  assert.equal(
    workHubNewSessionName('Create a new Session called Acme Inc. Payments'),
    'Acme Inc. Payments',
  );
  assert.equal(workHubNewSessionName('Create a new Session called No. 5 Login'), 'No. 5 Login');
  assert.equal(
    workHubNewSessionName('Create a new Session called Ph.D. Research'),
    'Ph.D. Research',
  );
  assert.equal(workHubNewSessionName('Create a new Session called App. Fix login'), 'App');
  assert.equal(workHubNewSessionName('Create a new Session called Fix. Add documentation.'), 'Fix');
  assert.equal(workHubNewSessionName('Create a new Session called Go. Then add tests.'), 'Go');
  assert.equal(
    workHubNewSessionName('Create a new Session called Acme Inc. Fix login.'),
    'Acme Inc',
  );
  assert.equal(workHubNewSessionName('Create a new Session called U.S. Fix login.'), 'U.S');
  assert.equal(workHubNewSessionName('Create a new Session called Ph.D. Fix login.'), 'Ph.D');
  assert.equal(workHubNewSessionName('Create a new Session called No. Fix login.'), 'No');
  assert.equal(workHubNewSessionName('Create a new Session called St. Fix login.'), 'St');
  assert.equal(
    workHubNewSessionName('Create a new Session called Acme Inc. Then fix login.'),
    'Acme Inc',
  );
  assert.equal(
    workHubNewSessionName('Create a new Session called Acme Inc. Please fix login.'),
    'Acme Inc',
  );
  assert.equal(
    workHubNewSessionName('Create a new Session called Acme Inc. Please then fix login.'),
    'Acme Inc',
  );
  assert.equal(
    workHubNewSessionName('Create a new Session called Acme Inc. Then, please fix login.'),
    'Acme Inc',
  );
  assert.equal(
    workHubNewSessionName('Create a new Session called Acme Inc. Finally fix login.'),
    'Acme Inc',
  );
  assert.equal(
    workHubNewSessionName('Create a new Session called Acme Inc. Afterwards fix login.'),
    'Acme Inc',
  );
  assert.equal(workHubNewSessionName('Create a new Session called U.S. Can you fix login?'), 'U.S');
  assert.equal(workHubNewSessionName('Create a new Session called U.S. Next, fix login.'), 'U.S');
  assert.equal(workHubNewSessionName('Create a new Session called U.S. Also fix login.'), 'U.S');
  assert.equal(
    workHubNewSessionName('Create a new Session called U.S. Immediately fix login.'),
    'U.S',
  );
  assert.equal(
    workHubNewSessionName('Create a new Session called U.S. Proceed to fix login.'),
    'U.S',
  );
  assert.equal(
    workHubNewSessionName('Create a new Session called U.S. At that point fix login.'),
    'U.S',
  );
  assert.equal(workHubNewSessionName('Create a new Session called U.S. Daily Fix'), 'U.S. Daily Fix');
  assert.equal(
    workHubNewSessionName('Create a new Session called U.S. Monthly Update'),
    'U.S. Monthly Update',
  );
  assert.equal(
    workHubNewSessionName('Create a new Session called U.S. Monthly update'),
    'U.S. Monthly update',
  );
  assert.equal(
    workHubNewSessionName('Create a new Session called U.S. customer update'),
    'U.S. customer update',
  );
  assert.equal(
    workHubNewSessionName('Create a new Session called Ph.D. Could you fix login?'),
    'Ph.D',
  );
  assert.equal(workHubNewSessionName('Create a new Session called Ph.D. Now fix login.'), 'Ph.D');
  assert.equal(
    workHubNewSessionName('Create a new Session called Ph.D. Finally fix login.'),
    'Ph.D',
  );
  assert.equal(workHubNewSessionName('Create a new Session called Ph.D. 接下来修复登录。'), 'Ph.D');
  assert.equal(workHubNewSessionName('Create a new Session called Ph.D. 最后修复登录。'), 'Ph.D');
  assert.equal(
    workHubNewSessionName('Create a new Session called Ph.D. Friendly Fix'),
    'Ph.D. Friendly Fix',
  );
  assert.equal(
    workHubNewSessionName('Create a new Session called Ph.D. Friendly fix'),
    'Ph.D. Friendly fix',
  );
});

test('English routing boilerplate does not make an old analysis look related', async () => {
  const created: string[] = [];
  const sessions = port([
    session('login', {
      sessionName: 'Login Refresh Token',
      latestResult: 'Just analyze the risks and test cases; do not modify any files.',
    }),
  ]);
  sessions.create = async ({ name }) => {
    created.push(name);
    return session('payment-new', { sessionName: name });
  };
  sessions.submit = async () => ({ turnId: 'turn-payment-new' });

  const result = await createWorkHubController({ sessions }).submit({
    requestId: 'english-boilerplate',
    text: "Check payment callback duplicate delivery; just analyze the risks and test cases; don't modify any files.",
  });

  assert.equal(result.kind, 'submitted');
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'new_session');
  assert.deepEqual(created, ['Check payment callback duplicate delivery']);
});

test('negated and deliberative creation language never creates a Session', async () => {
  const created: string[] = [];
  const sessions = port([]);
  sessions.create = async ({ name }) => {
    created.push(name);
    return session('unexpected', { sessionName: name });
  };
  const controller = createWorkHubController({ sessions });

  const negated = await controller.submit({
    requestId: 'negated-create',
    text: '不要创建一个新任务，我们先讨论这个方向。',
  });
  const deliberative = await controller.submit({
    requestId: 'question-create',
    text: '是否应该新建一个任务？',
  });

  assert.equal(negated.kind, 'discussion');
  assert.equal(deliberative.kind, 'discussion');
  assert.deepEqual(created, []);
});

test('polite executable questions and file-level constraints still create new work', () => {
  const cases = [
    'Can you fix login stability?',
    'Can you please fix login?',
    'Could you implement payment retry?',
    'Could you kindly implement payment retry?',
    'If retries fail, can you fix login?',
    'If retries fail can you fix login?',
    'If retries fail then can you fix login?',
    'When retries fail, can you fix login?',
    'If retries fail then fix login?',
    'When retries fail, fix login?',
    'When retries fail fix login?',
    '如果重试失败就请修复登录？',
    'Fix login, but leave documentation unchanged',
    'Fix login, but hold API behavior constant',
    'Fix login, but wait for tests before merging',
    'Create a new Session called App. Fix login',
    'Create a new Session called Fix. Add documentation.',
    'Create a new Session called Go. Then add tests.',
    'Create a new Session called Acme Inc. Fix login.',
    'Create a new Session called U.S. Fix login.',
    'Create a new Session called Ph.D. Fix login.',
    'Create a new Session called No. Fix login.',
    'Create a new Session called St. Fix login.',
    'Create a new Session called Acme Inc. Then fix login.',
    'Create a new Session called Acme Inc. Please fix login.',
    'Create a new Session called U.S. Can you fix login?',
    'Create a new Session called Ph.D. Could you fix login?',
    'Explain the issue, then fix login',
    'Tell me the cause and fix login',
    'Tell me the options and fix login',
    'Recommend options and fix login',
    'Can you fix login, but leave documentation unchanged?',
    'Please try to reproduce and fix login',
    'Try to reproduce and fix login',
    'Work to diagnose and fix login',
    'Explain that issue and fix login',
    'Update the label to How can I help?',
    'Fix copy to say What should I do?',
    'Implement an FAQ answering How can I recover?',
    'Update the prompt to How can I help?',
    'Fix the heading to What should I do?',
    'Update the tooltip to Where can I find files?',
    'Update the message to Why did this fail?',
    'Investigate and fix login',
    'Analyze and fix login',
    'Debug and fix login',
    'Review and update docs',
    'First investigate, then fix login',
    'Assess and fix login',
    'Examine and fix login',
    '调查并修复登录',
    '先分析，然后修复登录',
    'Investigate the issue and fix both login and logout.',
    'Review the failure and fix the affected user accounts.',
    'Analyze the suite and update the generated docs.',
    '先分析，然后修复已经失败的测试。',
    'Investigate and fix login stability.',
    'Review and update API docs.',
    'Analyze and fix payment retry logic.',
    'Audit and update generated API docs.',
    'Investigate issue and fix login for mobile.',
    'Assess logs and update docs for operators.',
    'Review issue and fix login in production.',
    'Discuss the approach, then implement retry',
    'Consider the options, but fix login now',
    '请修复支付回调重复投递？',
    'Fix how login errors are reported',
    'Update how retries are calculated',
    '请修复用户不知道怎么登录的问题',
    '请实现如何恢复失败任务的逻辑',
    'Create a new Session to fix how login errors are reported',
    'Implement docs to explain how retries work',
    'Update the guide to discuss why login fails',
    '修复帮助页以解释如何恢复失败任务',
    'Fix login stability, but do not create any files',
    '修复登录稳定性，但不要创建任何文件',
    'Create a new Session for login, but do not create files',
    'If retries fail, fix login',
    'If tests fail, fix login.',
    'If needed fix login.',
    'If necessary implement retries.',
    'When ready fix login.',
    'If possible fix login.',
    'If required fix login.',
    'If safe fix login.',
    'If appropriate implement retries.',
    'When convenient update docs.',
    'When available fix login.',
    'When feasible fix login.',
    'If desired fix login.',
    'If applicable fix login.',
    'When practical update docs.',
    'If advisable implement retries.',
    'If permitted fix login.',
    'When complete update docs.',
    'If urgent fix login.',
    'When sensible implement retries.',
    'If needed, implement payment retry',
  ];
  for (const text of cases) {
    assert.equal(
      createWorkHubRoutePolicy().resolve({
        text,
        sessions: [],
        originPromptBySessionId: new Map(),
      }).kind,
      'new_session',
      text,
    );
  }
});

test('advisory how-to ambiguity asks for a direct instruction', () => {
  for (const text of [
    'Explain how to fix login, then update the docs.',
    'Tell me how to diagnose login, and fix the bug.',
    '解释如何修复登录，然后更新文档。',
    'Explain how to diagnose login; then fix it.',
    'Explain how to diagnose and reproduce login, then fix it.',
    'Explain how to diagnose the text "do not fix", then update docs.',
    'Explain how to diagnose the text `do not fix`, then update docs.',
    'Explain how to diagnose the text (do not fix), then update docs.',
    'Show me how to diagnose login, then fix it.',
    'Walk me through how to diagnose login, then fix it.',
    '教我如何诊断登录，然后修复它。',
  ]) {
    assert.deepEqual(
      createWorkHubRoutePolicy().resolve({
        text,
        sessions: [],
        originPromptBySessionId: new Map(),
      }),
      { kind: 'clarification', options: [], reason: 'ambiguous_command' },
      text,
    );
  }
});

test('advisory ambiguity overrides explicit, exact-name, and recent-focus routing', () => {
  const login = session('login', { sessionName: 'Login' });
  const text = 'Explain how to diagnose Login, then fix it.';
  const expected = { kind: 'clarification', options: [], reason: 'ambiguous_command' };

  assert.deepEqual(
    createWorkHubRoutePolicy().resolve({
      text,
      sessions: [login],
      originPromptBySessionId: new Map(),
      explicitTarget: login.target,
    }),
    expected,
  );
  assert.deepEqual(
    createWorkHubRoutePolicy().resolve({
      text,
      sessions: [login],
      originPromptBySessionId: new Map(),
    }),
    expected,
  );

  const focusedPolicy = createWorkHubRoutePolicy();
  focusedPolicy.rememberTarget(login.target);
  assert.deepEqual(
    focusedPolicy.resolve({
      text: 'Explain how to diagnose this, then fix it.',
      sessions: [login],
      originPromptBySessionId: new Map(),
    }),
    expected,
  );
});

test('literal negator targets still create new work', () => {
  for (const text of [
    "Create a new Session for parsing don't",
    "Fix parsing of don't",
    'Update the button label to do not',
    '修改按钮文案为不要了',
    "Create a new Session for parsing contractions, e.g. don't",
    'Fix parsing examples, i.e. do not',
    "Create a new Session for parsing contractions, e.g., don't",
    'Fix parsing examples, i.e., do not',
    'Update the button label to:\ndo not',
    "Fix parser support for this token:\ndon't",
    "Fix parser for these literals:\ndon't\ndo not",
    '修改按钮文案为：\n不要了',
    "Create a new Session for parsing this token:\ndon't",
    "Create a new Session to test cases\n1. don't",
    "Fix parser for cases\n1. don't",
    "Create a new Session to test this code\n    don't",
    "Fix parser for this code\n\tdon't",
    "Create a new Session to test list items\n- don't",
    "Fix parser for list items\n- don't",
    "Update parser examples:\n- do\n- don't",
    "Update parser examples:\n1. do\n2. don't",
    "Update parser examples:\n    do\n    don't",
    "Create a new Session for parser examples:\n- do\n- don't",
    "Create a new Session to test parser\n*Examples:*\n- don't",
    "Create a new Session to test parser\n_Examples:_\n- don't",
    'Create a new Session to update copy\n帮我修改按钮文案为：\n不要了',
    '请帮我修改按钮文案为：\n不要了',
    "Fix parser support for foo-don't",
    "Create a new Session for parsing foo-don't",
  ]) {
    assert.equal(
      createWorkHubRoutePolicy().resolve({
        text,
        sessions: [],
        originPromptBySessionId: new Map(),
      }).kind,
      'new_session',
      text,
    );
  }
});

test('withdrawing the requested action keeps the input in WorkHub', () => {
  for (const text of [
    "Fix login stability, actually don't fix it",
    "Fix login stability — actually, don't",
    '修复登录稳定性，还是别了',
    "Fix login, logout, etc. Don't.",
    "Fix login\nDon't.",
    '修复登录稳定性\n还是别了',
    "Fix login stability - don't",
    '修复登录稳定性 - 还是别了',
    "Fix parser tokens:\ndon't\n\nactually, don't",
    "Fix login\nCorrection:\ndon't",
    '修复登录\n更正：\n还是别了',
    "Fix login\nWait:\ndon't",
    '修复登录\n不对：\n还是别了',
    "Fix login\nCorrection note:\n- don't",
    '修复登录\n想了想：\n    还是别了',
    "Fix login\nIn that case:\ndon't",
    "Fix login\nFor example:\ndon't",
    "Fix login\nIn this test case:\ndon't",
    "Fix login\nParser in this case:\ndon't",
    "Fix login\nWith this config value:\ndon't",
    "Create a new Session for login\nConfig in this case:\ndon't",
    "Create a new Session for login\nTesting, for example:\ndon't",
    "Fix login stability, but don't fix it",
    "Fix login stability, but don't do that",
    "Fix login stability, but don't implement it",
    "Implement login stability, but don't fix it",
    "Fix login stability, actually don't fix login stability",
    'Fix login stability, but do not fix login stability',
    'Fix login stability and do not fix login stability',
    "Fix login stability then don't fix login stability",
    'Fix login stability and please do not fix login stability',
    "Fix login stability then kindly don't fix login stability",
    'Fix login stability and could you please not fix login stability',
    '修复登录稳定性，不过不要修复它',
    '修复登录稳定性，但不要修改它',
    '修复登录稳定性，不过不要修复登录稳定性',
    '修复登录稳定性并且不要修复登录稳定性',
    '修复登录稳定性然后请不要修复登录稳定性',
    '修复登录稳定性然后麻烦你不要修复登录稳定性',
    '修复登录稳定性然后真的不要修复登录稳定性',
    'Fix login stability and just do not fix login stability',
    "Fix login stability and simply don't fix login stability",
    '修复登录稳定性然后千万不要修复登录稳定性',
    'Do not create a new Session to fix login stability',
    '不要创建一个新的 Session 来修复登录稳定性',
    'Do not create a new Session. Fix login stability',
  ]) {
    assert.equal(
      createWorkHubRoutePolicy().resolve({
        text,
        sessions: [],
        originPromptBySessionId: new Map(),
      }).kind,
      'discussion',
      text,
    );
  }
});

test('a later affirmative clause creates work after withdrawing an earlier action', () => {
  for (const text of [
    "Fix login, but don't do that; instead implement payment retry",
    '修复登录，但不要这样做；而是实现支付重试',
    "Fix login, but don't do that. Implement payment retry",
    "Create a new Session for login, but don't do that; instead implement payment retry",
    '创建一个新的 Session 处理登录，不过不要这样做；而是实现支付重试',
    'Fix login and do not fix login documentation',
    'Fix checkout, but do not fix checkout tests',
    '修复登录，但不要修复登录文档',
    'Update API documentation, but do not update API',
    'Fix checkout tests, but do not fix checkout',
    '修复登录文档，但不要修复登录',
  ]) {
    assert.equal(
      createWorkHubRoutePolicy().resolve({
        text,
        sessions: [],
        originPromptBySessionId: new Map(),
      }).kind,
      'new_session',
      text,
    );
  }
});

test('a correction with a negated creation tail never proposes a new Session', () => {
  const login = session('login', { sessionName: 'Login 登录稳定性', updatedAt: 20 });
  const payment = session('payment', { sessionName: 'Payment 支付稳定性', updatedAt: 30 });
  const cases = [
    '不是这个，换成登录稳定性，不要创建新会话',
    'Wrong session; switch to Login; do not create a new session',
    'Wrong session; switch to Login without creating a new session',
    '不是这个，而是不要真的创建一个新的 Session',
    'Wrong session; do not actually create a new Session',
    '不是这个，而是不要在没有我确认的情况下创建一个新的 Session',
    'Wrong session; do not under any circumstances whatsoever ever create a new session',
    'Wrong session; create a note and do not ever create a new session',
    '不是这个，而是请勿创建一个新的 Session',
    '我不想创建一个新的 Session',
    '我不打算创建一个新的 Session',
    '我不是要创建一个新的 Session，只是讨论',
    '我并非要创建一个新的 Session，只是讨论',
    '不是想创建一个新的 Session，只是问问',
    '我不是让你创建一个新的 Session，只是讨论',
    '我不是说要创建一个新的 Session，只是讨论',
    '并非让你创建一个新的 Session，只是讨论',
    '我没让你创建一个新的 Session，只是讨论',
    '我没有让你创建一个新的 Session，只是讨论',
    '我不希望你创建一个新的 Session，只是讨论',
    '我不是请你创建一个新的 Session，只是讨论',
    '我没说要创建一个新的 Session，只是讨论',
    '我没有说要创建一个新的 Session，只是讨论',
    '我没有打算创建一个新的 Session，只是讨论',
    '我没准备创建一个新的 Session，只是讨论',
    'Please refuse to create a new Session',
    'I decline to create a new Session; just discuss',
    '我未打算创建一个新的 Session，只是讨论',
    'I will not create a new session',
    'not create a new session; just discuss',
    'Under no circumstances create a new session',
    'Create a new Session; do not create a new Session',
    '创建一个新的 Session；不要创建一个新的 Session',
    "Create a new Session, but don't create it",
    "Create a new Session for login — actually, don't",
    '创建一个新的 Session 处理登录，还是别了',
    "Create a new Session to fix login, logout, etc. Don't.",
    "Create a new Session for login\nDon't.",
    "Create a new Session for login - don't",
    "Create a new Session for parser tokens:\ndon't\n\nactually, don't",
    "Create a new Session for login\nCorrection:\ndon't",
    "Create a new Session for login\nFinal correction:\ndon't",
    "Create a new Session for login\nCorrection:\n- don't",
    "Create a new Session for login\nCorrection:\n1. don't",
    "Create a new Session for login\nCorrection:\n    don't",
    '创建一个新的 Session 处理登录\n更正：\n- 还是别了',
    "Create a new Session for login\nCorrection note:\n- don't",
    "Create a new Session for login\nOn second thought:\n1. don't",
    '创建一个新的 Session 处理登录\n想了想：\n    还是别了',
    "Create a new Session for login\n## Correction:\n- don't",
    "Create a new Session for login\n**Correction:**\n- don't",
    '创建一个新的 Session 处理登录\n## 更正：\n- 还是别了',
    "Create a new Session for login\nChange to:\n- don't",
    "Create a new Session for login\nUpdate to:\ndon't",
    "Create a new Session for login\nCorrection to:\n1. don't",
    '创建一个新的 Session 处理登录\n改为：\n- 还是别了',
    "Create a new Session for login\nIn any case:\ndon't",
    "Create a new Session for parser examples:\n- do\n    \n- don't",
    "Create a new Session for parser examples:\n1. do\n\t\n2. don't",
    "Create a new Session for login\nFor this parser case:\ndon't",
    "Create a new Session, but don't create one after all",
    '创建一个新的 Session，不过不要创建它',
    '不是这个，而是创建一个新的 Session；不要创建一个新的 Session',
    'Wrong session; don’t ever create a new session',
    'Wrong session; do not, under any circumstances, create a new session',
    '不是这个，而是创建一个新的 Session；不过不要这样做',
    'No examples create a new Session.',
    'This note says no, create a new Session called Payments',
    "No, create a new Session for login but don't",
    'No, please explain how to create a new Session',
    'No, tell me how to create a new Session',
    '不对，请解释如何创建一个新的 Session',
    '错了，请告诉我怎么创建一个新的 Session',
  ];

  for (const text of cases) {
    const policy = createWorkHubRoutePolicy();
    policy.rememberTarget(payment.target);
    const decision = policy.resolve({
      text,
      sessions: [login, payment],
      originPromptBySessionId: new Map(),
    });

    assert.notEqual(decision.kind, 'new_session', text);
  }
});

test('a pronoun correction uses the shared affirmative target span', () => {
  const source = session('source', { sessionName: 'Source', updatedAt: 30 });
  const payments = session('payments', { sessionName: 'Payments', updatedAt: 20 });
  const policy = createWorkHubRoutePolicy();
  policy.rememberTarget(source.target);

  assert.deepEqual(
    policy.resolve({
      text: 'Not this session; move it to Payments',
      sessions: [source, payments],
      originPromptBySessionId: new Map(),
    }),
    {
      kind: 'target',
      target: payments.target,
      evidence: 'route_correction',
      correctedFrom: source.target,
    },
  );
});

test('correction routing preserves quoted and punctuated Session identities', () => {
  const source = session('source', { sessionName: 'Source', updatedAt: 30 });
  for (const [text, target] of [
    ['No, use "Payments"', session('payments', { sessionName: 'Payments', updatedAt: 20 })],
    [
      'No, use Research and Development',
      session('research', { sessionName: 'Research and Development', updatedAt: 20 }),
    ],
    [
      'No, use Payments, Retry',
      session('payment-retry', { sessionName: 'Payments, Retry', updatedAt: 20 }),
    ],
    ['不是这个，换成“支付任务”', session('payment', { sessionName: '支付任务', updatedAt: 20 })],
  ] as const) {
    const policy = createWorkHubRoutePolicy();
    policy.rememberTarget(source.target);
    const decision = policy.resolve({
      text,
      sessions: [source, target],
      originPromptBySessionId: new Map(),
    });
    assert.equal(decision.kind, 'target', text);
    assert.equal(decision.kind === 'target' ? decision.target.sessionId : undefined, target.target.sessionId);
    assert.equal(decision.kind === 'target' ? decision.evidence : undefined, 'route_correction');
  }
});

test('a negated existing-target correction never proposes destructive replacement', () => {
  const login = session('login', { sessionName: 'Login 登录稳定性', updatedAt: 20 });
  const payment = session('payment', { sessionName: 'Payment 支付任务', updatedAt: 30 });
  for (const text of [
    "Not this session; don't move it to Login",
    '不是这个会话，但不要转到登录稳定性',
    "Not this session; move to Login, but I don't want to move anymore",
    '不是这个会话，转到登录稳定性，不过我不想转了',
    'No examples use Login.',
    'This note says no, use Login',
    "No, use Login but don't",
    "No, use Login and actually don't",
    "No, use Login and don't want to move it",
    "No, use Login and don't proceed",
    "No, use Login and don't go ahead with that",
    'No, use Login, forget it',
    'No, use Login, on second thought leave it',
    '不是这个会话，转到登录稳定性然后不想转了',
    '不是这个会话，转到登录稳定性然后不要继续',
    '不是这个会话，转到登录稳定性，当我没说',
    '不是这个会话，转到登录稳定性，还是维持原样',
    'No, use Login, fix payments. Forget it',
    'No, use Login — on second thought leave it',
    '不是这个会话，转到登录稳定性，修复支付。当我没说',
  ]) {
    const policy = createWorkHubRoutePolicy();
    policy.rememberTarget(payment.target);
    const decision = policy.resolve({
      text,
      sessions: [login, payment],
      originPromptBySessionId: new Map(),
    });
    assert.notEqual(decision.kind, 'new_session', text);
    if (decision.kind === 'target') {
      assert.equal(decision.target.sessionId, payment.target.sessionId, text);
      assert.notEqual(decision.evidence, 'route_correction', text);
      assert.equal(decision.correctedFrom, undefined, text);
    }
  }
});

test('indirect questions containing action words stay in WorkHub', () => {
  for (const text of [
    '我想知道如何修复登录问题',
    '我们应该如何修复登录问题',
    'Please explain how to fix login',
    'Tell me how to fix login',
    'I would like to understand how to fix login',
    '麻烦解释如何修复登录问题',
    '请告诉我如何修复登录问题',
    'Show me how to fix login',
    'Could you walk me through how to fix login',
    'What steps should I take to fix login',
    '教我怎么修复登录问题',
    '给我讲讲如何修复登录问题',
    'Can you tell me if we should fix login?',
    'Could you evaluate if we should implement payment retry?',
    '请告诉我该不该修复登录问题？',
    '请告诉我应不应该实现支付重试？',
    'Can you give me steps to fix login',
    'Please give me a way to fix login',
    'Could you outline the steps to fix login',
    '告诉我修复登录的步骤',
    '给我一个修复登录的方法',
    'Can you tell me: should I fix login?',
    'Can you recommend I fix login?',
    '请告诉我：我应该修复登录吗？',
    '请告诉我应否修复登录？',
    'Can you tell me if I need to fix login',
    'Could you tell me if I must implement retry',
    'I need to know if I need to fix login',
    '请告诉我我应否修复登录',
    'Can you fix login, or should we wait?',
    'Can you fix login? Actually, should we?',
    'Can you fix login, or should we wait',
    'Can you fix login. Actually, should we',
    '请修复登录，还是应该先等等？',
    '请修复登录，还是应该先等等',
    'Can you fix login, or leave it for now?',
    '请修复登录，还是等等吧？',
    'Fix login. Maybe we should wait',
    'Fix login. On second thought, maybe wait',
    'Can you tell me if it is necessary to fix login',
    'Explain when to fix login',
    'Tell me in which cases to fix login',
    '请告诉我在什么情况下修复登录',
    'Fix login, but maybe we should wait',
    'Fix login; perhaps we should wait',
    '请修复登录，不过也许应该等等',
    'Fix login. Actually, I am not sure.',
    'Fix login. Do you think we should?',
    "Fix login. On second thought, I'm not sure",
    '请修复登录。我不确定。',
    'Can you recommend I fix login',
    'Could you suggest I implement retry',
    'Explain the circumstances in which to fix login',
    'Tell me the best time to fix login',
    'When should I fix login?',
    'When do we fix login?',
    '如果什么时候修复登录？',
    'If unsure whether to fix login?',
    'When in doubt, ask whether to fix login?',
    'If it is unclear how to implement retry?',
    'When is it appropriate to fix login?',
    '如果适合修复登录？',
    'Fix login. Is that wise?',
    'Fix login, cancel this task.',
    'Fix login, I take that back.',
    'Create a new Session for Payments; cancel the creation.',
    'Create a new Session for Payments. Cancel the new session.',
    '创建一个新会话用于支付然后停止创建。',
    'Fix login, cancel this job.',
    'Fix login, withdraw the request.',
    'Fix login, retract that.',
    'Fix login, forget the request.',
    'Create a new Session for Payments; cancel my request.',
    'Create a new Session for Payments; withdraw that request.',
    'Create a new Session for Payments. Revoke that request.',
    'When might we fix login?',
    'When may we fix login?',
    'When will we fix login?',
    'If it makes sense to fix login?',
    '如果现在修复登录合适吗？',
    'Fix login. Are we sure?',
    'Fix login. Are you sure?',
    'Fix login. Are they sure?',
    'Fix login. Should we really?',
    'Fix login, cancel the current task.',
    'Fix login, rescind my request.',
    'Fix login, drop this task.',
    'Fix login. Please cancel the task.',
    'Fix login. I want to cancel the task.',
    'Fix login. Could you cancel the task?',
    "Fix login. Let's cancel the task.",
    'Fix login. I would prefer to cancel the task.',
    'Fix login. Please do not proceed with the task.',
    'Fix login. I do not wish to proceed.',
    'When should the service fix login?',
    'When will Alice fix login?',
    'When will the patch fix login?',
    'When must the service fix login?',
    'When ought we fix login?',
    'If you think we should fix login?',
    'If you believe we ought to implement retry?',
    'If it is advisable to fix login?',
    'If I wanted you to fix login, what would happen?',
    'If I asked you to fix login, how would you approach it?',
    'If the plan were to fix login, would that be wise?',
    'If I asked you to fix login?',
    'If I wanted you to fix login?',
    'If the plan were to fix login?',
    'If I wanted you to fix login what would happen?',
    'If I asked you to fix login how would you approach it?',
    'If the plan were to fix login would that be wise?',
    '如果现在修复登录可以吗？',
    '如果现在修复登录可行吗？',
    '如果我让你修复登录会怎样？',
    'Fix login. Do you agree?',
    'Fix login. Are you certain?',
    'Fix login. Do you still want that?',
    'Fix login — do you agree?',
    'Fix login: are you sure?',
    'Fix login, okay?',
    'Fix login, sound good?',
    'Fix login, maybe?',
    'Fix login, perhaps?',
    'Fix login, not sure?',
    'Fix login, any concerns?',
    '修复登录，没问题吧？',
    'Could you suggest ways to monitor and fix login',
    'Explain techniques that diagnose and fix login errors.',
    'Discuss approaches that prevent and fix login errors.',
    'Explain the steps to diagnose and fix login.',
    'Explain strategies that diagnose and fix login.',
    'Recommend patterns that detect and fix login.',
    'Could you suggest practical options to monitor and fix login',
    'Tell me possible solutions to identify and fix login',
    'Describe techniques that diagnose and fix login.',
    'Analyze strategies that diagnose and fix login.',
    'Explain a process where we diagnose and fix login.',
    'Describe a framework that diagnoses and fix login.',
    'Outline a workflow that detects and fix login.',
    'Summarize a proposal where we diagnose and fix login.',
    'Compare tools that detect and fix login.',
    'I plan to fix login myself.',
    'The team will fix login.',
    'Suppose we fix login.',
    'If we fix login, users will be happier.',
    'When we fix login, users will be happier.',
    '如果我们修复登录，用户会更满意。',
    'If the team can fix login, users will be happier.',
    'If Alice can fix login, users will be happier.',
    '如果团队能修复登录，用户会更满意。',
    'Should we fix login and then update docs?',
    'Can we diagnose login and then fix it?',
    'What if we fix login and then update docs?',
    'Maybe investigate and fix login.',
    'Perhaps review and update docs.',
    'Potentially debug and fix login.',
    'Our goal is to investigate and fix login.',
    'The requirement is to investigate and fix login.',
    'The service must diagnose and fix login.',
    'Should we diagnose, then fix login?',
    'How should we fix login, then update docs?',
    'Explain how to fix login and then update docs.',
    'Tell me how to diagnose and then fix login.',
    'Can you explain how to diagnose login and then fix it?',
    'Explain whether we should diagnose then fix login.',
    'Discuss whether to diagnose then fix login.',
    'Tell me how we should diagnose then fix login.',
    'Explain how to diagnose, fix, and test login.',
    'Recommend ways to diagnose, fix, and test login.',
    'Explain how to diagnose login, fix it, and update docs.',
    'Explain whether we should diagnose, then fix login.',
    'Explain the workflow: diagnose, then fix login.',
    'Discuss the sequence: diagnose, then fix login.',
    'Review notes and fix status are attached.',
    'Audit results and fix plans are attached.',
    'Research findings and fix recommendations are attached.',
    'Explain how to diagnose login; then fix it. Is that wise?',
    'Explain how to diagnose login, then fix it—but is that wise?',
    'Explain how to diagnose the text "login, then fix it".',
    'Explain how to diagnose a phrase saying "login; then fix it".',
    'Explain how to diagnose login, and test results are attached.',
    'Explain how to diagnose login; then test results are available.',
    'Audit findings and fix recommendations both matter.',
    'Research findings and fix recommendations changed yesterday.',
    '分析报告并修复建议已经附上。',
    '调查结果并修复建议都很重要。',
    'Explain how to diagnose the text `login, then fix it`.',
    'Explain how to diagnose the sequence (login, then fix it).',
    'Explain how to diagnose login; then fix it, any concerns?',
    'Explain how to diagnose login; then fix it, do you agree?',
    'Audit findings and fix recommendations matter.',
    'Review notes and fix status matters.',
    'Research findings and fix recommendations changed.',
    'Explain how to diagnose login; then test results matter.',
    'Explain how to diagnose login; then test coverage improved.',
    'Explain how to diagnose login; then update metrics increased.',
    'Explain how to diagnose the text "login, then fix it.',
    'Explain how to diagnose the text `login, then fix it.',
    'Explain how to diagnose the sequence (login (primary), then fix it).',
    'Explain how to diagnose the sequence [login, then fix it].',
  ]) {
    assert.equal(
      createWorkHubRoutePolicy().resolve({
        text,
        sessions: [],
        originPromptBySessionId: new Map(),
      }).kind,
      'discussion',
      text,
    );
  }
});

test('a fuzzy correction target never becomes destructive routing authority', () => {
  const source = session('source', { sessionName: 'Source', updatedAt: 30 });
  const paymentCallback = session('payment-callback', {
    sessionName: '支付回调',
    updatedAt: 20,
  });
  const policy = createWorkHubRoutePolicy();
  policy.rememberTarget(source.target);

  const decision = policy.resolve({
    text: '不是这个，换成支付页面',
    sessions: [source, paymentCallback],
    originPromptBySessionId: new Map(),
  });

  assert.notEqual(decision.kind, 'new_session');
  if (decision.kind === 'target') {
    assert.equal(decision.target.sessionId, source.target.sessionId);
    assert.notEqual(decision.evidence, 'route_correction');
    assert.equal(decision.correctedFrom, undefined);
  }
});

test('a candidate name cannot absorb unquoted withdrawal semantics', () => {
  const source = session('source', { sessionName: 'Source', updatedAt: 30 });
  for (const [text, sessionName] of [
    ["No, use Payments and don't proceed", "Payments and don't proceed"],
    ['不是这个，转到支付任务然后不要继续', '支付任务然后不要继续'],
    ['No, use Payments and stop.', 'Payments and stop'],
    ['不是这个，转到支付任务然后停止。', '支付任务然后停止'],
    ['No, use Payments and abort.', 'Payments and abort'],
    ['No, use Payments and cancel.', 'Payments and cancel'],
    ['No, use Payments and stop now.', 'Payments and stop now'],
    ['No, use Payments and halt this.', 'Payments and halt this'],
    ['No, use Payments and ABORT.', 'Payments and ABORT'],
    ['No, use Payments but abort.', 'Payments but abort'],
    ['No, use Payments; stop now.', 'Payments; stop now'],
    ['No, use Payments. Abort.', 'Payments. Abort'],
    ['No, use Payments, cancel.', 'Payments, cancel'],
    ['不是这个，转到支付任务然后作罢。', '支付任务然后作罢'],
    ['不是这个，转到支付任务然后停止执行。', '支付任务然后停止执行'],
    ['不是这个，转到支付任务但是作罢。', '支付任务但是作罢'],
    ['不是这个，转到支付任务。作罢。', '支付任务。作罢'],
    ['No, use Payments. I changed my mind.', 'Payments. I changed my mind'],
    [
      'No, use Payments. On second thought, keep it here.',
      'Payments. On second thought, keep it here',
    ],
    ['不是这个，转到支付任务。我改主意了。', '支付任务。我改主意了'],
  ] as const) {
    const candidate = session('candidate', { sessionName, updatedAt: 20 });
    const policy = createWorkHubRoutePolicy();
    policy.rememberTarget(source.target);
    const decision = policy.resolve({
      text,
      sessions: [source, candidate],
      originPromptBySessionId: new Map(),
    });
    assert.notEqual(decision.kind === 'target' ? decision.evidence : undefined, 'route_correction');
  }
});

test('malformed or unbound creation naming stays in WorkHub discussion', () => {
  for (const text of [
    'Create a new Session called "Payments',
    '创建一个新会话叫“支付任务',
    "No, don't create a new session called Login; instead create a new session for Payments",
    "Create a new Session called Payments and don't proceed.",
    '创建一个新会话叫支付任务然后不要继续。',
    'Create a new Session called Payments and stop.',
    'Create a new Session called Payments and abort.',
    'Create a new Session called Payments and cancel.',
    'Create a new Session called Payments and stop now.',
    'Create a new Session called Payments and halt this operation immediately.',
    'Create a new Session called Payments and ABORT.',
    'Create a new Session called Payments but abort.',
    'Create a new Session called Payments; stop now.',
    'Create a new Session called Payments. Abort.',
    'Create a new Session called Payments, cancel.',
    '创建一个新会话叫支付任务然后作罢。',
    '创建一个新会话叫支付任务然后停止执行。',
    '创建一个新会话叫支付任务但是作罢。',
    '创建一个新会话叫支付任务。作罢。',
    'No, create a new Session called Payments. Example: create a new Session called Fraud.',
    'Create a new Session called Payments.Example: create a new Session called Fraud',
    'Create a new Session called App. Example: create a new Session called Fraud',
    'No, create a new Session called Payments. Fix login, cancel this task.',
  ]) {
    assert.equal(
      createWorkHubRoutePolicy().resolve({
        text,
        sessions: [],
        originPromptBySessionId: new Map(),
      }).kind,
      'discussion',
      text,
    );
  }
});

test('subscribe exposes Session invalidations without inventing WorkHub state', () => {
  let listener: (() => void) | undefined;
  let unsubscribed = false;
  const sessions = port([]);
  sessions.subscribe = (handler) => {
    listener = handler;
    return () => {
      unsubscribed = true;
    };
  };
  const controller = createWorkHubController({ sessions });
  let invalidations = 0;

  const unsubscribe = controller.subscribe(() => {
    invalidations += 1;
  });
  listener?.();
  unsubscribe();

  assert.equal(invalidations, 1);
  assert.equal(unsubscribed, true);
});
