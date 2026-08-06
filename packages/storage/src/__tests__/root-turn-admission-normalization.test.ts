import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeRootTurnAdmissionPayload } from '../agent-run-store.js';

test('root admission preserves an explicit empty inline-reference marker from its sources', () => {
  const content = { text: 'plain', inlineReferences: [] } as const;
  const normalized = normalizeRootTurnAdmissionPayload(content, [
    {
      messageId: 'message-1',
      content,
      placement: 'next_turn',
      disposition: 'followup',
    },
  ]);

  assert.deepEqual(normalized.normalizedInput, content);
  assert.deepEqual(normalized.sourceMessages[0]?.content, content);
});

test('root admission preserves and validates each source submission digest', () => {
  const digest = `sha256:${'a'.repeat(64)}` as const;
  const source = {
    messageId: 'message-1',
    content: { text: 'prepared', displayText: 'submitted' },
    submittedContentDigest: digest,
    placement: 'next_turn' as const,
    disposition: 'followup' as const,
  };
  const normalized = normalizeRootTurnAdmissionPayload(source.content, [source]);

  assert.equal(normalized.sourceMessages[0]?.submittedContentDigest, digest);
  assert.throws(() =>
    normalizeRootTurnAdmissionPayload(source.content, [
      { ...source, submittedContentDigest: 'sha256:not-a-digest' },
    ]),
  );
});
