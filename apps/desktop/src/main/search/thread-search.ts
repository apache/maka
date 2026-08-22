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
 * Local thread / session search — bounded scan, no FTS5.
 *
 * Anchors:
 *   - Current behavior is pinned by the focused thread-search tests.
 *   - Contract: `@maka/core/search` (PR-SEARCH-0 + PR-SEARCH-1.5 `SearchResultTarget`).
 *   - Implementation lane greenlight: xuan msg `074714c7`.
 *
 * Scope (this module, PR-SEARCH-2):
 *   - Pure helper. Accepts an injected `ThreadSearchDeps` so unit tests can
 *     supply fake `listSessions` / `readMessages` without an Electron runtime.
 *   - Bounded substring scan over user-visible message types only:
 *       UserMessage / AssistantMessage / ToolCallMessage / ToolResultMessage.
 *     Excluded: SystemNoteMessage / TokenUsageMessage / TurnStateMessage /
 *     PermissionDecisionMessage.
 *   - Excludes sessions with `backend === 'fake'` (retired local simulation,
 *     plus the e2e fixtures that still seed it) and archived sessions
 *     (managed in Settings › 活动 › 已归档任务).
 *   - Snippets are redacted via `@maka/core/redaction.redactSecrets()`.
 *   - `ToolResultMessage.content` is JSON-serialized for scan and capped to
 *     the first `TOOL_RESULT_SCAN_CAP_BYTES` bytes (worst-case bound).
 *   - Result limits come from `@maka/core/search.normalizeSearchLimit`
 *     (default 5, max `SEARCH_MAX_LIMIT=10`).
 *   - Total payload bytes (sum of snippets) capped at `TOTAL_PAYLOAD_CAP_BYTES`.
 *   - Per-result snippet capped at `SNIPPET_MAX_CODE_POINTS`.
 *   - Returns `SearchResult[]` per PR-SEARCH-0 shape with
 *     `source: 'thread'` and `target: { kind:'thread', sessionId, turnId? }`
 *     per PR-SEARCH-1.5. `url` is left undefined (thread navigation does NOT
 *     use `maka://session` — see `packages/ui/src/maka-uri.ts:24`).
 *
 * Hard no-go (enforced by source gate at review):
 *   - No `fetch` / `XMLHttpRequest` / `new WebSocket` / `BrowserWindow`.
 *   - No `electron` imports — runs in main but stays Electron-agnostic via DI.
 *   - No FTS5 / SQLite / better-sqlite3.
 *   - No telemetry emission of query body.
 *   - No `maka://session` URI construction.
 */

import { collapseSessionRevisions } from '@maka/core/session-revisions';

import { normalizeSearchLimit, normalizeSearchQuery } from '@maka/core/search';

import { redactSecrets } from '@maka/core/redaction';

import { validateWorkspacePrivacyContext } from '@maka/core/incognito';
import type { SearchErrorReason, SearchResult } from '@maka/core/search';

import type { SessionSummary, StoredMessage } from '@maka/core/session';

/** Max scan bytes per ToolResultMessage.content (JSON-serialized). */
export const TOOL_RESULT_SCAN_CAP_BYTES = 10_240;

/** Max code points retained in a result snippet. */
export const SNIPPET_MAX_CODE_POINTS = 240;

/** Half-window of snippet context characters on each side of the match. */
export const SNIPPET_CONTEXT_HALF = 80;

/** Cap on total snippet bytes (UTF-8) summed across all results. */
export const TOTAL_PAYLOAD_CAP_BYTES = 64 * 1024;

/** Max sessions scanned per query (newest first by lastMessageAt). */
export const MAX_SESSIONS_SCANNED = 200;

/** Returned source kind — locked to `'thread'` in v1. */
export const THREAD_SOURCE = 'thread' as const;

/**
 * Pure dependency injection. Production wiring binds these to the real
 * runtime; tests pass in-memory fakes.
 *
 * PR-SEARCH-2.5 (@xuan msg `2c55b975`): `getPrivacyContext` returns the
 * main-authority workspace privacy snapshot. Source is `unknown`
 * because even though the production wiring controls it, the helper
 * itself MUST validate via `validateWorkspacePrivacyContext` — a
 * future swap to a real authority (settings IPC etc.) must not bypass
 * the validator. Renderer payloads MUST NOT reach this dep; production
 * wiring binds it to a main-side authority only.
 */
export interface ThreadSearchDeps {
  listSessions(): Promise<SessionSummary[]>;
  readMessages(sessionId: string): Promise<StoredMessage[] | null>;
  /**
   * Main-authority workspace privacy snapshot. Returned as `unknown`
   * deliberately — the helper validates the payload with
   * `validateWorkspacePrivacyContext` before reading any field. Source
   * MUST be main-side (settings, workspace owner). Renderer payloads
   * MUST NOT flow into this dep.
   */
  getPrivacyContext(): Promise<unknown>;
}

/**
 * Public API surface. The IPC handler in `main.ts` wraps this; nothing
 * else should call it directly.
 *
 * Accepts `unknown` because the IPC payload crosses a process boundary —
 * TypeScript's `SearchRequest` annotation in the handler is compile-time
 * only. A renderer can send anything; malformed input must fail closed
 * with an error envelope. Dependency adapters project ordinary I/O
 * failures before calling this function. Same defense pattern as PR-MEMORY-1
 * `validateMemoryWriteRequest` and PR-UI-IPC-1 baseUrl normalize
 * (@xuan msg `2f1aba55` fixup).
 */
export async function runThreadSearch(
  request: unknown,
  deps: ThreadSearchDeps,
): Promise<SearchResult[] | { ok: false; reason: SearchErrorReason; message: string }> {
  // L1: runtime shape guard. Renderer payload is untrusted across the
  // IPC boundary. Null / non-object / missing fields → typed reject.
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { ok: false, reason: 'invalid_query', message: 'search request must be an object' };
  }
  const record = request as Record<string, unknown>;

  // L2: source enum gate — this module only handles `'thread'`. The
  // shape check above already rejected non-objects, so reading
  // `record.source` is safe.
  if (record.source !== THREAD_SOURCE) {
    return { ok: false, reason: 'disabled', message: 'thread search only handles source=thread' };
  }

  // L3: query / limit normalization via @maka/core helpers — single
  // chokepoint, never bypass. Both already guard typeof + finite.
  const queryResult = normalizeSearchQuery(record.query);
  if (!queryResult.ok) {
    return queryResult;
  }
  const limitResult = normalizeSearchLimit(record.limit);
  if (!limitResult.ok) {
    return limitResult;
  }

  // L4: privacy gate (PR-SEARCH-2.5 @xuan `2c55b975`). Main-owned
  // privacy authority. Two early-return paths share the same
  // `reason:'incognito_active'` to avoid an extra UI state:
  //   - active incognito (user toggled on): `incognitoActive === true`
  //   - malformed authority payload (system fail-closed): validator
  //     reject treated as if incognito were active
  // Both paths MUST NOT touch `listSessions` / `readMessages`.
  // Distinguishing message wording is kept for diagnostics; consumers
  // can read `message` if they need to differentiate.
  const privacyPayload = await deps.getPrivacyContext();
  const privacyResult = validateWorkspacePrivacyContext(privacyPayload);
  if (!privacyResult.ok) {
    return {
      ok: false,
      reason: 'incognito_active',
      message: 'Search is disabled because workspace privacy state could not be verified.',
    };
  }
  if (privacyResult.value.incognitoActive) {
    return {
      ok: false,
      reason: 'incognito_active',
      message: 'Search is disabled while incognito is active.',
    };
  }

  const queryFolded = foldForMatch(queryResult.value);
  const maxResults = limitResult.value;

  const sessions = collapseSessionRevisions(await deps.listSessions())
    // Exclude fake-backend sessions. The rail still shows them (marked
    // stale) because they are task records, but their transcripts are
    // simulator output — returning fabricated text as a hit on the user's own
    // history is worse than returning nothing. Retiring the backend (#3211)
    // did not make that content real, so the filter stays.
    //
    // Archived tasks are excluded for the same reason the command palette
    // skips them: archiving a task says it is out of the working set, and a
    // result you cannot land on anywhere but Settings is not a chat hit. They
    // also stop consuming the `MAX_SESSIONS_SCANNED` budget, which they shared
    // with active tasks while being unreachable from the rail.
    .filter((session) => session.backend !== 'fake' && !session.isArchived)
    // Newest first by lastMessageAt; secondary by id for determinism.
    .sort((a, b) => {
      const ts = (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
      if (ts !== 0) return ts;
      return a.id.localeCompare(b.id);
    })
    .slice(0, MAX_SESSIONS_SCANNED);

  const results: SearchResult[] = [];
  let totalBytes = 0;
  let truncated = false;

  for (const session of sessions) {
    if (results.length >= maxResults) {
      truncated = true;
      break;
    }

    const titleHit = findMatch(session.name, queryFolded);
    if (titleHit !== undefined) {
      const snippet = capCodePoints(
        redactSecrets(buildSnippet(session.name, titleHit, SNIPPET_CONTEXT_HALF)),
        SNIPPET_MAX_CODE_POINTS,
      );
      const snippetBytes = Buffer.byteLength(snippet, 'utf8');
      if (totalBytes + snippetBytes > TOTAL_PAYLOAD_CAP_BYTES) {
        truncated = true;
        break;
      }
      totalBytes += snippetBytes;
      results.push({
        source: THREAD_SOURCE,
        title: session.name,
        summary: '任务标题',
        snippet,
        target: {
          kind: 'thread',
          sessionId: session.id,
        },
      });
      if (results.length >= maxResults) {
        truncated = true;
        break;
      }
    }

    const messages = await deps.readMessages(session.id);
    if (!messages) continue;

    for (const [sequence, message] of messages.entries()) {
      if (results.length >= maxResults) {
        truncated = true;
        break;
      }

      const candidate = collectSearchableText(message);
      if (candidate === undefined) continue;

      const hit = findMatch(candidate, queryFolded);
      if (hit === undefined) continue;

      // Build the snippet, redact secrets, cap length.
      const snippet = capCodePoints(
        redactSecrets(buildSnippet(candidate, hit, SNIPPET_CONTEXT_HALF)),
        SNIPPET_MAX_CODE_POINTS,
      );

      const snippetBytes = Buffer.byteLength(snippet, 'utf8');
      if (totalBytes + snippetBytes > TOTAL_PAYLOAD_CAP_BYTES) {
        truncated = true;
        break;
      }
      totalBytes += snippetBytes;

      const turnId = (message as { turnId?: string }).turnId;
      results.push({
        source: THREAD_SOURCE,
        title: session.name,
        summary: formatSearchResultSummary(message),
        snippet,
        // PR-SEARCH-1.5: navigation target via discriminated union; no
        // `url` field for thread results (maka://session is deferred).
        target: {
          kind: 'thread',
          sessionId: session.id,
          ...(turnId ? { turnId } : {}),
          sequence,
        },
      });
    }
  }

  if (truncated && results.length > 0) {
    results[results.length - 1] = { ...results[results.length - 1]!, truncated: true };
  }

  return results;
}

export function formatSearchResultSummary(message: StoredMessage): string {
  switch (message.type) {
    case 'user':
      return '用户消息';
    case 'assistant':
      return '助手回复';
    case 'tool_call':
      return message.displayName ? `工具调用：${message.displayName}` : `工具调用：${message.toolName}`;
    case 'tool_result':
      return message.isError ? '工具结果：失败' : '工具结果：成功';
    case 'permission_decision':
      return '权限记录';
    case 'token_usage':
      return '用量记录';
    case 'turn_state':
      return '回合状态';
    case 'system_note':
      return '系统记录';
  }
}

/**
 * Extract user-visible answer text from a stored message. Returns `undefined`
 * for excluded message kinds (system notes, token usage, turn state,
 * permission decisions). This is the only "what counts as searchable
 * transcript content" gate; adding new searchable surfaces requires
 * extending this switch + a corresponding test.
 *
 * For ToolResultMessage, the `content` is JSON-serialized and capped
 * at `TOOL_RESULT_SCAN_CAP_BYTES` so a 100 MB tool result doesn't
 * inflate scan time.
 */
export function collectSearchableText(message: StoredMessage): string | undefined {
  switch (message.type) {
    case 'user':
      // Prefer the human-facing view so skill-invocation envelopes do not
      // dominate local search hits for what the user actually typed.
      return message.displayText ?? message.text;
    case 'assistant':
      // Search result snippets are a transcript surface. Assistant
      // reasoning/thinking may be rendered separately in the live chat,
      // but it is not answer text and must not leak into local search.
      return message.text;
    case 'tool_call':
      // PR-SEARCH-2 review fixup (@xuan `2f1aba55`): index ONLY
      // `intent` — the user-visible description of what the tool call
      // is doing. `toolName` (e.g. `Bash`) and `displayName` are
      // internal labels and would let searches for `Bash` match every
      // bash invocation regardless of intent. The PR-SEARCH-1 plan
      // already locked `intent` as the only searchable field on
      // `ToolCallMessage`; the previous draft over-indexed by mistake.
      return message.intent && message.intent.length > 0 ? message.intent : undefined;
    case 'tool_result': {
      // Bounded JSON-serialize. The cap protects against pathological
      // multi-MB tool outputs (file dumps, etc.).
      let serialized: string;
      try {
        serialized = JSON.stringify(message.content);
      } catch {
        return undefined;
      }
      if (Buffer.byteLength(serialized, 'utf8') > TOOL_RESULT_SCAN_CAP_BYTES) {
        // Truncate to the cap. Use byte-safe slice via Buffer.
        const buf = Buffer.from(serialized, 'utf8').subarray(0, TOOL_RESULT_SCAN_CAP_BYTES);
        return buf.toString('utf8');
      }
      return serialized;
    }
    case 'permission_decision':
    case 'token_usage':
    case 'turn_state':
    case 'system_note':
      // Excluded — not user-typed / not user-visible content.
      return undefined;
  }
}

/**
 * NFC + lowercase canonicalization for substring match. NOT a security
 * boundary — purely for case-insensitive + composed-form matching.
 *
 * Public for tests; production callers use `runThreadSearch` only.
 */
export function foldForMatch(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

/**
 * Find the index of the first occurrence of `queryFolded` in `text`
 * (after the same fold operation). Returns the index in the original
 * (unfolded) text — JS `String.prototype.toLowerCase()` preserves
 * code-point indexing for ASCII and most CJK, which is what we need
 * for snippet extraction. Returns `undefined` on no match.
 */
export function findMatch(text: string, queryFolded: string): number | undefined {
  const folded = foldForMatch(text);
  const idx = folded.indexOf(queryFolded);
  return idx >= 0 ? idx : undefined;
}

/**
 * Extract a context window around the match. Pure substring + ellipsis
 * marker; no HTML, no markup. Caller is responsible for redaction +
 * length cap afterward.
 */
export function buildSnippet(text: string, matchIndex: number, halfWindow: number): string {
  const start = Math.max(0, matchIndex - halfWindow);
  const end = Math.min(text.length, matchIndex + halfWindow);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
}

/**
 * Cap a string to at most `maxCodePoints` code points. Uses
 * `Array.from` so surrogate pairs (emoji) are not split. Appends
 * an ellipsis when truncated.
 */
export function capCodePoints(value: string, maxCodePoints: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= maxCodePoints) return value;
  return codePoints.slice(0, maxCodePoints - 1).join('') + '…';
}
