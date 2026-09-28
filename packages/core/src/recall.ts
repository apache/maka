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
 *   3. Transcript layer. A cheap candidate source names the Sessions worth
 *      reading, the real predicate decides message by message, BM25 ranks, a
 *      per-Session quota diversifies, and passages are assembled from the
 *      winners.
 *
 * Two invariants hold the design together:
 *
 *   - **The candidate source narrows; this module decides.**
 *     `listCandidateSessions` may over-name freely but must never under-name:
 *     every Session with a matching message has to be in its answer.
 *     Verification then reads each named Session and runs the exact predicate
 *     a full scan would on every message, so swapping candidate sources cannot
 *     change which messages match.
 *   - **Redaction precedes matching.** Substring matching plus a hit/no-hit
 *     signal is a prefix-extension oracle, so a term must be found in the
 *     redacted text. It must also be found in the stored text, which is what
 *     lets a scan of stored records stand in for the predicate; a term found
 *     only in a redaction artifact names nothing that was said.
 *
 * Scoring is Okapi BM25 with Lucene's parameters and Lucene's smoothed idf,
 * which never goes negative for a term that appears in most of the corpus,
 * plus one weight that BM25 has no way to express: a tool result's term
 * density reflects machine output rather than relevance.
 */

import { isCanonicalArtifactEntityId } from './artifacts.js';
import { formatAttachmentResourceRef, MAX_ATTACHMENT_COUNT } from './attachments.js';
import { isAttachmentRef, type AttachmentRef } from './events.js';
import { validateWorkspacePrivacyContext } from './incognito.js';
import { redactSecrets } from './redaction.js';
import { SEARCH_QUERY_MAX_CHARS } from './search.js';
import { collapseSessionRevisions } from './session-revisions.js';
import type { SessionSummary, StoredMessage } from './session.js';
import { foldForMatch, MAX_SESSIONS_SCANNED, threadSearchMatchKind } from './transcript-search.js';

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

/**
 * Visible neighbours taken on each side of an anchor, within its turn.
 *
 * Chosen against the cost of the follow-up it avoids. On one workspace, going
 * from two neighbours to four grew an envelope by about a kilobyte and dropped
 * the share of passages reporting more context available from 46% to 37%; each
 * of those is a `RecallMore` round trip, which costs far more than a kilobyte.
 * Eight would drop it to 23% but widens the exposure to long agent turns, and
 * the turn boundary — not this count — is what binds in practice.
 */
export const RECALL_PASSAGE_NEIGHBOURS = 4;

/** Cap on total passage bytes (UTF-8) summed across one envelope. */
export const RECALL_TOTAL_PAYLOAD_CAP_BYTES = 96 * 1024;

/** Cap on one passage. */
export const RECALL_PASSAGE_MAX_BYTES = 12 * 1024;

/**
 * Cap on the text recall extracts from one tool result. Machine output can run
 * to megabytes; past this much of it a match says nothing about relevance.
 */
export const RECALL_TOOL_RESULT_TEXT_CAP_BYTES = 10 * 1024;

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
 *
 * Measured on one workspace only: without the weight (1.0) the top result
 * changed in 1 of 5 queries and the top five in 2 of 5, each time by promoting
 * a tool result whose body enumerated the query term. No other value has been
 * measured; treat 0.5 as a prior to re-measure, not a constant to reason from.
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

/**
 * The text recall matches and returns for one message: what a reader of the
 * transcript would see, never the envelope around it.
 *
 * For a user turn that is the human-facing text; for an assistant turn its
 * answer, not its reasoning; for a tool call the intent the runtime wrote for
 * the user. A tool result is machine output shaped by whichever tool produced
 * it, so its text is every string value in the result — the file contents, the
 * command output, the search snippets — joined on separate lines, and not the
 * JSON keys and kind tags that structure them. Those keys are an artifact of
 * how the result is stored: matching them would find every result of a shape
 * rather than anything that was said, and a store that keeps results in a
 * different shape could not offer them. An archived result carries only ids
 * and hashes, so it has no text.
 */
export function recallSearchableText(message: StoredMessage): string | undefined {
  switch (message.type) {
    case 'user':
      return message.displayText ?? message.text;
    case 'assistant':
      return message.text;
    case 'tool_call':
      return message.intent && message.intent.length > 0 ? message.intent : undefined;
    case 'tool_result': {
      if (message.content.kind === 'archived_tool_result') return undefined;
      // The top-level `kind` is the result's shape tag, not its output.
      const { kind: _kind, ...output } = message.content;
      const leaves: string[] = [];
      let bytes = 0;
      collectStringLeaves(output, (leaf) => {
        if (bytes >= RECALL_TOOL_RESULT_TEXT_CAP_BYTES) return false;
        const remaining = RECALL_TOOL_RESULT_TEXT_CAP_BYTES - bytes;
        const text = truncateUtf8(leaf, remaining);
        leaves.push(text);
        bytes += Buffer.byteLength(text, 'utf8') + 1;
        return true;
      });
      return leaves.length > 0 ? leaves.join('\n') : undefined;
    }
    default:
      return undefined;
  }
}

/** Removes projection-written text before matching; see `RecallDeps.syntheticTextPatterns`. */
function stripSyntheticText(text: string, patterns: readonly RegExp[] | undefined): string {
  if (!patterns || patterns.length === 0) return text;
  let stripped = text;
  for (const pattern of patterns) stripped = stripped.replace(pattern, '');
  return stripped;
}

/**
 * One file a message carried. Metadata only: recall never returns bytes, and a
 * material is worth returning precisely because its bytes are expensive.
 */
export interface RecallMaterial {
  readonly name: string;
  readonly kind: AttachmentRef['kind'];
  readonly mimeType: string;
  readonly bytes: number;
  /**
   * Address `Read` accepts, present only when `Read` would answer it from the
   * Session asking. Attachment reads resolve against the calling Session and
   * refuse anything stored elsewhere, and refuse a PDF wherever it is stored,
   * so offering the address in either case would invite a call that can only
   * fail.
   */
  readonly resource?: string;
  /**
   * Where the material is stored, present exactly when `resource` is not: a
   * file `Read` cannot answer from here is still worth naming, and naming it
   * is only useful if it can also be asked for. A retrieval tool takes this
   * pair, checks the Session is one recall itself can see, and brings the
   * file into the asking Session.
   */
  readonly sourceSessionId?: string;
  readonly materialId?: string;
}

/**
 * The files a message carried. A screenshot pasted under "have a look" leaves
 * no trace in the text, so without this the message is unreachable by any
 * term the user would think to search.
 */
export function recallMaterials(message: StoredMessage): readonly RecallMaterial[] {
  if (message.type !== 'user') return [];
  const attachments = message.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  // Shape first, then the cap: a record older or stranger than the current
  // shape projects nothing, and a run of those ahead of a valid attachment
  // must not spend the cap that valid one needed.
  return attachments
    .filter(isAttachmentRef)
    .slice(0, MAX_ATTACHMENT_COUNT)
    .map((attachment) => {
      const resource = readableAttachmentResource(attachment);
      const location = retrievableMaterialLocation(attachment);
      return {
        name: attachment.name,
        kind: attachment.kind,
        mimeType: attachment.mimeType,
        bytes: attachment.bytes,
        ...(resource ? { resource } : {}),
        ...(location ?? {}),
      };
    });
}

/**
 * The address `Read` accepts, present only for a material `Read` can actually
 * return. `Read` answers an image with the image and anything else with the
 * file's text, and refuses a PDF outright — so a PDF's address is one the
 * caller can only fail on, which is the same reason a material in another
 * Session carries no address.
 */
function readableAttachmentResource(attachment: AttachmentRef): string | null {
  if (attachment.kind === 'pdf') return null;
  return formatAttachmentResourceRef(attachment.ref);
}

/**
 * The pair that names a material a retrieval tool can fetch: the Session that
 * holds it and the artifact inside it. Only a durable Session artifact can be
 * fetched, so a ref of any other kind names nothing.
 */
function retrievableMaterialLocation(
  attachment: AttachmentRef,
): { sourceSessionId: string; materialId: string } | null {
  if (attachment.ref.kind !== 'session_file') return null;
  if (!isCanonicalArtifactEntityId(attachment.ref.relativePath)) return null;
  return {
    sourceSessionId: attachment.ref.sessionId,
    materialId: attachment.ref.relativePath,
  };
}

/**
 * What the predicate runs on: a message's prose plus the names of the files it
 * carried, so a material is reachable by the name a person would remember.
 * Names are matched but not returned as text — they come back as materials.
 */
function recallMatchableText(message: StoredMessage): string | undefined {
  const prose = recallSearchableText(message);
  const materials = recallMaterials(message);
  if (materials.length === 0) return prose;
  const names = materials.map((material) => material.name).join('\n');
  return prose === undefined || prose.length === 0 ? names : `${prose}\n${names}`;
}

/** Visits every string value in a JSON-like value, in document order, until the visitor declines. */
function collectStringLeaves(value: unknown, visit: (leaf: string) => boolean): boolean {
  if (typeof value === 'string') return visit(value);
  if (Array.isArray(value)) {
    for (const item of value) if (!collectStringLeaves(item, visit)) return false;
    return true;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) if (!collectStringLeaves(item, visit)) return false;
  }
  return true;
}

/**
 * Message types that can carry visible text. Corpus size is counted by type
 * rather than by whether a record actually projects, because a storage-side
 * candidate source can only see the type. Counting the same way on both paths
 * keeps idf — and therefore the ranking — identical whichever path ran.
 */
const SEARCHABLE_MESSAGE_TYPES: ReadonlySet<StoredMessage['type']> = new Set([
  'user',
  'assistant',
  'tool_call',
  'tool_result',
]);

export interface RecallRequest {
  /** Literal terms, matched case-insensitively as substrings and OR-combined. */
  readonly terms: readonly string[];
  /**
   * Why the search was made. Never matched and never returned — it is accepted
   * so the reason is recorded in the tool call itself, where a reader of the
   * transcript can pair it with the terms that were chosen.
   */
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
}

export interface RecallPassageMessage {
  readonly messageId: string;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly matchKind: string;
  readonly text: string;
  readonly timestamp: number;
  readonly isAnchor: boolean;
  /** Files this message carried; omitted when it carried none. */
  readonly materials?: readonly RecallMaterial[];
}

export interface RecallPassage {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly turnId?: string;
  readonly anchorMessageId: string;
  /**
   * Zero-based index of the anchor message within its Session transcript, the
   * same coordinate a transcript reader scrolls by.
   *
   * A UI that navigates into a Session needs a position, not just an identity:
   * the transcript reader scrolls by sequence, and a message id alone would
   * force it to page the whole transcript to find the anchor. Recall already
   * has the index — it locates the anchor by `findIndex` — so carrying it costs
   * nothing and spares every consumer a second lookup.
   *
   * Present only when the anchor was located in the transcript it was
   * assembled from; `buildPassage` returns undefined in the other case, so
   * this is always defined on a passage that exists.
   */
  readonly sequence: number;
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
 * What a candidate source is asked. `terms` arrive already folded —
 * NFC-normalized and lowercased — because the predicate they must
 * over-approximate runs on folded text. A source that matched raw bytes
 * against a raw term would miss every record whose case differs from the
 * query, which is the common path for prose.
 */
export interface RecallCandidateSessionRequest {
  readonly sessionIds: readonly string[];
  /** Folded terms. A Session whose stored text contains any of them is a candidate. */
  readonly terms: readonly string[];
  readonly abortSignal?: AbortSignal;
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
   * Optional narrowing: which of the given Sessions could hold a message
   * containing one of the folded `terms`. It MUST name every Session whose
   * projected transcript matches — a superset — or results are silently lost;
   * over-naming only costs a transcript read. Recall then reads each named
   * Session through `readMessages` and runs the real predicate on every
   * message, so the source never decides what matches, only where to look.
   * Returning `null` declines the fast path for this query.
   *
   * Narrowing stops at the Session because that is the unit storage can vouch
   * for: a transcript is projected from its ledger as a whole, and the text
   * of one message is a value inside the events that projected it.
   *
   * Only used together with `countSearchableMessages`: idf needs the corpus
   * size, and a source that cannot report it would rank differently from the
   * full scan, which is the one thing a candidate source must never change.
   */
  listCandidateSessions?(input: RecallCandidateSessionRequest): Promise<readonly string[] | null>;
  /**
   * Corpus-wide count of searchable messages, used for idf. When present it
   * is the count on both paths, so which path ran cannot change a score;
   * without it the full scan counts what it read. `null` declines the fast
   * path for this query along with `listCandidateSessions`.
   */
  countSearchableMessages?(input: {
    readonly sessionIds: readonly string[];
  }): Promise<number | null>;
  /**
   * Brings a material into the asking Session and answers it. Absent when the
   * host has no artifact store, which makes materials name-only.
   */
  fetchMaterial?: RecallMaterialFetch;
  /**
   * Text the transcript projection writes that was never stored: a truncation
   * marker, a fallback caption for a result that lost its body. Matching runs
   * with these removed, so a term that occurs only in such text is not a hit
   * on either path — a candidate source scanning stored payloads could never
   * have offered it. Each pattern must be global (and multiline if it anchors
   * a line); the host that projects transcripts owns the list.
   */
  readonly syntheticTextPatterns?: readonly RegExp[];
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

/**
 * The scan's result, including the transcripts it read: a passage is built
 * from the same snapshot the predicate ran on, so a Session is read once and
 * an anchor cannot go missing between the two reads.
 */
interface CollectedHits {
  readonly hits: VerifiedHit[];
  readonly corpusSize: number;
  readonly scannedFully: boolean;
  readonly transcripts: ReadonlyMap<string, readonly StoredMessage[]>;
}

interface CollectHitsInput {
  readonly terms: readonly string[];
  readonly folded: readonly string[];
  readonly sessionIds: readonly string[];
  readonly forceFullScan: boolean;
  readonly syntheticTextPatterns?: readonly RegExp[];
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
  const { terms, folded, limit, sessionId, since, until } = normalized.value;

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
    ...(deps.syntheticTextPatterns ? { syntheticTextPatterns: deps.syntheticTextPatterns } : {}),
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
  const passages = assemblePassages(
    collected.transcripts,
    anchors,
    sessionById,
    options.activeSessionId,
  );

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
    (candidate) => candidate.id === anchorMessageId && isPassageMessage(candidate),
  );
  if (!message) {
    return { ok: false, reason: 'not_found', message: 'That passage anchor was not found.' };
  }

  // The anchor is caller-supplied, so the active-turn exclusion recall applies
  // when it chooses anchors has to be re-applied here: otherwise an id from
  // the turn in flight would widen into exactly the text recall refused to
  // surface. Answering `not_found` keeps the refusal indistinguishable from an
  // unknown id.
  const turnId = (message as { turnId?: string }).turnId;
  if (sessionId === options.activeSessionId && turnId && options.excludeTurnIds?.has(turnId)) {
    return { ok: false, reason: 'not_found', message: 'That passage anchor was not found.' };
  }

  const built = buildPassage(
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
    options.activeSessionId,
    { before, after },
  );
  if (!built) {
    return { ok: false, reason: 'not_found', message: 'That passage could not be rebuilt.' };
  }
  return { ok: true, passage: built.passage };
}

/**
 * What a host must do to bring a material into the asking Session: copy the
 * artifact and answer it the way `Read` answers one stored here.
 *
 * Copying rather than referencing is what makes the answer durable. A tool
 * result holds its file as a ref and every later turn re-materializes it, so a
 * ref into another Session would break the moment that Session was cleaned up
 * — the conversation would stop reproducing. A copy belongs to the asking
 * Session and survives whatever happens to the original.
 */
export interface RecallMaterialFetch {
  (input: {
    readonly sourceSessionId: string;
    readonly materialId: string;
    readonly targetSessionId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<RecallMaterialFetchResult>;
}

export type RecallMaterialFetchResult =
  | { readonly ok: true; readonly content: unknown }
  | { readonly ok: false; readonly reason: 'not_found' | 'unsupported'; readonly message: string };

export interface RecallMaterialRequest {
  readonly sessionId: string;
  readonly materialId: string;
}

/**
 * Brings one material named by a passage into the asking Session.
 *
 * The Session check is the point of this function, not a formality: without it
 * the tool would be a way to read any artifact by id, including from the
 * Sessions recall itself refuses to surface — incognito, retired simulator
 * transcripts, whatever a future rule excludes. A material is retrievable
 * exactly when recall could have shown you the Session it sits in.
 */
export async function fetchRecallMaterial(
  request: unknown,
  deps: RecallDeps,
  options: RecallOptions = {},
): Promise<{ readonly ok: true; readonly content: unknown } | RecallFailure> {
  if (options.abortSignal?.aborted) return aborted();
  if (!deps.fetchMaterial) {
    return { ok: false, reason: 'not_found', message: 'Materials are unavailable here.' };
  }
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { ok: false, reason: 'invalid_query', message: 'Material request must be an object.' };
  }
  const record = request as Record<string, unknown>;
  const sessionId = optionalString(record.sessionId);
  const materialId = optionalString(record.materialId);
  if (!sessionId || !materialId) {
    return {
      ok: false,
      reason: 'invalid_query',
      message: 'A material is named by its Session and its material id.',
    };
  }
  if (!options.activeSessionId) {
    return { ok: false, reason: 'not_found', message: 'Materials need an active Session.' };
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
  if (!sessions.some((candidate) => candidate.id === sessionId)) {
    return { ok: false, reason: 'not_found', message: 'That material was not found.' };
  }

  const fetched = await deps.fetchMaterial({
    sourceSessionId: sessionId,
    materialId,
    targetSessionId: options.activeSessionId,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  });
  if (options.abortSignal?.aborted) return aborted();
  if (!fetched.ok) {
    return {
      ok: false,
      reason: fetched.reason === 'unsupported' ? 'invalid_query' : 'not_found',
      message: fetched.message,
    };
  }
  return { ok: true, content: fetched.content };
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

/** Identifiers recall accepts back from a caller: Session and message ids. */
export const RECALL_ID_MAX_CHARS = 256;

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > RECALL_ID_MAX_CHARS) return null;
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
): Promise<CollectedHits | null> {
  if (input.sessionIds.length === 0) {
    return { hits: [], corpusSize: 0, scannedFully: true, transcripts: new Map() };
  }

  const transcripts = new Map<string, readonly StoredMessage[]>();
  let sessionIds: readonly string[] = input.sessionIds;
  let scannedFully = true;
  if (!input.forceFullScan && deps.listCandidateSessions && deps.countSearchableMessages) {
    // The source matches folded stored text, so it gets the folded terms the
    // verifier will use, never the terms as the caller typed them.
    const candidates = await deps.listCandidateSessions({
      terms: input.folded,
      sessionIds: input.sessionIds,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    if (input.abortSignal?.aborted) return null;
    if (candidates) {
      // A source may name a Session recall did not ask about; it is not
      // eligible, so it is not read.
      const eligible = new Set(input.sessionIds);
      sessionIds = [...new Set(candidates)].filter((sessionId) => eligible.has(sessionId));
      scannedFully = false;
    }
  }

  const hits: VerifiedHit[] = [];
  let counted = 0;
  for (const sessionId of sessionIds) {
    if (input.abortSignal?.aborted) return null;
    const messages = await deps.readMessages(sessionId, input.abortSignal);
    if (input.abortSignal?.aborted) return null;
    if (!messages) continue;
    transcripts.set(sessionId, messages);
    for (let index = 0; index < messages.length; index += 1) {
      // Verification redacts before it matches, which is the expensive part
      // of this module. A long transcript would hold the event loop for as
      // long as it takes, so yield periodically.
      if (index > 0 && index % 256 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (input.abortSignal?.aborted) return null;
      }
      const message = messages[index]!;
      if (!SEARCHABLE_MESSAGE_TYPES.has(message.type)) continue;
      counted += 1;
      const hit = verify(sessionId, message, input);
      if (hit) hits.push(hit);
    }
  }

  // The narrowed path never sees the Sessions it skipped, so its corpus size
  // has to come from the store. The full scan takes the same number when the
  // store offers one, which is what keeps a score independent of the path.
  let corpusSize: number | null = counted;
  if (deps.countSearchableMessages) {
    corpusSize = await deps.countSearchableMessages({ sessionIds: input.sessionIds });
    if (input.abortSignal?.aborted) return null;
    if (corpusSize === null) {
      if (!scannedFully) return collectHits(deps, { ...input, forceFullScan: true });
      corpusSize = counted;
    }
  }
  return { hits, corpusSize, scannedFully, transcripts };
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
    | 'terms'
    | 'folded'
    | 'since'
    | 'until'
    | 'excludeTurnIds'
    | 'activeSessionId'
    | 'syntheticTextPatterns'
  >,
): VerifiedHit | undefined {
  if (input.since !== undefined && message.ts < input.since) return undefined;
  if (input.until !== undefined && message.ts > input.until) return undefined;

  const turnId = (message as { turnId?: string }).turnId;
  if (sessionId === input.activeSessionId && turnId && input.excludeTurnIds?.has(turnId)) {
    return undefined;
  }

  const raw = recallMatchableText(message);
  if (raw === undefined) return undefined;
  // A hit is a term that occurs in the text as it was stored *and* still
  // occurs once secrets are redacted. Redaction alone is the security
  // boundary: it keeps a credential-shaped term from ever matching. Requiring
  // the stored text as well is what makes a candidate source sound — redaction
  // rewrites text (it inserts markers, and re-serializes a JSON body it
  // changed), and a term found only in that rewritten form would match here
  // while no scan of stored records could offer it. Such a term names a
  // redaction artifact rather than anything that was said, so nothing of
  // value is lost by refusing it.
  const stored = stripSyntheticText(raw, input.syntheticTextPatterns);
  const foldedStored = foldForMatch(stored);
  const foldedText = foldForMatch(redactSecrets(stored));

  const tf = new Map<string, number>();
  const matchedTerms: string[] = [];
  for (let index = 0; index < input.folded.length; index += 1) {
    const folded = input.folded[index]!;
    if (!foldedStored.includes(folded)) continue;
    const count = countOccurrences(foldedText, folded);
    if (count === 0) continue;
    tf.set(folded, count);
    // Report the term the caller sent, not the folded form matching used: a
    // caller that searched `Context` should not read `context` back.
    matchedTerms.push(input.terms[index] ?? folded);
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
 * sufficient because hits are only ever ranked against each other. It does
 * mean a message's score depends on which other messages matched the same
 * query, so scores compare within one envelope and never across calls.
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

function assemblePassages(
  transcripts: ReadonlyMap<string, readonly StoredMessage[]>,
  anchors: readonly VerifiedHit[],
  sessionById: ReadonlyMap<string, SessionSummary>,
  activeSessionId: string | undefined,
): RecallPassage[] {
  if (anchors.length === 0) return [];
  const passages: RecallPassage[] = [];
  let remaining = RECALL_TOTAL_PAYLOAD_CAP_BYTES;
  for (const anchor of anchors) {
    if (remaining <= 0) break;
    const transcript = transcripts.get(anchor.sessionId);
    if (!transcript) continue;
    const built = buildPassage(
      anchor,
      transcript,
      sessionById.get(anchor.sessionId),
      remaining,
      activeSessionId,
    );
    if (!built) continue;
    remaining -= built.bytes;
    passages.push(built.passage);
  }
  return passages;
}

function buildPassage(
  anchor: VerifiedHit,
  transcript: readonly StoredMessage[],
  session: SessionSummary | undefined,
  budget: number,
  activeSessionId: string | undefined,
  span: { readonly before: number; readonly after: number } = {
    before: RECALL_PASSAGE_NEIGHBOURS,
    after: RECALL_PASSAGE_NEIGHBOURS,
  },
): { readonly passage: RecallPassage; readonly bytes: number } | undefined {
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
  const allowance = Math.min(budget, RECALL_PASSAGE_MAX_BYTES);
  let remaining = allowance;
  let truncated = false;
  const rendered = new Map<string, RecallPassageMessage>();

  const render = (message: StoredMessage, isAnchor: boolean): void => {
    if (rendered.has(message.id)) return;
    const projected = projectPassageMessage(message, isAnchor, activeSessionId);
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

  // Spend the budget outward from the anchor. A passage's value falls off with
  // distance, so when the budget binds it is the farthest neighbours that
  // should go — consuming in chronological order would instead drop the
  // message immediately before the anchor, which is usually the question the
  // anchor answers.
  render(anchor.message, true);
  if (!rendered.has(anchor.message.id)) return undefined;
  for (let step = 1; step <= Math.max(neighbours.before.length, neighbours.after.length); step++) {
    const before = neighbours.before[neighbours.before.length - step];
    const after = neighbours.after[step - 1];
    if (before) render(before.message, false);
    if (after) render(after.message, false);
  }

  const messages = ordered
    .map((entry) => rendered.get(entry.message.id))
    .filter((message): message is RecallPassageMessage => message !== undefined);

  // A neighbour the span selected but the budget could not fit is more context
  // the caller can still reach, so it counts toward the continuation flags the
  // same way one beyond the span does. Reporting otherwise would tell a caller
  // there is nothing more in a direction recall just cut short.
  const omitted = (entries: readonly { message: StoredMessage }[]): boolean =>
    entries.some((entry) => !rendered.has(entry.message.id) && isPassageMessage(entry.message));

  const passage: RecallPassage = {
    sessionId: anchor.sessionId,
    sessionTitle: redactSecrets(session?.name ?? ''),
    ...(anchor.turnId ? { turnId: anchor.turnId } : {}),
    anchorMessageId: anchor.message.id,
    // The anchor's position in the transcript this passage was built from.
    // `anchorIndex` is already `findIndex` over that exact array, so this is
    // the same coordinate the transcript reader addresses.
    sequence: anchorIndex,
    messages,
    matchedTerms: anchor.matchedTerms,
    score: Number(anchor.score.toFixed(4)),
    ...(session?.lastMessageAt !== undefined ? { lastMessageAt: session.lastMessageAt } : {}),
    hasMoreBefore: neighbours.hasMoreBefore || omitted(neighbours.before),
    hasMoreAfter: neighbours.hasMoreAfter || omitted(neighbours.after),
    ...(truncated ? { truncated: true } : {}),
  };
  // Report what the rendering actually spent rather than re-deriving it, so
  // the envelope's total cap is accounted in the same units that enforced the
  // per-passage one.
  return { passage, bytes: allowance - remaining };
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

/**
 * Whether a message can appear in a passage at all. Redaction rewrites text
 * but never empties it, so this decides the same set `projectPassageMessage`
 * does without paying for redaction on every message a lookup walks past.
 */
function isPassageMessage(message: StoredMessage): boolean {
  const raw = recallSearchableText(message);
  if (raw !== undefined && raw.trim().length > 0) return true;
  return recallMaterials(message).length > 0;
}

function projectPassageMessage(
  message: StoredMessage,
  isAnchor: boolean,
  activeSessionId?: string,
): RecallPassageMessage | undefined {
  const raw = recallSearchableText(message);
  const text = raw === undefined ? '' : redactSecrets(raw).trim();
  // A message whose whole content was a pasted file has no text of its own.
  // Dropping it would make the file unreachable in exactly the case this
  // layer exists for.
  // A file name is user-authored text like any other, so it leaves through the
  // same redaction the passage body does; the address beside it is a runtime
  // identifier and carries nothing to redact.
  const materials = recallMaterials(message).map((material) => ({
    ...material,
    name: redactSecrets(material.name),
  }));
  if (text.length === 0 && materials.length === 0) return undefined;
  // A material carries an address or a location, never both: the address says
  // "read this now", the location says "ask for it and it will be brought
  // here". Offering an address `Read` would refuse is the mistake this split
  // exists to prevent.
  return {
    messageId: message.id,
    role: passageRole(message),
    matchKind: threadSearchMatchKind(message),
    text,
    timestamp: message.ts,
    isAnchor,
    ...(materials.length > 0
      ? { materials: materials.map((material) => addressOrLocation(material, activeSessionId)) }
      : {}),
  };
}

/**
 * Reachability is a fact about where the material itself is stored, not about
 * the passage that mentioned it. Keying it on the passage would offer an
 * address for a ref pointing into another Session — the doomed address this
 * split exists to prevent, with the polarity inverted.
 */
function addressOrLocation(
  material: RecallMaterial,
  activeSessionId: string | undefined,
): RecallMaterial {
  const { resource, sourceSessionId, materialId, ...named } = material;
  if (resource && sourceSessionId !== undefined && sourceSessionId === activeSessionId) {
    return { ...named, resource };
  }
  // A location is a thing to ask for, so it is only worth carrying when
  // asking could succeed. A PDF is refused wherever it is stored.
  return {
    ...named,
    ...(sourceSessionId && materialId && named.kind !== 'pdf'
      ? { sourceSessionId, materialId }
      : {}),
  };
}

function passageRole(message: StoredMessage): 'user' | 'assistant' | 'tool' {
  if (message.type === 'user') return 'user';
  if (message.type === 'assistant') return 'assistant';
  return 'tool';
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
  // `matchedTerms` carries each term as the caller wrote it; compare folded
  // forms on both sides so a mixed-case term that matched is not reported as
  // missing in the same envelope that returns its passage.
  const matched = new Set<string>();
  for (const hit of input.hits) {
    for (const term of hit.matchedTerms) matched.add(foldForMatch(term));
  }
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
