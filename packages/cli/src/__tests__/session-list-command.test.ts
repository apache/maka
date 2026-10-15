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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionSummary } from '@maka/core/session';
import type { RuntimeHostConnection } from '@maka/runtime-host/client';
import type { SessionCatalogProjection } from '@maka/runtime-host/protocol';
import { parseMakaCliArgs } from '../cli-core.js';
import {
  parseMakaSessionListArgs,
  runMakaSessionListCli,
  runMakaSessionListCommand,
  selectSessionListRows,
  type MakaSessionListConnectionDeps,
} from '../session-list-command.js';

describe('maka session-list argument parsing', () => {
  test('defaults to a human table of unarchived sessions', () => {
    assert.deepEqual(parseMakaSessionListArgs([]), {
      kind: 'list',
      options: { includeArchived: false, json: false },
    });
  });

  test('parses host, limit, archived and json', () => {
    assert.deepEqual(
      parseMakaSessionListArgs(['--host', 'office', '--limit', '5', '--archived', '--json']),
      {
        kind: 'list',
        options: { hostProfileId: 'office', limit: 5, includeArchived: true, json: true },
      },
    );
  });

  test('shows help even when other arguments are invalid', () => {
    assert.deepEqual(parseMakaSessionListArgs(['--bogus', '--help']), { kind: 'help' });
    assert.deepEqual(parseMakaSessionListArgs(['--json', '--json', '-h']), { kind: 'help' });
  });

  test('rejects unknown options, missing values and bad limits', () => {
    assert.equal(parseMakaSessionListArgs(['--nope']).kind, 'error');
    assert.equal(parseMakaSessionListArgs(['--host']).kind, 'error');
    assert.equal(parseMakaSessionListArgs(['--host', '--json']).kind, 'error');
    assert.equal(parseMakaSessionListArgs(['--limit', '0']).kind, 'error');
    assert.equal(parseMakaSessionListArgs(['--limit', '1.5']).kind, 'error');
    assert.equal(parseMakaSessionListArgs(['--limit', '0x10']).kind, 'error');
    assert.equal(parseMakaSessionListArgs(['--limit', '1e1']).kind, 'error');
    assert.equal(parseMakaSessionListArgs(['--limit', ' 5']).kind, 'error');
    assert.equal(parseMakaSessionListArgs(['--host', '']).kind, 'error');
    assert.equal(parseMakaSessionListArgs(['--json', '--json']).kind, 'error');
    assert.equal(parseMakaSessionListArgs(['--host', 'a', '--host', 'b']).kind, 'error');
  });
});

describe('maka session-list selection', () => {
  test('orders by recency, hides archived and subagent sessions, applies the limit', () => {
    const rows = selectSessionListRows(
      [
        session({ id: 'old', lastMessageAt: 10 }),
        session({ id: 'new', activityAt: 300, lastMessageAt: 20 }),
        session({ id: 'archived', isArchived: true, lastMessageAt: 400 }),
        session({
          id: 'child',
          lastMessageAt: 500,
          subagentParent: {
            kind: 'subagent',
            parentSessionId: 'new',
            spawnedBy: { parentRunId: 'run-1', parentTurnId: 'turn-1', toolCallId: 'call-1' },
            lifecycle: 'foreground',
          },
        }),
        session({ id: 'mid', lastMessageAt: 100 }),
      ],
      { includeArchived: false },
    );
    assert.deepEqual(
      rows.map((row) => row.id),
      ['new', 'mid', 'old'],
    );
    assert.deepEqual(
      selectSessionListRows([session({ id: 'a' }), session({ id: 'b' })], {
        includeArchived: false,
        limit: 1,
      }).map((row) => row.id),
      ['a'],
    );
  });

  test('includes archived sessions on request', () => {
    const rows = selectSessionListRows([session({ id: 'x', isArchived: true })], {
      includeArchived: true,
    });
    assert.equal(rows[0]?.archived, true);
  });
});

describe('maka session-list command', () => {
  test('emits one JSON object per line and forwards the host profile', async () => {
    const out: string[] = [];
    let requestedHost: string | undefined;
    const code = await runMakaSessionListCli(['--json', '--host', 'office'], {
      listSessions: async (host) => {
        requestedHost = host;
        return [session({ id: 's1', cwd: '/repo' })];
      },
      writeStdout: (text) => void out.push(text),
      writeStderr: () => undefined,
    });
    assert.equal(code, 0);
    assert.equal(requestedHost, 'office');
    const lines = out.join('').trimEnd().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!).id, 's1');
  });

  test('prints a placeholder for an empty list and exits 2 on bad arguments', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const deps = {
      listSessions: async () => [],
      writeStdout: (text: string) => void out.push(text),
      writeStderr: (text: string) => void err.push(text),
    };
    assert.equal(await runMakaSessionListCli([], deps), 0);
    assert.equal(out.join(''), 'No sessions.\n');
    assert.equal(await runMakaSessionListCli(['--bad'], deps), 2);
    assert.match(err.join(''), /unknown option: --bad/);
  });
});

describe('maka session-list dispatch', () => {
  test('routes to the command and is listed in the root help', () => {
    assert.deepEqual(parseMakaCliArgs(['session-list', '--json'], '0.1.0'), {
      kind: 'session-list',
      args: ['--json'],
    });
    const help = parseMakaCliArgs(['--help'], '0.1.0');
    assert.equal(help.kind, 'help');
    if (help.kind !== 'help') return;
    assert.match(help.text, /^ {2}maka session-list /m);
  });
});

describe('maka session-list ordering and rendering', () => {
  test('falls back from activityAt to lastMessageAt and sorts unknown times last', () => {
    const rows = selectSessionListRows(
      [
        session({ id: 'unknown', lastMessageAt: undefined }),
        session({ id: 'message', lastMessageAt: 50 }),
        session({ id: 'activity', activityAt: 90, lastMessageAt: 10 }),
      ],
      { includeArchived: false },
    );
    assert.deepEqual(
      rows.map((row) => [row.id, row.activityAt]),
      [
        ['activity', 90],
        ['message', 50],
        ['unknown', null],
      ],
    );
  });

  test('breaks recency ties by id', () => {
    const rows = selectSessionListRows(
      [session({ id: 'b', lastMessageAt: 1 }), session({ id: 'a', lastMessageAt: 1 })],
      { includeArchived: false },
    );
    assert.deepEqual(
      rows.map((row) => row.id),
      ['a', 'b'],
    );
  });

  test('renders aligned columns with placeholders for unknown time and cwd', async () => {
    const out: string[] = [];
    await runMakaSessionListCli([], {
      listSessions: async () => [
        session({ id: 'long-session-id', name: 'First', activityAt: 0, cwd: '/repo' }),
        session({ id: 's2', name: 'Second', lastMessageAt: undefined, cwd: undefined }),
      ],
      writeStdout: (text) => void out.push(text),
      writeStderr: () => undefined,
    });
    const lines = out.join('').trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.match(
      lines[0]!,
      /^long-session-id {2}active {2}1970-01-01T00:00:00\.000Z {2}\/repo {2}First$/,
    );
    assert.match(lines[1]!, /^s2 +active +- +- +Second$/);
    // Columns start at the same offset in both rows.
    assert.equal(lines[1]!.indexOf('active'), lines[0]!.indexOf('active'));
    assert.equal(lines[1]!.indexOf('Second'), lines[0]!.indexOf('First'));
  });

  test('prints help to stdout with exit 0', async () => {
    const out: string[] = [];
    const code = await runMakaSessionListCli(
      ['--help'],
      {
        listSessions: async () => assert.fail('help must not contact a Host'),
        writeStdout: (text) => void out.push(text),
        writeStderr: () => undefined,
      },
      'npm run cli:dev --',
    );
    assert.equal(code, 0);
    assert.match(out.join(''), /^Usage: npm run cli:dev -- session-list \[options\]/);
  });
});

describe('maka session-list failure handling', () => {
  test('reports a failing Host as a one-line error with exit 1', async () => {
    const err: string[] = [];
    const code = await runMakaSessionListCli(['--host', 'typo'], {
      listSessions: async () => {
        throw new Error('unknown host profile: typo');
      },
      writeStdout: () => assert.fail('nothing should be printed'),
      writeStderr: (text) => void err.push(text),
    });
    assert.equal(code, 1);
    assert.equal(err.join(''), 'session-list failed: unknown host profile: typo\n');
  });

  test('keeps rows single-line and survives an invalid timestamp', async () => {
    const out: string[] = [];
    await runMakaSessionListCli([], {
      listSessions: async () => [
        session({ id: 'a', name: 'two\nlines\u001b[31m', activityAt: Number.NaN }),
        session({ id: 'b', activityAt: 8.64e15 + 1 }),
      ],
      writeStdout: (text) => void out.push(text),
      writeStderr: () => undefined,
    });
    const lines = out.join('').trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.doesNotMatch(out.join(''), /\u001b/);
    // `b` has a finite but out-of-range time, so it sorts ahead of the NaN row `a`;
    // both are unusable as dates and render as the placeholder.
    assert.match(lines[0]!, /^b +active +- /);
    assert.match(lines[1]!, /^a +active +- /);
    assert.match(lines[1]!, /two lines /);
  });

  test('sorts a non-finite timestamp last instead of corrupting the order', () => {
    const rows = selectSessionListRows(
      [
        session({ id: 'nan', activityAt: Number.NaN, lastMessageAt: undefined }),
        session({ id: 'new', lastMessageAt: 300 }),
        session({ id: 'inf', activityAt: Number.POSITIVE_INFINITY }),
        session({ id: 'old', lastMessageAt: 100 }),
      ],
      { includeArchived: false, limit: 2 },
    );
    assert.deepEqual(
      rows.map((row) => row.id),
      ['new', 'old'],
    );
  });
});

describe('maka session-list Runtime Host connection', () => {
  test('connects to the selected profile, drops non-session rows and closes the connection', async () => {
    const calls: string[] = [];
    const out: string[] = [];
    const warnings: string[] = [];
    const deps = {
      connect: async (input: { profileId?: string; rootPath: string }) => {
        calls.push(`connect:${input.profileId ?? 'local'}:${input.rootPath}`);
        return {
          connection: {} as RuntimeHostConnection,
          close: async () => void calls.push('close'),
        };
      },
      readSessions: async () => [
        projection({ id: 'visible' }),
        {
          kind: 'unsupported_legacy_record',
          id: 'legacy',
          revision: 1,
          reason: 'not_wire_representable',
        },
      ],
    } as unknown as MakaSessionListConnectionDeps;

    const code = await runMakaSessionListCommand(
      ['--json', '--host', 'office'],
      { clientDataRoot: '/client', workspaceRoot: '/workspace', cliCommand: 'maka' },
      deps,
      {
        writeStdout: (text) => void out.push(text),
        writeStderr: (text) => void warnings.push(text),
      },
    );

    assert.equal(code, 0);
    assert.deepEqual(calls, ['connect:office:/workspace', 'close']);
    assert.deepEqual(warnings, ['1 session(s) in an unsupported format were not listed\n']);
    assert.deepEqual(
      out
        .join('')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line).id),
      ['visible'],
    );
  });

  test('closes the connection when reading sessions fails', async () => {
    let closed = false;
    const deps = {
      connect: async () => ({
        connection: {} as RuntimeHostConnection,
        close: async () => void (closed = true),
      }),
      readSessions: async () => {
        throw new Error('host unavailable');
      },
    } as unknown as MakaSessionListConnectionDeps;

    const err: string[] = [];
    const code = await runMakaSessionListCommand(
      [],
      { clientDataRoot: '/client', workspaceRoot: '/workspace', cliCommand: 'maka' },
      deps,
      { writeStdout: () => undefined, writeStderr: (text) => void err.push(text) },
    );
    assert.equal(code, 1);
    assert.match(err.join(''), /session-list failed: host unavailable/);
    assert.equal(closed, true);
  });
});

function projection(overrides: Partial<SessionCatalogProjection> = {}): SessionCatalogProjection {
  return {
    id: 'session-1',
    revision: 1,
    workspace: { target: { kind: 'host_path', path: '/workspace' }, hostCwd: '/workspace' },
    createdAt: 1,
    activityAt: 2,
    name: 'Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionId: 'connection-1',
    llmConnectionSlug: 'openai-main',
    connectionLocked: true,
    model: 'gpt-5',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    ...overrides,
  };
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    cwd: '/repo',
    name: 'Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    lastMessageAt: 100,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'fixture',
    connectionLocked: false,
    model: 'fixture-model',
    permissionMode: 'explore',
    ...overrides,
  };
}
