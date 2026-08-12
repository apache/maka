import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  SESSION_EVENT_STREAM_STALE_AFTER_MS,
  deriveSessionEventStreamStatus,
  newestSessionStreamObservation,
  sessionExpectsEventStream,
  shouldRefreshStaleSessionEventStream,
} from '../session-event-health.js';

describe('session event stream health contract', () => {
  it('expects a stream for running sessions or live renderer activity only', () => {
    assert.equal(sessionExpectsEventStream('running'), true);
    assert.equal(sessionExpectsEventStream('active'), false);
    assert.equal(sessionExpectsEventStream('active', true), true);
    assert.equal(sessionExpectsEventStream(undefined), false);
  });

  it('uses the newest known observation as the staleness anchor', () => {
    assert.equal(
      newestSessionStreamObservation({ subscribedAt: 10, lastEventAt: 20, lastChangedAt: 15 }),
      20,
    );
    assert.equal(newestSessionStreamObservation({ subscribedAt: 10, lastChangedAt: 25 }), 25);
    assert.equal(newestSessionStreamObservation({ subscribedAt: 10 }), 10);
  });

  it('marks expected streams stale after the configured threshold', () => {
    const subscribedAt = 1_000;
    assert.equal(
      deriveSessionEventStreamStatus({
        now: subscribedAt + SESSION_EVENT_STREAM_STALE_AFTER_MS - 1,
        subscribedAt,
        expected: true,
      }),
      'connected',
    );
    assert.equal(
      deriveSessionEventStreamStatus({
        now: subscribedAt + SESSION_EVENT_STREAM_STALE_AFTER_MS,
        subscribedAt,
        expected: true,
      }),
      'stale',
    );
  });

  it('reports recovered for the first healthy check after a stale state', () => {
    assert.equal(
      deriveSessionEventStreamStatus({
        now: 3_000,
        subscribedAt: 1_000,
        lastEventAt: 2_900,
        previousStatus: 'stale',
        expected: true,
      }),
      'recovered',
    );
  });

  it('throttles stale recovery refresh requests', () => {
    assert.equal(shouldRefreshStaleSessionEventStream({ status: 'connected', now: 20_000 }), false);
    assert.equal(shouldRefreshStaleSessionEventStream({ status: 'stale', now: 20_000 }), true);
    assert.equal(
      shouldRefreshStaleSessionEventStream({
        status: 'stale',
        now: 20_000,
        refreshRequestedAt: 15_000,
        cooldownMs: 10_000,
      }),
      false,
    );
    assert.equal(
      shouldRefreshStaleSessionEventStream({
        status: 'stale',
        now: 25_000,
        refreshRequestedAt: 15_000,
        cooldownMs: 10_000,
      }),
      true,
    );
  });
});
