import assert from 'node:assert/strict';
import test from 'node:test';
import { CodeCellAdmission } from '../code-cell-admission.js';

test('admits one cell and queues one more', async () => {
  const admission = new CodeCellAdmission();

  assert.equal(await admission.acquire(), 'admitted');

  let secondAdmitted = false;
  const second = admission.acquire().then((outcome) => {
    secondAdmitted = outcome === 'admitted';
    return outcome;
  });
  await tick();
  assert.equal(secondAdmitted, false, 'the second cell must wait for the first');

  assert.equal(await admission.acquire(), 'queue_full');

  admission.release();
  assert.equal(await second, 'admitted');
});

test('hands the permit to the queued cell rather than freeing it', async () => {
  const admission = new CodeCellAdmission();
  await admission.acquire();
  const queued = admission.acquire();

  admission.release();
  assert.equal(await queued, 'admitted');

  // The permit moved to the queued cell, so a newcomer waits rather than
  // running alongside it.
  let thirdAdmitted = false;
  void admission.acquire().then(() => {
    thirdAdmitted = true;
  });
  await tick();
  assert.equal(thirdAdmitted, false);
});

test('rejects a queued cell that is cancelled while waiting', async () => {
  const admission = new CodeCellAdmission();
  await admission.acquire();

  const controller = new AbortController();
  const reason = new Error('queued cell cancelled');
  const queued = admission.acquire(controller.signal);
  controller.abort(reason);

  await assert.rejects(queued, (error) => error === reason);

  // The cancelled cell freed the queue slot rather than holding it, so the next
  // cell can wait in its place instead of being turned away.
  let replacementAdmitted = false;
  void admission.acquire().then(() => {
    replacementAdmitted = true;
  });
  await tick();
  assert.equal(replacementAdmitted, false, 'the replacement should be queued, not admitted');
  assert.equal(await admission.acquire(), 'queue_full');
});

test('rejects a cell that was already cancelled before admission', async () => {
  const admission = new CodeCellAdmission();
  const controller = new AbortController();
  const reason = new Error('cancelled before start');
  controller.abort(reason);

  await assert.rejects(admission.acquire(controller.signal), (error) => error === reason);

  // Nothing was admitted, so the permit is still free.
  assert.equal(await admission.acquire(), 'admitted');
});

test('does not accumulate permits across repeated cancellation waves', async () => {
  const admission = new CodeCellAdmission();

  // A cancelled cell rejects at once but keeps draining host work, so its
  // permit stays held until it settles. Repeating that must leave no residue:
  // the abort path has to clear the queue slot without also freeing the
  // active one, or waves drift until the bound stops holding.
  for (let wave = 0; wave < 8; wave += 1) {
    assert.equal(await admission.acquire(), 'admitted');

    const cancelled = new AbortController();
    const queued = admission.acquire(cancelled.signal);
    cancelled.abort(new Error(`wave ${wave} cancelled`));
    await assert.rejects(queued, new RegExp(`wave ${wave} cancelled`));

    // The cancelled cell freed only its own slot: the active cell still holds
    // the permit, so the next cell queues rather than running.
    let nextAdmitted = false;
    void admission.acquire().then(() => {
      nextAdmitted = true;
    });
    await tick();
    assert.equal(nextAdmitted, false, `wave ${wave} admitted a second cell`);

    admission.release(); // the queued cell takes over
    admission.release(); // and settles in turn
  }
});

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
