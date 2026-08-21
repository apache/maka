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

test('a task bound to a retired provider is stale rather than quietly unusable', () => {
  // Nothing else about the row looks wrong: the connection still exists and is
  // still enabled, so without this the task reads as healthy until it is
  // opened. `connection_disabled` stays out because the switch that repairs it
  // is one the user can find; a retirement has no such switch.
  assert.deepEqual(
    [
      ...deriveStaleSessionIds({
        sessions: [{ id: 'retired' }, { id: 'disabled' }, { id: 'healthy' }],
        sendOutcomes: {
          retired: { kind: 'blocked', reason: 'provider_retired', connectionLocked: false },
          disabled: { kind: 'blocked', reason: 'connection_disabled', connectionLocked: false },
          healthy: { kind: 'ready' },
        },
      }),
    ],
    ['retired'],
  );
});

test('a row whose readiness has not arrived yet is not called stale', () => {
  assert.deepEqual([...deriveStaleSessionIds({ sessions: [{ id: 'unknown' }], sendOutcomes: {} })], []);
});
