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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeRuntimeEvent,
  decodeRuntimeInvocationOpened,
  runtimeEventHasModelVisibleContent,
  runtimeEventInvocationOpening,
  RUNTIME_EVENT_CONTENT_KINDS,
  type RuntimeEvent,
  type RuntimeEventInvocationOpenedContent,
} from '../runtime-event.js';

const DIGEST = `sha256:${'a'.repeat(64)}` as const;

function opening(
  overrides: Partial<RuntimeEventInvocationOpenedContent> = {},
): RuntimeEventInvocationOpenedContent {
  return {
    kind: 'invocation_opened',
    protocol: 'invocation_opened_v1',
    route: {
      provenance: 'runtime',
      backendKind: 'ai-sdk',
      llmConnectionId: 'conn-1',
      llmConnectionSlug: 'anthropic',
      modelId: 'claude-x',
      providerStateIdentity: DIGEST,
    },
    configuration: {
      cwd: '/repo',
      permissionMode: 'ask',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
      orchestrationSource: 'session',
      toolMode: 'direct',
    },
    root: { kind: 'user' },
    source: { kind: 'fresh' },
    ...overrides,
  };
}

function openingEvent(content: unknown): unknown {
  return {
    id: 'evt-open',
    invocationId: 'inv-1',
    runId: 'inv-1',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    ts: 10,
    partial: false,
    role: 'system',
    author: 'system',
    modelVisibility: 'hidden',
    content,
  };
}

describe('invocation_opened content contract', () => {
  test('is a runtime event content kind', () => {
    assert.ok(RUNTIME_EVENT_CONTENT_KINDS.includes('invocation_opened'));
  });

  test('decodes as RuntimeEvent content and narrows back out', () => {
    const event = decodeRuntimeEvent(openingEvent(opening()));
    const fact = runtimeEventInvocationOpening(event);
    assert.ok(fact);
    assert.equal(fact.protocol, 'invocation_opened_v1');
    assert.equal(fact.route.provenance, 'runtime');
    assert.equal(fact.route.modelId, 'claude-x');
  });

  test('is never model visible', () => {
    const event = decodeRuntimeEvent(openingEvent(opening())) as RuntimeEvent;
    assert.equal(runtimeEventHasModelVisibleContent(event), false);
  });

  test('binds connection identity to where the route came from, both ways', () => {
    const unknownRoute = {
      provenance: 'unknown',
      backendKind: 'ai-sdk',
      llmConnectionSlug: 'legacy',
      modelId: 'legacy-model',
    } as const;
    assert.equal(
      decodeRuntimeInvocationOpened(opening({ route: unknownRoute })).route.provenance,
      'unknown',
    );
    assert.throws(() =>
      decodeRuntimeInvocationOpened(
        opening({ route: { ...unknownRoute, llmConnectionId: 'conn-1' } as never }),
      ),
    );
    assert.throws(() =>
      decodeRuntimeInvocationOpened(
        opening({ route: { ...unknownRoute, provenance: 'runtime' } as never }),
      ),
    );
  });

  test('accepts every root authority the runtime can open, and no mixture of them', () => {
    for (const root of [
      { kind: 'user' },
      { kind: 'context_compact' },
      { kind: 'scheduled_task', scheduledTaskId: 'task-1' },
      { kind: 'goal', goalId: 'goal-1' },
      { kind: 'agent_graph_supervisor_wake', wakeId: 'w1', attemptId: 'a1' },
      { kind: 'legacy_automation', legacyAutomationId: 'auto-1' },
    ] as const) {
      assert.equal(decodeRuntimeInvocationOpened(opening({ root })).root.kind, root.kind);
    }
    assert.throws(() =>
      decodeRuntimeInvocationOpened(
        opening({ root: { kind: 'goal', goalId: 'g1', scheduledTaskId: 's1' } as never }),
      ),
    );
  });

  test('carries a continuation source only with the boundary position it resumes from', () => {
    const source = {
      kind: 'continuation',
      sourceInvocationId: 'inv-0',
      sourceRunId: 'inv-0',
      sourceTurnId: 'turn-0',
    } as const;
    const fact = decodeRuntimeInvocationOpened(
      opening({
        source: {
          ...source,
          sourceRuntimeEventHighWater: 7,
          claimId: 'claim-1',
          boundaryDigest: DIGEST,
        },
      }),
    );
    assert.equal(fact.source.kind, 'continuation');
    assert.throws(() => decodeRuntimeInvocationOpened(opening({ source: source as never })));
  });

  test('rejects anything the closed shape does not name', () => {
    assert.throws(() =>
      decodeRuntimeInvocationOpened({ ...opening(), runComposition: {} } as never),
    );
    assert.throws(() =>
      decodeRuntimeInvocationOpened(
        opening({
          configuration: { ...opening().configuration, sessionMode: 'agent' } as never,
        }),
      ),
    );
  });

  test('a malformed opening fact fails the whole RuntimeEvent decode', () => {
    assert.throws(() =>
      decodeRuntimeEvent(
        openingEvent({ kind: 'invocation_opened', protocol: 'invocation_opened_v1' }),
      ),
    );
  });
});
