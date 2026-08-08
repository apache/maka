import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  SIDE_CONVERSATION_SESSION_LABEL,
  buildSideConversationSystemPromptFragment,
  isSideConversationSession,
} from '../side-conversation.js';

describe('side conversation boundary', () => {
  it('uses one stable session label', () => {
    assert.equal(isSideConversationSession([SIDE_CONVERSATION_SESSION_LABEL]), true);
    assert.equal(isSideConversationSession(['mode:deep_research']), false);
    assert.equal(isSideConversationSession(undefined), false);
  });

  it('treats inherited history as reference-only and permits only explicit side actions', () => {
    const prompt = buildSideConversationSystemPromptFragment();
    assert.match(prompt, /inherited parent history is reference context only/i);
    assert.match(
      prompt,
      /Only instructions the user submits in this side conversation are active/i,
    );
    assert.match(prompt, /only when the user explicitly asks/i);
    assert.match(prompt, /inherited permission profile allows it/i);
    assert.match(prompt, /Do not spawn or coordinate sub-agents/);
    assert.match(prompt, /Messages and task state .* not written back/i);
    assert.match(prompt, /Workspace changes may be visible/i);
  });
});
