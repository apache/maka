import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import type { TaskLedgerStore } from '@maka/core/task-ledger';
import type { BackendFactoryContext, MakaTool, MakaToolContext, ScannedSkill } from '@maka/runtime';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveTaskLedgerStoreForWrite } from '@maka/storage/task-ledger-authority';
import type { TurnSnapshot, UsageQueryResult } from '../protocol/index.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import {
  createHostAiSdkBackend,
  createHostExecutionModelComposition,
  type HostAiSdkBackendInput,
} from '../server/execution-model-composition.js';
import type { HostMemoryCoordinator } from '../server/memory-coordinator.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import type { HostSkillCatalogCoordinator } from '../server/skill-catalog-coordinator.js';

const MODEL_ID = 'hosted-real-model';
const API_KEY = 'hosted-provider-key';
const RESPONSE_TEXT = 'Hosted real-model execution completed.';
const SUMMARY_TEXT = '## Goal\nContinue hosted real-model execution.';

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
    const fetchPreparation = await policy.operations.beginModelFetch(connection.connectionId);
    assert.equal(fetchPreparation.kind, 'ready');
    if (fetchPreparation.kind !== 'ready') return;
    const fetched = await policy.operations.completeModelFetch(fetchPreparation.ticket, {
      models: [
        {
          id: MODEL_ID,
          capabilities: { chat: true, functionCalling: true },
          contextWindow: 3_072,
          maxOutputTokens: 64,
        },
      ],
      source: 'fetched',
      fetchedAt: Date.now(),
    });
    assert.equal(fetched.kind, 'committed');
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
      'Skill',
      'SkillSearch',
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
    await rm(join(root, 'artifacts', 'metadata.jsonl'));
    await mkdir(join(root, 'artifacts', 'metadata.jsonl'));
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
  callKind: 'main' | 'semantic_compact' | 'history_compact',
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

function backendCreationFixture(input: {
  abortSignal: AbortSignal;
  resolveExecutionConnection: () => Promise<unknown>;
  readPricing: () => Promise<unknown>;
}): HostAiSdkBackendInput {
  return {
    context: {
      sessionId: 'backend-creation-session',
      workspaceRoot: '/workspace',
      header: {
        llmConnectionSlug: 'backend-creation-connection',
        model: MODEL_ID,
      },
      abortSignal: input.abortSignal,
    } as BackendFactoryContext,
    runtimePolicy: {
      operations: {
        resolveExecutionConnection: input.resolveExecutionConnection,
      },
    },
    usage: {
      pricing: {
        snapshot: input.readPricing,
      },
    },
  } as unknown as HostAiSdkBackendInput;
}

function readyExecutionConnection() {
  return {
    kind: 'ready',
    connection: {
      slug: 'backend-creation-connection',
      providerType: 'moonshot',
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
    timeout = setTimeout(
      () => reject(new Error('Backend creation did not settle after abort')),
      250,
    );
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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

interface ProviderRequest {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

async function startProvider(): Promise<{
  readonly baseUrl: string;
  readonly requests: ProviderRequest[];
  close(): Promise<void>;
}> {
  const requests: ProviderRequest[] = [];
  const server = createServer((request, response) => {
    void handleProviderRequest(request, response, requests).catch((error) => {
      response.destroy(error as Error);
    });
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => closeServer(server),
  };
}

async function handleProviderRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: ProviderRequest[],
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
          delta: { role: 'assistant', content: RESPONSE_TEXT },
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
