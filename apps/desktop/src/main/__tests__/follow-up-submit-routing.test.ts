import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  hasActiveTurnAtSubmit,
  resolveFollowUpModeAtSubmit,
} from '../../renderer/follow-up-submit-routing.js';

describe('follow-up submit routing', () => {
  it('uses the synchronous arm but ignores its stale authoritative running id after terminal', () => {
    assert.equal(
      hasActiveTurnAtSubmit({
        liveTurn: { turnId: 'turn-1' },
        runningTurnIds: [],
      }),
      true,
    );
    assert.equal(
      hasActiveTurnAtSubmit({
        liveTurn: { turnId: 'turn-1', terminal: true },
        runningTurnIds: ['turn-1'],
      }),
      false,
    );
    assert.equal(
      hasActiveTurnAtSubmit({
        liveTurn: { turnId: 'turn-1', terminal: true },
        runningTurnIds: ['turn-1', 'turn-2'],
      }),
      true,
    );
  });

  it('routes through the default follow-up mode while the synchronous turn arm is active', () => {
    assert.equal(
      resolveFollowUpModeAtSubmit({
        defaultMode: 'queue',
        hasActiveTurn: true,
      }),
      'queue',
    );
  });

  it('preserves an explicit Queue or Steer choice', () => {
    assert.equal(
      resolveFollowUpModeAtSubmit({
        requestedMode: 'steer',
        defaultMode: 'queue',
        hasActiveTurn: true,
      }),
      'steer',
    );
  });

  it('starts a normal turn only when no active-turn witness exists', () => {
    assert.equal(
      resolveFollowUpModeAtSubmit({
        defaultMode: 'queue',
        hasActiveTurn: false,
      }),
      undefined,
    );
  });
});
