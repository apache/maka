import assert from 'node:assert/strict';
import test from 'node:test';
import { pendingSessionView } from '../../renderer/pending-session-view.js';

test('the pending chat view starts on the model the next new task would use', () => {
  const view = pendingSessionView({
    sessionId: 'session-1',
    name: '新任务',
    permissionMode: 'ask',
    newChatModel: { llmConnectionSlug: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
    defaultConnectionSlug: 'openai',
  });

  // #3211: the placeholder used to claim `backend: 'fake'` / `model:
  // 'fake-model'`, so the model switcher matched no choice and the quote
  // companion targeted a model that never existed.
  assert.equal(view.backend, 'ai-sdk');
  assert.equal(view.llmConnectionSlug, 'anthropic');
  assert.equal(view.model, 'claude-sonnet-4-5-20250929');
  assert.equal(view.id, 'session-1');
  assert.equal(view.permissionMode, 'ask');
  assert.equal(view.connectionLocked, false);
});

test('the pending chat view falls back to the default connection, then to no model', () => {
  const withDefault = pendingSessionView({
    sessionId: 'session-2',
    name: '新任务',
    permissionMode: 'execute',
    newChatModel: undefined,
    defaultConnectionSlug: 'openai',
  });
  assert.equal(withDefault.llmConnectionSlug, 'openai');
  assert.equal(withDefault.model, '');

  const withNothing = pendingSessionView({
    sessionId: 'session-3',
    name: '新任务',
    permissionMode: 'ask',
    newChatModel: undefined,
    defaultConnectionSlug: null,
  });
  assert.equal(withNothing.backend, 'ai-sdk');
  assert.equal(withNothing.llmConnectionSlug, '');
  assert.equal(withNothing.model, '');
});
