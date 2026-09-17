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
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ExternalSessionCatalogCursorError,
  ExternalSessionLimitError,
  ExternalSessionNotFoundError,
  type ExternalSessionQuery,
  type ExternalSessionSummary,
} from '@maka/core/external-session';
import { decodeCanonicalMessage } from '@maka/core/session';
import { CodexSessionAdapter } from '../codex-session-adapter.js';
import { createExternalSessionAdapterRegistry } from '../external-session-adapters.js';

const CURRENT_FIXTURE = fixturePath('codex-rollout-v0.144.jsonl');
const ITEM_COMPLETED_FIXTURE = fixturePath('codex-rollout-v0.149-item-completed.jsonl');

async function listSessions(
  adapter: CodexSessionAdapter,
  query: ExternalSessionQuery = {},
): Promise<readonly ExternalSessionSummary[]> {
  const { offset = 0, limit = Number.MAX_SAFE_INTEGER, ...filters } = query;
  const summaries: ExternalSessionSummary[] = [];
  let cursor: string | undefined;
  while (summaries.length < offset + limit) {
    const page = await adapter.listSessionPage({ ...filters, cursor, limit: 256 });
    summaries.push(...page.items.map(({ summary }) => summary));
    if (!page.hasMore || page.items.length === 0) break;
    cursor = page.items.at(-1)!.nextCursor;
  }
  return summaries.slice(offset, offset + limit);
}

describe('CodexSessionAdapter', () => {
  test('lists active and archived root Sessions from the newest Codex state database', async () => {
    await withCodexHome(async (codexHome) => {
      const activePath = await seedFixtureRollout(codexHome, 'codex-session-1', false);
      const archivedPath = await seedMinimalRollout(
        codexHome,
        'codex-session-archived',
        true,
        '/workspace/archive',
        'Archived task',
      );
      await seedStateDatabase(codexHome, [
        {
          id: 'codex-session-1',
          rolloutPath: activePath,
          cwd: '/workspace/project',
          name: 'Named Codex thread',
          createdAtMs: 1000,
          updatedAtMs: 3000,
          archived: false,
          source: 'cli',
        },
        {
          id: 'codex-session-archived',
          rolloutPath: archivedPath,
          cwd: '/workspace/archive',
          name: 'Archived Codex thread',
          createdAtMs: 1500,
          updatedAtMs: 2000,
          archived: true,
          source: 'vscode',
        },
        {
          id: 'codex-subagent',
          rolloutPath: activePath,
          cwd: '/workspace/project',
          name: 'Internal child',
          createdAtMs: 2000,
          updatedAtMs: 4000,
          archived: false,
          source: '{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}',
        },
      ]);

      const adapter = new CodexSessionAdapter({ codexHome });
      assert.equal(await adapter.detect(), true);
      assert.deepEqual(await listSessions(adapter), [
        {
          id: 'codex-session-1',
          name: 'Named Codex thread',
          cwd: '/workspace/project',
          createdAt: 1_000_000,
          updatedAt: 3_000_000,
          archived: false,
        },
      ]);
      assert.deepEqual(
        (await listSessions(adapter, { includeArchived: true })).map((session) => session.id),
        ['codex-session-1', 'codex-session-archived'],
      );
      assert.deepEqual(
        (await listSessions(adapter, { includeArchived: true, offset: 0, limit: 1 })).map(
          (session) => session.id,
        ),
        ['codex-session-1'],
      );
      assert.deepEqual(
        (await listSessions(adapter, { includeArchived: true, offset: 1, limit: 1 })).map(
          (session) => session.id,
        ),
        ['codex-session-archived'],
      );

      // The same text query the Claude Code adapter honours. A catalog filter
      // that silently worked for one source and not the other would be worse
      // than none — the user cannot see which source dropped their term.
      assert.deepEqual(
        (await listSessions(adapter, { text: 'named' })).map((session) => session.id),
        ['codex-session-1'],
      );
      assert.deepEqual(
        (await listSessions(adapter, { text: '/workspace/project' })).map((session) => session.id),
        ['codex-session-1'],
      );
      assert.equal((await listSessions(adapter, { text: 'kubernetes' })).length, 0);
      // A blank box selects nothing, so it must not filter.
      assert.equal((await listSessions(adapter, { text: '  ' })).length, 1);
      // Text does not override the archived gate.
      assert.equal((await listSessions(adapter, { text: 'archived' })).length, 0);
      assert.deepEqual(
        (await listSessions(adapter, { includeArchived: true, text: 'archived' })).map(
          (session) => session.id,
        ),
        ['codex-session-archived'],
      );
      assert.deepEqual(
        await listSessions(adapter, { includeArchived: true, cwd: '/workspace/archive/' }),
        [
          {
            id: 'codex-session-archived',
            name: 'Archived Codex thread',
            cwd: '/workspace/archive',
            createdAt: 1_500_000,
            updatedAt: 2_000_000,
            archived: true,
          },
        ],
      );
    });
  });

  test('orders mixed Codex second and millisecond timestamps before paging', async () => {
    await withCodexHome(async (codexHome) => {
      const olderPath = await seedMinimalRollout(
        codexHome,
        'codex-older-ms',
        false,
        '/workspace',
        'Older milliseconds',
      );
      const newerPath = await seedMinimalRollout(
        codexHome,
        'codex-newer-seconds',
        false,
        '/workspace',
        'Newer seconds',
      );
      const newestPath = await seedMinimalRollout(
        codexHome,
        'codex-newest-ms-in-legacy-column',
        false,
        '/workspace',
        'Newest milliseconds in legacy column',
      );
      await seedStateDatabase(codexHome, [
        {
          id: 'codex-older-ms',
          rolloutPath: olderPath,
          cwd: '/workspace',
          name: 'Older milliseconds',
          createdAtMs: 1_700_000_000_000,
          updatedAtMs: 1_700_000_000_000,
          archived: false,
          source: 'cli',
        },
        {
          id: 'codex-newer-seconds',
          rolloutPath: newerPath,
          cwd: '/workspace',
          name: 'Newer seconds',
          createdAt: 1_800_000_000,
          updatedAt: 1_800_000_000,
          archived: false,
          source: 'cli',
        },
        {
          id: 'codex-newest-ms-in-legacy-column',
          rolloutPath: newestPath,
          cwd: '/workspace',
          name: 'Newest milliseconds in legacy column',
          createdAt: 1_900_000_000_000,
          updatedAt: 1_900_000_000_000,
          archived: false,
          source: 'cli',
        },
      ]);

      assert.deepEqual(
        (await listSessions(new CodexSessionAdapter({ codexHome }), { limit: 1 })).map(
          (session) => session.id,
        ),
        ['codex-newest-ms-in-legacy-column'],
      );
    });
  });

  test('lists every supported Codex thread source (#3693)', async () => {
    // The adapter owned its own token set, so bare `atlas`/`chatgpt` and a
    // wrapped `{"custom":"cli"}` used to drift across readers. Catalog and
    // import now use the same source eligibility gate.
    // authority, so the catalog and the scan agree on every shape.
    await withCodexHome(async (codexHome) => {
      const sources = ['cli', 'exec', 'vscode', 'atlas', 'chatgpt'] as const;
      const rows: StateRow[] = [];
      for (const [index, source] of sources.entries()) {
        const bareId = `codex-bare-${source}`;
        const wrappedId = `codex-wrapped-${source}`;
        rows.push({
          id: bareId,
          rolloutPath: await seedMinimalRollout(codexHome, bareId, false, '/workspace', 'Task'),
          cwd: '/workspace',
          name: `bare ${source}`,
          createdAtMs: 1000 + index,
          updatedAtMs: 3000 + index,
          archived: false,
          source,
        });
        rows.push({
          id: wrappedId,
          rolloutPath: await seedMinimalRollout(codexHome, wrappedId, false, '/workspace', 'Task'),
          cwd: '/workspace',
          name: `wrapped ${source}`,
          createdAtMs: 1100 + index,
          updatedAtMs: 3100 + index,
          archived: false,
          source: JSON.stringify({ custom: source }),
        });
      }
      const subagentId = 'codex-subagent-drop';
      rows.push({
        id: subagentId,
        rolloutPath: await seedMinimalRollout(codexHome, subagentId, false, '/workspace', 'Task'),
        cwd: '/workspace',
        name: 'internal child',
        createdAtMs: 2000,
        updatedAtMs: 4000,
        archived: false,
        source: '{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}',
      });
      await seedStateDatabase(codexHome, rows);

      const listed = new Set(
        (await listSessions(new CodexSessionAdapter({ codexHome }))).map((session) => session.id),
      );
      for (const source of sources) {
        assert.ok(listed.has(`codex-bare-${source}`), `bare ${source} was dropped`);
        assert.ok(listed.has(`codex-wrapped-${source}`), `wrapped ${source} was dropped`);
      }
      // Internal subagent threads stay out of the catalog.
      assert.equal(listed.has(subagentId), false);
      assert.equal(listed.size, sources.length * 2);
    });
  });

  test('a Windows path spelling reaches the matcher instead of being lost in SQL', async () => {
    // The SQL used to prefilter with `cwd IN (<spelling variants>)`, and
    // SQLite compares those exactly — a row stored `C:\\Repo\\App` was
    // discarded before the shared matcher could see that `c:/repo/app` names
    // the same project. This drives the real state-database path, not the
    // matcher in isolation, because that is where the row was being dropped.
    await withCodexHome(async (codexHome) => {
      const rolloutPath = await seedMinimalRollout(
        codexHome,
        'codex-win',
        false,
        'C:\\Repo\\App',
        'hello',
      );
      await seedStateDatabase(codexHome, [
        {
          id: 'codex-win',
          rolloutPath,
          cwd: 'C:\\Repo\\App',
          name: 'Windows-shaped path',
          createdAtMs: 1_000,
          updatedAtMs: 2_000,
          archived: false,
          source: 'cli',
        },
      ]);
      const adapter = new CodexSessionAdapter({ codexHome });
      for (const cwd of ['C:\\Repo\\App', 'C:/Repo/App', 'c:/repo/app', 'c:\\repo\\app\\']) {
        assert.deepEqual(
          (await listSessions(adapter, { cwd })).map((session) => session.id),
          ['codex-win'],
          `cwd=${cwd}`,
        );
      }
      // A genuinely different project is still excluded.
      assert.equal((await listSessions(adapter, { cwd: 'C:/Repo/Other' })).length, 0);
    });
  });

  test('converts Codex presentation events and raw tool items without duplicates', async () => {
    await withCodexHome(async (codexHome) => {
      await seedFixtureRollout(codexHome, 'codex-session-1', false);
      const adapter = new CodexSessionAdapter({ codexHome });

      assert.deepEqual(await listSessions(adapter), [
        {
          id: 'codex-session-1',
          name: 'Fix the parser',
          cwd: '/workspace/project',
          createdAt: Date.parse('2026-08-08T00:00:00.000Z'),
          updatedAt: await rolloutMtime(codexHome, 'codex-session-1', false),
          archived: false,
        },
      ]);

      const session = await adapter.readSession('codex-session-1');
      assert.deepEqual(session.metadata, {
        name: 'Fix the parser',
        cwd: '/workspace/project',
      });
      assert.equal(session.messages.length, 9);
      for (const message of session.messages) {
        assert.deepEqual(decodeCanonicalMessage(message), message);
      }

      assert.deepEqual(session.messages[0], {
        type: 'user',
        id: 'codex-user-1',
        turnId: 'codex-turn-1',
        ts: Date.parse('2026-08-08T00:00:02.000Z'),
        text: 'Fix the parser',
      });
      assert.deepEqual(session.messages[1], {
        type: 'assistant',
        id: 'codex-codex-session-1-reasoning-7',
        turnId: 'codex-turn-1',
        ts: Date.parse('2026-08-08T00:00:03.000Z'),
        text: '',
        thinking: { text: 'Inspect the failing path.' },
        contentOrder: ['thinking'],
        modelId: 'gpt-codex-test',
      });
      assert.equal(session.messages[2]?.type, 'assistant');
      assert.equal(session.messages[2]?.text, 'I found the issue.');
      assert.deepEqual(
        session.messages[2]?.type === 'assistant' ? session.messages[2].providerOptions : undefined,
        { openai: { phase: 'commentary' } },
      );
      assert.deepEqual(session.messages[3], {
        type: 'tool_call',
        id: 'call-wait-1',
        turnId: 'codex-turn-1',
        ts: Date.parse('2026-08-08T00:00:05.000Z'),
        toolName: 'wait',
        args: { milliseconds: 25 },
      });
      assert.deepEqual(session.messages[4], {
        type: 'tool_result',
        id: 'function-output-1',
        turnId: 'codex-turn-1',
        ts: Date.parse('2026-08-08T00:00:06.000Z'),
        toolUseId: 'call-wait-1',
        isError: false,
        content: { kind: 'text', text: 'waited' },
      });
      assert.equal(session.messages[5]?.type, 'tool_call');
      assert.equal(session.messages[5]?.args, '*** Begin Patch');
      assert.deepEqual(
        session.messages[6]?.type === 'tool_result' ? session.messages[6].content : undefined,
        { kind: 'text', text: 'Done\n1 file changed' },
      );
      assert.equal(session.messages[7]?.type, 'system_note');
      assert.equal(session.messages[8]?.type, 'turn_state');
      assert.equal(session.messages[8]?.status, 'completed');
    });
  });

  test('converts Codex Desktop completed items without importing response mirrors', async () => {
    await withCodexHome(async (codexHome) => {
      const sessionId = 'codex-item-completed';
      await seedRawRollout(codexHome, sessionId, await readFile(ITEM_COMPLETED_FIXTURE, 'utf8'));

      const adapter = new CodexSessionAdapter({ codexHome });
      assert.deepEqual(
        (await listSessions(adapter)).map(({ id, name }) => ({ id, name })),
        [{ id: sessionId, name: 'Analyze the image. Use OpenCV.js.' }],
      );
      const session = await adapter.readSession(sessionId);

      assert.deepEqual(session.metadata, {
        name: 'Analyze the image. Use OpenCV.js.',
        cwd: '/workspace/opencv',
      });
      assert.equal(session.messages.length, 4);
      assert.deepEqual(
        session.messages.map((message) => message.type),
        ['user', 'assistant', 'assistant', 'turn_state'],
      );
      for (const message of session.messages) {
        assert.deepEqual(decodeCanonicalMessage(message), message);
      }

      assert.deepEqual(session.messages[0], {
        type: 'user',
        id: 'user-client-1',
        turnId: 'codex-turn-item-completed',
        ts: Date.parse('2026-08-22T00:00:02.100Z'),
        text: 'Analyze the image. Use OpenCV.js.',
      });
      assert.deepEqual(session.messages[1], {
        type: 'assistant',
        id: 'reasoning-item-1',
        turnId: 'codex-turn-item-completed',
        ts: Date.parse('2026-08-22T00:00:03.000Z'),
        text: '',
        thinking: { text: 'Inspect the pixels.\nDraft the solution.' },
        contentOrder: ['thinking'],
        modelId: 'gpt-codex-item-test',
      });
      assert.deepEqual(session.messages[2], {
        type: 'assistant',
        id: 'assistant-item-1',
        turnId: 'codex-turn-item-completed',
        ts: Date.parse('2026-08-22T00:00:04.000Z'),
        text: 'Use canvas. Then process the pixels.',
        providerOptions: {
          openai: {
            phase: 'final_answer',
          },
        },
        modelId: 'gpt-codex-item-test',
        contentOrder: ['text'],
      });
      assert.equal(session.messages[3]?.type, 'turn_state');
      assert.equal(session.messages[3]?.status, 'completed');
    });
  });

  test('imports terminal errors as failed without failing turns on non-terminal errors', async () => {
    await withCodexHome(async (codexHome) => {
      const sessionId = 'codex-error-semantics';
      await seedRawRollout(codexHome, sessionId, errorSemanticsRollout(sessionId));

      const session = await new CodexSessionAdapter({ codexHome }).readSession(sessionId);
      assert.deepEqual(
        session.messages
          .filter((message) => message.type === 'turn_state')
          .map(({ turnId, status, errorClass }) => ({ turnId, status, errorClass })),
        [
          { turnId: 'turn-terminal', status: 'failed', errorClass: 'codex_error' },
          { turnId: 'turn-rollback', status: 'completed', errorClass: undefined },
          { turnId: 'turn-not-steerable', status: 'completed', errorClass: undefined },
        ],
      );
    });
  });

  test('preserves a terminal row that closes an older interleaved turn', async () => {
    await withCodexHome(async (codexHome) => {
      const sessionId = 'codex-interleaved-terminal';
      await seedRawRollout(codexHome, sessionId, interleavedTerminalRollout(sessionId));

      const session = await new CodexSessionAdapter({ codexHome }).readSession(sessionId);
      assert.deepEqual(
        session.messages.map((message) => [message.turnId, message.type]),
        [
          ['turn-a', 'user'],
          ['turn-b', 'user'],
          ['turn-a', 'turn_state'],
          ['turn-b', 'turn_state'],
        ],
      );
    });
  });

  test('filesystem fallback excludes internal subagent rollouts', async () => {
    await withCodexHome(async (codexHome) => {
      await seedMinimalRollout(
        codexHome,
        'codex-root-fallback',
        false,
        '/workspace/root',
        'Root task',
      );
      const subagentId = 'codex-subagent-fallback';
      await seedRawRollout(
        codexHome,
        subagentId,
        minimalRollout(subagentId, '/workspace/root', 'Internal task', {
          subagent: {
            thread_spawn: { parent_thread_id: 'parent', depth: 1 },
          },
        }),
      );

      const adapter = new CodexSessionAdapter({ codexHome });
      assert.deepEqual(
        (await listSessions(adapter)).map((session) => session.id),
        ['codex-root-fallback'],
      );
      await assert.rejects(adapter.readSession(subagentId), ExternalSessionNotFoundError);
    });
  });

  test('filesystem fallback pages globally by rollout mtime across active and archived roots', async () => {
    await withCodexHome(async (codexHome) => {
      const staleActive = await seedMinimalRollout(
        codexHome,
        'codex-page-z-stale',
        false,
        '/workspace/root',
        'stale active',
      );
      const freshActive = await seedMinimalRollout(
        codexHome,
        'codex-page-a-fresh',
        false,
        '/workspace/root',
        'fresh active',
      );
      const newestArchived = await seedMinimalRollout(
        codexHome,
        'codex-page-archived-newest',
        true,
        '/workspace/root',
        'newest archived',
      );
      await utimes(staleActive, new Date('2026-08-01T00:00:00Z'), new Date('2026-08-01T00:00:00Z'));
      await utimes(freshActive, new Date('2026-08-02T00:00:00Z'), new Date('2026-08-02T00:00:00Z'));
      await utimes(
        newestArchived,
        new Date('2026-08-03T00:00:00Z'),
        new Date('2026-08-03T00:00:00Z'),
      );
      const adapter = new CodexSessionAdapter({ codexHome });

      assert.deepEqual(
        (await listSessions(adapter, { includeArchived: true, offset: 0, limit: 1 })).map(
          ({ id }) => id,
        ),
        ['codex-page-archived-newest'],
      );
      assert.deepEqual(
        (await listSessions(adapter, { includeArchived: true, offset: 1, limit: 1 })).map(
          ({ id }) => id,
        ),
        ['codex-page-a-fresh'],
      );
      assert.deepEqual(
        (await listSessions(adapter, { includeArchived: true, offset: 2, limit: 1 })).map(
          ({ id }) => id,
        ),
        ['codex-page-z-stale'],
      );
    });
  });

  test('filesystem fallback fails with a typed limit instead of scanning an unbounded catalog', async () => {
    await withCodexHome(async (codexHome) => {
      for (const id of [
        'codex-catalog-limit-1',
        'codex-catalog-limit-2',
        'codex-catalog-limit-3',
      ]) {
        await seedMinimalRollout(codexHome, id, false, '/workspace/root', id);
      }
      const adapter = new CodexSessionAdapter({ codexHome, maxCatalogCandidates: 2 });

      await assert.rejects(
        adapter.listSessionPage({ limit: 1 }),
        (error: unknown) =>
          error instanceof ExternalSessionLimitError &&
          error.limit.kind === 'records' &&
          error.limit.max === 2,
      );
    });
  });

  test('filesystem keyset paging never repeats a row moved ahead of the cursor', async () => {
    await withCodexHome(async (codexHome) => {
      const paths: string[] = [];
      for (let index = 0; index < 20; index += 1) {
        const id = `codex-snapshot-${String(index).padStart(2, '0')}`;
        const path = await seedMinimalRollout(codexHome, id, false, '/workspace/root', id);
        const time = new Date(Date.UTC(2026, 7, 1, 0, 0, index));
        await utimes(path, time, time);
        paths.push(path);
      }
      const adapter = new CodexSessionAdapter({ codexHome });
      const first = await adapter.listSessionPage!({ limit: 16 });
      assert.deepEqual(
        first.items.map(({ summary }) => summary.id),
        Array.from(
          { length: 16 },
          (_, index) => `codex-snapshot-${String(19 - index).padStart(2, '0')}`,
        ),
      );
      const cursor = first.items.at(-1)!.nextCursor;
      assert.ok(Buffer.byteLength(cursor, 'utf8') <= 512);
      await assert.rejects(
        adapter.listSessionPage!({ cursor, cwd: '/another/workspace', limit: 16 }),
        (error: unknown) => error instanceof ExternalSessionCatalogCursorError,
      );

      const newest = new Date('2026-09-15T00:00:00Z');
      await utimes(paths[1]!, newest, newest);
      const second = await adapter.listSessionPage!({
        cursor,
        limit: 16,
      });
      const ids = [...first.items, ...second.items].map(({ summary }) => summary.id);
      assert.equal(new Set(ids).size, ids.length);
      assert.deepEqual(
        ids,
        Array.from({ length: 20 }, (_, index) => 19 - index)
          .filter((index) => index !== 1)
          .map((index) => `codex-snapshot-${String(index).padStart(2, '0')}`),
      );
    });
  });

  test('filesystem keyset paging uses one digest order across equal-mtime pages', async () => {
    await withCodexHome(async (codexHome) => {
      const underscore = await seedMinimalRollout(
        codexHome,
        'codex_a',
        false,
        '/workspace/root',
        'underscore',
      );
      const hyphen = await seedMinimalRollout(
        codexHome,
        'codex-a',
        false,
        '/workspace/root',
        'hyphen',
      );
      const tied = new Date('2026-08-08T00:00:00Z');
      await utimes(underscore, tied, tied);
      await utimes(hyphen, tied, tied);
      const adapter = new CodexSessionAdapter({ codexHome });

      const first = await adapter.listSessionPage!({ limit: 1 });
      assert.equal(first.items.length, 1);
      assert.equal(first.hasMore, true);
      const cursor = first.items[0]!.nextCursor;
      const [tag, queryHash, timestamp, identity] = cursor.split(':');
      if (!queryHash || !timestamp || !identity) throw new Error('Expected a filesystem cursor');
      assert.equal(tag, 'f2');
      for (const invalidCursor of [
        `f:${queryHash}:${timestamp}:${identity}`,
        `f2:${queryHash}:${timestamp}:${identity.slice(0, -1)}`,
        `f2:${queryHash}:${timestamp}:${identity}A`,
        `f2:${queryHash}:${timestamp}:${identity.slice(0, -1)}+`,
      ]) {
        await assert.rejects(
          adapter.listSessionPage!({ cursor: invalidCursor, limit: 1 }),
          ExternalSessionCatalogCursorError,
        );
      }

      const second = await adapter.listSessionPage!({
        cursor,
        limit: 1,
      });
      assert.deepEqual(
        new Set([...first.items, ...second.items].map(({ summary }) => summary.id)),
        new Set(['codex_a', 'codex-a']),
      );
      assert.equal(second.hasMore, false);
    });
  });

  test('filesystem cursor stays wire-bounded for deeply nested rollout paths', async () => {
    await withCodexHome(async (codexHome) => {
      const nestedDirectory = join(
        codexHome,
        'sessions',
        ...Array.from({ length: 12 }, (_, index) => `${index}-${'nested'.repeat(8)}`),
      );
      await mkdir(nestedDirectory, { recursive: true });
      const nestedId = 'codex-deep-cursor';
      const nestedPath = join(nestedDirectory, `rollout-${nestedId}.jsonl`);
      await writeFile(nestedPath, minimalRollout(nestedId, '/workspace/root', 'deep'));
      const shallowPath = await seedMinimalRollout(
        codexHome,
        'codex-shallow-cursor',
        false,
        '/workspace/root',
        'shallow',
      );
      const tied = new Date('2026-08-08T00:00:00Z');
      await utimes(nestedPath, tied, tied);
      await utimes(shallowPath, tied, tied);
      const adapter = new CodexSessionAdapter({ codexHome });

      const first = await adapter.listSessionPage({ limit: 1 });
      assert.equal(first.hasMore, true);
      assert.ok(Buffer.byteLength(first.items[0]!.nextCursor, 'utf8') <= 512);
      const second = await adapter.listSessionPage({
        cursor: first.items[0]!.nextCursor,
        limit: 1,
      });

      assert.equal(second.hasMore, false);
      assert.deepEqual(
        new Set([...first.items, ...second.items].map(({ summary }) => summary.id)),
        new Set([nestedId, 'codex-shallow-cursor']),
      );
    });
  });

  test('database keyset paging stays on the state generation that issued the cursor', async () => {
    await withCodexHome(async (codexHome) => {
      const oldRows: StateRow[] = [];
      for (let index = 1; index <= 4; index++) {
        const id = `codex-old-${index}`;
        oldRows.push({
          id,
          rolloutPath: await seedMinimalRollout(codexHome, id, false, '/workspace', id),
          cwd: '/workspace',
          name: id,
          createdAtMs: index * 1000,
          updatedAtMs: index * 1000,
          archived: false,
          source: 'cli',
        });
      }
      await seedStateDatabase(codexHome, oldRows);

      const adapter = new CodexSessionAdapter({ codexHome });
      const first = await adapter.listSessionPage!({ limit: 2 });
      assert.deepEqual(
        first.items.map(({ summary }) => summary.id),
        ['codex-old-4', 'codex-old-3'],
      );
      const cursor = first.items.at(-1)?.nextCursor;
      assert.ok(cursor);

      const newId = 'codex-new-100';
      await seedStateDatabase(
        codexHome,
        [
          {
            id: newId,
            rolloutPath: await seedMinimalRollout(codexHome, newId, false, '/workspace', newId),
            cwd: '/workspace',
            name: newId,
            createdAtMs: 100_000,
            updatedAtMs: 100_000,
            archived: false,
            source: 'cli',
          },
        ],
        'state_6.sqlite',
      );

      const second = await adapter.listSessionPage!({ cursor, limit: 2 });
      assert.deepEqual(
        second.items.map(({ summary }) => summary.id),
        ['codex-old-2', 'codex-old-1'],
      );
    });
  });

  test('database continuation surfaces source read failures without invalidating the cursor', async () => {
    await withCodexHome(async (codexHome) => {
      const rows: StateRow[] = [];
      for (let index = 1; index <= 3; index++) {
        const id = `codex-read-failure-${index}`;
        rows.push({
          id,
          rolloutPath: await seedMinimalRollout(codexHome, id, false, '/workspace', id),
          cwd: '/workspace',
          name: id,
          createdAtMs: index * 1000,
          updatedAtMs: index * 1000,
          archived: false,
          source: 'cli',
        });
      }
      await seedStateDatabase(codexHome, rows);
      const adapter = new CodexSessionAdapter({ codexHome });
      const first = await adapter.listSessionPage({ limit: 1 });
      const cursor = first.items[0]!.nextCursor;
      await writeFile(join(codexHome, 'state_5.sqlite'), 'not a sqlite database');

      await assert.rejects(adapter.listSessionPage({ cursor, limit: 1 }), (error: unknown) => {
        assert.equal(error instanceof ExternalSessionCatalogCursorError, false);
        return true;
      });
    });
  });

  test('an unreadable newest generation falls through to the rollout scan', async () => {
    await withCodexHome(async (codexHome) => {
      // The last bump froze `state_5.sqlite`; `state_6.sqlite` is the live one,
      // so a read can fail while Codex is rewriting it. `codex-new` was created
      // after the bump, so it exists only in the unreadable generation and in
      // its own rollout.
      const staleRollout = await seedMinimalRollout(
        codexHome,
        'codex-stale',
        false,
        '/workspace',
        'stale rollout title',
      );
      await seedMinimalRollout(codexHome, 'codex-new', false, '/workspace', 'new rollout title');
      await seedStateDatabase(codexHome, [
        {
          id: 'codex-stale',
          rolloutPath: staleRollout,
          cwd: '/workspace',
          name: 'stale row title',
          createdAtMs: 1000,
          updatedAtMs: 1000,
          archived: false,
          source: 'cli',
        },
      ]);
      await writeFile(join(codexHome, 'state_6.sqlite'), 'not a sqlite database');

      const adapter = new CodexSessionAdapter({ codexHome });
      const page = await adapter.listSessionPage({ limit: 10 });
      // Settling for the older generation would answer with `codex-stale`
      // alone and drop `codex-new` without a word. Only the rollout scan is
      // still known to cover both.
      assert.deepEqual(page.items.map(({ summary }) => summary.id).sort(), [
        'codex-new',
        'codex-stale',
      ]);
      // The titles come off the rollout heads, which is what proves the
      // `state_5.sqlite` page — whose row says "stale row title" — did not
      // answer this call.
      assert.deepEqual(page.items.map(({ summary }) => summary.name).sort(), [
        'new rollout title',
        'stale rollout title',
      ]);
    });
  });

  test('an unreadable older generation leaves the newest one in charge', async () => {
    await withCodexHome(async (codexHome) => {
      const rolloutPath = await seedMinimalRollout(
        codexHome,
        'codex-live',
        false,
        '/workspace',
        'rollout title',
      );
      await seedStateDatabase(
        codexHome,
        [
          {
            id: 'codex-live',
            rolloutPath,
            cwd: '/workspace',
            name: 'live row title',
            createdAtMs: 2000,
            updatedAtMs: 2000,
            archived: false,
            source: 'cli',
          },
        ],
        'state_6.sqlite',
      );
      await writeFile(join(codexHome, 'state_5.sqlite'), 'not a sqlite database');

      const adapter = new CodexSessionAdapter({ codexHome });
      const page = await adapter.listSessionPage({ limit: 10 });
      // A stale generation is never consulted once a newer one answers, so its
      // read failure must not push this call onto the coarser rollout scan.
      assert.deepEqual(
        page.items.map(({ summary }) => summary.name),
        ['live row title'],
      );
    });
  });

  test('a text-shaped ordering value cannot strand the rest of the catalog', async () => {
    await withCodexHome(async (codexHome) => {
      const rows: StateRow[] = [];
      // The healthy rows were updated well after `codex-text` was created, so
      // the JS fallback chain below (which skips the unparseable `updated_at_ms`
      // and lands on `created_at_ms`) computes a key far below theirs.
      for (const [id, updatedAtMs] of [
        ['codex-text', 1000],
        ['codex-a', 5_000_000],
        ['codex-b', 4_000_000],
      ] as const) {
        rows.push({
          id,
          rolloutPath: await seedMinimalRollout(codexHome, id, false, '/workspace', id),
          cwd: '/workspace',
          name: id,
          createdAtMs: 1000,
          updatedAtMs,
          archived: false,
          source: 'cli',
        });
      }
      await seedStateDatabase(codexHome, rows);
      // `updated_at_ms` is declared INTEGER, but SQLite keeps a value it cannot
      // convert losslessly with its original type, so anything Codex writes that
      // does not parse as a number lands as TEXT. SQLite then orders that key
      // above every number and never applies the `* 1000` branch to it.
      const { DatabaseSync } = await import('node:sqlite');
      const database = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
      try {
        database
          .prepare('UPDATE threads SET updated_at_ms = ? WHERE id = ?')
          .run('2026-08-08T00:00:00Z', 'codex-text');
      } finally {
        database.close();
      }

      const adapter = new CodexSessionAdapter({ codexHome });
      const seen: string[] = [];
      let cursor: string | undefined;
      // Bounded, so a page that fails to advance fails here instead of hanging.
      for (let page = 0; page < 8; page += 1) {
        const result = await adapter.listSessionPage({ limit: 1, ...(cursor ? { cursor } : {}) });
        seen.push(...result.items.map(({ summary }) => summary.id));
        if (!result.hasMore) break;
        cursor = result.items.at(-1)?.nextCursor;
        assert.ok(cursor, 'a page that reports hasMore must carry a next cursor');
      }
      // The same normalization must determine display time, SQL order, and
      // cursor position. The ISO value is in 2026, so it precedes the small
      // numeric fixtures instead of being cast to the number 2026.
      assert.deepEqual(seen, ['codex-text', 'codex-a', 'codex-b']);
    });
  });

  test('rejects corrupt interior records, tolerates a torn tail, and bounds scanned bytes', async () => {
    await withCodexHome(async (codexHome) => {
      const fixture = await readFile(CURRENT_FIXTURE, 'utf8');
      const corruptId = 'codex-corrupt';
      await seedRawRollout(
        codexHome,
        corruptId,
        fixture
          .replaceAll('codex-session-1', corruptId)
          .replace(
            '\n{"timestamp":"2026-08-08T00:00:01.000Z"',
            '\nnot-json\n{"timestamp":"2026-08-08T00:00:01.000Z"',
          ),
      );
      const tornId = 'codex-torn';
      await seedRawRollout(
        codexHome,
        tornId,
        `${fixture.replaceAll('codex-session-1', tornId)}{"timestamp"`,
      );

      const adapter = new CodexSessionAdapter({ codexHome });
      await assert.rejects(adapter.readSession(corruptId), /Invalid Codex rollout.*line 2/);
      assert.equal((await adapter.readSession(tornId)).messages.length, 9);

      const bounded = new CodexSessionAdapter({ codexHome, maxRolloutBytes: 100 });
      await assert.rejects(
        bounded.readSession(tornId),
        (error: unknown) =>
          error instanceof ExternalSessionLimitError &&
          error.limit.kind === 'transcript_bytes' &&
          error.limit.max === 100,
      );
    });
  });

  test('parses a UTF-8 JSONL record split across read buffers', async () => {
    await withCodexHome(async (codexHome) => {
      const sessionId = 'codex-cross-buffer-utf8';
      const meta = `${JSON.stringify({
        timestamp: '2026-08-08T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          session_id: sessionId,
          id: sessionId,
          cwd: '/workspace/utf8',
          source: 'cli',
        },
      })}\n`;
      const prefixBytes = Buffer.byteLength(meta, 'utf8');
      const eventTemplate = JSON.stringify({
        timestamp: '2026-08-08T00:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: '__MESSAGE__' },
      });
      const [eventPrefix, eventSuffix] = eventTemplate.split('__MESSAGE__');
      assert.ok(eventPrefix !== undefined && eventSuffix !== undefined);
      const paddingBytes = 64 * 1024 - prefixBytes - Buffer.byteLength(eventPrefix, 'utf8') - 1;
      assert.ok(paddingBytes > 0);
      const content = `${meta}${eventPrefix}${'x'.repeat(paddingBytes)}你${eventSuffix}\n`;
      await seedRawRollout(codexHome, sessionId, content);

      const session = await new CodexSessionAdapter({ codexHome }).readSession(sessionId);
      assert.equal(session.messages[0]?.type, 'user');
      assert.equal(
        session.messages[0]?.type === 'user' ? session.messages[0].text : undefined,
        `${'x'.repeat(paddingBytes)}你`,
      );
    });
  });

  test('rejects a short read before the fixed rollout snapshot is complete', async () => {
    await withCodexHome(async (codexHome) => {
      const sessionId = 'codex-truncated-during-read';
      const rolloutPath = await seedRawRollout(
        codexHome,
        sessionId,
        `${minimalRollout(sessionId, '/workspace', 'Keep this message')}${JSON.stringify({
          timestamp: '2026-08-08T00:00:02.000Z',
          type: 'world_state',
          payload: { padding: 'x'.repeat(128 * 1024) },
        })}\n`,
      );
      await seedStateDatabase(codexHome, [
        {
          id: sessionId,
          rolloutPath,
          cwd: '/workspace',
          name: 'Truncated during read',
          createdAtMs: 1_000,
          updatedAtMs: 2_000,
          archived: false,
          source: 'cli',
        },
      ]);

      let readCalls = 0;
      await withFileReadMock(
        rolloutPath,
        async (readOriginal, buffer) => {
          readCalls += 1;
          return readCalls === 2 ? { bytesRead: 0, buffer } : readOriginal();
        },
        () =>
          assert.rejects(
            new CodexSessionAdapter({ codexHome }).readSession(sessionId),
            /changed while being read/,
          ),
      );
    });
  });

  test('does not follow records appended after the rollout snapshot is opened', async () => {
    await withCodexHome(async (codexHome) => {
      const sessionId = 'codex-appended-during-read';
      const rolloutPath = await seedRawRollout(
        codexHome,
        sessionId,
        minimalRollout(sessionId, '/workspace', 'Keep this message'),
      );
      await seedStateDatabase(codexHome, [
        {
          id: sessionId,
          rolloutPath,
          cwd: '/workspace',
          name: 'Appended during read',
          createdAtMs: 1_000,
          updatedAtMs: 2_000,
          archived: false,
          source: 'cli',
        },
      ]);

      let appended = false;
      await withFileReadMock(
        rolloutPath,
        async (readOriginal) => {
          const result = await readOriginal();
          if (!appended) {
            appended = true;
            await appendFile(rolloutPath, 'not-json\n');
          }
          return result;
        },
        async () => {
          const session = await new CodexSessionAdapter({ codexHome }).readSession(sessionId);
          assert.equal(session.messages[0]?.type, 'user');
          assert.equal(
            session.messages[0]?.type === 'user' ? session.messages[0].text : undefined,
            'Keep this message',
          );
        },
      );
    });
  });

  test('rejects an oversized JSONL record without buffering the complete rollout', async () => {
    await withCodexHome(async (codexHome) => {
      const sessionId = 'codex-record-limit';
      await seedMinimalRollout(codexHome, sessionId, false, '/workspace', 'hello');
      const adapter = new CodexSessionAdapter({ codexHome, maxRecordBytes: 100 });

      await assert.rejects(
        adapter.readSession(sessionId),
        (error: unknown) =>
          error instanceof ExternalSessionLimitError &&
          error.limit.kind === 'record_bytes' &&
          error.limit.max === 100,
      );
    });
  });

  test('rejects converted histories that exceed message count or byte budgets', async () => {
    await withCodexHome(async (codexHome) => {
      const sessionId = 'codex-converted-limits';
      await seedRawRollout(
        codexHome,
        sessionId,
        `${minimalRollout(sessionId, '/workspace', 'hello')}${JSON.stringify({
          timestamp: '2026-08-08T00:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'world' },
        })}\n`,
      );

      await assert.rejects(
        new CodexSessionAdapter({ codexHome, maxMessages: 1 }).readSession(sessionId),
        (error: unknown) =>
          error instanceof ExternalSessionLimitError &&
          error.limit.kind === 'messages' &&
          error.limit.max === 1,
      );
      await assert.rejects(
        new CodexSessionAdapter({ codexHome, maxConvertedBytes: 10 }).readSession(sessionId),
        (error: unknown) =>
          error instanceof ExternalSessionLimitError &&
          error.limit.kind === 'converted_bytes' &&
          error.limit.max === 10,
      );
    });
  });

  test('streams valid rollouts larger than the legacy 64 MiB whole-file limit', async () => {
    await withCodexHome(async (codexHome) => {
      const sessionId = 'codex-large-streamed';
      const rolloutPath = await seedMinimalRollout(
        codexHome,
        sessionId,
        false,
        '/workspace/large',
        'Keep this message',
      );
      const ignoredRecord = `${JSON.stringify({
        timestamp: '2026-08-08T00:00:02.000Z',
        type: 'world_state',
        payload: { padding: 'x'.repeat(1024 * 1024) },
      })}\n`;
      const handle = await open(rolloutPath, 'a');
      try {
        for (let index = 0; index < 65; index += 1) await handle.write(ignoredRecord);
      } finally {
        await handle.close();
      }
      assert.ok((await stat(rolloutPath)).size > 64 * 1024 * 1024);

      const session = await new CodexSessionAdapter({ codexHome }).readSession(sessionId);
      assert.deepEqual(session.messages, [
        {
          type: 'user',
          id: `codex-${sessionId}-user-2`,
          turnId: `codex-${sessionId}-turn-2`,
          ts: Date.parse('2026-08-08T00:00:01.000Z'),
          text: 'Keep this message',
        },
      ]);
    });
  });

  test('never follows a state database rollout path outside CODEX_HOME', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'maka-codex-outside-'));
    try {
      await withCodexHome(async (codexHome) => {
        const id = 'codex-escaped';
        const escapedPath = join(outside, `rollout-2026-08-08T00-00-00-${id}.jsonl`);
        await writeFile(escapedPath, minimalRollout(id, '/outside', 'outside'));
        await seedStateDatabase(codexHome, [
          {
            id,
            rolloutPath: escapedPath,
            cwd: '/outside',
            name: 'Escaped',
            createdAtMs: 1000,
            updatedAtMs: 2000,
            archived: false,
            source: 'cli',
          },
        ]);

        const adapter = new CodexSessionAdapter({ codexHome });
        assert.deepEqual(await listSessions(adapter), []);
        await assert.rejects(adapter.readSession(id), ExternalSessionNotFoundError);
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('is registered by the internal default registry', async () => {
    await withCodexHome(async (codexHome) => {
      const registry = createExternalSessionAdapterRegistry({ codex: { codexHome } });
      assert.equal(registry.require('codex').id, 'codex');
    });
  });
});

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../src/__tests__/fixtures/${name}`, import.meta.url));
}

async function withCodexHome(run: (codexHome: string) => Promise<void>): Promise<void> {
  const codexHome = await mkdtemp(join(tmpdir(), 'maka-codex-adapter-'));
  try {
    await run(codexHome);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

type PositionalRead = (
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => Promise<{ bytesRead: number; buffer: Buffer }>;

async function withFileReadMock(
  path: string,
  read: (
    readOriginal: () => ReturnType<PositionalRead>,
    buffer: Buffer,
  ) => ReturnType<PositionalRead>,
  run: () => Promise<void>,
): Promise<void> {
  const probe = await open(path, 'r');
  const fileHandlePrototype = Object.getPrototypeOf(probe) as { read: PositionalRead };
  const originalRead = fileHandlePrototype.read;
  await probe.close();
  const readMock = mock.method(
    fileHandlePrototype,
    'read',
    async function (
      this: typeof probe,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) {
      return read(() => originalRead.call(this, buffer, offset, length, position), buffer);
    },
  );
  try {
    await run();
  } finally {
    readMock.mock.restore();
  }
}

async function seedFixtureRollout(
  codexHome: string,
  sessionId: string,
  archived: boolean,
): Promise<string> {
  const fixture = (await readFile(CURRENT_FIXTURE, 'utf8')).replaceAll(
    'codex-session-1',
    sessionId,
  );
  return seedRawRollout(codexHome, sessionId, fixture, archived);
}

async function seedMinimalRollout(
  codexHome: string,
  sessionId: string,
  archived: boolean,
  cwd: string,
  userText: string,
): Promise<string> {
  return seedRawRollout(codexHome, sessionId, minimalRollout(sessionId, cwd, userText), archived);
}

async function seedRawRollout(
  codexHome: string,
  sessionId: string,
  content: string,
  archived = false,
): Promise<string> {
  const directory = archived
    ? join(codexHome, 'archived_sessions')
    : join(codexHome, 'sessions', '2026', '08', '08');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-2026-08-08T00-00-00-${sessionId}.jsonl`);
  await writeFile(path, content);
  return path;
}

function minimalRollout(
  sessionId: string,
  cwd: string,
  userText: string,
  source: unknown = 'cli',
): string {
  return [
    JSON.stringify({
      timestamp: '2026-08-08T00:00:00.000Z',
      type: 'session_meta',
      payload: { session_id: sessionId, id: sessionId, cwd, source },
    }),
    JSON.stringify({
      timestamp: '2026-08-08T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: userText },
    }),
    '',
  ].join('\n');
}

function errorSemanticsRollout(sessionId: string): string {
  const event = (second: number, payload: Record<string, unknown>): string =>
    JSON.stringify({
      timestamp: `2026-08-08T00:00:${String(second).padStart(2, '0')}.000Z`,
      type: 'event_msg',
      payload,
    });
  return [
    JSON.stringify({
      timestamp: '2026-08-08T00:00:00.000Z',
      type: 'session_meta',
      payload: { session_id: sessionId, id: sessionId, cwd: '/workspace', source: 'cli' },
    }),
    event(1, { type: 'task_started', turn_id: 'turn-terminal' }),
    event(2, { type: 'user_message', message: 'Fail terminally' }),
    event(3, {
      type: 'task_complete',
      turn_id: 'turn-terminal',
      error: { message: 'capacity', codex_error_info: 'server_overloaded' },
    }),
    event(4, { type: 'task_started', turn_id: 'turn-rollback' }),
    event(5, { type: 'user_message', message: 'Rollback warning' }),
    event(6, {
      type: 'error',
      message: 'rollback failed',
      codex_error_info: 'thread_rollback_failed',
    }),
    event(7, { type: 'task_complete', turn_id: 'turn-rollback' }),
    event(8, { type: 'task_started', turn_id: 'turn-not-steerable' }),
    event(9, { type: 'user_message', message: 'Steer review' }),
    event(10, {
      type: 'error',
      message: 'cannot steer review',
      codex_error_info: { active_turn_not_steerable: { turn_kind: 'review' } },
    }),
    event(11, { type: 'task_complete', turn_id: 'turn-not-steerable' }),
    '',
  ].join('\n');
}

function interleavedTerminalRollout(sessionId: string): string {
  const event = (second: number, payload: Record<string, unknown>): string =>
    JSON.stringify({
      timestamp: `2026-08-08T00:00:${String(second).padStart(2, '0')}.000Z`,
      type: 'event_msg',
      payload,
    });
  return [
    JSON.stringify({
      timestamp: '2026-08-08T00:00:00.000Z',
      type: 'session_meta',
      payload: { session_id: sessionId, id: sessionId, cwd: '/workspace', source: 'cli' },
    }),
    event(1, { type: 'task_started', turn_id: 'turn-a' }),
    event(2, { type: 'user_message', message: 'first' }),
    event(3, { type: 'task_started', turn_id: 'turn-b' }),
    event(4, { type: 'user_message', message: 'second' }),
    event(5, { type: 'task_complete', turn_id: 'turn-a' }),
    event(6, { type: 'task_complete', turn_id: 'turn-b' }),
    '',
  ].join('\n');
}

interface StateRow {
  id: string;
  rolloutPath: string;
  cwd: string;
  name: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  createdAt?: number;
  updatedAt?: number;
  archived: boolean;
  source: string;
}

async function seedStateDatabase(
  codexHome: string,
  rows: readonly StateRow[],
  filename = 'state_5.sqlite',
): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(join(codexHome, filename));
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        cwd TEXT,
        name TEXT,
        created_at_ms INTEGER,
        updated_at_ms INTEGER,
        created_at INTEGER,
        updated_at INTEGER,
        archived INTEGER,
        source TEXT
      )
    `);
    const insert = database.prepare(`
      INSERT INTO threads (
        id, rollout_path, cwd, name, created_at_ms, updated_at_ms, created_at, updated_at,
        archived, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(
        row.id,
        row.rolloutPath,
        row.cwd,
        row.name,
        row.createdAtMs ?? null,
        row.updatedAtMs ?? null,
        row.createdAt ?? null,
        row.updatedAt ?? null,
        row.archived ? 1 : 0,
        row.source,
      );
    }
  } finally {
    database.close();
  }
}

async function rolloutMtime(
  codexHome: string,
  sessionId: string,
  archived: boolean,
): Promise<number> {
  const { stat } = await import('node:fs/promises');
  const directory = archived
    ? join(codexHome, 'archived_sessions')
    : join(codexHome, 'sessions', '2026', '08', '08');
  return (await stat(join(directory, `rollout-2026-08-08T00-00-00-${sessionId}.jsonl`))).mtimeMs;
}
