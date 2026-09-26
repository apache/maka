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

/**
 * Primitives shared by the retrieval surfaces that read stored transcripts.
 *
 * These live apart from any one retrieval implementation because more than one
 * needs them and they must not drift:
 *
 *   - Recall matches terms against folded, redacted transcript text and labels
 *     what it matched with the same message-kind vocabulary.
 *   - The Agent's global history search folds session headers and records to
 *     the same form before scanning them.
 *
 * Nothing here touches storage, privacy state, or the search contract's
 * envelopes — these are pure functions and constants, so a caller can adopt
 * one without inheriting a retrieval strategy.
 */

import type { ThreadSearchMatchKind } from './search.js';
import type { StoredMessage } from './session.js';

/** Max sessions scanned per query (newest first by lastMessageAt). */
export const MAX_SESSIONS_SCANNED = 200;

/**
 * NFC + lowercase canonicalization for substring match. NOT a security
 * boundary — purely for case-insensitive + composed-form matching.
 */
export function foldForMatch(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

/** Stable result classification shared by Desktop navigation and Agent tools. */
export function threadSearchMatchKind(message: StoredMessage): ThreadSearchMatchKind {
  switch (message.type) {
    case 'user':
      return 'user_message';
    case 'assistant':
      return 'assistant_message';
    case 'tool_call':
      return 'tool_intent';
    case 'tool_result':
      return 'tool_result';
    case 'permission_decision':
    case 'token_usage':
    case 'turn_state':
    case 'workhub_coordination':
    case 'system_note':
      throw new Error(`Message type ${message.type} is not searchable`);
  }
}
