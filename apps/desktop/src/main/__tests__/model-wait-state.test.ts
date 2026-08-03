import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MODEL_PROCESSING_DELAY_MS,
  createDelayedFlag,
  deriveModelWait,
  deriveTurnActive,
  type DelayedFlagScheduler,
} from '../../renderer/model-wait-state.js';

// The gate this whole change exists for: a send must show Stop at once and must
// not lose it mid-turn. Both regressions came from letting a session-level
// witness speak for the local arm, which is why these read as one suite.
describe('is a turn running', () => {
  it('opens on the local arm alone, with no session-level confirmation', () => {
    assert.equal(deriveTurnActive({
      turnPhase: 'waiting',
      armedTurnId: 'turn-1',
      runningTurnId: undefined,
    }), true);
  });

  // The runtime writes `status: 'running'` only at the END of `AgentRun.begin`,
  // so every list refreshed between the send and that write still describes an
  // idle session. ANDing such a witness in — the shape this replaced — is what
  // made Stop appear late and flicker off mid-turn.
  it('stays open across a session snapshot that predates the run', () => {
    assert.equal(deriveTurnActive({
      turnPhase: 'streamed',
      armedTurnId: 'turn-1',
      runningTurnId: undefined,
    }), true);
  });

  it('closes when neither witness reports a turn', () => {
    assert.equal(deriveTurnActive({
      turnPhase: undefined,
      armedTurnId: undefined,
      runningTurnId: undefined,
    }), false);
  });

  // A turn this renderer did not send: another client, an automation, or one
  // still running across a reload. There is no local arm to speak for it.
  it('opens for a running turn this renderer never armed', () => {
    assert.equal(deriveTurnActive({
      turnPhase: undefined,
      armedTurnId: undefined,
      runningTurnId: 'turn-elsewhere',
    }), true);
  });

  // The arm saw its own terminal event; a list fetched just before it did not.
  // Reading that snapshot as authority would light Stop back up after the turn
  // visibly ended.
  it('does not let a stale snapshot revive the arm\'s own finished turn', () => {
    assert.equal(deriveTurnActive({
      turnPhase: undefined,
      armedTurnId: 'turn-1',
      runningTurnId: 'turn-1',
    }), false);
  });

  // A new turn started elsewhere while this renderer still holds the previous
  // one's terminal projection.
  it('opens when the authority names a turn other than the settled arm', () => {
    assert.equal(deriveTurnActive({
      turnPhase: undefined,
      armedTurnId: 'turn-1',
      runningTurnId: 'turn-2',
    }), true);
  });
});

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
