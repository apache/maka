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

import { createRunStartedHook } from '../session-send-resolve.js';

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
