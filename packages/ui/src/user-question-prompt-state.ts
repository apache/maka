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
