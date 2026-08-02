import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import {
  createBypassExecutionBoundary,
  createManagedExecutionBoundary,
  createWorkspaceWritePermissionProfile,
  decodeCanonicalToolResultContent,
  type ModelCallKind,
  type RuntimeEvent,
} from '@maka/core';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import type { TaskLedgerStore } from '@maka/core/task-ledger';
import {
  serializeOAuthSubscriptionTokens,
  type OAuthSubscriptionTokens,
  type BackendFactoryContext,
  type FilesystemWorkerExecuteInput,
  type MakaTool,
  type MakaToolContext,
  type ProxiedFetchProxy,
  type ProxiedFetchTransport,
  type RunTraceEvent,
  type ScannedSkill,
  buildParentAgentTools,
} from '@maka/runtime';
import { createSqliteRuntimeStore } from '@maka/storage';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import {
  openInteractiveRuntimePolicyStoresForWrite,
  type RuntimePolicyStoresWriter,
} from '@maka/storage/runtime-policy-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveTaskLedgerStoreForWrite } from '@maka/storage/task-ledger-authority';
import { openInteractiveUsageStoresForWrite } from '@maka/storage/usage-stores';
import type { TurnSnapshot, UsageQueryResult } from '../protocol/index.js';
import type { ClientCapabilityHostFrame } from '../protocol/index.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import {
  createHostAiSdkBackend,
  createHostExecutionModelComposition,
  createHostGoalEvaluator,
  type HostAiSdkBackendInput,
} from '../server/execution-model-composition.js';
import { HostClientCapabilityCoordinator } from '../server/client-capability-coordinator.js';
import type { HostMemoryCoordinator } from '../server/memory-coordinator.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';
import { HostOAuthExecutionAuthority } from '../server/oauth-execution-authority.js';
import type { HostSkillCatalogCoordinator } from '../server/skill-catalog-coordinator.js';

const MODEL_ID = 'hosted-real-model';
const API_KEY = 'hosted-provider-key';
const RESPONSE_TEXT = 'Hosted real-model execution completed.';
const SUMMARY_TEXT = '## Goal\nContinue hosted real-model execution.';
const CLIENT_CAPABILITY_RESULT_TEXT = 'HOSTED_CLIENT_CAPABILITY_RESULT_SENTINEL';
const CHILD_AGENT_RESULT_TEXT = 'HOSTED_CHILD_AGENT_RESULT_SENTINEL';
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
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'backend-creation-connection',
        name: 'OAuth backend creation',
        providerType: 'claude-subscription',
        enabled: true,
        enabledModelIds: [MODEL_ID],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) return;
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
    await publishConnectionModel(policy, connection.connectionId, MODEL_ID);
    transports = controlledOAuthTransports();
    const authority = new HostOAuthExecutionAuthority(policy);
    const firstAbort = new AbortController();
    const firstCreation = createHostAiSdkBackend(
      backendCreationFixture({
        abortSignal: firstAbort.signal,
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
  const provider = coordinator.attachConnection('provider-a', { send: async () => undefined });
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
  provider.close();

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
    coordinator.close();
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
    connection = coordinator.attachConnection('client-capability-provider', {
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
    });
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
        resolveExecutionConnection: async () => readyExecutionConnection(provider.baseUrl),
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
    connection?.close();
    await backend?.dispose();
    coordinator.close();
    store.close();
    await provider.close();
  }
});

test('production Host executes a canonical ai-sdk Session against a real provider wire', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-real-model-'));
  const root = join(base, 'interactive');
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

    composition = await createExecutionRuntimeHostComposition({
      owner,
      hostEpoch: connectionContext.hostEpoch,
      acquireResidency: connectionContext.acquireResidency,
      retainUntilProcessExit: () => undefined,
      requestDrain: () => {
        drainRequests += 1;
      },
    });
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

    const mainRequests = provider.requests.filter((request) => request.body.stream === true);
    const compactRequests = provider.requests.filter((request) => request.body.stream !== true);
    assert.equal(mainRequests.length, 5);
    assert.ok(compactRequests.length >= 1);
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
    assert.deepEqual(toolNames(request?.body), [
      'AskUserQuestion',
      'Automation',
      'Bash',
      'Edit',
      'FormatJson',
      'Glob',
      'GoalClear',
      'GoalPause',
      'GoalResume',
      'GoalSet',
      'GoalStatus',
      'Grep',
      'Read',
      'Skill',
      'SkillSearch',
      'StopBackgroundTask',
      'Write',
      'WriteStdin',
      'load_tools',
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
    const evidence = await waitForProviderEvidence(execution, session.id, provider.requests.length);
    assert.equal(evidence.captures.length, provider.requests.length);
    assert.equal(evidence.attempts.length, provider.requests.length);

    const artifacts = await openInteractiveArtifactStoreForWrite(owner.lease);
    const artifactPage = await artifacts.listPage(session.id, { offset: 0, limit: 100 });
    const captureArtifacts = artifactPage.records.filter(
      (artifact) => artifact.source === 'provider_request_capture',
    );
    assert.equal(captureArtifacts.length, provider.requests.length);
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
    assert.equal(requests.length, 4);
    assert.ok(toolNames(requests[0]?.body).includes('load_tools'));
    assert.equal(toolNames(requests[0]?.body).includes('agent_spawn'), false);
    assert.ok(toolNames(requests[1]?.body).includes('agent_spawn'));
    assert.deepEqual(toolParameterEnum(requests[1]?.body, 'agent_spawn', 'profile'), [
      'local_read',
      'implementation',
    ]);
    assert.deepEqual(toolNames(requests[2]?.body), ['Glob', 'Grep', 'Read']);
    assert.ok(toolNames(requests[3]?.body).includes('agent_spawn'));

    const sessions = await execution.sessionStore.listForRecovery();
    const child = sessions.find((session) => session.id !== parent.id);
    assert.ok(child);
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
    await git(project, 'init', '--initial-branch=main');
    await git(project, 'add', 'README.md');
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
    assert.equal(requests.length, 5);
    assert.ok(toolNames(requests[0]?.body).includes('load_tools'));
    assert.equal(toolNames(requests[0]?.body).includes('agent_spawn'), false);
    assert.ok(toolNames(requests[1]?.body).includes('agent_spawn'));
    assert.deepEqual(toolParameterEnum(requests[1]?.body, 'agent_spawn', 'profile'), [
      'local_read',
      'implementation',
    ]);
    assert.deepEqual(toolNames(requests[2]?.body), [
      'Bash',
      'Edit',
      'Glob',
      'Grep',
      'Read',
      'Write',
    ]);
    assert.deepEqual(toolNames(requests[3]?.body), toolNames(requests[2]?.body));
    assert.ok(toolNames(requests[4]?.body).includes('agent_spawn'));

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
    assert.equal(childArtifacts.length, 3);
    assert.equal(
      childArtifacts.filter((artifact) => artifact.source === 'provider_request_capture').length,
      2,
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

test('Host Goal evaluator meters provider usage and aborts its physical request', {
  timeout: 10_000,
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
  let policyReads = 0;
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
  const composition = createHostExecutionModelComposition({
    policy: {
      getSnapshot: async () => {
        policyReads += 1;
        return policy;
      },
    },
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

  const firstPrompt = await composition.systemPrompt(firstContext);
  assert.match(firstPrompt ?? '', /OLD_DESCRIPTION/);
  assert.match(firstPrompt ?? '', /MEMORY_BODY/);
  assert.equal(policyReads, 0);
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

  const nextPrompt = await composition.systemPrompt({ ...firstContext, turnId: 'turn-2' });
  assert.match(nextPrompt ?? '', /NEW_DESCRIPTION/);
  assert.doesNotMatch(nextPrompt ?? '', /OLD_DESCRIPTION/);
  assert.equal(inventoryReads, 2);
});

test('Client Capability tools join the existing load_tools catalog without a parallel loader', () => {
  const capabilityTool: MakaTool = {
    name: 'mcp__opaque__inspect',
    description: 'Fixture Client Capability tool.',
    parameters: {},
    categoryHint: 'client_capability',
    impl: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  };
  const composition = createHostExecutionModelComposition({
    policy: {
      getSnapshot: async () => ({
        revision: 0,
        policy: createDefaultRuntimePolicy(),
      }),
    },
    skills: {
      readCanonicalModelInventory: async () => ({ inventory: [] }),
    } as unknown as HostSkillCatalogCoordinator,
    memory: {} as HostMemoryCoordinator,
    taskLedger: {} as TaskLedgerStore,
    clientCapabilities: {
      tools: [capabilityTool],
      groups: [
        {
          id: 'client_fixture',
          label: 'Opaque fixture',
          description: 'Loaded through the canonical tool connector.',
          toolNames: [capabilityTool.name],
        },
      ],
    },
  });

  assert.ok(composition.tools.includes(capabilityTool));
  assert.deepEqual(
    composition.toolAvailability.groups?.find((group) => group.id === 'client_fixture'),
    {
      id: 'client_fixture',
      label: 'Opaque fixture',
      description: 'Loaded through the canonical tool connector.',
      toolNames: [capabilityTool.name],
    },
  );
});

test('Host model composition routes managed file tools through its filesystem worker', async () => {
  let workerInput: FilesystemWorkerExecuteInput | undefined;
  const composition = createHostExecutionModelComposition({
    policy: {
      getSnapshot: async () => ({
        revision: 0,
        policy: createDefaultRuntimePolicy(),
      }),
    },
    skills: {
      readCanonicalModelInventory: async () => ({ inventory: [] }),
    } as unknown as HostSkillCatalogCoordinator,
    memory: {} as HostMemoryCoordinator,
    taskLedger: {} as TaskLedgerStore,
    builtinTools: {
      filesystemWorker: {
        execute: async (input) => {
          workerInput = input;
          return { kind: 'read', content: 'read by Host worker' };
        },
      },
      sandboxPlatform: 'darwin',
    },
  });
  const read = composition.tools.find((tool) => tool.name === 'Read');
  assert.ok(read);

  const result = await read.impl(
    { path: 'resource.txt' },
    {
      sessionId: 'session',
      turnId: 'turn',
      toolCallId: 'read-call',
      cwd: process.cwd(),
      permissionMode: 'ask',
      executionBoundary: createManagedExecutionBoundary(createWorkspaceWritePermissionProfile(), 0),
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
    },
  );

  assert.deepEqual(result, { content: 'read by Host worker' });
  assert.ok(workerInput);
  assert.deepEqual(workerInput.operation, { kind: 'read', path: 'resource.txt' });
  assert.equal(workerInput.cwd, process.cwd());
  assert.equal(workerInput.executionBoundary?.kind, 'managed');
  assert.equal(workerInput.mode, 'ask');
  assert.ok(workerInput.abortSignal instanceof AbortSignal);
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
  const automationTool: MakaTool = {
    name: 'Automation',
    description: 'A root-only Host authority outside the exact child ceiling.',
    parameters: {},
    impl: async () => 'automation',
  };
  const composition = createHostExecutionModelComposition({
    policy: {
      getSnapshot: async () => ({
        revision: 0,
        policy: createDefaultRuntimePolicy(),
      }),
    },
    skills: {
      readCanonicalModelInventory: async () => ({ inventory: [] }),
    } as unknown as HostSkillCatalogCoordinator,
    memory: {} as HostMemoryCoordinator,
    taskLedger: {} as TaskLedgerStore,
    boundTools: [boundTool],
    parentAgentTools: buildParentAgentTools(),
    automationTool,
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

test('root model composition defers the canonical parent-agent tool group', () => {
  const parentAgentTools = buildParentAgentTools();
  const composition = createHostExecutionModelComposition({
    policy: {
      getSnapshot: async () => ({
        revision: 0,
        policy: createDefaultRuntimePolicy(),
      }),
    },
    skills: {
      readCanonicalModelInventory: async () => ({ inventory: [] }),
    } as unknown as HostSkillCatalogCoordinator,
    memory: {} as HostMemoryCoordinator,
    taskLedger: {} as TaskLedgerStore,
    parentAgentTools,
  });

  assert.deepEqual(
    composition.toolAvailability.groups?.find((group) => group.id === 'agent')?.toolNames,
    ['agent_spawn', 'agent_swarm', 'agent_list', 'agent_output'],
  );
  assert.ok(parentAgentTools.every((tool) => composition.tools.includes(tool)));
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
    const started = await composition.handlers['turn.start'](
      { sessionId, turnId, content: { text } },
      context,
    );
    if (started.ok) return started.result;
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
  throw new Error('Hosted provider request evidence was not persisted');
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
  snapshotClientCapabilities?: () => unknown;
  executionBoundary?: unknown;
  loadTurnRuntimeEvents?: () => Promise<RuntimeEvent[]>;
  recordRunTrace?: (event: RunTraceEvent) => unknown;
  runtimeCommitSink?: HostAiSdkBackendInput['runtimeCommitSink'];
  createFetchTransport?: HostAiSdkBackendInput['createFetchTransport'];
}): HostAiSdkBackendInput {
  return {
    context: {
      sessionId: 'backend-creation-session',
      workspaceRoot: '/workspace',
      header: {
        llmConnectionSlug: 'backend-creation-connection',
        model: MODEL_ID,
        cwd: '/workspace',
        permissionMode: 'bypass',
      },
      abortSignal: input.abortSignal,
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.loadTurnRuntimeEvents
        ? { loadTurnRuntimeEvents: input.loadTurnRuntimeEvents }
        : {}),
      ...(input.recordRunTrace ? { recordRunTrace: input.recordRunTrace } : {}),
      store: {
        appendMessage: async () => undefined,
        readExecutionBoundary: async () => input.executionBoundary,
      },
    } as unknown as BackendFactoryContext,
    runtimePolicy: input.runtimePolicy ?? {
      operations: {
        resolveExecutionConnection: input.resolveExecutionConnection,
      },
      runtimePolicy: {
        getSnapshot: async () => ({
          revision: 0,
          policy: createDefaultRuntimePolicy(),
        }),
      },
    },
    ...(input.oauthCredentials ? { oauthCredentials: input.oauthCredentials } : {}),
    ...(input.claudeDeviceId ? { claudeDeviceId: input.claudeDeviceId } : {}),
    skills: {
      readCanonicalModelInventory: async () => ({ inventory: [] }),
    },
    memory: {
      readPromptProjection: async () => ({
        policy: { revision: 0, policy: createDefaultRuntimePolicy() },
        bundleRevision: null,
        memoryRevision: null,
        body: '',
      }),
    },
    taskLedger: {
      list: async () => [],
    },
    artifacts: {},
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
    clientCapabilities: {
      snapshotForSession: input.snapshotClientCapabilities ?? (() => undefined),
    },
    ...(input.runtimeCommitSink ? { runtimeCommitSink: input.runtimeCommitSink } : {}),
    ...(input.createFetchTransport ? { createFetchTransport: input.createFetchTransport } : {}),
  } as unknown as HostAiSdkBackendInput;
}

function readyExecutionConnection(baseUrl?: string) {
  return {
    kind: 'ready',
    connection: {
      slug: 'backend-creation-connection',
      providerType: 'moonshot',
      ...(baseUrl ? { baseUrl } : {}),
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
    },
  };
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
  readonly body: Record<string, unknown>;
}

type ProviderFlow =
  | { readonly kind: 'default' }
  | {
      readonly kind: 'client_capability';
      readonly groupId: string;
      readonly toolName: string;
    }
  | { readonly kind: 'child_agent' | 'implementation_child_agent' };

async function startProvider(): Promise<{
  readonly baseUrl: string;
  readonly requests: ProviderRequest[];
  configureClientCapability(input: { groupId: string; toolName: string }): void;
  configureChildAgentFlow(): void;
  configureImplementationChildAgentFlow(): void;
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
      flow = { kind: 'implementation_child_agent' };
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
    body,
  });
  if (body.stream !== true) {
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
            message: { role: 'assistant', content: SUMMARY_TEXT },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }),
    );
    return;
  }
  const streamRequestIndex = requests.filter((candidate) => candidate.body.stream === true).length;
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
    assert.deepEqual(toolNames(body), ['Glob', 'Grep', 'Read']);
    respondProviderText(response, CHILD_AGENT_RESULT_TEXT);
    return;
  }
  if (flow.kind === 'implementation_child_agent' && streamRequestIndex === 3) {
    assert.deepEqual(toolNames(body), ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);
    respondProviderToolCall(response, streamRequestIndex, 'Write', {
      path: 'implementation.txt',
      content: 'HOSTED_IMPLEMENTATION_PATCH_SENTINEL\n',
    });
    return;
  }
  if (flow.kind === 'implementation_child_agent' && streamRequestIndex === 4) {
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
