import { defineInteractiveRuntimeHostComposition } from '../server/host-composition.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  agentGraphIdForRootSession,
  type AgentGraphClientChangedListener,
  type AgentGraphCoordinator,
} from '@maka/runtime/stream-graph-coordinator';
import {
  type AgentGraphClientSnapshot,
  type AgentGraphOperatorInspection,
} from '@maka/runtime/stream-graph-read-model';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  connectRuntimeHost,
  type RuntimeHostConnection,
  type RuntimeHostSessionSubscription,
} from '../client/index.js';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '../protocol/index.js';
import { HostAgentGraphCoordinator } from '../server/agent-graph-coordinator.js';
import type { CanonicalSessionProjection } from '../server/canonical-session-projection.js';
import { RuntimeHostKernel } from '../server/host-kernel.js';
import { createUnavailableDomainOperationHandlers } from '../server/operation-dispatcher.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { SessionContinuityCoordinator } from '../server/session-continuity-coordinator.js';

const ROOT_SESSION_ID = 'root-1';
const GRAPH_ID = agentGraphIdForRootSession(ROOT_SESSION_ID);
// Injected client liveness cadence: the fake authority's slow stop() holds a
// request past probe cycles measured in this unit instead of the real 2s one.
const LIVENESS_INTERVAL_MS = 100;
const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

test('two Clients query and control one Agent graph through Session invalidation', {
  timeout: 10_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-agent-graph-two-client-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const authority = new FakeAgentGraphAuthority();
  const host = await RuntimeHostKernel.start({
    owner,
    idleGraceMs: 10_000,
    composition: defineInteractiveRuntimeHostComposition(async (context) => {
      const continuity = new SessionContinuityCoordinator(
        context.hostEpoch,
        async (sessionId) => (sessionId === ROOT_SESSION_ID ? canonical(context.hostEpoch) : null),
        new SessionAdmissionGate(),
        context.requestDrain,
      );
      const graph = new HostAgentGraphCoordinator({
        authority,
        continuity,
        stopExecution: (rootSessionId) => authority.stopExecution(rootSessionId),
      });
      return {
        handlers: {
          ...createUnavailableDomainOperationHandlers(),
          ...continuity.handlers,
          ...graph.handlers,
        },
        continuity,
        beginDrain: () => undefined,
        recover: async () => undefined,
        close: async () => {
          graph.close();
          continuity.close();
        },
      };
    }),
  });
  // Two probe round-trips observed while the stop request is pending resolve
  // the fake's stopGate. The observer is wired only onto the final TUI
  // connection that issues agent.graph.stop, so no other connection's slow
  // query could ever satisfy the counter.
  let livenessProbes = 0;
  let markProbesCrossed!: () => void;
  const probeWindowCrossed = new Promise<void>((resolve) => {
    markProbesCrossed = resolve;
  });
  const onLivenessProbe = () => {
    livenessProbes += 1;
    if (livenessProbes >= 2) markProbesCrossed();
  };
  authority.stopGate = probeWindowCrossed;
  let desktop: RuntimeHostConnection | undefined;
  let tui: RuntimeHostConnection | undefined;
  let subscription: RuntimeHostSessionSubscription | undefined;
  try {
    desktop = await connect(root, 'desktop');
    tui = await connect(root, 'tui');
    subscription = await desktop.openSessionSubscription({
      sessionId: ROOT_SESSION_ID,
      transcript: { kind: 'none' },
    });

    const [desktopSnapshot, tuiSnapshot] = await Promise.all([
      desktop.request('agent.graph.query', { rootSessionId: ROOT_SESSION_ID }),
      tui.request('agent.graph.query', { rootSessionId: ROOT_SESSION_ID }),
    ]);
    assert.equal(desktopSnapshot.snapshotVersion, tuiSnapshot.snapshotVersion);
    assert.equal(desktopSnapshot.status, 'active');

    const inspection = await tui.request('agent.graph.operator.query', {
      rootSessionId: ROOT_SESSION_ID,
      operatorId: 'operator-1',
    });
    assert.equal(inspection.operator.childSessionId, 'child-1');

    await tui.close();
    tui = undefined;
    assert.equal(authority.stopCount, 0);
    assert.equal(
      (await desktop.request('agent.graph.query', { rootSessionId: ROOT_SESSION_ID })).status,
      'active',
    );

    tui = await connect(root, 'tui', onLivenessProbe);
    const stopped = await tui.request('agent.graph.stop', { rootSessionId: ROOT_SESSION_ID });
    assert.deepEqual(stopped, { rootSessionId: ROOT_SESSION_ID, graphId: GRAPH_ID });
    assert.equal(authority.stopCount, 1);

    const invalidation = await withTimeout(
      subscription[Symbol.asyncIterator]().next(),
      2_000,
      'Agent graph invalidation did not arrive',
    );
    assert.equal(invalidation.done, false);
    assert.deepEqual(invalidation.value, {
      kind: 'subscription.agent_graph_changed',
      hostEpoch: desktop.hostEpoch,
      subscriptionId: subscription.subscriptionId,
      sequence: 1,
      rootSessionId: ROOT_SESSION_ID,
      graphId: GRAPH_ID,
      reason: 'stopped',
    });
    assert.equal(
      (await desktop.request('agent.graph.query', { rootSessionId: ROOT_SESSION_ID })).status,
      'stopped',
    );
  } finally {
    await Promise.allSettled([subscription?.close(), desktop?.close(), tui?.close()]);
    await host.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

type GraphAuthority = Pick<
  AgentGraphCoordinator,
  'getSnapshot' | 'inspectOperator' | 'subscribeAll'
>;

class FakeAgentGraphAuthority implements GraphAuthority {
  readonly #listeners = new Set<AgentGraphClientChangedListener>();
  #snapshot = snapshot();
  stopCount = 0;

  async getSnapshot(): Promise<AgentGraphClientSnapshot> {
    return structuredClone(this.#snapshot);
  }

  async inspectOperator(): Promise<AgentGraphOperatorInspection> {
    return inspection(this.#snapshot);
  }

  /** Resolved by the test once two client liveness probes have observably
   *  round-tripped, so the pending agent.graph.stop request provably crosses
   *  probe cycles — causal ordering, no fixed timing at all. */
  stopGate: Promise<void> = Promise.resolve();

  async stopExecution(rootSessionId: string): Promise<void> {
    assert.equal(rootSessionId, ROOT_SESSION_ID);
    await this.stopGate;
    this.stopCount += 1;
    this.#snapshot.status = 'stopped';
    for (const listener of this.#listeners) {
      await listener({
        schemaVersion: 1,
        rootSessionId: ROOT_SESSION_ID,
        graphId: GRAPH_ID,
        reason: 'stopped',
      });
    }
  }

  subscribeAll(listener: AgentGraphClientChangedListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

async function connect(
  rootPath: string,
  surface: 'desktop' | 'tui',
  onLivenessProbe?: () => void,
): Promise<RuntimeHostConnection> {
  const result = await connectRuntimeHost({
    rootPath,
    surface,
    protocol: PROTOCOL,
    livenessIntervalMs: LIVENESS_INTERVAL_MS,
    onLivenessProbe,
  });
  assert.equal(result.kind, 'connected');
  if (result.kind !== 'connected') throw new Error('Runtime Host did not accept the Client');
  return result.connection;
}

function snapshot(): AgentGraphClientSnapshot {
  const version = `sha256:${'a'.repeat(64)}`;
  return {
    schemaVersion: 1,
    rootSessionId: ROOT_SESSION_ID,
    graphId: GRAPH_ID,
    orchestrationMode: 'graph',
    snapshotVersion: version,
    status: 'active',
    scheduleRevision: 1,
    topologyFingerprint: version,
    closed: false,
    operators: [operator()],
    edges: [],
    work: [],
    reconciliationFailures: [],
    stoppedTargets: [],
    claims: [],
    recentControlDecisions: [],
    recentActivity: [],
    terminalHistory: { records: [] },
    omitted: {
      operators: 0,
      edges: 0,
      work: 0,
      reconciliationFailures: 0,
      stoppedTargets: 0,
      claims: 0,
      controlDecisions: 0,
      recentActivity: 0,
    },
  };
}

function operator() {
  return {
    operatorId: 'operator-1',
    childSessionId: 'child-1',
    provisionId: 'provision-1',
    agentId: 'agent-1',
    provisionedAt: 1,
    status: 'running' as const,
    inboundEdgeIds: [],
    outboundEdgeIds: [],
    scheduledWorkIds: [],
    readiness: [],
    omitted: {
      inboundEdgeIds: 0,
      outboundEdgeIds: 0,
      scheduledWorkIds: 0,
      readiness: 0,
      readinessWaits: 0,
    },
  };
}

function inspection(source: AgentGraphClientSnapshot): AgentGraphOperatorInspection {
  return {
    schemaVersion: 1,
    rootSessionId: source.rootSessionId,
    graphId: source.graphId,
    snapshotVersion: source.snapshotVersion,
    operator: source.operators[0]!,
    inboundEdges: [],
    outboundEdges: [],
    work: [],
    claims: [],
    activations: [],
    recentRecords: [],
    omitted: {
      inboundEdges: 0,
      outboundEdges: 0,
      work: 0,
      claims: 0,
      activations: 0,
      records: 0,
    },
  };
}

function canonical(hostEpoch: string): CanonicalSessionProjection {
  return {
    session: {
      sessionId: ROOT_SESSION_ID,
      metadataRevision: 1,
      status: 'active',
      createdAt: 1,
      lastUsedAt: 1,
      isArchived: false,
    },
    rootTurn: null,
    goal: null,
    queue: { hostEpoch, queueRevision: 0, steering: [], followup: [] },
    interactions: { pending: [] },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
