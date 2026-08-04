import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  AgentGraphIntentClaim,
  AgentGraphIntentClaimRequest,
} from '@maka/core/agent-graph-control';
import type { ShellRunRecord } from '@maka/core/shell-run';
import {
  FAKE_ASK_USER_QUESTION_PROMPT,
  LOCAL_READ_AGENT_DEFINITION,
  SessionManager,
} from '@maka/runtime';
import { fingerprintAgentGraphRunnableIntent } from '@maka/runtime/stream-graph-admission';
import type { AgentGraphRunnableIntent } from '@maka/runtime/stream-graph-readiness';
import { createAgentGraphControlStore } from '@maka/storage/agent-graph-control-store';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import {
  LONG_TERM_MEMORY_DATABASE_NAME,
  openInteractiveLongTermMemoryStoreForWrite,
} from '@maka/storage/long-term-memory-store';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '@maka/storage/root-authority';
import { openInteractiveUsageStoresForWrite } from '@maka/storage/usage-stores';
import { openInteractiveShellRunStoreForWrite } from '@maka/storage/shell-run-authority';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';

const require = createRequire(import.meta.url);

test('production composition owns the long-term memory database lifecycle', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const databasePath = join(root, LONG_TERM_MEMORY_DATABASE_NAME);
    await assert.rejects(stat(databasePath), { code: 'ENOENT' });

    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    const memory = await openInteractiveLongTermMemoryStoreForWrite(owner.lease);
    assert.equal((await stat(databasePath)).isFile(), true);

    await composition.close();
    await assert.rejects(memory.readItem('after-close'), /closed/);
    const Database = (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
    const database = new Database(databasePath);
    try {
      const counts = database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM memory_items) AS item_count,
             (SELECT COUNT(*) FROM memory_write_operations) AS operation_count`,
        )
        .get() as { item_count?: unknown; operation_count?: unknown };
      assert.equal(counts.item_count, 0);
      assert.equal(counts.operation_count, 0);
    } finally {
      database.close();
    }
  });
});

test('production composition closes long-term memory after a later startup failure', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: root,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const sessionRoot = join(root, 'sessions', session.id);
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(join(sessionRoot, 'task-events.jsonl'), '{not-json}\n');
    const memory = await openInteractiveLongTermMemoryStoreForWrite(owner.lease);

    await assert.rejects(createExecutionRuntimeHostComposition(compositionContext(owner)));
    await assert.rejects(memory.readItem('after-failed-start'), /closed/);

    await writeFile(join(sessionRoot, 'task-events.jsonl'), '');
    await owner.close();
    const recoveredCapability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const recoveredOwner = await tryAcquireInteractiveRootOwner(recoveredCapability);
    assert.ok(recoveredOwner);
    if (!recoveredOwner) return;
    try {
      const recovered = await createExecutionRuntimeHostComposition(
        compositionContext(recoveredOwner),
      );
      await recovered.close();
    } finally {
      await recoveredOwner.close();
    }
  });
});

test('composition drain preserves usage admission until active Runtime work settles', async () => {
  await withCompositionRoot(async ({ owner }) => {
    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    const usage = await openInteractiveUsageStoresForWrite(owner.lease);
    composition.beginDrain();

    await usage.telemetry.recordLlmCall(lifecycleUsageRecord());
    const persisted = await usage.telemetry.logs({ range: 'all' }, 0, 10);
    assert.deepEqual(
      persisted.rows.map((row) => row.id),
      ['usage_after_composition_drain'],
    );

    await composition.close();
  });
});

test('production composition orphans ownerless ShellRuns before serving Resource queries', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: root,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const shellRuns = await openInteractiveShellRunStoreForWrite(owner.lease);
    await shellRuns.createShellRun(shellRunRecord(session.id, 'starting-shell', 'starting'));
    await shellRuns.createShellRun(shellRunRecord(session.id, 'running-shell', 'running'));

    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    try {
      await composition.recover();
      const outcome = await composition.handlers['runtime.resource.query'](
        { kind: 'list_start', sessionId: session.id },
        {
          hostEpoch: 'execution-composition-test',
          connectionId: 'recovery-client',
          surface: 'tui',
          principal: 'local_os_user',
          acquireResidency: () => ({ release() {} }),
        },
      );
      assert.equal(outcome.ok, true);
      if (!outcome.ok || outcome.result.kind !== 'page') return;
      assert.equal(outcome.result.resources.length, 2);
      assert.deepEqual(
        outcome.result.resources.map((resource) => resource.result.status),
        ['orphaned', 'orphaned'],
      );
      assert.equal(
        outcome.result.resources.every(
          (resource) =>
            resource.result.failureMessage ===
            'Runtime restarted without a live shell process handle',
        ),
        true,
      );
    } finally {
      await composition.close();
    }
  });
});

test('production execution composition owns claimed graph activation retry and exact abort', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const claims = createAgentGraphControlStore(root);
    const parent = await stores.sessionStore.create({
      cwd: root,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const completedPrompt = 'execute the canonical claimed graph activation';
    const completed = await createClaimedGraphChild({
      root,
      parentSessionId: parent.id,
      suffix: 'a',
      stores,
      prompt: completedPrompt,
    });
    const completedClaim = (await claims.claimAgentGraphIntent(completed.request)).claim;
    const abortedFixture = await createClaimedGraphChild({
      root,
      parentSessionId: parent.id,
      suffix: 'e',
      stores,
      prompt: FAKE_ASK_USER_QUESTION_PROMPT,
    });
    const abortedClaim = (await claims.claimAgentGraphIntent(abortedFixture.request)).claim;
    claims.close();
    const { composition, manager } = await createCapturedExecutionComposition(owner);
    let journeyError: unknown;
    try {
      const first = await manager.runClaimedAgentGraphIntent({
        claimStore: claims,
        intent: completed.intent,
        graphId: completedClaim.graphId,
        intentId: completedClaim.intentId,
        prompt: completedPrompt,
      });
      assert.equal(first.status, 'completed');

      const admission = await stores.agentRunStore.readRootTurnAdmission(
        completedClaim.targetSessionId,
        completedClaim.targetTurnId,
      );
      assert.ok(admission);
      assert.ok(admission.userMessageId);
      assert.deepEqual(admission.execution, graphExecutionDescriptor(completedClaim));
      assert.deepEqual(admission.normalizedInput, { text: completedPrompt });

      const retry = await manager.runClaimedAgentGraphIntent({
        claimStore: claims,
        intent: completed.intent,
        graphId: completedClaim.graphId,
        intentId: completedClaim.intentId,
        prompt: completedPrompt,
      });
      assert.deepEqual(
        {
          claimId: retry.claimId,
          childSessionId: retry.childSessionId,
          turnId: retry.turnId,
          runId: retry.runId,
          status: retry.status,
          summary: retry.summary,
        },
        {
          claimId: first.claimId,
          childSessionId: first.childSessionId,
          turnId: first.turnId,
          runId: first.runId,
          status: first.status,
          summary: first.summary,
        },
      );
      const retriedAdmission = await stores.agentRunStore.readRootTurnAdmission(
        completedClaim.targetSessionId,
        completedClaim.targetTurnId,
      );
      assert.equal(retriedAdmission?.userMessageId, admission.userMessageId);
      await assertUniqueGraphExecutionFacts(stores, completedClaim, admission.userMessageId);

      const abort = new AbortController();
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const aborting = manager.runClaimedAgentGraphIntent({
        claimStore: claims,
        intent: abortedFixture.intent,
        graphId: abortedClaim.graphId,
        intentId: abortedClaim.intentId,
        prompt: FAKE_ASK_USER_QUESTION_PROMPT,
        abortSignal: abort.signal,
        onReady: ready,
      });
      await started;
      abort.abort();
      const aborted = await aborting;
      assert.equal(aborted.status, 'cancelled');

      const abortedAdmission = await stores.agentRunStore.readRootTurnAdmission(
        abortedClaim.targetSessionId,
        abortedClaim.targetTurnId,
      );
      assert.ok(abortedAdmission?.userMessageId);
      assert.deepEqual(abortedAdmission?.execution, graphExecutionDescriptor(abortedClaim));
      const abortedRun = await stores.agentRunStore.readRun(
        abortedClaim.targetSessionId,
        abortedClaim.targetRunId,
      );
      assert.equal(abortedRun.status, 'cancelled');
      await assertUniqueGraphExecutionFacts(
        stores,
        abortedClaim,
        abortedAdmission.userMessageId,
        'run_cancelled',
      );
      assert.equal(
        (
          await stores.agentRunStore.readRun(
            completedClaim.targetSessionId,
            completedClaim.targetRunId,
          )
        ).status,
        'completed',
      );
    } catch (error) {
      journeyError = error;
      throw error;
    } finally {
      try {
        await composition.close();
      } catch (closeError) {
        if (journeyError !== undefined) {
          throw new AggregateError(
            [journeyError, closeError],
            'Claimed graph journey and composition close both failed',
          );
        }
        throw closeError;
      }
    }
  });
});

function compositionContext(owner: InteractiveRootOwner) {
  return {
    owner,
    hostEpoch: 'execution-composition-test',
    acquireResidency: () => ({ release() {} }),
    retainUntilProcessExit: () => undefined,
    requestDrain: () => undefined,
  };
}

function shellRunRecord(
  sessionId: string,
  shellRunId: string,
  status: 'starting' | 'running',
): ShellRunRecord {
  return {
    shellRunId,
    sessionId,
    sourceTurnId: `turn-${shellRunId}`,
    sourceToolCallId: `tool-${shellRunId}`,
    cwd: '/workspace',
    command: 'sleep 60',
    status,
    startedAt: 1,
    updatedAt: 1,
    revision: 1,
    output: {
      mode: 'pipes',
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      redacted: false,
    },
  };
}

async function createCapturedExecutionComposition(owner: InteractiveRootOwner): Promise<{
  composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>>;
  manager: SessionManager;
}> {
  const originalRecover = SessionManager.prototype.recoverInterruptedSessionsStrict;
  let manager: SessionManager | undefined;
  SessionManager.prototype.recoverInterruptedSessionsStrict = async function (stores) {
    manager = this;
    return originalRecover.call(this, stores);
  };
  try {
    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    await composition.recover();
    if (!manager) throw new Error('Production execution composition did not construct Runtime');
    return { composition, manager };
  } finally {
    SessionManager.prototype.recoverInterruptedSessionsStrict = originalRecover;
  }
}

async function createClaimedGraphChild(input: {
  root: string;
  parentSessionId: string;
  suffix: string;
  stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>;
  prompt: string;
}): Promise<{ request: AgentGraphIntentClaimRequest; intent: AgentGraphRunnableIntent }> {
  const turnId = `graph-turn-${input.suffix}`;
  const runId = `graph-run-${input.suffix}`;
  const child = await input.stores.sessionStore.createSubagent({
    cwd: input.root,
    name: `Graph operator ${input.suffix}`,
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'explore',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    subagentParent: {
      kind: 'subagent',
      parentSessionId: input.parentSessionId,
      spawnedBy: {
        parentRunId: `parent-run-${input.suffix}`,
        parentTurnId: `parent-turn-${input.suffix}`,
        toolCallId: `graph-tool-${input.suffix}`,
      },
      lifecycle: 'foreground',
    },
    subagentRuntime: {
      schemaVersion: 1,
      definitionVersion: LOCAL_READ_AGENT_DEFINITION.definitionVersion,
      agentId: LOCAL_READ_AGENT_DEFINITION.id,
      agentName: LOCAL_READ_AGENT_DEFINITION.name,
      profile: LOCAL_READ_AGENT_DEFINITION.profile,
      systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
      toolNames: [],
      categoryPolicy: {},
      permissionCeiling: 'ask',
    },
    subagentSpawn: {
      schemaVersion: 1,
      requestFingerprint: input.suffix.repeat(64),
      initialTurnId: turnId,
      initialRunId: runId,
    },
  });
  assert.equal(child.created, true);
  const intent: AgentGraphRunnableIntent = {
    schemaVersion: 1,
    intentId: `graph_intent_${input.suffix.repeat(32)}`,
    graphId: `graph-${input.suffix}`,
    readinessContextFingerprint: `sha256:${nextHex(input.suffix).repeat(64)}`,
    policyFingerprint: `sha256:${nextHex(nextHex(input.suffix)).repeat(64)}`,
    readinessId: `readiness-${input.suffix}`,
    operatorId: LOCAL_READ_AGENT_DEFINITION.id,
    targetSessionId: child.header.id,
    policyKind: 'map',
    triggerRouteIds: [`route-${input.suffix}`],
    triggerRecordIds: [`record-${input.suffix}`],
  };
  return {
    intent,
    request: {
      schemaVersion: 1,
      claimId: `graph_claim_${input.suffix.repeat(32)}`,
      graphId: intent.graphId,
      intentId: intent.intentId,
      intentFingerprint: fingerprintAgentGraphRunnableIntent({
        intent,
        executionInput: { prompt: input.prompt },
      }),
      readinessContextFingerprint: intent.readinessContextFingerprint,
      targetOperatorId: LOCAL_READ_AGENT_DEFINITION.id,
      targetSessionId: child.header.id,
      targetTurnId: turnId,
      targetRunId: runId,
    },
  };
}

function graphExecutionDescriptor(claim: AgentGraphIntentClaim) {
  return {
    kind: 'claimed_agent_graph_intent' as const,
    claim,
    agentId: LOCAL_READ_AGENT_DEFINITION.id,
    agentName: LOCAL_READ_AGENT_DEFINITION.name,
  };
}

function lifecycleUsageRecord() {
  return {
    id: 'usage_after_composition_drain',
    providerId: 'openai',
    modelId: 'gpt-5',
    inputTokens: 10,
    outputTokens: 20,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 10,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 30,
    costUsd: 0.001,
    latencyMs: 100,
    status: 'success',
    date: '2026-07-30',
    ts: Date.UTC(2026, 6, 30),
    startedAt: Date.UTC(2026, 6, 30) - 100,
  } as Parameters<
    Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>>['telemetry']['recordLlmCall']
  >[0];
}

async function assertUniqueGraphExecutionFacts(
  stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>,
  claim: AgentGraphIntentClaim,
  userMessageId: string,
  expectedTerminal: 'run_completed' | 'run_cancelled' = 'run_completed',
): Promise<void> {
  const [runs, messages, runEvents, runtimeEvents] = await Promise.all([
    stores.agentRunStore.listSessionRuns(claim.targetSessionId),
    stores.sessionStore.readMessages(claim.targetSessionId),
    stores.agentRunStore.readEvents(claim.targetSessionId, claim.targetRunId),
    stores.runtimeEventStore.readImmutableRuntimeEvents(claim.targetSessionId, claim.targetRunId),
  ]);
  assert.deepEqual(
    runs.filter((run) => run.turnId === claim.targetTurnId).map((run) => run.runId),
    [claim.targetRunId],
  );
  assert.deepEqual(
    messages
      .filter((message) => message.type === 'user' && message.turnId === claim.targetTurnId)
      .map((message) => message.id),
    [userMessageId],
  );
  assert.equal(runEvents.filter((event) => event.type === 'run_started').length, 1);
  assert.equal(runEvents.filter((event) => event.type === expectedTerminal).length, 1);
  assert.equal(
    runtimeEvents.filter(
      (event) => event.status === (expectedTerminal === 'run_cancelled' ? 'aborted' : 'completed'),
    ).length,
    1,
  );
}

function nextHex(value: string): string {
  const code = Number.parseInt(value, 16);
  return ((code + 1) % 16).toString(16);
}

async function withCompositionRoot(
  run: (fixture: {
    root: string;
    owner: NonNullable<Awaited<ReturnType<typeof tryAcquireInteractiveRootOwner>>>;
  }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-execution-composition-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire composition test root');
  try {
    await run({ root, owner });
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
}
