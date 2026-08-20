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

  // Each wave stands in for a cell that is cancelled but whose host operations
  // are still draining: the permit is released only when the cell settles, so
  // a wave that never settles must keep the next one out.
  for (let wave = 0; wave < 8; wave += 1) {
    assert.equal(await admission.acquire(), 'admitted');
    let nextAdmitted = false;
    void admission.acquire().then(() => {
      nextAdmitted = true;
    });
    await tick();
    assert.equal(nextAdmitted, false, `wave ${wave} admitted a second cell`);
    assert.equal(await admission.acquire(), 'queue_full');
    admission.release(); // the queued cell takes over
    admission.release(); // and settles in turn
  }
});

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
