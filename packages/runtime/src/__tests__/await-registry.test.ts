import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AwaitRegistry } from '../await-registry.js';

describe('AwaitRegistry', () => {
  test('settles one request and ignores a late response', async () => {
    const registry = new AwaitRegistry<string, { toolUseId: string }>();

    const parked = registry.park('request-1', { toolUseId: 'tool-1' });

    assert.deepEqual(registry.resolve('request-1', 'answer'), { toolUseId: 'tool-1' });
    assert.equal(await parked, 'answer');
    assert.equal(registry.resolve('request-1', 'late'), null);
    assert.equal(registry.pendingCount(), 0);
  });

  test('closing rejects every request and refuses later ones', async () => {
    const registry = new AwaitRegistry<string, undefined>();
    const first = registry.park('request-1', undefined);
    const second = registry.park('request-2', undefined);

    registry.close((requestId) => new Error(`aborted ${requestId}`));

    await assert.rejects(first, /aborted request-1/);
    await assert.rejects(second, /aborted request-2/);
    assert.equal(registry.pendingCount(), 0);
    // Terminal: the turn this registry serves is over, so nothing may park into
    // it again — a tool that tried would otherwise wait on a promise no one owns.
    assert.throws(() => registry.park('request-late', undefined), /not accepting requests/);
    // And closing twice is a no-op: endTurn can run from both stop() and the
    // turn's own cleanup.
    registry.close(() => new Error('should not be thrown'));
  });
});
