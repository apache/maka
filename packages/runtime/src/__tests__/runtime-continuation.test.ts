import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildImmutableRuntimePrefix,
  createRuntimeBoundaryCursor,
  runtimePrefixSegment,
  type ImmutableRuntimePrefixV1,
} from '@maka/core/runtime-boundary';
import type { RuntimeEvent } from '@maka/core/runtime-event';

import type { FlowInput } from '../agent-flow.js';
import type { InvocationContext } from '../invocation-context.js';
import { createLocalContinuationSafetyInspector } from '../continuation-safety.js';
import {
  RuntimeContinuationPlanner,
  buildSafeBoundaryContinuationPlan,
} from '../runtime-resume.js';
import { RuntimeRunner } from '../runtime-runner.js';

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

test('RuntimeRunner continues from replay context without synthesizing another user event', async () => {
  const sourceEvents = [
    event({
      id: 'source-user',
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'run tests' },
    }),
    event({
      id: 'source-call',
      role: 'model',
      author: 'agent',
      content: { kind: 'function_call', id: 'tool-1', name: 'Bash', args: { command: 'npm test' } },
    }),
    event({
      id: 'source-result',
      role: 'tool',
      author: 'tool',
      content: { kind: 'function_response', id: 'tool-1', name: 'Bash', result: { exitCode: 0 } },
    }),
  ];
  const plan = buildSafeBoundaryContinuationPlan(sourceEvents, {
    ledgerReadable: true,
    terminalRepairSucceeded: true,
    sourceCwd: '/workspace/repo',
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: ['Bash'],
    continuationIdentity: {
      invocationId: 'invocation-2',
      runId: 'run-2',
      turnId: 'turn-2',
    },
  });
  assert.equal(plan.disposition, 'continue');
  assert.ok(plan.continuation);

  let capturedContext: InvocationContext | undefined;
  let capturedInput: FlowInput | undefined;
  const runner = new RuntimeRunner({
    flow: {
      async *run(context, input) {
        capturedContext = context;
        capturedInput = input;
        yield event({
          id: 'continued-complete',
          invocationId: context.invocationId,
          runId: context.runId,
          turnId: context.turnId,
          role: 'system',
          author: 'system',
          status: 'completed',
          actions: { endInvocation: true },
        });
      },
    },
    providers: { newId: () => 'continuation-start', now: () => 20 },
  });

  const result = await runner.resume(plan.continuation, { source: 'test' });

  assert.equal(result.invocationId, 'invocation-2');
  assert.equal(result.runId, 'run-2');
  assert.equal(result.turnId, 'turn-2');
  assert.deepEqual(
    result.events.map((candidate) => candidate.id),
    ['continued-complete'],
  );
  assert.equal(capturedContext?.request.continuation?.sourceRunId, 'run-1');
  assert.deepEqual(capturedInput?.runtimeContext, sourceEvents);
  assert.equal(capturedInput?.continuation?.sourceRuntimeEventHighWater, 3);
});

test('RuntimeRunner preserves the immediate source segment when replay includes continuation ancestors', async () => {
  const ancestorEvents = [
    event({
      id: 'ancestor-user',
      invocationId: 'ancestor-invocation',
      runId: 'ancestor-run',
      turnId: 'ancestor-turn',
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'original request' },
    }),
    event({
      id: 'ancestor-terminal',
      invocationId: 'ancestor-invocation',
      runId: 'ancestor-run',
      turnId: 'ancestor-turn',
      role: 'system',
      author: 'system',
      status: 'failed',
      actions: { endInvocation: true },
    }),
  ];
  const sourceRuntimeContext = [
    event({
      id: 'source-continuation-start',
      role: 'system',
      author: 'system',
      actions: { stateDelta: { continuation: true } },
    }),
    event({
      id: 'source-terminal',
      role: 'system',
      author: 'system',
      status: 'failed',
      actions: { endInvocation: true },
    }),
  ];
  const runtimeContext = [...ancestorEvents, ...sourceRuntimeContext];
  let capturedInput: FlowInput | undefined;
  const runner = new RuntimeRunner({
    commitContinuationStart: async () => {},
    flow: {
      async *run(context, input) {
        capturedInput = input;
        yield event({
          id: 'continued-text',
          invocationId: context.invocationId,
          runId: context.runId,
          turnId: context.turnId,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'continued' },
        });
        yield event({
          id: 'continued-terminal',
          invocationId: context.invocationId,
          runId: context.runId,
          turnId: context.turnId,
          role: 'system',
          author: 'system',
          status: 'completed',
          actions: { endInvocation: true },
        });
      },
    },
    providers: { newId: () => 'new-event', now: () => 20 },
  });

  const result = await runner.resume(
    {
      sessionId: 'session-1',
      invocationId: 'invocation-2',
      runId: 'run-2',
      turnId: 'turn-2',
      sourceInvocationId: 'invocation-1',
      sourceRunId: 'run-1',
      sourceTurnId: 'turn-1',
      sourceRuntimeEventHighWater: sourceRuntimeContext.length,
      sourceRuntimeContext,
      runtimeContext,
      safetySnapshot: {
        workspaceIdentity: 'workspace-1',
        backgroundOperationsSettled: true,
        availableToolNames: [],
      },
    },
    { source: 'test' },
  );

  assert.equal(result.status, 'completed');
  assert.deepEqual(capturedInput?.runtimeContext, runtimeContext);
  assert.equal('sourceRuntimeContext' in (capturedInput?.continuation ?? {}), false);
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
  const ids = ['invocation-2', 'run-2', 'turn-2', 'claim-2'];
  const planner = new RuntimeContinuationPlanner({
    readSourceRun: async () => ({ cwd: '/workspace/repo', status: 'failed' }),
    readImmutableRuntimePrefix: async () => sourcePrefix,
    newId: () => ids.shift() ?? 'unexpected-id',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-1',
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
    runId: 'run-2',
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
    providerProjectionVersion: 1,
    safetySnapshot: {
      workspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    },
  });
});

test('RuntimeRunner rejects a continuation envelope whose high-water is behind its replay context', async () => {
  const runner = new RuntimeRunner({
    flow: {
      async *run() {
        throw new Error('flow must not start');
      },
    },
  });

  await assert.rejects(
    runner.resume(
      {
        sessionId: 'session-1',
        invocationId: 'invocation-2',
        runId: 'run-2',
        turnId: 'turn-2',
        sourceInvocationId: 'invocation-1',
        sourceRunId: 'run-1',
        sourceTurnId: 'turn-1',
        sourceRuntimeEventHighWater: 0,
        runtimeContext: [
          event({
            id: 'source-user',
            role: 'user',
            author: 'user',
            content: { kind: 'text', text: 'continue' },
          }),
        ],
        safetySnapshot: {
          workspaceIdentity: 'workspace-1',
          backgroundOperationsSettled: true,
          availableToolNames: [],
        },
      },
      { source: 'test' },
    ),
    /high-water/i,
  );
});

test('RuntimeContinuationPlanner parks with a stable reason when the ledger cannot be read', async () => {
  const planner = new RuntimeContinuationPlanner({
    readSourceRun: async () => ({ cwd: '/workspace/repo', status: 'failed' }),
    readImmutableRuntimePrefix: async () => {
      throw new Error('corrupt ledger');
    },
    newId: () => 'unused',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-1',
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
    readSourceRun: async () => ({ cwd: '/workspace/repo', status: 'running' }),
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
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['terminal_repair_failed']);
});

test('RuntimeContinuationPlanner parks when the terminal run header disagrees with the ledger fact', async () => {
  const planner = new RuntimeContinuationPlanner({
    readSourceRun: async () => ({ cwd: '/workspace/repo', status: 'completed' }),
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
      ]),
    newId: () => 'fresh-id',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['terminal_repair_failed']);
});

test('RuntimeContinuationPlanner rejects a ledger returned for another source run', async () => {
  const planner = new RuntimeContinuationPlanner({
    readSourceRun: async () => ({ cwd: '/workspace/repo', status: 'failed' }),
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
    'run-1': {
      cwd: '/workspace/repo',
      status: 'failed',
      continuationSource: {
        sourceInvocationId: 'invocation-2',
        sourceRunId: 'run-2',
        sourceTurnId: 'turn-2',
        sourceRuntimeEventHighWater: 1,
      },
    },
    'run-2': {
      cwd: '/workspace/repo',
      status: 'failed',
      continuationSource: {
        sourceInvocationId: 'invocation-1',
        sourceRunId: 'run-1',
        sourceTurnId: 'turn-1',
        sourceRuntimeEventHighWater: 1,
      },
    },
  } as const;
  const prefixes = new Map([
    ['run-1', prefixForIdentity('invocation-1', 'run-1', 'turn-1')],
    ['run-2', prefixForIdentity('invocation-2', 'run-2', 'turn-2')],
  ]);
  const planner = new RuntimeContinuationPlanner({
    readSourceRun: async (_sessionId, runId) => runs[runId as keyof typeof runs],
    readImmutableRuntimePrefix: async ({ runId }) => prefixes.get(runId)!,
    newId: () => 'unused',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-1',
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
    readSourceRun: async (_sessionId, runId) => {
      if (runId === 'run-2') {
        return {
          cwd: '/workspace/repo',
          status: 'failed',
          continuationSource: {
            sourceInvocationId: 'invocation-1',
            sourceRunId: 'run-missing',
            sourceTurnId: 'turn-1',
            sourceRuntimeEventHighWater: 1,
          },
        };
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
  const runs = new Map<
    string,
    {
      cwd: string;
      status: string;
      continuationSource: {
        sourceInvocationId: string;
        sourceRunId: string;
        sourceTurnId: string;
        sourceRuntimeEventHighWater: number;
      };
    }
  >();
  const prefixes = new Map<string, ImmutableRuntimePrefixV1>();
  for (let index = 1; index <= 64; index += 1) {
    const runId = `run-${index}`;
    runs.set(runId, {
      cwd: '/workspace/repo',
      status: 'failed',
      continuationSource: {
        sourceInvocationId: `invocation-${index + 1}`,
        sourceRunId: `run-${index + 1}`,
        sourceTurnId: `turn-${index + 1}`,
        sourceRuntimeEventHighWater: 1,
      },
    });
    prefixes.set(runId, prefixForIdentity(`invocation-${index}`, runId, `turn-${index}`));
  }
  const planner = new RuntimeContinuationPlanner({
    readSourceRun: async (_sessionId, runId) => {
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
          replayManifestDigest:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          providerProjectionVersion: 1,
          providerReplayDigest:
            'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        },
      },
    }),
  ]);
  const planner = new RuntimeContinuationPlanner({
    readSourceRun: async (_sessionId, runId) =>
      runId === 'run-2'
        ? {
            cwd: '/workspace/repo',
            status: 'failed',
            continuationSource: {
              protocol: 'continuation_source_v2',
              claimId: 'claim-1',
              boundaryDigest:
                'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              sourceInvocationId: 'invocation-1',
              sourceRunId: 'run-1',
              sourceTurnId: 'turn-1',
              sourceRuntimeEventHighWater: 1,
              sourcePrefixDigest:
                'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              replayManifestDigest:
                'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          }
        : { cwd: '/workspace/repo', status: 'failed' },
    readImmutableRuntimePrefix: async ({ runId }) => (runId === 'run-2' ? source : ancestor),
    newId: () => 'unused',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-2',
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
    readSourceRun: async (_sessionId, runId) =>
      runId === 'run-2'
        ? {
            cwd: '/workspace/repo',
            status: 'failed',
            continuationSource: {
              protocol: 'continuation_source_v2',
              claimId: 'claim-expected',
              boundaryDigest: ancestorBoundary.manifestDigest,
              sourceInvocationId: ancestor.identity.invocationId,
              sourceRunId: ancestor.identity.runId,
              sourceTurnId: ancestor.identity.turnId,
              sourceRuntimeEventHighWater: ancestor.position.lastEventSeq,
              sourcePrefixDigest: ancestor.prefixDigest,
              replayManifestDigest: ancestorBoundary.manifestDigest,
            },
          }
        : { cwd: '/workspace/repo', status: 'failed' },
    readImmutableRuntimePrefix: async ({ runId }) => (runId === 'run-2' ? source : ancestor),
    newId: () => 'unused',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-2',
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['runtime_lineage_start_mismatch']);
});

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
