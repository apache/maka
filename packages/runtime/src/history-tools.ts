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

import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_QUERY_MAX_CHARS,
  normalizeSearchLimit,
  normalizeSearchQuery,
  type SearchError,
  type ThreadSearchMatchKind,
} from '@maka/core/search';
import { collapseSessionRevisions } from '@maka/core/session-revisions';
import { redactSecrets } from '@maka/core/redaction';
import { validateWorkspacePrivacyContext } from '@maka/core/incognito';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import {
  collectSearchableText,
  runThreadSearch,
  THREAD_SEARCH_CURSOR_MAX_CHARS,
  type ThreadSearchDeps,
} from '@maka/core/thread-search';
import { z } from 'zod';
import type { MakaTool } from './tool-runtime.js';

export const SEARCH_HISTORY_TOOL_NAME = 'SearchHistory';
export const READ_HISTORY_TOOL_NAME = 'ReadHistory';
export const HISTORY_READ_MAX_TURNS = 5;
export const HISTORY_READ_DEFAULT_BEFORE_TURNS = 1;
export const HISTORY_READ_DEFAULT_AFTER_TURNS = 1;
export const HISTORY_READ_MAX_BYTES = 32 * 1024;
export const HISTORY_READ_MAX_MESSAGE_BYTES = 8 * 1024;

export type HistoryToolDeps = ThreadSearchDeps;

type HistoryReadErrorReason =
  | 'incognito_active'
  | 'session_not_found'
  | 'message_not_found'
  | 'anchor_mismatch'
  | 'turn_not_found'
  | 'empty_transcript'
  | 'aborted';

interface HistoryTurnMessage {
  readonly messageId: string;
  readonly matchKind: Exclude<ThreadSearchMatchKind, 'session_title' | 'tool_result'>;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly text: string;
  readonly timestamp: number;
}

interface HistoryTurn {
  readonly turnId: string;
  readonly messages: readonly HistoryTurnMessage[];
}

/**
 * Builds the read-only global conversation search surface. Search returns
 * message-level hits from every logical Session; reading nearby turns is an
 * optional follow-up rather than a required second phase.
 */
export function buildHistoryTools(deps: HistoryToolDeps): readonly MakaTool[] {
  return [buildSearchHistoryTool(deps), buildReadHistoryTool(deps)];
}

export function buildSearchHistoryTool(deps: HistoryToolDeps): MakaTool {
  return {
    name: SEARCH_HISTORY_TOOL_NAME,
    displayName: 'Search conversation history',
    activityKind: 'read',
    categoryHint: 'read',
    description:
      'Search all Maka conversation sessions, including the current session, by visible title, user text, assistant text, tool intent, or bounded tool result. Returns redacted message-level hits. Use ReadHistory only when a hit needs surrounding context.',
    parameters: z
      .object({
        query: z
          .string()
          .trim()
          .min(1)
          .max(SEARCH_QUERY_MAX_CHARS)
          .describe('Text to find globally in session titles or visible transcript content.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SEARCH_MAX_LIMIT)
          .optional()
          .describe(`Maximum matches; defaults to ${SEARCH_DEFAULT_LIMIT}.`),
        cursor: z
          .string()
          .trim()
          .min(1)
          .max(THREAD_SEARCH_CURSOR_MAX_CHARS)
          .optional()
          .describe(
            'Opaque continuation returned as next_cursor by an earlier SearchHistory page.',
          ),
      })
      .strict(),
    impl: async ({ query, limit, cursor }, context) => {
      if (context.abortSignal.aborted) {
        return historySearchError({
          ok: false,
          reason: 'aborted',
          message: 'History search was aborted.',
        });
      }
      const normalizedQuery = normalizeSearchQuery(query);
      if (!normalizedQuery.ok) return historySearchError(normalizedQuery);
      const normalizedLimit = normalizeSearchLimit(limit);
      if (!normalizedLimit.ok) return historySearchError(normalizedLimit);

      let sessions: SessionSummary[] = [];
      const result = await runThreadSearch(
        {
          source: 'thread',
          query: normalizedQuery.value,
          limit: normalizedLimit.value,
          ...(cursor ? { cursor } : {}),
        },
        {
          ...deps,
          listSessions: async () => {
            sessions = await deps.listSessions();
            return sessions;
          },
        },
        {
          activeSessionId: context.sessionId,
          excludeTurnIds: new Set([context.turnId]),
          includeArchived: true,
          abortSignal: context.abortSignal,
        },
      );
      if (!result.ok) return historySearchError(result);
      if (context.abortSignal.aborted) {
        return historySearchError({
          ok: false,
          reason: 'aborted',
          message: 'History search was aborted.',
        });
      }

      const sessionById = new Map(sessions.map((session) => [session.id, session]));
      return {
        kind: 'history_search' as const,
        query: normalizedQuery.value,
        truncated: result.truncated,
        ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
        rows: result.results.flatMap((row) => {
          if (row.target?.kind !== 'thread') return [];
          const session = sessionById.get(row.target.sessionId);
          return [
            {
              session_id: row.target.sessionId,
              ...(row.target.turnId ? { turn_id: row.target.turnId } : {}),
              ...(row.target.messageId ? { message_id: row.target.messageId } : {}),
              ...(row.target.matchKind ? { match_kind: row.target.matchKind } : {}),
              ...(row.target.messageTimestamp !== undefined
                ? { message_timestamp: row.target.messageTimestamp }
                : {}),
              is_current_session: row.target.sessionId === context.sessionId,
              title: row.title,
              summary: redactSecrets(row.summary ?? ''),
              snippet: row.snippet ?? '',
              ...(session?.lastMessageAt !== undefined
                ? { last_message_at: session.lastMessageAt }
                : {}),
              ...(row.truncated ? { truncated: true } : {}),
            },
          ];
        }),
      };
    },
  };
}

export function buildReadHistoryTool(deps: HistoryToolDeps): MakaTool {
  return {
    name: READ_HISTORY_TOOL_NAME,
    displayName: 'Read conversation history',
    activityKind: 'read',
    categoryHint: 'read',
    description:
      'Optionally read bounded visible turns around a message-level SearchHistory hit, from any session including the current one. Use message_id as the preferred anchor. Hidden reasoning, permission records, and raw tool arguments/results are never returned.',
    parameters: z
      .object({
        session_id: z.string().trim().min(1).max(256).describe('Session id from SearchHistory.'),
        message_id: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .optional()
          .describe('Preferred message id anchor from SearchHistory; absent for title matches.'),
        turn_id: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .optional()
          .describe('Optional turn id anchor from SearchHistory, retained for title/legacy hits.'),
        before: z
          .number()
          .int()
          .min(0)
          .max(HISTORY_READ_MAX_TURNS - 1)
          .optional()
          .describe(
            `Visible turns before the anchor; defaults to ${HISTORY_READ_DEFAULT_BEFORE_TURNS}.`,
          ),
        after: z
          .number()
          .int()
          .min(0)
          .max(HISTORY_READ_MAX_TURNS - 1)
          .optional()
          .describe(
            `Visible turns after the anchor; defaults to ${HISTORY_READ_DEFAULT_AFTER_TURNS}.`,
          ),
      })
      .strict()
      .superRefine((value, ctx) => {
        const before = value.before ?? HISTORY_READ_DEFAULT_BEFORE_TURNS;
        const after = value.after ?? HISTORY_READ_DEFAULT_AFTER_TURNS;
        if (before + 1 + after > HISTORY_READ_MAX_TURNS) {
          ctx.addIssue({
            code: 'custom',
            path: ['after'],
            message: `before + anchor + after must be at most ${HISTORY_READ_MAX_TURNS} turns`,
          });
        }
      }),
    impl: async (
      {
        session_id: sessionId,
        message_id: messageId,
        turn_id: requestedTurnId,
        before = HISTORY_READ_DEFAULT_BEFORE_TURNS,
        after = HISTORY_READ_DEFAULT_AFTER_TURNS,
      },
      context,
    ) => {
      if (context.abortSignal.aborted) return historyError('aborted', 'History read was aborted.');

      const privacyPayload = await deps.getPrivacyContext();
      if (context.abortSignal.aborted) return historyError('aborted', 'History read was aborted.');
      const privacy = validateWorkspacePrivacyContext(privacyPayload);
      if (!privacy.ok) {
        return historyError(
          'incognito_active',
          'History is unavailable because workspace privacy state could not be verified.',
        );
      }
      if (privacy.value.incognitoActive) {
        return historyError(
          'incognito_active',
          'History is unavailable while incognito is active.',
        );
      }

      const sessions = collapseSessionRevisions(await deps.listSessions(), context.sessionId);
      if (context.abortSignal.aborted) return historyError('aborted', 'History read was aborted.');
      const session = sessions.find(
        (candidate) => candidate.id === sessionId && candidate.backend !== 'fake',
      );
      if (!session) {
        return historyError('session_not_found', 'The requested session was not found.');
      }
      if (context.abortSignal.aborted) return historyError('aborted', 'History read was aborted.');

      const messages = await deps.readMessages(sessionId, context.abortSignal);
      if (context.abortSignal.aborted) return historyError('aborted', 'History read was aborted.');
      if (!messages) {
        return historyError('session_not_found', 'The requested session was not found.');
      }
      const readableMessages =
        sessionId === context.sessionId
          ? messages.filter(
              (message) => !('turnId' in message) || message.turnId !== context.turnId,
            )
          : messages;
      const anchor = resolveHistoryAnchor(readableMessages, messageId, requestedTurnId);
      if (!anchor.ok) return historyError(anchor.reason, anchor.message);
      const turns = projectHistoryTurns(readableMessages);
      if (turns.length === 0) {
        return historyError('empty_transcript', 'The requested session has no visible transcript.');
      }
      const selected = selectHistoryTurns(turns, anchor.turnId, before, after);
      if (!selected) {
        return historyError('turn_not_found', 'The requested turn was not found in that session.');
      }
      const bounded = boundHistoryTurns(
        selected.turns,
        HISTORY_READ_MAX_BYTES,
        anchor.turnId,
        messageId,
      );
      return {
        kind: 'history_read' as const,
        session_id: session.id,
        is_current_session: session.id === context.sessionId,
        ...(messageId ? { anchor_message_id: messageId } : {}),
        ...(anchor.turnId ? { anchor_turn_id: anchor.turnId } : {}),
        title: redactSecrets(session.name),
        ...(session.lastMessageAt !== undefined ? { last_message_at: session.lastMessageAt } : {}),
        turns: bounded.turns.map((turn) => ({
          turn_id: turn.turnId,
          messages: turn.messages.map(({ messageId: id, matchKind, ...message }) => ({
            message_id: id,
            match_kind: matchKind,
            ...message,
          })),
        })),
        has_more_before: selected.hasMoreBefore,
        has_more_after: selected.hasMoreAfter,
        ...(bounded.truncated ? { truncated: true } : {}),
      };
    },
  };
}

export function projectHistoryTurns(messages: readonly StoredMessage[]): HistoryTurn[] {
  const turns = new Map<string, HistoryTurnMessage[]>();
  for (const message of messages) {
    const projected = projectHistoryMessage(message);
    if (!projected || !('turnId' in message) || !message.turnId) continue;
    const turn = turns.get(message.turnId) ?? [];
    turn.push(projected);
    turns.set(message.turnId, turn);
  }
  return [...turns].map(([turnId, turnMessages]) => ({ turnId, messages: turnMessages }));
}

function projectHistoryMessage(message: StoredMessage): HistoryTurnMessage | undefined {
  switch (message.type) {
    case 'user':
      return {
        messageId: message.id,
        matchKind: 'user_message',
        role: 'user',
        text: redactSecrets(message.displayText ?? message.text),
        timestamp: message.ts,
      };
    case 'assistant':
      if (!message.text.trim()) return undefined;
      return {
        messageId: message.id,
        matchKind: 'assistant_message',
        role: 'assistant',
        text: redactSecrets(message.text),
        timestamp: message.ts,
      };
    case 'tool_call':
      if (!message.intent?.trim()) return undefined;
      return {
        messageId: message.id,
        matchKind: 'tool_intent',
        role: 'tool',
        text: redactSecrets(message.intent),
        timestamp: message.ts,
      };
    case 'tool_result':
    case 'permission_decision':
    case 'token_usage':
    case 'turn_state':
    case 'system_note':
      return undefined;
  }
}

function resolveHistoryAnchor(
  messages: readonly StoredMessage[],
  messageId: string | undefined,
  requestedTurnId: string | undefined,
):
  | { readonly ok: true; readonly turnId: string | undefined }
  | {
      readonly ok: false;
      readonly reason: Extract<HistoryReadErrorReason, 'message_not_found' | 'anchor_mismatch'>;
      readonly message: string;
    } {
  if (!messageId) return { ok: true, turnId: requestedTurnId };
  const message = messages.find(
    (candidate) => candidate.id === messageId && collectSearchableText(candidate) !== undefined,
  );
  if (!message || !('turnId' in message) || !message.turnId) {
    return {
      ok: false,
      reason: 'message_not_found',
      message: 'The requested searchable message was not found in that session.',
    };
  }
  if (requestedTurnId && requestedTurnId !== message.turnId) {
    return {
      ok: false,
      reason: 'anchor_mismatch',
      message: 'The requested message_id and turn_id do not identify the same result.',
    };
  }
  return { ok: true, turnId: message.turnId };
}

function selectHistoryTurns(
  turns: readonly HistoryTurn[],
  turnId: string | undefined,
  before: number,
  after: number,
):
  | {
      readonly turns: HistoryTurn[];
      readonly hasMoreBefore: boolean;
      readonly hasMoreAfter: boolean;
    }
  | undefined {
  if (!turnId) {
    const start = Math.max(0, turns.length - (before + 1 + after));
    return {
      turns: turns.slice(start),
      hasMoreBefore: start > 0,
      hasMoreAfter: false,
    };
  }
  const target = turns.findIndex((turn) => turn.turnId === turnId);
  if (target < 0) return undefined;
  const start = Math.max(0, target - before);
  const end = Math.min(turns.length, target + after + 1);
  return {
    turns: turns.slice(start, end),
    hasMoreBefore: start > 0,
    hasMoreAfter: end < turns.length,
  };
}

function boundHistoryTurns(
  turns: readonly HistoryTurn[],
  maxBytes: number,
  anchorTurnId: string | undefined,
  anchorMessageId: string | undefined,
): { turns: HistoryTurn[]; truncated: boolean } {
  const boundedMessages = new Map<number, Map<number, HistoryTurnMessage>>();
  let remaining = maxBytes;
  let truncated = false;

  const candidates = turns.flatMap((turn, turnIndex) =>
    turn.messages.map((_message, messageIndex) => ({ turnIndex, messageIndex })),
  );
  const anchorTurnIndex = turns.findIndex((turn) => turn.turnId === anchorTurnId);
  const requestedAnchorIndex =
    anchorTurnIndex < 0
      ? -1
      : turns[anchorTurnIndex]!.messages.findIndex(
          (message) => message.messageId === anchorMessageId,
        );
  const anchorMessageIndex = Math.max(0, requestedAnchorIndex);
  if (anchorTurnIndex >= 0 && turns[anchorTurnIndex]!.messages.length > 0) {
    candidates.unshift({ turnIndex: anchorTurnIndex, messageIndex: anchorMessageIndex });
  } else {
    // An unanchored read means "show me the latest history". Spend the fixed
    // byte budget newest-first, then restore chronological order below.
    candidates.reverse();
  }

  const seen = new Set<string>();
  for (const { turnIndex, messageIndex } of candidates) {
    const key = `${turnIndex}:${messageIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const message = turns[turnIndex]!.messages[messageIndex]!;
    const overhead = Buffer.byteLength(JSON.stringify({ ...message, text: '' }), 'utf8');
    if (remaining <= overhead) {
      truncated = true;
      continue;
    }
    const messageBudget = Math.min(remaining - overhead, HISTORY_READ_MAX_MESSAGE_BYTES);
    const text = truncateUtf8(message.text, messageBudget);
    const bytes = overhead + Buffer.byteLength(text, 'utf8');
    const byMessage = boundedMessages.get(turnIndex) ?? new Map<number, HistoryTurnMessage>();
    byMessage.set(messageIndex, { ...message, text });
    boundedMessages.set(turnIndex, byMessage);
    remaining -= bytes;
    if (text !== message.text) truncated = true;
  }

  const bounded = turns.flatMap((turn, turnIndex) => {
    const byMessage = boundedMessages.get(turnIndex);
    if (!byMessage) return [];
    return [
      {
        turnId: turn.turnId,
        messages: [...byMessage.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, message]) => message),
      },
    ];
  });
  return { turns: bounded, truncated };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  if (maxBytes <= 3) return '';
  const body = Buffer.from(value, 'utf8')
    .subarray(0, maxBytes - 3)
    .toString('utf8')
    .replace(/\uFFFD+$/u, '');
  return `${body}…`;
}

function historySearchError(error: SearchError) {
  return {
    kind: 'history_search_error' as const,
    ok: false as const,
    reason: error.reason,
    message: error.message,
  };
}

function historyError(reason: HistoryReadErrorReason, message: string) {
  return { kind: 'history_read_error' as const, ok: false as const, reason, message };
}
