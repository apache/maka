/** Privacy boundaries and input normalization for `@maka/core/memory`. */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  MEMORY_CONTENT_MAX_CODE_POINTS,
  normalizeMemoryContent,
  normalizeMemoryMode,
  normalizeMemoryPersistenceState,
  normalizeMemoryScope,
  normalizeMemorySource,
  validateMemoryWriteRequest,
  type MemoryWriteRequest,
  type MemoryWriteRequestContext,
} from '../memory.js';

function ctx(overrides: Partial<MemoryWriteRequestContext> = {}): MemoryWriteRequestContext {
  return {
    mode: 'manual_with_drafts',
    incognitoActive: false,
    originatedFromRenderer: false,
    now: 1_700_000_000_000,
    ...overrides,
  };
}

function durableRequest(overrides: Partial<MemoryWriteRequest> = {}): MemoryWriteRequest {
  return {
    source: 'user_authored',
    persistenceState: 'active',
    content: 'Remember to ship the contract before the implementation.',
    scope: 'workspace',
    confirmedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function draftRequest(overrides: Partial<MemoryWriteRequest> = {}): MemoryWriteRequest {
  return {
    source: 'voice_transcript',
    persistenceState: 'draft',
    content: 'Meeting note from voice transcript.',
    scope: 'session',
    ...overrides,
  };
}

describe('G1 — mode=off blocks all writes (default-off)', () => {
  it('rejects durable and draft writes', () => {
    for (const request of [durableRequest(), draftRequest()]) {
      const result = validateMemoryWriteRequest(request, ctx({ mode: 'off' }));
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'mode_off');
    }
  });
});

describe('G2 — durable active requires confirmedAt (manual confirm)', () => {
  it('rejects user_authored + active without confirmedAt', () => {
    const result = validateMemoryWriteRequest(durableRequest({ confirmedAt: undefined }), ctx());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'manual_confirm_required');
  });

  it('rejects wrong-type, non-finite, and negative confirmedAt', () => {
    for (const bad of [NaN, -1, '1700000000000'] as unknown[]) {
      const result = validateMemoryWriteRequest(
        durableRequest({ confirmedAt: bad as number }),
        ctx(),
      );
      assert.equal(result.ok, false, `bad=${String(bad)}`);
      if (!result.ok) assert.equal(result.reason, 'manual_confirm_required');
    }
  });

  it('rejects durable source with non-active persistence (must use candidate source for pending)', () => {
    const result = validateMemoryWriteRequest(
      durableRequest({ persistenceState: 'draft', confirmedAt: undefined }),
      ctx(),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'manual_confirm_required');
  });
});

describe('G4 — incognito blocks all writes', () => {
  it('rejects durable and draft writes', () => {
    for (const request of [durableRequest(), draftRequest()]) {
      const result = validateMemoryWriteRequest(request, ctx({ incognitoActive: true }));
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'incognito_active');
    }
  });

  it('incognito gate precedes content validation (rejects malformed content as incognito)', () => {
    const result = validateMemoryWriteRequest(
      durableRequest({ content: '' }),
      ctx({ incognitoActive: true }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'incognito_active');
  });
});

describe('G7 — candidate sources cannot reach active state', () => {
  it('rejects a candidate source with persistenceState=active', () => {
    const result = validateMemoryWriteRequest(
      { source: 'voice_transcript', persistenceState: 'active', content: 'x', scope: 'workspace' },
      ctx(),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'candidate_source_no_active');
  });

  it('mode=manual_only rejects candidate sources even at draft state', () => {
    const result = validateMemoryWriteRequest(draftRequest(), ctx({ mode: 'manual_only' }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'mode_disallows_candidate');
  });
});

describe('G9 — renderer-originated active durable write is blocked', () => {
  it('rejects valid durable active when originatedFromRenderer=true', () => {
    const result = validateMemoryWriteRequest(
      durableRequest(),
      ctx({ originatedFromRenderer: true }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'renderer_provenance_forged');
  });
});

describe('normalizeMemoryContent', () => {
  it('strips control characters and zero-width characters', () => {
    const inputWithControls =
      'foo' + String.fromCharCode(0x00) + 'bar' + String.fromCharCode(0x200b) + 'baz';
    const result = normalizeMemoryContent(inputWithControls);
    assert.equal(result.ok, true);
    if (result.ok) {
      // C0 replaced with space; ZWSP removed entirely.
      assert.equal(result.value, 'foo barbaz');
    }
  });

  it('rejects non-string and empty input', () => {
    for (const bad of [null, '   ']) {
      const result = normalizeMemoryContent(bad);
      assert.equal(result.ok, false, String(bad));
      if (!result.ok) assert.equal(result.reason, 'content_invalid');
    }
  });

  it('enforces the code-point cap', () => {
    const over = 'a'.repeat(MEMORY_CONTENT_MAX_CODE_POINTS + 1);
    const result = normalizeMemoryContent(over);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'content_invalid');
    const at = 'a'.repeat(MEMORY_CONTENT_MAX_CODE_POINTS);
    assert.equal(normalizeMemoryContent(at).ok, true);
  });
});

describe('normalizeMemorySource', () => {
  it('separates durable and candidate sources', () => {
    const durable = normalizeMemorySource('user_authored');
    assert.equal(durable.ok, true);
    if (durable.ok) assert.equal(durable.value.kind, 'memory');
    const candidate = normalizeMemorySource('voice_transcript');
    assert.equal(candidate.ok, true);
    if (candidate.ok) assert.equal(candidate.value.kind, 'candidate');
  });

  it('rejects unknown and non-string sources', () => {
    for (const bad of ['usage_log', null]) {
      const result = normalizeMemorySource(bad);
      assert.equal(result.ok, false, String(bad));
      if (!result.ok) assert.equal(result.reason, 'unknown_source');
    }
  });
});

describe('normalizeMemoryMode / Scope / PersistenceState — closed-enum reject', () => {
  it('rejects unknown values with the matching reason', () => {
    for (const [normalize, value, reason] of [
      [normalizeMemoryMode, 'always_on', 'mode_invalid'],
      [normalizeMemoryScope, 'global', 'scope_invalid'],
      [normalizeMemoryPersistenceState, 'persisted', 'persistence_invalid'],
    ] as const) {
      const result = normalize(value);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, reason);
    }
  });
});

describe('canonical return shape', () => {
  it('returns canonical durable and draft entries', () => {
    const result = validateMemoryWriteRequest(durableRequest(), ctx());
    assert.equal(result.ok, true);
    if (result.ok) {
      const entry = result.value;
      assert.equal(entry.persistenceState, 'active');
      assert.equal(entry.source, 'user_authored');
      assert.equal(entry.scope, 'workspace');
      assert.equal(entry.content, 'Remember to ship the contract before the implementation.');
      // confirmedAt + createdAt both present.
      assert.equal((entry as { confirmedAt: number }).confirmedAt, 1_700_000_000_000);
      assert.equal(entry.createdAt, 1_700_000_000_000);
    }
    const draft = validateMemoryWriteRequest(draftRequest(), ctx({ now: 1_800_000_000_000 }));
    assert.equal(draft.ok, true);
    if (draft.ok) {
      const entry = draft.value;
      assert.equal(entry.persistenceState, 'draft');
      assert.equal(entry.source, 'voice_transcript');
      assert.equal((entry as { proposedAt: number }).proposedAt, 1_800_000_000_000);
      // No confirmedAt on draft entries (by design).
      assert.equal((entry as { confirmedAt?: number }).confirmedAt, undefined);
    }
  });
});
