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
import {
  RuntimeHostSessionCatalogRevisionChangedError,
  type RuntimeHostConnection,
  type RuntimeHostSessionCatalogPage,
} from '@maka/runtime-host/client';
import type { SessionCatalogProjection } from '@maka/runtime-host/protocol';
import { parseMakaCliArgs } from '../cli-core.js';
import {
  parseMakaSessionListArgs,
  runMakaSessionListCli,
  runMakaSessionListCommand,
  isListableSession,
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

describe('maka session-list filtering', () => {
  test('hides archived Sessions unless asked', () => {
    const archived = session({ isArchived: true });
    assert.equal(isListableSession(archived, false), false);
    assert.equal(isListableSession(archived, true), true);
  });

  test('hides linked subagent Sessions in both the Host and the legacy shape', () => {
    assert.equal(
      isListableSession(session({ subagent: { parentSessionId: 'parent' } }), true),
      false,
    );
    assert.equal(
      isListableSession(
        session({
          subagentParent: {
            kind: 'subagent',
            parentSessionId: 'parent',
            spawnedBy: { parentRunId: 'run-1', parentTurnId: 'turn-1', toolCallId: 'call-1' },
            lifecycle: 'foreground',
          },
        }),
        true,
      ),
      false,
    );
    assert.equal(isListableSession(session(), true), true);
  });

  test('hides side-conversation Sessions like the TUI does', () => {
    assert.equal(isListableSession(session({ labels: ['mode:side_conversation'] }), true), false);
    assert.equal(isListableSession(session({ labels: ['other'] }), true), true);
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
  test('keeps the Host order instead of re-sorting', async () => {
    const out: string[] = [];
    await runMakaSessionListCli(['--json'], {
      listSessions: async () => [
        session({ id: 'b', lastMessageAt: 1 }),
        session({ id: 'a', lastMessageAt: 9 }),
      ],
      writeStdout: (text) => void out.push(text),
      writeStderr: () => undefined,
    });
    assert.deepEqual(
      out
        .join('')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line).id),
      ['b', 'a'],
    );
  });

  test('reports activityAt, falling back to lastMessageAt, and null when unknown', async () => {
    const out: string[] = [];
    await runMakaSessionListCli(['--json'], {
      listSessions: async () => [
        session({ id: 'activity', activityAt: 90, lastMessageAt: 10 }),
        session({ id: 'message', lastMessageAt: 50 }),
        session({ id: 'unknown', lastMessageAt: undefined }),
        session({ id: 'nan', activityAt: Number.NaN, lastMessageAt: undefined }),
      ],
      writeStdout: (text) => void out.push(text),
      writeStderr: () => undefined,
    });
    assert.deepEqual(
      out
        .join('')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line).activityAt),
      [90, 50, null, null],
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
    // Both times are unusable as dates and render as the placeholder.
    assert.match(lines[0]!, /^a +active +- /);
    assert.match(lines[0]!, /two lines /);
    assert.match(lines[1]!, /^b +active +- /);
  });
});

describe('maka session-list Runtime Host connection', () => {
  const paths = { clientDataRoot: '/client', workspaceRoot: '/workspace', cliCommand: 'maka' };

  test('connects to the selected profile, drops non-session rows and closes the connection', async () => {
    const host = fakeHost({
      pages: [
        [
          projection({ id: 'visible' }),
          {
            kind: 'unsupported_legacy_record',
            id: 'legacy',
            revision: 1,
            reason: 'not_wire_representable',
          },
        ],
      ],
    });

    const code = await runMakaSessionListCommand(
      ['--json', '--host', 'office'],
      paths,
      host.deps,
      host.io,
    );

    assert.equal(code, 0);
    assert.deepEqual(host.calls, ['connect:office:/workspace', 'close']);
    assert.deepEqual(host.stderr, ['1 session(s) in an unsupported format were not listed\n']);
    assert.deepEqual(host.listedIds(), ['visible']);
  });

  test('hides subagent children as the Host actually projects them', async () => {
    const host = fakeHost({
      pages: [
        [
          projection({ id: 'parent' }),
          projection({ id: 'child', subagent: { parentSessionId: 'parent' } }),
          projection({ id: 'side', labels: ['mode:side_conversation'] }),
          projection({ id: 'archived', isArchived: true }),
        ],
      ],
    });
    assert.equal(await runMakaSessionListCommand(['--json'], paths, host.deps, host.io), 0);
    assert.deepEqual(host.listedIds(), ['parent']);
    assert.equal(host.pagesRead, 0, 'without a limit the stable full reader is used');
  });

  test('with --limit, stops reading pages once enough Sessions pass the filter', async () => {
    const host = fakeHost({
      pages: [
        [
          projection({ id: 's1' }),
          projection({ id: 'archived', isArchived: true }),
          projection({ id: 'child', subagent: { parentSessionId: 's1' } }),
        ],
        [projection({ id: 's2' }), projection({ id: 's3' })],
        [projection({ id: 's4' })],
      ],
    });
    assert.equal(
      await runMakaSessionListCommand(['--json', '--limit', '2'], paths, host.deps, host.io),
      0,
    );
    assert.deepEqual(host.listedIds(), ['s1', 's2']);
    assert.equal(host.pagesRead, 2, 'the third page is never requested');
  });

  test('with --limit, keeps paging past pages that are filtered out entirely', async () => {
    const host = fakeHost({
      pages: [
        [projection({ id: 'a1', isArchived: true })],
        [projection({ id: 'a2', isArchived: true })],
        [projection({ id: 'keep' })],
      ],
    });
    await runMakaSessionListCommand(['--json', '--limit', '1'], paths, host.deps, host.io);
    assert.deepEqual(host.listedIds(), ['keep']);
    assert.equal(host.pagesRead, 3);
  });

  test('with --limit, includes archived Sessions on request', async () => {
    const host = fakeHost({ pages: [[projection({ id: 'a', isArchived: true })]] });
    await runMakaSessionListCommand(
      ['--json', '--archived', '--limit', '1'],
      paths,
      host.deps,
      host.io,
    );
    assert.deepEqual(host.listedIds(), ['a']);
  });

  test('with --limit, restarts with backoff as often as the full reader does', async () => {
    const host = fakeHost({
      pages: [[projection({ id: 'one' })], [projection({ id: 'two' })]],
      revisionChangesBeforeSuccess: 7,
    });
    assert.equal(
      await runMakaSessionListCommand(['--json', '--limit', '2'], paths, host.deps, host.io),
      0,
    );
    assert.deepEqual(host.listedIds(), ['one', 'two']);
    assert.deepEqual(host.delays, [8, 16, 32, 64, 64, 64, 64]);
  });

  test('with --limit, gives up after 8 attempts when the revision keeps moving', async () => {
    const host = fakeHost({
      pages: [[projection({ id: 'one' })]],
      revisionChangesBeforeSuccess: 99,
    });
    assert.equal(
      await runMakaSessionListCommand(['--json', '--limit', '2'], paths, host.deps, host.io),
      1,
    );
    assert.match(host.stderr.join(''), /session-list failed: .*revision changed/);
    assert.equal(host.revisionChangesSeen, 8);
    assert.equal(host.delays.length, 7, 'no wait after the last attempt');
    assert.deepEqual(host.calls.at(-1), 'close');
  });

  test('with --limit, rejects a catalog that loops on a cursor', async () => {
    const host = fakeHost({ pages: [[projection({ id: 'one' })]], loopCursor: true });
    assert.equal(
      await runMakaSessionListCommand(['--json', '--limit', '5'], paths, host.deps, host.io),
      1,
    );
    assert.match(host.stderr.join(''), /repeated cursor/);
  });

  test('closes the connection when reading sessions fails', async () => {
    const host = fakeHost({ pages: [], readFailure: new Error('host unavailable') });
    const code = await runMakaSessionListCommand([], paths, host.deps, host.io);
    assert.equal(code, 1);
    assert.match(host.stderr.join(''), /session-list failed: host unavailable/);
    assert.equal(host.calls.at(-1), 'close');
  });
});

type FakeCatalogItem = Awaited<ReturnType<MakaSessionListConnectionDeps['readSessions']>>[number];

function fakeHost(config: {
  readonly pages: readonly (readonly FakeCatalogItem[])[];
  readonly revisionChangesBeforeSuccess?: number;
  readonly loopCursor?: boolean;
  readonly readFailure?: Error;
}) {
  const calls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const delays: number[] = [];
  let revisionChanges = config.revisionChangesBeforeSuccess ?? 0;
  const state = { pagesRead: 0, revisionChangesSeen: 0 };
  const deps = {
    connect: async (input: { profileId?: string; rootPath: string }) => {
      calls.push(`connect:${input.profileId ?? 'local'}:${input.rootPath}`);
      return {
        connection: {} as RuntimeHostConnection,
        close: async () => void calls.push('close'),
      };
    },
    readSessions: async () => {
      if (config.readFailure) throw config.readFailure;
      return config.pages.flat();
    },
    readPage: async (
      _connection: RuntimeHostConnection,
      cursor?: { readonly cursor: string },
    ): Promise<RuntimeHostSessionCatalogPage> => {
      if (config.readFailure) throw config.readFailure;
      if (revisionChanges > 0) {
        revisionChanges -= 1;
        state.revisionChangesSeen += 1;
        throw new RuntimeHostSessionCatalogRevisionChangedError('sha256:old', 'sha256:new');
      }
      state.pagesRead += 1;
      const index = cursor ? Number(cursor.cursor) : 0;
      const next = config.loopCursor ? 0 : index + 1;
      return {
        revision: 'sha256:rev',
        sessions: config.pages[index] ?? [],
        nextCursor:
          config.loopCursor || next < config.pages.length
            ? { revision: 'sha256:rev', cursor: String(next) }
            : null,
      };
    },
    sleep: async (ms: number) => void delays.push(ms),
  } as unknown as MakaSessionListConnectionDeps;
  return {
    deps,
    calls,
    stderr,
    delays,
    get pagesRead() {
      return state.pagesRead;
    },
    get revisionChangesSeen() {
      return state.revisionChangesSeen;
    },
    io: {
      writeStdout: (text: string) => void stdout.push(text),
      writeStderr: (text: string) => void stderr.push(text),
    },
    listedIds: () =>
      stdout
        .join('')
        .trimEnd()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).id as string),
  };
}

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
