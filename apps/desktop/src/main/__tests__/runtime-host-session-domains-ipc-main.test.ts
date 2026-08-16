import assert from 'node:assert/strict';
import test from 'node:test';
import type { IpcMain } from 'electron';
import { projectDeepResearchClientProgress } from '@maka/core/deep-research-client-progress';
import { type DeepResearchRun } from '@maka/core/deep-research-run';
import { type PlanSessionState } from '@maka/core/plan';
import { type ShellRunUpdate } from '@maka/core/events';
import { encodeDeepResearchSnapshot } from '@maka/runtime-host/protocol';
import {
  projectEmbeddedDeepResearch,
  projectHostedDeepResearch,
} from '../deep-research-desktop-projection.js';
import {
  registerRuntimeHostSessionDomainsIpc,
  type RuntimeHostSessionDomainsIpcDeps,
} from '../runtime-host-session-domains-ipc-main.js';

type DomainClient = RuntimeHostSessionDomainsIpcDeps['client'];

test('adapts Host Goal, Task, Deep Research, and Resource projections', async () => {
  const controls: unknown[] = [];
  const client = domainClient({
    listTasks: async () => [{ id: 'task-1' }] as never,
    listRuntimeResources: async () => [{ sessionId: 'session-1', result: { ref: 'shell:1' } }] as never,
    queryGoal: async () => ({
      sessionId: 'session-1',
      goal: goalProjection(),
    }),
    clearGoal: async (sessionId) => {
      controls.push(sessionId);
    },
    queryDeepResearch: async () => hostedResearch(),
  });
  const ipc = ipcHarness();
  registerDomainsIpc({ client, emitModeChanged() {} }, ipc);

  assert.equal(((await ipc.invoke('tasks:list', 'session-1')) as Array<{ id: string }>)[0]?.id, 'task-1');
  assert.equal(
    ((await ipc.invoke('shell-runs:list', 'session-1')) as Array<{ result: { ref: string } }>)[0]
      ?.result.ref,
    'shell:1',
  );
  assert.deepEqual(await ipc.invoke('goal:get', 'session-1'), {
    id: 'goal-1',
    revision: 3,
    sessionId: 'session-1',
    condition: 'Finish the adapter',
    status: 'active',
    setAt: 1,
    iterations: 2,
    maxIterations: 20,
    consecutiveNoProgress: 0,
    blockCap: 8,
    tokenBudget: 1_000,
    tokensAtStart: 0,
    tokensNow: 120,
    tokensBaselinePending: false,
  });
  await ipc.invoke('goal:clear', 'session-1');
  assert.deepEqual(controls, ['session-1']);
  assert.deepEqual(await ipc.invoke('deepResearch:get', 'session-1'), {
    sessionId: 'session-1',
    objective: 'Inspect the adapter',
    scopeLevel: 'standard',
    status: 'completed',
    stage: 'completed',
    round: 2,
    createdAt: 1,
    updatedAt: 2,
    artifactsCount: 4,
    stepsCount: 3,
    checklist: [
      { itemId: 'entrypoints', title: 'Map entrypoints', status: 'completed' },
    ],
    reportSections: [{ key: 'conclusion', status: 'completed' }],
    recentInspectedRefs: [
      { kind: 'file', locator: 'apps/desktop/src/main/runtime-host-boot.ts' },
    ],
    workerRunIds: ['run-1'],
    blockers: [],
    reportArtifactId: 'artifact-1',
    implementationPrompt: 'Implement the result.',
  });
});

test('adapts interactive terminal ownership to one Host controller lease', async () => {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const update = shellRunUpdate({
    result: {
      kind: 'shell_run',
      ref: 'maka://runtime/background-tasks/shell-1',
      mode: 'pty',
      status: 'running',
      cwd: '/workspace',
      cmd: 'exec "$SHELL" -l',
      startedAt: 1,
      updatedAt: 2,
      revision: 2,
      output: {
        mode: 'pty',
        screen: 'ready',
        scrollback: '',
        cols: 80,
        rows: 24,
        cursor: { x: 5, y: 0, visible: true },
        alternateScreen: false,
        truncated: false,
        redacted: false,
      },
    },
  });
  const pty = {
    sessionId: 'session-1',
    ref: update.result.ref,
    sequence: 3,
    buffer: 'ready',
    size: { cols: 80, rows: 24 },
  };
  const ipc = ipcHarness();
  const handle = registerDomainsIpc(
    {
      client: domainClient({
        startRuntimeResource: async (input) => {
          calls.push({ operation: 'start', input });
          return { resource: update.result as never };
        },
        getRuntimeResource: async (sessionId, ref) => {
          calls.push({ operation: 'get', input: { sessionId, ref } });
          return update;
        },
        acquireRuntimeResourceController: async (input) => {
          calls.push({ operation: 'acquire', input });
          return { controllerId: input.controllerId, nextSequence: 7, pty };
        },
        controlRuntimeResource: async (input) => {
          calls.push({ operation: 'control', input });
          return { controllerId: input.controllerId, sequence: input.sequence, resource: update.result as never };
        },
        releaseRuntimeResourceController: async (input) => {
          calls.push({ operation: 'release', input });
          return { controllerId: input.controllerId, released: true };
        },
        stopRuntimeResource: async (input) => {
          calls.push({ operation: 'stop', input });
          return { resource: update.result as never };
        },
      }),
      sessionObserver: {
        observe: async (sessionId, observerId) => {
          calls.push({ operation: 'observe', input: { sessionId, observerId } });
        },
        unobserve: async (observerId) => {
          calls.push({ operation: 'unobserve', input: { observerId } });
        },
      },
      emitModeChanged() {},
      newId: () => 'fixed-id',
    },
    ipc,
  );

  assert.equal((await ipc.invoke('shell-runs:start', 'session-1') as ShellRunUpdate).result.ref, pty.ref);
  assert.deepEqual(
    await ipc.invoke('shell-runs:attach', { sessionId: 'session-1', ref: pty.ref }),
    pty,
  );
  await ipc.invoke('shell-runs:write', {
    sessionId: 'session-1',
    ref: pty.ref,
    input: 'pwd\r',
    size: { cols: 90, rows: 30 },
  });
  await ipc.invoke('shell-runs:detach', { sessionId: 'session-1', ref: pty.ref });
  await ipc.invoke('shell-runs:stop', { sessionId: 'session-1', ref: pty.ref });
  await handle.close();

  assert.deepEqual(
    calls.filter(({ operation }) => operation === 'control').map(({ input }) => input),
    [{
      sessionId: 'session-1',
      ref: pty.ref,
      controllerId: 'desktop-terminal-controller-fixed-id',
      sequence: 7,
      control: { kind: 'input_and_resize', input: 'pwd\r', cols: 90, rows: 30 },
    }],
  );
  assert.equal(calls.filter(({ operation }) => operation === 'acquire').length, 1);
  assert.equal(calls.filter(({ operation }) => operation === 'release').length, 1);
  assert.equal(calls.filter(({ operation }) => operation === 'stop').length, 1);
  assert.deepEqual(
    calls.filter(({ operation }) => operation === 'observe' || operation === 'unobserve'),
    [
      {
        operation: 'observe',
        input: {
          sessionId: 'session-1',
          observerId: 'desktop-terminal-controller-fixed-id:session-events',
        },
      },
      {
        operation: 'unobserve',
        input: { observerId: 'desktop-terminal-controller-fixed-id:session-events' },
      },
    ],
  );
});

test('reuses terminal controller identity after an ambiguous acquire response', async () => {
  const controllerIds: string[] = [];
  let attempt = 0;
  const ref = 'maka://runtime/background-tasks/shell-1';
  const ipc = ipcHarness();
  registerDomainsIpc(
    {
      client: domainClient({
        acquireRuntimeResourceController: async (input) => {
          controllerIds.push(input.controllerId);
          attempt += 1;
          if (attempt === 1) throw new Error('response lost');
          return {
            controllerId: input.controllerId,
            nextSequence: 4,
            pty: {
              sessionId: input.sessionId,
              ref: input.ref,
              sequence: 3,
              buffer: 'ready',
              size: { cols: 80, rows: 24 },
            },
          };
        },
      }),
      emitModeChanged() {},
      newId: () => 'stable-id',
    },
    ipc,
  );

  await assert.rejects(
    ipc.invoke('shell-runs:attach', { sessionId: 'session-1', ref }),
    /response lost/,
  );
  assert.equal(
    (await ipc.invoke('shell-runs:attach', { sessionId: 'session-1', ref }) as {
      sequence: number;
    }).sequence,
    3,
  );
  assert.deepEqual(controllerIds, [
    'desktop-terminal-controller-stable-id',
    'desktop-terminal-controller-stable-id',
  ]);
});

test('restores terminal observation after the observer drops its registration', async () => {
  const ref = 'maka://runtime/background-tasks/shell-1';
  let observeCalls = 0;
  let observationActive = false;
  const ipc = ipcHarness();
  registerDomainsIpc(
    {
      client: domainClient({
        acquireRuntimeResourceController: async (input) => ({
          controllerId: input.controllerId,
          nextSequence: 4,
          pty: {
            sessionId: input.sessionId,
            ref: input.ref,
            sequence: 3,
            buffer: 'ready',
            size: { cols: 80, rows: 24 },
          },
        }),
      }),
      sessionObserver: {
        observe: async () => {
          observeCalls += 1;
          observationActive = true;
        },
        unobserve: async () => {
          observationActive = false;
        },
      },
      emitModeChanged() {},
      newId: () => 'stable-id',
    },
    ipc,
  );

  await ipc.invoke('shell-runs:attach', { sessionId: 'session-1', ref });
  observationActive = false;
  await ipc.invoke('shell-runs:attach', { sessionId: 'session-1', ref });

  assert.equal(observeCalls, 2);
  assert.equal(observationActive, true);
});

test('reacquires a missing terminal controller with protocol-exact identity fields', async () => {
  const ref = 'maka://runtime/background-tasks/shell-1';
  let acquired: unknown;
  const ipc = ipcHarness();
  registerDomainsIpc(
    {
      client: domainClient({
        acquireRuntimeResourceController: async (input) => {
          acquired = input;
          return {
            controllerId: input.controllerId,
            nextSequence: 4,
            pty: {
              sessionId: input.sessionId,
              ref: input.ref,
              sequence: 3,
              buffer: 'ready',
              size: { cols: 80, rows: 24 },
            },
          };
        },
        controlRuntimeResource: async (input) => ({
          controllerId: input.controllerId,
          sequence: input.sequence,
          resource: shellRunUpdate().result as never,
        }),
        getRuntimeResource: async () => shellRunUpdate(),
      }),
      emitModeChanged() {},
      newId: () => 'recovered-id',
    },
    ipc,
  );

  await ipc.invoke('shell-runs:write', {
    sessionId: 'session-1',
    ref,
    input: 'pwd\r',
  });

  assert.deepEqual(acquired, {
    sessionId: 'session-1',
    ref,
    controllerId: 'desktop-terminal-controller-recovered-id',
  });
});

test('adapts Plan controls and starts approved execution through one Host command', async () => {
  const calls: unknown[] = [];
  const state: PlanSessionState = {
    schemaVersion: 1,
    sessionId: 'session-1',
    storeVersion: 3,
    proposals: [],
    executions: [],
  };
  const ipc = ipcHarness();
  registerDomainsIpc(
    {
      client: domainClient({
        getPlanState: async () => state,
        controlPlan: async (input) => {
          calls.push({ kind: 'control', input });
          return {
            sessionId: 'session-1',
            storeVersion: 3,
            eventType: 'plan_revision_requested',
            proposalId: 'proposal-1',
            executionId: null,
          };
        },
        startPlanTurn: async (input) => {
          calls.push({ kind: 'start', input });
          return {
            plan: {
              sessionId: 'session-1',
              storeVersion: 4,
              eventType:
                input.kind === 'approve_proposal'
                  ? 'plan_approved'
                  : 'plan_execution_resumed',
              proposalId: input.kind === 'approve_proposal' ? 'proposal-1' : null,
              executionId: 'execution-1',
            },
            turn: {
              sessionId: 'session-1',
              turnId: input.turnId,
              runId: 'run-1',
              status: 'running',
            },
          };
        },
      }),
      emitModeChanged: (sessionId) => calls.push({ kind: 'changed', sessionId }),
      newId: (() => {
        let sequence = 0;
        return () => `operation-${++sequence}`;
      })(),
    },
    ipc,
  );

  assert.deepEqual(await ipc.invoke('plan-mode:requestRevision', 'session-1', 'proposal-1'), state);
  const approvalInput = {
    proposalId: 'proposal-1',
    expectedRevision: 2,
    expectedStoreVersion: 3,
    turnId: 'approval-turn',
  };
  assert.deepEqual(
    await ipc.invoke('plan-mode:approve', 'session-1', approvalInput),
    { turnId: 'approval-turn', executionId: 'execution-1' },
  );
  assert.deepEqual(
    await ipc.invoke('plan-mode:approve', 'session-1', approvalInput),
    { turnId: 'approval-turn', executionId: 'execution-1' },
  );
  assert.deepEqual(
    await ipc.invoke('plan-mode:resume', 'session-1', 'execution-1', 'resume-turn'),
    {
      turnId: 'resume-turn',
      executionId: 'execution-1',
    },
  );
  assert.deepEqual(
    await ipc.invoke('plan-mode:resume', 'session-1', 'execution-1', 'resume-turn'),
    {
      turnId: 'resume-turn',
      executionId: 'execution-1',
    },
  );
  assert.deepEqual(calls, [
    {
      kind: 'control',
      input: {
        kind: 'request_revision',
        sessionId: 'session-1',
        proposalId: 'proposal-1',
        operationId: 'operation-1',
      },
    },
    { kind: 'changed', sessionId: 'session-1' },
    {
      kind: 'start',
      input: {
        kind: 'approve_proposal',
        sessionId: 'session-1',
        proposalId: 'proposal-1',
        expectedRevision: 2,
        expectedStoreVersion: 3,
        turnId: 'approval-turn',
      },
    },
    { kind: 'changed', sessionId: 'session-1' },
    {
      kind: 'start',
      input: {
        kind: 'approve_proposal',
        sessionId: 'session-1',
        proposalId: 'proposal-1',
        expectedRevision: 2,
        expectedStoreVersion: 3,
        turnId: 'approval-turn',
      },
    },
    { kind: 'changed', sessionId: 'session-1' },
    {
      kind: 'start',
      input: {
        kind: 'resume_execution',
        sessionId: 'session-1',
        executionId: 'execution-1',
        turnId: 'resume-turn',
      },
    },
    { kind: 'changed', sessionId: 'session-1' },
    {
      kind: 'start',
      input: {
        kind: 'resume_execution',
        sessionId: 'session-1',
        executionId: 'execution-1',
        turnId: 'resume-turn',
      },
    },
    { kind: 'changed', sessionId: 'session-1' },
  ]);
});

test('publishes typed invalidations and refreshes only changed Runtime Resources', async () => {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  let listCalls = 0;
  const gets: Array<{ sessionId: string; ref: string }> = [];
  const update = shellRunUpdate({
    sessionId: 'session-1',
    ownership: {
      kind: 'source_owned',
      sourceSessionId: 'parent-session',
      ownerSessionId: 'parent-session',
    },
  });
  const ipc = ipcHarness();
  const handle = registerDomainsIpc(
    {
      client: domainClient({
        listRuntimeResources: async () => {
          listCalls += 1;
          return [];
        },
        getRuntimeResource: async (sessionId, ref) => {
          gets.push({ sessionId, ref });
          return update;
        },
      }),
      emitModeChanged() {},
      sendToRenderer: (channel, payload) => sent.push({ channel, payload }),
      now: () => 12,
    },
    ipc,
  );

  handle.sessionDomainChanged({ sessionId: 'session-1', domain: 'task' });
  handle.sessionDomainChanged({ sessionId: 'session-1', domain: 'deep_research' });
  handle.sessionDomainChanged({ sessionId: 'session-1', domain: 'plan' });
  handle.sessionDomainChanged({
    sessionId: 'session-1',
    domain: 'runtime_resource',
    resources: [{ sourceSessionId: 'parent-session', ref: update.result.ref }],
  });
  handle.agentGraphChanged({
    schemaVersion: 1,
    rootSessionId: 'session-1',
    graphId: 'graph-1',
    reason: 'runtime_activity',
  });
  handle.runtimeResourcePtyData({
    sessionId: 'session-1',
    ref: update.result.ref,
    sequence: 4,
    data: 'ready',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listCalls, 0);
  assert.deepEqual(gets, [{ sessionId: 'session-1', ref: update.result.ref }]);
  assert.deepEqual(sent, [
    {
      channel: 'tasks:changed',
      payload: { sessionId: 'session-1', taskIds: [], at: 12 },
    },
    {
      channel: 'deepResearch:changed',
      payload: { sessionId: 'session-1', ts: 12 },
    },
    {
      channel: 'plan-mode:changed',
      payload: { sessionId: 'session-1' },
    },
    {
      channel: 'graphs:changed',
      payload: {
        schemaVersion: 1,
        rootSessionId: 'session-1',
        graphId: 'graph-1',
        reason: 'runtime_activity',
      },
    },
    {
      channel: 'shell-runs:pty-data',
      payload: {
        sessionId: 'session-1',
        ref: update.result.ref,
        sequence: 4,
        data: 'ready',
      },
    },
    {
      channel: 'shell-runs:update',
      payload: update,
    },
  ]);

  sent.length = 0;
  handle.sessionSubscriptionRecovered('session-1');
  assert.deepEqual(sent, [
    {
      channel: 'tasks:changed',
      payload: { sessionId: 'session-1', taskIds: [], at: 12 },
    },
    {
      channel: 'deepResearch:changed',
      payload: { sessionId: 'session-1', ts: 12 },
    },
    {
      channel: 'plan-mode:changed',
      payload: { sessionId: 'session-1' },
    },
    {
      channel: 'graphs:resync',
      payload: { rootSessionId: 'session-1' },
    },
    {
      channel: 'shell-runs:resync',
      payload: { sessionId: 'session-1' },
    },
  ]);
});

test('projects embedded and hosted Deep Research into one renderer contract', () => {
  const run: DeepResearchRun = {
    schemaVersion: 1,
    sessionId: 'session-1',
    objective: 'Inspect the adapter',
    scopeLevel: 'standard',
    status: 'blocked',
    stage: 'knowledge_base',
    round: 1,
    createdAt: 1,
    updatedAt: 2,
    artifacts: [],
    checklist: [],
    steps: [{
      stepId: 'step-1',
      kind: 'local_exploration',
      status: 'blocked',
      objective: 'Inspect the adapter',
      summary: 'The adapter cannot continue.',
      roots: [],
      keywords: [],
      ignoredPaths: [],
      stoppingCondition: 'The boundary is known.',
      expectedEvidence: 'A stable projection.',
      evidenceArtifactIds: [],
      inspectedRefs: [],
      workerRunIds: [],
      blockedReason: 'Runtime credentials are unavailable.',
      createdAt: 2,
    }],
    reportSections: [],
    checkpoints: [],
  };
  const embedded = projectEmbeddedDeepResearch(run);
  const hosted = projectHostedDeepResearch(
    encodeDeepResearchSnapshot(projectDeepResearchClientProgress(run), 1),
  );

  assert.deepEqual(hosted, embedded);
  assert.deepEqual(hosted?.blockers, [
    'Inspect the adapter: Runtime credentials are unavailable.',
  ]);

  const checklistBlocked = structuredClone(run);
  checklistBlocked.checklist = [{
    itemId: 'blocked-item',
    title: '🙂'.repeat(240),
    status: 'blocked',
    evidenceArtifactIds: [],
    blockedReason: 'Credentials are unavailable.',
    updatedAt: 2,
  }];
  assert.match(
    projectDeepResearchClientProgress(checklistBlocked).blockers[0] ?? '',
    /Credentials are unavailable\./,
  );

  const stepBlocked = structuredClone(run);
  if (!stepBlocked.steps[0]) throw new Error('Missing Deep Research step fixture');
  stepBlocked.steps[0].objective = '🙂'.repeat(240);
  assert.match(
    projectDeepResearchClientProgress(stepBlocked).blockers.at(-1) ?? '',
    /Runtime credentials are unavailable\./,
  );
});

function domainClient(overrides: Partial<DomainClient>): DomainClient {
  const unavailable = async () => {
    throw new Error('Unexpected domain operation');
  };
  return {
    clearGoal: unavailable,
    acquireRuntimeResourceController: unavailable,
    controlPlan: unavailable,
    controlRuntimeResource: unavailable,
    getRuntimeResource: unavailable,
    getPlanState: unavailable,
    listRuntimeResources: unavailable,
    listTasks: unavailable,
    queryAgentGraph: unavailable,
    queryAgentGraphOperator: unavailable,
    queryDeepResearch: unavailable,
    queryGoal: unavailable,
    releaseRuntimeResourceController: unavailable,
    startRuntimeResource: unavailable,
    stopAgentGraph: unavailable,
    stopRuntimeResource: unavailable,
    ...overrides,
  } as DomainClient;
}

function goalProjection() {
  return {
    goalId: 'goal-1',
    revision: 3,
    sessionId: 'session-1',
    condition: 'Finish the adapter',
    status: 'active' as const,
    setAt: 1,
    iterations: 2,
    maxIterations: 20,
    consecutiveNoProgress: 0,
    blockCap: 8,
    tokenBudget: 1_000,
    tokensSpent: 120,
    lastReason: null,
    achievedAt: null,
    pausedAt: null,
  };
}

function hostedResearch() {
  return {
    kind: 'snapshot' as const,
    sessionId: 'session-1',
    revision: 4,
    objective: 'Inspect the adapter',
    scopeLevel: 'standard' as const,
    status: 'completed' as const,
    stage: 'completed' as const,
    round: 2,
    createdAt: 1,
    updatedAt: 2,
    artifactsCount: 4,
    stepsCount: 3,
    checklist: [
      {
        itemId: 'entrypoints',
        title: 'Map entrypoints',
        status: 'completed' as const,
        blockedReason: null,
      },
    ],
    reportSections: [{ key: 'conclusion' as const, status: 'completed' as const }],
    recentInspectedRefs: [
      {
        kind: 'file' as const,
        locator: 'apps/desktop/src/main/runtime-host-boot.ts',
        label: null,
      },
    ],
    workerRunIds: ['run-1'],
    blockers: [],
    reportArtifactId: 'artifact-1',
    implementationPrompt: 'Implement the result.',
  };
}

function shellRunUpdate(overrides: Partial<ShellRunUpdate> = {}): ShellRunUpdate {
  return {
    sessionId: 'session-1',
    ownership: { kind: 'local' },
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'tool-1',
    result: {
      kind: 'shell_run',
      ref: 'shell:run-1',
      mode: 'pipes',
      status: 'running',
      cwd: '/workspace',
      cmd: 'sleep 60',
      startedAt: 1,
      updatedAt: 2,
      revision: 2,
      output: {
        mode: 'pipes',
        stdout: 'ready',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        redacted: false,
      },
    },
    ...overrides,
  };
}

type IpcHandler = Parameters<Pick<IpcMain, 'handle'>['handle']>[1];

function ipcHarness() {
  const handlers = new Map<string, IpcHandler>();
  return {
    handle(channel: string, handler: IpcHandler) {
      assert.equal(handlers.has(channel), false, `duplicate handler: ${channel}`);
      handlers.set(channel, handler);
    },
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      const handler = handlers.get(channel);
      assert.ok(handler, `missing handler: ${channel}`);
      return handler({} as never, ...args);
    },
  };
}

function registerDomainsIpc(
  deps: Omit<RuntimeHostSessionDomainsIpcDeps, 'sessionObserver'> &
    Partial<Pick<RuntimeHostSessionDomainsIpcDeps, 'sessionObserver'>>,
  ipcMain: Pick<IpcMain, 'handle'>,
) {
  return registerRuntimeHostSessionDomainsIpc(
    {
      ...deps,
      sessionObserver: deps.sessionObserver ?? {
        async observe() {},
        async unobserve() {},
      },
    },
    ipcMain,
  );
}
