import { defineInteractiveRuntimeHostComposition } from '../server/host-composition.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SessionHeader } from '@maka/core';
import type { SessionManager } from '@maka/runtime';
import { openInteractiveAutomationAuthorityForWrite } from '@maka/storage/automation-authority';
import type {
  ExecutionAgentRunWriter,
  ExecutionSessionWriter,
} from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import { connectRuntimeHost, type RuntimeHostConnection } from '../client/index.js';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '../protocol/index.js';
import { HostAutomationCoordinator } from '../server/automation-coordinator.js';
import { RuntimeHostKernel } from '../server/host-kernel.js';
import { createUnavailableDomainOperationHandlers } from '../server/operation-dispatcher.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

test('two Clients share one revision-pinned Automation authority', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-automation-uds-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const headers = new Map<string, SessionHeader>([
    ['desktop-session', sessionHeader('desktop-session')],
    ['tui-session', sessionHeader('tui-session')],
  ]);
  const host = await RuntimeHostKernel.start({
    owner,
    idleGraceMs: 10_000,
    composition: defineInteractiveRuntimeHostComposition(async (context) => {
      const writer = await openInteractiveAutomationAuthorityForWrite(context.owner.lease);
      const coordinator = new HostAutomationCoordinator({
        store: writer,
        sessions: {
          readHeaderSnapshot: async (sessionId) => {
            const header = headers.get(sessionId);
            if (!header) throw missingRecord();
            return structuredClone(header);
          },
          createStableSession: async () => assert.fail('No cron fire is expected in this test'),
        } as Pick<ExecutionSessionWriter, 'createStableSession' | 'readHeaderSnapshot'>,
        runs: {
          readRun: async () => {
            throw missingRecord();
          },
        } as Pick<ExecutionAgentRunWriter, 'readRun'>,
        runtime: {
          sendMessage: async function* () {
            assert.fail('No Automation fire is expected in this test');
          },
        } as unknown as Pick<SessionManager, 'sendMessage'>,
        root: {
          admit: async () => assert.fail('No Automation fire is expected in this test'),
          reconcile: async () => assert.fail('No Automation fire is expected in this test'),
          subscribe: () => () => undefined,
        },
        runtimePolicy: runtimePolicyStores(),
        clientCapabilities: {
          requirementsForAutomation: async () => ({ ok: true, requirements: [] }),
          checkAutomationRequirements: async () => ({ ok: true }),
          bindAutomationSession: async () => ({ ok: true }),
        },
        isSessionActive: () => false,
        sessionAdmission: new SessionAdmissionGate(),
        acquireResidency: () => context.acquireResidency('automation'),
        requestDrain: context.requestDrain,
        now: () => 1_000,
        random: () => 0,
      });
      return {
        handlers: {
          ...createUnavailableDomainOperationHandlers(),
          ...coordinator.handlers,
        },
        beginDrain: () => coordinator.beginDrain(),
        recover: async () => {
          await coordinator.prepareRecovery();
          await coordinator.recover();
          coordinator.start();
        },
        close: async () => {
          await coordinator.close();
          writer.close();
        },
      };
    }),
  });
  let desktop: RuntimeHostConnection | undefined;
  let tui: RuntimeHostConnection | undefined;
  try {
    desktop = await connect(root, 'desktop');
    tui = await connect(root, 'tui');
    const created = await desktop.request('automation.mutate', {
      kind: 'create',
      sessionId: 'desktop-session',
      automationKind: 'heartbeat',
      name: 'check build',
      prompt: 'Check the build.',
      schedule: { type: 'interval', seconds: 60 },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed' || !created.automation) return;
    assert.equal(created.automation.firePending, false);

    const firstPage = await tui.request('automation.query', {
      kind: 'list_start',
      sessionId: 'desktop-session',
    });
    assert.equal(firstPage.kind, 'page');
    if (firstPage.kind !== 'page') return;
    assert.deepEqual(firstPage.automations, [created.automation]);
    assert.equal(firstPage.revision, created.revision);

    const paused = await tui.request('automation.mutate', {
      kind: 'pause',
      sessionId: 'desktop-session',
      automationId: created.automation.id,
    });
    assert.equal(paused.kind, 'committed');
    if (paused.kind !== 'committed' || !paused.automation) return;
    assert.equal(paused.automation.status, 'paused');
    assert.equal(paused.revision, firstPage.revision + 1);

    const stale = await desktop.request('automation.query', {
      kind: 'list_continue',
      sessionId: 'desktop-session',
      revision: firstPage.revision,
      cursor: '0',
    });
    assert.deepEqual(stale, {
      kind: 'revision_changed',
      expected: firstPage.revision,
      actual: paused.revision,
    });

    const cron = await desktop.request('automation.mutate', {
      kind: 'create',
      sessionId: 'desktop-session',
      automationKind: 'cron',
      name: 'daily summary',
      prompt: 'Summarize the workspace.',
      schedule: { type: 'once', delaySeconds: 30 },
    });
    assert.equal(cron.kind, 'committed');
    if (cron.kind !== 'committed' || !cron.automation) return;
    const globallyVisible = await tui.request('automation.query', {
      kind: 'get',
      sessionId: 'tui-session',
      automationId: cron.automation.id,
    });
    assert.equal(globallyVisible.kind, 'automation');
    if (globallyVisible.kind === 'automation') {
      assert.equal(globallyVisible.automation?.id, cron.automation.id);
      assert.equal(globallyVisible.automation?.durable, true);
    }
    assert.equal(JSON.stringify(globallyVisible).includes('execution'), false);
  } finally {
    await Promise.allSettled([desktop?.close(), tui?.close()]);
    await host.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

async function connect(
  rootPath: string,
  surface: 'desktop' | 'tui',
): Promise<RuntimeHostConnection> {
  const result = await connectRuntimeHost({ rootPath, surface, protocol: PROTOCOL });
  assert.equal(result.kind, 'connected');
  if (result.kind !== 'connected') throw new Error('Unable to connect to Runtime Host');
  return result.connection;
}

function sessionHeader(id: string): SessionHeader {
  return {
    id,
    workspaceRoot: '/workspace',
    cwd: '/workspace',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Session',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'openrouter',
    connectionLocked: false,
    model: 'openrouter/free',
    permissionMode: 'explore',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    schemaVersion: 1,
  };
}

function runtimePolicyStores(): RuntimePolicyStoresWriter {
  return {
    runtimePolicy: {
      getSnapshot: async () => ({
        revision: 0,
        policy: {
          networkProxy: {
            enabled: false,
            protocol: 'http',
            host: '',
            port: 0,
            authEnabled: false,
            username: '',
            bypassList: [],
            autoBypassDomains: [],
          },
          personalization: { displayName: '', assistantTone: '' },
          memory: { enabled: false, agentReadEnabled: false },
          workspaceInstructions: { enabled: true },
          privacy: { incognitoActive: false },
          chatDefaults: { permissionMode: 'explore' },
          webSearch: { enabled: false, defaultProvider: 'tavily' },
        },
      }),
    },
  } as unknown as RuntimePolicyStoresWriter;
}

function missingRecord(): NodeJS.ErrnoException {
  const error = new Error('Record not found') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}
