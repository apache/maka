import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TurnScopedAwaitRegistry } from '../turn-scoped-await-registry.js';

describe('TurnScopedAwaitRegistry', () => {
  test('settles one request and ignores a late response', async () => {
    const registry = new TurnScopedAwaitRegistry<string, { toolUseId: string }>();
    registry.beginTurn('turn-1');

    const parked = registry.park('turn-1', 'request-1', { toolUseId: 'tool-1' });

    assert.deepEqual(registry.resolve('turn-1', 'request-1', 'answer'), { toolUseId: 'tool-1' });
    assert.equal(await parked, 'answer');
    assert.equal(registry.resolve('turn-1', 'request-1', 'late'), null);
    assert.equal(registry.pendingCount('turn-1'), 0);
  });

  test('ending a turn rejects every request and drops the turn', async () => {
    const registry = new TurnScopedAwaitRegistry<string, undefined>();
    registry.beginTurn('turn-1');
    const first = registry.park('turn-1', 'request-1', undefined);
    const second = registry.park('turn-1', 'request-2', undefined);

    registry.endTurn('turn-1', (requestId) => new Error(`aborted ${requestId}`));

    await assert.rejects(first, /aborted request-1/);
    await assert.rejects(second, /aborted request-2/);
    assert.equal(registry.pendingCount('turn-1'), 0);
    assert.throws(
      () => registry.park('turn-1', 'request-late', undefined),
      /not accepting requests/,
    );
  });
});
