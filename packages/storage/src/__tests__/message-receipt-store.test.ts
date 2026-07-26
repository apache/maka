import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMessageReceiptStore } from '../message-receipt-store.js';

test('commit returns the detached canonical JSON snapshot written to disk', async () => {
  await withStore(async (store) => {
    const receipt = {
      payload: { nested: { value: 'before' } },
      result: { queueRevision: 1, retracted: [] },
    };

    const committing = store.commit('epoch-1', 'retract', 'session-1', 'retract-1', receipt);
    receipt.payload.nested.value = 'after';
    receipt.result.queueRevision = 2;

    const committed = await committing;
    assert.deepEqual(committed, {
      payload: { nested: { value: 'before' } },
      result: { queueRevision: 1, retracted: [] },
    });
    assert.deepEqual(await store.read('epoch-1', 'retract', 'session-1', 'retract-1'), committed);
  });
});

test('commit rejects receipts that are not exactly JSON representable', async () => {
  await withStore(async (store) => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const invalid = [
      { label: 'undefined', payload: undefined },
      { label: 'non-finite', payload: { value: Number.NaN } },
      { label: 'bigint', payload: { value: 1n } },
      { label: 'cycle', payload: cycle },
    ];

    for (const candidate of invalid) {
      await assert.rejects(() =>
        store.commit('epoch-1', 'submit', 'session-1', candidate.label, {
          payload: candidate.payload,
          result: { disposition: 'turn_started', turnId: 'turn-1' },
        }),
      );
    }
  });
});

async function withStore(
  run: (store: ReturnType<typeof createMessageReceiptStore>) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-message-receipts-'));
  try {
    await run(createMessageReceiptStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
