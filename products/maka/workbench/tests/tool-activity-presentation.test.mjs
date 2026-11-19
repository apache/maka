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
import { registerHooks } from 'node:module';
import test from 'node:test';
import { structuredToolPatch, textToolPatch } from '../app/toolPatch.ts';

const app = new URL('../app/', import.meta.url);
const locale = `
  export const currentLocale = () => 'en';
  export const localizedPresentation = value => value;
  export const displayText = ({ fallback }) => fallback;
  export const tr = (key, values = {}) =>
    key.replace(/\\{(\\w+)\\}/g, (placeholder, name) => values[name] ?? placeholder);
`;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(app.href)) {
      if (specifier === './locale')
        return { url: `data:text/javascript,${encodeURIComponent(locale)}`, shortCircuit: true };
      if (specifier.startsWith('.') && !/\.\w+$/.test(specifier))
        return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});
const { activityFailure, activityPresentation, activityProjection, activityTitle } = await import(
  new URL('toolActivityPresentation.ts', app)
);
const { toolResult } = await import(new URL('toolCards.ts', app));
const { providerSearch } = await import(new URL('providerSearch.ts', app));
hooks.deregister();

const sendKey = 'maka.agent.Agent@1/send';
const workKey = 'maka.agent.Agent@1/work';

test('a queued message says what was sent, where it is going and that it is queued', () => {
  assert.equal(
    activityTitle({ name: 'SessionSend', presentation: sendKey }),
    'Send message to agent',
  );
  const send = activityPresentation(sendKey);
  assert.deepEqual(
    activityProjection(
      send,
      'arguments',
      { sessionId: 'opaque-session-id', message: 'Check the compiler output.' },
      { returned: true, sessionTitle: () => 'Compiler investigation' },
    ).sections.map(({ label, text }) => [label, text]),
    [
      ['Message', 'Check the compiler output.'],
      ['Conversation', 'Compiler investigation'],
    ],
  );
  assert.deepEqual(
    activityProjection(
      send,
      'result',
      { kind: 'queued', messageId: 'opaque-message-id', completion: 'registered' },
      { returned: true },
    ).sections.map(({ text }) => text),
    ['Message queued', 'Notify when work ends'],
  );
});

test('a rejected send shows its reason and a Host error shows a readable diagnosis', () => {
  const rejected = activityProjection(
    activityPresentation(sendKey),
    'result',
    { kind: 'rejected', reason: 'model_unavailable' },
    { returned: true },
  );
  assert.deepEqual(
    rejected.sections.map(({ text, tone }) => [text, tone]),
    [['Selected model is unavailable', 'error']],
  );
  for (const diagnostic of [
    'agent_session_unavailable',
    'Session or Room was not found or is archived; check the ID with SessionList',
  ]) {
    assert.deepEqual(
      activityFailure({
        receipt: {
          kind: 'recorded',
          outcome: {
            kind: 'returned',
            result: { kind: 'failure', diagnostic },
          },
        },
      }),
      { kind: 'failure', message: 'Conversation is unavailable' },
    );
  }
});

test('checking work shows the captured wait or the final response', () => {
  const work = activityPresentation(workKey);
  const render = (state, answer) =>
    activityProjection(
      work,
      'result',
      { kind: 'delivered', execution: { state }, answer },
      { returned: true },
    ).sections.map(({ text }) => text);
  assert.deepEqual(render({ kind: 'waiting', waits: [{ kind: 'approval' }] }, null), [
    'Waiting when checked',
    'Approval',
  ]);
  assert.deepEqual(render({ kind: 'completed' }, { text: 'The build passed.' }), [
    'Completed',
    'The build passed.',
  ]);
});

test('ApplyPatch details preserve excerpts for each requested hunk', () => {
  const patch =
    '@@ first function\n keep\n-return false;\n+return true;\n@@\n-newName\n+betterName';
  assert.deepEqual(structuredToolPatch('src/example.ts', 'update_file', patch), [
    {
      path: 'src/example.ts',
      operation: 'update',
      hunks: [
        { context: 'first function', before: 'keep\nreturn false;', after: 'keep\nreturn true;' },
        { context: '', before: 'newName', after: 'betterName' },
      ],
    },
  ]);
});

test('a freeform patch shows an added file and a deletion without fabricating the deleted text', () => {
  assert.deepEqual(
    textToolPatch(
      '*** Begin Patch\n*** Add File: notes.md\n+hello\n*** Delete File: old.md\n*** End Patch',
    ),
    [
      {
        path: 'notes.md',
        operation: 'create',
        hunks: [{ context: '', before: '', after: 'hello' }],
      },
      { path: 'old.md', operation: 'delete', hunks: [] },
    ],
  );
});

test('a partially applied patch shows the failed file and files already changed', () => {
  const projection = toolResult('patch', {
    kind: 'completed',
    value: {
      status: 'failed',
      applied: [{ type: 'create_file', path: 'notes.md' }],
      failed: { type: 'update_file', path: 'src/example.ts' },
      error: 'Could not find the expected context.',
    },
  });
  assert.deepEqual(
    projection.sections.map(({ label, text }) => [label, text]),
    [
      ['Patch did not finish', 'src/example.ts\nCould not find the expected context.'],
      ['Files already changed', 'notes.md'],
    ],
  );
});

const execKey = 'maka.agent.Builtin@1/exec';
const cell = '"cell_id":"55d41969-e90e-822b-8622-935a84e39f04"';
const scriptResult = (original) =>
  activityProjection(activityPresentation(execKey), 'result', original, { returned: true });

test("a script's result shows what it printed, not the line of JSON before it", () => {
  const reply = `{"state":"completed",${cell},"result":{"ok":true,"value":null,"toolCalls":[]}}\nline 0\nline 1`;
  assert.deepEqual(scriptResult(reply), {
    kind: 'sections',
    sections: [{ label: 'Output', text: 'line 0\nline 1', style: 'code' }],
  });
});

test('a script that printed nothing shows the value it returned', () => {
  const text = `{"state":"completed",${cell},"result":{"ok":true,"value":"done","toolCalls":[]}}`;
  assert.deepEqual(scriptResult(text).sections, [{ label: 'Output', text: 'done', style: 'code' }]);
  const value = `{"state":"completed",${cell},"result":{"ok":true,"value":{"count":2},"toolCalls":[]}}`;
  assert.equal(scriptResult(value).sections[0].text, '{\n  "count": 2\n}');
  const none = `{"state":"completed",${cell},"result":{"ok":true,"value":null,"toolCalls":[]}}`;
  assert.deepEqual(scriptResult(none).sections, [
    { label: 'Output', text: 'Script finished without text output' },
  ]);
});

test("an interrupted script's failure is its reason, read out of the nested JSON", () => {
  const diagnostic = JSON.stringify(
    JSON.stringify({
      ok: false,
      error: { kind: 'execution_error', message: 'TypeError: tools.ModelList is not a function' },
      toolCalls: [],
    }),
  );
  const reply = `{"state":"interrupted",${cell},"diagnostic":${diagnostic},"heap":"expired","bindings":"invalid"}`;
  assert.deepEqual(activityFailure(reply), {
    kind: 'failure',
    message: 'TypeError: tools.ModelList is not a function',
  });
  // Cut short by the Host: the line no longer parses, the reason is still found.
  const cut = `${reply.slice(0, reply.indexOf('"heap"'))}\n[output truncated; full observation is archived]`;
  assert.equal(activityFailure(cut).message, 'TypeError: tools.ModelList is not a function');
  assert.deepEqual(scriptResult(reply).sections, [
    {
      label: 'Script source',
      text: 'Script interrupted\nTypeError: tools.ModelList is not a function',
      tone: 'warning',
    },
  ]);
});

test('the typed observation of a script reads the same way', () => {
  assert.deepEqual(
    scriptResult({
      observation: { state: 'completed', content: [{ text: 'printed' }], result: { ok: true } },
    }).sections,
    [{ label: 'Output', text: 'printed', style: 'code' }],
  );
  assert.deepEqual(
    scriptResult({
      observation: {
        state: 'completed',
        content: [],
        result: { ok: false, error: { message: 'boom' } },
      },
    }).sections,
    [{ label: 'Script source', text: 'Script reported an error\nboom', tone: 'warning' }],
  );
});

test('text that is not a script reply is left to other views', () => {
  assert.equal(scriptResult('{"state":"completed"}'), null);
  assert.equal(scriptResult('plain text'), null);
});

test('human-symmetric Session* tool cards project real contract variants', () => {
  const manage = activityPresentation('maka.agent.Agent@1/sessionManage');
  assert.ok(manage);

  // continue_run arguments + continuation_started / continuation_rejected results
  assert.deepEqual(
    activityProjection(
      manage,
      'arguments',
      {
        sessionId: 'ma_1',
        action: {
          kind: 'continue_run',
          model: { connectionId: 'c1', modelId: 'claude-sonnet-4-6' },
        },
      },
      { sessionTitle: () => 'Worker A' },
    ),
    {
      kind: 'sections',
      sections: [
        { label: 'Action', text: 'Continue conversation run', style: undefined },
        { label: 'Model', text: 'claude-sonnet-4-6', style: undefined },
        { label: 'Conversation', text: 'Worker A', style: undefined },
      ],
    },
  );
  assert.deepEqual(
    activityProjection(manage, 'result', { kind: 'continuation_started', runId: 'r1' }, {}),
    {
      kind: 'sections',
      sections: [{ label: 'Status', text: 'Continuation started', tone: undefined }],
    },
  );
  assert.deepEqual(
    activityProjection(
      manage,
      'result',
      { kind: 'continuation_rejected', reason: 'already_continued' },
      {},
    ),
    {
      kind: 'sections',
      sections: [
        { label: 'Status', text: 'Original run has already been continued', tone: 'error' },
      ],
    },
  );

  // queue_edited unwraps nested result
  assert.deepEqual(
    activityProjection(
      manage,
      'result',
      { kind: 'queue_edited', result: { kind: 'committed', revision: 3 } },
      {},
    ),
    { kind: 'sections', sections: [{ label: 'Status', text: 'Queue updated', tone: undefined }] },
  );
  assert.deepEqual(
    activityProjection(
      manage,
      'result',
      { kind: 'queue_edited', result: { kind: 'rejected', reason: 'in_flight' } },
      {},
    ),
    {
      kind: 'sections',
      sections: [{ label: 'Status', text: 'Message is already being delivered', tone: 'error' }],
    },
  );

  // updated preserves Archived status and reads SessionSummary.workspacePath
  assert.deepEqual(
    activityProjection(
      manage,
      'result',
      {
        kind: 'updated',
        session: {
          id: 'ma_1',
          kind: 'agent',
          title: 'Worker A',
          activity: 'idle',
          archived: true,
          pinned: false,
          hasUnread: false,
          labels: [],
          workspacePath: '/tmp/ws',
          updatedAt: 1,
          revision: 2,
        },
      },
      {},
    ),
    {
      kind: 'sections',
      sections: [
        { label: 'Conversation', text: 'Worker A', style: undefined },
        { label: 'Status', text: 'Archived', tone: undefined },
        { label: 'Workspace', text: '/tmp/ws', style: 'code' },
      ],
    },
  );

  // sessionRead surfaces run.error when latest run failed
  const read = activityPresentation('maka.agent.Agent@1/sessionRead');
  assert.deepEqual(
    activityProjection(
      read,
      'result',
      {
        session: {
          id: 'ma_2',
          kind: 'agent',
          title: 'Failed worker',
          activity: 'idle',
          archived: false,
          pinned: false,
          hasUnread: false,
          labels: [],
          workspacePath: '/tmp/ws2',
          updatedAt: 1,
          revision: 1,
        },
        run: {
          runId: 'r2',
          state: 'failed',
          stopped: false,
          error: 'model adapter failed: quota exhausted',
        },
      },
      {},
    ),
    {
      kind: 'sections',
      sections: [
        { label: 'Conversation', text: 'Failed worker', style: undefined },
        { label: 'Status', text: 'Idle', tone: undefined },
        { label: 'Workspace', text: '/tmp/ws2', style: 'code' },
        { label: 'Details', text: 'model adapter failed: quota exhausted', style: undefined },
      ],
    },
  );
});

test('hosted search cards preserve distinct queries and expose recorded web sources', () => {
  const q = 'site:github.com/maka-agent/cua browser takeover transport';
  assert.deepEqual(providerSearch({}, { action: { type: 'search', queries: [q], query: q } }), {
    queries: [q],
    sources: [],
    error: null,
  });
  const source = { title: 'The Rust Book', url: 'https://doc.rust-lang.org/book/' };
  const expected = { key: source.url, ...source, site: 'doc.rust-lang.org' };
  const responses = providerSearch(
    {},
    {
      action: {
        type: 'search',
        queries: ['Rust', ' borrow checker ', 'Rust'],
        query: 'Rust',
        sources: [source, source, { url: 'file:///private/example' }],
      },
    },
  );
  assert.deepEqual(responses, {
    queries: ['Rust', 'borrow checker'],
    sources: [expected],
    error: null,
  });
  assert.deepEqual(
    providerSearch({ query: 'Rust' }, [
      { type: 'web_search_result', ...source, encrypted_content: 'opaque provider data' },
    ]),
    { queries: ['Rust'], sources: [expected], error: null },
  );
  assert.equal(
    providerSearch(
      { query: 'Rust' },
      { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
    ).error,
    'max_uses_exceeded',
  );
  assert.equal(
    activityTitle({
      name: 'WebSearch',
      presentation: 'provider.web_search',
      title: { fallback: q },
    }),
    'Search the web · ' + q,
  );
});

test('gateway search envelopes accept query batches, text blocks and titled result links', () => {
  const url = 'https://example.org/reference';
  const sources = [{ key: url, title: 'Reference', url, site: 'example.org' }];
  const input = { search_query: [{ q: 'one' }, { q: 'two' }, { q: 'one' }] };
  for (const output of [
    { data: { results: [{ link: url, title: 'Reference' }] } },
    {
      content: [
        { type: 'text', text: JSON.stringify({ items: [{ href: url, name: 'Reference' }] }) },
      ],
    },
    { result: { webPages: { value: [{ url, name: 'Reference' }] } } },
    { action: { searchQuery: 'two', sources: [{ url, title: 'Reference' }, url] } },
  ]) {
    assert.deepEqual(providerSearch(input, output), {
      queries: ['one', 'two'],
      sources,
      error: null,
    });
  }
});
