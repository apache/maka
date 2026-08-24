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
import { type RuntimeEvent } from '@maka/core/runtime-event';
import {
  buildImmutableRuntimePrefix,
  type RuntimePrefixIdentityV1,
} from '@maka/core/runtime-boundary';
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

  it('excludes hidden nested events from continuation replay context', () => {
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
            ...textEvent('hidden-nested-result', 'tool', identity),
            modelVisibility: 'hidden',
          },
        },
      ]),
      providerProjectionVersion: PROVIDER_REPLAY_PROJECTION_VERSION,
    });

    assert.equal(result.kind, 'replayable');
    if (result.kind !== 'replayable') return;
    assert.deepEqual(
      result.plan.segment.replayRuntimeEvents.map((event) => event.id),
      ['user-1'],
    );
  });

  it('trims every model-visible item when a real continuation segment has no stable anchor', () => {
    const identity = runtimeIdentity();
    const digest = `sha256:${'a'.repeat(64)}` as const;
    const result = buildContinuationReplaySegment({
      prefix: buildImmutableRuntimePrefix(identity, [
        {
          eventSeq: 1,
          event: {
            id: 'continuation-start',
            ...identity,
            ts: 1,
            partial: false,
            role: 'system',
            author: 'system',
            actions: {
              continuationStart: {
                protocol: 'continuation_start_v2',
                provenance: 'runtime_admission',
                claimId: 'claim-1',
                boundaryDigest: digest,
                immediateSource: {
                  sessionId: identity.sessionId,
                  invocationId: 'ancestor-invocation',
                  runId: 'ancestor-run',
                  turnId: 'ancestor-turn',
                  highWater: 2,
                  prefixDigest: digest,
                },
                replayManifestDigest: digest,
                providerProjectionVersion: PROVIDER_REPLAY_PROJECTION_VERSION,
                providerReplayDigest: digest,
              },
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
        {
          eventSeq: 4,
          event: {
            id: 'failed-terminal',
            ...identity,
            ts: 4,
            partial: false,
            role: 'system',
            author: 'system',
            status: 'failed',
            actions: { endInvocation: true },
          },
        },
      ]),
      providerProjectionVersion: PROVIDER_REPLAY_PROJECTION_VERSION,
    });

    assert.equal(result.kind, 'replayable');
    if (result.kind !== 'replayable') return;
    assert.deepEqual(result.plan.segment.trimmedSuffixEventIds, ['thinking-1', 'assistant-1']);
    assert.deepEqual(
      result.plan.segment.replayRuntimeEvents.map((event) => event.id),
      ['continuation-start', 'failed-terminal'],
    );
    assert.deepEqual(result.plan.providerItems, []);
  });

  it('trims a continuation pre-T1 tool call when the live start declares the durable boundary', () => {
    const identity = runtimeIdentity();
    const digest = `sha256:${'a'.repeat(64)}` as const;
    const result = buildContinuationReplaySegment({
      prefix: buildImmutableRuntimePrefix(identity, [
        {
          eventSeq: 1,
          event: {
            id: 'continuation-start',
            ...identity,
            ts: 1,
            partial: false,
            role: 'system',
            author: 'system',
            actions: {
              runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' },
              continuationStart: {
                protocol: 'continuation_start_v2',
                provenance: 'runtime_admission',
                claimId: 'claim-1',
                boundaryDigest: digest,
                immediateSource: {
                  sessionId: identity.sessionId,
                  invocationId: 'ancestor-invocation',
                  runId: 'ancestor-run',
                  turnId: 'ancestor-turn',
                  highWater: 2,
                  prefixDigest: digest,
                },
                replayManifestDigest: digest,
                providerProjectionVersion: PROVIDER_REPLAY_PROJECTION_VERSION,
                providerReplayDigest: digest,
              },
            },
          },
        },
        {
          eventSeq: 2,
          event: {
            id: 'call-1',
            ...identity,
            ts: 2,
            partial: false,
            role: 'model',
            author: 'agent',
            content: {
              kind: 'function_call',
              id: 'tool-call-1',
              name: 'Write',
              args: { path: 'notes.txt', content: 'hello' },
            },
          },
        },
        {
          eventSeq: 3,
          event: {
            id: 'failed-terminal',
            ...identity,
            ts: 3,
            partial: false,
            role: 'system',
            author: 'system',
            status: 'failed',
            actions: { endInvocation: true },
          },
        },
      ]),
      providerProjectionVersion: PROVIDER_REPLAY_PROJECTION_VERSION,
    });

    assert.equal(result.kind, 'replayable');
    if (result.kind !== 'replayable') return;
    assert.deepEqual(result.plan.segment.trimmedSuffixEventIds, ['call-1']);
    assert.deepEqual(
      result.plan.segment.replayRuntimeEvents.map((event) => event.id),
      ['continuation-start', 'failed-terminal'],
    );
    assert.deepEqual(result.plan.providerItems, []);
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
