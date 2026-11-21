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

import { isLinkedSubagentSession, type SessionSummary } from '@maka/core/session';
import { isSideConversationSession } from '@maka/core/side-conversation';
import {
  projectSessionCatalogSummary,
  readRuntimeHostSessionCatalogPage,
  readRuntimeHostSessions,
  RuntimeHostSessionCatalogRevisionChangedError,
  type RuntimeHostSessionCatalogPageCursor,
} from '@maka/runtime-host/client';
import type { SessionCatalogItem } from '@maka/runtime-host/protocol';
import { connectRuntimeHostCliConnection } from './runtime-host-cli-context.js';

// Restarts after the catalog revision moved under a paged read. Matches the retry policy of
// `readRuntimeHostSessions`, so `--limit` gives up on a busy Host no sooner than a full read.
const MAX_BOUNDED_READ_ATTEMPTS = 8;
const BOUNDED_READ_RETRY_BASE_DELAY_MS = 8;
const BOUNDED_READ_RETRY_MAX_DELAY_MS = 64;

export interface MakaSessionListCliOptions {
  readonly hostProfileId?: string;
  readonly includeArchived: boolean;
  readonly json: boolean;
  readonly limit?: number;
}

export type ParseMakaSessionListArgsResult =
  | { readonly kind: 'list'; readonly options: MakaSessionListCliOptions }
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string };

export interface MakaSessionListDeps {
  /** Returns listable Sessions in Host order, at most `query.limit` of them. */
  listSessions(
    hostProfileId: string | undefined,
    query: MakaSessionListQuery,
  ): Promise<SessionSummary[]>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export type MakaSessionListQuery = Pick<MakaSessionListCliOptions, 'includeArchived' | 'limit'>;

export interface MakaSessionListRow {
  readonly id: string;
  readonly name: string;
  readonly status: SessionSummary['status'];
  readonly cwd: string | null;
  readonly model: string;
  readonly archived: boolean;
  readonly activityAt: number | null;
}

export function parseMakaSessionListArgs(argv: readonly string[]): ParseMakaSessionListArgsResult {
  let hostProfileId: string | undefined;
  let limit: number | undefined;
  let includeArchived = false;
  let json = false;
  const seen = new Set<string>();
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith('--') && seen.has(arg)) {
      return { kind: 'error', message: `option repeated: ${arg}` };
    }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--archived') includeArchived = true;
    else if (arg === '--host' || arg === '--limit') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { kind: 'error', message: `option ${arg} needs a value` };
      }
      index += 1;
      if (arg === '--host') {
        if (value === '') return { kind: 'error', message: '--host needs a non-empty profile id' };
        hostProfileId = value;
      } else {
        limit = Number(value);
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(limit)) {
          return { kind: 'error', message: '--limit must be a positive integer' };
        }
      }
    } else return { kind: 'error', message: `unknown option: ${arg}` };
  }
  return {
    kind: 'list',
    options: {
      includeArchived,
      json,
      ...(hostProfileId ? { hostProfileId } : {}),
      ...(limit ? { limit } : {}),
    },
  };
}

export function sessionListHelpText(cliCommand: string): string {
  return [
    `Usage: ${cliCommand} session-list [options]`,
    '',
    'Lists Sessions on the local or a remote Runtime Host, newest first.',
    'Subagent and side-conversation Sessions are not listed.',
    '',
    'Options:',
    '  --host <profile-id>   List Sessions on a saved Runtime Host profile',
    '  --archived            Include archived Sessions',
    '  --limit <n>           Show at most n Sessions',
    '  --json                Emit one JSON object per line; activityAt is epoch milliseconds',
  ].join('\n');
}

export async function runMakaSessionListCli(
  argv: readonly string[],
  deps: MakaSessionListDeps,
  cliCommand = 'maka',
): Promise<number> {
  const parsed = parseMakaSessionListArgs(argv);
  if (parsed.kind === 'help') {
    deps.writeStdout(`${sessionListHelpText(cliCommand)}\n`);
    return 0;
  }
  if (parsed.kind === 'error') {
    deps.writeStderr(`${parsed.message}\n`);
    return 2;
  }
  let sessions: SessionSummary[];
  try {
    sessions = await deps.listSessions(parsed.options.hostProfileId, parsed.options);
  } catch (error) {
    deps.writeStderr(`session-list failed: ${error instanceof Error ? error.message : error}\n`);
    return 1;
  }
  const rows = sessions.map(toListRow);
  deps.writeStdout(
    parsed.options.json
      ? rows.map((row) => `${JSON.stringify(row)}\n`).join('')
      : formatSessionListTable(rows),
  );
  return 0;
}

// The catalog is already ordered `activity_at DESC, session_id ASC`; rows keep that order.
export function isListableSession(session: SessionSummary, includeArchived: boolean): boolean {
  return (
    !isLinkedSubagentSession(session) &&
    !isSideConversationSession(session.labels) &&
    (includeArchived || !session.isArchived)
  );
}

function toListRow(session: SessionSummary): MakaSessionListRow {
  return {
    id: session.id,
    name: session.name,
    status: session.status,
    cwd: session.cwd ?? null,
    model: session.model,
    archived: session.isArchived,
    activityAt: finiteOrNull(session.activityAt ?? session.lastMessageAt),
  };
}

// A corrupt record must not surface a non-finite time to scripts.
function finiteOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}

function formatSessionListTable(rows: readonly MakaSessionListRow[]): string {
  if (rows.length === 0) return 'No sessions.\n';
  // Cells are single-line: a name or cwd with a newline or escape would
  // otherwise split a row for any line-oriented consumer.
  const lines = rows.map((row) =>
    [row.id, row.status, formatActivityTime(row.activityAt), row.cwd ?? '-', row.name].map((cell) =>
      cell.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' '),
    ),
  );
  const widths = [0, 1, 2, 3].map((column) =>
    lines.reduce((width, line) => Math.max(width, line[column]!.length), 0),
  );
  return `${lines
    .map((line) =>
      line.map((cell, column) => (column < 4 ? cell.padEnd(widths[column]!) : cell)).join('  '),
    )
    .join('\n')}\n`;
}

function formatActivityTime(activityAt: number | null): string {
  if (activityAt === null) return '-';
  const date = new Date(activityAt);
  return Number.isNaN(date.getTime()) ? '-' : date.toISOString();
}

export interface MakaSessionListConnectionDeps {
  connect: typeof connectRuntimeHostCliConnection;
  readSessions: typeof readRuntimeHostSessions;
  readPage: typeof readRuntimeHostSessionCatalogPage;
  sleep(ms: number): Promise<void>;
}

export async function runMakaSessionListCommand(
  argv: readonly string[],
  options: {
    readonly clientDataRoot: string;
    readonly workspaceRoot: string;
    readonly cliCommand: string;
  },
  connectionDeps: MakaSessionListConnectionDeps = {
    connect: connectRuntimeHostCliConnection,
    readSessions: readRuntimeHostSessions,
    readPage: readRuntimeHostSessionCatalogPage,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
  io: Pick<MakaSessionListDeps, 'writeStdout' | 'writeStderr'> = {
    writeStdout: (text) => void process.stdout.write(text),
    writeStderr: (text) => void process.stderr.write(text),
  },
): Promise<number> {
  return runMakaSessionListCli(
    argv,
    {
      ...io,
      listSessions: async (hostProfileId, query) => {
        const context = await connectionDeps.connect({
          rootPath: options.workspaceRoot,
          clientDataRoot: options.clientDataRoot,
          ...(hostProfileId ? { profileId: hostProfileId } : {}),
        });
        try {
          const { sessions, unsupported } = await readListableSessions(
            context.connection,
            connectionDeps,
            query,
          );
          if (unsupported > 0) {
            io.writeStderr(`${unsupported} session(s) in an unsupported format were not listed\n`);
          }
          return sessions;
        } finally {
          await context.close().catch(() => undefined);
        }
      },
    },
    options.cliCommand,
  );
}

// Without a limit the whole catalog is read. With one, pages are read in Host order only until
// enough Sessions pass the filter, so `--limit 5` does not page through a large history.
async function readListableSessions(
  connection: Parameters<MakaSessionListConnectionDeps['readSessions']>[0],
  deps: MakaSessionListConnectionDeps,
  query: MakaSessionListQuery,
): Promise<{ sessions: SessionSummary[]; unsupported: number }> {
  const sessions: SessionSummary[] = [];
  let unsupported = 0;
  // Returns true once `query.limit` Sessions are collected.
  const take = (items: readonly SessionCatalogItem[]): boolean => {
    for (const item of items) {
      if ('kind' in item) {
        unsupported += 1;
        continue;
      }
      const session = projectSessionCatalogSummary(item);
      if (!isListableSession(session, query.includeArchived)) continue;
      sessions.push(session);
      if (sessions.length === query.limit) return true;
    }
    return false;
  };

  if (query.limit === undefined) {
    take(await deps.readSessions(connection));
    return { sessions, unsupported };
  }
  for (let attempt = 1; ; attempt += 1) {
    sessions.length = 0;
    unsupported = 0;
    try {
      const cursors = new Set<string>();
      let cursor: RuntimeHostSessionCatalogPageCursor | null = null;
      do {
        const page = await deps.readPage(connection, cursor ?? undefined);
        if (take(page.sessions)) break;
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor.cursor)) {
          throw new Error('Runtime Host Session catalog returned a repeated cursor');
        }
        if (cursor) cursors.add(cursor.cursor);
      } while (cursor);
      return { sessions, unsupported };
    } catch (error) {
      const revisionMoved = error instanceof RuntimeHostSessionCatalogRevisionChangedError;
      if (!revisionMoved || attempt >= MAX_BOUNDED_READ_ATTEMPTS) throw error;
    }
    await deps.sleep(
      Math.min(
        BOUNDED_READ_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
        BOUNDED_READ_RETRY_MAX_DELAY_MS,
      ),
    );
  }
}
