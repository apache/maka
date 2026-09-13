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

export function createQuestionDrafts(questions: readonly UserQuestion[]): QuestionAnswerDraft[] {
  return questions.map(() => null);
}

export function canLeaveQuestion(draft: QuestionAnswerDraft): boolean {
  return draft?.kind !== 'other' || draft.value.trim().length > 0;
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
