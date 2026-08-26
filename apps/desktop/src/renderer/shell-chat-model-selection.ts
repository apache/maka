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

export type NewChatModel = {
  llmConnectionId: string;
  llmConnectionSlug: string;
  model: string;
};

export type NewChatModelCandidate = Omit<NewChatModel, 'llmConnectionId'> & {
  llmConnectionId?: string;
};

export function pickNewChatModel(input: {
  pending: NewChatModelCandidate | null;
  activationCandidate?: NewChatModelCandidate;
  catalogDefault: NewChatModelCandidate | undefined;
  choices: readonly ChatModelChoice[];
}): NewChatModel | undefined {
  for (const candidate of [input.pending, input.activationCandidate, input.catalogDefault]) {
    if (!candidate) continue;
    const choice = input.choices.find(
      (entry) =>
        entry.connectionSlug === candidate.llmConnectionSlug && entry.model === candidate.model,
    );
    if (choice &&
      (candidate.llmConnectionId === undefined || candidate.llmConnectionId === choice.connectionId)) {
      return {
        llmConnectionId: choice.connectionId,
        llmConnectionSlug: choice.connectionSlug,
        model: choice.model,
      };
    }
  }
  const first = input.choices[0];
  return first
    ? {
        llmConnectionId: first.connectionId,
        llmConnectionSlug: first.connectionSlug,
        model: first.model,
      }
    : undefined;
}

export function chatModelChoiceLabel(
  choices: readonly ChatModelChoice[],
  connectionId: string | undefined,
  connectionSlug: string | undefined,
  model: string | undefined,
): string | undefined {
  if (!connectionSlug || !model) return model;
  return (
    choices.find(
      (choice) =>
        (connectionId === undefined || choice.connectionId === connectionId) &&
        choice.connectionSlug === connectionSlug &&
        choice.model === model,
    )?.label ?? model
  );
}
