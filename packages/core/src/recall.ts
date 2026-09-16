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
 * Session recall — retrieval over distilled facts and visible transcript.
 *
 * Recall answers "what do I know about X" rather than "where was X mentioned".
 * It returns passages that already carry their surrounding context, so the
 * model does not have to chain a second lookup for the common case.
 *
 * Shape of one call:
 *
 *   1. Admission. Credential-shaped terms are rejected before any corpus is
 *      touched, and workspace privacy is validated fail-closed.
 *   2. Distilled layer. `searchFacts` reads already-extracted statements.
 *   3. Transcript layer. A cheap candidate source narrows the scan, the real
 *      predicate decides, BM25 ranks, a per-Session quota diversifies, and
 *      passages are assembled from the winners.
 *
 * Two invariants hold the design together:
 *
 *   - **The candidate source filters; this module decides.** `listCandidates`
 *     may over-select freely but must never under-select: its result has to be
 *     a superset of the true matches. Verification re-runs the exact predicate
 *     `indexOf(fold(redact(extract(m))), fold(term))` that a full scan would,
 *     so swapping candidate sources cannot change which messages match.
 *   - **Redaction precedes matching.** Substring matching plus a hit/no-hit
 *     signal is a prefix-extension oracle, so terms are matched against
 *     redacted text only. A candidate source may read raw records, but its
 *     output never reaches a caller without passing verification first.
 *
 * Scoring is Okapi BM25 with Lucene's parameters and Lucene's smoothed idf,
 * which never goes negative for a term that appears in most of the corpus,
 * plus one weight that BM25 has no way to express: a tool result's term
 * density reflects machine output rather than relevance.
 */

import { validateWorkspacePrivacyContext } from './incognito.js';
import { redactSecrets } from './redaction.js';
import { SEARCH_QUERY_MAX_CHARS } from './search.js';
import { collapseSessionRevisions } from './session-revisions.js';
import type { SessionSummary, StoredMessage } from './session.js';
import {
  collectSearchableText,
  foldForMatch,
  MAX_SESSIONS_SCANNED,
  threadSearchMatchKind,
} from './thread-search.js';

/** Okapi BM25 term-frequency saturation, Lucene's default. */
export const RECALL_BM25_K1 = 1.2;

/** Okapi BM25 length normalization, Lucene's default. */
export const RECALL_BM25_B = 0.75;

/** Passages returned when the caller does not ask for a specific count. */
export const RECALL_DEFAULT_LIMIT = 8;

/** Upper bound on passages in one envelope. */
export const RECALL_MAX_LIMIT = 25;

/** Upper bound on distinct query terms. */
export const RECALL_MAX_TERMS = 8;

/** Distilled statements returned alongside passages. */
export const RECALL_FACT_LIMIT = 10;

/** Visible neighbours taken on each side of an anchor, within its turn. */
export const RECALL_PASSAGE_NEIGHBOURS = 2;

/** Cap on total passage bytes (UTF-8) summed across one envelope. */
export const RECALL_TOTAL_PAYLOAD_CAP_BYTES = 96 * 1024;

/** Cap on one passage. */
export const RECALL_PASSAGE_MAX_BYTES = 12 * 1024;

/**
 * Candidate ceiling. A source that would exceed it must decline rather than
 * truncate: a truncated candidate set is no longer a superset, and the
 * matches it dropped would vanish without any error.
 */
export const RECALL_CANDIDATE_LIMIT = 5000;

/**
 * Weight on a tool result's score.
 *
 * BM25's length normalization already handles a long document with ordinary
 * term density. It does not handle a document that is almost entirely the
 * query terms — a `grep` or `find` result whose every line is the term scores
 * above the answer that actually explains it, however long it is. That density
 * is an artifact of machine output rather than evidence of relevance to a
 * question, which is a fact about the message's kind and cannot be expressed
 * as a length. Tool results stay reachable, they just stop outranking prose.
 */
const RECALL_TOOL_RESULT_WEIGHT = 0.5;

/** Cap on one message inside a passage. */
export const RECALL_MESSAGE_MAX_BYTES = 4 * 1024;

/** Quote and backslash, the two printable characters `JSON.stringify` escapes. */
const JSON_ESCAPED_PRINTABLE_PATTERN = /["\\]/u;

/** First code point `JSON.stringify` leaves unescaped. */
const FIRST_UNESCAPED_CODE_POINT = 0x20;

/**
 * A term containing a character that `JSON.stringify` escapes is stored in a
 * different literal form than it was typed, so a candidate source scanning
 * serialized records would under-select it. Such terms force a full scan.
 */
function hasJsonEscapedCharacter(term: string): boolean {
  if (JSON_ESCAPED_PRINTABLE_PATTERN.test(term)) return true;
  for (const character of term) {
    if ((character.codePointAt(0) ?? 0) < FIRST_UNESCAPED_CODE_POINT) return true;
  }
  return false;
}

export interface RecallRequest {
  /** Literal terms, matched case-insensitively as substrings and OR-combined. */
  readonly terms: readonly string[];
  /** The model's own framing. Never matched; carried into `gaps` for context. */
  readonly question?: string;
  readonly limit?: number;
  /** Restrict recall to one Session. */
  readonly sessionId?: string;
  readonly since?: number;
  readonly until?: number;
}

export interface RecallFact {
  readonly content: string;
  readonly kind: string;
  readonly observedAt: number;
  readonly matchedTerms: readonly string[];
}

export interface RecallPassageMessage {
  readonly messageId: string;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly matchKind: string;
  readonly text: string;
  readonly timestamp: number;
  readonly isAnchor: boolean;
}

export interface RecallPassage {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly turnId?: string;
  readonly anchorMessageId: string;
  readonly messages: readonly RecallPassageMessage[];
  readonly matchedTerms: readonly string[];
  readonly score: number;
  readonly lastMessageAt?: number;
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
  readonly truncated?: boolean;
}

export interface RecallSuccess {
  readonly ok: true;
  readonly facts: readonly RecallFact[];
  readonly passages: readonly RecallPassage[];
  /** What the search covered and what it did not find, for the model to read. */
  readonly gaps: string;
  /** True when the candidate source was bypassed for a full scan. */
  readonly scannedFully: boolean;
}

/**
 * Recall's own failure vocabulary. It deliberately does not reuse the search
 * contract's reasons: recall fails for reasons search has no notion of, and
 * widening a shared union would push them onto every other search surface.
 */
export type RecallFailureReason = 'invalid_query' | 'incognito_active' | 'not_found' | 'aborted';

export interface RecallFailure {
  readonly ok: false;
  readonly reason: RecallFailureReason;
  readonly message: string;
}

export type RecallResult = RecallSuccess | RecallFailure;

/**
 * One row offered by a candidate source. `message` is already decoded, which
 * keeps this module free of any storage encoding, including the chunked
 * payload form used for records above the inline size limit.
 */
export interface RecallCandidate {
  readonly sessionId: string;
  readonly message: StoredMessage;
}

export interface RecallDeps {
  listSessions(): Promise<SessionSummary[]>;
  readMessages(sessionId: string, abortSignal?: AbortSignal): Promise<StoredMessage[] | null>;
  /**
   * Host-authority workspace privacy snapshot, returned as `unknown` so this
   * module validates it rather than trusting its wiring.
   */
  getPrivacyContext(): Promise<unknown>;
  /**
   * Optional narrow-then-verify source. It MUST return a superset of the true
   * matches, or results are silently lost; returning `null` declines the fast
   * path for this query and falls back to a full scan.
   */
  listCandidates?(input: {
    readonly terms: readonly string[];
    readonly sessionIds: readonly string[];
    readonly abortSignal?: AbortSignal;
  }): Promise<readonly RecallCandidate[] | null>;
  /** Corpus-wide count of searchable messages, used for idf. */
  countSearchableMessages?(input: {
    readonly sessionIds: readonly string[];
  }): Promise<number | null>;
  /**
   * Optional distilled-fact source. `sessionId` lets the adapter resolve the
   * workspace scope those facts were recorded under; without it only globally
   * scoped facts are reachable.
   */
  searchFacts?(input: {
    readonly sessionId?: string;
    readonly terms: readonly string[];
    readonly limit: number;
  }): Promise<readonly RecallFact[]>;
}

export interface RecallOptions {
  readonly activeSessionId?: string;
  /** Keeps recall from matching the user/tool text of its own turn. */
  readonly excludeTurnIds?: ReadonlySet<string>;
  readonly includeArchived?: boolean;
  readonly abortSignal?: AbortSignal;
}

interface VerifiedHit {
  readonly sessionId: string;
  readonly message: StoredMessage;
  readonly turnId?: string;
  readonly length: number;
  readonly tf: ReadonlyMap<string, number>;
  readonly matchedTerms: readonly string[];
  score: number;
}

interface CollectHitsInput {
  readonly terms: readonly string[];
  readonly folded: readonly string[];
  readonly sessionIds: readonly string[];
  readonly forceFullScan: boolean;
  readonly since?: number;
  readonly until?: number;
  readonly excludeTurnIds?: ReadonlySet<string>;
  readonly activeSessionId?: string;
  readonly abortSignal?: AbortSignal;
}

export async function runRecall(
  request: unknown,
  deps: RecallDeps,
  options: RecallOptions = {},
): Promise<RecallResult> {
  if (options.abortSignal?.aborted) return aborted();

  const normalized = normalizeRecallRequest(request);
  if (!normalized.ok) return normalized;
  const { terms, folded, limit, sessionId, since, until, question } = normalized.value;

  const privacyPayload = await deps.getPrivacyContext();
  if (options.abortSignal?.aborted) return aborted();
  const privacy = validateWorkspacePrivacyContext(privacyPayload);
  if (!privacy.ok) {
    return {
      ok: false,
      reason: 'incognito_active',
      message: 'Recall is unavailable because workspace privacy state could not be verified.',
    };
  }
  if (privacy.value.incognitoActive) {
    return {
      ok: false,
      reason: 'incognito_active',
      message: 'Recall is unavailable while incognito is active.',
    };
  }

  const sessions = eligibleSessions(
    collapseSessionRevisions(await deps.listSessions(), options.activeSessionId),
    {
      ...(sessionId !== undefined ? { sessionId } : {}),
      includeArchived: options.includeArchived === true,
    },
  );
  if (options.abortSignal?.aborted) return aborted();

  const facts = await readFacts(deps, terms, options);
  if (options.abortSignal?.aborted) return aborted();

  const collected = await collectHits(deps, {
    terms,
    folded,
    sessionIds: sessions.map((session) => session.id),
    forceFullScan: terms.some(hasJsonEscapedCharacter),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(options.excludeTurnIds ? { excludeTurnIds: options.excludeTurnIds } : {}),
    ...(options.activeSessionId ? { activeSessionId: options.activeSessionId } : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  });
  if (!collected) return aborted();

  scoreHits(collected.hits, folded, collected.corpusSize);
  collected.hits.sort((left, right) => right.score - left.score || compareHitOrder(left, right));

  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const anchors = applySessionQuota(collected.hits, limit);
  const passages = await assemblePassages(deps, anchors, sessionById, options);
  if (!passages) return aborted();

  return {
    ok: true,
    facts,
    passages,
    gaps: describeGaps({
      terms,
      facts,
      hits: collected.hits,
      sessions,
    }),
    scannedFully: collected.scannedFully,
  };
}

/** Visible neighbours one expansion may add on each side of an anchor. */
export const RECALL_EXPAND_MAX_NEIGHBOURS = 8;

export interface RecallExpandRequest {
  readonly sessionId: string;
  /** A passage anchor returned by `runRecall`. */
  readonly anchorMessageId: string;
  readonly before?: number;
  readonly after?: number;
}

/**
 * Widens one passage around the anchor a recall envelope already reported.
 *
 * Expansion exists so the common case stays a single call: `runRecall` returns
 * enough context to answer most questions, and only a caller that actually
 * needs more pays for it. The projection is the same one recall uses, so an
 * expanded passage can never reveal content a passage could not.
 */
export async function expandRecallPassage(
  request: unknown,
  deps: RecallDeps,
  options: RecallOptions = {},
): Promise<{ readonly ok: true; readonly passage: RecallPassage } | RecallFailure> {
  if (options.abortSignal?.aborted) return aborted();

  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { ok: false, reason: 'invalid_query', message: 'Expand request must be an object.' };
  }
  const record = request as Record<string, unknown>;
  const sessionId = optionalString(record.sessionId);
  const anchorMessageId = optionalString(record.anchorMessageId);
  if (!sessionId || !anchorMessageId) {
    return {
      ok: false,
      reason: 'invalid_query',
      message: 'Expand requires a Session id and a passage anchor.',
    };
  }
  const before = normalizeSpan(record.before);
  const after = normalizeSpan(record.after);
  if (before === undefined || after === undefined) {
    return {
      ok: false,
      reason: 'invalid_query',
      message: `Expand bounds must be between 0 and ${RECALL_EXPAND_MAX_NEIGHBOURS}.`,
    };
  }

  const privacyPayload = await deps.getPrivacyContext();
  if (options.abortSignal?.aborted) return aborted();
  const privacy = validateWorkspacePrivacyContext(privacyPayload);
  if (!privacy.ok || privacy.value.incognitoActive) {
    return {
      ok: false,
      reason: 'incognito_active',
      message: 'Recall is unavailable while incognito is active.',
    };
  }

  const sessions = eligibleSessions(
    collapseSessionRevisions(await deps.listSessions(), options.activeSessionId),
    { sessionId, includeArchived: options.includeArchived === true },
  );
  if (options.abortSignal?.aborted) return aborted();
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) {
    return { ok: false, reason: 'not_found', message: 'That Session was not found.' };
  }

  const transcript = await deps.readMessages(sessionId, options.abortSignal);
  if (options.abortSignal?.aborted) return aborted();
  if (!transcript) {
    return { ok: false, reason: 'not_found', message: 'That Session was not found.' };
  }

  const message = transcript.find(
    (candidate) =>
      candidate.id === anchorMessageId && collectSearchableText(candidate) !== undefined,
  );
  if (!message) {
    return { ok: false, reason: 'not_found', message: 'That passage anchor was not found.' };
  }

  const turnId = (message as { turnId?: string }).turnId;
  const passage = buildPassage(
    {
      sessionId,
      message,
      ...(turnId ? { turnId } : {}),
      length: 0,
      tf: new Map(),
      matchedTerms: [],
      score: 0,
    },
    transcript,
    session,
    RECALL_PASSAGE_MAX_BYTES,
    { before, after },
  );
  if (!passage) {
    return { ok: false, reason: 'not_found', message: 'That passage could not be rebuilt.' };
  }
  return { ok: true, passage };
}

function normalizeSpan(value: unknown): number | undefined {
  if (value === undefined) return RECALL_EXPAND_MAX_NEIGHBOURS;
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < 0 || value > RECALL_EXPAND_MAX_NEIGHBOURS) return undefined;
  return value;
}

function normalizeRecallRequest(request: unknown):
  | {
      readonly ok: true;
      readonly value: {
        readonly terms: readonly string[];
        readonly folded: readonly string[];
        readonly limit: number;
        readonly sessionId?: string;
        readonly since?: number;
        readonly until?: number;
        readonly question?: string;
      };
    }
  | RecallFailure {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { ok: false, reason: 'invalid_query', message: 'Recall request must be an object.' };
  }
  const record = request as Record<string, unknown>;
  if (!Array.isArray(record.terms) || record.terms.length === 0) {
    return { ok: false, reason: 'invalid_query', message: 'Recall requires at least one term.' };
  }
  if (record.terms.length > RECALL_MAX_TERMS) {
    return {
      ok: false,
      reason: 'invalid_query',
      message: `Recall accepts at most ${RECALL_MAX_TERMS} terms.`,
    };
  }

  const terms: string[] = [];
  const folded: string[] = [];
  for (const candidate of record.terms) {
    if (typeof candidate !== 'string') {
      return { ok: false, reason: 'invalid_query', message: 'Recall terms must be strings.' };
    }
    const term = candidate.trim();
    if (term.length === 0) {
      return { ok: false, reason: 'invalid_query', message: 'Recall terms must not be empty.' };
    }
    if (Array.from(term).length > SEARCH_QUERY_MAX_CHARS) {
      return {
        ok: false,
        reason: 'invalid_query',
        message: `Recall terms must be ${SEARCH_QUERY_MAX_CHARS} characters or fewer.`,
      };
    }
    // Matching a credential-shaped term against raw history would expose a
    // hit/no-hit membership oracle, and substring matching turns that oracle
    // into an extraction primitive. Reject before touching any corpus.
    if (redactSecrets(term) !== term) {
      return {
        ok: false,
        reason: 'invalid_query',
        message: 'A recall term contains credential material and cannot be searched.',
      };
    }
    const foldedTerm = foldForMatch(term);
    if (folded.includes(foldedTerm)) continue;
    terms.push(term);
    folded.push(foldedTerm);
  }
  if (terms.length === 0) {
    return { ok: false, reason: 'invalid_query', message: 'Recall requires at least one term.' };
  }

  const limit = normalizeLimit(record.limit);
  if (limit === undefined) {
    return {
      ok: false,
      reason: 'invalid_query',
      message: `Recall limit must be between 1 and ${RECALL_MAX_LIMIT}.`,
    };
  }

  const sessionId = optionalString(record.sessionId);
  if (sessionId === null) {
    return { ok: false, reason: 'invalid_query', message: 'Recall session id is invalid.' };
  }
  const since = optionalTimestamp(record.since);
  const until = optionalTimestamp(record.until);
  if (since === null || until === null) {
    return { ok: false, reason: 'invalid_query', message: 'Recall time bounds must be numbers.' };
  }
  if (since !== undefined && until !== undefined && since > until) {
    return { ok: false, reason: 'invalid_query', message: 'Recall `since` must precede `until`.' };
  }
  const question = optionalString(record.question);
  if (question === null) {
    return { ok: false, reason: 'invalid_query', message: 'Recall question is invalid.' };
  }

  return {
    ok: true,
    value: {
      terms,
      folded,
      limit,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
      ...(question !== undefined ? { question } : {}),
    },
  };
}

function normalizeLimit(value: unknown): number | undefined {
  if (value === undefined) return RECALL_DEFAULT_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < 1 || value > RECALL_MAX_LIMIT) return undefined;
  return value;
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 4096) return null;
  return trimmed;
}

function optionalTimestamp(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function eligibleSessions(
  sessions: readonly SessionSummary[],
  filter: { readonly sessionId?: string; readonly includeArchived: boolean },
): SessionSummary[] {
  return sessions
    .filter(
      (session) =>
        // Retired simulator transcripts are task records, not real history;
        // returning fabricated text as a recall hit is worse than nothing.
        session.backend !== 'fake' &&
        (filter.includeArchived || !session.isArchived) &&
        (filter.sessionId === undefined || session.id === filter.sessionId),
    )
    .sort((left, right) => {
      const byTime = (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0);
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
    })
    .slice(0, MAX_SESSIONS_SCANNED);
}

async function readFacts(
  deps: RecallDeps,
  terms: readonly string[],
  options: RecallOptions,
): Promise<readonly RecallFact[]> {
  if (!deps.searchFacts) return [];
  try {
    const facts = await deps.searchFacts({
      ...(options.activeSessionId ? { sessionId: options.activeSessionId } : {}),
      terms,
      limit: RECALL_FACT_LIMIT,
    });
    if (options.abortSignal?.aborted) return [];
    return facts.map((fact) => ({ ...fact, content: redactSecrets(fact.content) }));
  } catch {
    // The distilled layer is an accelerator. Losing it degrades recall quality
    // but must never fail the call, so an unavailable store reads as empty.
    return [];
  }
}

async function collectHits(
  deps: RecallDeps,
  input: CollectHitsInput,
): Promise<{ hits: VerifiedHit[]; corpusSize: number; scannedFully: boolean } | null> {
  if (input.sessionIds.length === 0) {
    return { hits: [], corpusSize: 0, scannedFully: true };
  }

  if (!input.forceFullScan && deps.listCandidates) {
    const candidates = await deps.listCandidates({
      terms: input.terms,
      sessionIds: input.sessionIds,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    if (input.abortSignal?.aborted) return null;
    if (candidates) {
      const corpusSize =
        (await deps.countSearchableMessages?.({ sessionIds: input.sessionIds })) ?? null;
      if (input.abortSignal?.aborted) return null;
      const hits: VerifiedHit[] = [];
      for (const candidate of candidates) {
        const hit = verify(candidate.sessionId, candidate.message, input);
        if (hit) hits.push(hit);
      }
      return {
        hits,
        // A candidate source that cannot report corpus size leaves idf with
        // only the candidates, which collapses to zero for a single term. Fall
        // back to a size that keeps idf positive and ordering meaningful.
        corpusSize: corpusSize ?? Math.max(hits.length * 2, 1),
        scannedFully: false,
      };
    }
  }

  const hits: VerifiedHit[] = [];
  let corpusSize = 0;
  for (const sessionId of input.sessionIds) {
    if (input.abortSignal?.aborted) return null;
    const messages = await deps.readMessages(sessionId, input.abortSignal);
    if (input.abortSignal?.aborted) return null;
    if (!messages) continue;
    for (let index = 0; index < messages.length; index += 1) {
      if (index > 0 && index % 256 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (input.abortSignal?.aborted) return null;
      }
      const message = messages[index]!;
      if (collectSearchableText(message) === undefined) continue;
      corpusSize += 1;
      const hit = verify(sessionId, message, input);
      if (hit) hits.push(hit);
    }
  }
  return { hits, corpusSize, scannedFully: true };
}

/**
 * The real predicate. Everything a candidate source offers passes through
 * here, so narrowing the scan can never change which messages match.
 */
function verify(
  sessionId: string,
  message: StoredMessage,
  input: Pick<
    CollectHitsInput,
    'folded' | 'since' | 'until' | 'excludeTurnIds' | 'activeSessionId'
  >,
): VerifiedHit | undefined {
  if (input.since !== undefined && message.ts < input.since) return undefined;
  if (input.until !== undefined && message.ts > input.until) return undefined;

  const turnId = (message as { turnId?: string }).turnId;
  if (sessionId === input.activeSessionId && turnId && input.excludeTurnIds?.has(turnId)) {
    return undefined;
  }

  const raw = collectSearchableText(message);
  if (raw === undefined) return undefined;
  const foldedText = foldForMatch(redactSecrets(raw));

  const tf = new Map<string, number>();
  const matchedTerms: string[] = [];
  for (const term of input.folded) {
    const count = countOccurrences(foldedText, term);
    if (count === 0) continue;
    tf.set(term, count);
    matchedTerms.push(term);
  }
  if (matchedTerms.length === 0) return undefined;

  return {
    sessionId,
    message,
    ...(turnId ? { turnId } : {}),
    length: Array.from(foldedText).length,
    tf,
    matchedTerms,
    score: 0,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Okapi BM25 with Lucene's `k1`/`b` and Lucene's smoothed idf.
 *
 * `corpusSize` is the count of searchable messages, not the candidate count:
 * scoring against the candidates alone makes `df` equal `N` for a single-term
 * query, and idf collapses to zero. `df` itself comes from the verified hits,
 * which is exact because candidates are a superset of the matches.
 *
 * `avgdl` is the mean length of the verified hits rather than of the corpus.
 * Extracted length is only computable in this module, so a corpus-wide mean is
 * not available to a storage-side candidate source; the approximation is
 * sufficient because hits are only ever ranked against each other.
 */
function scoreHits(hits: VerifiedHit[], folded: readonly string[], corpusSize: number): void {
  if (hits.length === 0) return;
  const total = hits.reduce((sum, hit) => sum + hit.length, 0);
  const avgdl = total / hits.length || 1;
  const n = Math.max(corpusSize, hits.length);

  const idf = new Map<string, number>();
  for (const term of folded) {
    const df = hits.reduce((count, hit) => count + (hit.tf.get(term) ? 1 : 0), 0);
    if (df === 0) continue;
    idf.set(term, Math.log((n - df + 0.5) / (df + 0.5) + 1));
  }

  for (const hit of hits) {
    let score = 0;
    for (const [term, frequency] of hit.tf) {
      const weight = idf.get(term);
      if (weight === undefined) continue;
      const denominator =
        frequency + RECALL_BM25_K1 * (1 - RECALL_BM25_B + RECALL_BM25_B * (hit.length / avgdl));
      score += weight * ((frequency * (RECALL_BM25_K1 + 1)) / denominator);
    }
    hit.score = hit.message.type === 'tool_result' ? score * RECALL_TOOL_RESULT_WEIGHT : score;
  }
}

function compareHitOrder(left: VerifiedHit, right: VerifiedHit): number {
  const byTime = right.message.ts - left.message.ts;
  if (byTime !== 0) return byTime;
  return left.message.id.localeCompare(right.message.id);
}

/**
 * BM25 ranks messages independently and cannot express result diversity, so a
 * Session that genuinely discusses a topic at length would take most of the
 * envelope. The quota is an upper bound, not an allocation: a second pass
 * fills any slot the bound left empty, so a topic confined to one Session
 * still returns a full envelope.
 *
 * At most one passage per turn — several hits in one exchange describe the
 * same thing and would otherwise spend the envelope on near-duplicates.
 */
function applySessionQuota(hits: readonly VerifiedHit[], limit: number): VerifiedHit[] {
  const perSession = Math.max(1, Math.floor(limit / 3));
  const bySession = new Map<string, number>();
  const seenTurns = new Set<string>();
  const selected: VerifiedHit[] = [];

  const take = (hit: VerifiedHit): void => {
    const turnKey = `${hit.sessionId} ${hit.turnId ?? hit.message.id}`;
    if (seenTurns.has(turnKey)) return;
    seenTurns.add(turnKey);
    selected.push(hit);
    bySession.set(hit.sessionId, (bySession.get(hit.sessionId) ?? 0) + 1);
  };

  for (const hit of hits) {
    if (selected.length >= limit) break;
    if ((bySession.get(hit.sessionId) ?? 0) >= perSession) continue;
    take(hit);
  }
  for (const hit of hits) {
    if (selected.length >= limit) break;
    take(hit);
  }
  // The fill pass appends by scan order, so restore rank before returning: the
  // envelope is read top-down, and it also decides which passages get budget
  // first when the total cap binds.
  return selected.sort((left, right) => right.score - left.score);
}

async function assemblePassages(
  deps: RecallDeps,
  anchors: readonly VerifiedHit[],
  sessionById: ReadonlyMap<string, SessionSummary>,
  options: RecallOptions,
): Promise<RecallPassage[] | null> {
  if (anchors.length === 0) return [];

  const transcripts = new Map<string, readonly StoredMessage[]>();
  for (const sessionId of new Set(anchors.map((anchor) => anchor.sessionId))) {
    if (options.abortSignal?.aborted) return null;
    const messages = await deps.readMessages(sessionId, options.abortSignal);
    if (options.abortSignal?.aborted) return null;
    if (messages) transcripts.set(sessionId, messages);
  }

  const passages: RecallPassage[] = [];
  let remaining = RECALL_TOTAL_PAYLOAD_CAP_BYTES;
  for (const anchor of anchors) {
    if (remaining <= 0) break;
    const transcript = transcripts.get(anchor.sessionId);
    if (!transcript) continue;
    const passage = buildPassage(anchor, transcript, sessionById.get(anchor.sessionId), remaining);
    if (!passage) continue;
    remaining -= passageBytes(passage);
    passages.push(passage);
  }
  return passages;
}

function buildPassage(
  anchor: VerifiedHit,
  transcript: readonly StoredMessage[],
  session: SessionSummary | undefined,
  budget: number,
  span: { readonly before: number; readonly after: number } = {
    before: RECALL_PASSAGE_NEIGHBOURS,
    after: RECALL_PASSAGE_NEIGHBOURS,
  },
): RecallPassage | undefined {
  const anchorIndex = transcript.findIndex((message) => message.id === anchor.message.id);
  if (anchorIndex < 0) return undefined;

  const neighbours = collectNeighbours(transcript, anchorIndex, anchor.turnId, span);
  const ordered = [
    ...neighbours.before,
    { message: anchor.message, isAnchor: true },
    ...neighbours.after,
  ];

  // The anchor takes budget first, so the message the caller matched on
  // survives even when the passage has to be cut short.
  let remaining = Math.min(budget, RECALL_PASSAGE_MAX_BYTES);
  let truncated = false;
  const rendered = new Map<string, RecallPassageMessage>();

  const render = (message: StoredMessage, isAnchor: boolean): void => {
    if (rendered.has(message.id)) return;
    const projected = projectPassageMessage(message, isAnchor);
    if (!projected) return;
    const overhead = Buffer.byteLength(JSON.stringify({ ...projected, text: '' }), 'utf8');
    if (remaining <= overhead) {
      truncated = true;
      return;
    }
    const text = truncateUtf8(
      projected.text,
      Math.min(remaining - overhead, RECALL_MESSAGE_MAX_BYTES),
    );
    if (text !== projected.text) truncated = true;
    remaining -= overhead + Buffer.byteLength(text, 'utf8');
    rendered.set(message.id, { ...projected, text });
  };

  render(anchor.message, true);
  if (!rendered.has(anchor.message.id)) return undefined;
  for (const entry of ordered) render(entry.message, entry.isAnchor);

  const messages = ordered
    .map((entry) => rendered.get(entry.message.id))
    .filter((message): message is RecallPassageMessage => message !== undefined);

  return {
    sessionId: anchor.sessionId,
    sessionTitle: redactSecrets(session?.name ?? ''),
    ...(anchor.turnId ? { turnId: anchor.turnId } : {}),
    anchorMessageId: anchor.message.id,
    messages,
    matchedTerms: anchor.matchedTerms,
    score: Number(anchor.score.toFixed(4)),
    ...(session?.lastMessageAt !== undefined ? { lastMessageAt: session.lastMessageAt } : {}),
    hasMoreBefore: neighbours.hasMoreBefore,
    hasMoreAfter: neighbours.hasMoreAfter,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Neighbours come from the anchor's own turn, bounded by count rather than by
 * turn membership alone: an agent turn can run to dozens of messages, so "the
 * whole turn" is not a passage. Tool results join a passage only as its
 * anchor, since their serialized bodies crowd out the exchange around them.
 */
function collectNeighbours(
  transcript: readonly StoredMessage[],
  anchorIndex: number,
  turnId: string | undefined,
  span: { readonly before: number; readonly after: number },
): {
  before: { message: StoredMessage; isAnchor: boolean }[];
  after: { message: StoredMessage; isAnchor: boolean }[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
} {
  const before: { message: StoredMessage; isAnchor: boolean }[] = [];
  const after: { message: StoredMessage; isAnchor: boolean }[] = [];
  let hasMoreBefore = false;
  let hasMoreAfter = false;

  const sameTurn = (message: StoredMessage): boolean =>
    turnId === undefined || (message as { turnId?: string }).turnId === turnId;

  for (let index = anchorIndex - 1; index >= 0; index -= 1) {
    const message = transcript[index]!;
    if (!sameTurn(message)) break;
    if (!isPassageNeighbour(message)) continue;
    if (before.length >= span.before) {
      hasMoreBefore = true;
      break;
    }
    before.unshift({ message, isAnchor: false });
  }
  for (let index = anchorIndex + 1; index < transcript.length; index += 1) {
    const message = transcript[index]!;
    if (!sameTurn(message)) break;
    if (!isPassageNeighbour(message)) continue;
    if (after.length >= span.after) {
      hasMoreAfter = true;
      break;
    }
    after.push({ message, isAnchor: false });
  }
  return { before, after, hasMoreBefore, hasMoreAfter };
}

function isPassageNeighbour(message: StoredMessage): boolean {
  return message.type === 'user' || message.type === 'assistant' || message.type === 'tool_call';
}

function projectPassageMessage(
  message: StoredMessage,
  isAnchor: boolean,
): RecallPassageMessage | undefined {
  const raw = collectSearchableText(message);
  if (raw === undefined) return undefined;
  const text = redactSecrets(raw).trim();
  if (text.length === 0) return undefined;
  return {
    messageId: message.id,
    role: passageRole(message),
    matchKind: threadSearchMatchKind(message),
    text,
    timestamp: message.ts,
    isAnchor,
  };
}

function passageRole(message: StoredMessage): 'user' | 'assistant' | 'tool' {
  if (message.type === 'user') return 'user';
  if (message.type === 'assistant') return 'assistant';
  return 'tool';
}

function passageBytes(passage: RecallPassage): number {
  return passage.messages.reduce(
    (sum, message) => sum + Buffer.byteLength(message.text, 'utf8') + 96,
    0,
  );
}

/**
 * Names the boundary of the search so an empty envelope is distinguishable
 * from an unsearched corpus. Without it a model reads "no facts" as "the user
 * never discussed this" rather than "the distilled layer holds nothing yet".
 */
function describeGaps(input: {
  readonly terms: readonly string[];
  readonly facts: readonly RecallFact[];
  readonly hits: readonly VerifiedHit[];
  readonly sessions: readonly SessionSummary[];
}): string {
  const parts: string[] = [];
  const matched = new Set<string>();
  for (const hit of input.hits) for (const term of hit.matchedTerms) matched.add(term);
  const missing = input.terms.filter((term) => !matched.has(foldForMatch(term)));
  if (missing.length > 0) parts.push(`No transcript match for: ${missing.join(', ')}.`);
  if (input.facts.length === 0) parts.push('No distilled facts matched.');

  parts.push(`Searched ${input.sessions.length} Session(s).`);
  const oldest = input.sessions.reduce<number | undefined>((earliest, session) => {
    const at = session.lastMessageAt;
    if (at === undefined) return earliest;
    return earliest === undefined || at < earliest ? at : earliest;
  }, undefined);
  if (oldest !== undefined) {
    parts.push(`Oldest Session activity ${new Date(oldest).toISOString().slice(0, 10)}.`);
  }
  if (input.sessions.length >= MAX_SESSIONS_SCANNED) {
    parts.push(`Session scan capped at ${MAX_SESSIONS_SCANNED}; older Sessions were not read.`);
  }
  return parts.join(' ');
}

/** U+FFFD, what decoding produces when a byte slice cuts a character in half. */
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  if (maxBytes <= 3) return '';
  let body = Buffer.from(value, 'utf8')
    .subarray(0, maxBytes - 3)
    .toString('utf8');
  while (body.endsWith(REPLACEMENT_CHARACTER)) body = body.slice(0, -1);
  return `${body}…`;
}

function aborted(): RecallFailure {
  return { ok: false, reason: 'aborted', message: 'Recall was aborted.' };
}
