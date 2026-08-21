import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWorkHubInternalSession,
  decodeRuntimeHostWorkHubIntent,
  looksLikeWorkHubCoordination,
  resolveDeterministicWorkHubCoordination,
  resolveExplicitUncertaintyFallback,
  watchWorkHubTurnWithTimeout,
} from '../workhub/runtime-host-workhub-host.js';
import type { WorkHubCandidate } from '../workhub/work-orchestrator.js';
import type { SessionCatalogProjection, SessionCreateInput } from '@maka/runtime-host/protocol';

const candidates: WorkHubCandidate[] = [{
  candidateId: 'host-a:session-login',
  work: { workspaceId: 'host-a', sessionId: 'session-login' },
  projectName: 'Maka',
  workName: 'Login timeout',
  permissionMode: 'ask',
  searchableText: 'authentication refresh token timeout',
  archived: false,
}];

test('accepts only semantic target ids from the bounded candidate set', () => {
  assert.deepEqual(
    decodeRuntimeHostWorkHubIntent(
      '{"kind":"resume_work","candidateId":"host-a:session-login"}',
      candidates,
      'host-a',
    ),
    { kind: 'resume_work', candidateId: 'host-a:session-login' },
  );
  assert.equal(
    decodeRuntimeHostWorkHubIntent(
      '{"kind":"resume_work","candidateId":"invented"}',
      candidates,
      'host-a',
    ),
    undefined,
  );
});

test('binds model-created Work to the code-selected default Runtime Host', () => {
  assert.deepEqual(
    decodeRuntimeHostWorkHubIntent(
      '```json\n{"kind":"create_work","title":"Fix login timeout"}\n```',
      candidates,
      'host-a',
    ),
    { kind: 'create_work', workspaceId: 'host-a', title: 'Fix login timeout' },
  );
});

test('cleans and bounds the model-generated Chinese Work title', () => {
  assert.deepEqual(
    decodeRuntimeHostWorkHubIntent(
      '{"kind":"create_work","title":"标题：修复登录超时与刷新令牌续期。"}',
      [],
      'host-a',
    ),
    {
      kind: 'create_work',
      workspaceId: 'host-a',
      title: '修复登录超时与刷新令牌续期',
    },
  );
});

test('accepts a bounded cross-Work DAG using only supplied candidate ids', () => {
  const allCandidates = [
    ...candidates,
    {
      ...candidates[0]!,
      candidateId: 'host-b:session-client',
      work: { workspaceId: 'host-b', sessionId: 'session-client' },
      projectName: 'Client',
      workName: 'Update caller',
    },
  ];
  assert.deepEqual(
    decodeRuntimeHostWorkHubIntent(JSON.stringify({
      kind: 'coordinate', title: 'API rollout',
      nodes: [
        { nodeId: 'api', candidateId: 'host-a:session-login', instruction: 'Change API.' },
        { nodeId: 'client', candidateId: 'host-b:session-client', instruction: 'Update caller.' },
      ],
      edges: [{ fromNodeId: 'api', toNodeId: 'client' }],
    }), allCandidates, 'host-a'),
    {
      kind: 'coordinate', title: 'API rollout',
      nodes: [
        { nodeId: 'api', candidateId: 'host-a:session-login', instruction: 'Change API.' },
        { nodeId: 'client', candidateId: 'host-b:session-client', instruction: 'Update caller.' },
      ],
      edges: [{ fromNodeId: 'api', toNodeId: 'client' }],
    },
  );
  assert.equal(
    decodeRuntimeHostWorkHubIntent(JSON.stringify({
      kind: 'coordinate', title: 'Invented',
      nodes: [
        { nodeId: 'a', candidateId: 'host-a:session-login', instruction: 'A' },
        { nodeId: 'b', candidateId: 'invented', instruction: 'B' },
      ], edges: [],
    }), allCandidates, 'host-a'),
    undefined,
  );
});

test('detects explicit ordering language before deterministic single-Work routing', () => {
  assert.equal(looksLikeWorkHubCoordination('先修改接口，然后更新调用方', 2), true);
  assert.equal(looksLikeWorkHubCoordination('Continue the login timeout work.', 2), false);
  assert.equal(looksLikeWorkHubCoordination('First A, then B.', 1), false);
});

test('builds a deterministic Graph only from unambiguously named existing Works', () => {
  const allCandidates = [
    ...candidates,
    {
      ...candidates[0]!,
      candidateId: 'host-b:session-hi',
      work: { workspaceId: 'host-b', sessionId: 'session-hi' },
      projectName: 'Client',
      workName: 'hi',
    },
  ];
  assert.deepEqual(
    resolveDeterministicWorkHubCoordination(
      'First summarize Login timeout, then summarize hi after the first completes.',
      allCandidates,
    ),
    {
      kind: 'coordinate',
      title: 'Coordinate Login timeout → hi',
      nodes: [
        {
          nodeId: 'step_1',
          candidateId: 'host-a:session-login',
          instruction: 'In Maka / Login timeout, complete the relevant part of this coordinated request: First summarize Login timeout, then summarize hi after the first completes.',
        },
        {
          nodeId: 'step_2',
          candidateId: 'host-b:session-hi',
          instruction: 'In Client / hi, complete the relevant part of this coordinated request: First summarize Login timeout, then summarize hi after the first completes.',
        },
      ],
      edges: [{ fromNodeId: 'step_1', toNodeId: 'step_2' }],
      routing: { confidence: 'high', source: 'coordination' },
    },
  );
  assert.equal(
    resolveDeterministicWorkHubCoordination('Coordinate two greeting Works.', allCandidates),
    undefined,
  );
  assert.equal(
    resolveDeterministicWorkHubCoordination('Continue this work.', allCandidates),
    undefined,
  );
});

test('creates a hidden WorkHub Session through a declared chat boundary before making it read-only', async () => {
  const projection = { id: 'router-session' } as unknown as SessionCatalogProjection;
  const createInputs: SessionCreateInput[] = [];
  const updates: Array<{ sessionId: string; permissionMode: string }> = [];
  const client = {
    async createSession(input: SessionCreateInput) {
      createInputs.push(input);
      if (input.permissionMode === 'explore') {
        throw new Error('Session creation requires a declared mode for explore permission');
      }
      return projection;
    },
    async updateSessionConfiguration(sessionId: string, patch: { permissionMode?: string }) {
      updates.push({ sessionId, permissionMode: patch.permissionMode ?? '' });
      return { ...projection, permissionMode: patch.permissionMode } as SessionCatalogProjection;
    },
  } as Parameters<typeof createWorkHubInternalSession>[0];

  const result = await createWorkHubInternalSession(client, {
    sessionId: 'router-session',
    workspace: { kind: 'host_path', path: '/repo' },
    name: 'WorkHub Router',
    labels: ['maka:workhub-router-internal'],
    modelTarget: { kind: 'default' },
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  });

  assert.equal(result.permissionMode, 'explore');
  assert.equal(createInputs[0]?.permissionMode, 'ask');
  assert.deepEqual(updates, [{ sessionId: 'router-session', permissionMode: 'explore' }]);
});

test('stops a hidden router Turn and falls back when semantic routing times out', async () => {
  let stopped = false;
  const stops: Array<{ sessionId: string; turnId: string; runId: string }> = [];
  const client = {
    async queryTurn() {
      return stopped
        ? { status: 'cancelled', abortSource: 'user' }
        : { status: 'running' };
    },
    async stopTurn(input: { sessionId: string; turnId: string; runId: string }) {
      stops.push(input);
      stopped = true;
      return { status: 'cancelled', abortSource: 'user' };
    },
  } as unknown as Parameters<typeof watchWorkHubTurnWithTimeout>[0];

  const outcome = await watchWorkHubTurnWithTimeout(
    client,
    'router-session',
    'router-turn',
    'router-run',
    1,
  );

  assert.equal(outcome, undefined);
  assert.deepEqual(stops, [{
    sessionId: 'router-session',
    turnId: 'router-turn',
    runId: 'router-run',
  }]);
});

test('asks in Chinese instead of creating a Work when the user explicitly names uncertainty', () => {
  const alternatives = [
    ...candidates,
    {
      ...candidates[0]!,
      candidateId: 'host-b:session-greeting',
      work: { workspaceId: 'host-b', sessionId: 'session-greeting' },
      workName: 'Greeting follow-up',
    },
  ];
  assert.deepEqual(
    resolveExplicitUncertaintyFallback(
      '继续处理问候相关的工作，但我不确定具体是哪一个',
      alternatives,
      { kind: 'create_work', workspaceId: 'host-a', title: '问候相关工作' },
    ),
    {
      kind: 'clarify',
      candidateIds: ['host-a:session-login', 'host-b:session-greeting'],
      question: '你指的是哪一项工作？',
      routing: { confidence: 'low', source: 'semantic' },
    },
  );
});

test('keeps semantic routing bounded even when stopping the hidden Turn fails', async () => {
  const client = {
    async queryTurn() {
      return { status: 'running' };
    },
    async stopTurn() {
      throw new Error('host unavailable');
    },
  } as unknown as Parameters<typeof watchWorkHubTurnWithTimeout>[0];
  const startedAt = Date.now();

  const outcome = await watchWorkHubTurnWithTimeout(
    client,
    'router-session',
    'router-turn',
    'router-run',
    1,
  );

  assert.equal(outcome, undefined);
  assert.ok(Date.now() - startedAt < 100, 'timeout fallback should not await Turn cleanup');
});
