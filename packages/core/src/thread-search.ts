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
 *     plus the e2e fixtures that still seed it). Desktop also excludes archived
 *     sessions; Agent global history opts in to them explicitly.
 *   - Snippets are redacted via `@maka/core/redaction.redactSecrets()`.
 *   - `ToolResultMessage.content` is JSON-serialized for scan and capped to
 *     the first `TOOL_RESULT_SCAN_CAP_BYTES` bytes (worst-case bound).
 *   - Result limits come from `@maka/core/search.normalizeSearchLimit`
 *     (default 5, max `SEARCH_MAX_LIMIT=10`).
 *   - Total payload bytes (sum of snippets) capped at `TOTAL_PAYLOAD_CAP_BYTES`.
 *   - Per-result snippet capped at `SNIPPET_MAX_CODE_POINTS`.
 *   - Returns a success envelope containing `SearchResult[]` plus an explicit
 *     scan-truncation bit, with each result following the PR-SEARCH-0 shape and
 *     `source: 'thread'` and `target: { kind:'thread', sessionId, turnId? }`
 *     per PR-SEARCH-1.5, extended with stable message id, match kind, and
 *     timestamp anchors for Agent global search. `url` is left undefined
 *     (thread navigation does NOT use `maka://session`).
 *
 * Hard no-go (enforced by source gate at review):
 *   - No `fetch` / `XMLHttpRequest` / `new WebSocket` / `BrowserWindow`.
 *   - No `electron` imports — runs in main but stays Electron-agnostic via DI.
 *   - No FTS5 / SQLite / better-sqlite3.
 *   - No telemetry emission of query body.
 *   - No `maka://session` URI construction.
 */

import { validateWorkspacePrivacyContext } from './incognito.js';
import { redactSecrets } from './redaction.js';
import { normalizeSearchLimit, normalizeSearchQuery } from './search.js';
import type { SearchErrorReason, SearchResult, ThreadSearchMatchKind } from './search.js';
import { collapseSessionRevisions } from './session-revisions.js';
import type { SessionSummary, StoredMessage } from './session.js';

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

/** Max encoded bytes accepted for an opaque thread-search continuation. */
export const THREAD_SEARCH_CURSOR_MAX_CHARS = 2_048;

/** Returned source kind — locked to `'thread'` in v1. */
export const THREAD_SOURCE = 'thread' as const;

/**
 * Pure dependency injection. Production wiring binds these to the real
 * runtime; tests pass in-memory fakes.
 *
 * PR-SEARCH-2.5 (@xuan msg `2c55b975`): `getPrivacyContext` returns the
 * Host-authority workspace privacy snapshot. Source is `unknown`
 * because even though production wiring controls it, the helper
 * itself MUST validate via `validateWorkspacePrivacyContext` — a
 * future swap to a real authority (settings IPC etc.) must not bypass
 * the validator. Renderer payloads MUST NOT reach this dep; production
 * wiring binds it to a main-side authority only.
 */
export interface ThreadSearchDeps {
  listSessions(): Promise<SessionSummary[]>;
  readMessages(sessionId: string, abortSignal?: AbortSignal): Promise<StoredMessage[] | null>;
  /**
   * Host-authority workspace privacy snapshot. Returned as `unknown`
   * deliberately — the helper validates the payload with
   * `validateWorkspacePrivacyContext` before reading any field. Source
   * MUST be Host-side (Runtime Host policy, Desktop settings authority,
   * or workspace owner). Untrusted request payloads MUST NOT flow into this dep.
   */
  getPrivacyContext(): Promise<unknown>;
}

export interface ThreadSearchSuccess {
  readonly ok: true;
  readonly results: SearchResult[];
  readonly truncated: boolean;
  /** Present only when another complete session-scan page is reachable. */
  readonly nextCursor?: string;
}

interface ThreadSearchCursor {
  readonly version: 1;
  readonly query: string;
  readonly lastMessageAt: number;
  readonly sessionId: string;
}

/**
 * Shared API surface. Desktop IPC and Runtime Host Agent tools wrap this
 * helper with their own authority-owned dependencies.
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
  options: {
    readonly activeSessionId?: string;
    readonly excludeSessionIds?: ReadonlySet<string>;
    /** Desktop excludes archived tasks by default; Agent global history opts in explicitly. */
    readonly includeArchived?: boolean;
    /** Keeps Agent global search from matching the user/tool text of its active turn. */
    readonly excludeTurnIds?: ReadonlySet<string>;
    readonly abortSignal?: AbortSignal;
  } = {},
): Promise<ThreadSearchSuccess | { ok: false; reason: SearchErrorReason; message: string }> {
  if (options.abortSignal?.aborted) return abortedSearch();
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

  // Matching a secret-shaped query against raw history would expose a
  // hit/no-hit membership oracle even if the returned snippet were redacted.
  // Reject such queries before touching the history authority, and match every
  // searchable field only after applying the same redaction projection.
  const redactedQuery = redactSecrets(queryResult.value);
  if (redactedQuery !== queryResult.value) {
    return {
      ok: false,
      reason: 'invalid_query',
      message: 'Search query contains credential material and cannot be searched.',
    };
  }
  const queryFolded = foldForMatch(redactedQuery);
  const cursorResult = decodeThreadSearchCursor(record.cursor, queryFolded);
  if (!cursorResult.ok) return cursorResult;

  // L4: privacy gate (PR-SEARCH-2.5 @xuan `2c55b975`). Host-owned
  // privacy authority. Two early-return paths share the same
  // `reason:'incognito_active'` to avoid an extra UI state:
  //   - active incognito (user toggled on): `incognitoActive === true`
  //   - malformed authority payload (system fail-closed): validator
  //     reject treated as if incognito were active
  // Both paths MUST NOT touch `listSessions` / `readMessages`.
  // Distinguishing message wording is kept for diagnostics; consumers
  // can read `message` if they need to differentiate.
  const privacyPayload = await deps.getPrivacyContext();
  if (options.abortSignal?.aborted) return abortedSearch();
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

  const maxResults = limitResult.value;

  const eligibleSessions = collapseSessionRevisions(
    await deps.listSessions(),
    options.activeSessionId,
  )
    // Exclude fake-backend sessions. The rail still shows them (marked stale)
    // because they are task records, but their transcripts are simulator output;
    // returning fabricated text as a hit on the user's own history is worse than
    // returning nothing. Retiring the backend (#3211) did not make that content
    // real, so the filter stays.
    .filter(
      (session) =>
        session.backend !== 'fake' &&
        (options.includeArchived === true || !session.isArchived) &&
        !options.excludeSessionIds?.has(session.id),
    )
    // Newest first by lastMessageAt; secondary by id for determinism.
    .sort((a, b) => {
      const ts = (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
      if (ts !== 0) return ts;
      return a.id.localeCompare(b.id);
    });
  if (options.abortSignal?.aborted) return abortedSearch();
  const remainingSessions = cursorResult.value
    ? eligibleSessions.filter((session) => sessionIsAfterCursor(session, cursorResult.value!))
    : eligibleSessions;
  const sessions = remainingSessions.slice(0, MAX_SESSIONS_SCANNED);
  const hasMoreSessions = remainingSessions.length > sessions.length;

  const results: SearchResult[] = [];
  let totalBytes = 0;
  let truncated = hasMoreSessions;
  let scannedCompletePage = true;

  sessionScan: for (const session of sessions) {
    if (options.abortSignal?.aborted) return abortedSearch();
    if (results.length >= maxResults) {
      truncated = true;
      scannedCompletePage = false;
      break;
    }

    const searchableTitle = redactSecrets(session.name);
    const titleHit = findMatch(searchableTitle, queryFolded);
    if (titleHit !== undefined) {
      const snippet = capCodePoints(
        buildSnippet(searchableTitle, titleHit, SNIPPET_CONTEXT_HALF),
        SNIPPET_MAX_CODE_POINTS,
      );
      const snippetBytes = Buffer.byteLength(snippet, 'utf8');
      if (totalBytes + snippetBytes > TOTAL_PAYLOAD_CAP_BYTES) {
        truncated = true;
        scannedCompletePage = false;
        break;
      }
      totalBytes += snippetBytes;
      results.push({
        source: THREAD_SOURCE,
        title: searchableTitle,
        summary: '任务标题',
        snippet,
        target: {
          kind: 'thread',
          sessionId: session.id,
          matchKind: 'session_title',
        },
      });
      if (results.length >= maxResults) {
        truncated = true;
        scannedCompletePage = false;
        break;
      }
    }

    const messages = await deps.readMessages(session.id, options.abortSignal);
    if (options.abortSignal?.aborted) return abortedSearch();
    if (!messages) continue;

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      if (messageIndex > 0 && messageIndex % 256 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (options.abortSignal?.aborted) return abortedSearch();
      const message = messages[messageIndex]!;
      if (results.length >= maxResults) {
        truncated = true;
        scannedCompletePage = false;
        break sessionScan;
      }

      const turnId = (message as { turnId?: string }).turnId;
      if (session.id === options.activeSessionId && turnId && options.excludeTurnIds?.has(turnId)) {
        continue;
      }

      const rawCandidate = collectSearchableText(message);
      if (rawCandidate === undefined) continue;
      const candidate = redactSecrets(rawCandidate);

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
        scannedCompletePage = false;
        break sessionScan;
      }
      totalBytes += snippetBytes;

      results.push({
        source: THREAD_SOURCE,
        title: redactSecrets(session.name),
        summary: formatSearchResultSummary(message),
        snippet,
        // PR-SEARCH-1.5: navigation target via discriminated union; no
        // `url` field for thread results (maka://session is deferred).
        target: {
          kind: 'thread',
          sessionId: session.id,
          ...(turnId ? { turnId } : {}),
          sequence: messageIndex,
          messageId: message.id,
          matchKind: threadSearchMatchKind(message),
          messageTimestamp: message.ts,
        },
      });
    }
  }

  if (truncated && results.length > 0) {
    results[results.length - 1] = { ...results[results.length - 1]!, truncated: true };
  }

  const lastSession = sessions.at(-1);
  const nextCursor =
    hasMoreSessions && scannedCompletePage && lastSession
      ? encodeThreadSearchCursor({
          version: 1,
          query: queryFolded,
          lastMessageAt: sessionSortTime(lastSession),
          sessionId: lastSession.id,
        })
      : undefined;
  return { ok: true, results, truncated, ...(nextCursor ? { nextCursor } : {}) };
}

function abortedSearch(): { ok: false; reason: 'aborted'; message: string } {
  return { ok: false, reason: 'aborted', message: 'History search was aborted.' };
}

function decodeThreadSearchCursor(
  input: unknown,
  query: string,
):
  | { readonly ok: true; readonly value: ThreadSearchCursor | undefined }
  | { readonly ok: false; readonly reason: 'invalid_query'; readonly message: string } {
  if (input === undefined) return { ok: true, value: undefined };
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input.length > THREAD_SEARCH_CURSOR_MAX_CHARS ||
    input.trim() !== input
  ) {
    return invalidThreadSearchCursor();
  }
  try {
    const decoded = Buffer.from(input, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== input) {
      return invalidThreadSearchCursor();
    }
    const value: unknown = JSON.parse(decoded);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return invalidThreadSearchCursor();
    }
    const cursor = value as Record<string, unknown>;
    if (
      cursor.version !== 1 ||
      cursor.query !== query ||
      typeof cursor.lastMessageAt !== 'number' ||
      !Number.isFinite(cursor.lastMessageAt) ||
      typeof cursor.sessionId !== 'string' ||
      cursor.sessionId.length === 0 ||
      cursor.sessionId.length > 256
    ) {
      return invalidThreadSearchCursor();
    }
    return {
      ok: true,
      value: {
        version: 1,
        query,
        lastMessageAt: cursor.lastMessageAt,
        sessionId: cursor.sessionId,
      },
    };
  } catch {
    return invalidThreadSearchCursor();
  }
}

function invalidThreadSearchCursor() {
  return {
    ok: false as const,
    reason: 'invalid_query' as const,
    message: 'Search cursor is invalid or belongs to another query.',
  };
}

function encodeThreadSearchCursor(cursor: ThreadSearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function sessionSortTime(session: SessionSummary): number {
  return session.lastMessageAt ?? 0;
}

function sessionIsAfterCursor(session: SessionSummary, cursor: ThreadSearchCursor): boolean {
  const timestamp = sessionSortTime(session);
  return (
    timestamp < cursor.lastMessageAt ||
    (timestamp === cursor.lastMessageAt && session.id.localeCompare(cursor.sessionId) > 0)
  );
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
    case 'system_note':
      throw new Error(`Message type ${message.type} is not searchable`);
  }
}

export function formatSearchResultSummary(message: StoredMessage): string {
  switch (message.type) {
    case 'user':
      return '用户消息';
    case 'assistant':
      return '助手回复';
    case 'tool_call':
      return message.displayName
        ? `工具调用：${message.displayName}`
        : `工具调用：${message.toolName}`;
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
