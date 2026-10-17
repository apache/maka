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

import { failureClassFromCompleteStopReason, type SessionEvent } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import type { MakaRunOutcome } from './run-command-core.js';

type TurnOutcomeObservation =
  | { readonly kind: 'output'; readonly text: string; readonly source: 'live' | 'stored' }
  | {
      readonly kind: 'terminal';
      readonly update: 'replace' | 'if_unset';
      readonly status: 'completed';
    }
  | {
      readonly kind: 'terminal';
      readonly update: 'replace' | 'if_unset';
      readonly status: 'failed';
      readonly failure: NonNullable<MakaRunOutcome['failure']>;
    }
  | {
      readonly kind: 'tool_result';
      readonly toolUseId: string;
      readonly outcome: 'sandbox_failure' | 'success';
    };

type TerminalOutcomeObservation = Extract<TurnOutcomeObservation, { kind: 'terminal' }>;

export class TurnOutcomeClassifier {
  readonly #outcomeId: string;
  readonly #unresolvedSandboxFailures = new Set<string>();
  #finalOutput: string | undefined;
  #finalOutputFromLive = false;
  #terminal: TerminalOutcomeObservation | undefined;

  constructor(outcomeId: string) {
    this.#outcomeId = outcomeId;
  }

  accept(observation: TurnOutcomeObservation | undefined): void {
    switch (observation?.kind) {
      case undefined:
        return;
      case 'output':
        // A subscriber is delivered in Host order, so the stream's last answer
        // is the Turn's last answer. A transcript read stops wherever the Host
        // had committed, so it can supply an answer the stream never carried
        // but can never overrule one it did.
        if (observation.source === 'stored' && this.#finalOutputFromLive) return;
        this.#finalOutput = observation.text;
        this.#finalOutputFromLive = observation.source === 'live';
        return;
      case 'terminal':
        if (observation.update === 'replace' || this.#terminal === undefined) {
          this.#terminal = observation;
        }
        return;
      case 'tool_result': {
        if (observation.outcome === 'sandbox_failure') {
          this.#unresolvedSandboxFailures.add(observation.toolUseId);
        }
        // No clearing path: `maka run` denies every widening request, so the
        // boundary cannot move mid-Turn and a later success cannot prove that
        // a blocked call recovered. The failure stays unresolved to the end.
        return;
      }
    }
  }

  outcome(incomplete: 'fail'): MakaRunOutcome;
  outcome(incomplete: 'pending'): MakaRunOutcome | undefined;
  outcome(incomplete: 'fail' | 'pending'): MakaRunOutcome | undefined {
    const terminal = this.#terminal;
    if (!terminal && incomplete === 'pending') return undefined;
    const completed = terminal?.status === 'completed';
    const sandboxBoundary = this.#unresolvedSandboxFailures.size > 0 ? 'unresolved' : 'none';
    const failure =
      terminal?.status === 'failed'
        ? terminal.failure
        : {
            class: 'missing_terminal_event',
            message: 'Turn ended unexpectedly',
          };
    return {
      outcomeId: this.#outcomeId,
      status: completed ? 'completed' : 'failed',
      ...(completed && this.#finalOutput !== undefined ? { finalOutput: this.#finalOutput } : {}),
      ...(!completed ? { failure } : {}),
      sandboxBoundary,
    };
  }
}

export function observationFromSessionEvent(
  event: SessionEvent,
): TurnOutcomeObservation | undefined {
  if (event.type === 'text_complete' && event.text.trim().length > 0) {
    return { kind: 'output', text: event.text, source: 'live' };
  }
  if (event.type === 'error') {
    return {
      kind: 'terminal',
      update: 'replace',
      status: 'failed',
      failure: { class: event.reason ?? event.code ?? 'runtime_error', message: event.message },
    };
  }
  if (event.type === 'abort') {
    return {
      kind: 'terminal',
      update: 'replace',
      status: 'failed',
      failure: { class: 'aborted', message: 'Turn was cancelled' },
    };
  }
  if (event.type === 'complete') {
    return observationFromCompleteEvent(event);
  }
  return event.type === 'tool_result' ? observationFromToolResult(event) : undefined;
}

function observationFromStoredMessage(message: StoredMessage): TurnOutcomeObservation | undefined {
  if (message.type === 'assistant' && message.text.trim().length > 0) {
    return { kind: 'output', text: message.text, source: 'stored' };
  }
  if (message.type === 'turn_state' && message.status === 'completed') {
    return { kind: 'terminal', update: 'replace', status: 'completed' };
  }
  if (message.type === 'turn_state' && message.status === 'aborted') {
    return {
      kind: 'terminal',
      update: 'replace',
      status: 'failed',
      failure: { class: 'aborted', message: 'Turn was cancelled' },
    };
  }
  if (message.type === 'turn_state' && message.status === 'failed') {
    return {
      kind: 'terminal',
      update: 'replace',
      status: 'failed',
      failure: {
        class: message.errorClass ?? 'runtime_error',
        message: message.failureMessage ?? 'Turn failed',
      },
    };
  }
  return message.type === 'tool_result' ? observationFromToolResult(message) : undefined;
}

function observationFromCompleteEvent(
  event: Extract<SessionEvent, { type: 'complete' }>,
): TerminalOutcomeObservation {
  if (event.stopReason === 'user_stop') {
    return {
      kind: 'terminal',
      update: 'if_unset',
      status: 'failed',
      failure: { class: 'aborted', message: 'Turn was cancelled' },
    };
  }
  const failureClass = failureClassFromCompleteStopReason(event.stopReason);
  return failureClass
    ? {
        kind: 'terminal',
        update: 'if_unset',
        status: 'failed',
        failure: { class: failureClass },
      }
    : { kind: 'terminal', update: 'if_unset', status: 'completed' };
}

function observationFromToolResult(
  result: Pick<Extract<SessionEvent, { type: 'tool_result' }>, 'content' | 'isError' | 'toolUseId'>,
): TurnOutcomeObservation | undefined {
  if (result.isError && result.content.kind === 'text' && result.content.sandboxFailure) {
    return {
      kind: 'tool_result',
      toolUseId: result.toolUseId,
      outcome: 'sandbox_failure',
    };
  }
  return result.isError
    ? undefined
    : { kind: 'tool_result', toolUseId: result.toolUseId, outcome: 'success' };
}

export function outcomeFromStoredTurn(
  messages: readonly StoredMessage[],
  turnId: string,
): MakaRunOutcome | undefined {
  return classifierFromStoredTurn(messages, turnId, turnId).outcome('pending');
}

export function classifierFromStoredTurn(
  messages: readonly StoredMessage[],
  turnId: string,
  outcomeId: string,
): TurnOutcomeClassifier {
  const classifier = new TurnOutcomeClassifier(outcomeId);
  acceptStoredTurn(classifier, messages, turnId);
  return classifier;
}

export function acceptStoredTurn(
  classifier: TurnOutcomeClassifier,
  messages: readonly StoredMessage[],
  turnId: string,
): void {
  for (const message of messages) {
    if (message.turnId === turnId) classifier.accept(observationFromStoredMessage(message));
  }
}
