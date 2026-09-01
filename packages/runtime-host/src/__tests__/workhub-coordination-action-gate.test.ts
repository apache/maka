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
import { describe, test } from 'node:test';
import type {
  WorkHubDelegationAssignedMessage,
  WorkHubDelegationReplacementAbortedMessage,
  WorkHubDelegationReplacementRequestedMessage,
  WorkHubDelegationSupersededMessage,
} from '@maka/core/session';
import {
  WorkHubActionEffectFailure,
  WorkHubActionGateFailure,
  WorkHubCoordinationActionGate,
  isExplicitWorkHubCorrectionText,
  type WorkHubActionGateEffects,
  type WorkHubActionGateSession,
  type WorkHubDelegationAssignmentInput,
  type WorkHubDelegationReplacementAbortInput,
  type WorkHubDelegationReplacementInput,
} from '../server/workhub-coordination-action-gate.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const CONTEXT: ConnectionContext = {
  hostEpoch: 'workhub-action-gate-test',
  connectionId: 'workhub-action-gate-client',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

describe('WorkHub Coordination Action Gate', () => {
  test('trusted correction text binds complete target and title identities', () => {
    for (const [text, targetName] of [
      ['No, use "Payments"', 'Payments'],
      ['不是这个，换成“支付任务”', '支付任务'],
      ['No, use Research and Development', 'Research and Development'],
      ['No, use Payments, Retry', 'Payments, Retry'],
    ] as const) {
      assert.equal(isExplicitWorkHubCorrectionText(text, 'delegate_existing', targetName), true);
    }
    for (const text of [
      "No, use Payments and don't proceed",
      "No, use Payments and don't go ahead with that",
      'No, use Payments, forget it',
      'No, use Payments, on second thought leave it',
      '不是这个，转到支付任务然后不要继续',
      '不是这个，换成支付任务，当我没说',
      '不是这个，换成支付任务，还是维持原样',
      'No, use Payments, fix login. Forget it',
      'No, use Payments — on second thought leave it',
      '不是这个，换成支付任务，修复登录。当我没说',
    ]) {
      assert.equal(isExplicitWorkHubCorrectionText(text, 'delegate_existing', 'Payments'), false);
      assert.equal(isExplicitWorkHubCorrectionText(text, 'delegate_existing', '支付任务'), false);
    }
    assert.equal(
      isExplicitWorkHubCorrectionText(
        "No, use Payments and don't proceed",
        'delegate_existing',
        "Payments and don't proceed",
      ),
      false,
    );
    assert.equal(
      isExplicitWorkHubCorrectionText(
        '不是这个，转到支付任务然后不要继续',
        'delegate_existing',
        '支付任务然后不要继续',
      ),
      false,
    );
    assert.equal(
      isExplicitWorkHubCorrectionText(
        'No, use Payments and stop.',
        'delegate_existing',
        'Payments and stop',
      ),
      false,
    );
    assert.equal(
      isExplicitWorkHubCorrectionText(
        '不是这个，转到支付任务然后停止。',
        'delegate_existing',
        '支付任务然后停止',
      ),
      false,
    );
    for (const [text, targetName] of [
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
      assert.equal(isExplicitWorkHubCorrectionText(text, 'delegate_existing', targetName), false);
    }
    for (const text of [
      'No, create a new Session titled Login instead',
      'No, create a new Session with title Login',
      '不对，请创建一个新的 Session 标题为登录稳定性',
      '错了，新建一个会话名称为登录稳定性',
    ]) {
      assert.equal(isExplicitWorkHubCorrectionText(text, 'create_new', 'Payments'), false, text);
    }
    assert.equal(
      isExplicitWorkHubCorrectionText(
        "No, don't create a new session called Login; instead create a new session called Payments.",
        'create_new',
        'Payments',
      ),
      true,
    );
    const incidentalNamedExample =
      'No, create a new Session called Payments, and add documentation containing the example new Session called Fraud.';
    assert.equal(
      isExplicitWorkHubCorrectionText(incidentalNamedExample, 'create_new', 'Payments'),
      true,
    );
    assert.equal(
      isExplicitWorkHubCorrectionText(incidentalNamedExample, 'create_new', 'Fraud'),
      false,
    );
    for (const [text, targetName] of [
      ['No, create a new Session called U.S. Payments', 'U.S. Payments'],
      ['No, create a new Session called Dr. Login', 'Dr. Login'],
      ['No, create a new Session called Acme Inc. Payments', 'Acme Inc. Payments'],
      ['No, create a new Session called No. 5 Login', 'No. 5 Login'],
      ['No, create a new Session called Ph.D. Research', 'Ph.D. Research'],
      ['No, create a new Session called Payments. Fix login', 'Payments'],
      ['No, create a new Session called App. Fix login', 'App'],
      ['No, create a new Session called Fix. Add documentation.', 'Fix'],
      ['No, create a new Session called Go. Then add tests.', 'Go'],
      ['No, create a new Session called Acme Inc. Fix login.', 'Acme Inc'],
      ['No, create a new Session called U.S. Fix login.', 'U.S'],
      ['No, create a new Session called Ph.D. Fix login.', 'Ph.D'],
      ['No, create a new Session called No. Fix login.', 'No'],
      ['No, create a new Session called St. Fix login.', 'St'],
      ['No, create a new Session called Acme Inc. Then fix login.', 'Acme Inc'],
      ['No, create a new Session called Acme Inc. Please fix login.', 'Acme Inc'],
      ['No, create a new Session called Acme Inc. Please then fix login.', 'Acme Inc'],
      ['No, create a new Session called Acme Inc. Then, please fix login.', 'Acme Inc'],
      ['No, create a new Session called Acme Inc. Finally fix login.', 'Acme Inc'],
      ['No, create a new Session called Acme Inc. Afterwards fix login.', 'Acme Inc'],
      ['No, create a new Session called U.S. Can you fix login?', 'U.S'],
      ['No, create a new Session called U.S. Next, fix login.', 'U.S'],
      ['No, create a new Session called U.S. Also fix login.', 'U.S'],
      ['No, create a new Session called U.S. Immediately fix login.', 'U.S'],
      ['No, create a new Session called U.S. Proceed to fix login.', 'U.S'],
      ['No, create a new Session called U.S. At that point fix login.', 'U.S'],
      ['No, create a new Session called U.S. Daily Fix', 'U.S. Daily Fix'],
      ['No, create a new Session called U.S. Monthly Update', 'U.S. Monthly Update'],
      ['No, create a new Session called U.S. Monthly update', 'U.S. Monthly update'],
      ['No, create a new Session called U.S. customer update', 'U.S. customer update'],
      ['No, create a new Session called Ph.D. Could you fix login?', 'Ph.D'],
      ['No, create a new Session called Ph.D. Now fix login.', 'Ph.D'],
      ['No, create a new Session called Ph.D. Finally fix login.', 'Ph.D'],
      ['No, create a new Session called Ph.D. 接下来修复登录。', 'Ph.D'],
      ['No, create a new Session called Ph.D. 最后修复登录。', 'Ph.D'],
      ['No, create a new Session called Ph.D. Friendly Fix', 'Ph.D. Friendly Fix'],
      ['No, create a new Session called Ph.D. Friendly fix', 'Ph.D. Friendly fix'],
    ] as const) {
      assert.equal(isExplicitWorkHubCorrectionText(text, 'create_new', targetName), true, text);
    }
    for (const text of [
      "No, don't create a new session called Login; instead create a new session for Payments",
      'No, create a new Session called "Payments',
      '不对，创建一个新会话叫“支付任务',
      "No, create a new Session called Payments and don't proceed.",
      '不对，创建一个新会话叫支付任务然后不要继续。',
      'No, create a new Session called Payments and stop.',
      'No, create a new Session called Payments and abort.',
      'No, create a new Session called Payments and cancel.',
      'No, create a new Session called Payments and stop now.',
      'No, create a new Session called Payments and halt this operation immediately.',
      'No, create a new Session called Payments and ABORT.',
      'No, create a new Session called Payments but abort.',
      'No, create a new Session called Payments; stop now.',
      'No, create a new Session called Payments. Abort.',
      'No, create a new Session called Payments, cancel.',
      '不对，创建一个新会话叫支付任务然后作罢。',
      '不对，创建一个新会话叫支付任务然后停止执行。',
      '不对，创建一个新会话叫支付任务但是作罢。',
      '不对，创建一个新会话叫支付任务。作罢。',
      'No, create a new Session called Payments. Example: create a new Session called Fraud.',
      'No, create a new Session called Payments.Example: create a new Session called Fraud.',
      'No, create a new Session called App. Example: create a new Session called Fraud.',
      'No, create a new Session called Payments. Fix login, cancel this task.',
      'No, create a new Session called Payments. Cancel the current task.',
      'No, create a new Session called Payments. Rescind my request.',
      'No, create a new Session called Payments. Drop this task.',
      'No, create a new Session called Payments. Fix login. Please cancel the task.',
      "No, create a new Session called Payments. Fix login. Let's cancel the task.",
      'No, create a new Session called Payments. I do not wish to proceed.',
    ]) {
      assert.equal(isExplicitWorkHubCorrectionText(text, 'create_new', 'Login'), false, text);
      assert.equal(isExplicitWorkHubCorrectionText(text, 'create_new', 'Payments'), false, text);
    }
  });

  test('exposes only bounded ordinary candidates and opaque refs', async () => {
    const effects = fakeEffects([
      session('ordinary'),
      session('archived', { isArchived: true }),
      session('waiting', { status: 'waiting_for_user' }),
      session('side', { labels: ['mode:side_conversation'] }),
      session('child', {
        subagentParent: {
          kind: 'subagent',
          parentSessionId: 'ordinary',
          spawnedBy: { parentTurnId: 'turn', parentRunId: 'run', toolCallId: 'tool' },
          lifecycle: 'foreground',
        },
      }),
      session('maka_workhub_coordination', { role: 'workhub_coordination' }),
    ]);
    const result = await new WorkHubCoordinationActionGate(effects).candidates();
    assert.deepEqual(
      result.candidates.map(({ sessionId }) => sessionId),
      ['ordinary', 'waiting'],
    );
    assert.match(result.candidateSetId, /^sha256:[a-f0-9]{64}$/u);
    assert.notEqual(result.candidates[0]?.candidateRef, 'ordinary');

    const bounded = await new WorkHubCoordinationActionGate(
      fakeEffects(Array.from({ length: 40 }, (_, index) => session(`ordinary-${index}`))),
    ).candidates();
    assert.equal(bounded.candidates.length, 32);
  });

  test('rejects stale candidates before assignment', async () => {
    const effects = fakeEffects([session('payments')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    effects.sessions[0] = session('payments', { lastMessageAt: 9 });
    await assert.rejects(
      gate.act(
        {
          actionId: 'stale',
          userText: 'Continue payments',
          candidateSetId: snapshot.candidateSetId,
          proposal: {
            disposition: 'delegate_existing',
            candidateRef: snapshot.candidates[0]!.candidateRef,
          },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'candidate_set_stale',
    );
    assert.equal(effects.assignments.length, 0);

    const refreshed = await gate.candidates();
    const retried = await gate.act(
      {
        actionId: 'stale',
        userText: 'Continue payments',
        candidateSetId: refreshed.candidateSetId,
        proposal: {
          disposition: 'delegate_existing',
          candidateRef: refreshed.candidates[0]!.candidateRef,
        },
      },
      CONTEXT,
    );
    assert.equal(retried.disposition, 'delegate_existing');

    const current = await gate.candidates();
    await assert.rejects(
      gate.act(
        {
          actionId: 'invented',
          userText: 'Continue payments',
          candidateSetId: current.candidateSetId,
          proposal: { disposition: 'delegate_existing', candidateRef: 'invented_candidate' },
        },
        CONTEXT,
      ),
      (error) =>
        error instanceof WorkHubActionGateFailure && error.code === 'candidate_unavailable',
    );
    assert.equal(effects.assignments.length, 1);
  });

  test('rejects waiting targets independently of strategy behavior', async () => {
    const effects = fakeEffects([session('waiting', { status: 'waiting_for_user' })]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    await assert.rejects(
      gate.act(
        {
          actionId: 'waiting',
          userText: 'Continue',
          candidateSetId: snapshot.candidateSetId,
          proposal: {
            disposition: 'delegate_existing',
            candidateRef: snapshot.candidates[0]!.candidateRef,
          },
        },
        CONTEXT,
      ),
      (error) =>
        error instanceof WorkHubActionGateFailure && error.code === 'target_waiting_for_user',
    );
  });

  test('answers and clarifies only through Coordination effects', async () => {
    const effects = fakeEffects([session('ordinary')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    await gate.act(
      { actionId: 'answer', userText: 'Summarize', proposal: { disposition: 'answer_here' } },
      CONTEXT,
    );
    await gate.act(
      {
        actionId: 'clarify',
        userText: 'Which one?',
        proposal: { disposition: 'clarify', assistantText: 'Choose a Session' },
      },
      CONTEXT,
    );
    assert.equal(effects.answers.length, 1);
    assert.equal(effects.clarifications.length, 1);
    assert.equal(effects.assignments.length, 0);
  });

  test('delegates through one assignment effect', async () => {
    const effects = fakeEffects([session('payments', { name: 'Payments' })]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    const result = await gate.act(
      {
        actionId: 'delegate',
        userText: 'Continue payments',
        candidateSetId: snapshot.candidateSetId,
        proposal: {
          disposition: 'delegate_existing',
          candidateRef: snapshot.candidates[0]!.candidateRef,
        },
      },
      CONTEXT,
    );
    assert.deepEqual(result, {
      disposition: 'delegate_existing',
      targetSessionId: 'payments',
      targetTurnId: 'turn-delegate',
    });
    assert.equal(effects.assignments[0]!.targetSessionName, 'Payments');
    assert.equal(effects.assignments[0]!.userText, 'Continue payments');
  });

  test('rejects ambiguous advisory text before delegating to an existing Session', async () => {
    const effects = fakeEffects([session('login', { name: 'Login' })]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();

    await assert.rejects(
      gate.act(
        {
          actionId: 'ambiguous-delegate',
          userText: 'Explain how to diagnose Login, then fix it.',
          candidateSetId: snapshot.candidateSetId,
          proposal: {
            disposition: 'delegate_existing',
            candidateRef: snapshot.candidates[0]!.candidateRef,
          },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(effects.assignments.length, 0);
  });

  test('create_new carries creation context into the same assignment', async () => {
    const effects = fakeEffects([]);
    const gate = new WorkHubCoordinationActionGate(effects);
    await assert.rejects(
      gate.act(
        {
          actionId: 'missing-create-context',
          userText: 'Create an accessibility audit',
          proposal: { disposition: 'create_new', title: 'Accessibility audit' },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    const input = {
      actionId: 'create',
      userText: 'Create an accessibility audit',
      proposal: { disposition: 'create_new' as const, title: 'Accessibility audit' },
      create: { workspace: { kind: 'host_path' as const, path: '/workspace' } },
    };
    const first = await gate.act(input, CONTEXT);
    const replay = await gate.act(input, CONTEXT);
    assert.deepEqual(replay, first);
    assert.equal(effects.assignments.length, 1);
    const restartedReplay = await new WorkHubCoordinationActionGate(effects).act(input, CONTEXT);
    assert.deepEqual(restartedReplay, first);
    assert.equal(effects.assignments.length, 2);
    assert.deepEqual(effects.assignments[0], effects.assignments[1]);
    assert.match(effects.assignments[0]!.targetSessionId, /^whs_[a-f0-9]{48}$/u);
    assert.deepEqual(effects.assignments[0]!.create, {
      title: 'Accessibility audit',
      workspace: input.create.workspace,
    });
    await assert.rejects(
      gate.act({ ...input, proposal: { disposition: 'create_new', title: 'Different' } }, CONTEXT),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(effects.assignments.length, 2);
  });

  test('initial creation rejects negated executable intent at the host gate', async () => {
    const negatedCreationCases = [
      '请勿创建一个新的 Session',
      'Don’t ever create a new session',
      'Do not, under any circumstances, create a new session',
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
      '创建一个新的 Session；不过不要这样做',
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
      '我想知道如何修复登录问题',
      '我们应该如何修复登录问题',
      'Please explain how to fix login',
      'Tell me how to fix login',
      'I would like to understand how to fix login',
      '麻烦解释如何修复登录问题',
      '请告诉我如何修复登录问题',
      'Can you tell me if we should fix login?',
      'Could you evaluate if we should implement payment retry?',
      '请告诉我该不该修复登录问题？',
      '请告诉我应不应该实现支付重试？',
      'Can you give me steps to fix login',
      'Please give me a way to fix login',
      'Could you outline the steps to fix login',
      '告诉我修复登录的步骤',
      '给我一个修复登录的方法',
      'Create a new Session called Login',
      'Create a new Session called "Payments',
      '创建一个新会话叫“支付任务',
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
    ];
    for (const [index, userText] of negatedCreationCases.entries()) {
      const effects = fakeEffects([]);
      await assert.rejects(
        new WorkHubCoordinationActionGate(effects).act(
          {
            actionId: `negated-initial-create-${index}`,
            userText,
            proposal: { disposition: 'create_new', title: 'New Session' },
            create: { workspace: { kind: 'host_path', path: '/workspace' } },
          },
          CONTEXT,
        ),
        (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
      );
      assert.equal(effects.assignments.length, 0);
    }
  });

  test('initial creation accepts polite executable requests and file-level constraints', async () => {
    const cases = [
      'Can you fix login stability?',
      'Can you please fix login?',
      'Could you kindly implement payment retry?',
      'If retries fail, can you fix login?',
      'If retries fail can you fix login?',
      'If retries fail then can you fix login?',
      'When retries fail, can you fix login?',
      'If retries fail then fix login?',
      'When retries fail, fix login?',
      'When retries fail fix login?',
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
      '如果重试失败就请修复登录？',
      'Fix login, but leave documentation unchanged',
      'Fix login, but hold API behavior constant',
      'Fix login, but wait for tests before merging',
      'Explain the issue, then fix login',
      'Tell me the cause and fix login',
      'Discuss the approach, then implement retry',
      'Consider the options, but fix login now',
      '请修复支付回调重复投递？',
      'Fix login stability, but do not create any files',
      '修复登录稳定性，但不要创建任何文件',
      'Create a new Session for login, but do not create files',
      'Implement docs to explain how retries work',
      'Update the guide to discuss why login fails',
      '修复帮助页以解释如何恢复失败任务',
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
    ];
    for (const [index, userText] of cases.entries()) {
      const effects = fakeEffects([]);
      const result = await new WorkHubCoordinationActionGate(effects).act(
        {
          actionId: `affirmative-initial-create-${index}`,
          userText,
          proposal: { disposition: 'create_new', title: 'New Work' },
          create: { workspace: { kind: 'host_path', path: '/workspace' } },
        },
        CONTEXT,
      );
      assert.equal(result.disposition, 'create_new', userText);
      assert.equal(effects.assignments.length, 1, userText);
    }
  });

  test('initial creation rejects advisory how-to ambiguity at the host gate', async () => {
    for (const [index, userText] of [
      'Explain how to fix login, then update the docs.',
      'Tell me how to diagnose login, and fix the bug.',
      '解释如何修复登录，然后更新文档。',
      'Explain how to diagnose login; then fix it.',
      'Explain how to diagnose and reproduce login, then fix it.',
      'Explain how to diagnose the text "do not fix", then update docs.',
      'Explain how to diagnose the text `do not fix`, then update docs.',
      'Explain how to diagnose the text (do not fix), then update docs.',
    ].entries()) {
      const effects = fakeEffects([]);
      await assert.rejects(
        new WorkHubCoordinationActionGate(effects).act(
          {
            actionId: `ambiguous-initial-create-${index}`,
            userText,
            proposal: { disposition: 'create_new', title: 'New Work' },
            create: { workspace: { kind: 'host_path', path: '/workspace' } },
          },
          CONTEXT,
        ),
        (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
      );
      assert.equal(effects.assignments.length, 0, userText);
    }
  });

  test('initial creation accepts literal negator targets', async () => {
    for (const [index, userText] of [
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
    ].entries()) {
      const effects = fakeEffects([]);
      const result = await new WorkHubCoordinationActionGate(effects).act(
        {
          actionId: `literal-initial-create-${index}`,
          userText,
          proposal: { disposition: 'create_new', title: 'New Work' },
          create: { workspace: { kind: 'host_path', path: '/workspace' } },
        },
        CONTEXT,
      );
      assert.equal(result.disposition, 'create_new', userText);
      assert.equal(effects.assignments.length, 1, userText);
    }
  });

  test('replacement creation requires an affirmative correction at the host gate', async () => {
    const effects = fakeEffects([session('source')]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'a'.repeat(64)}`,
          targetSessionId: 'source',
          targetSessionName: 'source',
          disposition: 'delegate_existing',
          userText: 'Original work',
        },
        'source-turn',
      ),
    );

    const negatedCreationCases = [
      'Create a new Session for login',
      'No examples create a new Session.',
      'This note says no, create a new Session called Payments',
      "No, create a new Session for login but don't",
      'No, please explain how to create a new Session',
      'No, tell me how to create a new Session',
      '不对，请解释如何创建一个新的 Session',
      '错了，请告诉我怎么创建一个新的 Session',
      '不是这个，而是不要真的创建一个新的 Session',
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
      "Create a new Session for login\nConfig in this case:\ndon't",
      "Create a new Session for login\nTesting, for example:\ndon't",
      "Create a new Session, but don't create one after all",
      '创建一个新的 Session，不过不要创建它',
      '不是这个，而是创建一个新的 Session；不要创建一个新的 Session',
      'Wrong session; don’t ever create a new session',
      'Wrong session; do not, under any circumstances, create a new session',
      '不是这个，而是创建一个新的 Session；不过不要这样做',
    ];
    for (const [index, userText] of negatedCreationCases.entries()) {
      await assert.rejects(
        new WorkHubCoordinationActionGate(effects).act(
          {
            actionId: `negated-replacement-create-${index}`,
            userText,
            confirmation: { kind: 'user_correction' },
            proposal: {
              disposition: 'replace',
              replacesActionId: 'source-action',
              target: { disposition: 'create_new', title: 'New Session' },
            },
            create: { workspace: { kind: 'host_path', path: '/workspace' } },
          },
          CONTEXT,
        ),
        (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
      );
    }
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        {
          actionId: 'mismatched-named-replacement-create',
          userText: 'No, create a new Session called Login instead',
          confirmation: { kind: 'user_correction' },
          proposal: {
            disposition: 'replace',
            replacesActionId: 'source-action',
            target: { disposition: 'create_new', title: 'Payments' },
          },
          create: { workspace: { kind: 'host_path', path: '/workspace' } },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(effects.replacements.size, 0);
    assert.equal(effects.retirements.length, 0);
  });

  test('replacement rejects a negated existing-target action before retiring the source', async () => {
    const effects = fakeEffects([session('source'), session('payments')]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'a'.repeat(64)}`,
          targetSessionId: 'source',
          targetSessionName: 'source',
          disposition: 'delegate_existing',
          userText: 'Original work',
        },
        'source-turn',
      ),
    );
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    const candidateRef = snapshot.candidates.find(
      (candidate) => candidate.sessionId === 'payments',
    )!.candidateRef;

    for (const [index, userText] of [
      "Not this session; don't move it to Payments",
      '不是这个会话，但不要转到支付任务',
      "Not this session; move to Payments, but I don't want to move anymore",
      '不是这个会话，转到支付任务，不过我不想转了',
      'No examples use Payments.',
      'This note says no, use Payments',
      "No, use Payments but don't",
      "No, use Payments and actually don't",
      "No, use Payments and don't want to move it",
      "No, use Payments and don't proceed",
      "No, use Payments and don't go ahead with that",
      'No, use Payments, forget it',
      'No, use Payments, on second thought leave it',
      '不是这个，转到支付任务然后不想转了',
      '不是这个，转到支付任务然后不要继续',
      '不是这个，转到支付任务，当我没说',
      '不是这个，转到支付任务，还是维持原样',
      'No, use red instead',
    ].entries()) {
      await assert.rejects(
        gate.act(
          {
            actionId: `negated-existing-replacement-${index}`,
            userText,
            candidateSetId: snapshot.candidateSetId,
            confirmation: { kind: 'user_correction' },
            proposal: {
              disposition: 'replace',
              replacesActionId: 'source-action',
              target: { disposition: 'delegate_existing', candidateRef },
            },
          },
          CONTEXT,
        ),
        (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
      );
    }
    assert.equal(effects.replacements.size, 0);
    assert.equal(effects.retirements.length, 0);
    assert.equal(effects.assignments.length, 0);
  });

  test('replacement requires the complete affirmed target identity', async () => {
    const effects = fakeEffects([
      session('source'),
      session('api', { name: 'API' }),
      session('payment', { name: 'Payment' }),
      session('login', { name: 'Login' }),
      session('login-backend', { name: 'Login backend' }),
      session('api-client', { name: 'API client' }),
      session('payment-callback', { name: '支付回调' }),
      session('login-stability', { name: '登录稳定性' }),
      session('payment-task', { name: '支付任务' }),
    ]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'a'.repeat(64)}`,
          targetSessionId: 'source',
          targetSessionName: 'source',
          disposition: 'delegate_existing',
          userText: 'Original work',
        },
        'source-turn',
      ),
    );
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    for (const [index, { userText, targetId }] of [
      { userText: 'No, use rapid instead', targetId: 'api' },
      { userText: 'No, use Repayment instead', targetId: 'payment' },
      { userText: 'No, use Payments, not Login', targetId: 'login' },
      { userText: 'No, use Payments instead of Login', targetId: 'login' },
      { userText: 'No, move it to Login frontend', targetId: 'login-backend' },
      { userText: 'No, move it to API docs', targetId: 'api-client' },
      { userText: '不是这个，换成支付页面', targetId: 'payment-callback' },
      { userText: '不是这个，换成登录文档', targetId: 'login-stability' },
      { userText: '不是这个，转到支付回调', targetId: 'payment-task' },
    ].entries()) {
      const candidateRef = snapshot.candidates.find(
        (candidate) => candidate.sessionId === targetId,
      )!.candidateRef;
      await assert.rejects(
        gate.act(
          {
            actionId: `mismatched-existing-replacement-${index}`,
            userText,
            candidateSetId: snapshot.candidateSetId,
            confirmation: { kind: 'user_correction' },
            proposal: {
              disposition: 'replace',
              replacesActionId: 'source-action',
              target: { disposition: 'delegate_existing', candidateRef },
            },
          },
          CONTEXT,
        ),
        (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
      );
    }
    assert.equal(effects.retirements.length, 0);
    assert.equal(effects.assignments.length, 0);
  });

  test('replacement creation records a terminal abort when admission fails after retirement', async () => {
    const effects = fakeEffects([session('source')]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'a'.repeat(64)}`,
          targetSessionId: 'source',
          targetSessionName: 'source',
          disposition: 'delegate_existing',
          userText: 'Original work',
        },
        'source-turn',
      ),
    );
    effects.assign = async () => {
      throw new WorkHubActionEffectFailure('internal_failure', 'creation admission failed');
    };
    const input = {
      actionId: 'failed-replacement-create',
      userText: 'No, create a new Session for Payments instead',
      confirmation: { kind: 'user_correction' as const },
      proposal: {
        disposition: 'replace' as const,
        replacesActionId: 'source-action',
        target: { disposition: 'create_new' as const, title: 'Payments' },
      },
      create: { workspace: { kind: 'host_path' as const, path: '/workspace' } },
    };

    await assert.rejects(new WorkHubCoordinationActionGate(effects).act(input, CONTEXT));
    assert.equal(effects.retirements.length, 1);
    assert.equal(
      effects.replacementAborts.get('delegation-source-action')?.reason,
      'target_unavailable',
    );
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(input, CONTEXT),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
  });

  test('one in-memory action identity cannot change payload', async () => {
    const effects = fakeEffects([session('payments'), session('login', { lastMessageAt: 1 })]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    const input = {
      actionId: 'same-action',
      userText: 'Continue payments',
      candidateSetId: snapshot.candidateSetId,
      proposal: {
        disposition: 'delegate_existing' as const,
        candidateRef: snapshot.candidates[0]!.candidateRef,
      },
    };
    await gate.act(input, CONTEXT);
    await assert.rejects(
      gate.act({ ...input, userText: 'Different work' }, CONTEXT),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    await assert.rejects(
      gate.act(
        {
          ...input,
          proposal: {
            disposition: 'delegate_existing',
            candidateRef: snapshot.candidates[1]!.candidateRef,
          },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
  });

  test('an assignment rejection releases the action identity for retry', async () => {
    const effects = fakeEffects([session('payments')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    const input = {
      actionId: 'permission-rejected',
      userText: 'Continue payments',
      candidateSetId: snapshot.candidateSetId,
      proposal: {
        disposition: 'delegate_existing' as const,
        candidateRef: snapshot.candidates[0]!.candidateRef,
      },
    };
    const assign = effects.assign;
    effects.assign = async () => {
      throw new WorkHubActionEffectFailure('unauthorized', 'Target permission denied');
    };
    await assert.rejects(
      gate.act(input, CONTEXT),
      (error) => error instanceof WorkHubActionEffectFailure && error.code === 'unauthorized',
    );
    effects.assign = assign;
    assert.equal((await gate.act(input, CONTEXT)).disposition, 'delegate_existing');
  });

  test('replays an ordinary delegation without assigning twice', async () => {
    const effects = fakeEffects([session('payments')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    const input = {
      actionId: 'delegate-replay',
      userText: 'Continue payments',
      candidateSetId: snapshot.candidateSetId,
      proposal: {
        disposition: 'delegate_existing' as const,
        candidateRef: snapshot.candidates[0]!.candidateRef,
      },
    };

    const first = await gate.act(input, CONTEXT);
    const replay = await gate.act(input, CONTEXT);

    assert.deepEqual(replay, first);
    assert.equal(effects.assignments.length, 1);
  });

  test('rejects a changed candidate when replaying an action after restart', async () => {
    const effects = fakeEffects([session('payments'), session('login')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    const payments = snapshot.candidates.find((candidate) => candidate.sessionId === 'payments')!;
    const login = snapshot.candidates.find((candidate) => candidate.sessionId === 'login')!;
    const input = {
      actionId: 'delegate-restart-conflict',
      userText: 'Continue the work',
      candidateSetId: snapshot.candidateSetId,
      proposal: {
        disposition: 'delegate_existing' as const,
        candidateRef: payments.candidateRef,
      },
    };

    await gate.act(input, CONTEXT);

    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        {
          ...input,
          proposal: { ...input.proposal, candidateRef: login.candidateRef },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(effects.assignments.length, 1);
  });

  test('replaces only an explicitly confirmed durable delegation', async () => {
    const effects = fakeEffects([session('source'), session('destination')]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'a'.repeat(64)}`,
          targetSessionId: 'source',
          targetSessionName: 'source',
          disposition: 'delegate_existing',
          userText: 'Wrong target',
        },
        'source-turn',
      ),
    );
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    const destination = snapshot.candidates.find(
      (candidate) => candidate.sessionId === 'destination',
    )!;
    const input = {
      actionId: 'replacement-action',
      userText: 'No, send this to destination',
      candidateSetId: snapshot.candidateSetId,
      proposal: {
        disposition: 'replace' as const,
        replacesActionId: 'source-action',
        target: {
          disposition: 'delegate_existing' as const,
          candidateRef: destination.candidateRef,
        },
      },
    };

    await assert.rejects(
      gate.act(input, CONTEXT),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    await assert.rejects(
      gate.act(
        {
          ...input,
          userText: 'Send this to destination',
          confirmation: { kind: 'user_correction' as const },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    await assert.rejects(
      gate.act(
        {
          ...input,
          userText: 'No, keep going with the current work',
          confirmation: { kind: 'user_correction' as const },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    const result = await gate.act(
      { ...input, confirmation: { kind: 'user_correction' as const } },
      CONTEXT,
    );

    assert.deepEqual(result, {
      disposition: 'replace',
      replacementDisposition: 'delegate_existing',
      targetSessionId: 'destination',
      targetTurnId: 'turn-replacement-action',
    });
    assert.equal(effects.replacements.size, 1);
    assert.equal(effects.retirements[0]?.actionId, 'source-action');
    assert.equal(effects.assignments[0]?.replacesActionId, 'source-action');
    assert.equal(
      effects.supersessions.get('delegation-source-action')?.actionId,
      'replacement-action',
    );
  });

  test('recovers a prepared replacement after retirement and before assignment', async () => {
    const effects = fakeEffects([session('source'), session('destination'), session('other')]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'b'.repeat(64)}`,
          targetSessionId: 'source',
          targetSessionName: 'source',
          disposition: 'delegate_existing',
          userText: 'Wrong target',
        },
        'source-turn',
      ),
    );
    const snapshot = await new WorkHubCoordinationActionGate(effects).candidates();
    const input = {
      actionId: 'recover-replacement',
      userText: 'Not this session; move it to destination',
      candidateSetId: snapshot.candidateSetId,
      confirmation: { kind: 'user_correction' as const },
      proposal: {
        disposition: 'replace' as const,
        replacesActionId: 'source-action',
        target: {
          disposition: 'delegate_existing' as const,
          candidateRef: snapshot.candidates.find(
            (candidate) => candidate.sessionId === 'destination',
          )!.candidateRef,
        },
      },
    };
    const assign = effects.assign;
    effects.assign = async () => {
      throw new WorkHubActionEffectFailure('internal_failure', 'simulated crash seam');
    };

    await assert.rejects(new WorkHubCoordinationActionGate(effects).act(input, CONTEXT));
    assert.equal(effects.replacements.has('delegation-source-action'), true);
    assert.equal(effects.retirements.length, 1);
    assert.equal(effects.assignmentRecords.has(input.actionId), false);

    effects.sessions = effects.sessions.map((candidate) =>
      candidate.id === 'destination' ? { ...candidate, name: 'Renamed destination' } : candidate,
    );
    const refreshed = await new WorkHubCoordinationActionGate(effects).candidates();
    const refreshedDestination = refreshed.candidates.find(
      (candidate) => candidate.sessionId === 'destination',
    )!;
    effects.assign = assign;
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        {
          ...input,
          candidateSetId: refreshed.candidateSetId,
          proposal: {
            ...input.proposal,
            target: {
              ...input.proposal.target,
              candidateRef: refreshed.candidates.find(
                (candidate) => candidate.sessionId === 'other',
              )!.candidateRef,
            },
          },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(effects.retirements.length, 1);
    const recovered = await new WorkHubCoordinationActionGate(effects).act(
      {
        ...input,
        candidateSetId: refreshed.candidateSetId,
        proposal: {
          ...input.proposal,
          target: {
            ...input.proposal.target,
            candidateRef: refreshedDestination.candidateRef,
          },
        },
      },
      CONTEXT,
    );
    assert.equal(recovered.disposition, 'replace');
    assert.equal(effects.retirements.length, 1);
    assert.equal(effects.assignmentRecords.has(input.actionId), true);
    assert.equal(effects.supersessions.has('delegation-source-action'), true);
  });

  test('refreshes replacement target display identity after retiring the source', async () => {
    const effects = fakeEffects([
      session('source'),
      session('destination', { name: 'Destination' }),
    ]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'d'.repeat(64)}`,
          targetSessionId: 'source',
          targetSessionName: 'source',
          disposition: 'delegate_existing',
          userText: 'Wrong target',
        },
        'source-turn',
      ),
    );
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    const destination = snapshot.candidates.find(
      (candidate) => candidate.sessionId === 'destination',
    )!;
    const retireDelegation = effects.retireDelegation;
    effects.retireDelegation = async (assignment) => {
      await retireDelegation.call(effects, assignment);
      effects.sessions = effects.sessions.map((candidate) =>
        candidate.id === 'destination' ? { ...candidate, name: 'Renamed destination' } : candidate,
      );
    };
    const assign = effects.assign;
    effects.assign = async (input) => {
      const current = effects.sessions.find((candidate) => candidate.id === input.targetSessionId);
      if (current?.name !== input.targetSessionName) {
        throw new WorkHubActionEffectFailure(
          'internal_failure',
          'Target Session changed before replacement assignment',
        );
      }
      return assign.call(effects, input);
    };

    const result = await gate.act(
      {
        actionId: 'rename-race',
        userText: 'No, move this to destination',
        candidateSetId: snapshot.candidateSetId,
        confirmation: { kind: 'user_correction' },
        proposal: {
          disposition: 'replace',
          replacesActionId: 'source-action',
          target: {
            disposition: 'delegate_existing',
            candidateRef: destination.candidateRef,
          },
        },
      },
      CONTEXT,
    );
    assert.equal(result.disposition, 'replace');
    assert.equal(effects.retirements.length, 1);
    assert.equal(effects.assignments[0]?.targetSessionName, 'Renamed destination');
  });

  for (const lifecycle of ['archived', 'waiting'] as const) {
    test(`records a terminal abort when the replacement target becomes ${lifecycle} after retirement`, async () => {
      const effects = fakeEffects([session('source'), session('destination')]);
      effects.assignmentRecords.set(
        'source-action',
        assignmentRecord(
          {
            actionId: 'source-action',
            actionFingerprint: `sha256:${'e'.repeat(64)}`,
            targetSessionId: 'source',
            targetSessionName: 'source',
            disposition: 'delegate_existing',
            userText: 'Wrong target',
          },
          'source-turn',
        ),
      );
      const gate = new WorkHubCoordinationActionGate(effects);
      const snapshot = await gate.candidates();
      const destination = snapshot.candidates.find(
        (candidate) => candidate.sessionId === 'destination',
      )!;
      const retireDelegation = effects.retireDelegation;
      effects.retireDelegation = async (assignment) => {
        await retireDelegation.call(effects, assignment);
        effects.sessions = effects.sessions.map((candidate) =>
          candidate.id !== 'destination'
            ? candidate
            : lifecycle === 'archived'
              ? { ...candidate, isArchived: true }
              : { ...candidate, status: 'waiting_for_user' },
        );
      };
      const input = {
        actionId: `target-became-${lifecycle}`,
        userText: 'No, move this to destination',
        candidateSetId: snapshot.candidateSetId,
        confirmation: { kind: 'user_correction' as const },
        proposal: {
          disposition: 'replace' as const,
          replacesActionId: 'source-action',
          target: {
            disposition: 'delegate_existing' as const,
            candidateRef: destination.candidateRef,
          },
        },
      };

      await assert.rejects(
        gate.act(input, CONTEXT),
        (error) =>
          error instanceof WorkHubActionGateFailure &&
          error.code ===
            (lifecycle === 'archived' ? 'candidate_unavailable' : 'target_waiting_for_user'),
      );
      assert.equal(effects.retirements.length, 1);
      assert.equal(effects.assignments.length, 0);
      assert.equal(
        effects.replacementAborts.get('delegation-source-action')?.reason,
        lifecycle === 'archived' ? 'target_unavailable' : 'target_waiting_for_user',
      );

      effects.sessions = effects.sessions.map((candidate) =>
        candidate.id === 'destination'
          ? { ...candidate, isArchived: false, status: 'active' }
          : candidate,
      );
      await assert.rejects(
        new WorkHubCoordinationActionGate(effects).act(input, CONTEXT),
        (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
      );
      assert.equal(effects.retirements.length, 1);
    });
  }

  test('retry records an abort when the process crashed after source retirement', async () => {
    const effects = fakeEffects([session('source'), session('destination')]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'e'.repeat(64)}`,
          targetSessionId: 'source',
          targetSessionName: 'source',
          disposition: 'delegate_existing',
          userText: 'Wrong target',
        },
        'source-turn',
      ),
    );
    const snapshot = await new WorkHubCoordinationActionGate(effects).candidates();
    const destination = snapshot.candidates.find(
      (candidate) => candidate.sessionId === 'destination',
    )!;
    const input = {
      actionId: 'crashed-after-retirement',
      userText: 'No, move this to destination',
      candidateSetId: snapshot.candidateSetId,
      confirmation: { kind: 'user_correction' as const },
      proposal: {
        disposition: 'replace' as const,
        replacesActionId: 'source-action',
        target: {
          disposition: 'delegate_existing' as const,
          candidateRef: destination.candidateRef,
        },
      },
    };
    const retireDelegation = effects.retireDelegation;
    effects.retireDelegation = async (assignment) => {
      await retireDelegation.call(effects, assignment);
      throw new Error('simulated process exit after retirement');
    };

    await assert.rejects(new WorkHubCoordinationActionGate(effects).act(input, CONTEXT));
    effects.sessions = effects.sessions.map((candidate) =>
      candidate.id === 'destination' ? { ...candidate, isArchived: true } : candidate,
    );

    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(input, CONTEXT),
      (error) =>
        error instanceof WorkHubActionGateFailure && error.code === 'candidate_unavailable',
    );
    assert.equal(effects.retirements.length, 1);
    assert.equal(
      effects.replacementAborts.get('delegation-source-action')?.reason,
      'target_unavailable',
    );
  });

  test('the first durable correction intent owns a delegation', async () => {
    const effects = fakeEffects([session('source'), session('first'), session('second')]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'c'.repeat(64)}`,
          targetSessionId: 'source',
          targetSessionName: 'source',
          disposition: 'delegate_existing',
          userText: 'Start source work',
        },
        'source-turn',
      ),
    );
    const snapshot = await new WorkHubCoordinationActionGate(effects).candidates();
    const inputFor = (actionId: string, targetId: string) => ({
      actionId,
      userText: `No, use ${targetId} instead`,
      candidateSetId: snapshot.candidateSetId,
      confirmation: { kind: 'user_correction' as const },
      proposal: {
        disposition: 'replace' as const,
        replacesActionId: 'source-action',
        target: {
          disposition: 'delegate_existing' as const,
          candidateRef: snapshot.candidates.find((candidate) => candidate.sessionId === targetId)!
            .candidateRef,
        },
      },
    });
    const assign = effects.assign;
    effects.assign = async () => {
      throw new WorkHubActionEffectFailure('internal_failure', 'hold after durable intent');
    };
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        inputFor('first-correction', 'first'),
        CONTEXT,
      ),
    );
    effects.assign = assign;
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        inputFor('second-correction', 'second'),
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(
      effects.replacements.get('delegation-source-action')?.actionId,
      'first-correction',
    );
  });
});

function session(
  id: string,
  patch: Partial<WorkHubActionGateSession> = {},
): WorkHubActionGateSession {
  return {
    id,
    cwd: '/workspace',
    projectId: null,
    createdAt: 1,
    lastMessageAt: 2,
    name: id,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 2,
    ...patch,
  };
}

function fakeEffects(initialSessions: WorkHubActionGateSession[]) {
  const durable = new Map<
    string,
    { input: WorkHubDelegationAssignmentInput; result: { turnId: string } }
  >();
  const assignmentRecords = new Map<string, WorkHubDelegationAssignedMessage>();
  const replacements = new Map<string, WorkHubDelegationReplacementRequestedMessage>();
  const replacementAborts = new Map<string, WorkHubDelegationReplacementAbortedMessage>();
  const supersessions = new Map<string, WorkHubDelegationSupersededMessage>();
  return {
    sessions: [...initialSessions],
    answers: [] as Array<{ turnId: string; text: string }>,
    clarifications: [] as Array<{
      turnId: string;
      userText: string;
      assistantText: string;
    }>,
    assignments: [] as WorkHubDelegationAssignmentInput[],
    assignmentRecords,
    replacements,
    replacementAborts,
    supersessions,
    retirements: [] as WorkHubDelegationAssignedMessage[],
    async listSessions() {
      return this.sessions;
    },
    async readAssignment(actionId: string) {
      return assignmentRecords.get(actionId);
    },
    async readReplacement(delegationId: string) {
      return replacements.get(delegationId);
    },
    async readReplacementAbort(delegationId: string) {
      return replacementAborts.get(delegationId);
    },
    async readSupersession(delegationId: string) {
      return supersessions.get(delegationId);
    },
    async answer(input: { turnId: string; text: string }) {
      this.answers.push(input);
    },
    async clarify(input: { turnId: string; userText: string; assistantText: string }) {
      this.clarifications.push(input);
    },
    async assign(input: WorkHubDelegationAssignmentInput) {
      this.assignments.push(input);
      const existing = durable.get(input.actionId);
      if (existing) {
        assert.deepEqual(existing.input, input);
        return existing.result;
      }
      const result = { turnId: `turn-${input.actionId}` };
      durable.set(input.actionId, { input, result });
      const record = assignmentRecord(input, result.turnId);
      assignmentRecords.set(input.actionId, record);
      if (input.replacesDelegationId) {
        supersessions.set(input.replacesDelegationId, {
          type: 'workhub_coordination',
          id: `superseded-${input.actionId}`,
          turnId: input.actionId,
          ts: 3,
          schemaVersion: 2,
          kind: 'delegation_superseded',
          actionId: input.actionId,
          actionFingerprint: input.actionFingerprint,
          coordinationTurnId: input.actionId,
          supersededActionId: input.replacesActionId!,
          supersededDelegationId: input.replacesDelegationId,
          replacementDelegationId: record.delegationId,
        });
      }
      return result;
    },
    async prepareReplacement(input: WorkHubDelegationReplacementInput) {
      const existing = replacements.get(input.replacesDelegationId);
      if (existing) return existing;
      const replacement: WorkHubDelegationReplacementRequestedMessage = {
        type: 'workhub_coordination',
        id: `replacement-${input.actionId}`,
        turnId: input.actionId,
        ts: 2,
        schemaVersion: 2,
        kind: 'delegation_replacement_requested',
        actionId: input.actionId,
        actionFingerprint: input.actionFingerprint,
        coordinationTurnId: input.actionId,
        targetSessionId: input.targetSessionId,
        targetSessionName: input.targetSessionName,
        disposition: input.disposition,
        userText: input.userText,
        ...(input.create ? { create: input.create } : {}),
        replacesActionId: input.replacesActionId,
        replacesDelegationId: input.replacesDelegationId,
        replacedTargetSessionId: input.replacedTargetSessionId,
        replacedTargetMessageId: input.replacedTargetMessageId,
      };
      replacements.set(input.replacesDelegationId, replacement);
      return replacement;
    },
    async abortReplacement(input: WorkHubDelegationReplacementAbortInput) {
      const replacement = input.replacement;
      const existing = replacementAborts.get(replacement.replacesDelegationId);
      if (existing) return existing;
      const aborted: WorkHubDelegationReplacementAbortedMessage = {
        type: 'workhub_coordination',
        id: `aborted-${replacement.actionId}`,
        turnId: replacement.actionId,
        ts: 4,
        schemaVersion: 2,
        kind: 'delegation_replacement_aborted',
        actionId: replacement.actionId,
        actionFingerprint: replacement.actionFingerprint,
        coordinationTurnId: replacement.actionId,
        abortedActionId: replacement.replacesActionId,
        abortedDelegationId: replacement.replacesDelegationId,
        targetSessionId: replacement.targetSessionId,
        reason: input.reason,
      };
      replacementAborts.set(replacement.replacesDelegationId, aborted);
      return aborted;
    },
    async readDelegationRetirement(assignment: WorkHubDelegationAssignedMessage) {
      return this.retirements.some((retired) => retired.delegationId === assignment.delegationId)
        ? ('retired' as const)
        : ('not_retired' as const);
    },
    async retireDelegation(assignment: WorkHubDelegationAssignedMessage) {
      this.retirements.push(assignment);
    },
  } satisfies WorkHubActionGateEffects & {
    sessions: WorkHubActionGateSession[];
    answers: Array<{ turnId: string; text: string }>;
    clarifications: Array<{ turnId: string; userText: string; assistantText: string }>;
    assignments: WorkHubDelegationAssignmentInput[];
    assignmentRecords: Map<string, WorkHubDelegationAssignedMessage>;
    replacements: Map<string, WorkHubDelegationReplacementRequestedMessage>;
    replacementAborts: Map<string, WorkHubDelegationReplacementAbortedMessage>;
    supersessions: Map<string, WorkHubDelegationSupersededMessage>;
    retirements: WorkHubDelegationAssignedMessage[];
  };
}

function assignmentRecord(
  input: WorkHubDelegationAssignmentInput,
  targetTurnId: string,
): WorkHubDelegationAssignedMessage {
  return {
    type: 'workhub_coordination',
    id: `assignment-${input.actionId}`,
    turnId: input.actionId,
    ts: 1,
    schemaVersion: input.replacesDelegationId ? 2 : 1,
    kind: 'delegation_assigned',
    actionId: input.actionId,
    actionFingerprint: input.actionFingerprint,
    coordinationTurnId: input.actionId,
    targetSessionId: input.targetSessionId,
    targetSessionName: input.targetSessionName,
    targetTurnId,
    targetMessageId: `message-${input.actionId}`,
    delegationId: `delegation-${input.actionId}`,
    disposition: input.disposition,
    userText: input.userText,
    ...(input.create ? { create: input.create } : {}),
    ...(input.replacesActionId ? { replacesActionId: input.replacesActionId } : {}),
    ...(input.replacesDelegationId ? { replacesDelegationId: input.replacesDelegationId } : {}),
  };
}
