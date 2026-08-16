import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionTerminalHydration } from '../../renderer/session-terminal-hydration.js';

test('terminal hydration ignores an old snapshot and replays only post-resync PTY data', () => {
  const hydration = new SessionTerminalHydration();
  const oldEpoch = hydration.begin();
  hydration.accept({ sequence: 2, data: 'old' });

  const currentEpoch = hydration.begin();
  hydration.accept({ sequence: 6, data: ' after' });
  const current = hydration.commit(currentEpoch, {
    sequence: 5,
    buffer: 'ready',
  });

  assert.deepEqual(current, {
    snapshot: { sequence: 5, buffer: 'ready' },
    replay: [{ sequence: 6, data: ' after' }],
  });
  assert.equal(
    hydration.commit(oldEpoch, { sequence: 9, buffer: 'stale' }),
    undefined,
  );
  assert.deepEqual(hydration.accept({ sequence: 7, data: ' now' }), {
    sequence: 7,
    data: ' now',
  });
});
