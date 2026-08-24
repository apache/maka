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
    nesting: 'direct_only',
    impl: ({ questions }, context) => {
      // Unreachable from any ToolRuntime-driven call: ToolRuntime injects
      // `askUserQuestion` into every tool context unconditionally, so this
      // guard answers only an embedder that assembles its own MakaToolContext.
      // It is kept, and worded for a model, because that embedder exists and
      // its caller is still a model.
      if (!context.askUserQuestion)
        throw new Error(
          'AskUserQuestion is not available on this surface, so the user was not asked anything. ' +
            'Retrying will fail the same way — write the question and its options as ordinary reply text and wait for the user to answer.',
        );
      return context.askUserQuestion(questions);
    },
  };
}
