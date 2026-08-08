import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ExternalSessionAdapterRegistry,
  type ExternalSessionAdapter,
} from '../external-session.js';

describe('ExternalSessionAdapterRegistry', () => {
  test('registers and resolves adapters by their source id', () => {
    const codex = fakeAdapter('codex');
    const registry = new ExternalSessionAdapterRegistry([codex]);

    assert.equal(registry.get('codex'), codex);
    assert.equal(registry.require('codex'), codex);
    assert.deepEqual(registry.list(), [codex]);
  });

  test('rejects duplicate and empty adapter ids', () => {
    assert.throws(
      () => new ExternalSessionAdapterRegistry([fakeAdapter('codex'), fakeAdapter('codex')]),
      /already registered/,
    );
    assert.throws(
      () => new ExternalSessionAdapterRegistry([fakeAdapter('  ')]),
      /must not be empty/,
    );
  });

  test('fails explicitly when an adapter is not registered', () => {
    const registry = new ExternalSessionAdapterRegistry();
    assert.throws(() => registry.require('codex'), /not registered/);
  });
});

function fakeAdapter(id: string): ExternalSessionAdapter {
  return {
    id,
    detect: async () => true,
    listSessions: async () => [],
    readSession: async (sourceSessionId) => ({
      sourceSessionId,
      metadata: { name: sourceSessionId, cwd: '/repo' },
      messages: [],
    }),
  };
}
