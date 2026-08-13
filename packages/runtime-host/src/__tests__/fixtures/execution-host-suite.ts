import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { TOOL_BOUNDARY_PROTOCOL_V1 } from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import type { AgentRunHeader } from '@maka/core/agent-run';
import { normalizeMessageContent, type MessageContent } from '@maka/core/events';
import type { ConnectionCatalogEntry } from '@maka/core/runtime-policy';
import type { StoredMessage } from '@maka/core/session';
import type { Task } from '@maka/core/task-ledger';
import { isTerminalRuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { BackendRegistry, SessionManager } from '@maka/runtime/session-manager';
import { buildTaskLedgerTools } from '@maka/runtime/task-ledger-tools';
import {
  buildRecoveredTerminalRuntimeEvent,
  classifyTerminalRuntimeLedger,
  commitTerminalRunWithRuntimeFact,
} from '@maka/runtime/terminal-run-commit';
import {
  FAKE_ASK_USER_QUESTION_PROMPT,
  FAKE_WAIT_FOR_STEERING_PROMPT,
  FakeBackend,
} from '@maka/runtime/fake-backend';
import { type MakaTool, type MakaToolContext } from '@maka/runtime/tool-runtime';
import {
  openInteractiveExecutionStoresForRead,
  openInteractiveExecutionStoresForWrite,
} from '@maka/storage/execution-stores';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
  type StorageRootCapability,
} from '@maka/storage/root-authority';
import { openInteractiveTaskLedgerStoreForWrite } from '@maka/storage/task-ledger-authority';
import { resolveWorkspaceIdentity } from '@maka/storage/workspace-identity';
import {
  connectRuntimeHost,
  RuntimeHostOperationError,
  RuntimeHostSubscriptionError,
  type RuntimeHostConnection,
  type RuntimeHostSessionSubscription,
} from '../../client/index.js';
import {
  decodeHostFrame,
  encodeProtocolMessage,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  TASK_LEDGER_PAGE_MAX_ITEMS,
  type ClientFrame,
  type ConnectionCatalogQueryResult,
  type InteractionPendingSnapshot,
  type SubscriptionFrame,
  type TaskLedgerQueryResult,
  type TaskLedgerRevision,
  type TurnMessageSubmitInput,
  type TurnSnapshot,
  type TurnStartResult,
} from '../../protocol/index.js';
import { SessionAdmissionGate } from '../../server/session-admission-gate.js';
import { HostTaskLedgerCoordinator } from '../../server/task-ledger-coordinator.js';
import { continuationSafetyDigest } from '../../server/root-turn-coordinator.js';
import { FramedTransport } from '../../transport/framed-transport.js';
import { removePosixEndpointDirectories } from './endpoint-hygiene.js';

export const CURRENT_PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;
export const PROCESS_TIMEOUT_MS = 10_000;
export const CONNECTION_EFFECT_MODEL_IDS = Array.from(
  { length: 129 },
  (_, index) => `connection-effect-model-${String(index + 1).padStart(3, '0')}`,
);

export interface ExecutionHostHandle {
  child: ChildProcess;
  hostEpoch: string;
  endpoint: string;
  recoveryOutcome?: RuntimeEvent;
}

export interface TurnLedger {
  runs: AgentRunHeader[];
  userMessages: Array<Extract<StoredMessage, { type: 'user' }>>;
  runtimeEvents: RuntimeEvent[];
  terminalEvents: RuntimeEvent[];
  classification: ReturnType<typeof classifyTerminalRuntimeLedger>;
}

export class ExecutionFixture {
  readonly #children = new Set<ChildProcess>();

  constructor(
    readonly base: string,
    readonly root: string,
    readonly capability: StorageRootCapability<'interactive'>,
    readonly sessionId: string,
  ) {}

  async seedSession(): Promise<string> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for Session setup');
    let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
    try {
      stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const session = await stores.sessionStore.create({
        cwd: this.root,
        backend: 'fake',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      return session.id;
    } finally {
      await stores?.sessionStore.close?.();
      await owner.close();
    }
  }

  async seedSafeBoundaryContinuationSource(requiredToolName?: string): Promise<{
    sourceInvocationId: string;
    sourceRunId: string;
    sourceTurnId: string;
    sourceRuntimeEventHighWater: number;
  }> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for continuation setup');
    let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
    try {
      stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const sourceInvocationId = randomUUID();
      const sourceRunId = randomUUID();
      const sourceTurnId = randomUUID();
      const createdAt = Date.now();
      const workspace = await resolveWorkspaceIdentity({ path: this.root });
      const sourceRun: AgentRunHeader = {
        runId: sourceRunId,
        invocationId: sourceInvocationId,
        sessionId: this.sessionId,
        turnId: sourceTurnId,
        status: 'created',
        backendKind: 'fake',
        llmConnectionSlug: 'fake',
        modelId: 'fake-model',
        cwd: this.root,
        workspaceIdentity: workspace.workspaceIdentity,
        permissionMode: 'ask',
        collaborationMode: 'agent',
        createdAt,
        updatedAt: createdAt,
      };
      await stores.agentRunStore.createRun(sourceRun, { durable: true });
      await stores.runtimeEventStore.appendRuntimeEvent(this.sessionId, sourceRunId, {
        id: randomUUID(),
        sessionId: this.sessionId,
        invocationId: sourceInvocationId,
        runId: sourceRunId,
        turnId: sourceTurnId,
        ts: createdAt,
        partial: false,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'Continue this interrupted request.' },
      });
      if (requiredToolName) {
        const toolCallId = randomUUID();
        await stores.runtimeEventStore.appendRuntimeEvent(this.sessionId, sourceRunId, {
          id: randomUUID(),
          sessionId: this.sessionId,
          invocationId: sourceInvocationId,
          runId: sourceRunId,
          turnId: sourceTurnId,
          ts: createdAt + 1,
          partial: false,
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: toolCallId, name: requiredToolName, args: {} },
          refs: { toolCallId },
        });
        await stores.runtimeEventStore.appendRuntimeEvent(this.sessionId, sourceRunId, {
          id: randomUUID(),
          sessionId: this.sessionId,
          invocationId: sourceInvocationId,
          runId: sourceRunId,
          turnId: sourceTurnId,
          ts: createdAt + 2,
          partial: false,
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: toolCallId,
            name: requiredToolName,
            result: { ok: true },
            isError: false,
          },
          refs: { toolCallId },
        });
      }
      const terminalAt = createdAt + (requiredToolName ? 3 : 1);
      const terminal = buildRecoveredTerminalRuntimeEvent({
        id: randomUUID(),
        run: sourceRun,
        status: 'failed',
        ts: terminalAt,
        failureClass: 'app_restarted',
        recoveryReason: 'test_safe_boundary_source',
      });
      await commitTerminalRunWithRuntimeFact({
        runStore: stores.agentRunStore,
        runtimeEventStore: stores.runtimeEventStore,
        newId: randomUUID,
        sessionId: this.sessionId,
        runId: sourceRunId,
        turnId: sourceTurnId,
        status: 'failed',
        ts: terminalAt,
        terminalEvent: terminal,
        failureClass: 'app_restarted',
      });
      return {
        sourceInvocationId,
        sourceRunId,
        sourceTurnId,
        sourceRuntimeEventHighWater: requiredToolName ? 4 : 2,
      };
    } finally {
      await stores?.sessionStore.close?.();
      await owner.close();
    }
  }

  async seedSafeBoundaryContinuationCrash(
    failpoint:
      | 'after_continuation_claim_committed'
      | 'after_run_created'
      | 'after_continuation_start_committed',
  ): Promise<{
    sourceRunId: string;
    sourceRuntimeEventHighWater: number;
    targetRunId: string;
    targetTurnId: string;
  }> {
    const source = await this.seedSafeBoundaryContinuationSource();
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for continuation crash setup');
    let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
    try {
      stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const backends = new BackendRegistry();
      backends.register(
        'fake',
        (ctx) =>
          new FakeBackend({
            sessionId: ctx.sessionId,
            header: ctx.header,
            store: ctx.store,
            appendMessage: ctx.appendMessage,
          }),
      );
      const workspace = await resolveWorkspaceIdentity({ path: this.root });
      let markReached!: () => void;
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      const manager = new SessionManager({
        store: stores.sessionStore,
        runStore: stores.agentRunStore,
        runtimeEventStore: stores.runtimeEventStore,
        backends,
        safeBoundaryResumeEnabled: true,
        inspectContinuationSafety: async () => ({
          workspaceIdentity: workspace.workspaceIdentity,
          backgroundOperationsSettled: true,
          availableToolNames: [],
        }),
        continuationFailpoint: async (point) => {
          if (point !== failpoint) return;
          markReached();
          await new Promise<never>(() => undefined);
        },
        newId: randomUUID,
        now: Date.now,
        runtimeSource: 'test',
      });
      const plan = await manager.planAuthoritativeSafeBoundaryContinuation(this.sessionId, {
        sourceRunId: source.sourceRunId,
      });
      const planned = plan.continuation;
      assert.ok(planned?.claimId);
      assert.ok(planned?.boundary);
      assert.ok(planned?.providerReplayDigest);
      if (!planned?.claimId || !planned.boundary || !planned.providerReplayDigest) {
        throw new Error(`Unable to plan continuation crash setup: ${plan.rejectionReasons}`);
      }
      const claimId = planned.claimId;
      const boundaryDigest = planned.boundary.manifestDigest;
      const providerReplayDigest = planned.providerReplayDigest;
      const targetTurnId = `turn-${failpoint}`;
      const continuation = { ...planned, turnId: targetTurnId };
      await stores.agentRunStore.admitRootTurn({
        sessionId: this.sessionId,
        turnId: targetTurnId,
        proposedRunId: continuation.runId,
        proposedUserMessageId: null,
        execution: {
          kind: 'safe_boundary_continuation',
          sourceInvocationId: continuation.sourceInvocationId,
          sourceRunId: continuation.sourceRunId,
          sourceTurnId: continuation.sourceTurnId,
          sourceRuntimeEventHighWater: continuation.sourceRuntimeEventHighWater,
          claimId,
          boundaryDigest,
          providerReplayDigest,
          safetyDigest: continuationSafetyDigest(continuation),
          targetInvocationId: continuation.invocationId,
        },
        previousRootTurnId: null,
        normalizedInput: null,
        sourceMessages: [],
        admittedAt: Date.now(),
      });
      void (async () => {
        for await (const _event of manager.resumeSafeBoundaryContinuation(continuation)) {
          // The selected durable failpoint never returns.
        }
      })().catch(() => undefined);
      await withTimeout(reached, PROCESS_TIMEOUT_MS, `continuation did not reach ${failpoint}`);
      return {
        sourceRunId: source.sourceRunId,
        sourceRuntimeEventHighWater: source.sourceRuntimeEventHighWater,
        targetRunId: continuation.runId,
        targetTurnId,
      };
    } finally {
      await stores?.sessionStore.close?.();
      await owner.close();
    }
  }

  async seedPendingSafeBoundaryContinuation(requiredToolName: string): Promise<{
    sourceRunId: string;
    sourceRuntimeEventHighWater: number;
    targetRunId: string;
    targetTurnId: string;
  }> {
    const source = await this.seedSafeBoundaryContinuationSource(requiredToolName);
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for continuation setup');
    let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
    try {
      stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const workspace = await resolveWorkspaceIdentity({ path: this.root });
      const manager = new SessionManager({
        store: stores.sessionStore,
        runStore: stores.agentRunStore,
        runtimeEventStore: stores.runtimeEventStore,
        backends: new BackendRegistry(),
        safeBoundaryResumeEnabled: true,
        inspectContinuationSafety: async () => ({
          workspaceIdentity: workspace.workspaceIdentity,
          backgroundOperationsSettled: true,
          availableToolNames: [requiredToolName],
        }),
        newId: randomUUID,
        now: Date.now,
        runtimeSource: 'test',
      });
      const plan = await manager.planAuthoritativeSafeBoundaryContinuation(this.sessionId, {
        sourceRunId: source.sourceRunId,
      });
      const planned = plan.continuation;
      assert.ok(planned?.claimId);
      assert.ok(planned?.boundary);
      assert.ok(planned?.providerReplayDigest);
      if (!planned?.claimId || !planned.boundary || !planned.providerReplayDigest) {
        throw new Error(`Unable to plan pending continuation: ${plan.rejectionReasons}`);
      }
      const claimId = planned.claimId;
      const boundaryDigest = planned.boundary.manifestDigest;
      const providerReplayDigest = planned.providerReplayDigest;
      const targetTurnId = 'turn-pending-client-capability-continuation';
      const continuation = { ...planned, turnId: targetTurnId };
      await stores.agentRunStore.admitRootTurn({
        sessionId: this.sessionId,
        turnId: targetTurnId,
        proposedRunId: continuation.runId,
        proposedUserMessageId: null,
        execution: {
          kind: 'safe_boundary_continuation',
          sourceInvocationId: continuation.sourceInvocationId,
          sourceRunId: continuation.sourceRunId,
          sourceTurnId: continuation.sourceTurnId,
          sourceRuntimeEventHighWater: continuation.sourceRuntimeEventHighWater,
          claimId,
          boundaryDigest,
          providerReplayDigest,
          safetyDigest: continuationSafetyDigest(continuation),
          targetInvocationId: continuation.invocationId,
        },
        previousRootTurnId: null,
        normalizedInput: null,
        sourceMessages: [],
        admittedAt: Date.now(),
      });
      return {
        sourceRunId: source.sourceRunId,
        sourceRuntimeEventHighWater: source.sourceRuntimeEventHighWater,
        targetRunId: continuation.runId,
        targetTurnId,
      };
    } finally {
      await stores?.sessionStore.close?.();
      await owner.close();
    }
  }

  async seedPendingChildAdmission(
    kind:
      | 'linked_child_initial'
      | 'linked_child_resume'
      | 'linked_child_provider_retry'
      | 'claimed_agent_graph_intent',
  ): Promise<{
    kind:
      | 'linked_child_initial'
      | 'linked_child_resume'
      | 'linked_child_provider_retry'
      | 'claimed_agent_graph_intent';
    sessionId: string;
    turnId: string;
    runId: string;
    sourceRunId: string | undefined;
    userMessageId: string | null;
    agentId: string;
    agentName: string;
  }> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for child admission setup');
    let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
    try {
      stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const turnId = randomUUID();
      const runId = randomUUID();
      const sourceRunId =
        kind === 'linked_child_resume' || kind === 'linked_child_provider_retry'
          ? randomUUID()
          : undefined;
      const agentId = 'local-read';
      const agentName = 'Local Read';
      const child = await stores.sessionStore.createSubagent({
        cwd: this.root,
        name: `${agentName} ${kind}`,
        backend: 'fake',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'explore',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
        subagentParent: {
          kind: 'subagent',
          parentSessionId: this.sessionId,
          spawnedBy: {
            parentRunId: `parent-${kind}`,
            parentTurnId: `parent-turn-${kind}`,
            toolCallId: `tool-${kind}`,
          },
          lifecycle: 'foreground',
        },
        subagentRuntime: {
          schemaVersion: 1,
          definitionVersion: 1,
          agentId,
          agentName,
          profile: 'local_read',
          systemPrompt: 'Read the assigned workspace task.',
          toolNames: ['Read', 'Glob', 'Grep'],
          categoryPolicy: { read: 'allow' },
          permissionCeiling: 'ask',
        },
        subagentSpawn: {
          schemaVersion: 1,
          requestFingerprint: (kind === 'linked_child_initial'
            ? 'a'
            : kind === 'linked_child_resume'
              ? 'b'
              : kind === 'linked_child_provider_retry'
                ? 'c'
                : 'd'
          ).repeat(64),
          initialTurnId:
            kind === 'linked_child_initial' || kind === 'claimed_agent_graph_intent'
              ? turnId
              : `initial-${kind}`,
          initialRunId:
            kind === 'linked_child_initial' || kind === 'claimed_agent_graph_intent'
              ? runId
              : sourceRunId!,
        },
      });
      assert.equal(child.created, true);
      if (sourceRunId) {
        const sourceTs = Date.now();
        const sourceRun: AgentRunHeader = {
          runId: sourceRunId,
          invocationId: sourceRunId,
          sessionId: child.header.id,
          turnId: `source-turn-${kind}`,
          status: 'created',
          backendKind: 'fake',
          llmConnectionSlug: 'fake',
          modelId: 'fake-model',
          cwd: this.root,
          permissionMode: 'explore',
          collaborationMode: 'agent',
          createdAt: sourceTs,
          updatedAt: sourceTs,
          agentId,
          agentName,
        };
        await stores.agentRunStore.createRun(sourceRun, { durable: true });
        const sourceTerminal = buildRecoveredTerminalRuntimeEvent({
          id: randomUUID(),
          run: sourceRun,
          status: 'failed',
          ts: sourceTs,
          failureClass: kind === 'linked_child_provider_retry' ? 'RateLimit' : 'source_failed',
          recoveryReason: 'test_source_terminal',
        });
        await commitTerminalRunWithRuntimeFact({
          runStore: stores.agentRunStore,
          runtimeEventStore: stores.runtimeEventStore,
          newId: randomUUID,
          sessionId: child.header.id,
          runId: sourceRunId,
          turnId: sourceRun.turnId,
          status: 'failed',
          ts: sourceTs,
          terminalEvent: sourceTerminal,
          failureClass: kind === 'linked_child_provider_retry' ? 'RateLimit' : 'source_failed',
        });
      }
      const userMessageId = kind === 'linked_child_provider_retry' ? null : randomUUID();
      const admitted = await stores.agentRunStore.admitRootTurn({
        sessionId: child.header.id,
        turnId,
        proposedRunId: runId,
        proposedUserMessageId: userMessageId,
        execution:
          kind === 'linked_child_initial'
            ? { kind, agentId, agentName }
            : kind === 'claimed_agent_graph_intent'
              ? {
                  kind,
                  claim: {
                    schemaVersion: 1,
                    claimId: `graph_claim_${'a'.repeat(32)}`,
                    graphId: `graph-${runId}`,
                    intentId: `graph_intent_${'b'.repeat(32)}`,
                    intentFingerprint: `sha256:${'c'.repeat(64)}`,
                    readinessContextFingerprint: `sha256:${'d'.repeat(64)}`,
                    targetOperatorId: 'local-read',
                    targetSessionId: child.header.id,
                    targetTurnId: turnId,
                    targetRunId: runId,
                    claimedAt: Date.now(),
                  },
                  agentId,
                  agentName,
                }
              : { kind, agentId, agentName, sourceRunId: sourceRunId! },
        previousRootTurnId: null,
        normalizedInput: { text: `pending ${kind}` },
        sourceMessages: [],
        admittedAt: Date.now(),
      });
      assert.equal(admitted.kind, 'admitted');
      return {
        kind,
        sessionId: child.header.id,
        turnId,
        runId,
        sourceRunId,
        userMessageId,
        agentId,
        agentName,
      };
    } finally {
      await stores?.sessionStore.close?.();
      await owner.close();
    }
  }

  async seedClaimedGraphRunLineageDrift(): Promise<void> {
    const graph = await this.seedPendingChildAdmission('claimed_agent_graph_intent');
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for graph lineage setup');
    let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
    try {
      stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const ts = Date.now();
      await stores.agentRunStore.createRun(
        {
          runId: graph.runId,
          invocationId: graph.runId,
          sessionId: graph.sessionId,
          turnId: graph.turnId,
          status: 'created',
          backendKind: 'fake',
          llmConnectionSlug: 'fake',
          modelId: 'fake-model',
          cwd: this.root,
          permissionMode: 'explore',
          collaborationMode: 'agent',
          createdAt: ts,
          updatedAt: ts,
          resumedFromRunId: randomUUID(),
          agentId: graph.agentId,
          agentName: graph.agentName,
        },
        { durable: true },
      );
    } finally {
      await stores?.sessionStore.close?.();
      await owner.close();
    }
  }

  seedAdmission(
    turnId: string,
    content: string | MessageContent,
  ): Promise<{ runId: string; userMessageId: string }> {
    return this.seedTurnState(turnId, content, false, false);
  }

  async archiveSession(): Promise<void> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for archive');
    let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
    try {
      stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      await stores.sessionStore.archive(this.sessionId);
    } finally {
      await stores?.sessionStore.close?.();
      await owner.close();
    }
  }

  async seedConnectionEffect(baseUrl: string, secret: string): Promise<ConnectionCatalogEntry> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for connection effect setup');
    try {
      const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
      const current = await stores.connectionCatalog.getSnapshot();
      const created = await stores.connectionCatalog.create({
        expectedCatalogRevision: current.revision,
        connection: {
          slug: 'connection-effect-provider',
          name: 'Connection effect provider',
          providerType: 'moonshot',
          baseUrl,
          enabled: true,
          enabledModelIds: [CONNECTION_EFFECT_MODEL_IDS[0]!],
        },
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') {
        throw new Error('Connection effect setup did not create a connection');
      }
      const connection = created.snapshot.connections.find(
        ({ slug }) => slug === 'connection-effect-provider',
      );
      assert.ok(connection);
      if (!connection) throw new Error('Connection effect setup omitted its connection');
      const credential = await stores.credentialVault.set({
        locator: {
          scope: 'connection',
          connectionId: connection.connectionId,
          kind: 'api_key',
        },
        expected: null,
        secret,
      });
      assert.equal(credential.kind, 'committed');
      return connection;
    } finally {
      await owner.close();
    }
  }

  seedRunWithoutUserMessage(
    turnId: string,
    content: string | MessageContent,
  ): Promise<{ runId: string; userMessageId: string }> {
    return this.seedTurnState(turnId, content, true, false);
  }

  seedRunWithUserMessage(
    turnId: string,
    content: MessageContent,
  ): Promise<{ runId: string; userMessageId: string }> {
    return this.seedTurnState(turnId, content, true, true);
  }

  async seedRegenerateAdmissionWithoutRun(
    sourceTurnId: string,
    turnId: string,
  ): Promise<{ runId: string; userMessageId: string }> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for regenerate admission setup');
    let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
    try {
      stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const messages = await stores.sessionStore.readMessages(this.sessionId);
      const source = messages.find(
        (message): message is Extract<StoredMessage, { type: 'user' }> =>
          message.type === 'user' && message.turnId === sourceTurnId,
      );
      assert.ok(source);
      if (!source) throw new Error('Regenerate source UserMessage is unavailable');
      const chain = await stores.agentRunStore.listRootTurnAdmissionsForRecovery(this.sessionId);
      const result = await stores.agentRunStore.admitRootTurn({
        sessionId: this.sessionId,
        turnId,
        proposedRunId: randomUUID(),
        proposedUserMessageId: randomUUID(),
        execution: { kind: 'regenerate', sourceTurnId },
        previousRootTurnId: chain.at(-1)?.turnId ?? null,
        normalizedInput: normalizeMessageContent(source),
        sourceMessages: [],
        admittedAt: Date.now(),
      });
      assert.equal(result.kind, 'admitted');
      assert.ok(result.admission.userMessageId);
      return {
        runId: result.admission.runId,
        userMessageId: result.admission.userMessageId,
      };
    } finally {
      await stores?.sessionStore.close?.();
      await owner.close();
    }
  }

  private async seedTurnState(
    turnId: string,
    input: string | MessageContent,
    createRun: boolean,
    createUserMessage: boolean,
  ): Promise<{ runId: string; userMessageId: string }> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for admission setup');
    let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
    try {
      stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const admittedAt = Date.now();
      const content = typeof input === 'string' ? { text: input } : input;
      const result = await stores.agentRunStore.admitRootTurn({
        sessionId: this.sessionId,
        turnId,
        proposedRunId: randomUUID(),
        proposedUserMessageId: randomUUID(),
        execution: { kind: 'external_message' },
        previousRootTurnId: null,
        normalizedInput: content,
        sourceMessages: [],
        admittedAt,
      });
      assert.equal(result.kind, 'admitted');
      if (createRun) {
        await stores.agentRunStore.createRun({
          runId: result.admission.runId,
          invocationId: result.admission.runId,
          sessionId: this.sessionId,
          turnId,
          status: 'created',
          backendKind: 'fake',
          llmConnectionSlug: 'fake',
          modelId: 'fake-model',
          cwd: this.root,
          permissionMode: 'ask',
          createdAt: admittedAt,
          updatedAt: admittedAt,
        });
      }
      assert.ok(result.admission.userMessageId);
      if (createUserMessage) {
        await stores.sessionStore.appendMessage(this.sessionId, {
          type: 'user',
          id: result.admission.userMessageId,
          turnId,
          ts: admittedAt,
          ...content,
        });
      }
      return {
        runId: result.admission.runId,
        userMessageId: result.admission.userMessageId,
      };
    } finally {
      await stores?.sessionStore.close?.();
      await owner.close();
    }
  }

  async startHost(
    recoveryProbe?: {
      sessionId: string;
      runId: string;
    },
    safeBoundaryResumeEnabled = true,
  ): Promise<ExecutionHostHandle> {
    const child = this.spawnHost('inherit', recoveryProbe, safeBoundaryResumeEnabled);
    const ready = await waitForHostReady(child);
    return { child, ...ready };
  }

  async expectHostStartupFailure(): Promise<void> {
    const child = this.spawnHost('ignore');
    await assert.rejects(() => waitForHostReady(child), /execution Host exited before readiness/);
    await withTimeout(waitForExit(child), PROCESS_TIMEOUT_MS, 'failed execution Host did not exit');
    this.#children.delete(child);
  }

  async assertOwnerAvailable(): Promise<void> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    await owner?.close();
  }

  async stopHost(
    host: ExecutionHostHandle,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (host.child.exitCode === null && host.child.signalCode === null) {
      host.child.send({ type: 'shutdown' });
    }
    const exit = await withTimeout(
      waitForExitResult(host.child),
      PROCESS_TIMEOUT_MS + 2_000,
      'execution Host did not stop',
    );
    this.#children.delete(host.child);
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(
        `execution Host stopped uncleanly: ${exit.code === null ? exit.signal : `code ${exit.code}`}`,
      );
    }
    return exit;
  }

  async killHost(host: ExecutionHostHandle): Promise<void> {
    const closed = waitForCloseResult(host.child);
    host.child.kill('SIGKILL');
    await withTimeout(closed, PROCESS_TIMEOUT_MS, 'execution Host survived SIGKILL');
    this.#children.delete(host.child);
  }

  async waitForHostExit(host: ExecutionHostHandle): Promise<void> {
    await withTimeout(
      waitForExit(host.child),
      PROCESS_TIMEOUT_MS,
      'draining execution Host did not exit',
    );
    this.#children.delete(host.child);
  }

  async readTurn(turnId: string): Promise<TurnLedger> {
    const reader = await acquireReader(this.capability);
    let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForRead>> | undefined;
    try {
      stores = await openInteractiveExecutionStoresForRead(reader.lease);
      const admission = await stores.agentRunStore.readRootTurnAdmission(this.sessionId, turnId);
      assert.ok(admission);
      const runs = (await stores.agentRunStore.listSessionRuns(this.sessionId)).filter(
        (candidate) => candidate.turnId === turnId,
      );
      const run = await stores.agentRunStore.readRun(this.sessionId, admission.runId);
      const messages = await stores.sessionStore.readMessages(this.sessionId);
      const runtimeEvents = await stores.runtimeEventStore.readImmutableRuntimeEvents(
        this.sessionId,
        admission.runId,
      );
      return {
        runs,
        userMessages: messages.filter(
          (message): message is Extract<StoredMessage, { type: 'user' }> =>
            message.type === 'user' && message.turnId === turnId,
        ),
        runtimeEvents,
        terminalEvents: runtimeEvents.filter(isTerminalRuntimeEvent),
        classification: classifyTerminalRuntimeLedger(run, runtimeEvents),
      };
    } finally {
      await stores?.sessionStore.close?.();
      await reader.close();
    }
  }

  async readAdmissionChain() {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for admission inspection');
    let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
    try {
      stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      return await stores.agentRunStore.listRootTurnAdmissionsForRecovery(this.sessionId);
    } finally {
      await stores?.sessionStore.close?.();
      await owner.close();
    }
  }

  async readTurnFootprint(turnId: string): Promise<{
    admitted: boolean;
    runCount: number;
    userMessageCount: number;
  }> {
    const reader = await acquireReader(this.capability);
    let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForRead>> | undefined;
    try {
      stores = await openInteractiveExecutionStoresForRead(reader.lease);
      const [admission, runs, messages] = await Promise.all([
        stores.agentRunStore.readRootTurnAdmission(this.sessionId, turnId),
        stores.agentRunStore.listSessionRuns(this.sessionId),
        stores.sessionStore.readMessages(this.sessionId),
      ]);
      return {
        admitted: admission !== undefined,
        runCount: runs.filter((run) => run.turnId === turnId).length,
        userMessageCount: messages.filter(
          (message) => message.type === 'user' && message.turnId === turnId,
        ).length,
      };
    } finally {
      await stores?.sessionStore.close?.();
      await reader.close();
    }
  }

  async close(): Promise<void> {
    for (const child of this.#children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await withTimeout(waitForExit(child), 1_000, 'cleanup Host did not exit').catch(
        () => undefined,
      );
    }
    await rm(join(resolveRootControlNamespace(), this.capability.rootId), {
      recursive: true,
      force: true,
    });
    await removePosixEndpointDirectories(this.capability.rootId);
    await rm(this.base, { recursive: true, force: true });
  }

  private spawnHost(
    stderr: 'inherit' | 'ignore',
    recoveryProbe?: { sessionId: string; runId: string },
    safeBoundaryResumeEnabled = true,
  ): ChildProcess {
    const env = { ...process.env };
    if (safeBoundaryResumeEnabled) env.MAKA_RUNTIME_SAFE_BOUNDARY_RESUME = '1';
    else delete env.MAKA_RUNTIME_SAFE_BOUNDARY_RESUME;
    const child = fork(
      new URL('./execution-host.js', import.meta.url),
      [
        this.root,
        this.capability.rootId,
        '60000',
        ...(recoveryProbe ? [recoveryProbe.sessionId, recoveryProbe.runId] : []),
      ],
      { stdio: ['ignore', 'ignore', stderr, 'ipc'], env },
    );
    this.#children.add(child);
    return child;
  }
}

export async function withExecutionRoot(
  run: (fixture: ExecutionFixture) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-execution-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({
    path: root,
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  let sessionId: string;
  let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
  try {
    stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: root,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    sessionId = session.id;
  } finally {
    await stores?.sessionStore.close?.();
    await owner.close();
  }
  const fixture = new ExecutionFixture(base, root, capability, sessionId);
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

export async function connectClient(
  rootPath: string,
  surface: 'desktop' | 'tui' | 'run',
): Promise<RuntimeHostConnection> {
  const result = await connectRuntimeHost({
    rootPath,
    surface,
    protocol: CURRENT_PROTOCOL,
  });
  assert.equal(result.kind, 'connected');
  return result.connection;
}

export async function startConnectionEffectProvider(
  options: { responseDelayMs?: number } = {},
): Promise<{
  readonly baseUrl: string;
  readonly requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly authorization: string | undefined;
  }>;
  close(): Promise<void>;
}> {
  const requests: Array<{
    method: string;
    url: string;
    authorization: string | undefined;
  }> = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      authorization: request.headers.authorization,
    });
    const respond = () => {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(
        request.method === 'GET'
          ? JSON.stringify({ data: CONNECTION_EFFECT_MODEL_IDS.map((id) => ({ id })) })
          : JSON.stringify({ choices: [] }),
      );
    };
    const responseDelayMs = options.responseDelayMs ?? 0;
    if (responseDelayMs > 0) {
      setTimeout(respond, responseDelayMs);
    } else {
      respond();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeHttpServer(server);
    throw new Error('Connection effect provider did not bind a TCP address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => closeHttpServer(server),
  };
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function sendStartWithoutReadingResponse(
  endpoint: string,
  input: { sessionId: string; turnId: string; text: string },
): Promise<FramedTransport> {
  const transport = new FramedTransport(await openSocket(endpoint));
  await writeClientFrame(transport, {
    kind: 'hello',
    clientInstanceId: randomUUID(),
    surface: 'desktop',
    protocolMin: CURRENT_PROTOCOL.min,
    protocolMax: CURRENT_PROTOCOL.max,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
    compositionId: 'maka.interactive',
  });
  const handshake = decodeHostFrame(await transport.read(2_000));
  assert.ok('kind' in handshake);
  assert.equal(handshake.kind, 'accepted');
  await writeClientFrame(transport, {
    requestId: randomUUID(),
    operation: 'turn.start',
    input: {
      sessionId: input.sessionId,
      turnId: input.turnId,
      content: { text: input.text },
    },
  });
  return transport;
}

function writeClientFrame(transport: FramedTransport, frame: ClientFrame): Promise<void> {
  return transport.write(encodeProtocolMessage(frame));
}

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const onError = (error: Error) => {
      socket.off('connect', onConnect);
      reject(error);
    };
    const onConnect = () => {
      socket.off('error', onError);
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

export async function waitForTurn(
  connection: RuntimeHostConnection,
  sessionId: string,
  turnId: string,
): Promise<TurnSnapshot> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (true) {
    try {
      return await connection.queryTurn({ sessionId, turnId });
    } catch (error) {
      if (!(error instanceof RuntimeHostOperationError) || error.code !== 'not_found') throw error;
      if (Date.now() >= deadline) throw new Error('Turn admission was not observed');
      await sleep(20);
    }
  }
}

export class SubscriptionProbe {
  readonly frames: SubscriptionFrame[] = [];
  readonly done: Promise<void>;
  #failure: unknown;
  #settled = false;

  constructor(subscription: RuntimeHostSessionSubscription) {
    this.done = this.#consume(subscription);
  }

  async waitFor(
    predicate: (frame: SubscriptionFrame) => boolean,
    message: string,
  ): Promise<SubscriptionFrame> {
    const deadline = Date.now() + PROCESS_TIMEOUT_MS;
    while (true) {
      const frame = this.frames.find(predicate);
      if (frame) return frame;
      if (this.#failure) throw this.#failure;
      if (this.#settled) throw new Error(`${message}: subscription closed`);
      if (Date.now() >= deadline) throw new Error(message);
      await sleep(10);
    }
  }

  async waitForFailure(reason: RuntimeHostSubscriptionError['reason']): Promise<void> {
    const deadline = Date.now() + PROCESS_TIMEOUT_MS;
    while (!this.#failure && !this.#settled && Date.now() < deadline) await sleep(10);
    assert.ok(this.#failure instanceof RuntimeHostSubscriptionError);
    assert.equal(this.#failure.reason, reason);
  }

  indexOf(frame: SubscriptionFrame): number {
    return this.frames.indexOf(frame);
  }

  async #consume(subscription: RuntimeHostSessionSubscription): Promise<void> {
    try {
      for await (const frame of subscription) this.frames.push(frame);
    } catch (error) {
      this.#failure = error;
    } finally {
      this.#settled = true;
    }
  }
}

export async function waitForPendingInteraction(
  subscription: RuntimeHostSessionSubscription,
  probe: SubscriptionProbe,
  runId: string,
): Promise<InteractionPendingSnapshot> {
  const initial = subscription.snapshot.interactions.pending.find(
    (interaction) => interaction.runId === runId,
  );
  if (initial) return initial;
  const frame = await probe.waitFor(
    (candidate) =>
      candidate.kind === 'subscription.session_projection' &&
      candidate.snapshot.interactions.pending.some((interaction) => interaction.runId === runId),
    'subscription did not publish the pending Interaction',
  );
  assert.equal(frame.kind, 'subscription.session_projection');
  const pending = frame.snapshot.interactions.pending.find(
    (interaction) => interaction.runId === runId,
  );
  assert.ok(pending);
  return pending;
}

export async function waitForTerminalTurn(
  connection: RuntimeHostConnection,
  sessionId: string,
  turnId: string,
): Promise<TurnSnapshot> {
  const subscription = await connection.openSessionSubscription(
    { sessionId, transcript: { kind: 'none' } },
    PROCESS_TIMEOUT_MS,
  );
  try {
    return await withTimeout(
      (async () => {
        const current = await connection.queryTurn({ sessionId, turnId });
        if (isTerminalTurnSnapshot(current)) return current;
        for await (const frame of subscription) {
          if (frame.kind !== 'subscription.session_projection') continue;
          const projected = frame.snapshot.rootTurn;
          if (projected?.turnId === turnId && isTerminalTurnSnapshot(projected)) return projected;
        }
        throw new Error('Session subscription closed before the Turn reached a terminal fact');
      })(),
      PROCESS_TIMEOUT_MS,
      `Turn ${turnId} in Session ${sessionId} did not reach a terminal fact`,
    );
  } finally {
    await subscription.close();
  }
}

function isTerminalTurnSnapshot(snapshot: TurnSnapshot): boolean {
  return (
    snapshot.status === 'completed' ||
    snapshot.status === 'failed' ||
    snapshot.status === 'cancelled'
  );
}

export async function waitForRunningTurn(
  connection: RuntimeHostConnection,
  sessionId: string,
  turnId: string,
): Promise<TurnSnapshot> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (true) {
    const snapshot = await connection.queryTurn({ sessionId, turnId });
    if (snapshot.status === 'running' || snapshot.status === 'waiting_for_user') return snapshot;
    if (Date.now() >= deadline) throw new Error('Turn did not become active');
    await sleep(20);
  }
}

export async function waitForDurableMessageConflict(
  connection: RuntimeHostConnection,
  input: TurnMessageSubmitInput,
): Promise<void> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (true) {
    try {
      await connection.request('turn.message.submit', input);
      throw new Error('Conflicting durable Message identity was accepted');
    } catch (error) {
      if (error instanceof RuntimeHostOperationError && error.code === 'operation_conflict') return;
      if (!(error instanceof RuntimeHostOperationError) || error.code !== 'outcome_unknown') {
        throw error;
      }
    }
    if (Date.now() >= deadline) throw new Error('Durable Message source was not observed');
    await sleep(20);
  }
}

export function operationError(code: RuntimeHostOperationError['code']) {
  return (error: unknown): boolean =>
    error instanceof RuntimeHostOperationError && error.code === code;
}

export function assertJsonLines(bytes: string): void {
  for (const line of bytes.split('\n').filter(Boolean)) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
}

export function attachment(id: string, name: string) {
  return {
    kind: 'image' as const,
    name,
    mimeType: 'image/png',
    bytes: 10,
    ref: { kind: 'workspace_file' as const, relativePath: `attachments/${id}.png` },
  };
}

export function quoteRefs(prefix: string) {
  return [
    {
      text: `${prefix} first excerpt`,
      label: 'Assistant',
      sourceTurnId: `turn-${prefix}-1`,
    },
    {
      text: `${prefix} second excerpt`,
      sourceTurnId: `turn-${prefix}-2`,
    },
  ];
}

export function quotedContent(text: string): MessageContent {
  return { text, quotes: quoteRefs(text.replaceAll(' ', '-')) };
}

export function requireStartedTurn(result: TurnStartResult): TurnSnapshot {
  assert.equal(result.kind, 'started', JSON.stringify(result));
  if (result.kind !== 'started') assert.fail('Expected a started Turn');
  return result.turn;
}

export function userRuntimeContent(
  events: readonly RuntimeEvent[],
): Extract<NonNullable<RuntimeEvent['content']>, { kind: 'text' }> | undefined {
  for (const event of events) {
    if (event.role === 'user' && event.content?.kind === 'text') return event.content;
  }
  return undefined;
}

function waitForHostReady(
  child: ChildProcess,
): Promise<{ hostEpoch: string; endpoint: string; recoveryOutcome?: RuntimeEvent }> {
  return withTimeout(
    new Promise((resolve, reject) => {
      const cleanup = () => {
        child.off('error', onError);
        child.off('exit', onExit);
        child.off('message', onMessage);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new Error(`execution Host exited before readiness: ${code ?? signal}`));
      };
      const onMessage = (message: unknown) => {
        if (!isHostReadyMessage(message)) return;
        cleanup();
        resolve({
          hostEpoch: message.hostEpoch,
          endpoint: message.endpoint,
          ...(message.recoveryOutcome ? { recoveryOutcome: message.recoveryOutcome } : {}),
        });
      };
      child.once('error', onError);
      child.once('exit', onExit);
      child.on('message', onMessage);
    }),
    PROCESS_TIMEOUT_MS,
    'execution Host did not become ready',
  );
}

function isHostReadyMessage(value: unknown): value is {
  type: 'ready';
  hostEpoch: string;
  endpoint: string;
  recoveryOutcome?: RuntimeEvent;
} {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'ready' &&
    typeof message.hostEpoch === 'string' &&
    typeof message.endpoint === 'string' &&
    (message.recoveryOutcome === undefined ||
      (typeof message.recoveryOutcome === 'object' && message.recoveryOutcome !== null))
  );
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}

function waitForExitResult(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function waitForCloseResult(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('error', onError);
      child.off('close', onClose);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    child.once('error', onError);
    child.once('close', onClose);
  });
}

async function acquireReader(capability: StorageRootCapability<'interactive'>) {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (true) {
    const reader = await tryAcquireInteractiveRootReader(capability);
    if (reader) return reader;
    if (Date.now() >= deadline)
      throw new Error('Interactive root reader could not acquire the released root');
    await sleep(20);
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
