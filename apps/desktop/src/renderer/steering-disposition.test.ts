import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  abandonPendingSteeringSession,
  admitPendingSteering,
  completePendingSteeringTurn,
  consumePendingSteering,
  registerPendingSteering,
  type PendingSteeringDispositionStore,
} from './steering-disposition.js';

describe('steering disposition', () => {
  it('treats a matching steering event as same-turn consumption', () => {
    const store: PendingSteeringDispositionStore = new Map();
    registerPendingSteering(store, 'message-1', 'session-1');
    assert.equal(admitPendingSteering(store, 'message-1'), false);
    consumePendingSteering(store, 'message-1');
    assert.equal(completePendingSteeringTurn(store, 'session-1'), false);
  });

  it('reports admitted input that survives until complete as deferred', () => {
    const store: PendingSteeringDispositionStore = new Map();
    registerPendingSteering(store, 'message-1', 'session-1');
    assert.equal(admitPendingSteering(store, 'message-1'), false);
    assert.equal(completePendingSteeringTurn(store, 'session-1'), true);
    assert.equal(store.size, 0);
  });

  it('handles complete racing ahead of Host admission without a false early result', () => {
    const store: PendingSteeringDispositionStore = new Map();
    registerPendingSteering(store, 'message-1', 'session-1');
    assert.equal(completePendingSteeringTurn(store, 'session-1'), false);
    assert.equal(admitPendingSteering(store, 'message-1'), true);
    assert.equal(store.size, 0);
  });

  it('drops only the failed or aborted session pending state', () => {
    const store: PendingSteeringDispositionStore = new Map();
    registerPendingSteering(store, 'message-1', 'session-1');
    registerPendingSteering(store, 'message-2', 'session-2');
    abandonPendingSteeringSession(store, 'session-1');
    assert.deepEqual([...store.keys()], ['message-2']);
  });
});
