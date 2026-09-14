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

import type { StoredMessage } from './session.js';
import { redactSecrets } from './redaction.js';
import { sanitizeUnicodeText } from './text-sanitize.js';

/** Stable identifier for one external Agent integration, for example `codex`. */
export type ExternalAgentId = string;

/** A search term longer than this is truncated to this length before matching. */
export const EXTERNAL_SESSION_QUERY_TEXT_MAX_CHARS = 200;

export interface ExternalSessionQuery {
  cwd?: string;
  includeArchived?: boolean;
  /**
   * Free text matched against a summary's title and cwd.
   *
   * Applied by the adapter, before paging. Filtering an assembled page would
   * search only the rows already fetched, which on a 1128-session source is
   * worse than offering no search at all.
   */
  text?: string;
  /** Adapter-side page offset. Host-owned callers use this after filtering and sorting. */
  offset?: number;
  /** Maximum summaries returned. Adapters must apply it before returning to the Host. */
  limit?: number;
}

/** Lightweight source-native identity used by session pickers and import commands. */
export interface ExternalSessionSummary {
  id: string;
  name: string;
  cwd: string;
  createdAt?: number;
  updatedAt?: number;
  archived?: boolean;
}

const EXTERNAL_SESSION_TITLE_MAX_CODE_POINTS = 120;

/** Sanitize and redact a source-owned title before it reaches a Maka surface. */
export function sanitizeExternalSessionTitle(input: unknown): string {
  if (typeof input !== 'string') return '';
  return redactSecrets(
    sanitizeUnicodeText(input, { maxCodePoints: EXTERNAL_SESSION_TITLE_MAX_CODE_POINTS }),
  );
}

export interface ClaudeTitleCandidates {
  customTitle?: string;
  aiTitle?: string;
  summary?: string;
  lastPrompt?: string;
  firstUserMessage?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function collectClaudeTitle(
  record: Record<string, unknown>,
  titles: ClaudeTitleCandidates,
): void {
  if (typeof record.customTitle === 'string' && record.customTitle.length > 0) {
    titles.customTitle = record.customTitle;
  }
  if (typeof record.aiTitle === 'string' && record.aiTitle.length > 0)
    titles.aiTitle = record.aiTitle;
  if (typeof record.summary === 'string' && record.summary.length > 0)
    titles.summary = record.summary;
  if (typeof record.lastPrompt === 'string' && record.lastPrompt.length > 0) {
    titles.lastPrompt = record.lastPrompt;
  }
  if (titles.firstUserMessage === undefined) {
    const candidate = claudeFirstPromptCandidate(record);
    if (candidate !== undefined) titles.firstUserMessage = candidate;
  }
}

function claudeFirstPromptCandidate(record: Record<string, unknown>): string | undefined {
  if (record.type !== 'user' || record.isMeta === true || record.isCompactSummary === true) {
    return undefined;
  }
  const raw = claudeUserMessageText(record);
  if (raw === undefined) return undefined;
  const commandName = raw.match(/<command-name>([^<]+)<\/command-name>/);
  if (commandName) return commandName[1]!.trim();
  const bashInput = raw.match(/<bash-input>([^<]+)<\/bash-input>/);
  if (bashInput) return `! ${bashInput[1]!.trim()}`;
  const text = raw.trim();
  if (isSyntheticClaudeUserText(text)) return undefined;
  return text.length > 0 ? text : undefined;
}

export function isSyntheticClaudeUserText(text: string): boolean {
  const value = text.trimStart();
  return (
    value.startsWith('[Request interrupted by user') ||
    /^<\/?(command-(name|message|args|contents)|local-command-(stdout|stderr)|bash-(input|stdout|stderr))[\s>]/.test(
      value,
    )
  );
}

export function pickClaudeTitle(titles: ClaudeTitleCandidates): string {
  return sanitizeExternalSessionTitle(
    titles.customTitle ??
      titles.aiTitle ??
      titles.lastPrompt ??
      titles.summary ??
      titles.firstUserMessage,
  );
}

function claudeUserMessageText(record: Record<string, unknown>): string | undefined {
  const message = asRecord(record.message);
  if (!message) return undefined;
  const content = message.content;
  if (typeof content === 'string') return content.length > 0 ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    const item = asRecord(block);
    if (item?.type === 'text' && typeof item.text === 'string') texts.push(item.text);
  }
  const joined = texts.join('\n').trim();
  return joined.length > 0 ? joined : undefined;
}

export function claudeUserAuthoredText(record: Record<string, unknown>): string | undefined {
  if (record.isMeta === true || record.isCompactSummary === true) return undefined;
  const text = claudeUserMessageText(record);
  return text === undefined || isSyntheticClaudeUserText(text) ? undefined : text;
}

export function claudeAssistantText(record: Record<string, unknown>): string | undefined {
  return claudeUserMessageText(record);
}

const CODEX_SUPPORTED_THREAD_SOURCES = ['cli', 'exec', 'vscode', 'atlas', 'chatgpt'] as const;

function codexSourceToken(value: unknown): string | undefined {
  if (typeof value === 'string') {
    if (value.length === 0) return undefined;
    if ((CODEX_SUPPORTED_THREAD_SOURCES as readonly string[]).includes(value)) return value;
    if (!value.startsWith('{')) return undefined;
    try {
      return codexSourceToken(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  if (typeof value === 'object' && value !== null) {
    const custom = (value as Record<string, unknown>).custom;
    return typeof custom === 'string' &&
      (CODEX_SUPPORTED_THREAD_SOURCES as readonly string[]).includes(custom)
      ? custom
      : undefined;
  }
  return undefined;
}

export function isSupportedCodexThreadSource(value: unknown): boolean {
  return value === undefined || value === null || codexSourceToken(value) !== undefined;
}

/**
 * Whether one summary answers a query.
 *
 * Shared by every adapter on purpose. The catalog is one surface over several
 * sources, so a filter that quietly worked for Codex and not for Claude Code
 * would be worse than no filter — the user cannot see which source dropped
 * their term. Keeping the decision here means a new adapter inherits the
 * behaviour instead of reimplementing it.
 */
export function externalSessionMatchesQuery(
  summary: ExternalSessionSummary,
  query: ExternalSessionQuery = {},
): boolean {
  if (!query.includeArchived && summary.archived) return false;
  if (query.cwd !== undefined && !sameExternalSessionPath(summary.cwd, query.cwd)) return false;
  const text = normalizeExternalSessionQueryText(query.text);
  if (text === undefined) return true;
  // Title and path, because those are the two things a user remembers about a
  // conversation they are looking for. Both already sit on the summary, so
  // matching costs no extra reads. Message content is deliberately excluded:
  // it would mean opening every transcript on every keystroke.
  //
  // Candidate and term pass through the same normalizer. Without it a term
  // pasted from a Windows path missed a stored forward-slash path that
  // `sameExternalSessionPath` already calls the same project, and a title
  // typed in NFC missed one macOS recorded in NFD.
  // Separator folding is applied to the path pair only, never to the title.
  // Folding a title would make a search for `/n` match a title containing a
  // literal backslash-n, and folding the term without the title would stop
  // `\\n` from finding the very title it names. The path pair has no such
  // ambiguity: a separator there is a separator.
  return (
    normalizeExternalSessionMatchText(summary.name).includes(text) ||
    foldExternalSessionPathSeparators(normalizeExternalSessionMatchText(summary.cwd)).includes(
      foldExternalSessionPathSeparators(text),
    )
  );
}

export function pageExternalSessionSummaries<T>(
  summaries: readonly T[],
  query: Pick<ExternalSessionQuery, 'offset' | 'limit'> = {},
): readonly T[] {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? summaries.length;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0) {
    throw new Error('Invalid external Session adapter page');
  }
  return summaries.slice(offset, offset + limit);
}

/**
 * The comparable form of one side of a text match.
 *
 * Three normalizations, each for a difference that is not a difference to the
 * person searching:
 *
 * - **NFC** — macOS records decomposed filenames, so the same visible name can
 *   arrive composed or decomposed depending on where it was typed.
 * - **case** — nobody searching for a project remembers its capitalisation.
 * - **separators** — a term pasted from a Windows path should still find the
 *   project the summary stored with forward slashes, matching the equivalence
 *   `sameExternalSessionPath` already applies to the `cwd` filter.
 *
 * Applied to the title as well as the path. A title rarely holds a separator,
 * but running one normalizer over both is what keeps this a single authority
 * rather than two rules free to drift.
 */
function normalizeExternalSessionMatchText(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

/**
 * Windows separators folded to the POSIX form, so a term pasted from one
 * spelling of a path finds the project the summary stored in the other. The
 * same equivalence `sameExternalSessionPath` applies to the `cwd` filter.
 */
function foldExternalSessionPathSeparators(value: string): string {
  return normalizeExternalSessionPath(value);
}

/**
 * The comparable form of a search term, or `undefined` when it selects
 * nothing — an empty or whitespace-only box is not a filter, and treating it
 * as one would hide every session behind a stray space.
 */
export function normalizeExternalSessionQueryText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().slice(0, EXTERNAL_SESSION_QUERY_TEXT_MAX_CHARS);
  return trimmed.length > 0 ? normalizeExternalSessionMatchText(trimmed) : undefined;
}

/**
 * Path equality across the shapes different sources record.
 *
 * Codex normalizes separators and lowercases a Windows drive prefix before
 * comparing; the Claude Code adapter compared raw strings, so the same project
 * reached through a different separator answered "no such project". One rule
 * for both.
 */
export function sameExternalSessionPath(left: string, right: string): boolean {
  return normalizeExternalSessionPath(left) === normalizeExternalSessionPath(right);
}

function normalizeExternalSessionPath(value: string): string {
  const folded = value.normalize('NFC').replaceAll('\\', '/');
  // Trailing separators are noise — Windows Explorer copies `C:\\Repo\\App\\`
  // — but the POSIX root IS its separator. Stripping unconditionally folded
  // `/` and `''` to the same value, so a workspace at filesystem root matched
  // every session whose cwd was simply unknown.
  const stripped = folded.replace(/\/+$/u, '');
  // `''` after stripping means the input was nothing but separators, so it was
  // the POSIX root — `/`, `//` and `///` all name the same directory.
  const trimmed = stripped.length > 0 ? stripped : folded.length > 0 ? '/' : '';
  return /^[A-Za-z]:\//u.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/**
 * An external session after its source-specific format has been converted to
 * Maka's existing raw Session representation.
 *
 * There is intentionally no intermediate external-message model here. Each
 * adapter owns its source format and emits canonical Maka StoredMessages.
 */
export interface ExternalMakaSession {
  sourceSessionId: string;
  metadata: {
    name: string;
    cwd: string;
  };
  messages: readonly StoredMessage[];
}

export const EXTERNAL_SESSION_LIMIT_KINDS = [
  'transcript_bytes',
  'record_bytes',
  'records',
  'converted_bytes',
  'messages',
] as const;

/** Safe import refusal data: no source paths, transcript content, or raw errors. */
export interface ExternalSessionLimit {
  readonly kind: (typeof EXTERNAL_SESSION_LIMIT_KINDS)[number];
  readonly max: number;
}

export class ExternalSessionLimitError extends Error {
  readonly limit: ExternalSessionLimit;

  constructor(kind: ExternalSessionLimit['kind'], max: number, message: string) {
    super(message);
    if (!EXTERNAL_SESSION_LIMIT_KINDS.includes(kind) || !Number.isSafeInteger(max) || max <= 0) {
      throw new Error('Invalid external Session import limit');
    }
    this.name = 'ExternalSessionLimitError';
    this.limit = Object.freeze({ kind, max });
  }
}

/** Read-only, source-specific conversion boundary for one external Agent. */
export interface ExternalSessionAdapter {
  readonly id: ExternalAgentId;

  detect(): Promise<boolean>;

  listSessions(query?: ExternalSessionQuery): Promise<readonly ExternalSessionSummary[]>;

  readSession(sessionId: string): Promise<ExternalMakaSession>;
}

export class ExternalSessionAdapterRegistry {
  private readonly adapters = new Map<ExternalAgentId, ExternalSessionAdapter>();

  constructor(adapters: readonly ExternalSessionAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ExternalSessionAdapter): void {
    if (adapter.id.trim().length === 0) {
      throw new Error('External Session adapter id must not be empty');
    }
    if (this.adapters.has(adapter.id)) {
      throw new Error(`External Session adapter is already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(adapterId: ExternalAgentId): ExternalSessionAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  require(adapterId: ExternalAgentId): ExternalSessionAdapter {
    const adapter = this.get(adapterId);
    if (!adapter) throw new Error(`External Session adapter is not registered: ${adapterId}`);
    return adapter;
  }

  list(): readonly ExternalSessionAdapter[] {
    return [...this.adapters.values()];
  }
}
