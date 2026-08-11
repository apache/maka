import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_QUERY_MAX_CHARS,
  normalizeSearchLimit,
  normalizeSearchQuery,
  type SearchError,
} from '@maka/core/search';
import { collapseSessionRevisions } from '@maka/core/session-revisions';
import { redactSecrets } from '@maka/core/redaction';
import { validateWorkspacePrivacyContext } from '@maka/core/incognito';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import { runThreadSearch, type ThreadSearchDeps } from '@maka/core/thread-search';
import { z } from 'zod';
import type { MakaTool } from './tool-runtime.js';

export const SEARCH_HISTORY_TOOL_NAME = 'SearchHistory';
export const READ_HISTORY_TOOL_NAME = 'ReadHistory';
export const HISTORY_READ_DEFAULT_TURNS = 3;
export const HISTORY_READ_MAX_TURNS = 5;
export const HISTORY_READ_MAX_BYTES = 32 * 1024;
export const HISTORY_READ_MAX_MESSAGE_BYTES = 8 * 1024;

export type HistoryToolDeps = ThreadSearchDeps;

type HistoryReadErrorReason =
  | 'incognito_active'
  | 'session_not_found'
  | 'current_session'
  | 'turn_not_found'
  | 'empty_transcript'
  | 'aborted';

interface HistoryTurnMessage {
  readonly role: 'user' | 'assistant' | 'tool';
  readonly text: string;
  readonly timestamp: number;
}

interface HistoryTurn {
  readonly turnId: string;
  readonly messages: readonly HistoryTurnMessage[];
}

/**
 * Builds the two-stage, read-only cross-Session history surface.
 * Search is intentionally separate from bounded transcript reading so a model
 * cannot pull entire conversations into one turn.
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
      'Search earlier Maka sessions when the user refers to previous conversations or work. Returns only bounded, redacted matches from other sessions. Call ReadHistory with a returned session_id and optional turn_id when more context is needed.',
    parameters: z
      .object({
        query: z
          .string()
          .trim()
          .min(1)
          .max(SEARCH_QUERY_MAX_CHARS)
          .describe('Text to find in earlier session titles or visible transcript content.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SEARCH_MAX_LIMIT)
          .optional()
          .describe(`Maximum matches; defaults to ${SEARCH_DEFAULT_LIMIT}.`),
      })
      .strict(),
    impl: async ({ query, limit }, context) => {
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
        { source: 'thread', query: normalizedQuery.value, limit: normalizedLimit.value },
        {
          ...deps,
          listSessions: async () => {
            sessions = await deps.listSessions();
            return sessions;
          },
        },
        {
          activeSessionId: context.sessionId,
          excludeSessionIds: new Set([context.sessionId]),
        },
      );
      if (!Array.isArray(result)) return historySearchError(result);
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
        rows: result.flatMap((row) => {
          if (row.target?.kind !== 'thread') return [];
          const session = sessionById.get(row.target.sessionId);
          return [
            {
              session_id: row.target.sessionId,
              ...(row.target.turnId ? { turn_id: row.target.turnId } : {}),
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
      'Read a small, redacted excerpt from an earlier Maka session returned by SearchHistory. If turn_id is omitted, reads the most recent visible turns. This cannot read the current session or hidden reasoning, permission records, or raw tool arguments/results.',
    parameters: z
      .object({
        session_id: z.string().trim().min(1).max(256).describe('Session id from SearchHistory.'),
        turn_id: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .optional()
          .describe('Optional matching turn id from SearchHistory.'),
        max_turns: z
          .number()
          .int()
          .min(1)
          .max(HISTORY_READ_MAX_TURNS)
          .optional()
          .describe(`Maximum adjacent visible turns; defaults to ${HISTORY_READ_DEFAULT_TURNS}.`),
      })
      .strict(),
    impl: async ({ session_id: sessionId, turn_id: turnId, max_turns: maxTurns }, context) => {
      if (context.abortSignal.aborted) return historyError('aborted', 'History read was aborted.');
      if (sessionId === context.sessionId) {
        return historyError('current_session', 'ReadHistory only reads earlier sessions.');
      }

      const privacy = validateWorkspacePrivacyContext(await deps.getPrivacyContext());
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
      const session = sessions.find(
        (candidate) => candidate.id === sessionId && candidate.backend !== 'fake',
      );
      if (!session) {
        return historyError('session_not_found', 'The requested earlier session was not found.');
      }
      if (context.abortSignal.aborted) return historyError('aborted', 'History read was aborted.');

      const messages = await deps.readMessages(sessionId);
      if (!messages) {
        return historyError('session_not_found', 'The requested earlier session was not found.');
      }
      const turns = projectHistoryTurns(messages);
      if (turns.length === 0) {
        return historyError('empty_transcript', 'The requested session has no visible transcript.');
      }
      const selected = selectHistoryTurns(turns, turnId, maxTurns ?? HISTORY_READ_DEFAULT_TURNS);
      if (!selected) {
        return historyError('turn_not_found', 'The requested turn was not found in that session.');
      }
      const bounded = boundHistoryTurns(selected, HISTORY_READ_MAX_BYTES);
      return {
        kind: 'history_read' as const,
        session_id: session.id,
        title: redactSecrets(session.name),
        ...(session.lastMessageAt !== undefined ? { last_message_at: session.lastMessageAt } : {}),
        turns: bounded.turns.map((turn) => ({
          turn_id: turn.turnId,
          messages: turn.messages,
        })),
        ...(bounded.truncated || selected.length < turns.length ? { truncated: true } : {}),
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
        role: 'user',
        text: redactSecrets(message.displayText ?? message.text),
        timestamp: message.ts,
      };
    case 'assistant':
      if (!message.text.trim()) return undefined;
      return { role: 'assistant', text: redactSecrets(message.text), timestamp: message.ts };
    case 'tool_call':
      if (!message.intent?.trim()) return undefined;
      return { role: 'tool', text: redactSecrets(message.intent), timestamp: message.ts };
    case 'tool_result':
    case 'permission_decision':
    case 'token_usage':
    case 'turn_state':
    case 'system_note':
      return undefined;
  }
}

function selectHistoryTurns(
  turns: readonly HistoryTurn[],
  turnId: string | undefined,
  maxTurns: number,
): HistoryTurn[] | undefined {
  if (!turnId) return turns.slice(-maxTurns);
  const target = turns.findIndex((turn) => turn.turnId === turnId);
  if (target < 0) return undefined;
  let start = Math.max(0, target - Math.floor((maxTurns - 1) / 2));
  let end = Math.min(turns.length, start + maxTurns);
  start = Math.max(0, end - maxTurns);
  return turns.slice(start, end);
}

function boundHistoryTurns(
  turns: readonly HistoryTurn[],
  maxBytes: number,
): { turns: HistoryTurn[]; truncated: boolean } {
  const bounded: HistoryTurn[] = [];
  let remaining = maxBytes;
  let truncated = false;
  for (const turn of turns) {
    const messages: HistoryTurnMessage[] = [];
    for (const message of turn.messages) {
      const overhead = Buffer.byteLength(JSON.stringify({ ...message, text: '' }), 'utf8');
      if (remaining <= overhead) {
        truncated = true;
        break;
      }
      const messageBudget = Math.min(remaining - overhead, HISTORY_READ_MAX_MESSAGE_BYTES);
      const text = truncateUtf8(message.text, messageBudget);
      const bytes = overhead + Buffer.byteLength(text, 'utf8');
      messages.push({ ...message, text });
      remaining -= bytes;
      if (text !== message.text) truncated = true;
    }
    if (messages.length > 0) bounded.push({ turnId: turn.turnId, messages });
    if (truncated) break;
  }
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
