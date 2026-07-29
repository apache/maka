import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createTurnSizeWarmup, type WarmupScheduler } from '../turn-size-warmup.js';

function fakeTurn(overrides: { live?: boolean; connected?: boolean } = {}) {
  return {
    isConnected: overrides.connected ?? true,
    hasAttribute: (name: string) => name === 'data-live-streaming' && (overrides.live ?? false),
    style: { contentVisibility: '', contain: '' },
  };
}

function fakeScheduler() {
  const idle: Array<() => void> = [];
  const frames: Array<() => void> = [];
  const remove = (queue: Array<() => void>, callback: () => void) => {
    const index = queue.indexOf(callback);
    if (index >= 0) queue.splice(index, 1);
  };
  const scheduler: WarmupScheduler = {
    requestIdle(callback) {
      idle.push(callback);
      return () => remove(idle, callback);
    },
    requestFrame(callback) {
      frames.push(callback);
      return () => remove(frames, callback);
    },
  };
  return {
    scheduler,
    flushIdle: () => { idle.splice(0).forEach((callback) => callback()); },
    flushFrame: () => { frames.splice(0).forEach((callback) => callback()); },
    pending: () => idle.length + frames.length,
  };
}

function forced(turns: Array<{ style: { contentVisibility: string; contain: string } }>): number[] {
  return turns.flatMap((turn, index) =>
    turn.style.contentVisibility === 'visible' && turn.style.contain === 'layout style paint' ? [index] : []);
}

describe('createTurnSizeWarmup', () => {
  it('walks bottom-up in chunks, forcing each chunk across a full frame then releasing it', () => {
    const turns = [fakeTurn(), fakeTurn(), fakeTurn(), fakeTurn(), fakeTurn()];
    const { scheduler, flushIdle, flushFrame, pending } = fakeScheduler();
    createTurnSizeWarmup({ turns: () => turns, chunkSize: 2, scheduler });

    assert.deepEqual(forced(turns), []);
    flushIdle();
    assert.deepEqual(forced(turns), [3, 4]);
    // The chunk must stay forced across the frame that lays it out (the first
    // frame callback fires before that layout) and release on the next frame.
    flushFrame();
    assert.deepEqual(forced(turns), [3, 4]);
    flushFrame();
    assert.deepEqual(forced(turns), []);
    // Release must fully restore the stylesheet state — both properties.
    assert.equal(turns[3].style.contentVisibility, '');
    assert.equal(turns[3].style.contain, '');

    flushIdle();
    assert.deepEqual(forced(turns), [1, 2]);
    flushFrame();
    flushFrame();
    flushIdle();
    assert.deepEqual(forced(turns), [0]);
    flushFrame();
    flushFrame();
    assert.deepEqual(forced(turns), []);
    assert.equal(pending(), 0);
  });

  // `onSettled` is the contract the scroll-geometry E2E waits on, and every
  // way of being early is a way of certifying a transcript that is still a
  // third short. So these pin the boundary from both sides: the last instant
  // it must still be silent, and the first instant it must have fired.
  it('stays silent through the gap between chunks and through the last chunk itself', () => {
    const turns = [fakeTurn(), fakeTurn(), fakeTurn(), fakeTurn()];
    const { scheduler, flushIdle, flushFrame } = fakeScheduler();
    let settled = 0;
    // Captured inside the callback, not after the flush: "settled" has to mean
    // the last chunk is already released, and a release that happens later in
    // the same frame callback is invisible to an assertion made afterwards.
    let forcedWhenSettled: number[] | null = null;
    createTurnSizeWarmup({
      turns: () => turns,
      chunkSize: 2,
      scheduler,
      onSettled: () => { settled += 1; forcedWhenSettled = forced(turns); },
    });

    flushIdle();
    flushFrame();
    flushFrame();
    // Between chunks: nothing forced and geometry holding still — the exact
    // shape of the end, and not the end.
    assert.deepEqual(forced(turns), []);
    assert.equal(settled, 0);

    // Last chunk queued and forced. Its turns have not been laid out yet.
    flushIdle();
    assert.deepEqual(forced(turns), [0, 1]);
    assert.equal(settled, 0);
    // First frame: still before the layout that records the remembered sizes.
    flushFrame();
    assert.deepEqual(forced(turns), [0, 1]);
    assert.equal(settled, 0);
    // Second frame releases the chunk — only now is the geometry final, and
    // the release must already have happened when the callback runs.
    flushFrame();
    assert.equal(settled, 1);
    assert.deepEqual(forcedWhenSettled, []);

    // Nothing left to schedule can fire it again.
    flushIdle();
    flushFrame();
    assert.equal(settled, 1);
  });

  it('settles immediately when there is nothing to walk', () => {
    const { scheduler, flushIdle } = fakeScheduler();
    let settled = 0;
    createTurnSizeWarmup({ turns: () => [], scheduler, onSettled: () => { settled += 1; } });

    flushIdle();
    assert.equal(settled, 1);
  });

  it('settles once when every remaining turn has been detached mid-walk', () => {
    // Second chunk's turns leave the DOM while the first chunk is in flight:
    // the walk drains the queue, finds nothing live, and must report the walk
    // over exactly once rather than stall waiting for a chunk it cannot build.
    const live = [fakeTurn(), fakeTurn()];
    const doomed = [fakeTurn(), fakeTurn()];
    const turns = [...doomed, ...live];
    const { scheduler, flushIdle, flushFrame, pending } = fakeScheduler();
    let settled = 0;
    createTurnSizeWarmup({ turns: () => turns, chunkSize: 2, scheduler, onSettled: () => { settled += 1; } });

    flushIdle();
    assert.deepEqual(forced(turns), [2, 3]);
    for (const turn of doomed) turn.isConnected = false;
    flushFrame();
    flushFrame();
    assert.equal(settled, 0);

    flushIdle();
    assert.equal(settled, 1);
    assert.deepEqual(forced(turns), []);
    assert.equal(pending(), 0);
  });

  it('does not report settled for a walk cancelled at either end', () => {
    const turns = [fakeTurn(), fakeTurn(), fakeTurn()];
    const { scheduler, flushIdle, flushFrame } = fakeScheduler();
    let settled = 0;
    const stop = createTurnSizeWarmup({ turns: () => turns, chunkSize: 2, scheduler, onSettled: () => { settled += 1; } });

    // Cancelled with the queue still holding work.
    flushIdle();
    stop();
    flushFrame();
    flushFrame();
    flushIdle();
    assert.equal(settled, 0);

    // Cancelled with the LAST chunk forced and the queue already empty — one
    // frame short of the release that would have settled it.
    const lateTurns = [fakeTurn(), fakeTurn()];
    const late = fakeScheduler();
    let lateSettled = 0;
    const stopLate = createTurnSizeWarmup({
      turns: () => lateTurns,
      chunkSize: 2,
      scheduler: late.scheduler,
      onSettled: () => { lateSettled += 1; },
    });
    late.flushIdle();
    late.flushFrame();
    assert.deepEqual(forced(lateTurns), [0, 1]);
    stopLate();
    late.flushFrame();
    late.flushIdle();
    assert.equal(lateSettled, 0);
    assert.deepEqual(forced(lateTurns), []);
  });

  it('skips the live-streaming tail and disconnected turns', () => {
    const turns = [fakeTurn(), fakeTurn({ connected: false }), fakeTurn(), fakeTurn({ live: true })];
    const { scheduler, flushIdle } = fakeScheduler();
    createTurnSizeWarmup({ turns: () => turns, chunkSize: 4, scheduler });

    flushIdle();
    assert.deepEqual(forced(turns), [0, 2]);
  });

  it('cancel releases the in-flight chunk and stops the walk', () => {
    const turns = [fakeTurn(), fakeTurn(), fakeTurn()];
    const { scheduler, flushIdle, flushFrame, pending } = fakeScheduler();
    const stop = createTurnSizeWarmup({ turns: () => turns, chunkSize: 2, scheduler });

    flushIdle();
    assert.deepEqual(forced(turns), [1, 2]);
    stop();
    assert.deepEqual(forced(turns), []);
    flushFrame();
    flushFrame();
    flushIdle();
    assert.deepEqual(forced(turns), []);
    assert.equal(pending(), 0);
  });
});
