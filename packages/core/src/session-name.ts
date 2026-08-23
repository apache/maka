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
 * PR-UI-IPC-2 (@kenji msg 0474c3fe + @xuan msg 88d96a87):
 * User-visible session name normalization contract.
 *
 * `SessionHeader.name` is the title users see in the sidebar list,
 * tab headers, and any future export/share surfaces. It's
 * user-typed (sidebar inline rename) or runtime-derived (default
 * "New Chat", branch "${parent} · 分支") — both paths need the
 * same gate so the store only ever sees safe text.
 *
 * The contract is **a single pure helper** in this `@maka/core`
 * module so every write path can call it:
 *   - `sessions:create`  IPC → runtime.create → store.create
 *   - `sessions:rename`  IPC → runtime.renameSession → store.rename
 *   - `sessions:branchFromTurn`  IPC → runtime.branchFromTurn → store.create
 *
 * Pipeline (applied in order):
 *   1. **Runtime type guard**: `typeof input !== 'string'` → typed
 *      reject. IPC payloads cross a process boundary; TypeScript
 *      signature alone is not enough.
 *   2. **Unicode sanitize + cap**: delegates to the shared
 *      `sanitizeUnicodeText` helper in `text-sanitize.ts` (the single
 *      source of truth shared with `foreign-session.ts`, #1404). That
 *      pipeline is NFC → control/bidi chars → space, zero-width/invisible
 *      chars → removed, whitespace collapse, trim, code-point cap. See its
 *      module doc for the full char-class rationale. Here we pass
 *      `truncatedSuffix: ''` so a capped name doesn't grow a visible
 *      ellipsis in the sidebar.
 *   3. **Empty check**: if the sanitized result is empty, typed reject.
 *      The caller decides whether to fall back to a default or surface
 *      the error.
 *
 * Returns `{ ok: true; value }` with the normalized canonical
 * string, or `{ ok: false; error }` with a typed reason.
 *
 * Scope (out of bounds for this contract — single-responsibility):
 *   - HTML/Markdown escaping for display: the renderer/Markdown
 *     layer handles output encoding; this helper only sanitizes
 *     storage input.
 *   - URL/path encoding: session names are NEVER used as path
 *     segments (the session id is the path; name is metadata).
 *     `assertSafeSessionId` covers the id path.
 *   - Default value selection: callers decide what to do when
 *     `input === undefined` (e.g. `sessions:create` uses
 *     `'New Chat'`); this helper only accepts string inputs.
 */

import { sanitizeUnicodeText } from './text-sanitize.js';

export type NormalizeSessionNameResult = { ok: true; value: string } | { ok: false; error: string };

export const DEFAULT_SESSION_NAME = 'New Chat';

/**
 * @kenji + @xuan: code-point cap. 80 chars matches the existing
 * `store.rename` behavior; do NOT change here.
 */
export const SESSION_NAME_MAX_CODE_POINTS = 80;

export function normalizeUserSessionName(input: unknown): NormalizeSessionNameResult {
  // L1: runtime type guard — IPC payloads cross process boundary.
  if (typeof input !== 'string') {
    return { ok: false, error: 'Session name must be a string' };
  }
  // L2–L9: the shared Unicode pipeline (NFC, control/bidi → space,
  // zero-width removal, whitespace collapse, trim, code-point cap). Lives in
  // text-sanitize.ts so the session-name and foreign-session surfaces cannot
  // drift apart again (#1404). We pass `truncatedSuffix: ''` to keep this
  // surface's "silently cap at 80, no visible marker" behavior — a session
  // name truncated mid-word should not grow a dangling ellipsis in the
  // sidebar. Note the cap also runs the cleaner, so this one call covers both.
  const value = sanitizeUnicodeText(input, {
    maxCodePoints: SESSION_NAME_MAX_CODE_POINTS,
    truncatedSuffix: '',
  });
  // Empty-after-sanitize → reject. Caller decides whether to fall back to a
  // default (e.g. `'New Chat'` for create) or surface the error (e.g. inline
  // rename). Done AFTER the pipeline so we catch "sanitizes down to nothing".
  if (value === '') {
    return { ok: false, error: 'Session name cannot be empty after sanitization' };
  }
  return { ok: true, value };
}
