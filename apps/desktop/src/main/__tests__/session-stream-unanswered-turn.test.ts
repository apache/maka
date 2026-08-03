/**
 * Every send the IPC accepts must be answered by a change naming its turn.
 *
 * A client arms a live-turn projection the moment it sends, and that arm stays
 * `unconfirmed` — refusing to let any session snapshot retire it — until the
 * authority says something about that exact turn. The arm is what puts Stop up
 * and locks the composer, so a send accepted and then never answered would pin
 * both for the life of the process; nothing polls, and Stop cannot clear an arm
 * it never confirms.
 *
 * A turn refused registration (session closed underneath it, duplicate turn id)
 * produces no such answer: it runs none of the streamer's callbacks. What saves
 * it is that the refusal is thrown SYNCHRONOUSLY, so it escapes the
 * `void streamEvents(...)` in the send handler, rejects that handler instead of
 * resolving `{ ok: true }`, and the client disarms in its own catch.
 *
 * That synchronicity is the whole safety property, and it is invisible at the
 * call site — a later `async` on this path would be swallowed by the `void`.
 * This locks it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSessionStreamer } from '../session-stream.js';

function refusingStreamer(reason: string) {
  const noop = new Proxy({}, { get: () => () => undefined });
  return createSessionStreamer({
    sessionActivities: noop as never,
    goalWiring: {
      coordinator: {
        beginObservedTurn: () => ({ kind: 'unavailable' as const, reason }),
      },
    } as never,
    computerUseOverlay: noop as never,
    computerUseTools: noop as never,
    safeSendToRenderer: () => undefined,
    emitSessionsChanged: () => undefined,
  });
}

describe('a turn that is refused registration', () => {
  // `assert.throws`, not `assert.rejects`: a returned rejected promise would be
  // discarded by the caller's `void`, and the client would sit on `{ ok: true }`
  // with an arm nothing can ever confirm.
  it('reaches the caller synchronously rather than as a rejected promise', () => {
    const streamEvents = refusingStreamer('Goal continuation session is closed.');

    assert.throws(
      () =>
        streamEvents('session-a', (async function* () {})(), {
          turnId: 'turn-1',
          goalBoundary: 'external',
        }),
      /session is closed/,
    );
  });

  it('reaches the caller for a duplicate turn id too', () => {
    const streamEvents = refusingStreamer('Goal turn turn-dup is already registered.');

    assert.throws(() =>
      streamEvents('session-a', (async function* () {})(), {
        turnId: 'turn-dup',
        goalBoundary: 'external',
      }),
    );
  });
});
