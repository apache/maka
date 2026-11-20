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

import { cleanup, signal } from 'nsh';
import { randomUUID } from 'crypto';
import { host } from 'maka/host';
import type { OperationReply } from '../../../../packages/plugin-sdk/src/index';
import type { OriginalMutation } from './host';
import { tr } from './locale';

function returned(reply: OperationReply) {
  const receipt = reply.receipt;
  const outcome = receipt.kind === 'recorded' ? receipt.outcome : receipt;
  const failure = outcome.kind === 'returned' ? outcome.result : outcome;
  if (failure.kind === 'success') return;
  if ('diagnostic' in failure) {
    throw Error(
      failure.diagnostic === 'quick_question_model_required'
        ? tr('Select a model for Maka Bot first.')
        : failure.diagnostic,
    );
  }
  throw Error(tr('Quick question failed.'));
}

export function createQuickQuestion(openBot: () => Promise<string>) {
  const turns = signal<{ question: string; answer: string }[]>([]);
  const running = signal(false),
    error = signal('');
  let previous: string | null = null;
  let active: OriginalMutation | undefined;
  let stopped = false,
    alive = true;
  const stop = () => {
    stopped = true;
    active?.cancel();
  };
  cleanup(() => {
    alive = false;
    stop();
  });
  const ask = async (question: string, follow: boolean) => {
    question = question.trim();
    if (!question || running()) return;
    const requestId = randomUUID();
    const continueFrom = follow ? previous : null;
    const history = continueFrom ? turns() : [];
    running.set(true);
    error.set('');
    stopped = false;
    previous = null;
    turns.set([...history, { question, answer: '' }]);
    try {
      const sessionId = await openBot();
      if (stopped) return;
      const operation = (await host.beginMutation('agent', 'askQuickQuestion', {
        sessionId,
        question,
        requestId,
        continueFrom,
      })) as OriginalMutation;
      active = operation;
      if (stopped) operation.cancel();
      for (;;) {
        const event = await operation.next();
        if (!event || event.kind === 'not_dispatched') throw Error(tr('Quick question failed.'));
        if (event.kind === 'progress' && alive && typeof event.value === 'string') {
          previous = requestId;
          turns.set([...history, { question, answer: event.value }]);
        }
        if (event.kind === 'finished') {
          returned(event.reply);
          if (event.cleanupError) throw Error(event.cleanupError);
          break;
        }
      }
    } catch (cause) {
      if (alive && !stopped) error.set(String(cause));
    } finally {
      active = undefined;
      if (alive) running.set(false);
    }
  };
  const reset = () => {
    if (!running()) {
      turns.set([]);
      previous = null;
      error.set('');
    }
  };
  return { turns, running, error, ask, stop, reset };
}
