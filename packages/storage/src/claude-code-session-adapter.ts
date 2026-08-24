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

// Claude Code transcripts as Maka Sessions.
//
// Transcripts live at `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, one
// JSON object per line, discriminated by `type`. The parsing primitives are
// shared with the CLI's foreign-session handoff (`@maka/core/foreign-session`)
// rather than reimplemented: a scanner and an importer that disagreed about
// "what did the user actually say" would be a real defect, not a cosmetic one.
//
// The directory name cannot answer which session belongs to which project —
// it encodes the cwd by replacing separators, so `-Users-a-b` is ambiguous
// between `/Users/a/b` and `/Users/a-b`. Every record carries its own `cwd`,
// and that is what a project-scoped query reads.
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  claudeAssistantText,
  claudeUserAuthoredText,
  isSyntheticClaudeUserText,
  pickClaudeTitle,
  sanitizeForeignTitle,
} from '@maka/core/foreign-session';
import { externalSessionMatchesQuery } from '@maka/core/external-session';
import type {
  ExternalMakaSession,
  ExternalSessionAdapter,
  ExternalSessionQuery,
  ExternalSessionSummary,
} from '@maka/core/external-session';
import type { StoredMessage } from '@maka/core/session';
import {
  resolveTranscriptLineage,
  type TranscriptRecord,
} from './claude-code-transcript-lineage.js';

export const CLAUDE_CODE_SESSION_ADAPTER_ID = 'claude-code';

/** A transcript larger than this is not read. Bounded for the same reason the
 *  Codex rollout cap exists: a single hostile or runaway file must not be able
 *  to exhaust the Host's memory during an import the user asked for. */
export const CLAUDE_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;

/** Session ids are the transcript's filename stem, and reach the filesystem.
 *  A uuid is what Claude Code writes; anything else is refused rather than
 *  joined onto a path. */
const SESSION_ID_PATTERN = /^[0-9a-fA-F-]{1,128}$/u;

export interface ClaudeCodeSessionAdapterOptions {
  /** Overrides `~/.claude`. */
  claudeHome?: string;
  maxTranscriptBytes?: number;
}

interface ParsedTranscript {
  readonly records: readonly TranscriptRecord[];
  readonly cwd: string;
  readonly title: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly isSidechain: boolean;
}

export class ClaudeCodeSessionAdapter implements ExternalSessionAdapter {
  readonly id = CLAUDE_CODE_SESSION_ADAPTER_ID;
  readonly #home: string;
  readonly #maxBytes: number;
  /**
   * Summaries already derived from a transcript, keyed by path and invalidated
   * by the file's own mtime and size.
   *
   * Listing reads and parses every transcript: 1128 of them take about a
   * second here, and the catalog is listed once per search term. Without this,
   * a pause in typing starts another full parse of files that have not changed
   * since the last one — the cost is paid again for an answer already known.
   *
   * Keyed on what the filesystem reports rather than a timer: a transcript
   * that Claude Code appended to must be re-read, and one that did not change
   * cannot have a different summary.
   */
  readonly #summaries = new Map<
    string,
    { mtimeMs: number; size: number; summary?: ExternalSessionSummary }
  >();

  constructor(options: ClaudeCodeSessionAdapterOptions = {}) {
    this.#home = options.claudeHome ?? join(homedir(), '.claude');
    this.#maxBytes = options.maxTranscriptBytes ?? CLAUDE_TRANSCRIPT_MAX_BYTES;
  }

  async detect(): Promise<boolean> {
    return existsSync(this.#projectsRoot());
  }

  async listSessions(query?: ExternalSessionQuery): Promise<readonly ExternalSessionSummary[]> {
    const summaries: ExternalSessionSummary[] = [];
    const live = new Set<string>();
    for (const file of await this.#transcriptFiles()) {
      live.add(file.path);
      const summary = await this.#summaryOf(file.path, file.sessionId);
      if (!summary) continue;
      // The shared matcher, not a local cwd comparison: filtering happens here
      // rather than after paging, and every source has to answer a query the
      // same way or the catalog lies about which one dropped the term.
      if (!externalSessionMatchesQuery(summary, query)) continue;
      summaries.push(summary);
    }
    // A transcript the source no longer lists must not keep its entry alive,
    // or a long-lived Host grows one per deleted session.
    for (const path of this.#summaries.keys()) {
      if (!live.has(path)) this.#summaries.delete(path);
    }
    summaries.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    return summaries;
  }

  /**
   * The summary for one transcript, parsed only when the file has changed.
   *
   * `undefined` is cached too: a sidechain transcript or an unreadable one is
   * a stable answer, and re-deriving it every list would defeat the point.
   */
  async #summaryOf(path: string, sessionId: string): Promise<ExternalSessionSummary | undefined> {
    let mtimeMs: number;
    let size: number;
    try {
      const info = await stat(path);
      mtimeMs = info.mtimeMs;
      size = info.size;
    } catch {
      this.#summaries.delete(path);
      return undefined;
    }
    const cached = this.#summaries.get(path);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.summary;

    const parsed = await this.#parse(path, sessionId);
    // Sub-agent transcripts are whole files, never records interleaved into a
    // parent — so exclusion is per file. Importing one would present a
    // fragment of a conversation as a conversation.
    const summary =
      parsed && !parsed.isSidechain
        ? {
            id: sessionId,
            name: parsed.title || sessionId,
            cwd: parsed.cwd,
            ...(parsed.createdAt !== undefined ? { createdAt: parsed.createdAt } : {}),
            ...(parsed.updatedAt !== undefined ? { updatedAt: parsed.updatedAt } : {}),
          }
        : undefined;
    this.#summaries.set(path, { mtimeMs, size, ...(summary ? { summary } : {}) });
    return summary;
  }

  async readSession(sessionId: string): Promise<ExternalMakaSession> {
    assertSafeSessionId(sessionId);
    const file = (await this.#transcriptFiles()).find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (!file) throw new Error(`Claude Code transcript not found: ${sessionId}`);
    const parsed = await this.#parse(file.path, sessionId);
    if (!parsed) throw new Error(`Claude Code transcript could not be read: ${sessionId}`);
    if (parsed.isSidechain) {
      throw new Error(`Claude Code transcript is a sub-agent sidechain: ${sessionId}`);
    }
    return {
      sourceSessionId: sessionId,
      metadata: { name: parsed.title || sessionId, cwd: parsed.cwd },
      messages: convertTranscript(sessionId, parsed.records),
    };
  }

  #projectsRoot(): string {
    return join(this.#home, 'projects');
  }

  async #transcriptFiles(): Promise<ReadonlyArray<{ path: string; sessionId: string }>> {
    const root = this.#projectsRoot();
    let projects: string[];
    try {
      projects = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    // Keyed by session id: the same id can legitimately exist under more than
    // one project directory after a workspace move or a resumed session. Two
    // files with one id are two candidates for the same source session, and
    // list and read must pick the same one or a user selects one summary and
    // imports the other.
    const bySessionId = new Map<string, { path: string; sessionId: string; mtimeMs: number }>();
    for (const project of projects) {
      let entries: string[];
      try {
        entries = (await readdir(join(root, project), { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const name of entries) {
        const sessionId = name.slice(0, -'.jsonl'.length);
        if (!SESSION_ID_PATTERN.test(sessionId)) continue;
        const path = join(root, project, name);
        // The id reaches a path join, so the resolved file must still be under
        // the projects root — a crafted id must not read outside it.
        if (!resolve(path).startsWith(resolve(root))) continue;
        let mtimeMs: number;
        try {
          mtimeMs = (await stat(path)).mtimeMs;
        } catch {
          continue;
        }
        const existing = bySessionId.get(sessionId);
        // Newest wins, and the path breaks a tie so the choice does not depend
        // on directory iteration order. A resumed session's continuation is
        // the copy a user means when they pick that id.
        if (
          !existing ||
          mtimeMs > existing.mtimeMs ||
          (mtimeMs === existing.mtimeMs && path < existing.path)
        ) {
          bySessionId.set(sessionId, { path, sessionId, mtimeMs });
        }
      }
    }
    return [...bySessionId.values()].map(({ path, sessionId }) => ({ path, sessionId }));
  }

  async #parse(path: string, sessionId: string): Promise<ParsedTranscript | undefined> {
    try {
      const info = await stat(path);
      if (info.size > this.#maxBytes) return undefined;
    } catch {
      return undefined;
    }

    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return undefined;
    }

    const records: TranscriptRecord[] = [];
    let cwd = '';
    let isSidechain = false;
    let createdAt: number | undefined;
    let updatedAt: number | undefined;
    const titles: {
      customTitle?: string;
      aiTitle?: string;
      summary?: string;
      lastPrompt?: string;
      firstUserMessage?: string;
    } = {};

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        // A torn final line is what an interrupted write leaves behind, and a
        // corrupt interior line is not worth failing an otherwise readable
        // transcript over. Skipping is what the scanner already does.
        continue;
      }
      if (typeof record !== 'object' || record === null || Array.isArray(record)) continue;
      const typed = record as TranscriptRecord;
      records.push(typed);

      if (typed.isSidechain === true) isSidechain = true;
      if (typeof typed.cwd === 'string' && typed.cwd && !cwd) cwd = typed.cwd;
      const ts = timestampMs(typed);
      if (ts !== undefined) {
        createdAt ??= ts;
        updatedAt = ts;
      }
      collectTitle(typed, titles);
      if (titles.firstUserMessage === undefined && typed.type === 'user') {
        const text = claudeUserAuthoredText(typed);
        if (text) titles.firstUserMessage = text;
      }
    }

    if (records.length === 0) return undefined;
    return {
      records,
      cwd,
      title: pickClaudeTitle(titles),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      isSidechain,
    };
  }
}

function assertSafeSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('Claude Code session id is not a transcript name');
  }
}

function collectTitle(
  record: TranscriptRecord,
  titles: { customTitle?: string; aiTitle?: string; summary?: string; lastPrompt?: string },
): void {
  const take = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? sanitizeForeignTitle(value) : undefined;
  switch (record.type) {
    case 'ai-title':
      titles.aiTitle = take(record.aiTitle ?? record.title) ?? titles.aiTitle;
      return;
    case 'last-prompt':
      titles.lastPrompt = take(record.lastPrompt ?? record.prompt) ?? titles.lastPrompt;
      return;
    case 'summary':
      titles.summary = take(record.summary) ?? titles.summary;
      return;
    default:
      return;
  }
}

function timestampMs(record: TranscriptRecord): number | undefined {
  const value = record.timestamp;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export default ClaudeCodeSessionAdapter;

/* ------------------------------------------------------------------ *
 * Transcript -> StoredMessage[]
 * ------------------------------------------------------------------ */

/** `stop_reason` values that mean the model finished what it was saying. This
 *  is the recorded evidence a terminal `turn_state` needs: the Ledger refuses a
 *  reconstructed terminal that no record corroborates
 *  (`runtime-ledger-repair.ts`), and rightly so — a transcript killed
 *  mid-answer must not import as one that completed.
 *
 *  `max_tokens` is deliberately absent. It does report that generation stopped,
 *  but it stopped because the answer hit the output limit — the turn was cut
 *  off mid-sentence, which is the opposite of completed. It is rare (1
 *  occurrence across 1130 local transcripts) and imports with no terminal
 *  state, the same as any other turn whose end nothing vouches for. */
const TERMINAL_STOP_REASONS = new Set(['end_turn', 'stop_sequence']);

/** Names the cutoff for a turn the transcript simply stops inside, so a reader
 *  can tell an imported snapshot's edge from a user's Stop or a provider abort. */
const EXTERNAL_SNAPSHOT_ABORT_SOURCE = 'external_session_snapshot';

interface TurnAccumulator {
  turnId: string;
  lastTs: number;
  /** Set when a terminal `stop_reason` is seen; the turn ends `completed`. */
  terminalStop?: string;
  /** Set by `isApiErrorMessage`; the turn ends `failed`. */
  failed?: boolean;
  /** Set by an interrupt notice; the turn ends `aborted`. */
  aborted?: boolean;
}

/**
 * Which records are the conversation, decided before any of them becomes a
 * message. See `claude-code-transcript-lineage` for what the transcript's own
 * fields say about rewind branches, compaction boundaries, and fragmented
 * responses; this file only converts what that returns.
 */
export function convertTranscript(
  sessionId: string,
  rawRecords: readonly TranscriptRecord[],
): readonly StoredMessage[] {
  const records = resolveTranscriptLineage(rawRecords).records;
  // Every fragment of one assistant response, keyed by `message.id`. A
  // response is emitted once, from all of its fragments, at the position of
  // the first — so a later fragment's text is part of the reply rather than
  // something the first fragment's absence of text can suppress.
  const responseFragments = new Map<string, TranscriptRecord[]>();
  for (const record of records) {
    if (record.type !== 'assistant') continue;
    const responseId = stringOf(asMessageRecord(record)?.id);
    if (responseId === undefined) continue;
    const existing = responseFragments.get(responseId);
    if (existing) existing.push(record);
    else responseFragments.set(responseId, [record]);
  }
  const emittedResponses = new Set<string>();
  const messages: StoredMessage[] = [];
  // A boundary can precede the first turn — a transcript that opens straight
  // after a compaction. A system note needs a turn to hang from, so the fact
  // waits for one rather than being dropped for arriving early.
  let pendingCompactBoundaryTs: number | undefined;
  let turn: TurnAccumulator | undefined;
  let sequence = 0;
  const id = (kind: string): string => `claude-code:${sessionId}:${kind}:${sequence++}`;
  // Turn ids count separately from message ids. Sharing one counter made turn
  // ids skip (`turn:0`, `turn:3`) for no reason, and left them one edit away
  // from colliding with a message id if the emission order ever changed.
  let turnSequence = 0;
  const nextTurnId = (): string => `claude-code:${sessionId}:turn:${turnSequence++}`;

  const closeTurn = (): void => {
    if (!turn) return;
    // Every turn gets a terminal state, and which one depends on what the
    // transcript actually says.
    //
    // Leaving one out is not the same as preserving "unfinished". Without a
    // `turn_state`, `deriveTurnRecords` falls back to `inferLegacyTurnStatus`,
    // which answers `completed` for any turn holding an assistant message
    // (`session.ts:1250`) and marks it `inferred`. The Ledger then refuses
    // that uncorroborated terminal and the repair path persists
    // `failed / missing_terminal_event` — an internal-corruption verdict on a
    // transcript that was merely cut short. Measured: 13.9% of turns across
    // 1130 local transcripts end with no assistant reply or at a `tool_use`
    // whose result never arrived.
    //
    // So an unfinished turn is recorded as what it is: a snapshot that ended
    // mid-turn, with an `abortSource` naming the import rather than a user or
    // a provider. `end_turn`, interrupt notices and API errors keep their own
    // evidence and are unaffected.
    if (turn.aborted) {
      messages.push({
        type: 'turn_state',
        id: id('turn-state'),
        turnId: turn.turnId,
        ts: turn.lastTs,
        status: 'aborted',
        abortedAt: turn.lastTs,
        abortSource: 'claude-code.interrupt',
        partialOutputRetained: true,
      });
    } else if (turn.failed) {
      messages.push({
        type: 'turn_state',
        id: id('turn-state'),
        turnId: turn.turnId,
        ts: turn.lastTs,
        status: 'failed',
        errorClass: 'claude_code_api_error',
        partialOutputRetained: true,
      });
    } else if (turn.terminalStop) {
      messages.push({
        type: 'turn_state',
        id: id('turn-state'),
        turnId: turn.turnId,
        ts: turn.lastTs,
        status: 'completed',
        partialOutputRetained: true,
      });
    } else {
      messages.push({
        type: 'turn_state',
        id: id('turn-state'),
        turnId: turn.turnId,
        ts: turn.lastTs,
        status: 'aborted',
        abortedAt: turn.lastTs,
        abortSource: EXTERNAL_SNAPSHOT_ABORT_SOURCE,
        partialOutputRetained: true,
      });
    }
    turn = undefined;
  };

  for (const record of records) {
    const ts = timestampMs(record) ?? turn?.lastTs ?? 0;
    if (turn) turn.lastTs = ts;
    const type = record.type;

    if (type === 'user') {
      const message = asMessageRecord(record);
      const toolResults = toolResultBlocks(message);
      if (toolResults.length > 0) {
        // Tool results arrive as `user` records — the harness replying to the
        // model, not the human. Importing them as user Turns would put the
        // model's own tool output in the user's mouth.
        for (const block of toolResults) {
          if (!turn) continue;
          const toolUseId = stringOf(block.tool_use_id);
          // A result with no `tool_use_id` cannot be matched to its call.
          // Minting one produces a result that is guaranteed not to pair with
          // anything — a detached row in the transcript view, which is worse
          // than the row being absent.
          if (!toolUseId) continue;
          messages.push({
            type: 'tool_result',
            id: id('tool-result'),
            turnId: turn.turnId,
            ts,
            toolUseId,
            isError: block.is_error === true,
            content: { kind: 'text', text: toolResultText(block.content) },
          });
        }
        continue;
      }

      const text = claudeUserAuthoredText(record);
      if (text === undefined) {
        // Synthetic user text: interrupt notices and command wrappers. The
        // interrupt notice is one of the few terminal facts a transcript
        // carries, so it is read for status even though it is not a message.
        const raw = rawUserText(message);
        if (
          raw &&
          isSyntheticClaudeUserText(raw) &&
          raw.trimStart().startsWith('[Request interrupted')
        ) {
          if (turn) turn.aborted = true;
        }
        continue;
      }

      // A human-authored user record opens a new turn.
      closeTurn();
      turn = { turnId: nextTurnId(), lastTs: ts };
      if (pendingCompactBoundaryTs !== undefined) {
        messages.push({
          type: 'system_note',
          id: id('compact'),
          turnId: turn.turnId,
          ts: pendingCompactBoundaryTs,
          kind: 'context_compacted',
        });
        pendingCompactBoundaryTs = undefined;
      }
      messages.push({ type: 'user', id: id('user'), turnId: turn.turnId, ts, text });
      continue;
    }

    if (type === 'assistant') {
      if (!turn) {
        // A transcript can open with an assistant record when the session was
        // resumed. Give it a turn rather than dropping the content.
        turn = { turnId: nextTurnId(), lastTs: ts };
        if (pendingCompactBoundaryTs !== undefined) {
          messages.push({
            type: 'system_note',
            id: id('compact'),
            turnId: turn.turnId,
            ts: pendingCompactBoundaryTs,
            kind: 'context_compacted',
          });
          pendingCompactBoundaryTs = undefined;
        }
      }
      if (record.isApiErrorMessage === true) turn.failed = true;
      const message = asMessageRecord(record);
      const responseId = stringOf(message?.id);
      // A response is emitted once, at its first fragment, assembled from all
      // of them. A later fragment reached here is that same response still
      // being written — its content is already in what was emitted, and
      // emitting again would repeat the reply.
      if (responseId !== undefined) {
        if (emittedResponses.has(responseId)) continue;
        emittedResponses.add(responseId);
      }
      // A fragment with no id stands alone; it is the only fragment of itself.
      const fragments = (responseId === undefined
        ? undefined
        : responseFragments.get(responseId)) ?? [record];

      // Status evidence is read from every fragment, not just the first: the
      // `stop_reason` lands on whichever fragment the response finished on.
      for (const fragment of fragments) {
        if (fragment.isApiErrorMessage === true) turn.failed = true;
        const stop = stringOf(asMessageRecord(fragment)?.stop_reason);
        if (stop && TERMINAL_STOP_REASONS.has(stop)) turn.terminalStop = stop;
      }

      // The transcript names the model that produced each step. Carrying the
      // real value keeps an imported turn attributable; a placeholder would
      // put a model the user never ran onto their history.
      const modelId = stringOf(message?.model) ?? 'claude-code';

      // Concatenated in fragment order, which is the order the response was
      // streamed. Joining rather than picking one: every delta is content the
      // model produced, and choosing between them would be choosing which
      // half of a reply to keep.
      const thinking = fragments
        .map((fragment) => thinkingText(asMessageRecord(fragment)))
        .filter((part) => part.length > 0)
        .join('\n\n');
      if (thinking) {
        messages.push({
          type: 'assistant',
          id: id('thinking'),
          turnId: turn.turnId,
          ts,
          text: '',
          thinking: { text: thinking },
          contentOrder: ['thinking'],
          modelId,
        });
      }
      const text = fragments
        .map((fragment) => claudeAssistantText(fragment))
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join('\n\n');
      if (text) {
        messages.push({
          type: 'assistant',
          id: id('assistant'),
          turnId: turn.turnId,
          ts,
          text,
          contentOrder: ['text'],
          modelId,
        });
      }
      // Every call the response made, before any of their results. Calls
      // sharing a `message.id` came from one API response, so they were
      // issued together however the log interleaved them with the results
      // arriving; a call written after its sibling's result did not follow it.
      for (const fragment of fragments) {
        for (const block of toolUseBlocks(asMessageRecord(fragment))) {
          messages.push({
            type: 'tool_call',
            // The id must equal the tool_use id so the result can match it.
            id: stringOf(block.id) ?? id('tool-call'),
            turnId: turn.turnId,
            ts,
            toolName: stringOf(block.name) ?? 'unknown',
            args: block.input ?? {},
          });
        }
      }
      continue;
    }

    // The compaction boundary, keyed on the record that states it.
    //
    // It used to be keyed on `isCompactSummary`, which belongs to the summary
    // *user* record — and that record is consumed by the `user` branch above
    // and never reaches here, so the note was never emitted. The import then
    // carried the pre-boundary history flat with nothing saying a compaction
    // had happened, while `claudeUserAuthoredText` dropped the summary itself
    // for being `isCompactSummary`: both halves of the event lost at once.
    //
    // Pre-boundary records stay. They are the conversation that actually
    // happened — 24,695 of them across the 5 compacted transcripts here — and
    // the boundary marks where the model's context restarted, which is the
    // part a reader cannot reconstruct from the messages themselves.
    if (record.subtype === 'compact_boundary') {
      if (!turn) {
        pendingCompactBoundaryTs = ts;
        continue;
      }
      messages.push({
        type: 'system_note',
        id: id('compact'),
        turnId: turn.turnId,
        ts,
        kind: 'context_compacted',
      });
    }
  }

  closeTurn();
  return messages;
}

function asMessageRecord(record: TranscriptRecord): Record<string, unknown> | undefined {
  const message = record.message;
  return typeof message === 'object' && message !== null && !Array.isArray(message)
    ? (message as Record<string, unknown>)
    : undefined;
}

function contentBlocks(message: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is Record<string, unknown> =>
      typeof block === 'object' && block !== null && !Array.isArray(block),
  );
}

function toolUseBlocks(message: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return contentBlocks(message).filter((block) => block.type === 'tool_use');
}

function toolResultBlocks(message: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return contentBlocks(message).filter((block) => block.type === 'tool_result');
}

function thinkingText(message: Record<string, unknown> | undefined): string {
  return contentBlocks(message)
    .filter((block) => block.type === 'thinking')
    .map((block) => stringOf(block.thinking) ?? '')
    .filter(Boolean)
    .join('\n\n');
}

function rawUserText(message: Record<string, unknown> | undefined): string | undefined {
  const content = message?.content;
  if (typeof content === 'string') return content;
  const texts = contentBlocks(message)
    .filter((block) => block.type === 'text')
    .map((block) => stringOf(block.text) ?? '');
  return texts.join('\n').trim() || undefined;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === 'object' && block !== null && !Array.isArray(block)
          ? (stringOf((block as Record<string, unknown>).text) ?? '')
          : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
