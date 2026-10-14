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
import type { UserQuestion } from '@maka/core/user-question';
import {
  buildUserQuestionResponse,
  clearUserQuestionWizardState,
  createQuestionDrafts,
  createUserQuestionWizardState,
  MAX_USER_QUESTION_WIZARD_STATES,
  readUserQuestionWizardState,
  rememberUserQuestionWizardState,
} from './user-question-prompt-state.js';

const questions: UserQuestion[] = [
  {
    question: 'First?',
    options: [{ label: 'A' }, { label: 'B' }],
  },
  {
    question: 'Second?',
    options: [{ label: 'Yes' }, { label: 'No' }],
  },
];

test('wizard store restores and clears progress keyed by requestId', () => {
  const requestId = 'question-1';
  const initial = createUserQuestionWizardState(questions);
  assert.deepEqual(initial, {
    questionIndex: 0,
    drafts: [null, null],
    answerText: '',
  });

  rememberUserQuestionWizardState(requestId, {
    questionIndex: 1,
    drafts: [{ kind: 'option', optionIndex: 0 }, null],
    answerText: 'custom',
  });

  const remembered = readUserQuestionWizardState(requestId);
  assert.deepEqual(remembered, {
    questionIndex: 1,
    drafts: [{ kind: 'option', optionIndex: 0 }, null],
    answerText: 'custom',
  });

  remembered!.drafts[0] = null;
  assert.deepEqual(readUserQuestionWizardState(requestId)?.drafts, [{ kind: 'option', optionIndex: 0 }, null]);

  clearUserQuestionWizardState(requestId);
  assert.equal(readUserQuestionWizardState(requestId), undefined);
});

test('wizard store evicts the oldest entry when it exceeds the bound', () => {
  for (let index = 0; index < MAX_USER_QUESTION_WIZARD_STATES; index += 1) {
    rememberUserQuestionWizardState(`question-${index}`, createUserQuestionWizardState(questions));
  }
  assert.equal(readUserQuestionWizardState('question-0')?.questionIndex, 0);
  rememberUserQuestionWizardState('question-overflow', {
    questionIndex: 1,
    drafts: createQuestionDrafts(questions),
    answerText: 'overflow',
  });
  assert.equal(readUserQuestionWizardState('question-0'), undefined);
  assert.equal(readUserQuestionWizardState('question-overflow')?.answerText, 'overflow');
  for (let index = 0; index < MAX_USER_QUESTION_WIZARD_STATES; index += 1) {
    clearUserQuestionWizardState(`question-${index}`);
  }
  clearUserQuestionWizardState('question-overflow');
});

test('buildUserQuestionResponse maps committed drafts to option labels', () => {
  const drafts = createQuestionDrafts(questions);
  drafts[0] = { kind: 'option', optionIndex: 1 };
  drafts[1] = { kind: 'other', value: 'maybe' };
  assert.deepEqual(buildUserQuestionResponse({
    requestId: 'question-1',
    toolUseId: 'tool-1',
    questions,
  }, drafts), {
    requestId: 'question-1',
    answers: ['B', 'maybe'],
  });
});
