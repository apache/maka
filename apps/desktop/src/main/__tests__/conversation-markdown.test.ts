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
