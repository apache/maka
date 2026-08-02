import { z } from 'zod';
import type { UserQuestion, UserQuestionResult } from '@maka/core/user-question';

import type { MakaTool } from './tool-runtime.js';

const optionSchema = z.object({
  label: z.string().min(1),
  description: z.string().min(1).optional(),
});

const questionSchema = z.object({
  question: z.string().min(1),
  options: z.array(optionSchema).min(2).max(3),
});

export function buildAskUserQuestionTool(): MakaTool<
  { questions: UserQuestion[] },
  UserQuestionResult
> {
  return {
    name: 'AskUserQuestion',
    description:
      'Ask 1–3 bounded multiple-choice questions whose answers are required to continue the current turn. Use ordinary assistant text for open-ended follow-up.',
    parameters: z.object({
      questions: z.array(questionSchema).min(1).max(3),
    }),
    impl: ({ questions }, context) => {
      if (!context.askUserQuestion)
        throw new Error(
          'AskUserQuestion is not available on this surface, so the user was not asked anything. ' +
            'Retrying will fail the same way — write the question and its options as ordinary reply text and wait for the user to answer.',
        );
      return context.askUserQuestion(questions);
    },
  };
}
