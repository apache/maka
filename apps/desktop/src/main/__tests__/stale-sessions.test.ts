import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveStaleSessionIds } from '../../renderer/stale-sessions.js';

test('derives stale rows from each Session Host readiness projection', () => {
  const sessions = [
    session('local-ready'),
    session('remote-missing'),
    session('remote-rebind'),
    session('legacy-fake', 'fake'),
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
      },
    })],
    ['remote-missing', 'legacy-fake'],
  );
});

function session(id: string, backend = 'ai-sdk') {
  return { id, backend };
}
