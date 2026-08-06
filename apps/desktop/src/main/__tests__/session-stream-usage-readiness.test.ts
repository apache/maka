import { createToolResultArchiveCapability } from '@maka/runtime';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SessionHeader } from '@maka/core';
import {
  buildPricingLookup,
  createSandboxDiagnosticsProvider,
  type BackendFactoryContext,
} from '@maka/runtime';
import {
  createSqliteModelCallLedger,
  createSqlitePlanStore,
  createSqliteTelemetryRepo,
} from '@maka/storage';
import {
  createAiSdkBackendFactory,
  type AiSdkBackendFactoryDeps,
} from '../session-stream.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('the first Desktop backend waits for canonical telemetry readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-desktop-usage-ready-'));
  const loadGate = deferred();
  const telemetryRepo = createSqliteTelemetryRepo(root);
  const modelCallLedger = createSqliteModelCallLedger(root);
  const planStore = createSqlitePlanStore(root);
  await planStore.ready();
  let lookupPricing = buildPricingLookup();
  let readyConnectionReads = 0;

  try {
    const ensureUsageReady = async () => {
      await loadGate.promise;
      await telemetryRepo.load();
      lookupPricing = buildPricingLookup(telemetryRepo.listPricingOverrides());
    };
    const factory = createAiSdkBackendFactory({
      isComputerUseRealModelE2e: false,
      ensureMcpReady: async () => {},
      getReadyConnection: async () => {
        readyConnectionReads += 1;
        return {
          connection: {
            slug: 'openai-main',
            name: 'OpenAI',
            providerType: 'openai',
            defaultModel: 'gpt-4o',
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
          apiKey: 'test-key',
          model: 'gpt-4o',
        };
      },
      buildSubscriptionModelFetch: () => undefined,
      systemPromptService: {
        buildLocalMemoryPromptFragment: async () => undefined,
        buildBackendSystemPrompt: () => '',
        buildTurnTailPrompt: () => undefined,
      },
      mcpManager: {},
      telemetryRepo,
      modelCallLedger,
      ensureUsageReady,
      artifactStore: {},
      deepResearchTools: [],
      desktopSessionSkillHosts: new Map(),
      computerUseTools: [],
      builtinTools: [],
      toolAvailability: { economy: false, groups: [] },
      sandboxDiagnosticsProvider: createSandboxDiagnosticsProvider({ platform: 'win32' }),
      persistToolArtifacts: async () => {},
      toolResultArchive: testDesktopToolResultArchive(),
      runtimeCommitStore: undefined,
      planStore,
      safeSendToRenderer: () => {},
      getRuntime: () => ({}),
      getLookupPricing: () => lookupPricing,
    } as unknown as AiSdkBackendFactoryDeps);

    const backendPending = Promise.resolve(factory(factoryContext(root)));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(readyConnectionReads, 0);

    loadGate.resolve();
    const backend = await backendPending;
    assert.equal(readyConnectionReads, 1);
    await backend.dispose();
  } finally {
    planStore.close();
    await modelCallLedger.close().catch(() => undefined);
    await telemetryRepo.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function factoryContext(root: string): BackendFactoryContext {
  const header: SessionHeader = {
    id: 'session-1',
    workspaceRoot: root,
    cwd: root,
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Usage readiness test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'openai-main',
    connectionLocked: true,
    model: 'gpt-4o',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
  return {
    sessionId: header.id,
    workspaceRoot: root,
    header,
    store: { appendMessage: async () => {} } as unknown as BackendFactoryContext['store'],
    tools: [],
  };
}

function testDesktopToolResultArchive() {
  return createToolResultArchiveCapability({
    archiveToolResult: async () => undefined,
    readToolResultArchive: async () => ({ ok: false, reason: 'not_found' }),
    readArchivedToolResultResource: async () => ({ ok: false, reason: 'not_found' }),
  });
}
