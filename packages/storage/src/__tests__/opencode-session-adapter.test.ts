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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeCanonicalMessage } from '@maka/core/session';
import { createExternalSessionAdapterRegistry } from '../external-session-adapters.js';
import {
  OPENCODE_SESSION_ADAPTER_ID,
  OpenCodeSessionAdapter,
} from '../opencode-session-adapter.js';

// Captured from opencode 1.18.21 with `opencode db`: one session that reads
// files, runs commands, writes one, and ends on an aborted message. Paths are
// rewritten and long tool output truncated; the record shapes are verbatim.
// Resolved against `src` rather than the compiled location: the fixture is
// data, so it is not emitted into `dist` beside the test that reads it.
const FIXTURE = fileURLToPath(
  new URL('../../src/__tests__/fixtures/opencode-session-1.18.21.json', import.meta.url),
);

interface Fixture {
  session: {
    id: string;
    title: string;
    directory: string;
    time_created: number;
    time_updated: number;
    time_archived: number | null;
    parent_id: string | null;
  };
  messages: { id: string; time_created: number; data: unknown }[];
  parts: { id: string; message_id: string; time_created: number; data: unknown }[];
}

describe('OpenCodeSessionAdapter', () => {
  test('reports absent when no database exists', async () => {
    await withOpenCodeHome(async (home) => {
      const adapter = new OpenCodeSessionAdapter({ opencodeHome: home });
      assert.equal(await adapter.detect(), false);
      assert.deepEqual(await adapter.listSessions(), []);
    });
  });

  test('an unreadable database is reported, not answered as an empty catalog', async () => {
    await withOpenCodeHome(async (home) => {
      await writeFile(join(home, 'opencode.db'), 'not a database');
      const adapter = new OpenCodeSessionAdapter({ opencodeHome: home });
      // The file is there, so the source is present; what fails is reading it.
      assert.equal(await adapter.detect(), true);
      await assert.rejects(adapter.listSessions(), /could not be (opened|read)/u);
      // Reporting "not found" here would send a user looking for a session
      // that exists in a database this could not open.
      await assert.rejects(adapter.readSession('ses_anything'), /could not be (opened|read)/u);
    });
  });

  test('a session whose transcript tables are missing fails instead of importing empty', async () => {
    await withOpenCodeHome(async (home) => {
      const fixture = await seed(home, undefined, { omitPartTable: true });
      const adapter = new OpenCodeSessionAdapter({ opencodeHome: home });
      // The session row still reads, so the catalog offers it...
      assert.equal((await adapter.listSessions()).length, 1);
      // ...and the import must not answer with a conversation of nothing. A
      // future opencode that renames these tables would otherwise silently
      // import every session as empty and report success.
      await assert.rejects(adapter.readSession(fixture.session.id), /could not be read/u);
    });
  });

  test('a user message with no prompt does not produce a turn holding no messages', async () => {
    await withOpenCodeHome(async (home) => {
      const fixture = await seed(home, (f) => {
        // One user message, no parts at all.
        f.messages = [{ id: 'msg_empty', time_created: 1, data: { role: 'user' } }];
        f.parts = [];
        return f;
      });
      const adapter = new OpenCodeSessionAdapter({ opencodeHome: home });
      const session = await adapter.readSession(fixture.session.id);
      assert.deepEqual(
        session.messages,
        [],
        'no turn_state is emitted for a turn that holds nothing',
      );
    });
  });

  test('lists a captured session with its directory and title', async () => {
    await withOpenCodeHome(async (home) => {
      const fixture = await seed(home);
      const adapter = new OpenCodeSessionAdapter({ opencodeHome: home });
      assert.equal(await adapter.detect(), true);
      const sessions = await adapter.listSessions();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.id, fixture.session.id);
      assert.equal(sessions[0]?.cwd, fixture.session.directory);
      assert.equal(sessions[0]?.name, fixture.session.title);
      assert.equal(sessions[0]?.createdAt, fixture.session.time_created);
    });
  });

  test('a cwd query selects by the session directory', async () => {
    await withOpenCodeHome(async (home) => {
      const fixture = await seed(home);
      const adapter = new OpenCodeSessionAdapter({ opencodeHome: home });
      assert.equal((await adapter.listSessions({ cwd: fixture.session.directory })).length, 1);
      assert.equal((await adapter.listSessions({ cwd: '/somewhere/else' })).length, 0);
    });
  });

  test('child sessions are neither listed nor readable as conversations', async () => {
    await withOpenCodeHome(async (home) => {
      const fixture = await seed(home, (f) => {
        f.session.parent_id = 'ses_parent';
        return f;
      });
      const adapter = new OpenCodeSessionAdapter({ opencodeHome: home });
      assert.deepEqual(await adapter.listSessions(), []);
      await assert.rejects(adapter.readSession(fixture.session.id), /child of another session/u);
    });
  });

  test('converts the captured session into canonical Maka messages', async () => {
    await withOpenCodeHome(async (home) => {
      const fixture = await seed(home);
      const adapter = new OpenCodeSessionAdapter({ opencodeHome: home });
      const session = await adapter.readSession(fixture.session.id);

      assert.equal(session.sourceSessionId, fixture.session.id);
      assert.equal(session.metadata.cwd, fixture.session.directory);
      // Every emitted message has to survive Maka's own decoder, or the
      // import would be rejected at the persistence boundary rather than here.
      for (const message of session.messages) {
        assert.ok(decodeCanonicalMessage(message), `undecodable: ${message.type}`);
      }

      const kinds = new Set(session.messages.map((message) => message.type));
      assert.ok(kinds.has('user'));
      assert.ok(kinds.has('assistant'));
      assert.ok(kinds.has('tool_call'));
      assert.ok(kinds.has('tool_result'));
      assert.ok(kinds.has('turn_state'));
    });
  });

  test('pairs every tool result with the call it answers', async () => {
    await withOpenCodeHome(async (home) => {
      const fixture = await seed(home);
      const adapter = new OpenCodeSessionAdapter({ opencodeHome: home });
      const session = await adapter.readSession(fixture.session.id);

      const callIds = new Set(
        session.messages.filter((m) => m.type === 'tool_call').map((m) => m.id),
      );
      const results = session.messages.filter((m) => m.type === 'tool_result');
      assert.ok(results.length > 0, 'the capture contains completed tool calls');
      for (const result of results) {
        assert.ok(
          callIds.has((result as { toolUseId: string }).toolUseId),
          'every result names a call that was emitted',
        );
      }
    });
  });

  test('reasoning is carried as thinking rather than as reply text', async () => {
    await withOpenCodeHome(async (home) => {
      const fixture = await seed(home);
      const adapter = new OpenCodeSessionAdapter({ opencodeHome: home });
      const session = await adapter.readSession(fixture.session.id);

      const thinking = session.messages.filter(
        (m) => m.type === 'assistant' && (m as { thinking?: unknown }).thinking !== undefined,
      );
      assert.ok(thinking.length > 0, 'the capture contains reasoning parts');
      for (const message of thinking) {
        assert.equal((message as { text: string }).text, '');
      }
    });
  });

  test('an aborted final message closes its turn as aborted, not completed', async () => {
    await withOpenCodeHome(async (home) => {
      const fixture = await seed(home);
      const adapter = new OpenCodeSessionAdapter({ opencodeHome: home });
      const session = await adapter.readSession(fixture.session.id);

      const states = session.messages.filter((m) => m.type === 'turn_state') as {
        status: string;
      }[];
      assert.ok(states.length > 0);
      // The capture ends on a message carrying MessageAbortedError.
      assert.equal(states.at(-1)?.status, 'aborted');
      // Earlier turns finished on `finish: "stop"` and must not be dragged
      // into the last one's verdict.
      assert.ok(
        states.slice(0, -1).some((state) => state.status === 'completed'),
        'completed turns are recorded as completed',
      );
    });
  });

  test('a turn left waiting on a tool call is aborted rather than completed', async () => {
    await withOpenCodeHome(async (home) => {
      // Drop everything after the first tool-calls message, which is what a
      // run killed between a call and its answer leaves behind.
      const fixture = await seed(home, (f) => {
        const cut = f.messages.findIndex(
          (m) => (m.data as { finish?: string }).finish === 'tool-calls',
        );
        assert.ok(cut > 0, 'the capture has a tool-calls message');
        const kept = f.messages.slice(0, cut + 1);
        const keptIds = new Set(kept.map((m) => m.id));
        f.messages = kept;
        f.parts = f.parts.filter((p) => keptIds.has(p.message_id));
        return f;
      });
      const adapter = new OpenCodeSessionAdapter({ opencodeHome: home });
      const session = await adapter.readSession(fixture.session.id);
      const states = session.messages.filter((m) => m.type === 'turn_state') as {
        status: string;
      }[];
      assert.equal(states.at(-1)?.status, 'aborted');
    });
  });

  test('an in-flight tool call is imported without a synthesised result', async () => {
    await withOpenCodeHome(async (home) => {
      const fixture = await seed(home, (f) => {
        for (const part of f.parts) {
          const data = part.data as { type?: string; state?: { status?: string } };
          if (data.type === 'tool' && data.state) data.state.status = 'running';
        }
        return f;
      });
      const adapter = new OpenCodeSessionAdapter({ opencodeHome: home });
      const session = await adapter.readSession(fixture.session.id);
      assert.ok(session.messages.some((m) => m.type === 'tool_call'));
      assert.equal(
        session.messages.filter((m) => m.type === 'tool_result').length,
        0,
        'no result is invented for a call that never answered',
      );
    });
  });

  test('a terminal tool failure is imported as an errored result, not a dangling call', async () => {
    await withOpenCodeHome(async (home) => {
      // The reviewer's reproduction: a failed call inside a step that a later
      // `finish: "stop"` closes. Without a result the transcript asserts the
      // tool never replied, inside a turn recorded as completed.
      const fixture = await seed(home, (f) => {
        f.messages = [
          { id: 'm_user', time_created: 1, data: { role: 'user' } },
          {
            id: 'm_call',
            time_created: 2,
            data: { role: 'assistant', finish: 'tool-calls', modelID: 'm' },
          },
          {
            id: 'm_stop',
            time_created: 3,
            data: { role: 'assistant', finish: 'stop', modelID: 'm' },
          },
        ];
        f.parts = [
          {
            id: 'p_prompt',
            message_id: 'm_user',
            time_created: 1,
            data: { type: 'text', text: 'go' },
          },
          {
            id: 'p_tool',
            message_id: 'm_call',
            time_created: 2,
            data: {
              type: 'tool',
              tool: 'bash',
              callID: 'call_failed',
              state: { status: 'error', input: { command: 'false' }, error: 'exit 1' },
            },
          },
          {
            id: 'p_text',
            message_id: 'm_stop',
            time_created: 3,
            data: { type: 'text', text: 'done' },
          },
        ];
        return f;
      });
      const adapter = new OpenCodeSessionAdapter({ opencodeHome: home });
      const session = await adapter.readSession(fixture.session.id);

      const result = session.messages.find((m) => m.type === 'tool_result') as
        | { toolUseId: string; isError: boolean; content: { text: string } }
        | undefined;
      assert.ok(result, 'a failed call still answered, and the answer is a failure');
      assert.equal(result?.toolUseId, 'call_failed');
      assert.equal(result?.isError, true);
      assert.equal(result?.content.text, 'exit 1');
    });
  });

  test('a call still running when the session was written gets no result', async () => {
    await withOpenCodeHome(async (home) => {
      const fixture = await seed(home, (f) => {
        f.messages = [
          { id: 'm_user', time_created: 1, data: { role: 'user' } },
          {
            id: 'm_call',
            time_created: 2,
            data: { role: 'assistant', finish: 'tool-calls', modelID: 'm' },
          },
        ];
        f.parts = [
          {
            id: 'p_prompt',
            message_id: 'm_user',
            time_created: 1,
            data: { type: 'text', text: 'go' },
          },
          {
            id: 'p_tool',
            message_id: 'm_call',
            time_created: 2,
            data: {
              type: 'tool',
              tool: 'bash',
              callID: 'call_running',
              state: { status: 'running', input: {} },
            },
          },
        ];
        return f;
      });
      const adapter = new OpenCodeSessionAdapter({ opencodeHome: home });
      const session = await adapter.readSession(fixture.session.id);
      assert.ok(session.messages.some((m) => m.type === 'tool_call'));
      assert.equal(session.messages.filter((m) => m.type === 'tool_result').length, 0);
    });
  });

  test('parts keep the order the session recorded them in', async () => {
    await withOpenCodeHome(async (home) => {
      // opencode accepts text -> reasoning -> tool and its own replay keeps
      // that order. Bucketing by type would emit reasoning first.
      const fixture = await seed(home, (f) => {
        f.messages = [
          { id: 'm_user', time_created: 1, data: { role: 'user' } },
          {
            id: 'm_reply',
            time_created: 2,
            data: { role: 'assistant', finish: 'stop', modelID: 'm' },
          },
        ];
        f.parts = [
          {
            id: 'p_prompt',
            message_id: 'm_user',
            time_created: 1,
            data: { type: 'text', text: 'go' },
          },
          {
            id: 'p1',
            message_id: 'm_reply',
            time_created: 2,
            data: { type: 'text', text: 'first' },
          },
          {
            id: 'p2',
            message_id: 'm_reply',
            time_created: 3,
            data: { type: 'reasoning', text: 'second' },
          },
          {
            id: 'p3',
            message_id: 'm_reply',
            time_created: 4,
            data: {
              type: 'tool',
              tool: 'bash',
              callID: 'call_third',
              state: { status: 'completed', input: {}, output: 'ok' },
            },
          },
        ];
        return f;
      });
      const adapter = new OpenCodeSessionAdapter({ opencodeHome: home });
      const session = await adapter.readSession(fixture.session.id);
      const reply = session.messages.filter((m) => m.type !== 'user');
      assert.deepEqual(
        reply.slice(0, 4).map((m) => {
          if (m.type !== 'assistant') return m.type;
          return (m as { thinking?: unknown }).thinking !== undefined ? 'thinking' : 'text';
        }),
        ['text', 'thinking', 'tool_call', 'tool_result'],
      );
    });
  });

  test('an undecodable transcript row fails the import rather than truncating it', async () => {
    await withOpenCodeHome(async (home) => {
      const fixture = await seed(home, (f) => {
        f.messages = [{ id: 'm_user', time_created: 1, data: { role: 'user' } }];
        f.parts = [];
        return f;
      });
      // Replace the message payload with something that is not JSON.
      const db = new DatabaseSync(join(home, 'opencode.db'));
      try {
        db.prepare('UPDATE message SET data = ? WHERE id = ?').run('{not json', 'm_user');
      } finally {
        db.close();
      }
      const adapter = new OpenCodeSessionAdapter({ opencodeHome: home });
      await assert.rejects(adapter.readSession(fixture.session.id), /could not be read/u);
    });
  });

  test('the registry exposes the adapter under its own id', async () => {
    const registry = createExternalSessionAdapterRegistry();
    const adapter = registry.get(OPENCODE_SESSION_ADAPTER_ID);
    assert.ok(adapter);
    assert.equal(adapter?.id, OPENCODE_SESSION_ADAPTER_ID);
  });
});

async function withOpenCodeHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'maka-opencode-adapter-'));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function seed(
  home: string,
  mutate?: (fixture: Fixture) => Fixture,
  options: { omitPartTable?: boolean } = {},
): Promise<Fixture> {
  const raw = JSON.parse(await readFile(FIXTURE, 'utf8')) as Fixture;
  const fixture = mutate ? mutate(raw) : raw;
  const db = new DatabaseSync(join(home, 'opencode.db'));
  try {
    db.exec(`
      CREATE TABLE session (
        id text PRIMARY KEY, project_id text, workspace_id text, parent_id text,
        slug text, directory text NOT NULL, path text, title text,
        version text, time_created integer, time_updated integer,
        time_compacting integer, time_archived integer
      );
      CREATE TABLE message (
        id text PRIMARY KEY, session_id text NOT NULL,
        time_created integer NOT NULL, time_updated integer, data text NOT NULL
      );
    `);
    if (!options.omitPartTable) {
      db.exec(`
        CREATE TABLE part (
          id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
          time_created integer NOT NULL, time_updated integer, data text NOT NULL
        );
      `);
    }
    db.prepare(
      'INSERT INTO session (id, parent_id, directory, title, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      fixture.session.id,
      fixture.session.parent_id,
      fixture.session.directory,
      fixture.session.title,
      fixture.session.time_created,
      fixture.session.time_updated,
      fixture.session.time_archived,
    );
    const message = db.prepare(
      'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
    );
    for (const row of fixture.messages) {
      message.run(row.id, fixture.session.id, row.time_created, JSON.stringify(row.data));
    }
    if (options.omitPartTable) return fixture;
    const part = db.prepare(
      'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
    );
    for (const row of fixture.parts) {
      part.run(
        row.id,
        row.message_id,
        fixture.session.id,
        row.time_created,
        JSON.stringify(row.data),
      );
    }
  } finally {
    db.close();
  }
  return fixture;
}
