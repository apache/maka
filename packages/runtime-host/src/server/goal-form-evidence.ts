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

import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { InteractionFormResult } from '@maka/core/interaction';
import type { InteractionRecord } from '@maka/storage/interaction-store';

export interface GoalFormAnswer {
  readonly turnId: string;
  readonly toolUseId: string;
  readonly requestId: string;
  readonly action: InteractionFormResult['action'] | 'unavailable';
  readonly message: string;
  readonly fields: readonly { readonly name: string; readonly label: string }[];
  readonly values?: Readonly<Record<string, unknown>>;
  readonly selectedOptions?: Readonly<
    Record<string, readonly { readonly value: string; readonly label: string }[]>
  >;
}

export interface GoalFormToolReference {
  readonly turnId: string;
  readonly toolUseId: string;
}

const RECENT_FORM_ANSWER_LIMIT = 6;

/**
 * A Tool may request several forms before returning. An acknowledgement beyond
 * the answer-read quota still means its result could echo an unchecked answer.
 * Record only selected Tool identities so this guard stays bounded without
 * reading older Interaction values or adding synthetic display answers.
 */
export function unreadGoalFormToolResponses(
  sessionId: string,
  events: readonly RuntimeEvent[],
  answers: readonly GoalFormAnswer[],
  relevantTools: readonly GoalFormToolReference[],
): readonly GoalFormToolReference[] {
  const inspected = new Set(
    answers.map(({ turnId, toolUseId, requestId }) =>
      JSON.stringify([turnId, toolUseId, requestId]),
    ),
  );
  const relevant = new Map(
    relevantTools.map(({ turnId, toolUseId }) => [
      JSON.stringify([turnId, toolUseId]),
      { turnId, toolUseId },
    ]),
  );
  const unread = new Set<string>();
  for (const event of events) {
    const requestId = event.actions?.formAnswerAccepted?.requestId;
    const toolUseId = event.refs?.toolCallId;
    if (event.sessionId !== sessionId || event.partial || !requestId || !toolUseId) continue;
    const key = JSON.stringify([event.turnId, toolUseId]);
    if (relevant.has(key) && !inspected.has(JSON.stringify([event.turnId, toolUseId, requestId])))
      unread.add(key);
  }
  return [...relevant].flatMap(([key, reference]) => (unread.has(key) ? [reference] : []));
}

/**
 * A form acknowledgement carries identity, not the human's answer. Read that
 * answer from its existing authority: the eventual tool result may contain
 * nothing more than "done". Do not turn a pending, missing or mismatched
 * Interaction into an accepted answer, or copy its private request metadata.
 */
export async function readGoalFormEvidence(
  sessionId: string,
  events: readonly RuntimeEvent[],
  readInteraction: (requestId: string) => Promise<InteractionRecord | undefined>,
): Promise<readonly GoalFormAnswer[]> {
  const seen = new Set<string>();
  const acknowledgements: RuntimeEvent[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    const requestId = event.actions?.formAnswerAccepted?.requestId;
    if (event.sessionId !== sessionId || event.partial || !requestId || seen.has(requestId))
      continue;
    seen.add(requestId);
    acknowledgements.push(event);
    if (acknowledgements.length === RECENT_FORM_ANSWER_LIMIT) break;
  }
  acknowledgements.reverse();

  const answers: GoalFormAnswer[] = [];
  for (const event of acknowledgements) {
    const requestId = event.actions!.formAnswerAccepted!.requestId;
    const record = await readInteraction(requestId);
    const request = record?.request;
    const outcome = record?.outcome;
    if (
      !request ||
      !outcome ||
      request.requestId !== requestId ||
      request.sessionId !== sessionId ||
      request.turnId !== event.turnId ||
      request.runId !== event.runId ||
      outcome.requestId !== requestId ||
      outcome.sessionId !== sessionId ||
      outcome.turnId !== event.turnId ||
      outcome.runId !== event.runId ||
      request.request.kind !== 'form' ||
      outcome.outcome.kind !== 'form_answer' ||
      request.request.toolUseId !== event.refs?.toolCallId
    ) {
      answers.push({
        turnId: event.turnId,
        toolUseId: event.refs?.toolCallId ?? '[unavailable]',
        requestId,
        action: 'unavailable',
        message: 'The acknowledged form response is unavailable.',
        fields: [],
      });
      continue;
    }
    const answer = outcome.outcome;
    const selectedOptions =
      answer.action === 'accept'
        ? Object.fromEntries(
            request.request.fields.flatMap((field) => {
              if (field.kind !== 'single_select' && field.kind !== 'multi_select') return [];
              const value = answer.values[field.name];
              const values =
                typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
              const options = field.options
                .filter((option) => values.includes(option.value))
                .map(({ value, label }) => ({ value, label }));
              return options.length ? [[field.name, options] as const] : [];
            }),
          )
        : undefined;
    answers.push({
      turnId: event.turnId,
      toolUseId: request.request.toolUseId,
      requestId,
      action: answer.action,
      message: request.request.message,
      fields: request.request.fields.map(({ name, label }) => ({ name, label })),
      ...(answer.action === 'accept' ? { values: answer.values } : {}),
      ...(selectedOptions && Object.keys(selectedOptions).length ? { selectedOptions } : {}),
    });
  }
  return answers;
}
