import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MODEL_PROCESSING_DELAY_MS,
  createDelayedFlag,
  deriveModelWait,
  type DelayedFlagScheduler,
} from '../../renderer/model-wait-state.js';

const HEAD = {
  turnPhase: 'waiting',
  streamingText: '',
  thinkingText: '',
  hasInFlightTools: false,
} as const;

function fakeScheduler() {
  let now = 0;
  let sequence = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const scheduler: DelayedFlagScheduler = {
    setTimeout(run, delay) {
      const id = ++sequence;
      timers.set(id, { at: now + delay, run });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  return {
    scheduler,
    advance(duration: number) {
      now += duration;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
      }
    },
    pending: () => timers.size,
  };
}

describe('model wait state', () => {
  it('derives head, active-content, tool, and mid-turn wait states', () => {
    for (const [input, expected] of [
      [HEAD, 'processing'],
      [{ ...HEAD, turnPhase: undefined }, 'none'],
      [{ ...HEAD, streamingText: 'answer' }, 'none'],
      [{ ...HEAD, thinkingText: 'reasoning' }, 'none'],
      [{ ...HEAD, hasInFlightTools: true }, 'none'],
      [{ ...HEAD, turnPhase: 'streamed', hasInFlightTools: true }, 'none'],
      [{ ...HEAD, turnPhase: 'streamed' }, 'continuing'],
    ] as const) {
      assert.equal(deriveModelWait(input), expected);
    }
  });

  it('delays rising edges, hides immediately, re-arms, and emits only transitions', () => {
    const clock = fakeScheduler();
    const changes: boolean[] = [];
    const flag = createDelayedFlag({
      delayMs: MODEL_PROCESSING_DELAY_MS,
      scheduler: clock.scheduler,
      onChange: (visible) => changes.push(visible),
    });

    flag.setCondition(true);
    flag.setCondition(true);
    clock.advance(MODEL_PROCESSING_DELAY_MS - 1);
    assert.equal(flag.get(), false);
    clock.advance(1);
    assert.equal(flag.get(), true);

    flag.setCondition(false);
    assert.equal(flag.get(), false);
    flag.setCondition(true);
    clock.advance(MODEL_PROCESSING_DELAY_MS - 1);
    assert.equal(flag.get(), false);
    clock.advance(1);
    assert.equal(flag.get(), true);
    assert.deepEqual(changes, [true, false, true]);
  });

  it('cancels a pending reveal when the condition drops or the owner disposes', () => {
    for (const cancel of ['condition', 'dispose'] as const) {
      const clock = fakeScheduler();
      const flag = createDelayedFlag({
        delayMs: MODEL_PROCESSING_DELAY_MS,
        scheduler: clock.scheduler,
      });
      flag.setCondition(true);
      clock.advance(100);
      if (cancel === 'condition') flag.setCondition(false);
      else flag.dispose();
      clock.advance(MODEL_PROCESSING_DELAY_MS);
      assert.equal(flag.get(), false, cancel);
      assert.equal(clock.pending(), 0, cancel);
    }
  });
});
