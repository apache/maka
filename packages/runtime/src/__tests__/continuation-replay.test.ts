import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildImmutableRuntimePrefix,
  type RuntimeEvent,
  type RuntimePrefixIdentityV1,
} from '@maka/core';
import {
  buildContinuationReplayPlan,
  buildContinuationReplaySegment,
} from '../continuation-replay.js';
import { PROVIDER_REPLAY_PROJECTION_VERSION } from '../model-history.js';

describe('continuation replay segment', () => {
  it('trims an interrupted assistant suffix after the last stable user boundary', () => {
    const identity = runtimeIdentity();
    const result = buildContinuationReplaySegment({
      prefix: buildImmutableRuntimePrefix(identity, [
        {
          eventSeq: 1,
          event: {
            ...textEvent('user-1', 'user', identity),
            actions: {
              runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' },
            },
          },
        },
        {
          eventSeq: 2,
          event: {
            ...textEvent('thinking-1', 'model', identity),
            content: { kind: 'thinking', text: 'unfinished', signature: 'signed-1' },
          },
        },
        { eventSeq: 3, event: textEvent('assistant-1', 'model', identity) },
      ]),
      providerProjectionVersion: PROVIDER_REPLAY_PROJECTION_VERSION,
    });

    assert.equal(result.kind, 'replayable');
    if (result.kind !== 'replayable') return;
    assert.deepEqual(result.plan.segment.trimmedSuffixEventIds, ['thinking-1', 'assistant-1']);
    assert.deepEqual(
      result.plan.segment.replayRuntimeEvents.map((event) => event.id),
      ['user-1'],
    );
    assert.deepEqual(
      result.plan.providerItems.map((item) => item.eventId),
      ['user-1'],
    );
  });

  it('blocks an unmatched tool call followed by replayable assistant content', () => {
    const identity = runtimeIdentity();
    const result = buildContinuationReplaySegment({
      prefix: buildImmutableRuntimePrefix(identity, [
        {
          eventSeq: 1,
          event: {
            ...textEvent('user-1', 'user', identity),
            actions: {
              runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' },
            },
          },
        },
        {
          eventSeq: 2,
          event: {
            ...textEvent('call-1', 'model', identity),
            content: { kind: 'function_call', id: 'tool-1', name: 'Read', args: {} },
          },
        },
        { eventSeq: 3, event: textEvent('assistant-1', 'model', identity) },
      ]),
      providerProjectionVersion: PROVIDER_REPLAY_PROJECTION_VERSION,
    });

    assert.equal(result.kind, 'blocked');
    if (result.kind !== 'blocked') return;
    assert.equal(result.reason, 'provider_replay_non_suffix_gap');
  });

  it('projects every lineage segment once and never reintroduces an ancestor suffix', () => {
    const ancestorIdentity = runtimeIdentity();
    const sourceIdentity: RuntimePrefixIdentityV1 = {
      ...ancestorIdentity,
      invocationId: 'invocation-2',
      runId: 'run-2',
      turnId: 'turn-2',
    };
    const ancestor = buildImmutableRuntimePrefix(ancestorIdentity, [
      {
        eventSeq: 1,
        event: {
          ...textEvent('root-user', 'user', ancestorIdentity),
          actions: {
            runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' },
          },
        },
      },
      {
        eventSeq: 2,
        event: {
          ...textEvent('root-thinking', 'model', ancestorIdentity),
          content: { kind: 'thinking', text: 'interrupted', signature: 'signed-root' },
        },
      },
      {
        eventSeq: 3,
        event: textEvent('root-interrupted-text', 'model', ancestorIdentity),
      },
    ]);
    const source = buildImmutableRuntimePrefix(sourceIdentity, [
      {
        eventSeq: 1,
        event: {
          ...textEvent('child-user', 'user', sourceIdentity),
          actions: {
            runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' },
          },
        },
      },
    ]);

    const result = buildContinuationReplayPlan({
      prefixes: [ancestor, source],
      providerProjectionVersion: PROVIDER_REPLAY_PROJECTION_VERSION,
    });

    assert.equal(result.kind, 'replayable');
    if (result.kind !== 'replayable') return;
    assert.deepEqual(
      result.plan.runtimeContext.map((event) => event.id),
      ['root-user', 'child-user'],
    );
    assert.deepEqual(
      result.plan.segments.map((segment) => segment.trimmedSuffixEventIds),
      [['root-thinking', 'root-interrupted-text'], []],
    );
    assert.deepEqual(
      result.plan.boundary.segments.map((segment) => segment.identity.runId),
      ['run-1', 'run-2'],
    );
  });
});

function runtimeIdentity(): RuntimePrefixIdentityV1 {
  return {
    sessionId: 'session-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    turnId: 'turn-1',
  };
}

function textEvent(
  id: string,
  role: RuntimeEvent['role'],
  identity: RuntimePrefixIdentityV1,
): RuntimeEvent {
  return {
    id,
    ...identity,
    ts: 1,
    partial: false,
    role,
    author: role === 'user' ? 'user' : 'agent',
    content: { kind: 'text', text: id },
  };
}
