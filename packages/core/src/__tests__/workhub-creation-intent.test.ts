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
import {
  readWorkHubRequestIntent,
  workHubCorrectionTargetsSession,
  workHubCreationAuthorizesTitle,
  matchWorkHubSessionName,
  type WorkHubRequestIntent,
} from '../workhub-creation-intent.js';

const intentFor = readWorkHubRequestIntent;
/**
 * The stop Action Policy, reproduced here over the shared matcher: a stop
 * reference may carry punctuation after the name and nothing else.
 */
const workHubStopTargetsSession = (intent: WorkHubRequestIntent, sessionName: string): boolean => {
  if (!intent.stop.imperative || !intent.stop.target) return false;
  const match = matchWorkHubSessionName(intent.stop.target, sessionName);
  return (
    match.kind === 'elided_name_punctuation' ||
    (match.kind === 'named' && /^[.!?。！？]*$/u.test(match.remainder))
  );
};
const affirmativeWorkHubExistingCorrectionTarget = (value: string) =>
  intentFor(value).correction.existingTarget;
const affirmativeWorkHubNamedCreationTitle = (value: string) => {
  const naming = intentFor(value).creation.naming;
  return naming.kind === 'named' ? naming.title : undefined;
};
const hasNegatedWorkHubCreationRequest = (value: string) => !intentFor(value).creation.explicit;
const hasWorkHubNamedCreationClause = (value: string) =>
  intentFor(value).creation.naming.kind !== 'none';
const isAffirmativeWorkHubCorrectionRequest = (value: string) => {
  const intent = intentFor(value);
  return (
    intent.correction.cue &&
    Boolean(
      intent.correction.existingTarget ||
        (intent.creation.explicit && intent.execution === 'imperative'),
    )
  );
};
const isAffirmativeWorkHubExistingTargetCorrectionRequest = (
  value: string,
  expectedTargetName?: string,
) => {
  const intent = intentFor(value);
  return expectedTargetName
    ? workHubCorrectionTargetsSession(intent, expectedTargetName)
    : Boolean(intent.correction.existingTarget);
};
const isAffirmativeWorkHubNewTopicRequest = (value: string) =>
  intentFor(value).execution === 'imperative';
const isExplicitWorkHubCreationRequest = (value: string) => intentFor(value).creation.explicit;

test('requires an affirmative target action for destructive corrections', () => {
  for (const text of [
    'No, use Payments instead',
    'Not this session; move it to Payments',
    'Wrong session; switch to Payments',
    '不是这个会话，转到支付任务',
    '不是这个，换成登录那个',
  ]) {
    assert.equal(isAffirmativeWorkHubExistingTargetCorrectionRequest(text), true, text);
    assert.equal(isAffirmativeWorkHubCorrectionRequest(text), true, text);
  }
  assert.equal(
    affirmativeWorkHubExistingCorrectionTarget('Not this session; move it to Payments'),
    'Payments',
  );
  assert.equal(
    affirmativeWorkHubExistingCorrectionTarget('No, use Payments instead of Login'),
    'Payments instead of Login',
  );
  for (const [text, targetName] of [
    ['No, use "Payments"', 'Payments'],
    ['不是这个，换成“支付任务”', '支付任务'],
    ['No, use Research and Development', 'Research and Development'],
    ['No, use Payments, Retry', 'Payments, Retry'],
  ] as const) {
    assert.equal(isAffirmativeWorkHubExistingTargetCorrectionRequest(text, targetName), true, text);
  }
  assert.equal(
    isAffirmativeWorkHubExistingTargetCorrectionRequest('No, use Payments, not Login', 'Login'),
    false,
  );
  for (const [text, targetName] of [
    ['No, use rapid instead', 'API'],
    ['No, use Repayment instead', 'Payment'],
    ['No, use Payments instead of Login', 'Login'],
    ['No, use Payments, not Login', 'Login'],
    ['No, move it to Login frontend', 'Login backend'],
    ['No, move it to API docs', 'API client'],
    ['不是这个，换成支付页面', '支付回调'],
    ['不是这个，换成登录文档', '登录稳定性'],
    ['不是这个，转到支付回调', '支付任务'],
  ] as const) {
    assert.equal(
      isAffirmativeWorkHubExistingTargetCorrectionRequest(text, targetName),
      false,
      `${text} must not authorize ${targetName}`,
    );
  }
  for (const text of [
    "Not this session; don't move it to Payments",
    'Wrong session; do not switch to Payments',
    '不是这个会话，但不要转到支付任务',
    '不是这个，别换成登录那个',
    "No, move it to Payments, actually don't",
    "Not this session; move to Payments, but I don't want to move anymore",
    '不是这个会话，转到支付任务，不过我不想转了',
    'No examples use Payments.',
    'This note says no, use Payments',
    "No, use Payments but don't",
    "No, use Payments and actually don't",
    "No, use Payments and don't want to move it",
    '不是这个，转到支付任务然后不想转了',
  ]) {
    assert.equal(isAffirmativeWorkHubExistingTargetCorrectionRequest(text), false, text);
    assert.equal(isAffirmativeWorkHubCorrectionRequest(text), false, text);
  }
  for (const [text, targetName] of [
    ["No, use Payments and don't proceed", 'Payments'],
    ["No, use Payments and don't go ahead with that", 'Payments'],
    ['No, use Payments, forget it', 'Payments'],
    ['No, use Payments, on second thought leave it', 'Payments'],
    ['不是这个，转到支付任务然后不要继续', '支付任务'],
    ['不是这个，换成支付任务，当我没说', '支付任务'],
    ['不是这个，换成支付任务，还是维持原样', '支付任务'],
    ["No, use Payments and don't proceed", "Payments and don't proceed"],
    ['不是这个，转到支付任务然后不要继续', '支付任务然后不要继续'],
    ['No, use Payments, fix login. Forget it', 'Payments'],
    ['No, use Payments — on second thought leave it', 'Payments'],
    ['不是这个，换成支付任务，修复登录。当我没说', '支付任务'],
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
    assert.equal(
      isAffirmativeWorkHubExistingTargetCorrectionRequest(text, targetName),
      false,
      text,
    );
  }
  assert.equal(
    isAffirmativeWorkHubCorrectionRequest('No, create a new Session for Payments instead'),
    true,
  );
  assert.equal(
    isAffirmativeWorkHubExistingTargetCorrectionRequest('No, use red instead', 'Payments'),
    false,
  );
  for (const text of [
    'No examples create a new Session.',
    'This note says no, create a new Session called Payments',
    "No, create a new Session for login but don't",
    'No, please explain how to create a new Session',
    'No, tell me how to create a new Session',
    '不对，请解释如何创建一个新的 Session',
    '错了，请告诉我怎么创建一个新的 Session',
  ]) {
    assert.equal(isAffirmativeWorkHubCorrectionRequest(text), false, text);
    assert.equal(isExplicitWorkHubCreationRequest(text), false, text);
  }

  for (const sessionName of ['U.S.', 'Dr.']) {
    assert.equal(
      workHubStopTargetsSession(readWorkHubRequestIntent(`Stop ${sessionName}`), sessionName),
      true,
      sessionName,
    );
  }
  for (const text of ['Stop Payments, fix Login', 'Stop Payments and Login']) {
    assert.equal(
      workHubStopTargetsSession(readWorkHubRequestIntent(text), 'Payments'),
      false,
      text,
    );
  }
});

test('recognizes affirmative creation after an explicit contrast', () => {
  assert.equal(
    isExplicitWorkHubCreationRequest('不是继续旧会话，而是创建一个新的 Session 登录稳定性'),
    true,
  );
  assert.equal(
    isExplicitWorkHubCreationRequest(
      "Don't continue the old task; instead create a new session called Login",
    ),
    true,
  );
  assert.equal(isExplicitWorkHubCreationRequest('Can you create a new Session for login?'), true);
  assert.equal(
    affirmativeWorkHubNamedCreationTitle('No, create a new Session called Login instead'),
    'Login',
  );
  assert.equal(
    affirmativeWorkHubNamedCreationTitle('不是这个，请创建一个新会话叫登录稳定性'),
    '登录稳定性',
  );
  for (const [text, title] of [
    ['No, create a new Session titled Login instead', 'Login'],
    ['No, create a new Session with title Login', 'Login'],
    ['不对，请创建一个新的 Session 标题为登录稳定性', '登录稳定性'],
    ['错了，新建一个会话名称为支付任务', '支付任务'],
    [
      "No, don't create a new session called Login; instead create a new session called Payments.",
      'Payments',
    ],
    ['不对，不要创建一个新会话叫登录；而是创建一个新会话叫支付。', '支付'],
    [
      'No, create a new Session called Payments, and add documentation containing the example new Session called Fraud.',
      'Payments',
    ],
    ['Create a new Session called U.S. Payments', 'U.S. Payments'],
    ['Create a new Session called Dr. Login', 'Dr. Login'],
    ['Create a new Session called Acme Inc. Payments', 'Acme Inc. Payments'],
    ['Create a new Session called No. 5 Login', 'No. 5 Login'],
    ['Create a new Session called Ph.D. Research', 'Ph.D. Research'],
    ['Create a new Session called Payments. Fix login', 'Payments'],
    ['Create a new Session called App. Fix login', 'App'],
    ['Create a new Session called Fix. Add documentation.', 'Fix'],
    ['Create a new Session called Go. Then add tests.', 'Go'],
    ['Create a new Session called Acme Inc. Fix login.', 'Acme Inc'],
    ['Create a new Session called U.S. Fix login.', 'U.S'],
    ['Create a new Session called Ph.D. Fix login.', 'Ph.D'],
    ['Create a new Session called No. Fix login.', 'No'],
    ['Create a new Session called St. Fix login.', 'St'],
    ['Create a new Session called Acme Inc. Then fix login.', 'Acme Inc'],
    ['Create a new Session called Acme Inc. Please fix login.', 'Acme Inc'],
    ['Create a new Session called Acme Inc. Please then fix login.', 'Acme Inc'],
    ['Create a new Session called Acme Inc. Then, please fix login.', 'Acme Inc'],
    ['Create a new Session called Acme Inc. Finally fix login.', 'Acme Inc'],
    ['Create a new Session called Acme Inc. Afterwards fix login.', 'Acme Inc'],
    ['Create a new Session called U.S. Can you fix login?', 'U.S'],
    ['Create a new Session called U.S. Next, fix login.', 'U.S'],
    ['Create a new Session called U.S. Also fix login.', 'U.S'],
    ['Create a new Session called U.S. Immediately fix login.', 'U.S'],
    ['Create a new Session called U.S. Proceed to fix login.', 'U.S'],
    ['Create a new Session called U.S. At that point fix login.', 'U.S'],
    ['Create a new Session called U.S. Daily Fix', 'U.S. Daily Fix'],
    ['Create a new Session called U.S. Monthly Update', 'U.S. Monthly Update'],
    ['Create a new Session called U.S. Monthly update', 'U.S. Monthly update'],
    ['Create a new Session called U.S. customer update', 'U.S. customer update'],
    ['Create a new Session called Ph.D. Could you fix login?', 'Ph.D'],
    ['Create a new Session called Ph.D. Now fix login.', 'Ph.D'],
    ['Create a new Session called Ph.D. Finally fix login.', 'Ph.D'],
    ['Create a new Session called Ph.D. 接下来修复登录。', 'Ph.D'],
    ['Create a new Session called Ph.D. 最后修复登录。', 'Ph.D'],
    ['Create a new Session called Ph.D. Friendly Fix', 'Ph.D. Friendly Fix'],
    ['Create a new Session called Ph.D. Friendly fix', 'Ph.D. Friendly fix'],
  ] as const) {
    assert.equal(hasWorkHubNamedCreationClause(text), true, text);
    assert.equal(affirmativeWorkHubNamedCreationTitle(text), title, text);
  }
  const unnamedLastCreation =
    "No, don't create a new session called Login; instead create a new session for Payments";
  assert.equal(affirmativeWorkHubNamedCreationTitle(unnamedLastCreation), undefined);
  assert.equal(hasWorkHubNamedCreationClause(unnamedLastCreation), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest(unnamedLastCreation), false);
  for (const text of [
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
    'No, create a new Session called Payments. Example: create a new Session called Fraud.',
    'Create a new Session called Payments.Example: create a new Session called Fraud',
    'Create a new Session called App. Example: create a new Session called Fraud',
    'No, create a new Session called Payments. Fix login, cancel this task.',
    'No, create a new Session called Payments. Cancel the current task.',
    'No, create a new Session called Payments. Rescind my request.',
    'No, create a new Session called Payments. Drop this task.',
    'No, create a new Session called Payments. Fix login. Please cancel the task.',
    "No, create a new Session called Payments. Fix login. Let's cancel the task.",
    'No, create a new Session called Payments. I do not wish to proceed.',
  ]) {
    assert.equal(hasWorkHubNamedCreationClause(text), true, text);
    assert.equal(affirmativeWorkHubNamedCreationTitle(text), undefined, text);
    assert.equal(isAffirmativeWorkHubNewTopicRequest(text), false, text);
  }
  assert.equal(
    isExplicitWorkHubCreationRequest('Can you explain whether we should create a new Session?'),
    false,
  );
});

test('rejects direct, parenthetical, Unicode, and anaphoric creation negation', () => {
  const cases = [
    '不是这个，而是请勿创建一个新的 Session',
    'Wrong session; don’t ever create a new session',
    'Wrong session; do not, under any circumstances, create a new session',
    'Wrong session; must not create a new session',
    '我不想创建一个新的 Session',
    '我不打算创建一个新的 Session',
    '我无意创建一个新的 Session',
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
    "Create a new Session, but don't create one after all",
    '创建一个新的 Session，不过不要创建它',
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
    '不是这个，而是创建一个新的 Session；不过不要这样做',
    'Wrong session; create a new session, but do not do that',
  ];
  for (const value of cases) {
    assert.equal(hasNegatedWorkHubCreationRequest(value), true, value);
    assert.equal(isExplicitWorkHubCreationRequest(value), false, value);
    assert.equal(isAffirmativeWorkHubNewTopicRequest(value), false, value);
  }
});

test('recognizes affirmative executable topics without trusting negated work', () => {
  assert.equal(isAffirmativeWorkHubNewTopicRequest('修复支付回调重复投递'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('Create an accessibility audit'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('Can you fix login stability?'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('Could you implement payment retry?'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('请修复支付回调重复投递？'), true);
  for (const text of [
    'Fix how login errors are reported',
    'Update how retries are calculated',
    '请修复用户不知道怎么登录的问题',
    '请实现如何恢复失败任务的逻辑',
    'Implement docs to explain how retries work',
    'Update the guide to discuss why login fails',
    '修复帮助页以解释如何恢复失败任务',
  ]) {
    assert.equal(isAffirmativeWorkHubNewTopicRequest(text), true, text);
  }
  assert.equal(
    isExplicitWorkHubCreationRequest('Create a new Session to fix how login errors are reported'),
    true,
  );
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
    assert.equal(isAffirmativeWorkHubNewTopicRequest(text), false, text);
  }
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest("Don't modify the old task; instead fix login stability"),
    true,
  );
  assert.equal(isAffirmativeWorkHubNewTopicRequest('If retries fail, fix login'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('If tests fail, fix login.'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('If needed, implement payment retry'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('If needed fix login.'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('If necessary implement retries.'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('When ready fix login.'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('If possible fix login.'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('If required fix login.'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('If safe fix login.'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('If appropriate implement retries.'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('When convenient update docs.'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('When available fix login.'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('When feasible fix login.'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('If desired fix login.'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('If applicable fix login.'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('When practical update docs.'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('If advisable implement retries.'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('If permitted fix login.'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('When complete update docs.'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('If urgent fix login.'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('When sensible implement retries.'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('Can you please fix login?'), true);
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('Could you kindly implement payment retry?'),
    true,
  );
  assert.equal(isAffirmativeWorkHubNewTopicRequest('If retries fail, can you fix login?'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('If retries fail can you fix login?'), true);
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('If retries fail then can you fix login?'),
    true,
  );
  assert.equal(isAffirmativeWorkHubNewTopicRequest('When retries fail, can you fix login?'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('If retries fail then fix login?'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('When retries fail, fix login?'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('When retries fail fix login?'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('Tell me the options and fix login'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('Recommend options and fix login'), true);
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('Can you fix login, but leave documentation unchanged?'),
    true,
  );
  for (const text of [
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
  ]) {
    assert.equal(isAffirmativeWorkHubNewTopicRequest(text), true, text);
  }
  for (const text of [
    'Explain how to fix login, then update the docs.',
    'Tell me how to diagnose login, and fix the bug.',
    '解释如何修复登录，然后更新文档。',
    'Explain how to diagnose login, then fix and test it.',
    'Explain how to diagnose login; then fix it.',
    'Explain how to diagnose and reproduce login, then fix it.',
    'Tell me how to diagnose and test login, then update docs.',
    'Explain how to diagnose, reproduce, and test login; then fix it.',
    'Explain how to diagnose the text "login, fix it"; then update docs.',
    'Explain how to diagnose login; then update the prompt to "How can I help?"',
    "Explain how to diagnose what's wrong, then fix what's broken.",
    'Explain how to diagnose the text "do not fix", then update docs.',
    'Explain how to diagnose the text `do not fix`, then update docs.',
    'Explain how to diagnose the text (do not fix), then update docs.',
    'Explain how to diagnose the text "do not update", then fix login.',
    'Show me how to diagnose login, then fix it.',
    'Walk me through how to diagnose login, then fix it.',
    '教我如何诊断登录，然后修复它。',
  ]) {
    assert.equal(intentFor(text).execution, 'ambiguous', text);
  }
  assert.equal(isAffirmativeWorkHubNewTopicRequest('如果重试失败就请修复登录？'), true);
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('Fix login, but leave documentation unchanged'),
    true,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('Fix login, but hold API behavior constant'),
    true,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('Fix login, but wait for tests before merging'),
    true,
  );
  assert.equal(isAffirmativeWorkHubNewTopicRequest('Explain the issue, then fix login'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('Tell me the cause and fix login'), true);
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('Discuss the approach, then implement retry'),
    true,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('Consider the options, but fix login now'),
    true,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('Fix login stability, but do not create any files'),
    true,
  );
  assert.equal(isAffirmativeWorkHubNewTopicRequest('修复登录稳定性，但不要创建任何文件'), true);
  assert.equal(
    isExplicitWorkHubCreationRequest('Create a new Session for login, but do not create files'),
    true,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('Create a new Session for login, but do not create files'),
    true,
  );
  assert.equal(isAffirmativeWorkHubNewTopicRequest("Don't modify any files"), false);
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest("Don't fix or implement login stability"),
    false,
  );
  assert.equal(isAffirmativeWorkHubNewTopicRequest('不要修复或实现登录稳定性'), false);
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest("Fix login stability, actually don't fix it"),
    false,
  );
  assert.equal(isAffirmativeWorkHubNewTopicRequest("Fix login stability — actually, don't"), false);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('修复登录稳定性，还是别了'), false);
  assert.equal(isAffirmativeWorkHubNewTopicRequest("Fix login, logout, etc. Don't."), false);
  assert.equal(isAffirmativeWorkHubNewTopicRequest("Fix login\nDon't."), false);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('修复登录稳定性\n还是别了'), false);
  assert.equal(isAffirmativeWorkHubNewTopicRequest("Fix login stability - don't"), false);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('修复登录稳定性 - 还是别了'), false);
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest("Fix parser tokens:\ndon't\n\nactually, don't"),
    false,
  );
  assert.equal(isAffirmativeWorkHubNewTopicRequest("Fix login\nCorrection:\ndon't"), false);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('修复登录\n更正：\n还是别了'), false);
  assert.equal(isAffirmativeWorkHubNewTopicRequest("Fix login\nWait:\ndon't"), false);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('修复登录\n不对：\n还是别了'), false);
  assert.equal(isAffirmativeWorkHubNewTopicRequest("Fix login\nCorrection note:\n- don't"), false);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('修复登录\n想了想：\n    还是别了'), false);
  assert.equal(isAffirmativeWorkHubNewTopicRequest("Fix login\nIn that case:\ndon't"), false);
  assert.equal(isAffirmativeWorkHubNewTopicRequest("Fix login\nFor example:\ndon't"), false);
  assert.equal(isAffirmativeWorkHubNewTopicRequest("Fix login\nIn this test case:\ndon't"), false);
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest("Fix login\nParser in this case:\ndon't"),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest("Fix login\nWith this config value:\ndon't"),
    false,
  );
  for (const text of [
    "Create a new Session for login\nConfig in this case:\ndon't",
    "Create a new Session for login\nTesting, for example:\ndon't",
  ]) {
    assert.equal(isExplicitWorkHubCreationRequest(text), false, text);
    assert.equal(isAffirmativeWorkHubNewTopicRequest(text), false, text);
  }
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
    assert.equal(isAffirmativeWorkHubNewTopicRequest(text), true, text);
  }
  assert.equal(isExplicitWorkHubCreationRequest("Create a new Session for parsing don't"), true);
  assert.equal(
    isExplicitWorkHubCreationRequest("Create a new Session for parsing this token:\ndon't"),
    true,
  );
  assert.equal(isAffirmativeWorkHubNewTopicRequest("Fix login stability, but don't fix it"), false);
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest("Fix login stability, but don't do that"),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest("Fix login stability, instead don't do that"),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest("Fix login stability, but don't implement it"),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest("Implement login stability, but don't fix it"),
    false,
  );
  assert.equal(isAffirmativeWorkHubNewTopicRequest('修复登录稳定性，但不要修改它'), false);
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest("Fix login stability, actually don't fix login stability"),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('Fix login stability, but do not fix login stability'),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('修复登录稳定性，不过不要修复登录稳定性'),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('Fix login stability and do not fix login stability'),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest("Fix login stability then don't fix login stability"),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('Fix login stability and then do not fix login stability'),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest(
      'Fix login stability and please do not fix login stability',
    ),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest(
      "Fix login stability then kindly don't fix login stability",
    ),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('修复登录稳定性然后请不要修复登录稳定性'),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest(
      'Fix login stability and could you please not fix login stability',
    ),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('修复登录稳定性然后麻烦你不要修复登录稳定性'),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('修复登录稳定性然后真的不要修复登录稳定性'),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('Fix login stability and just do not fix login stability'),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest("Fix login stability and simply don't fix login stability"),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('修复登录稳定性然后千万不要修复登录稳定性'),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('Fix login and do not fix login documentation'),
    true,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('Fix checkout, but do not fix checkout tests'),
    true,
  );
  assert.equal(isAffirmativeWorkHubNewTopicRequest('修复登录，但不要修复登录文档'), true);
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('Update API documentation, but do not update API'),
    true,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('Fix checkout tests, but do not fix checkout'),
    true,
  );
  assert.equal(isAffirmativeWorkHubNewTopicRequest('修复登录文档，但不要修复登录'), true);
  assert.equal(isAffirmativeWorkHubNewTopicRequest('修复登录稳定性并且不要修复登录稳定性'), false);
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('Do not create a new Session to fix login stability'),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('不要创建一个新的 Session 来修复登录稳定性'),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('Do not create a new Session. Fix login stability'),
    false,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest(
      "Fix login, but don't do that; instead implement payment retry",
    ),
    true,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest('修复登录，但不要这样做；而是实现支付重试'),
    true,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest("Fix login, but don't do that. Implement payment retry"),
    true,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest(
      "Create a new Session for login, but don't do that; instead implement payment retry",
    ),
    true,
  );
  assert.equal(
    isAffirmativeWorkHubNewTopicRequest(
      '创建一个新的 Session 处理登录，不过不要这样做；而是实现支付重试',
    ),
    true,
  );
  assert.equal(isAffirmativeWorkHubNewTopicRequest('修复登录稳定性，不过不要修复它'), false);
});

test('returns one bounded intent record for routing and admission', () => {
  const named = readWorkHubRequestIntent('Create a new Session called Login');
  assert.equal(named.execution, 'imperative');
  assert.deepEqual(named.creation, {
    explicit: true,
    naming: { kind: 'named', title: 'Login' },
  });
  assert.equal(workHubCreationAuthorizesTitle(named, 'Login'), true);
  assert.equal(workHubCreationAuthorizesTitle(named, 'Payments'), false);

  const direct = readWorkHubRequestIntent('Fix login, then update docs.');
  const quotedNegation = readWorkHubRequestIntent('Fix the text "do not fix", then update docs.');
  assert.equal(direct.execution, 'imperative');
  assert.equal(quotedNegation.execution, direct.execution);

  assert.equal(
    readWorkHubRequestIntent("Explain how to diagnose what's wrong, then fix what's broken.")
      .execution,
    'ambiguous',
  );
  for (const text of [
    'Explain how to diagnose the text "login, then fix it.',
    'Explain how to diagnose the sequence (login (primary), then fix it).',
    'Explain how to diagnose the sequence [login, then fix it].',
    'Fix login] then update docs.',
  ]) {
    assert.equal(readWorkHubRequestIntent(text).execution, 'non_executable', text);
  }
});

test('requires a direct, explicitly named command for WorkHub stop authority', () => {
  for (const [text, target] of [
    ['Stop Payments', 'Payments'],
    ['Please cancel the session Payments.', 'Payments'],
    ['Terminate work "API migration"', 'API migration'],
    ['停止支付任务', '支付任务'],
    ['请取消这个会话 登录稳定性。', '登录稳定性'],
  ] as const) {
    const intent = readWorkHubRequestIntent(text);
    assert.deepEqual(intent.stop, { cue: true, imperative: true, target }, text);
    assert.equal(workHubStopTargetsSession(intent, target), true, text);
    assert.equal(workHubStopTargetsSession(intent, `${target} extra`), false, text);
  }

  for (const text of [
    'Stop it',
    'Cancel this work',
    '取消这个工作',
    'Pause Payments',
    'Wait on Payments',
    'How do I stop Payments?',
    'Can you stop Payments?',
    'Do not stop Payments',
    "Don't cancel Payments",
    '不要停止支付任务',
    'The literal text is "Stop Payments"',
    '"Stop Payments"',
    'Stop "Payments',
  ]) {
    assert.deepEqual(
      readWorkHubRequestIntent(text).stop,
      {
        cue: text === 'Stop it' || text === 'Cancel this work' || text === '取消这个工作',
        imperative: false,
      },
      text,
    );
  }
});
