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
 * Canonical parser for `NO_REAL_CONNECTION:<reason>` failures.
 *
 * The `NO_REAL_CONNECTION` code, its reason tokens, and the
 * `NO_REAL_CONNECTION:<reason>: <message>` wire shape that IPC wrapping
 * produces are locale-independent protocol values. Presentation copy is a
 * surface concern: the Desktop resolves its own localized table from the
 * parsed reason, and the CLI renders its own line, so this module owns
 * parsing only — producers stay free to word the embedded message in their
 * own language because consumers never display it.
 *
 * Pure & sync.
 */

import type { ChatConfigurationReason } from './connection-readiness.js';

export const NO_REAL_CONNECTION_CODE = 'NO_REAL_CONNECTION';

/**
 * Every reason, mirroring the canonical union in `connection-readiness`.
 * `satisfies` rejects tokens that are not in the union, and the
 * `AssertNever` alias below fails the build when the union gains a reason
 * this list is missing, so the parser's known-token set cannot silently
 * drift from the taxonomy.
 */
export const CHAT_CONFIGURATION_REASONS = [
  'missing_default_connection',
  'connection_missing',
  'connection_disabled',
  'missing_api_key',
  'missing_model',
  'empty_model_list',
  'model_not_enabled',
  'model_not_chat_capable',
  'fake_backend',
  'provider_retired',
] as const satisfies readonly ChatConfigurationReason[];

type AssertNever<T extends never> = T;
type MissingChatConfigurationReasons = AssertNever<
  Exclude<ChatConfigurationReason, (typeof CHAT_CONFIGURATION_REASONS)[number]>
>;

const KNOWN_CHAT_CONFIGURATION_REASONS: ReadonlySet<string> = new Set(CHAT_CONFIGURATION_REASONS);

// `\bNO_REAL_CONNECTION\b` pins the whole code: the trailing boundary stops it
// matching a longer word like `NO_REAL_CONNECTIONS` (the reason group is
// optional, so without the boundary that prefix alone would falsely match and
// swallow an unrelated error). Then capture the reason token whole, up to the
// next delimiter (`:` in the wrapped `...:<reason>: <msg>` form, whitespace, or
// end), so a token that only prefixes a known reason (`missing_api_key2`) is
// not mistaken for it.
const NO_REAL_CONNECTION_RE = /\bNO_REAL_CONNECTION\b(?::([^\s:]+))?/;

export interface ParsedNoRealConnectionError {
  /** True when the error is a `NO_REAL_CONNECTION` failure. */
  matched: boolean;
  /** The known reason, or `undefined` for a missing/unrecognized token. */
  reason?: ChatConfigurationReason;
}

/**
 * Classify a thrown error: whether it is a NO_REAL_CONNECTION failure and, if
 * so, its reason. A matched error with a missing or unrecognized token yields
 * `{ matched: true, reason: undefined }`, so a caller still renders generic fix
 * copy rather than mistaking it for an unrelated failure and re-throwing.
 */
export function parseNoRealConnectionError(error: unknown): ParsedNoRealConnectionError {
  const raw = error instanceof Error ? error.message : String(error);
  const match = raw.match(NO_REAL_CONNECTION_RE);
  if (!match) return { matched: false };
  const token = match[1];
  return {
    matched: true,
    reason:
      token && KNOWN_CHAT_CONFIGURATION_REASONS.has(token)
        ? (token as ChatConfigurationReason)
        : undefined,
  };
}
