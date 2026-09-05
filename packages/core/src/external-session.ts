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
