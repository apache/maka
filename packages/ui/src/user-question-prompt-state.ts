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

/**
 * Wizard progress for one request: which question is on screen, the committed
 * per-question drafts, and the in-flight free-form text.
 */
export interface QuestionWizardProgress {
  questionIndex: number;
  drafts: QuestionAnswerDraft[];
  answerText: string;
}

/**
 * The wizard's progress plus the request object it belongs to. The prompt
 * keeps this as a single state object so the persistence effect always writes
 * under the request the progress was made for — splitting them across separate
 * states let a request-switch commit write the old request's progress under
 * the new request.
 */
export interface QuestionWizardState extends QuestionWizardProgress {
  request: UserQuestionRequest;
}

// The prompt unmounts when the user switches sessions, so its useState alone
// cannot survive the round trip. This cache lets a remounted prompt resume
// where the user left off.
//
// Progress is keyed by the request OBJECT, not its id, and the interaction
// queue (interaction-queue.ts) owns that object's lifetime: a surface holds
// exactly one object per pending request — enqueue dedupes by id, a rehydration
// keeps the object already shown — and drops it when the runtime settles the
// request (answer ack, tool result, terminal Turn event, or a live set that no
// longer lists it) or when the surface rebuilds its queue (WorkHub does on a
// session or host change). A WeakMap ties the cached progress to that
// lifetime, which is what makes it correct without any resolution signal of
// its own:
// - Nothing here decides that a request is over. The Desktop adapters report a
//   failed answer or stop with a toast and fulfill anyway, so the prompt cannot
//   tell a real resolution from a swallowed bridge failure — and it does not
//   have to. A request the runtime still holds stays in the queue, its object
//   stays alive, and the answers stay put for the retry.
// - Settled requests need no eviction: their object leaves the queue and the
//   entry goes with it, so there is no bound for later requests to push a
//   still-pending wizard out of.
// - The cache is per renderer process: the main chat surface and the WorkHub
//   WebContentsView each keep their own copy. The same request shown in two
//   surfaces resumes independently; first submit wins. Cross-surface sync is
//   out of scope.
const progressByRequest = new WeakMap<UserQuestionRequest, QuestionWizardProgress>();

/** Initial wizard state for the request: cached progress when resuming, a
 * fresh wizard otherwise. */
export function createQuestionWizardState(request: UserQuestionRequest): QuestionWizardState {
  const cached = progressByRequest.get(request);
  return {
    request,
    questionIndex: cached?.questionIndex ?? 0,
    drafts: cached?.drafts ?? createQuestionDrafts(request.questions),
    answerText: cached?.answerText ?? '',
  };
}

export function writeQuestionWizardProgress(request: UserQuestionRequest, progress: QuestionWizardProgress): void {
  progressByRequest.set(request, {
    questionIndex: progress.questionIndex,
    drafts: progress.drafts,
    answerText: progress.answerText,
  });
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
