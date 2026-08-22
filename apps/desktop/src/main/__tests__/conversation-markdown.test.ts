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

/**
 * Export must prefer the human-facing user message view so skill-injection
 * envelopes do not leak into clipboard / file exports.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { StoredMessage } from '@maka/core/session';
import { renderConversationMarkdown } from '../../renderer/conversation-markdown.js';

describe('renderConversationMarkdown', () => {
  it('uses displayText for user turns when the model text is a skill envelope', () => {
    const typed = '/skill:alpha 帮我整理';
    const envelope = [
      'The user explicitly invoked the following local skill(s) for this request.',
      '<invoked-skill id="alpha" name="Alpha">',
      '# Alpha',
      'Secret skill body that must not export.',
      '</invoked-skill>',
      '<user-message>',
      '帮我整理',
      '</user-message>',
    ].join('\n');
    const messages: StoredMessage[] = [
      {
        type: 'user',
        id: 'u1',
        turnId: 't1',
        ts: 1,
        text: envelope,
        displayText: typed,
      },
      {
        type: 'assistant',
        id: 'a1',
        turnId: 't1',
        ts: 2,
        text: 'done',
        modelId: 'fake',
      },
    ];
    const md = renderConversationMarkdown('skill session', messages);
    assert.match(md, /## 你/);
    assert.ok(md.includes(typed), 'export shows the typed prompt');
    assert.ok(!md.includes('<invoked-skill'), 'export must not include the skill envelope');
    assert.ok(!md.includes('Secret skill body'), 'export must not include skill body');
  });
});
