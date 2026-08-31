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

import { ASSISTANT_PROGRESS_TOOL_NAME } from '@maka/core/events';
import { z } from 'zod';

import type { MakaTool } from './tool-runtime.js';

export const ASSISTANT_PROGRESS_MAX_CHARS = 500;

const assistantProgressInputSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(ASSISTANT_PROGRESS_MAX_CHARS)
      .describe('A brief user-facing progress update.'),
  })
  .strict();

export function buildAssistantProgressTool(): MakaTool<{ text: string }> {
  return {
    name: ASSISTANT_PROGRESS_TOOL_NAME,
    description:
      'Required before the first work tool in a multi-step task: send one brief user-facing progress update. If it cannot be called alongside the work tool, call it alone first. This is not a final answer; continue the task afterward.',
    parameters: assistantProgressInputSchema,
    nesting: 'direct_only',
    recoveryMode: 'idempotent',
    impl: () => ({ status: 'displayed' as const }),
  };
}

export function assistantProgressText(input: unknown): string | undefined {
  const decoded = assistantProgressInputSchema.safeParse(input);
  return decoded.success ? decoded.data.text : undefined;
}
