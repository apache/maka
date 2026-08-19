import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveStaleSessionIds } from '../../renderer/stale-sessions.js';

test('derives stale rows from each Session Host readiness projection', () => {
  const sessions = [
    { id: 'local-ready' },
    { id: 'remote-missing' },
    { id: 'remote-rebind' },
    { id: 'legacy-fake' },
  ];

  assert.deepEqual(
    [...deriveStaleSessionIds({
      sessions,
      sendOutcomes: {
        'local-ready': { kind: 'ready' },
        'remote-missing': {
          kind: 'blocked',
          reason: 'connection_missing',
          connectionLocked: true,
        },
        'remote-rebind': {
          kind: 'rebind',
          connectionSlug: 'replacement',
          model: 'model',
        },
        // #3211: a retired backend reaches the rail as a projection reason like
        // any other. The row is no longer identified by reading its `backend`.
        'legacy-fake': {
          kind: 'blocked',
          reason: 'fake_backend',
          connectionLocked: false,
        },
      },
    })],
    ['remote-missing', 'legacy-fake'],
  );
});

test('a row whose readiness has not arrived yet is not called stale', () => {
  assert.deepEqual([...deriveStaleSessionIds({ sessions: [{ id: 'unknown' }], sendOutcomes: {} })], []);
});
