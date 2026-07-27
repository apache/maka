import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeEvent } from '../runtime-event.js';
import {
  buildImmutableRuntimePrefix,
  createRuntimeBoundaryCursor,
  runtimePrefixSegment,
  type RuntimePrefixIdentityV1,
} from '../runtime-boundary.js';

describe('immutable RuntimeEvent boundary', () => {
  it('derives one prefix identity from canonical event bytes and physical sequence', () => {
    const identity = runtimeIdentity('run-1');
    const first = event('event-1', identity, {
      kind: 'text',
      text: 'hello',
      displayText: 'hello',
    });
    const canonicalEquivalent = event('event-1', identity, {
      displayText: 'hello',
      text: 'hello',
      kind: 'text',
    });

    const prefix = buildImmutableRuntimePrefix(identity, [
      { eventSeq: 1, event: first },
      { eventSeq: 2, event: event('event-2', identity, { kind: 'text', text: 'world' }) },
    ]);
    const equivalent = buildImmutableRuntimePrefix(identity, [
      { eventSeq: 1, event: canonicalEquivalent },
      { eventSeq: 2, event: event('event-2', identity, { text: 'world', kind: 'text' }) },
    ]);

    assert.deepEqual(prefix.position, {
      lastEventSeq: 2,
      eventCount: 2,
      lastEventId: 'event-2',
    });
    assert.match(prefix.prefixDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(prefix.prefixDigest, equivalent.prefixDigest);
  });

  it('rejects gaps in the immutable physical sequence', () => {
    const identity = runtimeIdentity('run-1');
    assert.throws(
      () =>
        buildImmutableRuntimePrefix(identity, [
          { eventSeq: 1, event: event('event-1', identity) },
          { eventSeq: 3, event: event('event-3', identity) },
        ]),
      /event_seq gap/,
    );
  });

  it('rejects mutable partial snapshots as durable boundary rows', () => {
    const identity = runtimeIdentity('run-1');
    assert.throws(
      () =>
        buildImmutableRuntimePrefix(identity, [
          {
            eventSeq: 1,
            event: {
              ...event('partial-1', identity),
              partial: true,
            },
          },
        ]),
      /partial snapshot/,
    );
  });

  it('binds manifest identity to ordered oldest-to-source segments', () => {
    const ancestor = runtimePrefixSegment(
      buildImmutableRuntimePrefix(runtimeIdentity('run-a'), [
        { eventSeq: 1, event: event('event-a', runtimeIdentity('run-a')) },
      ]),
    );
    const source = runtimePrefixSegment(
      buildImmutableRuntimePrefix(runtimeIdentity('run-b'), [
        { eventSeq: 1, event: event('event-b', runtimeIdentity('run-b')) },
      ]),
    );

    const cursor = createRuntimeBoundaryCursor([ancestor, source]);
    const reversed = createRuntimeBoundaryCursor([source, ancestor]);

    assert.deepEqual(
      cursor.segments.map((segment) => segment.identity.runId),
      ['run-a', 'run-b'],
    );
    assert.notEqual(cursor.manifestDigest, reversed.manifestDigest);
  });

  it('rejects a forged immutable prefix before reducing it to a segment', () => {
    const identity = runtimeIdentity('run-1');
    const prefix = buildImmutableRuntimePrefix(identity, [
      { eventSeq: 1, event: event('event-1', identity) },
    ]);

    assert.throws(
      () =>
        runtimePrefixSegment({
          ...prefix,
          prefixDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      /prefix digest mismatch/,
    );
    assert.throws(
      () =>
        runtimePrefixSegment({
          ...prefix,
          position: { ...prefix.position, lastEventId: 'forged-event' },
        }),
      /prefix position mismatch/,
    );
  });
});

function runtimeIdentity(runId: string): RuntimePrefixIdentityV1 {
  return {
    sessionId: 'session-1',
    invocationId: `invocation-${runId}`,
    runId,
    turnId: `turn-${runId}`,
  };
}

function event(
  id: string,
  identity: RuntimePrefixIdentityV1,
  content: RuntimeEvent['content'] = { kind: 'text', text: id },
): RuntimeEvent {
  return {
    id,
    ...identity,
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content,
  };
}
