import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AgentGraphIntentClaimStore } from '@maka/core/agent-graph-control';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { SessionEvent } from '@maka/core/events';
import { createSqliteSessionMetadataStore } from '@maka/storage';
import type {
  AgentGraphIntentExecutor,
  AgentGraphSupervisorObservation,
} from '../stream-graph-dispatch.js';
import { fingerprintAgentGraphRunnableIntent } from '../stream-graph-admission.js';
import { runAgentGraphToQuiescence } from '../stream-graph-dispatch.js';
import type { AgentGraphReadinessPolicy } from '../stream-graph-readiness.js';
import type { AgentGraphTraceTopology } from '../stream-graph-trace.js';

describe('stream graph dispatch', () => {
  test('recovers a durable fan-out and dynamically sealed join to quiescence', async () => {
    const facts = new MemoryGraphFacts();
    facts.seedCompleted('session-source', 'run-source', 'turn-source', 1);
    const claimStore = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(100) });
    const executor = new MemoryGraphExecutor(claimStore, facts);
    const ids = nextId();
    const observations: AgentGraphSupervisorObservation[] = [];
    const readyOperators: string[] = [];
    const runtimeOperators: string[] = [];

    try {
      const first = await runAgentGraphToQuiescence({
        topology: topology(),
        runStore: facts,
        runtimeEventStore: facts,
        claimStore,
        executor,
        newId: ids,
        maxNewActivations: 3,
        resolvePolicies: fanOutJoinPolicies,
        renderPrompt: ({ intent, triggerRecords }) =>
          `execute ${intent.operatorId} from ${triggerRecords.map((record) => record.recordId).join(',')}`,
        supervisor: {
          onObservation(observation) {
            observations.push(observation);
            (observation.readiness as { graphId: string }).graphId = 'observer-corruption';
            throw new Error('presentation observer must not gate execution');
          },
          onActivationReady({ intent }) {
            readyOperators.push(intent.operatorId);
            throw new Error('presentation observer must not gate execution');
          },
          onRuntimeEvent({ intent }) {
            runtimeOperators.push(intent.operatorId);
            throw new Error('presentation observer must not gate execution');
          },
        },
      });

      assert.equal(first.status, 'quiescent');
      assert.equal(first.newActivationCount, 3);
      assert.equal(first.observedExistingActivationCount, 0);
      assert.deepEqual(
        first.dispatches.map((dispatch) => dispatch.intent.operatorId),
        ['branch-a', 'branch-b', 'join'],
      );
      assert.equal(first.failures.length, 0);
      assert.equal(executor.backendInvocations, 3);
      assert.deepEqual(readyOperators, ['branch-a', 'branch-b', 'join']);
      assert.deepEqual(runtimeOperators, ['branch-a', 'branch-b', 'join']);
      assert.ok(observations.length >= 3);
      assert.equal(first.readiness.graphId, 'graph-dispatch');
      assert.equal(first.projection.records.length, 4);
      assert.equal(first.readiness.readiness['join-ready']?.status, 'runnable');

      const retry = await runAgentGraphToQuiescence({
        topology: topology(),
        runStore: facts,
        runtimeEventStore: facts,
        claimStore,
        executor,
        newId: ids,
        maxNewActivations: 0,
        resolvePolicies: fanOutJoinPolicies,
        renderPrompt: ({ intent, triggerRecords }) =>
          `execute ${intent.operatorId} from ${triggerRecords.map((record) => record.recordId).join(',')}`,
      });

      assert.equal(retry.status, 'quiescent');
      assert.equal(retry.newActivationCount, 0);
      assert.equal(retry.observedExistingActivationCount, 3);
      assert.equal(executor.backendInvocations, 3);
      assert.equal((await claimStore.listAgentGraphIntentClaims('graph-dispatch')).length, 3);

      const drifted = await runAgentGraphToQuiescence({
        topology: topology(),
        runStore: facts,
        runtimeEventStore: facts,
        claimStore,
        executor,
        newId: ids,
        maxNewActivations: 0,
        resolvePolicies: fanOutJoinPolicies,
        renderPrompt: ({ intent }) => `different work for ${intent.operatorId}`,
      });

      assert.equal(drifted.status, 'failed');
      assert.equal(drifted.dispatches.length, 0);
      assert.equal(drifted.failures.length, 3);
      assert.equal(executor.backendInvocations, 3);
    } finally {
      claimStore.close();
    }
  });

  test('bounds only newly admitted activations and advances on the next invocation', async () => {
    const facts = new MemoryGraphFacts();
    facts.seedCompleted('session-source', 'run-source', 'turn-source', 1);
    const claimStore = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(200) });
    const executor = new MemoryGraphExecutor(claimStore, facts);
    const ids = nextId();

    const run = (maxNewActivations: number) =>
      runAgentGraphToQuiescence({
        topology: topology(),
        runStore: facts,
        runtimeEventStore: facts,
        claimStore,
        executor,
        newId: ids,
        maxNewActivations,
        resolvePolicies: fanOutJoinPolicies,
        renderPrompt: ({ intent }) => `execute ${intent.operatorId}`,
      });

    try {
      const first = await run(1);
      assert.equal(first.status, 'limit_reached');
      assert.equal(first.newActivationCount, 1);
      assert.deepEqual(
        first.dispatches.map((dispatch) => dispatch.intent.operatorId),
        ['branch-a'],
      );

      const second = await run(1);
      assert.equal(second.status, 'limit_reached');
      assert.equal(second.newActivationCount, 1);
      assert.deepEqual(
        second.dispatches.map((dispatch) => [dispatch.intent.operatorId, dispatch.claimCreated]),
        [
          ['branch-a', false],
          ['branch-b', true],
        ],
      );

      const third = await run(1);
      assert.equal(third.status, 'quiescent');
      assert.equal(third.newActivationCount, 1);
      assert.deepEqual(
        third.dispatches.map((dispatch) => [dispatch.intent.operatorId, dispatch.claimCreated]),
        [
          ['branch-a', false],
          ['branch-b', false],
          ['join', true],
        ],
      );
      assert.equal(executor.backendInvocations, 3);
    } finally {
      claimStore.close();
    }
  });

  test('preserves sibling admissions when one execution fails after its claim', async () => {
    const facts = new MemoryGraphFacts();
    facts.seedCompleted('session-source', 'run-source', 'turn-source', 1);
    const claimStore = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(300) });
    const executor = new MemoryGraphExecutor(claimStore, facts, new Set(['branch-b']));

    try {
      const result = await runAgentGraphToQuiescence({
        topology: topology(),
        runStore: facts,
        runtimeEventStore: facts,
        claimStore,
        executor,
        newId: nextId(),
        maxNewActivations: 2,
        resolvePolicies: fanOutJoinPolicies,
        renderPrompt: ({ intent }) => `execute ${intent.operatorId}`,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.newActivationCount, 2);
      assert.equal(result.observedExistingActivationCount, 0);
      assert.deepEqual(
        result.dispatches.map((dispatch) => [dispatch.intent.operatorId, dispatch.claimCreated]),
        [['branch-a', true]],
      );
      assert.equal(result.failures.length, 1);
      assert.equal(result.failures[0]?.intent.operatorId, 'branch-b');
      assert.equal(result.failures[0]?.claim?.targetOperatorId, 'branch-b');
      assert.equal(result.failures[0]?.claimCreated, true);
      assert.match(String(result.failures[0]?.error), /branch-b execution failed/);
      assert.equal(executor.backendInvocations, 1);
      assert.equal((await claimStore.listAgentGraphIntentClaims('graph-dispatch')).length, 2);
    } finally {
      claimStore.close();
    }
  });
});

function topology(): AgentGraphTraceTopology {
  return {
    graphId: 'graph-dispatch',
    operators: [
      { operatorId: 'source', sessionId: 'session-source' },
      { operatorId: 'branch-a', sessionId: 'session-branch-a' },
      { operatorId: 'branch-b', sessionId: 'session-branch-b' },
      { operatorId: 'join', sessionId: 'session-join' },
    ],
    edges: [
      { edgeId: 'source-a', fromOperatorId: 'source', toOperatorId: 'branch-a' },
      { edgeId: 'source-b', fromOperatorId: 'source', toOperatorId: 'branch-b' },
      { edgeId: 'a-join', fromOperatorId: 'branch-a', toOperatorId: 'join' },
      { edgeId: 'b-join', fromOperatorId: 'branch-b', toOperatorId: 'join' },
    ],
  };
}

function fanOutJoinPolicies({
  claims,
}: Parameters<
  NonNullable<Parameters<typeof runAgentGraphToQuiescence>[0]['resolvePolicies']>
>[0]): AgentGraphReadinessPolicy[] {
  const policies: AgentGraphReadinessPolicy[] = [
    { readinessId: 'branch-a-map', operatorId: 'branch-a', kind: 'map' },
    { readinessId: 'branch-b-map', operatorId: 'branch-b', kind: 'map' },
  ];
  const branchA = claims.find((claim) => claim.targetOperatorId === 'branch-a');
  const branchB = claims.find((claim) => claim.targetOperatorId === 'branch-b');
  if (branchA && branchB) {
    policies.push({
      readinessId: 'join-ready',
      operatorId: 'join',
      kind: 'all_settled',
      inputs: [
        { operatorId: 'branch-a', activationId: branchA.targetRunId },
        { operatorId: 'branch-b', activationId: branchB.targetRunId },
      ],
    });
  }
  return policies;
}

class MemoryGraphFacts {
  private readonly runs = new Map<string, AgentRunHeader[]>();
  private readonly events = new Map<string, RuntimeEvent[]>();
  private clock = 10;

  async listSessionRuns(sessionId: string): Promise<AgentRunHeader[]> {
    return [...(this.runs.get(sessionId) ?? [])];
  }

  async readImmutableRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    return [...(this.events.get(factKey(sessionId, runId)) ?? [])];
  }

  hasRun(sessionId: string, runId: string): boolean {
    return (this.runs.get(sessionId) ?? []).some((run) => run.runId === runId);
  }

  seedCompleted(sessionId: string, runId: string, turnId: string, createdAt = this.clock++): void {
    const run: AgentRunHeader = {
      sessionId,
      runId,
      turnId,
      invocationId: `invocation-${runId}`,
      backendKind: 'ai-sdk',
      llmConnectionSlug: 'deepseek',
      modelId: 'deepseek-chat',
      cwd: '/workspace',
      permissionMode: 'explore',
      status: 'completed',
      createdAt,
      updatedAt: createdAt + 1,
      completedAt: createdAt + 1,
    };
    this.runs.set(sessionId, [...(this.runs.get(sessionId) ?? []), run]);
    this.events.set(factKey(sessionId, runId), [
      {
        id: `terminal-${runId}`,
        invocationId: run.invocationId!,
        runId,
        sessionId,
        turnId,
        ts: createdAt + 1,
        partial: false,
        role: 'system',
        author: 'system',
        status: 'completed',
        actions: { endInvocation: true },
      },
    ]);
  }
}

class MemoryGraphExecutor implements AgentGraphIntentExecutor {
  backendInvocations = 0;

  constructor(
    private readonly claims: AgentGraphIntentClaimStore,
    private readonly facts: MemoryGraphFacts,
    private readonly failingOperators = new Set<string>(),
  ) {}

  async runClaimedAgentGraphIntent(
    input: Parameters<AgentGraphIntentExecutor['runClaimedAgentGraphIntent']>[0],
  ): ReturnType<AgentGraphIntentExecutor['runClaimedAgentGraphIntent']> {
    const claim = await this.claims.readAgentGraphIntentClaim(input.graphId, input.intentId);
    if (!claim) throw new Error('missing claim');
    if (
      claim.graphId !== input.intent.graphId ||
      claim.intentId !== input.intent.intentId ||
      claim.readinessContextFingerprint !== input.intent.readinessContextFingerprint ||
      claim.targetOperatorId !== input.intent.operatorId ||
      claim.targetSessionId !== input.intent.targetSessionId ||
      claim.intentFingerprint !==
        fingerprintAgentGraphRunnableIntent({
          intent: input.intent,
          executionInput: { prompt: input.prompt },
        })
    ) {
      throw new Error('claimed graph intent execution does not match its durable claim');
    }
    if (this.failingOperators.has(claim.targetOperatorId)) {
      throw new Error(`${claim.targetOperatorId} execution failed`);
    }
    const isNew = !this.facts.hasRun(claim.targetSessionId, claim.targetRunId);
    await input.onReady?.({
      claimId: claim.claimId,
      graphId: claim.graphId,
      intentId: claim.intentId,
      operatorId: claim.targetOperatorId,
      childSessionId: claim.targetSessionId,
      turnId: claim.targetTurnId,
      runId: claim.targetRunId,
      agentId: `agent-${claim.targetOperatorId}`,
      agentName: claim.targetOperatorId,
    });
    if (isNew) {
      this.backendInvocations += 1;
      this.facts.seedCompleted(claim.targetSessionId, claim.targetRunId, claim.targetTurnId);
      input.onEvent?.(completeEvent(claim.targetTurnId, claim.targetRunId));
    }
    return {
      claimId: claim.claimId,
      graphId: claim.graphId,
      intentId: claim.intentId,
      operatorId: claim.targetOperatorId,
      childSessionId: claim.targetSessionId,
      turnId: claim.targetTurnId,
      runId: claim.targetRunId,
      agentId: `agent-${claim.targetOperatorId}`,
      agentName: claim.targetOperatorId,
      profile: 'read-only',
      status: 'completed',
      permissionMode: 'explore',
      summary: `completed ${claim.targetOperatorId}`,
      artifactIds: [],
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      eventCount: 1,
    };
  }
}

function completeEvent(turnId: string, runId: string): SessionEvent {
  return {
    type: 'complete',
    id: `event-${runId}`,
    turnId,
    ts: 1,
    stopReason: 'end_turn',
  };
}

function factKey(sessionId: string, runId: string): string {
  return `${sessionId}\0${runId}`;
}

function nextId(): () => string {
  let value = 0;
  return () => `graph-dispatch-id-${++value}`;
}

function nextNumber(start: number): () => number {
  let value = start;
  return () => value++;
}
