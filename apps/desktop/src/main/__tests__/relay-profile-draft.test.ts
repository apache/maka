import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  relayProfileDraftReseedPlan,
  relayProfileDraftSeed,
} from '../../renderer/settings/relay-profile-draft.js';

test('a clean draft reseeds on every reload of its own connection', () => {
  assert.deepEqual(relayProfileDraftReseedPlan({ slug: 'relay-a', dirty: false }, 'relay-a'), {
    reseed: true,
    clearDirty: false,
  });
});

test('a dirty draft survives same-connection reloads', () => {
  assert.deepEqual(relayProfileDraftReseedPlan({ slug: 'relay-a', dirty: true }, 'relay-a'), {
    reseed: false,
    clearDirty: false,
  });
});

test('a connection switch reseeds regardless of unsaved edits — and owns the result', () => {
  // Dirty belongs to the slug that produced it: A's unsaved declarations
  // must neither render under B nor be saved into B.
  for (const dirty of [true, false]) {
    assert.deepEqual(relayProfileDraftReseedPlan({ slug: 'relay-a', dirty }, 'relay-b'), {
      reseed: true,
      clearDirty: true,
    });
  }
});

test('the draft seed sanitizes a hand-edited saved table', () => {
  // Runtime reads sanitize through relayModelProfile; the editor must show
  // the same canonical view — a malformed local file degrades to no
  // declaration, not to UI state TypeScript does not model.
  assert.deepEqual(
    relayProfileDraftSeed({
      reasoner: { thinkingLevels: 'low' as never, contextWindow: '128000' as never },
      ghost: { thinkingLevels: ['off', 'low'] },
      visual: { vision: true },
    }),
    {
      ghost: { thinkingLevels: ['low'] },
      visual: { vision: true },
    },
  );
  assert.deepEqual(relayProfileDraftSeed(undefined), {});
});
