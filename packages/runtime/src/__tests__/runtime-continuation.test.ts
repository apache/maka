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
import { test } from 'node:test';

import {
  buildImmutableRuntimePrefix,
  createRuntimeBoundaryCursor,
  runtimePrefixSegment,
  type ImmutableRuntimePrefixV1,
} from '@maka/core/runtime-boundary';
import type { RuntimeEvent, RuntimeEventInvocationOpenedContent } from '@maka/core/runtime-event';
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';

import { createLocalContinuationSafetyInspector } from '../continuation-safety.js';
import { buildContinuationReplayPlan } from '../continuation-replay.js';
import {
  buildRuntimeEventModelReplayPlan,
  PROVIDER_REPLAY_PROJECTION_VERSION,
} from '../model-history.js';
import {
  RuntimeContinuationPlanner,
  buildSafeBoundaryContinuationPlan,
  type RuntimeContinuation,
} from '../runtime-resume.js';
import { testInvocationRecord } from './invocation-fixture.js';

test('local continuation safety inspector returns current authoritative workspace facts', async () => {
  const inspect = createLocalContinuationSafetyInspector({
    readSessionCwd: async () => '/workspace/repo-link',
    resolveWorkspaceIdentity: async () => ({
      workspaceIdentity: 'workspace:v1:123e4567-e89b-42d3-a456-426614174000',
      canonicalPath: '/workspace/repo',
    }),
    listAvailableToolNames: async () => ['Write', 'Read', 'Read'],
    hasPendingBackgroundOperations: async () => false,
  });

  assert.deepEqual(await inspect('session-1'), {
    workspaceIdentity: 'workspace:v1:123e4567-e89b-42d3-a456-426614174000',
    workspacePath: '/workspace/repo',
    backgroundOperationsSettled: true,
    availableToolNames: ['Read', 'Write'],
  });
});

test('RuntimeContinuationPlanner reads the durable source boundary and allocates fresh identities', async () => {
  const sourceEvents = [
    event({
      id: 'source-user',
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'continue' },
    }),
    event({
      id: 'source-terminal',
      role: 'system',
      author: 'system',
      status: 'failed',
      actions: { endInvocation: true },
    }),
  ];
  const sourcePrefix = immutablePrefix(sourceEvents);
  // Run and invocation are one identity, so the planner mints three ids, not four.
  const ids = ['invocation-2', 'turn-2', 'claim-2'];
  const planner = new RuntimeContinuationPlanner({
    readSourceInvocation: async () => runInvocation('run-1'),
    readImmutableRuntimePrefix: async () => sourcePrefix,
    newId: () => ids.shift() ?? 'unexpected-id',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    admissionRoute: sameRouteAdmission(),
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'continue');
  assert.deepEqual(plan.continuation, {
    sessionId: 'session-1',
    invocationId: 'invocation-2',
    runId: 'invocation-2',
    turnId: 'turn-2',
    sourceInvocationId: 'invocation-1',
    sourceRunId: 'run-1',
    sourceTurnId: 'turn-1',
    sourceRuntimeEventHighWater: 2,
    claimId: 'claim-2',
    runtimeContext: sourceEvents,
    boundary: {
      protocol: 'runtime_boundary_cursor_v1',
      segments: [
        {
          protocol: 'runtime_prefix_segment_v1',
          identity: sourcePrefix.identity,
          position: sourcePrefix.position,
          prefixDigest: sourcePrefix.prefixDigest,
        },
      ],
      manifestDigest: plan.continuation?.boundary?.manifestDigest,
    },
    providerReplayDigest: plan.continuation?.providerReplayDigest,
    providerProjectionVersion: PROVIDER_REPLAY_PROJECTION_VERSION,
    safetySnapshot: {
      workspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    },
  });
});

test('RuntimeContinuationPlanner parks with a stable reason when the ledger cannot be read', async () => {
  const planner = new RuntimeContinuationPlanner({
    readSourceInvocation: async () => runInvocation('run-1'),
    readImmutableRuntimePrefix: async () => {
      throw new Error('corrupt ledger');
    },
    newId: () => 'unused',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    admissionRoute: sameRouteAdmission(),
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['runtime_ledger_unreadable']);
});

test('RuntimeContinuationPlanner derives terminal repair from durable run and event facts', async () => {
  const planner = new RuntimeContinuationPlanner({
    readSourceInvocation: async () => runInvocation('run-1', { outcome: 'open' }),
    readImmutableRuntimePrefix: async () =>
      immutablePrefix([
        event({
          id: 'source-user',
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'continue' },
        }),
      ]),
    newId: () => 'fresh-id',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    admissionRoute: sameRouteAdmission(),
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['terminal_repair_failed']);
});

test('RuntimeContinuationPlanner parks when the source ledger does not end on its terminal fact', async () => {
  const planner = new RuntimeContinuationPlanner({
    readSourceInvocation: async () => runInvocation('run-1', { outcome: 'completed' }),
    readImmutableRuntimePrefix: async () =>
      immutablePrefix([
        event({
          id: 'source-terminal',
          role: 'system',
          author: 'system',
          status: 'failed',
          actions: { endInvocation: true },
        }),
        event({
          id: 'source-user',
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'continue' },
        }),
      ]),
    newId: () => 'fresh-id',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    admissionRoute: sameRouteAdmission(),
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['terminal_repair_failed']);
});

test('RuntimeContinuationPlanner rejects immutable output after the source terminal fact', async () => {
  const planner = new RuntimeContinuationPlanner({
    readSourceInvocation: async () => runInvocation('run-1'),
    readImmutableRuntimePrefix: async () =>
      immutablePrefix([
        event({
          id: 'source-user',
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'continue' },
        }),
        event({
          id: 'source-terminal',
          role: 'system',
          author: 'system',
          status: 'failed',
          actions: { endInvocation: true },
        }),
        event({
          id: 'post-terminal-output',
          ts: 3,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'must invalidate the boundary' },
        }),
      ]),
    newId: () => 'fresh-id',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    admissionRoute: sameRouteAdmission(),
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['terminal_repair_failed']);
});

test('RuntimeContinuationPlanner uses canonical provider items for composite head and tail gates', async () => {
  let nextId = 0;
  const planner = new RuntimeContinuationPlanner({
    readSourceInvocation: async () => runInvocation('run-1'),
    readImmutableRuntimePrefix: async () =>
      immutablePrefix([
        event({
          id: 'source-user',
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'continue' },
        }),
        event({
          id: 'empty-model-text',
          ts: 2,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: '' },
        }),
        event({
          id: 'source-terminal',
          ts: 3,
          role: 'system',
          author: 'system',
          status: 'failed',
          actions: { endInvocation: true },
        }),
      ]),
    newId: () => `fresh-id-${++nextId}`,
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    admissionRoute: sameRouteAdmission(),
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'continue');
  assert.ok(plan.continuation);
  assert.deepEqual(plan.rejectionReasons, []);
});

test('RuntimeContinuationPlanner rejects a ledger returned for another source run', async () => {
  const planner = new RuntimeContinuationPlanner({
    readSourceInvocation: async () => runInvocation('run-1'),
    readImmutableRuntimePrefix: async () =>
      immutablePrefix([
        event({
          id: 'wrong-user',
          runId: 'run-other',
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'continue' },
        }),
        event({
          id: 'wrong-terminal',
          runId: 'run-other',
          role: 'system',
          author: 'system',
          status: 'failed',
          actions: { endInvocation: true },
        }),
      ]),
    newId: () => 'fresh-id',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    admissionRoute: sameRouteAdmission(),
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['runtime_identity_mismatch']);
});

test('RuntimeContinuationPlanner fails a cyclic continuation lineage closed', async () => {
  const runs = {
    'run-1': runInvocation('run-1', {
      source: {
        kind: 'continuation' as const,
        sourceInvocationId: 'invocation-2',
        sourceRunId: 'run-2',
        sourceTurnId: 'turn-2',
        sourceRuntimeEventHighWater: 1,
      },
    }),
    'run-2': runInvocation('run-2', {
      source: {
        kind: 'continuation' as const,
        sourceInvocationId: 'invocation-1',
        sourceRunId: 'run-1',
        sourceTurnId: 'turn-1',
        sourceRuntimeEventHighWater: 1,
      },
    }),
  } as const;
  const prefixes = new Map([
    ['run-1', prefixForIdentity('invocation-1', 'run-1', 'turn-1')],
    ['run-2', prefixForIdentity('invocation-2', 'run-2', 'turn-2')],
  ]);
  const planner = new RuntimeContinuationPlanner({
    readSourceInvocation: async (_sessionId, runId) => runs[runId as keyof typeof runs],
    readImmutableRuntimePrefix: async ({ runId }) => prefixes.get(runId)!,
    newId: () => 'unused',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    admissionRoute: sameRouteAdmission(),
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['runtime_lineage_cycle']);
});

test('RuntimeContinuationPlanner parks when a continuation ancestor is unavailable', async () => {
  const source = prefixForIdentity('invocation-2', 'run-2', 'turn-2');
  const planner = new RuntimeContinuationPlanner({
    readSourceInvocation: async (_sessionId, runId) => {
      if (runId === 'run-2') {
        return runInvocation('run-2', {
          source: {
            kind: 'continuation' as const,
            sourceInvocationId: 'invocation-1',
            sourceRunId: 'run-missing',
            sourceTurnId: 'turn-1',
            sourceRuntimeEventHighWater: 1,
          },
        });
      }
      throw new Error('missing ancestor');
    },
    readImmutableRuntimePrefix: async ({ runId }) => {
      if (runId === 'run-2') return source;
      throw new Error('missing ancestor prefix');
    },
    newId: () => 'unused',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-2',
    admissionRoute: sameRouteAdmission(),
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['runtime_lineage_missing']);
});

test('RuntimeContinuationPlanner caps continuation lineage at 64 segments', async () => {
  const runs = new Map<string, RuntimeInvocationRecord>();
  const prefixes = new Map<string, ImmutableRuntimePrefixV1>();
  for (let index = 1; index <= 64; index += 1) {
    const runId = `run-${index}`;
    runs.set(
      runId,
      runInvocation(runId, {
        source: {
          kind: 'continuation' as const,
          sourceInvocationId: `invocation-${index + 1}`,
          sourceRunId: `run-${index + 1}`,
          sourceTurnId: `turn-${index + 1}`,
          sourceRuntimeEventHighWater: 1,
        },
      }),
    );
    prefixes.set(runId, prefixForIdentity(`invocation-${index}`, runId, `turn-${index}`));
  }
  const planner = new RuntimeContinuationPlanner({
    readSourceInvocation: async (_sessionId, runId) => {
      const run = runs.get(runId);
      if (!run) throw new Error('unexpected lineage read');
      return run;
    },
    readImmutableRuntimePrefix: async ({ runId }) => {
      const prefix = prefixes.get(runId);
      if (!prefix) throw new Error('unexpected lineage prefix read');
      return prefix;
    },
    newId: () => 'unused',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    admissionRoute: sameRouteAdmission(),
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['runtime_lineage_depth_exceeded']);
});

test('RuntimeContinuationPlanner verifies a v2 lineage edge prefix digest', async () => {
  const ancestor = prefixForIdentity('invocation-1', 'run-1', 'turn-1');
  const source = immutablePrefix([
    event({
      id: 'run-2-start',
      invocationId: 'invocation-2',
      runId: 'run-2',
      turnId: 'turn-2',
      role: 'system',
      author: 'system',
      actions: {
        continuationStart: {
          protocol: 'continuation_start_v2',
          provenance: 'runtime_admission',
          claimId: 'claim-1',
          boundaryDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          immediateSource: {
            sessionId: 'session-1',
            invocationId: 'invocation-1',
            runId: 'run-1',
            turnId: 'turn-1',
            highWater: 1,
            prefixDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          },
          providerProjectionVersion: 1,
          providerReplayDigest:
            'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          replayManifestDigest:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      },
    }),
  ]);
  const planner = new RuntimeContinuationPlanner({
    readSourceInvocation: async (_sessionId, runId) =>
      runId === 'run-2'
        ? runInvocation('run-2', {
            source: {
              kind: 'continuation' as const,
              claimId: 'claim-1',
              boundaryDigest:
                'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              sourceInvocationId: 'invocation-1',
              sourceRunId: 'run-1',
              sourceTurnId: 'turn-1',
              sourceRuntimeEventHighWater: 1,
            },
          })
        : runInvocation('run-1'),
    readImmutableRuntimePrefix: async ({ runId }) => (runId === 'run-2' ? source : ancestor),
    newId: () => 'unused',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-2',
    admissionRoute: sameRouteAdmission(),
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['source_prefix_digest_mismatch']);
});

test('RuntimeContinuationPlanner binds every v2 lineage edge to its continuation-start T1', async () => {
  const ancestor = prefixForIdentity('invocation-1', 'run-1', 'turn-1');
  const ancestorBoundary = createRuntimeBoundaryCursor([runtimePrefixSegment(ancestor)]);
  const sourceIdentity = {
    sessionId: 'session-1',
    invocationId: 'invocation-2',
    runId: 'run-2',
    turnId: 'turn-2',
  };
  const source = immutablePrefix([
    event({
      id: 'continuation-start-2',
      ...sourceIdentity,
      role: 'system',
      author: 'system',
      actions: {
        continuationStart: {
          protocol: 'continuation_start_v2',
          provenance: 'runtime_admission',
          claimId: 'forged-claim',
          boundaryDigest: ancestorBoundary.manifestDigest,
          immediateSource: {
            ...ancestor.identity,
            highWater: ancestor.position.lastEventSeq,
            prefixDigest: ancestor.prefixDigest,
          },
          replayManifestDigest: ancestorBoundary.manifestDigest,
          providerProjectionVersion: 1,
          providerReplayDigest:
            'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        },
      },
    }),
    event({
      id: 'run-2-terminal',
      ...sourceIdentity,
      role: 'system',
      author: 'system',
      status: 'failed',
      actions: { endInvocation: true },
    }),
  ]);
  const planner = new RuntimeContinuationPlanner({
    readSourceInvocation: async (_sessionId, runId) =>
      runId === 'run-2'
        ? runInvocation('run-2', {
            source: {
              kind: 'continuation' as const,
              claimId: 'claim-expected',
              boundaryDigest: ancestorBoundary.manifestDigest,
              sourceInvocationId: ancestor.identity.invocationId,
              sourceRunId: ancestor.identity.runId,
              sourceTurnId: ancestor.identity.turnId,
              sourceRuntimeEventHighWater: ancestor.position.lastEventSeq,
            },
          })
        : runInvocation('run-1'),
    readImmutableRuntimePrefix: async ({ runId }) => (runId === 'run-2' ? source : ancestor),
    newId: () => 'unused',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-2',
    admissionRoute: sameRouteAdmission(),
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['runtime_lineage_start_mismatch']);
});

test('RuntimeContinuationPlanner rejects downgrading a canonical v2 start to legacy lineage', async () => {
  const ancestor = prefixForIdentity('invocation-1', 'run-1', 'turn-1');
  const ancestorReplay = buildContinuationReplayPlan({
    prefixes: [ancestor],
    providerProjectionVersion: PROVIDER_REPLAY_PROJECTION_VERSION,
    admissionRoute: sameRouteAdmission(),
  });
  assert.equal(ancestorReplay.kind, 'replayable');
  if (ancestorReplay.kind !== 'replayable') return;
  const sourceIdentity = {
    sessionId: 'session-1',
    invocationId: 'invocation-2',
    runId: 'run-2',
    turnId: 'turn-2',
  };
  const source = immutablePrefix([
    event({
      id: 'continuation-start-2',
      ...sourceIdentity,
      role: 'system',
      author: 'system',
      actions: {
        continuationStart: {
          protocol: 'continuation_start_v2',
          provenance: 'runtime_admission',
          claimId: 'claim-1',
          boundaryDigest: ancestorReplay.plan.boundary.manifestDigest,
          immediateSource: {
            ...ancestor.identity,
            highWater: ancestor.position.lastEventSeq,
            prefixDigest: ancestor.prefixDigest,
          },
          replayManifestDigest: ancestorReplay.plan.boundary.manifestDigest,
          providerProjectionVersion: PROVIDER_REPLAY_PROJECTION_VERSION,
          providerReplayDigest: ancestorReplay.plan.providerReplayDigest,
        },
      },
    }),
    event({
      id: 'run-2-terminal',
      ...sourceIdentity,
      ts: 2,
      role: 'system',
      author: 'system',
      status: 'failed',
      actions: { endInvocation: true },
    }),
  ]);
  const planner = new RuntimeContinuationPlanner({
    readSourceInvocation: async (_sessionId, runId) =>
      runId === sourceIdentity.runId
        ? runInvocation(sourceIdentity.runId, {
            source: {
              kind: 'continuation' as const,
              sourceInvocationId: ancestor.identity.invocationId,
              sourceRunId: ancestor.identity.runId,
              sourceTurnId: ancestor.identity.turnId,
              sourceRuntimeEventHighWater: ancestor.position.lastEventSeq,
            },
          })
        : runInvocation('run-1'),
    readImmutableRuntimePrefix: async ({ runId }) =>
      runId === sourceIdentity.runId ? source : ancestor,
    newId: () => 'unused',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: sourceIdentity.runId,
    admissionRoute: sameRouteAdmission(),
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['runtime_lineage_start_mismatch']);
});

test('RuntimeContinuationPlanner requires a durable target before authenticating edge replay', async () => {
  const ancestor = prefixForIdentity('invocation-1', 'run-1', 'turn-1');
  const ancestorReplay = buildContinuationReplayPlan({
    prefixes: [ancestor],
    providerProjectionVersion: PROVIDER_REPLAY_PROJECTION_VERSION,
    admissionRoute: sameRouteAdmission(),
  });
  assert.equal(ancestorReplay.kind, 'replayable');
  if (ancestorReplay.kind !== 'replayable') return;
  const sourceIdentity = {
    sessionId: 'session-1',
    invocationId: 'invocation-2',
    runId: 'run-2',
    turnId: 'turn-2',
  };
  const source = immutablePrefix([
    event({
      id: 'continuation-start-2',
      ...sourceIdentity,
      role: 'system',
      author: 'system',
      actions: {
        continuationStart: {
          protocol: 'continuation_start_v2',
          provenance: 'runtime_admission',
          claimId: 'claim-1',
          boundaryDigest: ancestorReplay.plan.boundary.manifestDigest,
          immediateSource: {
            ...ancestor.identity,
            highWater: ancestor.position.lastEventSeq,
            prefixDigest: ancestor.prefixDigest,
          },
          replayManifestDigest: ancestorReplay.plan.boundary.manifestDigest,
          providerProjectionVersion: PROVIDER_REPLAY_PROJECTION_VERSION,
          providerReplayDigest:
            'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        },
      },
    }),
    event({
      id: 'run-2-terminal',
      ...sourceIdentity,
      role: 'system',
      author: 'system',
      status: 'failed',
      actions: { endInvocation: true },
    }),
  ]);
  const planner = new RuntimeContinuationPlanner({
    readSourceInvocation: async (_sessionId, runId) =>
      runId === sourceIdentity.runId
        ? runInvocation(sourceIdentity.runId, {
            source: {
              kind: 'continuation' as const,
              claimId: 'claim-1',
              boundaryDigest: ancestorReplay.plan.boundary.manifestDigest,
              sourceInvocationId: ancestor.identity.invocationId,
              sourceRunId: ancestor.identity.runId,
              sourceTurnId: ancestor.identity.turnId,
              sourceRuntimeEventHighWater: ancestor.position.lastEventSeq,
            },
          })
        : runInvocation('run-1'),
    readImmutableRuntimePrefix: async ({ runId }) =>
      runId === sourceIdentity.runId ? source : ancestor,
    newId: () => 'unused',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: sourceIdentity.runId,
    admissionRoute: sameRouteAdmission(),
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['continuation_authority_unavailable']);
});

test('RuntimeContinuationPlanner rejects a v2 lineage edge whose durable claim is missing', async () => {
  const ancestor = prefixForIdentity('invocation-1', 'run-1', 'turn-1');
  const ancestorReplay = buildContinuationReplayPlan({
    prefixes: [ancestor],
    providerProjectionVersion: PROVIDER_REPLAY_PROJECTION_VERSION,
    admissionRoute: sameRouteAdmission(),
  });
  assert.equal(ancestorReplay.kind, 'replayable');
  if (ancestorReplay.kind !== 'replayable') return;
  const sourceIdentity = {
    sessionId: 'session-1',
    invocationId: 'invocation-2',
    runId: 'run-2',
    turnId: 'turn-2',
  };
  const source = immutablePrefix([
    event({
      id: 'continuation-start-2',
      ...sourceIdentity,
      role: 'system',
      author: 'system',
      actions: {
        continuationStart: {
          protocol: 'continuation_start_v2',
          provenance: 'runtime_admission',
          claimId: 'claim-1',
          boundaryDigest: ancestorReplay.plan.boundary.manifestDigest,
          immediateSource: {
            ...ancestor.identity,
            highWater: ancestor.position.lastEventSeq,
            prefixDigest: ancestor.prefixDigest,
          },
          replayManifestDigest: ancestorReplay.plan.boundary.manifestDigest,
          providerProjectionVersion: PROVIDER_REPLAY_PROJECTION_VERSION,
          providerReplayDigest: ancestorReplay.plan.providerReplayDigest,
        },
      },
    }),
    event({
      id: 'run-2-terminal',
      ...sourceIdentity,
      ts: 2,
      role: 'system',
      author: 'system',
      status: 'failed',
      actions: { endInvocation: true, stateDelta: { failureClass: 'test_failure' } },
    }),
  ]);
  const sourceRun = runInvocation(sourceIdentity.runId, {
    source: {
      kind: 'continuation' as const,
      claimId: 'claim-1',
      boundaryDigest: ancestorReplay.plan.boundary.manifestDigest,
      sourceInvocationId: ancestor.identity.invocationId,
      sourceRunId: ancestor.identity.runId,
      sourceTurnId: ancestor.identity.turnId,
      sourceRuntimeEventHighWater: ancestor.position.lastEventSeq,
    },
  });
  const planner = new RuntimeContinuationPlanner({
    readSourceInvocation: async (_sessionId, runId) =>
      runId === sourceIdentity.runId ? sourceRun : runInvocation('run-1'),
    readImmutableRuntimePrefix: async ({ runId }) =>
      runId === sourceIdentity.runId ? source : ancestor,
    readContinuationClaimStateByBoundary: async () => undefined,
    newId: () => 'unused',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: sourceIdentity.runId,
    admissionRoute: sameRouteAdmission(),
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['runtime_lineage_claim_mismatch']);
});

function sameRouteAdmission() {
  return {
    invocations: ['run-1', 'run-2', 'run-3'].map((runId) => runInvocation(runId)),
    targetProviderStateIdentity: undefined,
    targetModelId: 'test-model',
  };
}

interface RunFacts {
  source?: RuntimeEventInvocationOpenedContent['source'];
  outcome?: 'completed' | 'failed' | 'aborted' | 'open';
  failureClass?: string;
  providerStateIdentity?: `sha256:${string}`;
  modelId?: string;
  cwd?: string;
}

/** One source invocation as the planner reads it back off the spine. */
function runInvocation(runId: string, facts: RunFacts = {}): RuntimeInvocationRecord {
  const ordinal = runId.match(/(\d+)$/)?.[1] ?? '1';
  const outcome = facts.outcome ?? 'failed';
  const failureClass = outcome === 'failed' ? (facts.failureClass ?? 'test_failure') : undefined;
  return testInvocationRecord({
    sessionId: 'session-1',
    invocationId: `invocation-${ordinal}`,
    runId,
    turnId: `turn-${ordinal}`,
    openedAt: 1,
    closedAt: 1,
    ...(outcome === 'open' ? {} : { outcome }),
    ...(failureClass ? { failureClass } : {}),
    opening: {
      route: {
        provenance: 'runtime',
        backendKind: 'fake',
        llmConnectionId: 'connection-1',
        llmConnectionSlug: 'test',
        modelId: facts.modelId ?? 'test-model',
        ...(facts.providerStateIdentity
          ? { providerStateIdentity: facts.providerStateIdentity }
          : {}),
      },
      configuration: { cwd: facts.cwd ?? '/workspace/repo' },
      ...(facts.source ? { source: facts.source } : {}),
    },
  });
}

function event(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: 'event',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'model',
    author: 'agent',
    ...overrides,
  };
}

function immutablePrefix(events: readonly RuntimeEvent[]): ImmutableRuntimePrefixV1 {
  const first = events[0];
  if (!first) throw new Error('test immutable prefix requires at least one event');
  return buildImmutableRuntimePrefix(
    {
      sessionId: first.sessionId,
      invocationId: first.invocationId,
      runId: first.runId,
      turnId: first.turnId,
    },
    events.map((runtimeEvent, index) => ({
      eventSeq: index + 1,
      event: runtimeEvent,
    })),
  );
}

function prefixForIdentity(
  invocationId: string,
  runId: string,
  turnId: string,
): ImmutableRuntimePrefixV1 {
  return immutablePrefix([
    event({
      id: `${runId}-user`,
      invocationId,
      runId,
      turnId,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'continue' },
    }),
  ]);
}
