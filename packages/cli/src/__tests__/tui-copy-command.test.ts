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
import type { MakaPiTranscriptEntry, MakaPiTranscriptState } from '../pi-transcript.js';
import { getTuiCopyCopy, lastAssistantText, serializeTranscriptText } from '../tui-copy-command.js';

function stateWith(entries: MakaPiTranscriptEntry[]): MakaPiTranscriptState {
  return { entries } as MakaPiTranscriptState;
}

const LABELS = { user: 'You:', assistant: 'Maka:' };

describe('lastAssistantText', () => {
  test('returns the text of the most recent assistant entry', () => {
    const state = stateWith([
      { kind: 'assistant', messageId: 'a1', text: 'first' },
      { kind: 'user', messageId: 'u1', text: 'question' },
      { kind: 'assistant', messageId: 'a2', text: 'second' },
    ]);
    assert.equal(lastAssistantText(state), 'second');
  });

  test('ignores trailing non-assistant entries', () => {
    const state = stateWith([
      { kind: 'assistant', messageId: 'a1', text: 'reply' },
      { kind: 'notice', level: 'info', text: 'a notice' },
    ]);
    assert.equal(lastAssistantText(state), 'reply');
  });

  test('returns undefined when there is no assistant entry', () => {
    assert.equal(lastAssistantText(stateWith([])), undefined);
    assert.equal(
      lastAssistantText(stateWith([{ kind: 'user', messageId: 'u1', text: 'hi' }])),
      undefined,
    );
  });

  test('skips an empty trailing assistant entry and returns the earlier reply', () => {
    // A tool-only or aborted turn (and durable recovery) can leave a text-less
    // assistant entry at the tail; it must not mask the real reply before it.
    const state = stateWith([
      { kind: 'assistant', messageId: 'a1', text: 'the real reply' },
      { kind: 'assistant', messageId: 'a2', text: '   ' },
    ]);
    assert.equal(lastAssistantText(state), 'the real reply');
  });
});

describe('serializeTranscriptText', () => {
  test('serializes user and assistant turns in order with role labels', () => {
    const state = stateWith([
      { kind: 'user', messageId: 'u1', text: 'hello' },
      { kind: 'thinking', messageId: 't1', text: 'hmm', expanded: false },
      { kind: 'assistant', messageId: 'a1', text: 'hi there' },
      { kind: 'notice', level: 'info', text: 'ignored' },
      { kind: 'user', messageId: 'u2', text: 'bye' },
    ]);
    assert.equal(
      serializeTranscriptText(state, LABELS),
      'You:\nhello\n\nMaka:\nhi there\n\nYou:\nbye',
    );
  });

  test('collapses consecutive assistant steps under one label and drops empty ones', () => {
    const state = stateWith([
      { kind: 'user', messageId: 'u1', text: 'do it' },
      { kind: 'assistant', messageId: 'a1', text: "I'll inspect it." },
      { kind: 'tool', toolUseId: 't1', toolName: 'Bash', input: {}, resultVersion: 0 } as never,
      { kind: 'assistant', messageId: 'a2', text: '' },
      { kind: 'assistant', messageId: 'a3', text: 'Final answer.' },
    ]);
    assert.equal(
      serializeTranscriptText(state, LABELS),
      "You:\ndo it\n\nMaka:\nI'll inspect it.\n\nFinal answer.",
    );
  });

  test('returns an empty string when there are no conversation turns', () => {
    assert.equal(serializeTranscriptText(stateWith([]), LABELS), '');
  });
});

describe('getTuiCopyCopy', () => {
  test('resolves localized copy for each locale', () => {
    assert.equal(typeof getTuiCopyCopy('en').nothingToCopy, 'string');
    assert.equal(typeof getTuiCopyCopy('zh').nothingToCopy, 'string');
    assert.ok(getTuiCopyCopy('en').copiedLast.includes('{count'));
  });
});
