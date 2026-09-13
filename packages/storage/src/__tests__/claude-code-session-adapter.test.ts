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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { decodeCanonicalMessage, type StoredMessage } from '@maka/core/session';
import { ClaudeCodeSessionAdapter } from '../claude-code-session-adapter.js';
import { createExternalSessionAdapterRegistry } from '../external-session-adapters.js';

/**
 * The load-bearing question for this adapter is which turns get a terminal
 * `turn_state`. The Ledger refuses a reconstructed terminal that no record
 * corroborates (`runtime-ledger-repair.ts`), so emitting one for a turn that
 * was killed mid-answer would import a crash as a clean completion — and
 * emitting none for a turn that did finish leaves every imported Run repaired
 * to `failed`.
 *
 * `stop_reason` is the record that answers it. Measured across 1130 local
 * transcripts: 86% of turns carry a terminal one, and the rest end with no
 * assistant reply at all or stopped at `tool_use` — genuinely unfinished.
 */

const CWD = '/workspace/project';

describe('ClaudeCodeSessionAdapter', () => {
  test('a turn that stopped with end_turn imports as completed', async () => {
    await withClaudeHome(async (home) => {
      await seed(home, 'aaaaaaaa-0000-4000-8000-000000000001', [
        userRecord('ship the parser'),
        assistantRecord({ text: 'Done.', stopReason: 'end_turn' }),
      ]);
      const messages = await read(home, 'aaaaaaaa-0000-4000-8000-000000000001');
      const state = terminalState(messages);
      assert.equal(state?.status, 'completed');
    });
  });

  test('a turn stopped at tool_use with no result is recorded as a snapshot cutoff', async () => {
    // The process died between the call and its result. Reporting `completed`
    // here is the failure mode this adapter exists to avoid.
    await withClaudeHome(async (home) => {
      await seed(home, 'aaaaaaaa-0000-4000-8000-000000000002', [
        userRecord('read the file'),
        assistantRecord({ toolUse: { id: 'toolu_1', name: 'Read' }, stopReason: 'tool_use' }),
      ]);
      const messages = await read(home, 'aaaaaaaa-0000-4000-8000-000000000002');
      const state = terminalState(messages);
      assert.equal(state?.status, 'aborted');
      assert.equal(state?.abortSource, 'external_session_snapshot');
      // The call itself still imports — the conversation is real up to the cut.
      assert.equal(messages.filter((m) => m.type === 'tool_call').length, 1);
    });
  });

  test('a prompt with no answer at all is recorded as a snapshot cutoff', async () => {
    await withClaudeHome(async (home) => {
      await seed(home, 'aaaaaaaa-0000-4000-8000-000000000003', [userRecord('are you there?')]);
      const messages = await read(home, 'aaaaaaaa-0000-4000-8000-000000000003');
      const state = terminalState(messages);
      assert.equal(state?.status, 'aborted');
      assert.equal(state?.abortSource, 'external_session_snapshot');
      assert.equal(messages.filter((m) => m.type === 'user').length, 1);
    });
  });

  test('an interrupt notice imports as aborted, not as a user message', async () => {
    await withClaudeHome(async (home) => {
      await seed(home, 'aaaaaaaa-0000-4000-8000-000000000004', [
        userRecord('start the long job'),
        assistantRecord({ text: 'Working…', stopReason: 'tool_use' }),
        userRecord('[Request interrupted by user for tool use]'),
      ]);
      const messages = await read(home, 'aaaaaaaa-0000-4000-8000-000000000004');
      const state = terminalState(messages);
      assert.equal(state?.status, 'aborted');
      // The notice is the harness speaking, not the human. One user message.
      assert.equal(messages.filter((m) => m.type === 'user').length, 1);
    });
  });

  test('an API error imports as failed', async () => {
    await withClaudeHome(async (home) => {
      await seed(home, 'aaaaaaaa-0000-4000-8000-000000000005', [
        userRecord('summarize this'),
        { ...assistantRecord({ text: 'API Error: overloaded' }), isApiErrorMessage: true },
      ]);
      const messages = await read(home, 'aaaaaaaa-0000-4000-8000-000000000005');
      const state = terminalState(messages);
      assert.equal(state?.status, 'failed');
      assert.equal(state?.errorClass, 'claude_code_api_error');
    });
  });

  test('tool results arrive as user records and must not import as user turns', async () => {
    await withClaudeHome(async (home) => {
      await seed(home, 'aaaaaaaa-0000-4000-8000-000000000006', [
        userRecord('read it'),
        assistantRecord({ toolUse: { id: 'toolu_9', name: 'Read' }, stopReason: 'tool_use' }),
        toolResultRecord('toolu_9', 'file contents'),
        assistantRecord({ text: 'Here it is.', stopReason: 'end_turn' }),
      ]);
      const messages = await read(home, 'aaaaaaaa-0000-4000-8000-000000000006');
      assert.equal(messages.filter((m) => m.type === 'user').length, 1);
      const results = messages.filter((m) => m.type === 'tool_result');
      assert.equal(results.length, 1);
      // The result must point back at the call, or the pair renders detached.
      assert.equal(results[0]?.type === 'tool_result' ? results[0].toolUseId : null, 'toolu_9');
    });
  });

  test('a turn cut off by max_tokens is not reported as completed', async () => {
    // `max_tokens` does say generation stopped — because the answer hit the
    // output limit mid-sentence. Treating "stopped" as "finished" is the
    // specific mistake this adapter is built to avoid.
    await withClaudeHome(async (home) => {
      await seed(home, 'aaaaaaaa-0000-4000-8000-000000000011', [
        userRecord('write the whole file'),
        assistantRecord({ text: 'Here is the beg', stopReason: 'max_tokens' }),
      ]);
      const messages = await read(home, 'aaaaaaaa-0000-4000-8000-000000000011');
      const state = terminalState(messages);
      // Cut off, not completed — and named as the snapshot's edge rather than
      // as a user Stop.
      assert.equal(state?.status, 'aborted');
      assert.equal(state?.abortSource, 'external_session_snapshot');
    });
  });

  test('a tool result with no tool_use_id is dropped rather than left detached', async () => {
    // Minting an id produces a result guaranteed not to pair with any call —
    // a detached row in the transcript view, worse than an absent one.
    await withClaudeHome(async (home) => {
      await seed(home, 'aaaaaaaa-0000-4000-8000-000000000012', [
        userRecord('read it'),
        assistantRecord({ toolUse: { id: 'toolu_a', name: 'Read' }, stopReason: 'tool_use' }),
        {
          type: 'user',
          timestamp: '2026-08-01T00:00:02.000Z',
          message: { role: 'user', content: [{ type: 'tool_result', content: 'orphan' }] },
        },
        assistantRecord({ text: 'done', stopReason: 'end_turn' }),
      ]);
      const messages = await read(home, 'aaaaaaaa-0000-4000-8000-000000000012');
      assert.equal(messages.filter((m) => m.type === 'tool_result').length, 0);
      // Every result that does survive must name a call that is present.
      const callIds = new Set(messages.filter((m) => m.type === 'tool_call').map((m) => m.id));
      for (const message of messages) {
        if (message.type === 'tool_result') assert.ok(callIds.has(message.toolUseId));
      }
    });
  });

  test('turn ids are dense and never collide with message ids', async () => {
    await withClaudeHome(async (home) => {
      await seed(home, 'aaaaaaaa-0000-4000-8000-000000000013', [
        userRecord('one'),
        assistantRecord({ text: 'a', stopReason: 'end_turn' }),
        userRecord('two'),
        assistantRecord({ text: 'b', stopReason: 'end_turn' }),
      ]);
      const messages = await read(home, 'aaaaaaaa-0000-4000-8000-000000000013');
      const turnIds = [...new Set(messages.map((m) => m.turnId))];
      assert.deepEqual(turnIds, [
        'claude-code:aaaaaaaa-0000-4000-8000-000000000013:turn:0',
        'claude-code:aaaaaaaa-0000-4000-8000-000000000013:turn:1',
      ]);
      const messageIds = new Set(messages.map((m) => m.id));
      for (const turnId of turnIds) assert.equal(messageIds.has(turnId), false);
    });
  });

  test('a record written twice emits one message, not two', async () => {
    // A transcript is an append log: resume and recovery can replay a line.
    // Persisting both copies duplicates the prompt in canonical history, and
    // re-importing produces the same result — it is not recoverable after the
    // fact.
    await withClaudeHome(async (home) => {
      const prompt = { ...userRecord('build the thing'), uuid: 'u-1' };
      await seed(home, 'aaaaaaaa-0000-4000-8000-000000000014', [
        prompt,
        prompt,
        assistantRecord({ text: 'Done.', stopReason: 'end_turn' }),
      ]);
      const messages = await read(home, 'aaaaaaaa-0000-4000-8000-000000000014');
      assert.equal(messages.filter((m) => m.type === 'user').length, 1);
      assert.equal(new Set(messages.map((m) => m.turnId)).size, 1);
    });
  });

  test('one response is assembled from every fragment, calls before their results', async () => {
    // The real shape, measured across 1130 local transcripts: a response is
    // written as several records sharing `message.id`, the pieces separated by
    // the results of calls the earlier pieces made. In 4093 of 14095
    // responses the visible text is NOT in the first fragment — so a guard
    // that emits prose at the first record and suppresses it afterwards drops
    // the reply.
    //
    // Both calls share one `message.id`, so they came from one API response
    // and were issued together however the log interleaved them with the
    // results arriving: they are one assistant step, and both precede both
    // results.
    await withClaudeHome(async (home) => {
      const fragment = (blocks: Parameters<typeof assistantFragment>[1]) =>
        assistantFragment('msg_shared', blocks);
      await seed(home, 'aaaaaaaa-0000-4000-8000-000000000015', [
        userRecord('read both files'),
        fragment([{ type: 'thinking', thinking: 'Two files to read.' }]),
        fragment([{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }]),
        toolResultRecord('toolu_1', 'first file'),
        // The text arrives last, after a call and its result — the 4093 case.
        fragment([
          { type: 'text', text: 'Reading them now.' },
          { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} },
        ]),
        toolResultRecord('toolu_2', 'second file'),
        assistantRecord({ text: 'Both read.', stopReason: 'end_turn' }),
      ]);
      const messages = await read(home, 'aaaaaaaa-0000-4000-8000-000000000015');

      const assistants = messages.filter(
        (m): m is Extract<StoredMessage, { type: 'assistant' }> => m.type === 'assistant',
      );
      // The reply survives even though no fragment before it carried text, and
      // the response is still one reply rather than one per fragment.
      assert.deepEqual(
        assistants.filter((m) => m.text.length > 0).map((m) => m.text),
        ['Reading them now.', 'Both read.'],
      );
      // The thinking from the first fragment belongs to the same response.
      assert.deepEqual(
        assistants.filter((m) => m.thinking).map((m) => m.thinking?.text),
        ['Two files to read.'],
      );

      const order = messages
        .filter((m) => m.type === 'tool_call' || m.type === 'tool_result')
        .map((m) => (m.type === 'tool_call' ? `call:${m.id}` : `result:${m.toolUseId}`));
      assert.deepEqual(order, ['call:toolu_1', 'call:toolu_2', 'result:toolu_1', 'result:toolu_2']);
    });
  });

  test('a sidechain transcript is neither listed nor readable', async () => {
    // Sub-agent transcripts are whole files, so exclusion is per file.
    // Importing one would present a fragment of a conversation as a whole.
    await withClaudeHome(async (home) => {
      await seed(home, 'aaaaaaaa-0000-4000-8000-000000000007', [
        { ...userRecord('sub-agent work'), isSidechain: true },
        { ...assistantRecord({ text: 'done', stopReason: 'end_turn' }), isSidechain: true },
      ]);
      const adapter = new ClaudeCodeSessionAdapter({ claudeHome: home });
      assert.deepEqual(await adapter.listSessions(), []);
      await assert.rejects(
        () => adapter.readSession('aaaaaaaa-0000-4000-8000-000000000007'),
        /sidechain/u,
      );
    });
  });

  test('a text query filters the source, before paging', async () => {
    // The catalog pages 16 at a time over a source with 1128 sessions here, so
    // the term has to reach the adapter. A filter applied to an assembled page
    // would search the rows already fetched, which is worse than none.
    await withClaudeHome(async (home) => {
      await seed(
        home,
        'aaaaaaaa-0000-4000-8000-000000000030',
        [userRecord('fix the parser'), assistantRecord({ text: 'ok', stopReason: 'end_turn' })],
        '/Users/someone/compiler',
      );
      await seed(
        home,
        'aaaaaaaa-0000-4000-8000-000000000031',
        [userRecord('write the docs'), assistantRecord({ text: 'ok', stopReason: 'end_turn' })],
        '/Users/someone/handbook',
      );
      const adapter = new ClaudeCodeSessionAdapter({ claudeHome: home });

      const byTitle = await adapter.listSessions({ text: 'parser' });
      assert.deepEqual(
        byTitle.map((s) => s.id),
        ['aaaaaaaa-0000-4000-8000-000000000030'],
      );

      // The path is the other half of what a user remembers.
      const byPath = await adapter.listSessions({ text: 'handbook' });
      assert.deepEqual(
        byPath.map((s) => s.id),
        ['aaaaaaaa-0000-4000-8000-000000000031'],
      );

      assert.equal((await adapter.listSessions({ text: 'kubernetes' })).length, 0);
      // A blank box is not a filter.
      assert.equal((await adapter.listSessions({ text: '  ' })).length, 2);
      assert.equal((await adapter.listSessions()).length, 2);
    });
  });

  test('a rewritten transcript is re-read, a deleted one drops out', async () => {
    // Listing parses every transcript, and the catalog is listed once per
    // search term — so summaries are cached against the file's own mtime and
    // size. The risk a cache carries is serving a stale answer, so both
    // directions are pinned: an appended transcript must be re-read, and a
    // removed one must not survive in the map.
    await withClaudeHome(async (home) => {
      const id = 'aaaaaaaa-0000-4000-8000-000000000033';
      await seed(home, id, [
        userRecord('first title'),
        assistantRecord({ text: 'ok', stopReason: 'end_turn' }),
      ]);
      const adapter = new ClaudeCodeSessionAdapter({ claudeHome: home });
      assert.equal((await adapter.listSessions())[0]?.name, 'first title');

      // Rewritten with a different title. Same path, new content.
      await seed(home, id, [
        userRecord('second title'),
        assistantRecord({ text: 'ok', stopReason: 'end_turn' }),
      ]);
      assert.equal(
        (await adapter.listSessions())[0]?.name,
        'second title',
        'a changed transcript must not keep its cached summary',
      );

      await rm(join(home, 'projects', CWD.replace(/\//gu, '-'), `${id}.jsonl`));
      assert.deepEqual(await adapter.listSessions(), []);
    });
  });

  test('a project query tolerates a trailing separator', async () => {
    // The adapter compared raw strings, so the same project reached with a
    // trailing slash answered "no such project". Both sources now share one
    // path rule.
    await withClaudeHome(async (home) => {
      await seed(
        home,
        'aaaaaaaa-0000-4000-8000-000000000032',
        [userRecord('one'), assistantRecord({ text: 'ok', stopReason: 'end_turn' })],
        '/Users/someone/my-project',
      );
      const adapter = new ClaudeCodeSessionAdapter({ claudeHome: home });
      assert.equal((await adapter.listSessions({ cwd: '/Users/someone/my-project/' })).length, 1);
    });
  });

  test('a project query matches the record cwd, not the mangled directory name', async () => {
    // `-Users-a-b` cannot be reversed — it is ambiguous between `/Users/a/b`
    // and `/Users/a-b` — so only a record's own `cwd` can answer this.
    await withClaudeHome(async (home) => {
      await seed(
        home,
        'aaaaaaaa-0000-4000-8000-000000000008',
        [userRecord('one'), assistantRecord({ text: 'ok', stopReason: 'end_turn' })],
        '/Users/someone/my-project',
      );
      const adapter = new ClaudeCodeSessionAdapter({ claudeHome: home });
      assert.equal((await adapter.listSessions({ cwd: '/Users/someone/my-project' })).length, 1);
      assert.equal((await adapter.listSessions({ cwd: '/Users/someone/my' })).length, 0);
    });
  });

  test('every emitted message survives the canonical decoder', async () => {
    // The importer round-trips adapter output through `decodeStoredMessage`,
    // so a shape this adapter invents is rejected at persistence rather than
    // stored. Asserting it here names the adapter as the culprit instead.
    await withClaudeHome(async (home) => {
      await seed(home, 'aaaaaaaa-0000-4000-8000-000000000009', [
        userRecord('do the thing'),
        assistantRecord({ thinking: 'considering', stopReason: 'tool_use' }),
        assistantRecord({ toolUse: { id: 'toolu_x', name: 'Bash' }, stopReason: 'tool_use' }),
        toolResultRecord('toolu_x', 'ok'),
        assistantRecord({ text: 'Finished.', stopReason: 'end_turn' }),
      ]);
      const messages = await read(home, 'aaaaaaaa-0000-4000-8000-000000000009');
      assert.ok(messages.length > 0);
      for (const message of messages) {
        assert.doesNotThrow(() => decodeCanonicalMessage(JSON.parse(JSON.stringify(message))));
      }
    });
  });

  test('a corrupt line does not fail an otherwise readable transcript', async () => {
    await withClaudeHome(async (home) => {
      const dir = join(home, 'projects', '-workspace-project');
      await mkdir(dir, { recursive: true });
      const lines = [
        JSON.stringify(userRecord('first')),
        '{ this is not json',
        JSON.stringify(assistantRecord({ text: 'second', stopReason: 'end_turn' })),
      ];
      await writeFile(
        join(dir, 'aaaaaaaa-0000-4000-8000-000000000010.jsonl'),
        `${lines.join('\n')}\n`,
      );
      const messages = await read(home, 'aaaaaaaa-0000-4000-8000-000000000010');
      assert.equal(terminalState(messages)?.status, 'completed');
    });
  });

  test('is registered by the internal default registry', () => {
    const registry = createExternalSessionAdapterRegistry();
    assert.equal(registry.require('claude-code').id, 'claude-code');
    // Codex must still be there — this adds a source rather than replacing one.
    assert.equal(registry.require('codex').id, 'codex');
  });
});

/* ------------------------------------------------------------------ */

function terminalState(
  messages: readonly StoredMessage[],
): Extract<StoredMessage, { type: 'turn_state' }> | undefined {
  return messages.find(
    (message): message is Extract<StoredMessage, { type: 'turn_state' }> =>
      message.type === 'turn_state',
  );
}

async function read(home: string, sessionId: string): Promise<readonly StoredMessage[]> {
  const adapter = new ClaudeCodeSessionAdapter({ claudeHome: home });
  return (await adapter.readSession(sessionId)).messages;
}

function userRecord(text: string): Record<string, unknown> {
  return {
    type: 'user',
    cwd: CWD,
    timestamp: '2026-08-01T00:00:00.000Z',
    message: { role: 'user', content: text },
  };
}

function toolResultRecord(toolUseId: string, text: string): Record<string, unknown> {
  return {
    type: 'user',
    cwd: CWD,
    timestamp: '2026-08-01T00:00:02.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }],
    },
  };
}

function assistantFragment(
  messageId: string,
  content: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    type: 'assistant',
    cwd: CWD,
    timestamp: '2026-08-01T00:00:01.000Z',
    message: {
      role: 'assistant',
      id: messageId,
      model: 'claude-opus-5',
      content,
      stop_reason: 'tool_use',
    },
  };
}

function assistantRecord(input: {
  text?: string;
  thinking?: string;
  toolUse?: { id: string; name: string };
  stopReason?: string;
}): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (input.thinking) content.push({ type: 'thinking', thinking: input.thinking });
  if (input.text) content.push({ type: 'text', text: input.text });
  if (input.toolUse) {
    content.push({ type: 'tool_use', id: input.toolUse.id, name: input.toolUse.name, input: {} });
  }
  return {
    type: 'assistant',
    cwd: CWD,
    timestamp: '2026-08-01T00:00:01.000Z',
    message: {
      role: 'assistant',
      id: 'msg_test',
      model: 'claude-opus-5',
      content,
      ...(input.stopReason ? { stop_reason: input.stopReason } : {}),
    },
  };
}

async function seed(
  home: string,
  sessionId: string,
  records: readonly Record<string, unknown>[],
  cwd = CWD,
): Promise<void> {
  const dir = join(home, 'projects', cwd.replace(/\//gu, '-'));
  await mkdir(dir, { recursive: true });
  const lines = records.map((record) => JSON.stringify({ ...record, cwd }));
  await writeFile(join(dir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`);
}

async function withClaudeHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'maka-claude-home-'));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
