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

import { requireEntityId, requireExactRecord, requireUtf8String } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export interface PromptSuggestionInput { readonly sessionId: string }
export type PromptSuggestionResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'generated'; readonly turnId: string; readonly terminalEventId: string; readonly text: string };

export const PROMPT_SUGGESTION_OPERATION_SPECS = {
  'session.prompt-suggestion.generate': defineOperation({
    mode: 'command', availability: 'ready',
    errors: ['host_not_ready', 'host_draining', 'operation_unavailable', 'not_found', 'internal_failure'],
    decodeInput: (value: unknown): PromptSuggestionInput => {
      const input = requireExactRecord(value, 'Prompt suggestion input', ['sessionId']);
      return { sessionId: requireEntityId(input.sessionId, 'sessionId') };
    },
    decodeOutput: (value: unknown): PromptSuggestionResult => {
      if (typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'none') {
        requireExactRecord(value, 'Empty prompt suggestion', ['kind']);
        return { kind: 'none' };
      }
      const result = requireExactRecord(value, 'Prompt suggestion', ['kind', 'turnId', 'terminalEventId', 'text']);
      if (result.kind !== 'generated') throw invalidProtocolFrame('Invalid prompt suggestion kind');
      const text = requireUtf8String(result.text, 'Suggestion text', 512);
      if (!text.trim() || /[\r\n]/u.test(text)) throw invalidProtocolFrame('Invalid suggestion text');
      return { kind: 'generated', turnId: requireEntityId(result.turnId, 'turnId'),
        terminalEventId: requireEntityId(result.terminalEventId, 'terminalEventId'), text };
    },
  }),
} as const;
