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

import { cleanup, signal, Storage } from 'nsh';
import { randomUUID } from 'crypto';
import { host } from 'maka/host';
import type { AgentHistoryChunk, OperationReply } from '../../../../packages/plugin-sdk/src/index';
import type { OriginalMutation } from './host';
import { tr } from './locale';

function returned(reply: OperationReply) {
  const receipt = reply.receipt;
  const outcome = receipt.kind === 'recorded' ? receipt.outcome : receipt;
  const failure = outcome.kind === 'returned' ? outcome.result : outcome;
  if (failure.kind === 'success') return failure.value as AgentHistoryChunk['replyInfo'];
  if ('diagnostic' in failure) {
    throw Error(
      failure.diagnostic === 'quick_question_model_required'
        ? tr('Select a model for Maka Bot first.')
        : failure.diagnostic,
    );
  }
  throw Error(tr('Quick question failed.'));
}

export interface QuickThread {
  id: string;
  turns: {
    question: string;
    answer: string;
    askedAt?: number;
    answeredAt?: number;
    replyInfo?: AgentHistoryChunk['replyInfo'];
  }[];
  updatedAt: number;
}

export function createQuickQuestion(openBot: () => Promise<string>) {
  const thread = signal<QuickThread | null>(null);
  const running = signal(false);
  const error = signal('');
  let active: OriginalMutation | undefined;
  let stopped = false;
  let scope = '';
  const prefix = async () => 'maka.quick-history.' + (await openBot()) + '.';
  const save = (value: QuickThread) => Storage.setItem(scope + value.id, JSON.stringify(value));
  const list = async (): Promise<QuickThread[]> => {
    const root = await prefix();
    const keys = (await Storage.keys()).filter((key) => key.startsWith(root));
    const values = await Promise.all(keys.map((key) => Storage.getItem(key)));
    return values.flatMap((value) => (value ? [JSON.parse(value) as QuickThread] : []));
  };
  const stop = () => {
    stopped = true;
    active?.cancel();
  };
  cleanup(stop);
  const ask = async (text: string, existing: QuickThread | null) => {
    const question = text.trim();
    if (!question || running()) return;
    const previous = existing?.turns ?? [];
    if (previous.length >= 32) {
      error.set(tr('Continue in the main window to keep chatting.'));
      return;
    }
    error.set('');
    scope = '';
    running.set(true);
    stopped = false;
    const askedAt = Date.now();
    let value: QuickThread = {
      id: existing?.id ?? randomUUID(),
      updatedAt: askedAt,
      turns: [...previous, { question, askedAt, answer: '' }],
    };
    thread.set(value);
    try {
      const sessionId = await openBot();
      scope = 'maka.quick-history.' + sessionId + '.';
      await save(value);
      if (stopped) return;
      active = (await host.beginMutation('agent', 'askQuickQuestion', {
        sessionId,
        question,
        requestId: randomUUID(),
        history: previous.map(({ question, answer }) => ({ question, answer })),
      })) as OriginalMutation;
      if (stopped) active.cancel();
      for (;;) {
        const event = await active.next();
        if (!event || event.kind === 'not_dispatched') throw Error(tr('Quick question failed.'));
        if (event.kind === 'progress' && typeof event.value === 'string') {
          value = { ...value, turns: [...previous, { question, askedAt, answer: event.value }] };
          thread.set(value);
        }
        if (event.kind === 'finished') {
          const replyInfo = returned(event.reply);
          value = {
            ...value,
            turns: [...previous, { ...value.turns.at(-1)!, answeredAt: Date.now(), replyInfo }],
          };
          thread.set(value);
          if (event.cleanupError) throw Error(event.cleanupError);
          break;
        }
      }
    } catch (cause) {
      if (!stopped) error.set(String(cause));
    } finally {
      try {
        if (scope) await save(value);
      } catch (cause) {
        error.set(String(cause));
      }
      active = undefined;
      running.set(false);
    }
  };
  return {
    thread,
    running,
    error,
    ask,
    stop,
    list,
    async remove(id: string) {
      await Storage.removeItem((await prefix()) + id);
    },
  };
}
