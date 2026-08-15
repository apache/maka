import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { z } from 'zod';
import { clientCapabilityConnectionIdentity } from './fixtures/client-capability.js';
import {
  createBypassExecutionBoundary,
  createManagedExecutionBoundary,
} from '@maka/core/sandbox-boundary';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import { decodeRunCompositionSnapshot } from '@maka/core/run-composition';
import { decodeCanonicalToolResultContent } from '@maka/core/tool-result-record-schema';
import { type ModelCallKind } from '@maka/core/model-call-attempt';
import { type RuntimeEvent } from '@maka/core/runtime-event';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import type { PlanSessionState, PlanStore } from '@maka/core/plan';
import type { TaskLedgerStore } from '@maka/core/task-ledger';
import {
  serializeOAuthSubscriptionTokens,
  type OAuthSubscriptionTokens,
} from '@maka/runtime/subscription-credentials';
import { type BackendFactoryContext } from '@maka/runtime/session-manager';
import { type AiSdkBackendInput, type RunTraceEvent } from '@maka/runtime/ai-sdk-backend';
import { type FilesystemWorkerExecuteInput } from '@maka/runtime/filesystem-worker';
import { type MakaTool, type MakaToolContext } from '@maka/runtime/tool-runtime';
import {
  type ProxiedFetchProxy,
  type ProxiedFetchTransport,
} from '@maka/runtime/network/scoped-fetch-transport';
import { type ScannedSkill } from '@maka/runtime/skills';
import { agentGraphIdForRootSession } from '@maka/runtime/stream-graph-coordinator';
import { buildParentAgentTools } from '@maka/runtime/subagent-tools';
import { SESSION_RECAP_INSTRUCTION } from '@maka/runtime/session-recap';
import { hostedExecutionToolNames } from '../server/hosted-execution-tool-profile.js';
import { createToolResultArchiveCapability } from '@maka/runtime/tool-result-archive-capability';
import { loadHistoryCompactCheckpointsFromRunLedger } from '@maka/runtime/history-compact-ledger';
import { stableHash, toolCatalogHash } from '@maka/runtime/request-shape';
import { toolAvailabilityHash } from '@maka/runtime/tool-availability';
import { createSqliteRuntimeStore } from '@maka/storage';
import { createAgentGraphControlStore } from '@maka/storage/agent-graph-control-store';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import {
  openInteractiveRuntimePolicyStoresForWrite,
  type RuntimePolicyStoresWriter,
} from '@maka/storage/runtime-policy-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveTaskLedgerStoreForWrite } from '@maka/storage/task-ledger-authority';
import {
  openInteractiveUsageStoresForWrite,
  type InteractiveUsageStoresWriter,
} from '@maka/storage/usage-stores';
import type { TurnSnapshot, UsageQueryResult } from '../protocol/index.js';
import type { ClientCapabilityHostFrame } from '../protocol/index.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import {
  createHostDailyReviewModel,
  createHostGoalEvaluator,
  createHostMemoryExtractionModel,
  createHostSessionEffectModel,
} from '../server/execution-model-authority.js';
import {
  createHostAiSdkBackend,
  resolveCollaborationPermissionMode,
  type HostAiSdkBackendInput,
} from '../server/execution-model-composition.js';
import {
  createInteractiveRunComposer,
  createInteractiveRunComposerFactory,
} from '../server/interactive-run-composer.js';
import { HostClientCapabilityCoordinator } from '../server/client-capability-coordinator.js';
import type { HostMemoryCoordinator } from '../server/memory-coordinator.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';
import { HostResidencyRegistry } from '../server/host-residency-registry.js';
import {
  HostOAuthExecutionAuthority,
  OAuthExecutionCredentialError,
} from '../server/oauth-execution-authority.js';
import type { HostSkillCatalogCoordinator } from '../server/skill-catalog-coordinator.js';
import { AgentGraphProviderScenario } from './fixtures/agent-graph-provider-scenario.js';

const MODEL_ID = 'hosted-real-model';
const API_KEY = 'hosted-provider-key';
const RESPONSE_TEXT = 'Hosted real-model execution completed.';
const SUMMARY_TEXT = '## Goal\nContinue hosted real-model execution.';
const CLIENT_CAPABILITY_RESULT_TEXT = 'HOSTED_CLIENT_CAPABILITY_RESULT_SENTINEL';
const CHILD_AGENT_RESULT_TEXT = 'HOSTED_CHILD_AGENT_RESULT_SENTINEL';
const WEB_RESEARCH_CHILD_RESULT_TEXT = 'HOSTED_WEB_RESEARCH_RESULT_SENTINEL';
const MAX_IMPLEMENTATION_CHILD_PTY_READS = 5;
const MIN_IMPLEMENTATION_CHILD_REQUESTS = 6;
const MAX_IMPLEMENTATION_CHILD_REQUESTS =
  MIN_IMPLEMENTATION_CHILD_REQUESTS + MAX_IMPLEMENTATION_CHILD_PTY_READS - 1;
const HEADLESS_CODING_V1_PROMPT_HASH =
  'sha256:0e3389e330b8b8f0db1c7a8b8e2126325fe4c672d6eff279afcd3f9412e52271';
const HEADLESS_CODING_V1_TOOLS_HASH =
  'sha256:ea1f293096e5e209ae49346f46b0e8ff9b54ae17452a5a23149ad7233afaeafc';
const execFileAsync = promisify(execFile);

test('backend creation aborts a stalled canonical connection read', async () => {
  const abort = new AbortController();
  const creating = createHostAiSdkBackend(
    backendCreationFixture({
      abortSignal: abort.signal,
      resolveExecutionConnection: () => new Promise(() => {}),
      readPricing: async () => ({ revision: 0, overrides: [] }),
    }),
  );

  abort.abort(new DOMException('Connection resolution was interrupted', 'AbortError'));

  await assert.rejects(settleWithin(creating), {
    name: 'AbortError',
    message: 'Connection resolution was interrupted',
  });
});

test('backend creation aborts a stalled pricing snapshot read', async () => {
  const abort = new AbortController();
  let markPricingStarted!: () => void;
  const pricingStarted = new Promise<void>((resolve) => {
    markPricingStarted = resolve;
  });
  const creating = createHostAiSdkBackend(
    backendCreationFixture({
      abortSignal: abort.signal,
      resolveExecutionConnection: async () => readyExecutionConnection(),
      readPricing: () => {
        markPricingStarted();
        return new Promise(() => {});
      },
    }),
  );
  await pricingStarted;

  abort.abort(new DOMException('Pricing resolution was interrupted', 'AbortError'));

  await assert.rejects(settleWithin(creating), {
    name: 'AbortError',
    message: 'Pricing resolution was interrupted',
  });
});

test('backend creation admits the enabled bootstrap DeepSeek model before discovery', async () => {
  const modelId = 'deepseek-v4-flash';
  const backend = await createHostAiSdkBackend(
    backendCreationFixture({
      abortSignal: new AbortController().signal,
      modelId,
      resolveExecutionConnection: async () => ({
        kind: 'ready',
        connection: {
          slug: 'backend-creation-connection',
          providerType: 'deepseek',
          enabledModelIds: [modelId],
          models: [],
        },
        networkProxy: { enabled: false },
        secretMaterial: { connection: { secret: API_KEY } },
      }),
      readPricing: async () => ({ revision: 0, overrides: [] }),
    }),
  );

  await backend.dispose();
});

test('backend creation does not bypass a non-empty DeepSeek inventory', async () => {
  const modelId = 'deepseek-v4-flash';
  await assert.rejects(
    createHostAiSdkBackend(
      backendCreationFixture({
        abortSignal: new AbortController().signal,
        modelId,
        resolveExecutionConnection: async () => ({
          kind: 'ready',
          connection: {
            slug: 'backend-creation-connection',
            providerType: 'deepseek',
            enabledModelIds: [modelId],
            models: [{ id: 'deepseek-chat' }],
          },
          networkProxy: { enabled: false },
          secretMaterial: { connection: { secret: API_KEY } },
        }),
        readPricing: async () => ({ revision: 0, overrides: [] }),
      }),
    ),
    /Session model is not enabled/,
  );
});

test('backend creation does not treat aliased provider metadata as inventory', async () => {
  const modelId = 'claude-opus-5';
  await assert.rejects(
    createHostAiSdkBackend(
      backendCreationFixture({
        abortSignal: new AbortController().signal,
        modelId,
        resolveExecutionConnection: async () => ({
          kind: 'ready',
          connection: {
            slug: 'backend-creation-connection',
            providerType: 'opencode-free',
            enabledModelIds: [modelId],
            models: [],
          },
          networkProxy: { enabled: false },
          secretMaterial: {},
        }),
        readPricing: async () => ({ revision: 0, overrides: [] }),
      }),
    ),
    /Session model is not enabled/,
  );
});

test('provider dispatch fails closed when the Run Composition commit fails', async () => {
  const provider = await startProvider();
  let commits = 0;
  let backend: Awaited<ReturnType<typeof createHostAiSdkBackend>> | undefined;
  try {
    backend = await createHostAiSdkBackend(
      backendCreationFixture({
        abortSignal: new AbortController().signal,
        resolveExecutionConnection: async () => readyExecutionConnection(provider.baseUrl),
        readPricing: async () => ({ revision: 0, overrides: [] }),
        executionBoundary: createBypassExecutionBoundary(0),
        recordRunComposition: async (_runId, snapshot) => {
          commits += 1;
          decodeRunCompositionSnapshot(snapshot);
          throw new Error('Run Composition store unavailable');
        },
      }),
    );
    const events = [];
    for await (const event of backend.send({
      invocationId: 'composition-invocation',
      runId: 'composition-run',
      turnId: 'composition-turn',
      text: 'This request must not reach the provider.',
      context: [],
    })) {
      events.push(event);
    }

    assert.equal(commits, 1);
    assert.equal(provider.requests.length, 0);
    assert.ok(events.some((event) => event.type === 'error'));
  } finally {
    await backend?.dispose();
    await provider.close();
  }
});

test('backend abort cannot cancel the authority-owned OAuth refresh used by its successor', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-oauth-backend-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'interactive'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  let secondBackend: Awaited<ReturnType<typeof createHostAiSdkBackend>> | undefined;
  let transports: ReturnType<typeof controlledOAuthTransports> | undefined;
  try {
    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    // claude-subscription discovery is fallback-only (session-scoped OAuth
    // tokens cannot call GET /v1/models). Create seeds the curated inventory;
    // pick an id from that inventory rather than opening a fetch ticket.
    const subscriptionModelId = 'claude-sonnet-5';
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'backend-creation-connection',
        name: 'OAuth backend creation',
        providerType: 'claude-subscription',
        enabled: true,
        enabledModelIds: [subscriptionModelId],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) return;
    assert.ok(
      connection.models.some((model) => model.id === subscriptionModelId),
      'create must seed the curated claude-subscription inventory',
    );
    const tokens: OAuthSubscriptionTokens = {
      access_token: 'expired-oauth-access',
      refresh_token: 'rotating-oauth-refresh',
      expires_at: 0,
      account_uuid: 'oauth-account-v1',
    };
    await writeFile(
      join(capability.canonicalPath, 'credential-vault.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          revision: 1,
          entries: [
            {
              locator: {
                scope: 'connection',
                connectionId: connection.connectionId,
                kind: 'oauth_token',
              },
              credentialId: randomUUID(),
              revision: 1,
              secret: serializeOAuthSubscriptionTokens(tokens),
              updatedAt: Date.now(),
            },
          ],
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    transports = controlledOAuthTransports();
    const authority = new HostOAuthExecutionAuthority(policy);
    const firstAbort = new AbortController();
    const firstCreation = createHostAiSdkBackend(
      backendCreationFixture({
        abortSignal: firstAbort.signal,
        modelId: subscriptionModelId,
        resolveExecutionConnection: () =>
          policy.operations.resolveExecutionConnection('backend-creation-connection'),
        runtimePolicy: policy,
        oauthCredentials: authority,
        claudeDeviceId: capability.rootId,
        readPricing: async () => ({ revision: 0, overrides: [] }),
        createFetchTransport: transports.create,
      }),
    );
    await transports.refreshStarted;

    const abortReason = new DOMException('First backend stopped', 'AbortError');
    firstAbort.abort(abortReason);
    await assert.rejects(settleWithin(firstCreation), (error) => error === abortReason);
    assert.equal(transports.modelTransportsClosed, 1);
    assert.equal(transports.refreshTransportClosed, false);

    transports.completeRefresh();
    await transports.refreshTransportSettled;
    assert.equal(transports.refreshTransportClosed, true);

    secondBackend = await createHostAiSdkBackend(
      backendCreationFixture({
        abortSignal: new AbortController().signal,
        modelId: subscriptionModelId,
        resolveExecutionConnection: () =>
          policy.operations.resolveExecutionConnection('backend-creation-connection'),
        runtimePolicy: policy,
        oauthCredentials: authority,
        claudeDeviceId: capability.rootId,
        readPricing: async () => ({ revision: 0, overrides: [] }),
        createFetchTransport: transports.create,
      }),
    );
    assert.equal(transports.refreshCalls, 1);

    const resolved = await policy.operations.resolveExecutionConnection(
      'backend-creation-connection',
    );
    assert.equal(resolved.kind, 'ready');
    if (resolved.kind === 'ready') {
      const persisted = JSON.parse(
        resolved.secretMaterial.connection?.secret ?? '',
      ) as OAuthSubscriptionTokens;
      assert.equal(persisted.access_token, 'refreshed-oauth-access');
      assert.equal(persisted.refresh_token, 'rotated-oauth-refresh');
      assert.equal(persisted.account_uuid, 'oauth-account-v2');
      assert.ok((persisted.expires_at ?? 0) > Date.now());
    }
  } finally {
    try {
      if (transports && transports.refreshCalls > 0) {
        transports.completeRefresh();
        await transports.refreshTransportSettled;
      }
      await secondBackend?.dispose();
    } finally {
      await owner.close();
      await rm(base, { recursive: true, force: true });
    }
  }
});

test('backend creation does not acquire Client Capabilities beyond a bound tool ceiling', async () => {
  let snapshotCalls = 0;
  const backend = await createHostAiSdkBackend(
    backendCreationFixture({
      abortSignal: new AbortController().signal,
      resolveExecutionConnection: async () => readyExecutionConnection(),
      readPricing: async () => ({ revision: 0, overrides: [] }),
      tools: [
        {
          name: 'bounded_tool',
          description: 'The exact activation ceiling.',
          parameters: {},
          impl: async () => 'bounded',
        },
      ],
      snapshotClientCapabilities: () => {
        snapshotCalls += 1;
        throw new Error('Client Capability snapshot must not be acquired');
      },
    }),
  );
  try {
    assert.equal(snapshotCalls, 0);
  } finally {
    await backend.dispose();
  }
});

test('production backend creation continues after a Session Client Capability is lost', async () => {
  const coordinator = new HostClientCapabilityCoordinator({
    activation: new RuntimePolicyActivationGate(),
    onModelToolsChanged: () => undefined,
  });
  const provider = coordinator.attachConnection(clientCapabilityConnectionIdentity('provider-a'), {
    send: async () => undefined,
  });
  const context: ConnectionContext = {
    hostEpoch: 'backend-creation-epoch',
    connectionId: 'provider-a',
    surface: 'desktop',
    principal: 'local_os_user',
    acquireResidency: () => ({ release() {} }),
  };
  const replaced = await coordinator.handlers['client.capability.replace'](
    {
      registrationId: 'registration-a',
      offers: [
        {
          offerId: 'browser',
          version: '0',
          affinity: 'session',
          hostPathAccess: 'cwd',
          label: 'Browser',
          tools: [
            {
              serverId: 'browser',
              name: 'navigate',
              inputSchema: { type: 'object' },
            },
          ],
        },
      ],
    },
    context,
  );
  assert.equal(replaced.ok, true);
  assert.deepEqual(await coordinator.bindSession('backend-creation-session', 'provider-a'), {
    ok: true,
  });
  await provider.close();

  const backend = await createHostAiSdkBackend(
    backendCreationFixture({
      abortSignal: new AbortController().signal,
      resolveExecutionConnection: async () => readyExecutionConnection(),
      readPricing: async () => ({ revision: 0, overrides: [] }),
      snapshotClientCapabilities: () => coordinator.snapshotForSession('backend-creation-session'),
    }),
  );
  try {
    assert.equal(coordinator.snapshotForSession('backend-creation-session'), undefined);
  } finally {
    await backend.dispose();
    await coordinator.close();
  }
});

test('production backend preserves coordinator Client Capability semantics across load_tools and T1', async () => {
  const sessionId = 'backend-creation-session';
  const turnId = 'client-capability-turn';
  const runId = 'client-capability-run';
  const provider = await startProvider();
  const store = createSqliteRuntimeStore(':memory:');
  const trace: RunTraceEvent[] = [];
  const calls: Array<Extract<ClientCapabilityHostFrame, { kind: 'client.capability.call' }>> = [];
  const coordinator = new HostClientCapabilityCoordinator({
    activation: new RuntimePolicyActivationGate(),
    onModelToolsChanged: () => undefined,
  });
  let connection: ReturnType<HostClientCapabilityCoordinator['attachConnection']> | undefined;
  let backend: Awaited<ReturnType<typeof createHostAiSdkBackend>> | undefined;
  try {
    connection = coordinator.attachConnection(
      clientCapabilityConnectionIdentity('client-capability-provider'),
      {
        send: async (frame) => {
          if (frame.kind !== 'client.capability.call') return;
          calls.push(frame);
          queueMicrotask(() => {
            connection?.accept({
              kind: 'client.capability.accepted',
              invocationId: frame.invocationId,
            });
            connection?.accept({
              kind: 'client.capability.result',
              invocationId: frame.invocationId,
              result: {
                content: [{ type: 'text', text: CLIENT_CAPABILITY_RESULT_TEXT }],
              },
            });
          });
        },
      },
    );
    const context = {
      hostEpoch: 'client-capability-host-epoch',
      connectionId: 'client-capability-provider',
      surface: 'tui',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    } satisfies ConnectionContext;
    const registered = await coordinator.handlers['client.capability.replace'](
      {
        registrationId: 'client-capability-registration',
        offers: [
          {
            offerId: 'hosted-browser',
            version: '0',
            affinity: 'session',
            hostPathAccess: 'cwd',
            label: 'Hosted Browser',
            tools: [
              {
                serverId: 'hosted_browser',
                name: 'navigate',
                description: 'Navigate the hosted browser.',
                inputSchema: {
                  type: 'object',
                  properties: { url: { type: 'string' } },
                  required: ['url'],
                  additionalProperties: false,
                },
              },
            ],
          },
        ],
      },
      context,
    );
    assert.equal(registered.ok, true);
    assert.deepEqual(await coordinator.bindSession(sessionId, context.connectionId), { ok: true });
    const snapshot = coordinator.snapshotForSession(sessionId);
    assert.ok(snapshot);
    if (!snapshot) return;
    const group = snapshot.groups[0];
    const tool = snapshot.tools[0];
    snapshot.release();
    assert.ok(group);
    assert.ok(tool);
    if (!group || !tool) throw new Error('Client Capability snapshot was empty');
    provider.configureClientCapability({ groupId: group.id, toolName: tool.name });

    const head: RuntimeEvent = {
      id: 'client-capability-head',
      invocationId: runId,
      runId,
      sessionId,
      turnId,
      ts: 1,
      partial: false,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'Use the connected Client Capability.' },
    };
    await store.appendRuntimeEvent(sessionId, runId, head);
    backend = await createHostAiSdkBackend(
      backendCreationFixture({
        abortSignal: new AbortController().signal,
        resolveExecutionConnection: async () =>
          readyExecutionConnection(provider.baseUrl, {
            requestHeaders: { 'X-Maka-Test': 'tui-shared-setting' },
            requestBodyOverlay: { provider: { only: ['deepseek'] } },
          }),
        readPricing: async () => ({ revision: 0, overrides: [] }),
        snapshotClientCapabilities: () => coordinator.snapshotForSession(sessionId),
        executionBoundary: createBypassExecutionBoundary(0),
        loadTurnRuntimeEvents: () => store.readImmutableRuntimeEvents(sessionId, runId),
        recordRunTrace: (event) => {
          trace.push(event);
        },
        runtimeCommitSink: store,
      }),
    );
    const events = [];
    for await (const event of backend.send({
      invocationId: runId,
      runId,
      turnId,
      headAnchorRuntimeEvent: head,
      text: 'Use the connected Client Capability.',
      context: [],
      runtimeContext: [head],
    })) {
      events.push(event);
    }

    assert.equal(
      events.find((event) => event.type === 'complete')?.stopReason,
      'end_turn',
      JSON.stringify({ events, requests: provider.requests, trace }),
    );
    assert.equal(calls.length, 1);
    assert.ok(provider.requests.length > 0);
    for (const request of provider.requests) {
      assert.equal(request.customHeader, 'tui-shared-setting');
      assert.deepEqual(request.body.provider, { only: ['deepseek'] });
    }
    assert.deepEqual(calls[0]?.arguments, {
      url: 'https://example.test/client-capability',
    });
    assert.ok(
      trace.some(
        (event) =>
          event.type === 'tool_started' &&
          event.data?.toolName === tool.name &&
          event.data?.categoryHint === 'client_capability',
      ),
    );
    const runtimeEvents = await store.readImmutableRuntimeEvents(sessionId, runId);
    assert.ok(
      runtimeEvents.some(
        (event) =>
          event.actions?.toolDispatch?.toolName === tool.name &&
          event.actions?.toolDispatch?.recoveryMode === 'outcome_unknown',
      ),
    );
    assert.ok(
      runtimeEvents.some(
        (event) =>
          event.content?.kind === 'function_response' &&
          event.content.name === tool.name &&
          JSON.stringify(event.content.result).includes(CLIENT_CAPABILITY_RESULT_TEXT),
      ),
    );
    const providerToolSets = provider.requests
      .filter((request) => request.body.stream === true)
      .map((request) => toolNames(request.body));
    assert.equal(providerToolSets.length, 3);
    assert.ok(providerToolSets[0]?.includes('load_tools'));
    assert.equal(providerToolSets[0]?.includes(tool.name), false);
    assert.ok(providerToolSets[1]?.includes('load_tools'));
    assert.ok(providerToolSets[1]?.includes(tool.name));
    assert.ok(providerToolSets[2]?.includes(tool.name));
  } finally {
    await connection?.close();
    await backend?.dispose();
    await coordinator.close();
    store.close();
    await provider.close();
  }
});

test('hosted execution freezes the headless coding provider wire contract', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-hosted-profile-wire-'));
  const root = join(base, 'interactive');
  const provider = await startProvider();
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const residencies = new HostResidencyRegistry();
  const context: ConnectionContext = {
    hostEpoch: 'hosted-profile-wire-epoch',
    connectionId: 'hosted-profile-wire-client',
    surface: 'run',
    principal: 'runtime_host',
    acquireResidency: () => residencies.acquire('hosted-profile-wire-operation'),
  };
  let composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>> | undefined;
  try {
    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'profile-deepseek',
        name: 'Profile DeepSeek',
        providerType: 'deepseek',
        baseUrl: provider.baseUrl,
        enabled: true,
        enabledModelIds: ['deepseek-v4-flash'],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) return;
    const configured = await policy.credentialVault.set({
      locator: {
        scope: 'connection',
        connectionId: connection.connectionId,
        kind: 'api_key',
      },
      expected: null,
      secret: API_KEY,
    });
    assert.equal(configured.kind, 'committed');
    await publishConnectionModel(policy, connection.connectionId, 'deepseek-v4-flash');

    composition = await createExecutionRuntimeHostComposition(
      {
        owner,
        hostEpoch: context.hostEpoch,
        acquireResidency: (label) => residencies.acquire(label),
        retainUntilProcessExit: () => undefined,
        requestDrain: () => composition?.beginDrain(),
        waitForResidencies: () => residencies.waitForEmpty(),
        waitForResidenciesExcept: (label) => residencies.waitForEmptyExcept(label),
      },
      { bootstrapRuntimePolicy: false },
    );
    await composition.recover();
    const executionId = '00000000-0000-4000-8000-000000000777';
    const outcome = await composition.handlers['hosted.execution.start'](
      {
        executionId,
        session: {
          workspace: { kind: 'host_path', path: root },
          modelTarget: {
            kind: 'explicit',
            connectionSlug: 'profile-deepseek',
            model: 'deepseek-v4-flash',
          },
          permissionMode: 'bypass',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
          toolProfile: 'headless-coding-v1',
        },
        content: { text: 'Complete the benchmark task.' },
        maxSteps: 100_000,
      },
      context,
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.result.kind, 'settled');

    const request = provider.requests.find(
      (candidate) => candidate.url === '/v1/responses' && Array.isArray(candidate.body.tools),
    );
    assert.ok(request);
    const instructions = responsesDeveloperPrompt(request?.body);
    const tools = request?.body.tools;
    assert.equal(typeof instructions, 'string', JSON.stringify(request?.body));
    assert.ok(Array.isArray(tools));
    assert.equal(stableHash(instructions), HEADLESS_CODING_V1_PROMPT_HASH);
    assert.equal(stableHash(tools), HEADLESS_CODING_V1_TOOLS_HASH);
    assert.deepEqual(responsesToolNames(request?.body), [
      'ArchiveRead',
      'Bash',
      'Glob',
      'Grep',
      'Read',
      'apply_patch',
    ]);
    const bash = (tools as Array<Record<string, unknown>>).find((tool) => tool.name === 'Bash');
    assert.ok(bash);
    assert.doesNotMatch(JSON.stringify(bash), /run_in_background|pty/u);

    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    assert.equal(
      (await stores.sessionStore.readHeaderSnapshot(executionId)).toolProfile,
      'headless-coding-v1',
    );
    const secondTurnId = '00000000-0000-4000-8000-000000000778';
    const secondStarted = await startTurn(
      composition,
      executionId,
      secondTurnId,
      'Continue the benchmark task.',
      context,
    );
    const secondTerminal = await waitForTerminal(
      composition,
      executionId,
      secondTurnId,
      secondStarted,
      context,
    );
    assert.equal(secondTerminal.status, 'completed');
    const profiledRequests = provider.requests.filter(
      (candidate) => candidate.url === '/v1/responses' && Array.isArray(candidate.body.tools),
    );
    assert.equal(profiledRequests.length, 2);
    for (const profiled of profiledRequests) {
      assert.equal(
        stableHash(responsesDeveloperPrompt(profiled.body)),
        HEADLESS_CODING_V1_PROMPT_HASH,
      );
      assert.equal(stableHash(profiled.body.tools), HEADLESS_CODING_V1_TOOLS_HASH);
    }
  } finally {
    try {
      await composition?.close();
    } finally {
      try {
        await owner.close();
      } finally {
        await provider.close();
        await rm(base, { recursive: true, force: true });
      }
    }
  }
});

test('production Host executes a canonical ai-sdk Session against a real provider wire', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-real-model-'));
  const root = join(base, 'interactive');
  const home = join(base, 'home');
  const provider = await startProvider();
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;

  const connectionContext: ConnectionContext = {
    hostEpoch: 'real-model-test-epoch',
    connectionId: 'real-model-test-client',
    surface: 'tui',
    principal: 'local_os_user',
    acquireResidency: () => ({ release() {} }),
  };
  let drainRequests = 0;
  let composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>> | undefined;
  try {
    await mkdir(home, { recursive: true });
    await mkdir(join(root, '.agents', 'skills', 'hosted-skill'), {
      recursive: true,
    });
    await writeFile(
      join(root, '.agents', 'skills', 'hosted-skill', 'SKILL.md'),
      [
        '---',
        'name: Hosted Skill Sentinel',
        'description: HOSTED_SKILL_DESCRIPTION_SENTINEL',
        '---',
        '',
        'HOSTED_SKILL_BODY_MUST_STAY_LAZY',
        '',
      ].join('\n'),
    );
    await writeFile(join(root, 'AGENTS.md'), 'HOSTED_WORKSPACE_SENTINEL\n');

    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'hosted-real-provider',
        name: 'Hosted real provider',
        providerType: 'moonshot',
        baseUrl: provider.baseUrl,
        enabled: true,
        enabledModelIds: [MODEL_ID],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) return;
    const configured = await policy.credentialVault.set({
      locator: {
        scope: 'connection',
        connectionId: connection.connectionId,
        kind: 'api_key',
      },
      expected: null,
      secret: API_KEY,
    });
    assert.equal(configured.kind, 'committed');
    await publishConnectionModel(policy, connection.connectionId, MODEL_ID);
    let policySnapshot = await policy.runtimePolicy.getSnapshot();
    const personalized = await policy.runtimePolicy.mutate({
      expectedRevision: policySnapshot.revision,
      operation: {
        kind: 'set_personalization',
        value: {
          displayName: 'HOSTED_PERSONALIZATION_SENTINEL',
          assistantTone: '',
        },
      },
    });
    assert.equal(personalized.kind, 'committed');
    policySnapshot = await policy.runtimePolicy.getSnapshot();
    const memoryEnabled = await policy.runtimePolicy.mutate({
      expectedRevision: policySnapshot.revision,
      operation: {
        kind: 'set_memory',
        value: { enabled: true, agentReadEnabled: true },
      },
    });
    assert.equal(memoryEnabled.kind, 'committed');
    policySnapshot = await policy.runtimePolicy.getSnapshot();
    const webSearchEnabled = await policy.runtimePolicy.mutate({
      expectedRevision: policySnapshot.revision,
      operation: {
        kind: 'set_web_search',
        value: { enabled: true, defaultProvider: 'tavily' },
      },
    });
    assert.equal(webSearchEnabled.kind, 'committed');

    const execution = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await execution.sessionStore.create({
      cwd: root,
      backend: 'ai-sdk',
      llmConnectionSlug: 'hosted-real-provider',
      model: MODEL_ID,
      permissionMode: 'ask',
    });
    const taskLedger = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
    await taskLedger.create(session.id, [{ subject: 'HOSTED_TASK_LEDGER_SENTINEL' }]);

    composition = await createExecutionRuntimeHostComposition(
      {
        owner,
        hostEpoch: connectionContext.hostEpoch,
        acquireResidency: connectionContext.acquireResidency,
        retainUntilProcessExit: () => undefined,
        requestDrain: () => {
          drainRequests += 1;
        },
      },
      { skillHomeDirectory: home },
    );
    await composition.recover();
    const memoryState = await composition.handlers['memory.query'](
      { kind: 'state' },
      connectionContext,
    );
    assert.equal(memoryState.ok, true);
    if (!memoryState.ok) return;
    assert.equal(memoryState.result.kind, 'state');
    if (memoryState.result.kind !== 'state') return;
    const remembered = await composition.handlers['memory.mutate'](
      {
        kind: 'remember',
        expectedRevision: memoryState.result.revision,
        title: 'Hosted execution preference',
        content: 'HOSTED_MEMORY_SENTINEL',
        scope: { kind: 'workspace' },
      },
      connectionContext,
    );
    assert.equal(remembered.ok, true);
    if (!remembered.ok) return;
    assert.equal(remembered.result.kind, 'committed');

    const turnIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const turnId = randomUUID();
      turnIds.push(turnId);
      const started = await startTurn(
        composition,
        session.id,
        turnId,
        index === 0
          ? `Reply with the hosted execution result.${' HISTORY_PRESSURE'.repeat(160)}`
          : index === 1
            ? `/skill:hosted-skill Continue hosted execution turn ${index}.${' HISTORY_PRESSURE'.repeat(160)}`
            : `Continue hosted execution turn ${index}.${' HISTORY_PRESSURE'.repeat(160)}`,
        connectionContext,
      );
      const terminal = await waitForTerminal(
        composition,
        session.id,
        turnId,
        started,
        connectionContext,
      );
      assert.equal(terminal.status, 'completed');
    }
    const hostedCheckpoints = await loadHistoryCompactCheckpointsFromRunLedger(
      execution.agentRunStore,
      session.id,
    );
    const hostedMemoryBoundary = hostedCheckpoints.find(
      (checkpoint) => checkpoint.memoryExtractionBoundary,
    )?.memoryExtractionBoundary;
    assert.equal(hostedMemoryBoundary?.disposition, 'eligible');
    await waitForAutomaticMemoryRequestsToSettle(provider.requests);

    const mainRequests = provider.requests.filter((request) => request.body.stream === true);
    const compactRequests = provider.requests.filter(
      (request) =>
        request.body.stream !== true &&
        /context summarization assistant/.test(JSON.stringify(request.body)),
    );
    const memoryRequests = provider.requests.filter((request) =>
      /Perform the first stage of long-term-memory extraction/.test(JSON.stringify(request.body)),
    );
    assert.equal(mainRequests.length, 5);
    assert.ok(compactRequests.length >= 1);
    assert.ok(memoryRequests.length >= 1);
    assert.ok(memoryRequests.every((memoryRequest) => toolNames(memoryRequest.body).length === 0));
    assert.ok(
      memoryRequests.every(
        (memoryRequest) =>
          !JSON.stringify(memoryRequest.body).includes('HOSTED_WORKSPACE_SENTINEL'),
      ),
    );
    const request = mainRequests[0];
    assert.equal(request?.authorization, `Bearer ${API_KEY}`);
    assert.equal(request?.url, '/v1/chat/completions');
    assert.equal(request?.body.model, MODEL_ID);
    const requestText = JSON.stringify(request?.body);
    assert.match(requestText, /HOSTED_SKILL_DESCRIPTION_SENTINEL/);
    assert.doesNotMatch(requestText, /HOSTED_SKILL_BODY_MUST_STAY_LAZY/);
    assert.match(requestText, /HOSTED_WORKSPACE_SENTINEL/);
    assert.match(requestText, /HOSTED_TASK_LEDGER_SENTINEL/);
    assert.match(requestText, /HOSTED_PERSONALIZATION_SENTINEL/);
    assert.match(requestText, /HOSTED_MEMORY_SENTINEL/);
    assert.match(JSON.stringify(mainRequests[1]?.body), /HOSTED_SKILL_BODY_MUST_STAY_LAZY/);
    assert.deepEqual(toolNames(request?.body), [
      'ArchiveRead',
      'AskUserQuestion',
      'Bash',
      'Edit',
      'ExploreAgent',
      'FormatJson',
      'Glob',
      'GoalClear',
      'GoalPause',
      'GoalResume',
      'GoalSet',
      'GoalStatus',
      'Grep',
      'MakaSettingsGet',
      'MakaSettingsUpdate',
      'Read',
      'ScheduledTask',
      'Skill',
      'SkillSearch',
      'StopBackgroundTask',
      'WebFetch',
      'WebSearch',
      'Write',
      'WriteStdin',
      'load_tools',
      'memory_extract',
      'memory_remember',
      'request_sandbox_boundary',
      'task_create',
      'task_get',
      'task_list',
      'task_update',
    ]);
    assert.match(JSON.stringify(compactRequests[0]?.body), /context summarization assistant/);

    const messages = await execution.sessionStore.readMessagesSnapshot(session.id);
    const assistant = messages.find(
      (message) => message.type === 'assistant' && message.turnId === turnIds[0],
    );
    assert.equal(assistant?.type, 'assistant');
    if (assistant?.type === 'assistant') assert.equal(assistant.text, RESPONSE_TEXT);
    const skillMessage = messages.find(
      (message) => message.type === 'user' && message.turnId === turnIds[1],
    );
    assert.equal(skillMessage?.type, 'user');
    if (skillMessage?.type === 'user') {
      assert.match(skillMessage.text, /HOSTED_SKILL_BODY_MUST_STAY_LAZY/);
      assert.match(skillMessage.displayText ?? '', /^\/skill:hosted-skill /);
      assert.deepEqual(skillMessage.inlineReferences, [
        {
          kind: 'skill',
          value: '/skill:hosted-skill',
          label: 'Hosted Skill Sentinel',
          start: 0,
        },
      ]);
    }

    const usage = await waitForUsage(
      composition,
      connectionContext,
      'hosted-real-provider',
      'main',
    );
    assert.equal(usage.providerId, 'moonshot');
    assert.equal(usage.modelId, MODEL_ID);
    assert.equal(usage.inputTokens, 11);
    assert.equal(usage.outputTokens, 5);
    assert.equal(usage.status, 'success');

    const compactUsage = await waitForUsage(
      composition,
      connectionContext,
      'hosted-real-provider',
      'history_compact',
    );
    assert.equal(compactUsage.inputTokens, 7);
    assert.equal(compactUsage.outputTokens, 3);
    const capturedRequestCount = mainRequests.length + compactRequests.length;
    const evidence = await waitForProviderEvidence(execution, session.id, capturedRequestCount);
    assert.equal(evidence.captures.length, capturedRequestCount);
    assert.equal(evidence.attempts.length, capturedRequestCount);

    const artifacts = await openInteractiveArtifactStoreForWrite(owner.lease);
    const artifactPage = await artifacts.listPage(session.id, { offset: 0, limit: 100 });
    const captureArtifacts = artifactPage.records.filter(
      (artifact) => artifact.source === 'provider_request_capture',
    );
    assert.equal(captureArtifacts.length, capturedRequestCount);
    let summaryCaptureFound = false;
    for (const artifact of captureArtifacts) {
      const read = await artifacts.readTextInSession(session.id, artifact.id);
      if (read.ok && /context summarization assistant/.test(read.text)) {
        summaryCaptureFound = true;
        break;
      }
    }
    assert.equal(summaryCaptureFound, true);

    const requestsBeforeArtifactFailure = provider.requests.length;
    artifacts.close();
    const failedTurnId = randomUUID();
    const failedStart = await startTurn(
      composition,
      session.id,
      failedTurnId,
      'This request must fail before provider dispatch.',
      connectionContext,
    );
    const failedTerminal = await waitForTerminal(
      composition,
      session.id,
      failedTurnId,
      failedStart,
      connectionContext,
    );
    assert.equal(failedTerminal.status, 'failed');
    assert.equal(provider.requests.length, requestsBeforeArtifactFailure);
    assert.equal(drainRequests, 1);
  } finally {
    try {
      await composition?.close();
    } finally {
      try {
        await owner.close();
      } finally {
        await provider.close();
        await rm(base, { recursive: true, force: true });
      }
    }
  }
});

test('production Host executes and durably supervises an Agent Graph over a real provider wire', {
  timeout: 20_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-agent-graph-'));
  const root = join(base, 'interactive');
  const project = join(base, 'project');
  const provider = await startProvider();
  provider.configureAgentGraphFlow();
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  let liveResidencies = 0;
  const context: ConnectionContext = {
    hostEpoch: 'agent-graph-test-epoch',
    connectionId: 'agent-graph-test-client',
    surface: 'tui',
    principal: 'local_os_user',
    acquireResidency: () => {
      liveResidencies += 1;
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          liveResidencies -= 1;
        },
      };
    },
  };
  let composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>> | undefined;
  let graphStore: ReturnType<typeof createAgentGraphControlStore> | undefined;
  try {
    await mkdir(project);
    await writeFile(join(project, 'README.md'), '# Hosted Graph fixture\n');
    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'hosted-graph-provider',
        name: 'Hosted Graph provider',
        providerType: 'moonshot',
        baseUrl: provider.baseUrl,
        enabled: true,
        enabledModelIds: [MODEL_ID],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) return;
    assert.equal(
      (
        await policy.credentialVault.set({
          locator: {
            scope: 'connection',
            connectionId: connection.connectionId,
            kind: 'api_key',
          },
          expected: null,
          secret: API_KEY,
        })
      ).kind,
      'committed',
    );
    await publishConnectionModel(policy, connection.connectionId, MODEL_ID, 32_768);

    const execution = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await execution.sessionStore.create({
      cwd: project,
      backend: 'ai-sdk',
      llmConnectionSlug: 'hosted-graph-provider',
      model: MODEL_ID,
      permissionMode: 'bypass',
    });
    composition = await createExecutionRuntimeHostComposition({
      owner,
      hostEpoch: context.hostEpoch,
      acquireResidency: context.acquireResidency,
      retainUntilProcessExit: () => undefined,
      requestDrain: () => assert.fail('The healthy Agent Graph must not drain the Host'),
    });
    await composition.recover();

    const turnId = 'hosted-agent-graph-turn';
    const started = await composition.handlers['turn.start'](
      {
        sessionId: session.id,
        turnId,
        content: { text: 'Coordinate this task through a hosted Agent Graph.' },
        turnOrchestration: { mode: 'graph', source: 'host_api' },
      },
      context,
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(started.result.kind, 'started');
    if (started.result.kind !== 'started') return;
    let initialTerminal: TurnSnapshot;
    try {
      initialTerminal = await waitForTerminal(
        composition,
        session.id,
        turnId,
        started.result.turn,
        context,
      );
    } catch (error) {
      throw new Error(
        `Hosted Graph root did not settle: ${JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          requests: providerRequestTrace(provider.requests),
        })}`,
      );
    }
    assert.equal(initialTerminal.status, 'completed');

    graphStore = createAgentGraphControlStore(root);
    const graphId = agentGraphIdForRootSession(session.id);
    let updates = await graphStore.listAgentGraphScheduleUpdates(graphId);
    let runs = await execution.agentRunStore.listSessionRuns(session.id);
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const wakeRuns = runs.filter((run) => run.agentGraphWakeAttemptId !== undefined);
      if (
        updates.at(-1)?.finish &&
        wakeRuns.length > 0 &&
        wakeRuns.every((run) => ['completed', 'failed', 'cancelled'].includes(run.status)) &&
        liveResidencies === 0
      ) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      updates = await graphStore.listAgentGraphScheduleUpdates(graphId);
      runs = await execution.agentRunStore.listSessionRuns(session.id);
    }

    const finish = updates.at(-1)?.finish;
    assert.ok(
      finish,
      JSON.stringify({
        updateCount: updates.length,
        lastUpdate: updates.at(-1),
        runs: runs.map((run) => ({
          runId: run.runId,
          status: run.status,
          wakeAttemptId: run.agentGraphWakeAttemptId,
        })),
        requests: providerRequestTrace(provider.requests),
      }),
    );
    assert.equal(finish?.resultIds.length, 1);
    const rootRun = runs.find((run) => run.runId === initialTerminal.runId);
    assert.equal(rootRun?.runComposition?.composerId, 'maka.interactive');
    assert.equal(rootRun?.runComposition?.contextWindow, 32_768);
    assert.match(rootRun?.runComposition?.baseSystemPromptHash ?? '', /^sha256:[a-f0-9]{64}$/u);
    assert.ok(rootRun?.runComposition?.toolNames.includes('view_agent_graph'));
    const wakeRuns = runs.filter((run) => run.agentGraphWakeAttemptId !== undefined);
    assert.ok(wakeRuns.length > 0);
    assert.ok(wakeRuns.every((run) => run.status === 'completed'));
    assert.ok(wakeRuns.every((run) => run.orchestrationMode === 'graph'));
    assert.equal(liveResidencies, 0);

    const sessions = await execution.sessionStore.listForRecovery();
    const child = sessions.find(
      (candidate) => candidate.subagentParent?.graph?.graphId === graphId,
    );
    assert.ok(child);
    assert.equal(child?.subagentRuntime?.profile, 'local_read');
    assert.equal(child?.subagentParent?.parentSessionId, session.id);
    const childRuns = child ? await execution.agentRunStore.listSessionRuns(child.id) : [];
    assert.equal(childRuns.length, 1);
    assert.equal(childRuns[0]?.status, 'completed');

    const graphRequests = provider.requests.filter(
      (request) =>
        request.body.stream === true && toolNames(request.body).includes('view_agent_graph'),
    );
    assert.ok(graphRequests.length >= 4);
    for (const request of graphRequests) {
      assert.ok(toolNames(request.body).includes('update_agent_graph'));
      assert.ok(toolNames(request.body).includes('yield_agent_graph'));
      assert.ok(toolNames(request.body).includes('agent_output'));
    }
    assert.ok(
      provider.requests.some(
        (request) =>
          request.body.stream === true &&
          JSON.stringify(request.body).includes('child_session_run'),
      ),
    );
  } finally {
    graphStore?.close();
    try {
      await composition?.close();
    } finally {
      try {
        await owner.close();
      } finally {
        await provider.close();
        await rm(base, { recursive: true, force: true });
      }
    }
  }
});

test('production Host executes a durable runnable child with an exact tool ceiling', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-child-agent-'));
  const root = join(base, 'interactive');
  const project = join(base, 'project');
  const provider = await startProvider();
  provider.configureChildAgentFlow();
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const context: ConnectionContext = {
    hostEpoch: 'child-agent-test-epoch',
    connectionId: 'child-agent-test-client',
    surface: 'tui',
    principal: 'local_os_user',
    acquireResidency: () => ({ release() {} }),
  };
  let composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>> | undefined;
  try {
    await mkdir(project);
    await writeFile(join(project, 'README.md'), '# Hosted child fixture\n');
    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'hosted-child-provider',
        name: 'Hosted child provider',
        providerType: 'moonshot',
        baseUrl: provider.baseUrl,
        enabled: true,
        enabledModelIds: [MODEL_ID],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) return;
    assert.equal(
      (
        await policy.credentialVault.set({
          locator: {
            scope: 'connection',
            connectionId: connection.connectionId,
            kind: 'api_key',
          },
          expected: null,
          secret: API_KEY,
        })
      ).kind,
      'committed',
    );
    await publishConnectionModel(policy, connection.connectionId, MODEL_ID, 32_768);
    const policySnapshot = await policy.runtimePolicy.getSnapshot();
    const webSearchEnabled = await policy.runtimePolicy.mutate({
      expectedRevision: policySnapshot.revision,
      operation: {
        kind: 'set_web_search',
        value: { enabled: true, defaultProvider: 'tavily' },
      },
    });
    assert.equal(webSearchEnabled.kind, 'committed');

    const execution = await openInteractiveExecutionStoresForWrite(owner.lease);
    const parent = await execution.sessionStore.create({
      cwd: project,
      backend: 'ai-sdk',
      llmConnectionSlug: 'hosted-child-provider',
      model: MODEL_ID,
      permissionMode: 'bypass',
    });
    composition = await createExecutionRuntimeHostComposition({
      owner,
      hostEpoch: context.hostEpoch,
      acquireResidency: context.acquireResidency,
      retainUntilProcessExit: () => undefined,
      requestDrain: () => undefined,
    });
    await composition.recover();

    const turnId = 'hosted-child-parent-turn';
    const terminal = await waitForTerminal(
      composition,
      parent.id,
      turnId,
      await startTurn(
        composition,
        parent.id,
        turnId,
        'Delegate this bounded read-only task.',
        context,
      ),
      context,
    );
    const parentRun = await execution.agentRunStore.readRun(parent.id, terminal.runId);
    const parentRunEvents = await execution.agentRunStore.readEvents(parent.id, terminal.runId);
    assert.equal(
      terminal.status,
      'completed',
      JSON.stringify({
        terminal,
        parentRun,
        parentRunEvents,
        requests: provider.requests.map((request) => ({
          stream: request.body.stream,
          tools: toolNames(request.body),
        })),
      }),
    );

    const requests = provider.requests.filter((request) => request.body.stream === true);
    assert.equal(requests.length, 7);
    assert.ok(toolNames(requests[0]?.body).includes('load_tools'));
    assert.equal(toolNames(requests[0]?.body).includes('agent_spawn'), false);
    assert.ok(toolNames(requests[1]?.body).includes('agent_spawn'));
    assert.deepEqual(toolParameterEnum(requests[1]?.body, 'agent_spawn', 'profile'), [
      'local_read',
      'web_research',
      'implementation',
    ]);
    // A child now carries the archive decoder alongside its allowlist (#2026).
    // Its own placeholders name `ArchiveRead`, so the ceiling that governs
    // agent-permission tools cannot be the thing that decides whether the child
    // can read back a result the runtime itself pruned.
    assert.deepEqual(toolNames(requests[2]?.body), ['ArchiveRead', 'Glob', 'Grep', 'Read']);
    assert.ok(toolNames(requests[3]?.body).includes('agent_spawn'));
    assert.deepEqual(toolNames(requests[4]?.body), ['ArchiveRead', 'WebSearch']);
    assert.deepEqual(toolNames(requests[5]?.body), ['ArchiveRead', 'WebSearch']);
    assert.ok(toolNames(requests[6]?.body).includes('agent_spawn'));

    const sessions = await execution.sessionStore.listForRecovery();
    const child = sessions.find((session) => session.subagentRuntime?.profile === 'local_read');
    const webChild = sessions.find(
      (session) => session.subagentRuntime?.profile === 'web_research',
    );
    assert.ok(child);
    assert.ok(webChild);
    assert.equal(child?.subagentRuntime?.profile, 'local_read');
    assert.equal(child?.subagentParent?.parentSessionId, parent.id);
    if (!child) return;
    assert.equal(child.subagentWorkspace, undefined);
    assert.equal(child.cwd, project);
    const childRuns = await execution.agentRunStore.listSessionRuns(child.id);
    assert.equal(childRuns.length, 1);
    assert.equal(childRuns[0]?.status, 'completed');
    assert.equal(childRuns[0]?.parentRunId, undefined);
    const childMessages = await execution.sessionStore.readMessagesSnapshot(child.id);
    assert.equal(
      childMessages.find((message) => message.type === 'assistant')?.text,
      CHILD_AGENT_RESULT_TEXT,
    );
    if (!webChild) return;
    const webChildRuns = await execution.agentRunStore.listSessionRuns(webChild.id);
    assert.equal(webChildRuns.length, 1);
    assert.equal(webChildRuns[0]?.status, 'completed');
    const webChildMessages = await execution.sessionStore.readMessagesSnapshot(webChild.id);
    assert.equal(
      webChildMessages.find((message) => message.type === 'assistant')?.text,
      WEB_RESEARCH_CHILD_RESULT_TEXT,
    );
    const webChildEvents = await execution.runtimeEventStore.readRuntimeEvents(
      webChild.id,
      webChildRuns[0]!.runId,
    );
    const searchResult = webChildEvents.find(
      (event) => event.content?.kind === 'function_response' && event.content.name === 'WebSearch',
    );
    assert.ok(searchResult?.content?.kind === 'function_response');
    assert.deepEqual(decodeCanonicalToolResultContent(searchResult.content.result), {
      kind: 'web_search_error',
      ok: false,
      provider: 'tavily',
      query: 'latest hosted web result',
      reason: 'not_configured',
      message: 'Configure a Tavily API key before using web search.',
    });
    const artifacts = await openInteractiveArtifactStoreForWrite(owner.lease);
    const childArtifacts = await artifacts.listTurnArtifacts(child.id, childRuns[0]!.turnId);
    assert.equal(childArtifacts.length, 1);
    assert.equal(childArtifacts[0]?.source, 'provider_request_capture');
    const parentRuntimeEvents = await execution.runtimeEventStore.readRuntimeEvents(
      parent.id,
      terminal.runId,
    );
    const spawnResult = parentRuntimeEvents.find(
      (event) =>
        event.content?.kind === 'function_response' && event.content.name === 'agent_spawn',
    );
    assert.ok(spawnResult?.content?.kind === 'function_response');
    const typedSpawnResult = decodeCanonicalToolResultContent(spawnResult.content.result);
    assert.equal(typedSpawnResult.kind, 'subagent');
    assert.deepEqual(
      (typedSpawnResult as { artifactIds?: readonly string[] }).artifactIds,
      childArtifacts.map((artifact) => artifact.id),
    );
  } finally {
    try {
      await composition?.close();
    } finally {
      try {
        await owner.close();
      } finally {
        await provider.close();
        await rm(base, { recursive: true, force: true });
      }
    }
  }
});

test('production Host publishes and retires an implementation child patch', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-child-agent-'));
  const root = join(base, 'interactive');
  const project = join(base, 'project');
  const provider = await startProvider();
  provider.configureImplementationChildAgentFlow();
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const context: ConnectionContext = {
    hostEpoch: 'child-agent-test-epoch',
    connectionId: 'child-agent-test-client',
    surface: 'tui',
    principal: 'local_os_user',
    acquireResidency: () => ({ release() {} }),
  };
  let composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>> | undefined;
  let restartedOwner: Awaited<ReturnType<typeof tryAcquireInteractiveRootOwner>>;
  let initialOwnerClosed = false;
  try {
    await mkdir(project);
    await writeFile(join(project, 'README.md'), '# Hosted child fixture\n');
    await writeFile(
      join(project, 'pty-child.mjs'),
      [
        "process.stdin.setEncoding('utf8');",
        "process.stdout.write('READY\\n');",
        "process.stdin.once('data', (data) => {",
        '  process.stdout.write(`CHILD_PTY_OK:${data.trim()}\\n`);',
        '  setTimeout(() => {}, 30_000);',
        '});',
        '',
      ].join('\n'),
    );
    await git(project, 'init', '--initial-branch=main');
    await git(project, 'add', 'README.md', 'pty-child.mjs');
    await git(
      project,
      '-c',
      'user.name=Maka Test',
      '-c',
      'user.email=test@maka.invalid',
      'commit',
      '-m',
      'fixture',
    );
    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'hosted-child-provider',
        name: 'Hosted child provider',
        providerType: 'moonshot',
        baseUrl: provider.baseUrl,
        enabled: true,
        enabledModelIds: [MODEL_ID],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) return;
    assert.equal(
      (
        await policy.credentialVault.set({
          locator: {
            scope: 'connection',
            connectionId: connection.connectionId,
            kind: 'api_key',
          },
          expected: null,
          secret: API_KEY,
        })
      ).kind,
      'committed',
    );
    await publishConnectionModel(policy, connection.connectionId, MODEL_ID, 32_768);

    const execution = await openInteractiveExecutionStoresForWrite(owner.lease);
    const parent = await execution.sessionStore.create({
      cwd: project,
      backend: 'ai-sdk',
      llmConnectionSlug: 'hosted-child-provider',
      model: MODEL_ID,
      permissionMode: 'bypass',
    });
    composition = await createExecutionRuntimeHostComposition({
      owner,
      hostEpoch: context.hostEpoch,
      acquireResidency: context.acquireResidency,
      retainUntilProcessExit: () => undefined,
      requestDrain: () => undefined,
    });
    await composition.recover();

    const turnId = 'hosted-child-parent-turn';
    const terminal = await waitForTerminal(
      composition,
      parent.id,
      turnId,
      await startTurn(
        composition,
        parent.id,
        turnId,
        'Delegate this bounded implementation task.',
        context,
      ),
      context,
    );
    const parentRun = await execution.agentRunStore.readRun(parent.id, terminal.runId);
    const parentRunEvents = await execution.agentRunStore.readEvents(parent.id, terminal.runId);
    assert.equal(
      terminal.status,
      'completed',
      JSON.stringify({
        terminal,
        parentRun,
        parentRunEvents,
        requests: provider.requests.map((request) => ({
          stream: request.body.stream,
          tools: toolNames(request.body),
        })),
      }),
    );

    const requests = provider.requests.filter((request) => request.body.stream === true);
    assert.ok(
      requests.length >= MIN_IMPLEMENTATION_CHILD_REQUESTS + 3 &&
        requests.length <= MAX_IMPLEMENTATION_CHILD_REQUESTS + 3,
      JSON.stringify(providerRequestTrace(requests)),
    );
    assert.ok(toolNames(requests[0]?.body).includes('load_tools'));
    assert.equal(toolNames(requests[0]?.body).includes('agent_spawn'), false);
    assert.ok(toolNames(requests[1]?.body).includes('agent_spawn'));
    assert.deepEqual(toolParameterEnum(requests[1]?.body, 'agent_spawn', 'profile'), [
      'local_read',
      'implementation',
    ]);
    const childToolNames = [
      'ArchiveRead',
      'Bash',
      'Edit',
      'Glob',
      'Grep',
      'Read',
      'StopBackgroundTask',
      'Write',
      'WriteStdin',
    ];
    const childRequests = requests.slice(2, -1);
    assert.ok(
      childRequests.length >= MIN_IMPLEMENTATION_CHILD_REQUESTS &&
        childRequests.length <= MAX_IMPLEMENTATION_CHILD_REQUESTS,
    );
    for (const request of childRequests) {
      assert.deepEqual(toolNames(request.body), childToolNames);
    }
    assert.ok(toolNames(requests.at(-1)?.body).includes('agent_spawn'));

    const sessions = await execution.sessionStore.listForRecovery();
    const child = sessions.find((session) => session.id !== parent.id);
    assert.ok(child);
    assert.equal(child?.subagentRuntime?.profile, 'implementation');
    assert.equal(child?.subagentParent?.parentSessionId, parent.id);
    if (!child) return;
    assert.ok(child.subagentWorkspace);
    assert.equal(child.cwd, child.subagentWorkspace?.worktreePath);
    assert.equal(await fileExists(join(project, 'implementation.txt')), false);
    assert.equal(await fileExists(join(child.cwd, 'implementation.txt')), true);
    const childRuns = await execution.agentRunStore.listSessionRuns(child.id);
    assert.equal(childRuns.length, 1);
    assert.equal(childRuns[0]?.status, 'completed');
    assert.equal(childRuns[0]?.parentRunId, undefined);
    const childMessages = await execution.sessionStore.readMessagesSnapshot(child.id);
    assert.equal(
      childMessages.find((message) => message.type === 'assistant')?.text,
      CHILD_AGENT_RESULT_TEXT,
    );
    const artifacts = await openInteractiveArtifactStoreForWrite(owner.lease);
    const childArtifacts = await artifacts.listTurnArtifacts(child.id, childRuns[0]!.turnId);
    assert.equal(childArtifacts.length, childRequests.length + 2);
    assert.equal(
      childArtifacts.filter((artifact) => artifact.source === 'provider_request_capture').length,
      childRequests.length,
    );
    assert.ok(
      childArtifacts.some(
        (artifact) => artifact.source === 'tool_result' && artifact.name === 'implementation.txt',
      ),
    );
    const patchArtifact = childArtifacts.find(
      (artifact) => artifact.source === 'subagent_writeback',
    );
    assert.ok(patchArtifact);
    if (!patchArtifact) return;
    const patch = await artifacts.readTextInSession(child.id, patchArtifact.id);
    assert.equal(patch.ok, true);
    if (patch.ok) {
      assert.match(patch.text, /diff --git a\/implementation\.txt b\/implementation\.txt/);
      assert.match(patch.text, /\+HOSTED_IMPLEMENTATION_PATCH_SENTINEL/);
    }
    const parentRuntimeEvents = await execution.runtimeEventStore.readRuntimeEvents(
      parent.id,
      terminal.runId,
    );
    const spawnResult = parentRuntimeEvents.find(
      (event) =>
        event.content?.kind === 'function_response' && event.content.name === 'agent_spawn',
    );
    assert.ok(spawnResult?.content?.kind === 'function_response');
    const typedSpawnResult = decodeCanonicalToolResultContent(spawnResult.content.result);
    assert.equal(typedSpawnResult.kind, 'subagent');
    assert.deepEqual(
      (typedSpawnResult as { artifactIds?: readonly string[] }).artifactIds,
      childArtifacts.map((artifact) => artifact.id),
    );
    const childSnapshot = await execution.sessionStore.readHeaderRecordSnapshot(child.id);
    const worktreePath = child.subagentWorkspace?.worktreePath;
    assert.ok(worktreePath);
    await artifacts.purgeSessionArtifacts(child.id);
    assert.deepEqual(await artifacts.listTurnArtifacts(child.id, childRuns[0]!.turnId), []);
    await composition.close();
    composition = undefined;
    if (worktreePath) assert.equal(await fileExists(worktreePath), true);
    await owner.close();
    initialOwnerClosed = true;
    restartedOwner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(restartedOwner);
    if (!restartedOwner) return;

    const restartContext = { ...context, hostEpoch: 'child-agent-test-restart-epoch' };
    composition = await createExecutionRuntimeHostComposition({
      owner: restartedOwner,
      hostEpoch: restartContext.hostEpoch,
      acquireResidency: restartContext.acquireResidency,
      retainUntilProcessExit: () => undefined,
      requestDrain: () => undefined,
    });
    await composition.recover();
    if (worktreePath) assert.equal(await fileExists(worktreePath), true);
    const recoveredArtifacts = await openInteractiveArtifactStoreForWrite(restartedOwner.lease);
    const recoveredPatch = (
      await recoveredArtifacts.listTurnArtifacts(child.id, childRuns[0]!.turnId)
    ).find((artifact) => artifact.source === 'subagent_writeback');
    assert.ok(recoveredPatch);
    if (recoveredPatch) {
      const recoveredPatchText = await recoveredArtifacts.readTextInSession(
        child.id,
        recoveredPatch.id,
      );
      assert.equal(recoveredPatchText.ok, true);
      if (recoveredPatchText.ok) {
        assert.match(recoveredPatchText.text, /\+HOSTED_IMPLEMENTATION_PATCH_SENTINEL/);
      }
    }
    const removed = await composition.handlers['session.remove'](
      { sessionId: child.id, expectedRevision: childSnapshot.revision },
      restartContext,
    );
    assert.equal(removed.ok, true);
    await composition.close();
    composition = undefined;
    if (worktreePath) assert.equal(await fileExists(worktreePath), false);
  } finally {
    try {
      await composition?.close();
    } finally {
      try {
        await restartedOwner?.close();
      } finally {
        try {
          if (!initialOwnerClosed) await owner.close();
        } finally {
          await provider.close();
          await rm(base, { recursive: true, force: true });
        }
      }
    }
  }
});

test('Host auxiliary models meter provider usage and abort physical requests', {
  timeout: 20_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-goal-evaluator-'));
  const provider = await startProvider();
  const capability = await resolveStorageRoot({
    path: join(base, 'interactive'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;

  const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
  const usage = await openInteractiveUsageStoresForWrite(owner.lease);
  const execution = await openInteractiveExecutionStoresForWrite(owner.lease);
  try {
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'goal-evaluator-provider',
        name: 'Goal evaluator provider',
        providerType: 'moonshot',
        baseUrl: provider.baseUrl,
        enabled: true,
        enabledModelIds: [MODEL_ID],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) return;
    const credential = await policy.credentialVault.set({
      locator: {
        scope: 'connection',
        connectionId: connection.connectionId,
        kind: 'api_key',
      },
      expected: null,
      secret: API_KEY,
    });
    assert.equal(credential.kind, 'committed');
    await publishConnectionModel(policy, connection.connectionId, MODEL_ID);
    const session = await execution.sessionStore.create({
      cwd: capability.canonicalPath,
      backend: 'ai-sdk',
      llmConnectionSlug: 'goal-evaluator-provider',
      model: MODEL_ID,
      permissionMode: 'ask',
    });
    const evaluatorInput = {
      runtimePolicy: policy,
      oauthCredentials: new HostOAuthExecutionAuthority(policy),
      claudeDeviceId: capability.rootId,
      usage,
      requestDrain: () => assert.fail('Goal evaluator telemetry must not drain the Host'),
      readSessionHeader: (sessionId: string) =>
        execution.sessionStore.readHeaderSnapshot(sessionId),
      newId: () => 'call-1',
    };
    const evaluator = createHostGoalEvaluator(evaluatorInput);
    const result = await evaluator.evaluate(
      'Judge the completed Goal.',
      session.id,
      new AbortController().signal,
    );
    assert.equal(result, SUMMARY_TEXT);
    const logs = await usage.telemetry.logs({ range: 'all' });
    const recorded = logs.rows.find((row) => row.callKind === 'goal_evaluation');
    assert.ok(recorded);
    assert.equal(recorded.callId, `goal_evaluation_${session.id}_call-1`);
    assert.equal(recorded.inputTokens, 7);
    assert.equal(recorded.outputTokens, 3);
    assert.equal(recorded.status, 'success');
    await evaluator.close();

    const sessionEffects = createHostSessionEffectModel({
      runtimePolicy: policy,
      oauthCredentials: new HostOAuthExecutionAuthority(policy),
      claudeDeviceId: capability.rootId,
      usage,
      requestDrain: () => assert.fail('Session effect telemetry must not drain the Host'),
      newId: () => 'effect-call-1',
    });
    assert.equal(
      await sessionEffects.generateTitle({
        sessionId: session.id,
        header: session,
        sourceText: 'Explain the Runtime Host ownership change',
        abortSignal: new AbortController().signal,
      }),
      '## Goal',
    );
    const recap = await sessionEffects.generateRecap({
      sessionId: session.id,
      effectId: 'recap-effect-1',
      header: session,
      events: [],
      abortSignal: new AbortController().signal,
    });
    assert.equal(recap.ok, true);
    if (!recap.ok) return;
    assert.equal(recap.modelId, MODEL_ID);
    assert.deepEqual(recap.messages, [{ role: 'user', content: SESSION_RECAP_INSTRUCTION }]);
    assert.equal(recap.raw, SUMMARY_TEXT);
    const effectLogs = await usage.telemetry.logs({ range: 'all' });
    assert.ok(
      effectLogs.rows.some(
        (row) =>
          row.callKind === 'session_title' &&
          row.callId === `session_title_${session.id}_effect-call-1`,
      ),
    );
    assert.ok(
      effectLogs.rows.some(
        (row) =>
          row.callKind === 'session_recap' &&
          row.callId === `session_recap_${session.id}_recap-effect-1`,
      ),
    );

    const dailyReview = createHostDailyReviewModel({
      runtimePolicy: policy,
      oauthCredentials: new HostOAuthExecutionAuthority(policy),
      claudeDeviceId: capability.rootId,
      usage,
      requestDrain: () => assert.fail('Daily Review telemetry must not drain the Host'),
      newId: () => 'daily-review-call-1',
    });
    assert.deepEqual(
      await dailyReview.generate({
        modelKey: `goal-evaluator-provider::${MODEL_ID}`,
        prompt: 'Generate one Daily Review.',
        abortSignal: new AbortController().signal,
      }),
      {
        ok: true,
        text: SUMMARY_TEXT,
        modelKey: `goal-evaluator-provider::${MODEL_ID}`,
      },
    );
    const dailyReviewLogs = await usage.telemetry.logs({ range: 'all' });
    const dailyReviewLog = dailyReviewLogs.rows.find((row) => row.callKind === 'daily_review');
    assert.ok(dailyReviewLog);
    assert.equal(dailyReviewLog.callId, 'daily_review_daily-review-call-1');
    assert.equal(dailyReviewLog.sessionId, undefined);

    const memoryModel = createHostMemoryExtractionModel({
      runtimePolicy: policy,
      oauthCredentials: new HostOAuthExecutionAuthority(policy),
      claudeDeviceId: capability.rootId,
      usage,
      requestDrain: () => assert.fail('Memory extraction telemetry must not drain the Host'),
      newId: () => 'memory-call-1',
    });
    const memorySnapshot = {
      trigger: 'remember' as const,
      sourceHeader: session,
      sourceSystemPrompt: 'SOURCE_SYSTEM_SENTINEL',
      sourceMessages: [
        { role: 'user' as const, content: 'SOURCE_USER_SENTINEL' },
        { role: 'assistant' as const, content: 'SOURCE_ASSISTANT_SENTINEL' },
      ],
      sourceTools: {
        memory_remember: {
          description: 'Remember durable information',
          inputSchema: z.object({}).strict(),
        },
      },
      sourceActiveTools: ['memory_remember'],
      sessionId: session.id,
      runId: 'memory-source-run',
      turnId: 'memory-source-turn',
      workspaceKey: capability.canonicalPath,
      toolCallId: 'memory-source-call',
    };
    const memoryRequestsBefore = provider.requests.length;
    const proposalResult = await memoryModel.generate({
      snapshot: memorySnapshot,
      prompt: 'PROPOSAL_PROMPT_SENTINEL',
      stage: 'proposal',
      abortSignal: new AbortController().signal,
    });
    assert.deepEqual(proposalResult, { ok: true, text: SUMMARY_TEXT });
    const canonicalizeResult = await memoryModel.generate({
      snapshot: memorySnapshot,
      prompt: 'CANONICALIZE_PROMPT_SENTINEL',
      stage: 'canonicalize',
      abortSignal: new AbortController().signal,
    });
    assert.deepEqual(canonicalizeResult, { ok: true, text: SUMMARY_TEXT });
    const [proposalRequest, canonicalizeRequest] = provider.requests.slice(memoryRequestsBefore);
    assert.ok(proposalRequest);
    assert.ok(canonicalizeRequest);
    assert.deepEqual(toolNames(proposalRequest.body), ['memory_remember']);
    assert.match(JSON.stringify(proposalRequest.body), /SOURCE_SYSTEM_SENTINEL/);
    assert.match(JSON.stringify(proposalRequest.body), /SOURCE_USER_SENTINEL/);
    assert.match(JSON.stringify(proposalRequest.body), /SOURCE_ASSISTANT_SENTINEL/);
    assert.match(JSON.stringify(proposalRequest.body), /PROPOSAL_PROMPT_SENTINEL/);
    assert.deepEqual(toolNames(canonicalizeRequest.body), []);
    assert.doesNotMatch(
      JSON.stringify(canonicalizeRequest.body),
      /SOURCE_(SYSTEM|USER|ASSISTANT)_SENTINEL/,
    );
    assert.match(JSON.stringify(canonicalizeRequest.body), /CANONICALIZE_PROMPT_SENTINEL/);

    assert.deepEqual(
      await sessionEffects.generateRecap({
        sessionId: session.id,
        effectId: 'recap-disabled-model',
        header: { ...session, model: 'disabled-model' },
        events: [],
        abortSignal: new AbortController().signal,
      }),
      {
        ok: false,
        errorClass: 'configuration',
      },
    );

    let preflightDrainRequests = 0;
    let preflightTransportCreations = 0;
    const failingPreflightEffects = createHostSessionEffectModel({
      runtimePolicy: policy,
      oauthCredentials: new HostOAuthExecutionAuthority(policy),
      claudeDeviceId: capability.rootId,
      usage: {
        pricing: {
          snapshot: async () => {
            throw new Error('injected pricing snapshot failure');
          },
        },
        telemetry: {
          recordLlmCall: async () =>
            assert.fail('preflight failure must not record provider usage'),
        },
      } as unknown as InteractiveUsageStoresWriter,
      requestDrain: () => {
        preflightDrainRequests += 1;
      },
      createFetchTransport: () => {
        preflightTransportCreations += 1;
        throw new Error('preflight failure must not create a provider transport');
      },
    });
    const preflightResult = await failingPreflightEffects.generateRecap({
      sessionId: session.id,
      effectId: 'recap-preflight-failure',
      header: session,
      events: [],
      abortSignal: new AbortController().signal,
    });
    assert.equal(preflightResult.ok, false);
    if (!preflightResult.ok) assert.equal(preflightResult.errorClass, 'persistence');
    assert.equal(preflightTransportCreations, 0);
    assert.equal(preflightDrainRequests, 1);

    let oauthDrainRequests = 0;
    let oauthProviderDispatches = 0;
    let oauthTransportCloses = 0;
    const oauthPersistenceEffects = createHostSessionEffectModel({
      runtimePolicy: {
        operations: {
          resolveExecutionConnection: async () => ({
            kind: 'ready',
            connection: {
              slug: 'oauth-persistence',
              providerType: 'openai-codex',
              enabledModelIds: [MODEL_ID],
              models: [
                {
                  id: MODEL_ID,
                  capabilities: { chat: true, functionCalling: true },
                  contextWindow: 8_192,
                  maxOutputTokens: 1_024,
                },
              ],
            },
            networkProxy: { enabled: false },
            secretMaterial: { connection: { secret: 'oauth-material' } },
          }),
        },
      } as unknown as RuntimePolicyStoresWriter,
      oauthCredentials: {
        bind: () => ({
          providerType: 'openai-codex',
          connectionSlug: 'oauth-persistence',
          resolve: async () => ({
            access_token: codexAccessToken('oauth-persistence-account'),
            refresh_token: 'oauth-persistence-refresh',
          }),
          forceRefresh: async () => {
            throw new OAuthExecutionCredentialError(
              'persistence_failed',
              'injected OAuth persistence failure',
            );
          },
        }),
      } as unknown as HostOAuthExecutionAuthority,
      claudeDeviceId: capability.rootId,
      usage,
      requestDrain: () => {
        oauthDrainRequests += 1;
      },
      createFetchTransport: () => ({
        fetch: async () => {
          oauthProviderDispatches += 1;
          return Response.json({ error: { message: 'expired credential' } }, { status: 401 });
        },
        close: async () => {
          oauthTransportCloses += 1;
        },
      }),
    });
    const oauthResult = await oauthPersistenceEffects.generateRecap({
      sessionId: session.id,
      effectId: 'recap-oauth-persistence-failure',
      header: session,
      events: [],
      abortSignal: new AbortController().signal,
    });
    assert.equal(oauthResult.ok, false);
    if (!oauthResult.ok) assert.equal(oauthResult.errorClass, 'persistence');
    assert.equal(oauthProviderDispatches, 1);
    assert.equal(oauthTransportCloses, 1);
    assert.equal(oauthDrainRequests, 1);

    let accountingDrains = 0;
    const accountingAbort = new AbortController();
    const accountingFailure = createHostSessionEffectModel({
      runtimePolicy: policy,
      oauthCredentials: new HostOAuthExecutionAuthority(policy),
      claudeDeviceId: capability.rootId,
      usage: {
        pricing: usage.pricing,
        telemetry: {
          recordLlmCall: async () => {
            accountingAbort.abort(new DOMException('Host drain raced accounting', 'AbortError'));
            throw new Error('injected accounting failure');
          },
        },
      } as unknown as InteractiveUsageStoresWriter,
      requestDrain: () => {
        accountingDrains += 1;
      },
    });
    assert.deepEqual(
      await accountingFailure.generateRecap({
        sessionId: session.id,
        effectId: 'recap-accounting-failure',
        header: session,
        events: [],
        abortSignal: accountingAbort.signal,
      }),
      {
        ok: false,
        modelId: MODEL_ID,
        messages: [{ role: 'user', content: SESSION_RECAP_INSTRUCTION }],
        errorClass: 'persistence',
      },
    );
    assert.equal(accountingDrains, 1);

    let effectProviderSignal: AbortSignal | undefined;
    let effectTransportCloses = 0;
    const effectProviderDispatched = deferred<void>();
    const stalledEffect = createHostSessionEffectModel({
      runtimePolicy: policy,
      oauthCredentials: new HostOAuthExecutionAuthority(policy),
      claudeDeviceId: capability.rootId,
      usage,
      requestDrain: () => assert.fail('A provider timeout must not drain the Host'),
      createFetchTransport: () => ({
        fetch: async (_request, init) => {
          effectProviderSignal = init?.signal ?? undefined;
          effectProviderDispatched.resolve();
          return new Promise<Response>(() => {});
        },
        close: async () => {
          effectTransportCloses += 1;
        },
      }),
    });
    // An explicit controller instead of AbortSignal.timeout(10): a wall-clock
    // timer races the preflight under load, and an abort that lands before
    // dispatch takes a different error path (#2132). Aborting after the
    // dispatch barrier settles pins the abort mid-flight; the TimeoutError
    // reason name keeps the errorClass classification.
    const effectTimeout = new AbortController();
    const timedEffect = stalledEffect.generateRecap({
      sessionId: session.id,
      effectId: 'recap-timeout',
      header: session,
      events: [],
      abortSignal: effectTimeout.signal,
    });
    await settleWithin(effectProviderDispatched.promise);
    effectTimeout.abort(new DOMException('provider stalled', 'TimeoutError'));
    const timedResult = await settleWithin(timedEffect);
    assert.equal(timedResult.ok, false);
    if (timedResult.ok) return;
    assert.equal(timedResult.errorClass, 'timeout');
    assert.equal(effectProviderSignal?.aborted, true);
    assert.equal(effectTransportCloses, 1);

    let providerSignal: AbortSignal | undefined;
    let transportCloses = 0;
    const providerDispatched = deferred<void>();
    const providerRelease = deferred<void>();
    const stalled = createHostGoalEvaluator({
      ...evaluatorInput,
      newId: () => 'call-2',
      createFetchTransport: () => ({
        fetch: async (_request, init) => {
          providerSignal = init?.signal ?? undefined;
          providerDispatched.resolve();
          await providerRelease.promise;
          throw providerSignal?.reason ?? new DOMException('Aborted', 'AbortError');
        },
        close: async () => {
          transportCloses += 1;
        },
      }),
    });
    const abort = new AbortController();
    const pending = stalled.evaluate('Wait forever.', session.id, abort.signal);
    try {
      await settleWithin(providerDispatched.promise);
      abort.abort(new DOMException('Goal lane invalidated', 'AbortError'));
      assert.equal(providerSignal?.aborted, true);
      let closeSettled = false;
      const closing = stalled.close().then(() => {
        closeSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(closeSettled, false);

      providerRelease.resolve();
      await assert.rejects(settleWithin(pending), (error: unknown) => {
        assert.notEqual(error instanceof Error ? error.message : undefined, SETTLE_TIMEOUT_MESSAGE);
        return true;
      });
      await closing;
      assert.equal(transportCloses, 1);
      const abortedLogs = await usage.telemetry.logs({ range: 'all' });
      assert.ok(
        abortedLogs.rows.some(
          (row) =>
            row.callId === `goal_evaluation_${session.id}_call-2` && row.status === 'aborted',
        ),
      );
    } finally {
      abort.abort(new DOMException('Goal evaluator test cleanup', 'AbortError'));
      providerRelease.resolve();
      await stalled.close();
      await pending.catch(() => undefined);
    }
  } finally {
    await usage.close();
    await execution.sessionStore.close?.();
    await owner.close();
    await provider.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('one turn shares one canonical Skill inventory across prompt and lazy tools', async () => {
  const policy = {
    revision: 7,
    policy: {
      ...createDefaultRuntimePolicy(),
      memory: { enabled: true, agentReadEnabled: true },
      workspaceInstructions: { enabled: false },
    },
  };
  let inventoryReads = 0;
  let inventory: readonly ScannedSkill[] = [skillFixture('old', 'OLD_DESCRIPTION', 'OLD_BODY')];
  const skills = {
    readCanonicalModelInventory: async () => {
      inventoryReads += 1;
      return { inventory };
    },
  } as unknown as HostSkillCatalogCoordinator;
  const memory = {
    readPromptProjection: async () => ({
      policy,
      bundleRevision: null,
      memoryRevision: null,
      body: 'MEMORY_BODY',
    }),
  } as unknown as HostMemoryCoordinator;
  const composition = createInteractiveRunComposer({
    runtimePolicy: policy,
    skills,
    memory,
    taskLedger: {} as TaskLedgerStore,
  });
  const firstContext = {
    sessionId: 'session',
    turnId: 'turn-1',
    cwd: '/workspace',
    workspaceRoot: '/workspace',
  } as const;

  const firstPrompt = (await composition.resolveSystemPrompt(firstContext)).text;
  assert.match(firstPrompt ?? '', /^You are Maka,/);
  assert.match(firstPrompt ?? '', /OLD_DESCRIPTION/);
  assert.match(firstPrompt ?? '', /MEMORY_BODY/);
  assert.equal(inventoryReads, 1);

  inventory = [skillFixture('new', 'NEW_DESCRIPTION', 'NEW_BODY')];
  const toolContext = {
    sessionId: firstContext.sessionId,
    turnId: firstContext.turnId,
    cwd: firstContext.cwd,
    toolCallId: 'tool-call',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  } satisfies MakaToolContext;
  const skillTool = composition.tools.find((tool) => tool.name === 'Skill') as
    | MakaTool<
        { name: string },
        { ok: true; skill: { instructions: string } } | { ok: false; reason: string }
      >
    | undefined;
  const searchTool = composition.tools.find((tool) => tool.name === 'SkillSearch') as
    | MakaTool<{ query: string }, { matches: Array<{ ref: string }> }>
    | undefined;
  assert.ok(skillTool);
  assert.ok(searchTool);
  const loaded = await skillTool.impl({ name: 'old' }, toolContext);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.skill.instructions, 'OLD_BODY');
  const searched = await searchTool.impl({ query: 'OLD_DESCRIPTION' }, toolContext);
  assert.deepEqual(
    searched.matches.map((match) => match.ref),
    ['project:agents:old'],
  );
  assert.equal(inventoryReads, 1);

  const nextPrompt = (await composition.resolveSystemPrompt({ ...firstContext, turnId: 'turn-2' }))
    .text;
  assert.match(nextPrompt ?? '', /NEW_DESCRIPTION/);
  assert.doesNotMatch(nextPrompt ?? '', /OLD_DESCRIPTION/);
  assert.equal(inventoryReads, 2);
});

test('one composer freezes Runtime Policy while each Run freezes its remaining prompt sources', async () => {
  let policyRevision = 3;
  let memoryRevision = 'memory-3';
  let memoryBody = 'MEMORY_THREE';
  let skillRevision = 'skills-3';
  let skillDescription = 'SKILL_THREE';
  const composition = createInteractiveRunComposer({
    runtimePolicy: { revision: policyRevision, policy: createDefaultRuntimePolicy() },
    skills: {
      readCanonicalModelInventory: async () => ({
        revision: skillRevision,
        inventory: [skillFixture('fixture', skillDescription, 'BODY')],
      }),
    } as unknown as HostSkillCatalogCoordinator,
    memory: {
      readPromptProjection: async () => ({
        bundleRevision: `bundle-${memoryRevision}`,
        memoryRevision,
        body: memoryBody,
      }),
    } as unknown as HostMemoryCoordinator,
    taskLedger: {} as TaskLedgerStore,
  });
  const context = {
    sessionId: 'session',
    turnId: 'turn-1',
    cwd: '/workspace',
    workspaceRoot: '/workspace',
  } as const;

  const first = await composition.resolveSystemPrompt(context);
  policyRevision = 4;
  memoryRevision = 'memory-4';
  memoryBody = 'MEMORY_FOUR';
  skillRevision = 'skills-4';
  skillDescription = 'SKILL_FOUR';
  const repeated = await composition.resolveSystemPrompt(context);
  const next = await composition.resolveSystemPrompt({ ...context, turnId: 'turn-2' });

  assert.deepEqual(repeated, first);
  assert.deepEqual(first.sourceRevisions, [
    { id: 'memory', revision: 'memory-3' },
    { id: 'memory-bundle', revision: 'bundle-memory-3' },
    { id: 'runtime-policy', revision: '3' },
    { id: 'skill-catalog', revision: 'skills-3' },
  ]);
  assert.match(first.text ?? '', /MEMORY_THREE/u);
  assert.match(first.text ?? '', /SKILL_THREE/u);
  assert.deepEqual(next.sourceRevisions, [
    { id: 'memory', revision: 'memory-4' },
    { id: 'memory-bundle', revision: 'bundle-memory-4' },
    { id: 'runtime-policy', revision: '3' },
    { id: 'skill-catalog', revision: 'skills-4' },
  ]);
  assert.match(next.text ?? '', /MEMORY_FOUR/u);
  assert.match(next.text ?? '', /SKILL_FOUR/u);

  const nextComposition = createInteractiveRunComposer({
    runtimePolicy: { revision: policyRevision, policy: createDefaultRuntimePolicy() },
    skills: {
      readCanonicalModelInventory: async () => ({
        revision: skillRevision,
        inventory: [skillFixture('fixture', skillDescription, 'BODY')],
      }),
    } as unknown as HostSkillCatalogCoordinator,
    memory: {
      readPromptProjection: async () => ({
        bundleRevision: `bundle-${memoryRevision}`,
        memoryRevision,
        body: memoryBody,
      }),
    } as unknown as HostMemoryCoordinator,
    taskLedger: {} as TaskLedgerStore,
  });
  assert.deepEqual(
    (await nextComposition.resolveSystemPrompt({ ...context, turnId: 'turn-3' })).sourceRevisions,
    [
      { id: 'memory', revision: 'memory-4' },
      { id: 'memory-bundle', revision: 'bundle-memory-4' },
      { id: 'runtime-policy', revision: '4' },
      { id: 'skill-catalog', revision: 'skills-4' },
    ],
  );
});

test('a bound tool ceiling excludes dynamic Client Capability tools', () => {
  const boundTool: MakaTool = {
    name: 'bounded_tool',
    description: 'The only tool admitted for this activation.',
    parameters: {},
    impl: async () => 'bounded',
  };
  const capabilityTool: MakaTool = {
    name: 'mcp__opaque__inspect',
    description: 'A dynamic capability outside the exact ceiling.',
    parameters: {},
    categoryHint: 'client_capability',
    impl: async () => 'capability',
  };
  const scheduledTaskTool: MakaTool = {
    name: 'ScheduledTask',
    description: 'A root-only Host authority outside the exact child ceiling.',
    parameters: {},
    impl: async () => 'scheduled-task',
  };
  const composition = createInteractiveRunComposer({
    runtimePolicy: { revision: 0, policy: createDefaultRuntimePolicy() },
    skills: {
      readCanonicalModelInventory: async () => ({ inventory: [] }),
    } as unknown as HostSkillCatalogCoordinator,
    memory: {} as HostMemoryCoordinator,
    taskLedger: {} as TaskLedgerStore,
    boundTools: [boundTool],
    parentAgentTools: buildParentAgentTools(),
    scheduledTaskTool,
    builtinTools: {},
    clientCapabilities: {
      tools: [capabilityTool],
      groups: [
        {
          id: 'client_fixture',
          label: 'Opaque fixture',
          toolNames: [capabilityTool.name],
        },
      ],
    },
  });

  assert.deepEqual(composition.tools, [boundTool]);
  assert.equal(
    composition.toolAvailability.groups?.some((group) => group.id === 'client_fixture'),
    false,
  );
});

test('the headless coding profile freezes the Eval prompt and tool ceiling', async () => {
  const composition = createInteractiveRunComposer({
    runtimePolicy: { revision: 0, policy: createDefaultRuntimePolicy() },
    skills: {
      readCanonicalModelInventory: async () => {
        throw new Error('Profiled prompt must not read the product Skill catalog');
      },
    } as unknown as HostSkillCatalogCoordinator,
    memory: {
      readPromptProjection: async () => {
        throw new Error('Profiled prompt must not read product Memory');
      },
    } as unknown as HostMemoryCoordinator,
    taskLedger: {} as TaskLedgerStore,
    builtinTools: {},
    boundToolNames: hostedExecutionToolNames('headless-coding-v1'),
    toolProfile: 'headless-coding-v1',
    parentAgentTools: buildParentAgentTools(),
    scheduledTaskTool: {
      name: 'ScheduledTask',
      description: 'Must stay outside the Eval ceiling.',
      parameters: {},
      impl: async () => 'scheduled',
    },
  });

  assert.deepEqual(
    composition.tools.map(({ name }) => name),
    ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'apply_patch'],
  );
  assert.deepEqual(composition.toolAvailability.groups, []);
  assert.equal(
    (
      await composition.resolveSystemPrompt({
        sessionId: 'profiled-session',
        turnId: 'profiled-turn',
        cwd: '/workspace',
        workspaceRoot: '/workspace',
      })
    ).text,
    [
      'Complete the task by acting with the available tools, not by narrating.',
      'Prefer Read, Glob, and Grep for inspection, Edit and Write for file changes, and Bash for shell commands and tests.',
      'Verify the result when practical.',
      'Stop when the task is complete.',
    ].join('\n'),
  );
});

function skillFixture(id: string, description: string, content: string): ScannedSkill {
  return {
    ref: `project:agents:${id}`,
    id,
    name: id,
    description,
    path: `/workspace/.agents/skills/${id}/SKILL.md`,
    declaredTools: [],
    requiredTools: [],
    requiredCapabilities: [],
    enabled: true,
    pinned: false,
    runtimeStatus: 'enabled',
    scope: 'project',
    source: 'agents',
    precedence: 0,
    content,
    contentSha256: `sha256:${id}`,
    discoveryRoot: '/workspace',
  };
}

async function startTurn(
  composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>>,
  sessionId: string,
  turnId: string,
  text: string,
  context: ConnectionContext,
): Promise<TurnSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const input = { sessionId, turnId, content: { text } };
    const started = await composition.handlers['turn.start'](input, context);
    if (started.ok) {
      if (started.result.kind === 'started') return started.result.turn;
      throw new Error(`Hosted real-model Skill invocation was blocked: ${JSON.stringify(started)}`);
    }
    if (started.error.code !== 'session_busy') {
      throw new Error(`Hosted real-model Turn start failed: ${JSON.stringify(started.error)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Hosted real-model Session did not become idle');
}

async function waitForTerminal(
  composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>>,
  sessionId: string,
  turnId: string,
  initial: TurnSnapshot,
  context: ConnectionContext,
): Promise<TurnSnapshot> {
  let snapshot = initial;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (isTerminal(snapshot)) return snapshot;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const queried = await composition.handlers['turn.query']({ sessionId, turnId }, context);
    assert.equal(queried.ok, true);
    snapshot = queried.result;
  }
  throw new Error('Hosted real-model Turn did not become terminal');
}

async function waitForUsage(
  composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>>,
  context: ConnectionContext,
  connectionSlug: string,
  callKind: ModelCallKind,
): Promise<Extract<UsageQueryResult, { kind: 'logs'; source: 'llm' }>['rows'][number]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const queried = await composition.handlers['usage.query'](
      { kind: 'logs', source: 'llm', query: { range: 'all' } },
      context,
    );
    assert.equal(queried.ok, true);
    if (queried.result.kind === 'logs' && queried.result.source === 'llm') {
      const row = queried.result.rows.find(
        (candidate) =>
          candidate.connectionSlug === connectionSlug &&
          (candidate.callKind ?? 'main') === callKind,
      );
      if (row) return row;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Hosted real-model usage attribution was not persisted');
}

async function waitForProviderEvidence(
  execution: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>,
  sessionId: string,
  expectedRequests: number,
): Promise<{ captures: unknown[]; attempts: unknown[] }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const runs = await execution.agentRunStore.listSessionRuns(sessionId);
    const events = (
      await Promise.all(runs.map((run) => execution.agentRunStore.readEvents(sessionId, run.runId)))
    ).flat();
    const captures = events.filter((event) => event.type === 'provider_request_captured');
    const attempts = events.filter((event) => event.type === 'provider_request_attempt_recorded');
    if (captures.length >= expectedRequests && attempts.length >= expectedRequests) {
      return { captures, attempts };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  const runs = await execution.agentRunStore.listSessionRuns(sessionId);
  const events = (
    await Promise.all(runs.map((run) => execution.agentRunStore.readEvents(sessionId, run.runId)))
  ).flat();
  throw new Error(
    `Hosted provider request evidence was not persisted: ${JSON.stringify({
      expectedRequests,
      captures: events.filter((event) => event.type === 'provider_request_captured').length,
      attempts: events.filter((event) => event.type === 'provider_request_attempt_recorded').length,
    })}`,
  );
}

async function waitForAutomaticMemoryRequestsToSettle(
  requests: readonly ProviderRequest[],
): Promise<void> {
  let stablePolls = 0;
  let previousCount = -1;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const memoryCount = requests.filter((request) =>
      /Perform the first stage of long-term-memory extraction/.test(JSON.stringify(request.body)),
    ).length;
    if (memoryCount > 0 && requests.length === previousCount) stablePolls += 1;
    else stablePolls = 0;
    if (stablePolls >= 5) return;
    previousCount = requests.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Hosted automatic Memory extraction request did not settle: ${JSON.stringify(
      requests.map((request) => ({
        stream: request.body.stream,
        summary: /context summarization assistant/.test(JSON.stringify(request.body)),
        memory: /Perform the first stage of long-term-memory extraction/.test(
          JSON.stringify(request.body),
        ),
      })),
    )}`,
  );
}

function isTerminal(snapshot: TurnSnapshot): boolean {
  return (
    snapshot.status === 'completed' ||
    snapshot.status === 'failed' ||
    snapshot.status === 'cancelled'
  );
}

async function publishConnectionModel(
  policy: RuntimePolicyStoresWriter,
  connectionId: string,
  modelId: string,
  contextWindow = 3_072,
): Promise<void> {
  const prepared = await policy.operations.beginModelFetch(connectionId);
  assert.equal(prepared.kind, 'ready');
  if (prepared.kind !== 'ready') throw new Error('Model discovery was not ready');
  const committed = await policy.operations.completeModelFetch(prepared.ticket, {
    models: [
      {
        id: modelId,
        capabilities: { chat: true, functionCalling: true },
        contextWindow,
        maxOutputTokens: 64,
      },
    ],
    source: 'fetched',
    fetchedAt: Date.now(),
  });
  assert.equal(committed.kind, 'committed');
}

function backendCreationFixture(input: {
  abortSignal: AbortSignal;
  resolveExecutionConnection: () => Promise<unknown>;
  readPricing: () => Promise<unknown>;
  runtimePolicy?: RuntimePolicyStoresWriter;
  oauthCredentials?: HostOAuthExecutionAuthority;
  claudeDeviceId?: string;
  tools?: readonly MakaTool[];
  modelId?: string;
  snapshotClientCapabilities?: () => unknown;
  executionBoundary?: unknown;
  loadTurnRuntimeEvents?: () => Promise<RuntimeEvent[]>;
  recordRunTrace?: (event: RunTraceEvent) => unknown;
  runtimeCommitSink?: HostAiSdkBackendInput['runtimeCommitSink'];
  recordRunComposition?: BackendFactoryContext['recordRunComposition'];
  createFetchTransport?: HostAiSdkBackendInput['createFetchTransport'];
  createRunComposer?: HostAiSdkBackendInput['createRunComposer'];
}): HostAiSdkBackendInput {
  const runtimePolicy =
    input.runtimePolicy ??
    ({
      operations: {
        resolveExecutionConnection: input.resolveExecutionConnection,
      },
      runtimePolicy: {
        getSnapshot: async () => ({
          revision: 0,
          policy: createDefaultRuntimePolicy(),
        }),
      },
    } as unknown as RuntimePolicyStoresWriter);
  const createRunComposer =
    input.createRunComposer ??
    createInteractiveRunComposerFactory({
      skills: {
        readCanonicalModelInventory: async () => ({
          revision: 'skills-fixture',
          projectRoot: '/workspace',
          inventory: [],
          diagnostics: [],
          discoveryDiagnostics: [],
        }),
      } as unknown as HostSkillCatalogCoordinator,
      memory: {
        readPromptProjection: async () => ({
          policy: { revision: 0, policy: createDefaultRuntimePolicy() },
          bundleRevision: null,
          memoryRevision: null,
          body: '',
        }),
      } as unknown as HostMemoryCoordinator,
      taskLedger: { list: async () => [] } as unknown as TaskLedgerStore,
      clientCapabilities: {
        snapshotForSession: input.snapshotClientCapabilities ?? (() => undefined),
      } as unknown as HostClientCapabilityCoordinator,
    });
  return {
    context: {
      sessionId: 'backend-creation-session',
      workspaceRoot: '/workspace',
      header: {
        llmConnectionSlug: 'backend-creation-connection',
        model: input.modelId ?? MODEL_ID,
        cwd: '/workspace',
        permissionMode: 'bypass',
      },
      abortSignal: input.abortSignal,
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.loadTurnRuntimeEvents
        ? { loadTurnRuntimeEvents: input.loadTurnRuntimeEvents }
        : {}),
      ...(input.recordRunTrace ? { recordRunTrace: input.recordRunTrace } : {}),
      ...(input.recordRunComposition ? { recordRunComposition: input.recordRunComposition } : {}),
      store: {
        appendMessage: async () => undefined,
        readExecutionBoundary: async () => input.executionBoundary,
      },
    } as unknown as BackendFactoryContext,
    runtimePolicy,
    ...(input.oauthCredentials ? { oauthCredentials: input.oauthCredentials } : {}),
    ...(input.claudeDeviceId ? { claudeDeviceId: input.claudeDeviceId } : {}),
    createRunComposer,
    artifacts: {},
    executionArtifacts: {
      recordToolArtifacts: async () => undefined,
      toolResultArchive: createToolResultArchiveCapability({
        archiveToolResult: async () => ({ artifactId: 'fixture-tool-result-archive' }),
        readToolResultArchive: async () => ({ ok: false, reason: 'not_found' }),
        readArchivedToolResultResource: async () => ({ ok: false, reason: 'not_found' }),
      }),
    },
    usage: {
      pricing: {
        snapshot: input.readPricing,
      },
      telemetry: {
        recordLlmCall: async () => undefined,
        recordToolInvocation: async () => undefined,
      },
    },
    requestDrain: () => undefined,
    ...(input.runtimeCommitSink ? { runtimeCommitSink: input.runtimeCommitSink } : {}),
    ...(input.createFetchTransport ? { createFetchTransport: input.createFetchTransport } : {}),
  } as unknown as HostAiSdkBackendInput;
}

function readyExecutionConnection(
  baseUrl?: string,
  customization: {
    readonly requestHeaders?: Readonly<Record<string, string>>;
    readonly requestBodyOverlay?: Readonly<Record<string, unknown>>;
  } = {},
) {
  return {
    kind: 'ready',
    connection: {
      slug: 'backend-creation-connection',
      providerType: 'moonshot',
      ...(baseUrl ? { baseUrl } : {}),
      ...(customization.requestBodyOverlay
        ? { requestBodyOverlay: customization.requestBodyOverlay }
        : {}),
      enabledModelIds: [MODEL_ID],
      models: [
        {
          id: MODEL_ID,
          capabilities: { chat: true, functionCalling: true },
          contextWindow: 8_192,
          maxOutputTokens: 1_024,
        },
      ],
    },
    networkProxy: { enabled: false },
    secretMaterial: {
      connection: { secret: API_KEY },
      ...(customization.requestHeaders
        ? { requestHeaders: { secret: JSON.stringify(customization.requestHeaders) } }
        : {}),
    },
  };
}

function codexAccessToken(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  ).toString('base64url');
  return `header.${payload}.signature`;
}

async function settleWithin<T>(pending: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(SETTLE_TIMEOUT_MESSAGE)), 5_000);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const SETTLE_TIMEOUT_MESSAGE = 'Operation did not settle within five seconds';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function controlledOAuthTransports(): {
  readonly create: (proxy: ProxiedFetchProxy | null) => ProxiedFetchTransport;
  readonly refreshStarted: Promise<void>;
  readonly refreshTransportSettled: Promise<void>;
  readonly refreshCalls: number;
  readonly refreshTransportClosed: boolean;
  readonly modelTransportsClosed: number;
  completeRefresh(): void;
} {
  let markRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    markRefreshStarted = resolve;
  });
  let markRefreshTransportSettled!: () => void;
  const refreshTransportSettled = new Promise<void>((resolve) => {
    markRefreshTransportSettled = resolve;
  });
  let refreshCalls = 0;
  let refreshTransportClosed = false;
  let modelTransportsClosed = 0;
  let resolveRefresh: ((response: Response) => void) | undefined;
  let rejectRefresh: ((error: Error) => void) | undefined;
  let refreshCompleted = false;

  const create = (_proxy: ProxiedFetchProxy | null): ProxiedFetchTransport => {
    let usedForRefresh = false;
    let closed = false;
    return {
      fetch: async (url) => {
        assert.equal(String(url), 'https://platform.claude.com/v1/oauth/token');
        usedForRefresh = true;
        refreshCalls += 1;
        markRefreshStarted();
        return new Promise<Response>((resolve, reject) => {
          resolveRefresh = resolve;
          rejectRefresh = reject;
        });
      },
      close: async () => {
        if (closed) return;
        closed = true;
        if (usedForRefresh) {
          refreshTransportClosed = true;
          rejectRefresh?.(new Error('Controlled OAuth transport closed'));
          markRefreshTransportSettled();
        } else {
          modelTransportsClosed += 1;
        }
      },
    };
  };

  return {
    create,
    refreshStarted,
    refreshTransportSettled,
    get refreshCalls() {
      return refreshCalls;
    },
    get refreshTransportClosed() {
      return refreshTransportClosed;
    },
    get modelTransportsClosed() {
      return modelTransportsClosed;
    },
    completeRefresh: () => {
      if (refreshCompleted || !resolveRefresh) return;
      refreshCompleted = true;
      resolveRefresh(
        Response.json({
          access_token: 'refreshed-oauth-access',
          refresh_token: 'rotated-oauth-refresh',
          expires_in: 3_600,
          account: { uuid: 'oauth-account-v2' },
        }),
      );
    },
  };
}

function toolNames(body: Record<string, unknown> | undefined): string[] {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools
    .map((tool) => {
      if (!tool || typeof tool !== 'object') return undefined;
      const fn = (tool as { function?: unknown }).function;
      if (!fn || typeof fn !== 'object') return undefined;
      const name = (fn as { name?: unknown }).name;
      return typeof name === 'string' ? name : undefined;
    })
    .filter((name): name is string => Boolean(name))
    .sort();
}

function responsesToolNames(body: Record<string, unknown> | undefined): string[] {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools
    .flatMap((tool) => {
      if (!tool || typeof tool !== 'object') return [];
      const name = (tool as { name?: unknown }).name;
      return typeof name === 'string' ? [name] : [];
    })
    .sort();
}

function responsesDeveloperPrompt(body: Record<string, unknown> | undefined): string | undefined {
  const input = Array.isArray(body?.input) ? body.input : [];
  const developer = input.find(
    (message): message is Record<string, unknown> =>
      Boolean(message) && typeof message === 'object' && message.role === 'developer',
  );
  return typeof developer?.content === 'string' ? developer.content : undefined;
}

function providerRequestTrace(requests: readonly ProviderRequest[]): readonly unknown[] {
  return requests.map((request) => {
    return {
      stream: request.body.stream,
      tools: toolNames(request.body),
      lastToolResult: latestToolResultText(request.body)?.slice(0, 1_000),
    };
  });
}

function latestToolResultText(body: Record<string, unknown>): string | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const content = messages
    .filter(
      (message): message is Record<string, unknown> =>
        Boolean(message) && typeof message === 'object' && message.role === 'tool',
    )
    .at(-1)?.content;
  return typeof content === 'string'
    ? content
    : content === undefined
      ? undefined
      : JSON.stringify(content);
}

function requireLatestToolResult(body: Record<string, unknown>): Record<string, unknown> {
  const serialized = latestToolResultText(body);
  assert.ok(serialized, 'provider fixture expected a tool result in model history');
  const result: unknown = JSON.parse(serialized);
  assert.ok(result && typeof result === 'object' && !Array.isArray(result));
  return result as Record<string, unknown>;
}

function toolParameterEnum(
  body: Record<string, unknown> | undefined,
  toolName: string,
  property: string,
): unknown {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const tool = tools.find((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const fn = (candidate as { function?: unknown }).function;
    return Boolean(fn && typeof fn === 'object' && (fn as { name?: unknown }).name === toolName);
  }) as { function?: { parameters?: { properties?: Record<string, unknown> } } } | undefined;
  const schema = tool?.function?.parameters?.properties?.[property];
  return schema && typeof schema === 'object' ? (schema as { enum?: unknown }).enum : undefined;
}

function requireRuntimeResourceRef(body: Record<string, unknown>): string {
  const ref = JSON.stringify(body).match(/maka:\/\/runtime\/background-tasks\/[A-Za-z0-9_-]+/)?.[0];
  assert.ok(ref, 'provider fixture expected a background-task ref in model history');
  return ref;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

interface ProviderRequest {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly customHeader: string | undefined;
  readonly body: Record<string, unknown>;
}

type ProviderFlow =
  | { readonly kind: 'default' }
  | {
      readonly kind: 'client_capability';
      readonly groupId: string;
      readonly toolName: string;
    }
  | { readonly kind: 'child_agent' }
  | {
      readonly kind: 'implementation_child_agent';
      ptyReadCount: number;
      stopRequested: boolean;
    }
  | { readonly kind: 'agent_graph'; readonly scenario: AgentGraphProviderScenario };

async function startProvider(): Promise<{
  readonly baseUrl: string;
  readonly requests: ProviderRequest[];
  configureClientCapability(input: { groupId: string; toolName: string }): void;
  configureChildAgentFlow(): void;
  configureImplementationChildAgentFlow(): void;
  configureAgentGraphFlow(): void;
  close(): Promise<void>;
}> {
  const requests: ProviderRequest[] = [];
  let flow: ProviderFlow = { kind: 'default' };
  const server = createServer((request, response) => {
    void handleProviderRequest(request, response, requests, flow).catch((error) => {
      response.destroy(error as Error);
    });
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    configureClientCapability: (input) => {
      if (flow.kind !== 'default') throw new Error('Provider flow is already configured');
      flow = { kind: 'client_capability', ...input };
    },
    configureChildAgentFlow: () => {
      if (flow.kind !== 'default') throw new Error('Provider flow is already configured');
      flow = { kind: 'child_agent' };
    },
    configureImplementationChildAgentFlow: () => {
      if (flow.kind !== 'default') throw new Error('Provider flow is already configured');
      flow = { kind: 'implementation_child_agent', ptyReadCount: 0, stopRequested: false };
    },
    configureAgentGraphFlow: () => {
      if (flow.kind !== 'default') throw new Error('Provider flow is already configured');
      flow = {
        kind: 'agent_graph',
        scenario: new AgentGraphProviderScenario(CHILD_AGENT_RESULT_TEXT),
      };
    },
    close: () => closeServer(server),
  };
}

async function handleProviderRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: ProviderRequest[],
  flow: ProviderFlow,
): Promise<void> {
  assert.equal(request.method, 'POST');
  const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
  requests.push({
    url: request.url ?? '',
    authorization: request.headers.authorization,
    customHeader: request.headers['x-maka-test'] as string | undefined,
    body,
  });
  if (request.url === '/v1/responses') {
    respondProviderResponsesText(response, RESPONSE_TEXT);
    return;
  }
  if (body.stream !== true) {
    const isMemoryExtraction = /Perform the first stage of long-term-memory extraction/.test(
      JSON.stringify(body),
    );
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl-hosted-summary',
        object: 'chat.completion',
        created: 1,
        model: MODEL_ID,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: isMemoryExtraction
                ? JSON.stringify({
                    status: 'complete',
                    coverageStatus: 'processed',
                    requestedStatus: 'not_applicable',
                    requestedItems: [],
                    incidentalItems: [],
                  })
                : SUMMARY_TEXT,
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }),
    );
    return;
  }
  const streamRequestIndex = requests.filter((candidate) => candidate.body.stream === true).length;
  if (flow.kind === 'agent_graph') {
    flow.scenario.respond(body, {
      text: (text) => respondProviderText(response, text),
      toolCall: (toolName, args) =>
        respondProviderToolCall(response, streamRequestIndex, toolName, args),
    });
    return;
  }
  if (
    (flow.kind === 'child_agent' || flow.kind === 'implementation_child_agent') &&
    streamRequestIndex === 1
  ) {
    assert.ok(toolNames(body).includes('load_tools'));
    assert.equal(toolNames(body).includes('agent_spawn'), false);
    respondProviderToolCall(response, streamRequestIndex, 'load_tools', { group: 'agent' });
    return;
  }
  if (
    (flow.kind === 'child_agent' || flow.kind === 'implementation_child_agent') &&
    streamRequestIndex === 2
  ) {
    assert.ok(toolNames(body).includes('agent_spawn'));
    respondProviderToolCall(response, streamRequestIndex, 'agent_spawn', {
      profile: flow.kind === 'child_agent' ? 'local_read' : 'implementation',
      task:
        flow.kind === 'child_agent'
          ? 'Inspect the hosted child execution boundary without changing files.'
          : 'Create implementation.txt with the requested sentinel.',
      isolation: flow.kind === 'child_agent' ? 'same_workspace' : 'worktree',
      write_back: flow.kind === 'child_agent' ? 'summary' : 'patch',
    });
    return;
  }
  if (flow.kind === 'child_agent' && streamRequestIndex === 3) {
    assert.deepEqual(toolNames(body), ['ArchiveRead', 'Glob', 'Grep', 'Read']);
    respondProviderText(response, CHILD_AGENT_RESULT_TEXT);
    return;
  }
  if (flow.kind === 'child_agent' && streamRequestIndex === 4) {
    assert.ok(toolNames(body).includes('agent_spawn'));
    respondProviderToolCall(response, streamRequestIndex, 'agent_spawn', {
      profile: 'web_research',
      task: 'Find one current hosted web result.',
      isolation: 'same_workspace',
      write_back: 'summary',
    });
    return;
  }
  if (flow.kind === 'child_agent' && streamRequestIndex === 5) {
    assert.deepEqual(toolNames(body), ['ArchiveRead', 'WebSearch']);
    respondProviderToolCall(response, streamRequestIndex, 'WebSearch', {
      query: 'latest hosted web result',
      limit: 1,
    });
    return;
  }
  if (flow.kind === 'child_agent' && streamRequestIndex === 6) {
    assert.deepEqual(toolNames(body), ['ArchiveRead', 'WebSearch']);
    respondProviderText(response, WEB_RESEARCH_CHILD_RESULT_TEXT);
    return;
  }
  if (flow.kind === 'implementation_child_agent' && streamRequestIndex === 3) {
    assert.deepEqual(toolNames(body), [
      'ArchiveRead',
      'Bash',
      'Edit',
      'Glob',
      'Grep',
      'Read',
      'StopBackgroundTask',
      'Write',
      'WriteStdin',
    ]);
    respondProviderToolCall(response, streamRequestIndex, 'Write', {
      path: 'implementation.txt',
      content: 'HOSTED_IMPLEMENTATION_PATCH_SENTINEL\n',
    });
    return;
  }
  if (flow.kind === 'implementation_child_agent' && streamRequestIndex === 4) {
    respondProviderToolCall(response, streamRequestIndex, 'Bash', {
      command: 'node pty-child.mjs',
      run_in_background: true,
      pty: true,
    });
    return;
  }
  if (flow.kind === 'implementation_child_agent' && streamRequestIndex === 5) {
    respondProviderToolCall(response, streamRequestIndex, 'WriteStdin', {
      ref: requireRuntimeResourceRef(body),
      actions: [
        { type: 'text', text: 'ping' },
        { type: 'key', key: 'enter' },
      ],
    });
    return;
  }
  if (flow.kind === 'implementation_child_agent' && streamRequestIndex === 6) {
    flow.ptyReadCount = 1;
    respondProviderToolCall(response, streamRequestIndex, 'Read', {
      ref: requireRuntimeResourceRef(body),
    });
    return;
  }
  if (
    flow.kind === 'implementation_child_agent' &&
    streamRequestIndex >= 7 &&
    !toolNames(body).includes('agent_spawn')
  ) {
    const latestResult = latestToolResultText(body) ?? '';
    if (!flow.stopRequested) {
      if (!latestResult.includes('CHILD_PTY_OK:ping')) {
        assert.ok(
          flow.ptyReadCount < MAX_IMPLEMENTATION_CHILD_PTY_READS,
          'PTY child did not publish its input response',
        );
        flow.ptyReadCount += 1;
        respondProviderToolCall(response, streamRequestIndex, 'Read', {
          ref: requireRuntimeResourceRef(body),
        });
        return;
      }
      flow.stopRequested = true;
      respondProviderToolCall(response, streamRequestIndex, 'StopBackgroundTask', {
        ref: requireRuntimeResourceRef(body),
      });
      return;
    }
    const stopResult = requireLatestToolResult(body);
    assert.equal(stopResult.status, 'cancelled');
    assert.deepEqual(stopResult.operation, { kind: 'stop', applied: true });
    respondProviderText(response, CHILD_AGENT_RESULT_TEXT);
    return;
  }
  if (flow.kind === 'client_capability' && streamRequestIndex === 1) {
    assert.ok(toolNames(body).includes('load_tools'));
    respondProviderToolCall(response, streamRequestIndex, 'load_tools', {
      group: flow.groupId,
    });
    return;
  }
  if (flow.kind === 'client_capability' && streamRequestIndex === 2) {
    assert.ok(toolNames(body).includes(flow.toolName));
    respondProviderToolCall(response, streamRequestIndex, flow.toolName, {
      url: 'https://example.test/client-capability',
    });
    return;
  }
  respondProviderText(response, RESPONSE_TEXT);
}

function respondProviderResponsesText(response: ServerResponse, text: string): void {
  const responseId = 'resp-hosted-profile';
  const messageId = 'msg-hosted-profile';
  const events = [
    {
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        created_at: 1,
        model: 'deepseek-v4-flash',
        status: 'in_progress',
        output: [],
      },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'message',
        id: messageId,
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    },
    {
      type: 'response.output_text.delta',
      content_index: 0,
      delta: text,
      item_id: messageId,
      output_index: 0,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: messageId,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        object: 'response',
        created_at: 1,
        model: 'deepseek-v4-flash',
        status: 'completed',
        output: [],
        usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
      },
    },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\n`);
}

function respondProviderText(response: ServerResponse, text: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-hosted-real',
      object: 'chat.completion.chunk',
      created: 1,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: text },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-hosted-real',
      object: 'chat.completion.chunk',
      created: 1,
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
    })}\n\n`,
  );
  response.end('data: [DONE]\n\n');
}

function respondProviderToolCall(
  response: ServerResponse,
  step: number,
  toolName: string,
  args: Record<string, unknown>,
): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-hosted-tool-${step}`,
      object: 'chat.completion.chunk',
      created: step,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `hosted-tool-call-${step}`,
                type: 'function',
                function: { name: toolName, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-hosted-tool-${step}`,
      object: 'chat.completion.chunk',
      created: step,
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })}\n\n`,
  );
  response.end('data: [DONE]\n\n');
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
