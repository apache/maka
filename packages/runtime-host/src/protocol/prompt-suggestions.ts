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

import { requireEntityId, requireExactRecord, requireRecord, requireUtf8String } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export interface PromptSuggestionInput {
  readonly sessionId: string;
  /**
   * The draft the user has typed so far. Present, the Host predicts a short
   * continuation to append to it; absent, it predicts the whole next message.
   */
  readonly prefix?: string;
}

/** Longest draft, in UTF-8 bytes, a continuation request may carry. */
export const PROMPT_CONTINUATION_PREFIX_MAX_BYTES = 8_192;
export type PromptSuggestionResult =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'generated';
      readonly turnId: string;
      readonly terminalEventId: string;
      readonly text: string;
    };

export const PROMPT_SUGGESTION_OPERATION_SPECS = {
  'session.prompt-suggestion.generate': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'internal_failure',
    ],
    decodeInput: (value: unknown): PromptSuggestionInput => {
      const record = requireRecord(value, 'Prompt suggestion input');
      const input = requireExactRecord(
        record,
        'Prompt suggestion input',
        Object.hasOwn(record, 'prefix') ? ['sessionId', 'prefix'] : ['sessionId'],
      );
      const sessionId = requireEntityId(input.sessionId, 'sessionId');
      if (input.prefix === undefined) return { sessionId };
      const prefix = requireUtf8String(
        input.prefix,
        'Continuation prefix',
        PROMPT_CONTINUATION_PREFIX_MAX_BYTES,
      );
      if (!prefix.trim()) throw invalidProtocolFrame('Continuation prefix is empty');
      return { sessionId, prefix };
    },
    decodeOutput: (value: unknown): PromptSuggestionResult => {
      if (typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'none') {
        requireExactRecord(value, 'Empty prompt suggestion', ['kind']);
        return { kind: 'none' };
      }
      const result = requireExactRecord(value, 'Prompt suggestion', [
        'kind',
        'turnId',
        'terminalEventId',
        'text',
      ]);
      if (result.kind !== 'generated') throw invalidProtocolFrame('Invalid prompt suggestion kind');
      const text = requireUtf8String(result.text, 'Suggestion text', 512);
      if (!text.trim() || /[\r\n]/u.test(text))
        throw invalidProtocolFrame('Invalid suggestion text');
      return {
        kind: 'generated',
        turnId: requireEntityId(result.turnId, 'turnId'),
        terminalEventId: requireEntityId(result.terminalEventId, 'terminalEventId'),
        text,
      };
    },
  }),
} as const;
