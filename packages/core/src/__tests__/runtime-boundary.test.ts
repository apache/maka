/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeRuntimeEvent, type RuntimeEvent } from '../runtime-event.js';
import {
  buildImmutableRuntimePrefix,
  createRuntimeBoundaryCursor,
  decodeContinuationClaim,
  runtimePrefixSegment,
  type RuntimeBoundaryCursorV1,
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

  it('preserves the released Automation prefix identity after semantic decoding', () => {
    const identity = runtimeIdentity('run-legacy');
    const releasedEvent = decodeRuntimeEvent({
      ...event('event-legacy', identity),
      content: {
        kind: 'text',
        text: 'automated prompt',
        origin: { kind: 'automation', automationId: 'automation-1' },
      },
    });

    const prefix = buildImmutableRuntimePrefix(identity, [{ eventSeq: 1, event: releasedEvent }]);

    assert.equal(
      prefix.prefixDigest,
      'sha256:d4c8211024788a3fd7554a644f6983f6af088eeb050404f507c76a519080d7ca',
    );
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

  it('rejects a boundary whose segments cross session authority', () => {
    const ancestor = runtimePrefixSegment(
      buildImmutableRuntimePrefix(runtimeIdentity('run-a'), [
        { eventSeq: 1, event: event('event-a', runtimeIdentity('run-a')) },
      ]),
    );
    const foreignIdentity = {
      ...runtimeIdentity('run-b'),
      sessionId: 'session-2',
    };
    const foreignSource = runtimePrefixSegment(
      buildImmutableRuntimePrefix(foreignIdentity, [
        { eventSeq: 1, event: event('event-b', foreignIdentity) },
      ]),
    );

    assert.throws(() => createRuntimeBoundaryCursor([ancestor, foreignSource]), /same session/);
  });

  it('rejects a boundary that reuses a source run identity', () => {
    const firstIdentity = runtimeIdentity('run-shared');
    const secondIdentity = {
      ...firstIdentity,
      invocationId: 'invocation-second',
      turnId: 'turn-second',
    };
    const first = runtimePrefixSegment(
      buildImmutableRuntimePrefix(firstIdentity, [
        { eventSeq: 1, event: event('event-first', firstIdentity) },
      ]),
    );
    const second = runtimePrefixSegment(
      buildImmutableRuntimePrefix(secondIdentity, [
        { eventSeq: 1, event: event('event-second', secondIdentity) },
      ]),
    );

    assert.throws(() => createRuntimeBoundaryCursor([first, second]), /duplicate runId/);
  });

  it('rejects a boundary that reuses a source invocation identity', () => {
    const firstIdentity = runtimeIdentity('run-first');
    const secondIdentity = {
      ...runtimeIdentity('run-second'),
      invocationId: firstIdentity.invocationId,
    };
    const first = runtimePrefixSegment(
      buildImmutableRuntimePrefix(firstIdentity, [
        { eventSeq: 1, event: event('event-first', firstIdentity) },
      ]),
    );
    const second = runtimePrefixSegment(
      buildImmutableRuntimePrefix(secondIdentity, [
        { eventSeq: 1, event: event('event-second', secondIdentity) },
      ]),
    );

    assert.throws(() => createRuntimeBoundaryCursor([first, second]), /duplicate invocationId/);
  });

  it('rejects a boundary that reuses a source turn identity', () => {
    const firstIdentity = runtimeIdentity('run-first');
    const secondIdentity = {
      ...runtimeIdentity('run-second'),
      turnId: firstIdentity.turnId,
    };
    const first = runtimePrefixSegment(
      buildImmutableRuntimePrefix(firstIdentity, [
        { eventSeq: 1, event: event('event-first', firstIdentity) },
      ]),
    );
    const second = runtimePrefixSegment(
      buildImmutableRuntimePrefix(secondIdentity, [
        { eventSeq: 1, event: event('event-second', secondIdentity) },
      ]),
    );

    assert.throws(() => createRuntimeBoundaryCursor([first, second]), /duplicate turnId/);
  });

  it('requires a continuation target to remain in the source session', () => {
    const boundary = boundaryForRuns('run-source');

    assert.throws(
      () =>
        decodeContinuationClaim({
          ...claimForBoundary(boundary),
          target: {
            ...claimForBoundary(boundary).target,
            sessionId: 'session-foreign',
          },
        }),
      /target session differs/,
    );
  });

  it('rejects a continuation target that reuses any source run identity', () => {
    const boundary = boundaryForRuns('run-ancestor', 'run-source');
    const claim = claimForBoundary(boundary);

    assert.throws(
      () =>
        decodeContinuationClaim({
          ...claim,
          target: { ...claim.target, runId: 'run-ancestor' },
        }),
      /target runId reuses source identity/,
    );
  });

  it('rejects a continuation target that reuses any source invocation identity', () => {
    const boundary = boundaryForRuns('run-ancestor', 'run-source');
    const claim = claimForBoundary(boundary);

    assert.throws(
      () =>
        decodeContinuationClaim({
          ...claim,
          target: {
            ...claim.target,
            invocationId: boundary.segments[0].identity.invocationId,
          },
        }),
      /target invocationId reuses source identity/,
    );
  });

  it('rejects a continuation target that reuses any source turn identity', () => {
    const boundary = boundaryForRuns('run-ancestor', 'run-source');
    const claim = claimForBoundary(boundary);

    assert.throws(
      () =>
        decodeContinuationClaim({
          ...claim,
          target: {
            ...claim.target,
            turnId: boundary.segments[0].identity.turnId,
          },
        }),
      /target turnId reuses source identity/,
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

function boundaryForRuns(...runIds: string[]): RuntimeBoundaryCursorV1 {
  const segments = runIds.map((runId) => {
    const identity = runtimeIdentity(runId);
    return runtimePrefixSegment(
      buildImmutableRuntimePrefix(identity, [
        { eventSeq: 1, event: event(`event-${runId}`, identity) },
      ]),
    );
  }) as [ReturnType<typeof runtimePrefixSegment>, ...ReturnType<typeof runtimePrefixSegment>[]];
  return createRuntimeBoundaryCursor(segments);
}

function claimForBoundary(boundary: RuntimeBoundaryCursorV1) {
  const source = boundary.segments.at(-1)!;
  const target = {
    sessionId: boundary.segments[0].identity.sessionId,
    invocationId: 'target-invocation',
    runId: 'target-run',
    turnId: 'target-turn',
  };
  return {
    protocol: 'continuation_claim_v1',
    claimId: 'claim-1',
    boundaryDigest: boundary.manifestDigest,
    boundary,
    providerProjectionVersion: 1,
    providerReplayDigest: `sha256:${'b'.repeat(64)}`,
    target,
    targetRunHeader: {
      runId: target.runId,
      invocationId: target.invocationId,
      sessionId: target.sessionId,
      turnId: target.turnId,
      status: 'created',
      backendKind: 'fake',
      llmConnectionSlug: 'connection-1',
      modelId: 'model-1',
      cwd: '/workspace',
      permissionMode: 'ask',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
      orchestrationSource: 'session',
      createdAt: 1,
      updatedAt: 1,
      parentRunId: source.identity.runId,
      parentTurnId: source.identity.turnId,
      continuationSource: {
        protocol: 'continuation_source_v2',
        claimId: 'claim-1',
        boundaryDigest: boundary.manifestDigest,
        sourceInvocationId: source.identity.invocationId,
        sourceRunId: source.identity.runId,
        sourceTurnId: source.identity.turnId,
        sourceRuntimeEventHighWater: source.position.lastEventSeq,
        sourcePrefixDigest: source.prefixDigest,
        replayManifestDigest: boundary.manifestDigest,
      },
    },
    claimedAt: 1,
  };
}
