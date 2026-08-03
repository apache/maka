/**
 * The one seam that tells a client its own send is live.
 *
 * No SessionEvent marks a turn's START — only its end — and the runtime writes
 * `status: 'running'` at the end of `AgentRun.begin`, announcing it to nobody.
 * Until this broadcast the earliest a client learned its turn had begun was the
 * `message-appended` riding the FIRST content event, so the entire backend
 * start-up looked idle.
 *
 * The turn id is what makes it an ANSWER rather than a bare invalidation: it
 * must be the id the renderer sent, or the arm that send placed is never
 * confirmed and a stale session list can retire it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRunStartedHook, stoppedTurnBroadcasts } from '../session-send-resolve.js';

function hookHarness(turnId: string, options: { commitFails?: boolean } = {}) {
  const answers: Array<{ sessionId: string; turnId: string }> = [];
  const commits: string[] = [];
  return {
    answers,
    commits,
    hook: createRunStartedHook({
      sessionId: 'session-a',
      turnId,
      emitSessionsChanged: (sessionId, turn) => answers.push({ sessionId, turnId: turn }),
      commitRevisionVersion: async (sessionId) => {
        commits.push(sessionId);
        if (options.commitFails) throw new Error('revision commit failed');
      },
    }),
  };
}

describe('the broadcast that answers a send', () => {
  it('names the turn the send was made with', async () => {
    const harness = hookHarness('turn-from-renderer');

    await harness.hook('run-1', {});

    assert.deepEqual(harness.answers, [
      { sessionId: 'session-a', turnId: 'turn-from-renderer' },
    ]);
  });

  // The revision commit shares this callback but nothing in the answer depends
  // on it, so it must not be able to delay the broadcast.
  it('answers before committing a prepared revision', async () => {
    const order: string[] = [];
    const hook = createRunStartedHook({
      sessionId: 'session-a',
      turnId: 'turn-1',
      emitSessionsChanged: () => order.push('answer'),
      commitRevisionVersion: async () => {
        order.push('commit');
      },
    });

    await hook('run-1', { revisionState: 'preparing' });

    assert.deepEqual(order, ['answer', 'commit']);
  });

  // A failing commit rejects the whole callback. If the answer rode behind it,
  // the client's arm would stay unconfirmed with nothing left to confirm it.
  it('survives a revision commit that throws', async () => {
    const harness = hookHarness('turn-1', { commitFails: true });

    await assert.rejects(() => harness.hook('run-1', { revisionState: 'preparing' }));

    assert.deepEqual(harness.answers, [{ sessionId: 'session-a', turnId: 'turn-1' }]);
    assert.deepEqual(harness.commits, ['session-a']);
  });

  it('does not commit a revision the session did not prepare', async () => {
    const harness = hookHarness('turn-1');

    await harness.hook('run-1', {});

    assert.deepEqual(harness.commits, []);
    assert.equal(harness.answers.length, 1, 'the answer is unconditional');
  });
});

// Stop is the one turn ending a client can be waiting on without ever having
// seen the turn start: pressed inside the send→run-start window, it is the only
// thing that will ever answer that send. Unnamed, it cannot release the claim —
// Stop would be the one control unable to undo Stop.
describe('the broadcasts that announce a stop', () => {
  it('names the turn it ended, on every reason', () => {
    assert.deepEqual(stoppedTurnBroadcasts(['turn-1']), [
      { reason: 'status-change', turnId: 'turn-1' },
      { reason: 'turn-status-change', turnId: 'turn-1' },
      { reason: 'message-appended', turnId: 'turn-1' },
    ]);
  });

  // A session can carry concurrent runs; stopping ends all of them, and a
  // client waiting on any one must hear its own turn named.
  it('names every turn it ended', () => {
    const named = stoppedTurnBroadcasts(['turn-1', 'turn-2'])
      .filter((broadcast) => broadcast.reason === 'turn-status-change')
      .map((broadcast) => broadcast.turnId);

    assert.deepEqual(named, ['turn-1', 'turn-2']);
  });

  // Nothing was running, so nothing is being answered — an unnamed change is
  // exactly what "not about any turn" means.
  it('names nothing when there was no turn to stop', () => {
    assert.deepEqual(stoppedTurnBroadcasts([]), [
      { reason: 'status-change' },
      { reason: 'turn-status-change' },
      { reason: 'message-appended' },
    ]);
  });
});
