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
import test from 'node:test';
import {
  HostPromptSuggestionCoordinator,
  supportsPromptSuggestion,
  buildPromptSuggestionPrompt,
  cleanPromptSuggestion,
  type PromptSuggestionSource,
} from '../server/prompt-suggestion.js';
import { PROMPT_SUGGESTION_OPERATION_SPECS } from '../protocol/prompt-suggestions.js';
import type { StoredMessage } from '@maka/core/session';
import type { OperationResidency } from '../server/operation-dispatcher.js';

const source = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  terminalEventId: 'terminal-1',
  header: { model: 'model', llmConnectionSlug: 'provider' },
  messages: [],
} as unknown as PromptSuggestionSource;
const lease = () => ({ release() {} }) as OperationResidency;

test('Chinese without whitespace is valid; empty/meta/multiline/oversized suggestions are discarded', () => {
  assert.equal(cleanPromptSuggestion('补上测试'), '补上测试');
  assert.equal(cleanPromptSuggestion('“按这个方案实现”'), '按这个方案实现');
  for (const raw of [
    '',
    'none',
    'no suggestion',
    '第一行\n第二行',
    'a'.repeat(81),
    '<tool>run</tool>',
  ])
    assert.equal(cleanPromptSuggestion(raw), undefined, raw);
});

test('prompt only contains bounded user/assistant text, never tool payloads or thinking', () => {
  const prompt = buildPromptSuggestionPrompt([
    { type: 'user', text: 'original goal', id: 'u', ts: 1, turnId: 't' },
    ...Array.from({ length: 100 }, (_, i) => ({
      type: 'assistant' as const,
      text: 'x'.repeat(5000),
      id: `a${i}`,
      ts: i + 2,
      turnId: 't',
      modelId: 'm',
    })),
    { type: 'tool_result', content: 'secret tool result' } as never,
    { type: 'assistant_thinking', text: 'hidden reasoning' } as never,
  ]);
  assert.match(prompt, /original goal/);
  assert.doesNotMatch(prompt, /secret tool result|hidden reasoning/);
  assert.ok(prompt.length < 15000);
});

test('protocol rejects arbitrary context, missing identity and multiline output', () => {
  const spec = PROMPT_SUGGESTION_OPERATION_SPECS['session.prompt-suggestion.generate'];
  assert.deepEqual(spec.decodeInput({ sessionId: 's' }), { sessionId: 's' });
  assert.throws(() => spec.decodeInput({ sessionId: 's', messages: [] }));
  assert.throws(() => spec.decodeOutput({ kind: 'generated', text: 'hello' }));
  assert.throws(() =>
    spec.decodeOutput({ kind: 'generated', turnId: 't', terminalEventId: 'e', text: 'a\nb' }),
  );
});

test('concurrent clients and repeat requests share one metered generation', async () => {
  let calls = 0;
  let releases = 0;
  let complete!: (text: string) => void;
  const coordinator = new HostPromptSuggestionCoordinator({
    readSource: async () => source,
    generate: async () => {
      calls++;
      return new Promise<string>((resolve) => {
        complete = resolve;
      });
    },
  });
  const acquire = () =>
    ({
      release: () => {
        releases++;
      },
    }) as OperationResidency;
  const first = coordinator.generate('session-1', acquire);
  const second = coordinator.generate('session-1', acquire);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  complete('补上测试');
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(a.kind, 'generated');
  assert.deepEqual(await coordinator.generate('session-1', acquire), a);
  assert.equal(calls, 1);
  assert.equal(releases, 1);
  await coordinator.close();
});

test('missing source discards a late result; failed effects are not retried', async () => {
  let current: PromptSuggestionSource | undefined = source;
  let complete!: (text: string) => void;
  let calls = 0;
  const coordinator = new HostPromptSuggestionCoordinator({
    readSource: async () => current,
    generate: async () => {
      calls++;
      return new Promise<string>((resolve) => {
        complete = resolve;
      });
    },
  });
  const first = coordinator.generate('session-1', lease);
  await new Promise((resolve) => setImmediate(resolve));
  current = undefined;
  complete('补上测试');
  assert.deepEqual(await first, { kind: 'none' });
  current = source;
  assert.deepEqual(await coordinator.generate('session-1', lease), { kind: 'none' });
  assert.equal(calls, 1);
  await coordinator.close();
});

test('Host drain aborts the physical request and releases residency', async () => {
  let signal!: AbortSignal;
  let releases = 0;
  const coordinator = new HostPromptSuggestionCoordinator({
    readSource: async () => source,
    generate: async (_, abortSignal) => {
      signal = abortSignal;
      return new Promise<string>((_, reject) => {
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
      });
    },
  });
  const pending = coordinator.generate(
    'session-1',
    () =>
      ({
        release: () => {
          releases++;
        },
      }) as OperationResidency,
  );
  await new Promise((resolve) => setImmediate(resolve));
  await coordinator.close();
  assert.equal(signal.aborted, true);
  assert.equal(releases, 1);
  assert.deepEqual(await pending, { kind: 'none' });
});

test('a new canonical Turn cancels an in-flight prediction', async () => {
  let current = source;
  let signal!: AbortSignal;
  const coordinator = new HostPromptSuggestionCoordinator({
    readSource: async () => current,
    generate: async (_, abortSignal) => {
      signal = abortSignal;
      return new Promise<string>((_, reject) => {
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
      });
    },
  });
  const pending = coordinator.generate('session-1', lease);
  await new Promise((resolve) => setImmediate(resolve));
  current = { ...source, turnId: 'turn-2', terminalEventId: 'terminal-2' };
  await coordinator.reconcile('session-1');
  assert.equal(signal.aborted, true);
  assert.deepEqual(await pending, { kind: 'none' });
  await coordinator.close();
});

test('the permanent WorkHub coordinator is eligible; other agent and restricted sessions are not', () => {
  const header = {
    ...source.header,
    backend: 'ai-sdk',
    labels: [],
    collaborationMode: 'agent',
  } as PromptSuggestionSource['header'];
  assert.equal(supportsPromptSuggestion('ordinary', header), true);
  assert.equal(
    supportsPromptSuggestion('maka_workhub_coordination', {
      ...header,
      role: 'workhub_coordination',
    }),
    true,
  );
  assert.equal(
    supportsPromptSuggestion('other', { ...header, role: 'workhub_coordination' }),
    false,
  );
  for (const patch of [
    { collaborationMode: 'plan' },
    { backend: 'claude' },
    { labels: ['mode:side_conversation'] },
    { subagentParent: {} },
  ]) {
    assert.equal(
      supportsPromptSuggestion('maka_workhub_coordination', {
        ...header,
        role: 'workhub_coordination',
        ...patch,
      } as typeof header),
      false,
    );
  }
});

test('WorkHub prediction follows recent visible conversation without reviving an unrelated first task', () => {
  const messages = [
    { type: 'user', text: 'unrelated old task' },
    ...Array.from({ length: 6 }, () => ({ type: 'assistant', text: 'current task' })),
  ] as StoredMessage[];
  const prompt = buildPromptSuggestionPrompt(messages, true);
  assert.doesNotMatch(prompt, /unrelated old task/);
  assert.match(prompt, /current task/);
  assert.match(prompt, /persistent WorkHub/);
});
