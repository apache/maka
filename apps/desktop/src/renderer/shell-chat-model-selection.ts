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

import type { ChatModelChoice } from '@maka/core/chat-model-choice';

export type NewChatModel = { llmConnectionSlug: string; model: string };

export function pickNewChatModel(input: {
  pending: NewChatModel | null;
  activationCandidate?: NewChatModel;
  catalogDefault: NewChatModel | undefined;
  choices: readonly ChatModelChoice[];
}): NewChatModel | undefined {
  for (const candidate of [input.pending, input.activationCandidate, input.catalogDefault]) {
    if (candidate && input.choices.some(
      (choice) => choice.connectionSlug === candidate.llmConnectionSlug && choice.model === candidate.model,
    )) return candidate;
  }
  const first = input.choices[0];
  return first ? { llmConnectionSlug: first.connectionSlug, model: first.model } : undefined;
}

export function chatModelChoiceLabel(
  choices: readonly ChatModelChoice[],
  connectionSlug: string | undefined,
  model: string | undefined,
): string | undefined {
  if (!connectionSlug || !model) return model;
  return choices.find((choice) => choice.connectionSlug === connectionSlug && choice.model === model)?.label ?? model;
}
