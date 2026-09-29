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

import type { UserQuestion, UserQuestionRequest, UserQuestionResponse } from '@maka/core/user-question';

export type QuestionAnswerDraft =
  | { kind: 'option'; optionIndex: number }
  | { kind: 'other'; value: string }
  | null;

export interface UserQuestionWizardState {
  questionIndex: number;
  drafts: QuestionAnswerDraft[];
  answerText: string;
}

const wizardStateByRequestId = new Map<string, UserQuestionWizardState>();
const completedWizardRequestIds = new Set<string>();

export function createQuestionDrafts(questions: readonly UserQuestion[]): QuestionAnswerDraft[] {
  return questions.map(() => null);
}

export function createUserQuestionWizardState(questions: readonly UserQuestion[]): UserQuestionWizardState {
  return {
    questionIndex: 0,
    drafts: createQuestionDrafts(questions),
    answerText: '',
  };
}

export function readUserQuestionWizardState(requestId: string): UserQuestionWizardState | undefined {
  const remembered = wizardStateByRequestId.get(requestId);
  if (!remembered) return undefined;
  return {
    questionIndex: remembered.questionIndex,
    drafts: [...remembered.drafts],
    answerText: remembered.answerText,
  };
}

export function rememberUserQuestionWizardState(requestId: string, state: UserQuestionWizardState): void {
  if (completedWizardRequestIds.has(requestId)) return;
  wizardStateByRequestId.set(requestId, {
    questionIndex: state.questionIndex,
    drafts: [...state.drafts],
    answerText: state.answerText,
  });
}

export function clearUserQuestionWizardState(requestId: string): void {
  wizardStateByRequestId.delete(requestId);
  completedWizardRequestIds.delete(requestId);
}

export function completeUserQuestionWizardState(requestId: string): void {
  wizardStateByRequestId.delete(requestId);
  completedWizardRequestIds.add(requestId);
}

export function buildUserQuestionResponse(
  request: UserQuestionRequest,
  drafts: readonly QuestionAnswerDraft[],
): UserQuestionResponse {
  return {
    requestId: request.requestId,
    answers: request.questions.map((question, index) => {
      const draft = drafts[index];
      if (!draft) return null;
      if (draft.kind === 'other') return draft.value.trim() || null;
      return question.options[draft.optionIndex]?.label ?? null;
    }),
  };
}
