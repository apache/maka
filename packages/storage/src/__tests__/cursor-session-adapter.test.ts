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
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  ExternalSessionLimitError,
  ExternalSessionNotFoundError,
} from '@maka/core/external-session';
import { createExternalSessionAdapterRegistry } from '../external-session-adapters.js';
import {
  CURSOR_SESSION_ADAPTER_ID,
  CursorSessionAdapter,
  defaultCursorHome,
} from '../cursor-session-adapter.js';

const CLEANUPS: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (CLEANUPS.length > 0) {
    await CLEANUPS.pop()!();
  }
});

interface FixtureBubble {
  readonly bubbleId: string;
  readonly type: number;
  readonly text?: string;
  readonly createdAt?: string;
  readonly toolFormerData?: Record<string, unknown>;
}

interface FixtureComposer {
  readonly composerId: string;
  readonly name?: string;
  readonly createdAt?: number;
  readonly lastUpdatedAt?: number;
  readonly headers?: readonly FixtureBubble[];
  /** Header ids whose bubble row the source pruned: key never written. */
  readonly omitBubbles?: readonly string[];
  /** Rows whose key is written but whose value is not JSON. */
  readonly corruptBubbles?: readonly string[];
  /** Pads the composer record with a foreign field of this many bytes. */
  readonly paddedBytes?: number;
}

/** Builds a `state.vscdb` the way Cursor writes it: one KV table, JSON text values. */
async function makeStateDb(composers: readonly FixtureComposer[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'cursor-globalStorage-'));
  CLEANUPS.push(() => rm(home, { recursive: true, force: true }));
  const db = new DatabaseSync(join(home, 'state.vscdb'));
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
  for (const composer of composers) {
    const record = {
      _v: 13,
      composerId: composer.composerId,
      ...(composer.name !== undefined ? { name: composer.name } : {}),
      ...(composer.createdAt !== undefined ? { createdAt: composer.createdAt } : {}),
      ...(composer.lastUpdatedAt !== undefined ? { lastUpdatedAt: composer.lastUpdatedAt } : {}),
      ...(composer.paddedBytes !== undefined
        ? { foreignFutureField: 'p'.repeat(composer.paddedBytes) }
        : {}),
      fullConversationHeadersOnly: (composer.headers ?? []).map(({ bubbleId, type }) => ({
        bubbleId,
        type,
      })),
    };
    db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
      `composerData:${composer.composerId}`,
      JSON.stringify(record),
    );
    for (const bubble of composer.headers ?? []) {
      if (composer.omitBubbles?.includes(bubble.bubbleId)) continue;
      const body: Record<string, unknown> = { _v: 13, type: bubble.type };
      if (bubble.text !== undefined) body.text = bubble.text;
      if (bubble.createdAt !== undefined) body.createdAt = bubble.createdAt;
      if (bubble.toolFormerData !== undefined) body.toolFormerData = bubble.toolFormerData;
      db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
        `bubbleId:${composer.composerId}:${bubble.bubbleId}`,
        JSON.stringify(body),
      );
    }
    for (const bubbleId of composer.corruptBubbles ?? []) {
      // Replaces the readable row: the header is intact, the body is not.
      db.prepare('INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
        `bubbleId:${composer.composerId}:${bubbleId}`,
        '{"type": 2, "text":',
      );
    }
  }
  db.close();
  return home;
}

function adapterFor(home: string, overrides: Record<string, unknown> = {}): CursorSessionAdapter {
  return new CursorSessionAdapter({ cursorHome: home, ...overrides });
}

const ISO_A = '2026-02-06T23:10:05.886Z';
const ISO_B = '2026-02-06T23:10:09.997Z';
const ISO_C = '2026-02-06T23:10:12.181Z';

function fullFixture(): FixtureComposer[] {
  return [
    {
      composerId: 'composer-aaaa',
      name: 'Fix the login flow',
      createdAt: 1765597641911,
      lastUpdatedAt: 1765597700000,
      headers: [
        { bubbleId: 'b1', type: 1, text: 'the login button does nothing', createdAt: ISO_A },
        {
          bubbleId: 'b2',
          type: 2,
          text: 'I will look at the handler.',
          createdAt: ISO_B,
        },
        {
          bubbleId: 'b3',
          type: 2,
          text: '',
          createdAt: ISO_C,
          toolFormerData: {
            tool: '35',
            toolCallId: 'toolu_01',
            name: 'read_file',
            status: 'completed',
            params: JSON.stringify({ path: 'src/login.ts' }),
            result: 'export function onLogin() {}',
          },
        },
        {
          bubbleId: 'b4',
          type: 2,
          text: '',
          createdAt: ISO_C,
          toolFormerData: {
            tool: '36',
            toolCallId: 'toolu_02',
            name: 'edit_file',
            status: 'error',
            params: JSON.stringify({ path: 'src/login.ts' }),
            result: 'the file changed on disk',
          },
        },
        { bubbleId: 'b5', type: 2, text: 'The handler was never bound.', createdAt: ISO_C },
      ],
    },
    {
      composerId: 'composer-bbbb',
      name: 'Empty session',
      createdAt: 1765597642000,
      headers: [],
    },
    {
      composerId: 'composer-cccc',
      name: 'Pruned session',
      createdAt: 1765597643000,
      // The header survives; its bubble row was pruned by the source.
      headers: [{ bubbleId: 'gone', type: 1, text: 'lost prompt' }],
      omitBubbles: ['gone'],
    },
  ];
}

describe('CursorSessionAdapter', () => {
  test('reports absent when no database exists', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cursor-empty-'));
    CLEANUPS.push(() => rm(home, { recursive: true, force: true }));
    const adapter = adapterFor(home);
    assert.equal(await adapter.detect(), false);
    assert.deepEqual(await adapter.listSessions(), []);
  });

  test('an unreadable database is reported, not answered as an empty catalog', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cursor-corrupt-'));
    CLEANUPS.push(() => rm(home, { recursive: true, force: true }));
    await writeFile(join(home, 'state.vscdb'), 'not a database');
    const adapter = adapterFor(home);
    assert.equal(await adapter.detect(), true);
    await assert.rejects(adapter.listSessions(), /could not be (opened|read)/u);
    await assert.rejects(adapter.readSession('composer-x'), /could not be (opened|read)/u);
  });

  test('lists composers with names and stamps, query-filtered', async () => {
    const home = await makeStateDb(fullFixture());
    const adapter = adapterFor(home);
    assert.equal(await adapter.detect(), true);

    const all = await adapter.listSessions();
    assert.deepEqual(
      all.map((session) => [session.id, session.name]),
      [
        ['composer-aaaa', 'Fix the login flow'],
        ['composer-bbbb', 'Empty session'],
        ['composer-cccc', 'Pruned session'],
      ],
    );
    assert.equal(all[0]!.createdAt, 1765597641911);
    assert.equal(all[0]!.updatedAt, 1765597700000);

    const filtered = await adapter.listSessions({ text: 'login' });
    assert.deepEqual(
      filtered.map((session) => session.id),
      ['composer-aaaa'],
    );
  });

  test('pages the catalog with an opaque cursor', async () => {
    const home = await makeStateDb(
      [1, 2, 3].map((index) => ({
        composerId: `composer-${index}`,
        name: `session ${index}`,
        createdAt: index,
      })),
    );
    const adapter = adapterFor(home);
    const first = await adapter.listSessionPage({ limit: 2 });
    assert.equal(first.items.length, 2);
    assert.equal(first.hasMore, true);
    const second = await adapter.listSessionPage({ limit: 2, cursor: first.items[1]!.nextCursor! });
    assert.equal(second.items.length, 1);
    assert.equal(second.hasMore, false);
    assert.deepEqual(
      second.items.map((item) => item.summary.id),
      ['composer-3'],
    );
  });

  test('reads one session end to end: turns, tools, and the abort verdict', async () => {
    const home = await makeStateDb(fullFixture());
    const adapter = adapterFor(home);

    const session = await adapter.readSession('composer-aaaa');
    assert.equal(session.metadata.name, 'Fix the login flow');
    const messages = session.messages;
    assert.equal(messages[0]!.type, 'user');
    if (messages[0]!.type === 'user') {
      assert.equal(messages[0]!.text, 'the login button does nothing');
      assert.equal(messages[0]!.ts, Date.parse(ISO_A));
    }
    const toolCalls = messages.filter((message) => message.type === 'tool_call');
    assert.equal(toolCalls.length, 2);
    if (toolCalls[0]!.type === 'tool_call') {
      assert.equal(toolCalls[0]!.toolName, 'read_file');
      assert.deepEqual(toolCalls[0]!.args, { path: 'src/login.ts' });
    }
    const results = messages.filter((message) => message.type === 'tool_result');
    assert.equal(results.length, 2);
    if (results[0]!.type === 'tool_result') assert.equal(results[0]!.isError, false);
    if (results[1]!.type === 'tool_result') assert.equal(results[1]!.isError, true);
    const verdicts = messages.filter((message) => message.type === 'turn_state');
    // One turn: its tool errored, so the turn reads failed, not completed.
    assert.equal(verdicts.length, 1);
    if (verdicts[0]!.type === 'turn_state') assert.equal(verdicts[0]!.status, 'failed');
    // Every converted row namespaces generated ids; a tool call keeps its
    // source toolCallId because the result pairs with it by that id.
    for (const message of messages) {
      if (message.type === 'tool_call') continue;
      assert.match(message.id, /^cursor:composer-aaaa:/u);
    }
    const callIds = messages
      .filter((message) => message.type === 'tool_call')
      .map((message) => (message.type === 'tool_call' ? message.id : ''));
    assert.deepEqual(callIds, ['toolu_01', 'toolu_02']);
  });

  test('an empty headers list is an empty session, not an error', async () => {
    const home = await makeStateDb(fullFixture());
    const adapter = adapterFor(home);
    const session = await adapter.readSession('composer-bbbb');
    assert.deepEqual(session.messages, []);
    assert.equal(session.metadata.name, 'Empty session');
  });

  test('a header whose bubble was pruned is a gap, not a failure', async () => {
    const home = await makeStateDb(fullFixture());
    const adapter = adapterFor(home);
    const session = await adapter.readSession('composer-cccc');
    assert.deepEqual(session.messages, []);
  });

  test('a corrupt bubble row degrades to a gap while readable ones still import', async () => {
    const home = await makeStateDb([
      {
        composerId: 'composer-dddd',
        name: 'Half readable',
        headers: [
          { bubbleId: 'keep', type: 1, text: 'still here' },
          { bubbleId: 'broken', type: 2, text: 'unreadable' },
        ],
        corruptBubbles: ['broken'],
      },
    ]);
    const adapter = adapterFor(home);
    const session = await adapter.readSession('composer-dddd');
    assert.deepEqual(
      session.messages.map((message) => message.type),
      ['user', 'turn_state'],
    );
  });

  test('a missing session reads as not found', async () => {
    const home = await makeStateDb(fullFixture());
    const adapter = adapterFor(home);
    await assert.rejects(
      adapter.readSession('composer-zzzz'),
      (error: unknown) => error instanceof ExternalSessionNotFoundError,
    );
  });

  test('a hostile session id is refused before any database read', async () => {
    const home = await makeStateDb(fullFixture());
    const adapter = adapterFor(home);
    await assert.rejects(adapter.readSession("x' OR '1'='1"), /not usable/u);
  });

  test('all five limit kinds refuse oversized transcripts', async () => {
    const home = await makeStateDb(fullFixture());
    // records: the composer's header count caps the read before any bubble is
    // fetched.
    await assert.rejects(
      adapterFor(home, { maxRows: 2 }).readSession('composer-aaaa'),
      (error: unknown) =>
        error instanceof ExternalSessionLimitError && error.limit.kind === 'records',
    );
    // record_bytes: one oversized bubble refuses the session outright.
    const bigComposer: FixtureComposer[] = [
      {
        composerId: 'composer-big',
        name: 'Big bubble',
        headers: [{ bubbleId: 'big', type: 1, text: 'x'.repeat(4096) }],
      },
    ];
    const bigHome = await makeStateDb(bigComposer);
    await assert.rejects(
      adapterFor(bigHome, { maxRawBytes: 1024 }).readSession('composer-big'),
      (error: unknown) =>
        error instanceof ExternalSessionLimitError && error.limit.kind === 'record_bytes',
    );
    // transcript_bytes: the aggregate across in-budget rows refuses too.
    const spreadComposer: FixtureComposer[] = [
      {
        composerId: 'composer-spread',
        name: 'Spread',
        headers: [1, 2, 3].map((index) => ({
          bubbleId: `b${index}`,
          type: 2,
          text: 'y'.repeat(600),
        })),
      },
    ];
    const spreadHome = await makeStateDb(spreadComposer);
    await assert.rejects(
      adapterFor(spreadHome, { maxRawBytes: 1024 }).readSession('composer-spread'),
      (error: unknown) =>
        error instanceof ExternalSessionLimitError && error.limit.kind === 'transcript_bytes',
    );
    // messages: the converted message count caps the import.
    await assert.rejects(
      adapterFor(home, { maxMessages: 3 }).readSession('composer-aaaa'),
      (error: unknown) =>
        error instanceof ExternalSessionLimitError && error.limit.kind === 'messages',
    );
    // converted_bytes: the serialized size caps the import.
    await assert.rejects(
      adapterFor(home, { maxConvertedBytes: 512 }).readSession('composer-aaaa'),
      (error: unknown) =>
        error instanceof ExternalSessionLimitError && error.limit.kind === 'converted_bytes',
    );
  });

  test('error messages carry no source paths or transcript content', async () => {
    const home = await makeStateDb(fullFixture());
    const adapter = adapterFor(home, { maxRows: 2 });
    try {
      await adapter.readSession('composer-aaaa');
      assert.fail('expected the limit to refuse the session');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(home), false);
      assert.equal(error.message.includes('login'), false);
    }
    const badAdapter = new CursorSessionAdapter({
      cursorHome: home,
      stateDbPath: join(home, 'absent.vscdb'),
    });
    await assert.rejects(badAdapter.readSession('composer-aaaa'), /unavailable/u);
  });

  test('an oversized foreign title is sanitized, not verbatim', async () => {
    const home = await makeStateDb([
      { composerId: 'composer-title', name: `t${'i'.repeat(200_000)}tle` },
    ]);
    const adapter = adapterFor(home);
    const sessions = await adapter.listSessions();
    assert.equal(sessions.length, 1);
    assert.ok(sessions[0]!.name.length < 200_000);
  });

  test('joins the shared registry as the cursor source', async () => {
    const home = await makeStateDb(fullFixture());
    const registry = createExternalSessionAdapterRegistry({ cursor: { cursorHome: home } });
    const adapter = registry.get(CURSOR_SESSION_ADAPTER_ID);
    assert.ok(adapter);
    assert.equal(await adapter.detect(), true);
  });

  test('the composer row itself is budgeted before it is read', async () => {
    const home = await makeStateDb([
      {
        composerId: 'composer-fat',
        name: 'Fat composer',
        headers: [],
        // The composer record alone carries a padded foreign field that blows
        // a 1 KB budget without any bubbles at all.
        paddedBytes: 4096,
      },
    ]);
    await assert.rejects(
      adapterFor(home, { maxRawBytes: 1024 }).readSession('composer-fat'),
      (error: unknown) =>
        error instanceof ExternalSessionLimitError && error.limit.kind === 'record_bytes',
    );
  });

  test('the row budget counts the composer row against records', async () => {
    const home = await makeStateDb(fullFixture());
    // composer + 5 bubbles = 6 source rows; a limit of 6 must pass, 5 refuse.
    const session = await adapterFor(home, { maxRows: 6 }).readSession('composer-aaaa');
    assert.ok(session.messages.length > 0);
    await assert.rejects(
      adapterFor(home, { maxRows: 5 }).readSession('composer-aaaa'),
      (error: unknown) =>
        error instanceof ExternalSessionLimitError && error.limit.kind === 'records',
    );
  });

  test('default discovery roots follow the platform', () => {
    assert.equal(
      defaultCursorHome('darwin', '/Users/u'),
      '/Users/u/Library/Application Support/Cursor/User/globalStorage',
    );
    assert.equal(
      defaultCursorHome('linux', '/home/u'),
      '/home/u/.config/Cursor/User/globalStorage',
    );
    assert.equal(
      defaultCursorHome('win32', 'C:\\Users\\u'),
      'C:\\Users\\u\\AppData\\Roaming\\Cursor\\User\\globalStorage',
    );
  });

  test('open and read failures stay free of the source path', async () => {
    const home = await makeStateDb(fullFixture());
    await writeFile(join(home, 'state.vscdb'), 'not a database');
    const adapter = adapterFor(home);
    const error = await adapter.listSessions().then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes(home), false, error.message);
    assert.equal((error as NodeJS.ErrnoException).cause, undefined);
  });
});
