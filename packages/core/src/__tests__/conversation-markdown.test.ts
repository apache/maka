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
import { test } from 'node:test';
import type { StoredMessage } from '../session.js';
import {
  renderConversationMarkdown,
  type ConversationMarkdownCopy,
  type RenderConversationMarkdownOptions,
} from '../conversation-markdown.js';

const COPY: ConversationMarkdownCopy = {
  you: 'You',
  assistant: 'Maka',
  toolCalls: 'Tool calls',
  thinking: 'Thinking',
  intentSeparator: ' — ',
};

function userMessage(id: string, turnId: string, ts: number, text: string): StoredMessage {
  return { type: 'user', id, turnId, ts, text };
}

function assistantMessage(input: {
  id: string;
  turnId: string;
  ts: number;
  text: string;
  thinking?: string;
}): StoredMessage {
  return {
    type: 'assistant',
    id: input.id,
    turnId: input.turnId,
    ts: input.ts,
    text: input.text,
    modelId: 'test-model',
    ...(input.thinking === undefined ? {} : { thinking: { text: input.thinking } }),
  };
}

function toolCallMessage(input: {
  id: string;
  turnId: string;
  ts: number;
  toolName: string;
  intent?: string;
  args?: unknown;
}): StoredMessage {
  return {
    type: 'tool_call',
    id: input.id,
    turnId: input.turnId,
    ts: input.ts,
    toolName: input.toolName,
    ...(input.intent === undefined ? {} : { intent: input.intent }),
    args: input.args ?? {},
  };
}

function toolResultMessage(input: {
  id: string;
  toolUseId: string;
  turnId: string;
  ts: number;
  text: string;
}): StoredMessage {
  return {
    type: 'tool_result',
    id: input.id,
    toolUseId: input.toolUseId,
    turnId: input.turnId,
    ts: input.ts,
    isError: false,
    content: { kind: 'text', text: input.text },
  };
}

function render(
  messages: readonly StoredMessage[],
  overrides: Partial<RenderConversationMarkdownOptions> = {},
): string {
  return renderConversationMarkdown('Session', messages, {
    copy: COPY,
    includeToolResults: true,
    now: () => Date.parse('2026-10-13T00:00:00Z'),
    ...overrides,
  });
}

test('emits rows in stored order inside a turn — steering lands where it was sent', () => {
  // The tool RESULT sits after the steering message in storage: rendering it
  // at the call site would move it ahead of the steering (#6036 review).
  const markdown = render([
    userMessage('u1', 't1', 1, 'open the file'),
    toolCallMessage({ id: 'c1', turnId: 't1', ts: 2, toolName: 'read_file' }),
    userMessage('u2', 't1', 3, 'STOP'),
    toolResultMessage({ id: 'r1', toolUseId: 'c1', turnId: 't1', ts: 5, text: 'file body' }),
    assistantMessage({ id: 'a2', turnId: 't1', ts: 6, text: 'done' }),
  ]);

  const order = ['open the file', '`read_file`', 'STOP', 'file body', 'done'].map((fragment) =>
    markdown.indexOf(fragment),
  );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    'rows must appear in stored order',
  );
  assert.ok(
    order.every((index) => index >= 0),
    'every row renders',
  );
});

test('reused provider tool-call ids bind each result to its own turn', () => {
  const markdown = render([
    toolCallMessage({ id: 'c-shared', turnId: 't1', ts: 1, toolName: 'run' }),
    toolResultMessage({
      id: 'r1',
      toolUseId: 'c-shared',
      turnId: 't1',
      ts: 2,
      text: 'first outcome',
    }),
    userMessage('u1', 't2', 3, 'again'),
    toolCallMessage({ id: 'c-shared', turnId: 't2', ts: 4, toolName: 'run' }),
    toolResultMessage({
      id: 'r2',
      toolUseId: 'c-shared',
      turnId: 't2',
      ts: 5,
      text: 'second outcome',
    }),
  ]);
  const first = markdown.indexOf('first outcome');
  const again = markdown.indexOf('again');
  const second = markdown.indexOf('second outcome');
  assert.ok(first >= 0 && second >= 0);
  assert.ok(first < again && again < second, 'each result stays inside its own turn');
});

test('sizes the result fence past any backtick run in the body', () => {
  const markdown = render([
    toolCallMessage({ id: 'c1', turnId: 't1', ts: 1, toolName: 'run' }),
    toolResultMessage({
      id: 'r1',
      toolUseId: 'c1',
      turnId: 't1',
      ts: 2,
      text: 'nested example:\n\n```md\n# inner\n```\nover',
    }),
  ]);
  assert.ok(markdown.includes('  ````'), 'the fence widens past the embedded ``` run');
  // The structural open/close fences are four backticks; the inner ``` lines
  // are content and stay inside them.
  assert.equal((markdown.match(/^  ````$/gm) ?? []).length, 2);
  assert.ok(markdown.includes('# inner'));
});

test('tool arguments render on the row only behind the flag', () => {
  const call = [
    toolCallMessage({ id: 'c1', turnId: 't1', ts: 1, toolName: 'run', args: { path: '/tmp/x' } }),
  ];
  assert.ok(render(call, { includeToolArguments: true }).includes('args: {"path":"/tmp/x"}'));
  assert.ok(!render(call).includes('args:'));
});

test('tool results stay out of the light clipboard shape', () => {
  const messages = [
    toolCallMessage({ id: 'c1', turnId: 't1', ts: 1, toolName: 'read_file' }),
    toolResultMessage({ id: 'r1', toolUseId: 'c1', turnId: 't1', ts: 2, text: 'file body' }),
  ];
  assert.ok(!render(messages, { includeToolResults: false }).includes('file body'));
  assert.ok(render(messages).includes('file body'));
});

test('the redactor sees every model-produced string and user text stays untouched', () => {
  const seen: string[] = [];
  const markdown = render(
    [
      userMessage('u1', 't1', 1, 'user typed password: hunter2'),
      toolCallMessage({
        id: 'c1',
        turnId: 't1',
        ts: 2,
        toolName: 'run',
        intent: 'intent text',
        args: { a: 1 },
      }),
      toolResultMessage({ id: 'r1', toolUseId: 'c1', turnId: 't1', ts: 3, text: 'result text' }),
      assistantMessage({
        id: 'a1',
        turnId: 't1',
        ts: 4,
        text: 'answer text',
        thinking: 'thinking text',
      }),
    ],
    {
      includeThinking: true,
      includeToolArguments: true,
      redact: (text) => {
        seen.push(text);
        return text;
      },
    },
  );
  assert.ok(markdown.includes('user typed password: hunter2'), 'user text is not redacted');
  for (const fragment of [
    'intent text',
    '{"a":1}',
    'result text',
    'answer text',
    'thinking text',
  ]) {
    assert.ok(
      seen.some((text) => text.includes(fragment)),
      `redactor saw ${fragment}`,
    );
  }
});

test('emit streams per-turn chunks that assemble to the string form', () => {
  const messages = [
    userMessage('u1', 't1', 1, 'open the file'),
    assistantMessage({ id: 'a1', turnId: 't1', ts: 2, text: 'done' }),
    userMessage('u2', 't2', 3, 'again'),
  ];
  const stringForm = render(messages);
  const chunks: string[] = [];
  const streamed = renderConversationMarkdown('Session', messages, {
    copy: COPY,
    includeToolResults: true,
    now: () => Date.parse('2026-10-13T00:00:00Z'),
    emit: (chunk) => chunks.push(chunk),
  });
  assert.equal(streamed, '');
  assert.equal(chunks.join(''), stringForm);
  // The head is its own chunk and each turn arrives as one block: memory is
  // bounded by the largest turn, not the session (#6036 review).
  assert.ok(chunks.length >= 3, `expected head + per-turn chunks, got ${chunks.length}`);
});
