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
import {
  createWorkHubController as createGatedWorkHubController,
  WORKHUB_ROUTING_STRATEGY_ID,
  type WorkHubSessionFacts,
  type WorkHubSessionPort,
  type WorkHubCoordinationTurn,
} from '../../renderer/workhub-controller.js';

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
      delegationId: 'delegation-1',
      targetSessionId: 'payment',
      targetSessionName: 'Payments',
      targetMessageId: 'payment-message',
      targetTurnId: 'payment-turn',
      feedbackState: 'accepted',
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
        handler([assignment]);
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
        handler([coordinationAssignmentTurn()]);
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

test('production defers destructive correction until persistent delegation exists', async () => {
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
        throw new Error('incomplete correction must not reach the Action Gate');
      },
    },
  });

  await assert.rejects(
    controller.submit({
      requestId: 'deferred-correction',
      text: 'No, use target instead',
      explicitTarget: { sessionId: 'target' },
      correction: { from: { sessionId: 'source' }, turnId: 'source-turn' },
    }),
    /linked correction requires persistent delegation support/u,
  );
  assert.deepEqual(actions, []);
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

test('production natural-language correction fails closed before a second delegation', async () => {
  const actions: unknown[] = [];
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
        return {
          disposition: 'delegate_existing',
          targetSessionId: input.proposal.disposition === 'delegate_existing' &&
              input.proposal.candidateRef === 'candidate-login'
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

  await assert.rejects(
    controller.submit({
      requestId: 'production-natural-correction',
      text: '不是这个，换成登录那个，补充刷新令牌失败判定',
    }),
    /linked correction requires persistent delegation support/u,
  );

  for (const [requestId, text] of PRODUCTION_CORRECTION_CREATION_CASES) {
    await assert.rejects(
      controller.submit({ requestId, text }),
      /linked correction requires persistent delegation support/u,
    );
  }

  assert.deepEqual(actions, [{
    actionId: 'production-wrong-payment',
    userText: '继续这个工作，补充验收项',
    candidateSetId,
    proposal: {
      disposition: 'delegate_existing',
      candidateRef: 'candidate-payment',
    },
  }]);
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
