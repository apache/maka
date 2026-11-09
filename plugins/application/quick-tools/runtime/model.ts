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

import { host } from 'maka/host';
import type { SuggestionInput, SuggestionResult } from '../shared/plugin';
import type { OriginalMutation } from '../../../../products/maka/workbench/app/host';
import type { OperationReply } from '../../../../packages/plugin-sdk/src/index';
const local = (): SuggestionResult => ({ source: 'local', ids: [] });
let queue: Promise<unknown> = Promise.resolve();
let sessionId: string | undefined;
function returned(reply: OperationReply): unknown {
  const receipt = reply.receipt;
  if (receipt.kind !== 'recorded' || receipt.outcome.kind !== 'returned')
    throw Error('AI ranking did not return a result');
  return receipt.outcome.value;
}
export function rankOptions(
  input: SuggestionInput,
  signal: AbortSignal,
): Promise<SuggestionResult> {
  const task = queue
    .catch(() => {})
    .then(async () => {
      if (signal.aborted) return local();
      if (!sessionId) {
        const opened = (await host.mutation('agent', 'openBot', {})) as { reply: OperationReply };
        const value = returned(opened.reply) as { kind: string; sessionId?: string };
        if (value.kind !== 'opened' || !value.sessionId) return local();
        sessionId = value.sessionId;
      }
      if (signal.aborted) return local();
      const operation = (await host.beginMutation('agent', 'rankQuickTools', {
        sessionId,
        ...input,
      })) as OriginalMutation;
      const cancel = () => operation.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        for (;;) {
          const event = await operation.next();
          if (!event || event.kind === 'not_dispatched') return local();
          if (event.kind !== 'finished') continue;
          if (event.cleanupError) throw Error(event.cleanupError);
          if (signal.aborted) return local();
          const result = returned(event.reply) as SuggestionResult;
          if (!Array.isArray(result.ids) || !['local', 'assistant', 'jev'].includes(result.source))
            throw Error('Invalid AI ranking result');
          return {
            ...result,
            ids: [
              ...new Set(
                result.ids.filter((id) =>
                  input.candidates.some((candidate) => candidate.id === id),
                ),
              ),
            ].slice(0, 8),
          };
        }
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    });
  queue = task;
  return task;
}
