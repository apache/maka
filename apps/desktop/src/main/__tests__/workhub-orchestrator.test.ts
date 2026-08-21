import assert from 'node:assert/strict';
import test from 'node:test';
import type { AttachmentIngestItem } from '@maka/core/events';
import type { PermissionMode } from '@maka/core/permission';
import type {
  WorkHubCommand,
  WorkHubCommandResult,
  WorkHubEvent,
  WorkHubSnapshot,
  WorkHubWorkRef,
} from '@maka/core/workhub';
import {
  createWorkHubOrchestrator,
  type WorkHubCandidate,
  type WorkHubHostDirectory,
  type WorkHubStateStore,
  type WorkHubTurnOutcome,
} from '../workhub/work-orchestrator.js';
import { createWorkHubIntentResolver } from '../workhub/workhub-intent-resolver.js';

test('中文指代“它”会继续最近焦点 Work，而不是创建新 Work', async () => {
  const login = workCandidate({
    candidateId: 'login',
    work: { workspaceId: 'workspace-1', sessionId: 'login' },
    projectName: 'Maka',
    workName: '登录超时',
    searchableText: '登录 超时 authentication timeout',
  });
  const payment = workCandidate({
    candidateId: 'payment',
    work: { workspaceId: 'workspace-1', sessionId: 'payment' },
    projectName: '商城',
    workName: '支付失败',
    searchableText: '支付 失败 payment error',
  });
  const harness = createHarness({
    candidates: [login, payment],
    resolveIntent: createWorkHubIntentResolver({ defaultWorkspaceId: () => 'workspace-1' }),
  });

  const named = await harness.orchestrator.handle({
    kind: 'submit', requestId: 'focus-named', text: '继续修复登录超时',
  });
  assert.equal(named.kind, 'work');
  assert.deepEqual(harness.host.startCalls[0]?.work, login.work);

  const referred = await harness.orchestrator.handle({
    kind: 'submit', requestId: 'focus-pronoun', text: '接着把它修完',
  });
  assert.equal(referred.kind, 'work');
  assert.deepEqual(harness.host.startCalls[1]?.work, login.work);
});

test('中文“上一个工作”会从最近焦点历史返回前一个 Work', async () => {
  const login = workCandidate({
    candidateId: 'login',
    work: { workspaceId: 'workspace-1', sessionId: 'login' },
    workName: '登录超时',
    searchableText: '登录 超时',
  });
  const payment = workCandidate({
    candidateId: 'payment',
    work: { workspaceId: 'workspace-1', sessionId: 'payment' },
    workName: '支付失败',
    searchableText: '支付 失败',
  });
  const harness = createHarness({
    candidates: [login, payment],
    resolveIntent: createWorkHubIntentResolver({ defaultWorkspaceId: () => 'workspace-1' }),
  });

  await harness.orchestrator.handle({
    kind: 'submit', requestId: 'history-login', text: '继续登录超时工作',
  });
  await harness.orchestrator.handle({
    kind: 'submit', requestId: 'history-payment', text: '继续支付失败工作',
  });
  const previous = await harness.orchestrator.handle({
    kind: 'submit', requestId: 'history-previous', text: '回到上一个工作继续处理',
  });

  assert.equal(previous.kind, 'work');
  assert.deepEqual(harness.host.startCalls[2]?.work, login.work);
});

test('结构化 Work 记忆会用此前请求中的实体找回非当前焦点', async () => {
  const login = workCandidate({
    candidateId: 'login-memory',
    work: { workspaceId: 'workspace-1', sessionId: 'login-memory' },
    projectName: 'Maka',
    workName: '登录稳定性排查',
    searchableText: '登录 稳定性 authentication reliability',
  });
  const payment = workCandidate({
    candidateId: 'payment-memory',
    work: { workspaceId: 'workspace-1', sessionId: 'payment-memory' },
    projectName: '商城',
    workName: '支付稳定性排查',
    searchableText: '支付 稳定性 payment reliability',
  });
  const harness = createHarness({
    candidates: [login, payment],
    resolveIntent: createWorkHubIntentResolver({ defaultWorkspaceId: () => 'workspace-1' }),
  });

  await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'memory-seed',
    text: '检查刷新令牌过期后的重试逻辑',
    explicitWork: login.work,
  });
  await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'memory-move-focus',
    text: '检查支付回调',
    explicitWork: payment.work,
  });

  const memory = (await inspect(harness)).routingMemory?.works.find(
    (entry) => entry.work.sessionId === login.work.sessionId,
  );
  assert.ok(memory);
  assert.deepEqual(memory.aliases, ['登录稳定性排查', 'Maka / 登录稳定性排查']);
  assert.deepEqual(memory.recentRequests, ['检查刷新令牌过期后的重试逻辑']);
  assert.ok(memory.entities.includes('刷新令牌'));

  const recalled = await harness.orchestrator.handle({
    kind: 'submit', requestId: 'memory-recall', text: '刷新令牌过期的问题继续处理',
  });
  assert.equal(recalled.kind, 'work');
  assert.deepEqual(harness.host.startCalls[2]?.work, login.work);
});

test('混合召回会把 Host 词面 Top-N 之外的记忆 Work 重新加入候选', async () => {
  const identity = workCandidate({
    candidateId: 'identity-memory',
    work: { workspaceId: 'workspace-1', sessionId: 'identity-memory' },
    projectName: '账户中心',
    workName: '身份链路排查',
    searchableText: '身份 登录 稳定性',
  });
  const payment = workCandidate({
    candidateId: 'payment-visible',
    work: { workspaceId: 'workspace-1', sessionId: 'payment-visible' },
    projectName: '商城',
    workName: '支付链路排查',
    searchableText: '支付 回调 稳定性',
  });
  const lexicalOnly = Array.from({ length: 10 }, (_, index) => workCandidate({
    candidateId: `lexical-${index}`,
    work: { workspaceId: 'workspace-1', sessionId: `lexical-${index}` },
    projectName: '其他项目',
    workName: `普通排查 ${index}`,
    searchableText: '认证 常规 检查',
  }));
  const harness = createHarness({
    candidates: [identity, payment, ...lexicalOnly],
    listCandidates: () => [payment, ...lexicalOnly],
    resolveIntent: createWorkHubIntentResolver({ defaultWorkspaceId: () => 'workspace-1' }),
  });

  await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'hybrid-memory-seed',
    text: '检查 OIDC 登录握手状态校验',
    explicitWork: identity.work,
  });
  await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'hybrid-focus-move',
    text: '检查支付回调',
    explicitWork: payment.work,
  });

  const recalled = await harness.orchestrator.handle({
    kind: 'submit', requestId: 'hybrid-recall', text: '认证握手状态异常继续处理',
  });

  assert.equal(recalled.kind, 'work');
  assert.deepEqual(harness.host.startCalls[2]?.work, identity.work);
  assert.equal(harness.host.listCalls[0]?.limit, 32);
});

test('中文路由把名称命中、记忆命中和歧义分别标成高、中、低置信度', async () => {
  const login = workCandidate({
    candidateId: 'confidence-login',
    work: { workspaceId: 'workspace-1', sessionId: 'confidence-login' },
    projectName: 'Maka',
    workName: '登录超时',
    searchableText: '登录 超时',
  });
  const api = workCandidate({
    candidateId: 'confidence-api',
    work: { workspaceId: 'workspace-1', sessionId: 'confidence-api' },
    projectName: 'Maka',
    workName: '接口超时',
    searchableText: '接口 超时',
  });
  const harness = createHarness({
    candidates: [login, api],
    resolveIntent: createWorkHubIntentResolver({ defaultWorkspaceId: () => 'workspace-1' }),
  });

  const named = await harness.orchestrator.handle({
    kind: 'submit', requestId: 'confidence-name', text: '继续修复登录超时',
  });
  assert.equal(named.kind, 'work');
  if (named.kind === 'work') {
    assert.equal(named.block.routing?.confidence, 'high');
    assert.equal(named.block.routing?.source, 'name');
  }

  const ambiguousHarness = createHarness({
    candidates: [login, api],
    resolveIntent: createWorkHubIntentResolver({ defaultWorkspaceId: () => 'workspace-1' }),
  });
  const ambiguous = await ambiguousHarness.orchestrator.handle({
    kind: 'submit', requestId: 'confidence-low', text: '继续处理超时问题',
  });
  assert.equal(ambiguous.kind, 'clarification');
  if (ambiguous.kind === 'clarification') {
    assert.equal(ambiguous.item.routing?.confidence, 'low');
  }

  await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'confidence-memory-seed',
    text: '检查刷新令牌过期处理',
    explicitWork: api.work,
  });
  const remembered = await harness.orchestrator.handle({
    kind: 'submit', requestId: 'confidence-memory', text: '刷新令牌过期继续处理',
  });
  assert.equal(remembered.kind, 'work');
  if (remembered.kind === 'work') {
    assert.equal(remembered.block.routing?.confidence, 'medium');
    assert.equal(remembered.block.routing?.source, 'memory');
    assert.deepEqual(
      remembered.block.routing?.alternatives.map((option) => option.candidateId),
      [login.candidateId],
    );
  }
});

test('用户纠正中置信度路由后会停止误投 Work、重投目标并记住纠错', async () => {
  const login = workCandidate({
    candidateId: 'correction-login',
    work: { workspaceId: 'workspace-1', sessionId: 'correction-login' },
    projectName: '账户中心',
    workName: '登录稳定性',
    searchableText: '登录 稳定性',
  });
  const api = workCandidate({
    candidateId: 'correction-api',
    work: { workspaceId: 'workspace-1', sessionId: 'correction-api' },
    projectName: '网关',
    workName: '接口稳定性',
    searchableText: '接口 稳定性',
  });
  const harness = createHarness({
    candidates: [login, api],
    resolveIntent: createWorkHubIntentResolver({ defaultWorkspaceId: () => 'workspace-1' }),
  });
  await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'correction-seed',
    text: '排查握手状态失效后的重试',
    explicitWork: login.work,
  });
  await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'correction-focus',
    text: '检查接口状态',
    explicitWork: api.work,
  });
  const mistaken = await harness.orchestrator.handle({
    kind: 'submit', requestId: 'correction-mistaken', text: '握手状态失效继续处理',
  });
  assert.equal(mistaken.kind, 'work');
  if (mistaken.kind !== 'work') return;
  assert.equal(mistaken.block.routing?.confidence, 'medium');

  const corrected = await harness.orchestrator.handle({
    kind: 'correct_route',
    blockId: mistaken.block.id,
    work: api.work,
  });
  assert.equal(corrected.kind, 'work');
  if (corrected.kind === 'work') {
    assert.deepEqual(corrected.block.work, api.work);
    assert.equal(corrected.block.routing?.confidence, 'high');
    assert.equal(corrected.block.routing?.source, 'correction');
  }
  assert.deepEqual(harness.host.stopCalls, [login.work]);

  const snapshot = await inspect(harness);
  const original = snapshot.items.find(
    (item) => item.kind === 'work' && item.id === mistaken.block.id,
  );
  assert.equal(original?.kind, 'work');
  if (original?.kind === 'work') assert.deepEqual(original.routing?.correctedTo, api.work);
  const correction = snapshot.routingMemory?.corrections[0];
  assert.equal(correction?.query, '握手状态失效继续处理');
  assert.deepEqual(correction?.from, login.work);
  assert.deepEqual(correction?.to, api.work);
  assert.ok(correction && Number.isSafeInteger(correction.correctedAt));

  const learned = await harness.orchestrator.handle({
    kind: 'submit', requestId: 'correction-learned', text: '握手状态失效继续处理',
  });
  assert.equal(learned.kind, 'work');
  assert.deepEqual(harness.host.startCalls.at(-1)?.work, api.work);
});

test('exposes one command interface and one event subscription', () => {
  const harness = createHarness();
  assert.deepEqual(Object.keys(harness.orchestrator).sort(), ['handle', 'subscribe']);
});

test('keeps anonymous product metrics local and deduplicates retried submissions', async () => {
  const harness = createHarness({
    candidates: [workCandidate()],
    resolveIntent: async ({ text }) =>
      text.startsWith('Ambiguous') ? { kind: 'clarify' } : { kind: 'discussion' },
  });

  await harness.orchestrator.handle({ kind: 'record_metric', metric: 'workhub_opened' });
  await harness.orchestrator.handle({ kind: 'record_metric', metric: 'manual_session_switch' });
  const discussion = {
    kind: 'submit' as const,
    requestId: 'metrics-discussion',
    text: 'Discuss this.',
  };
  await harness.orchestrator.handle(discussion);
  await harness.orchestrator.handle(discussion);
  await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'metrics-clarification',
    text: 'Ambiguous target.',
  });

  assert.deepEqual(await harness.orchestrator.handle({ kind: 'inspect_metrics' }), {
    kind: 'metrics',
    metrics: {
      workhubOpened: 1,
      submissions: 2,
      clarifications: 1,
      manualSessionSwitches: 1,
    },
  });
});

test('keeps discussion in WorkHub without starting a target Session', async () => {
  const harness = createHarness({
    resolveIntent: async () => ({ kind: 'discussion' }),
  });
  const events: WorkHubEvent[] = [];
  harness.orchestrator.subscribe((event) => events.push(event));

  const result = await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'request-1',
    text: 'Could the timeout come from token refresh?',
  });

  assert.equal(result.kind, 'discussion');
  assert.equal(harness.host.startCalls.length, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'snapshot_changed');
  const snapshot = await inspect(harness);
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.items[0]?.kind, 'discussion');
  assert.equal(snapshot.items[1]?.kind, 'discussion');
});

test('projects a model-backed Discussion answer without creating a Work', async () => {
  const answer = deferred<string>();
  const harness = createHarness({
    answerDiscussion: () => answer.promise,
    resolveIntent: async () => ({ kind: 'discussion' }),
  });
  await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'request-discussion-answer',
    text: 'Could this be related to token refresh?',
  });

  answer.resolve('Yes. An expired refresh token is one plausible cause.');
  await waitFor(async () =>
    (await inspect(harness)).items.some(
      (item) => item.kind === 'discussion' && item.role === 'assistant' && item.status === 'completed',
    ),
  );
  const snapshot = await inspect(harness);
  const assistant = snapshot.items.find(
    (item) => item.kind === 'discussion' && item.role === 'assistant',
  );
  assert.equal(assistant?.kind, 'discussion');
  if (assistant?.kind === 'discussion') {
    assert.equal(assistant.text, 'Yes. An expired refresh token is one plausible cause.');
  }
  assert.equal(harness.host.startCalls.length, 0);
});

test('passes the composer model to semantic routing and WorkHub discussion', async () => {
  const routed: unknown[] = [];
  const answered: unknown[] = [];
  const harness = createHarness({
    resolveIntent: async (input) => {
      routed.push(input.modelSelection);
      return { kind: 'discussion' };
    },
    answerDiscussion: async (input) => {
      answered.push(input.modelSelection);
      return 'Ready.';
    },
  });
  const modelSelection = { llmConnectionSlug: 'primary', model: 'model-a' };

  await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'request-model-selection',
    text: 'Help me understand the current state.',
    modelSelection,
  });

  assert.deepEqual(routed, [modelSelection]);
  assert.deepEqual(answered, [modelSelection]);
});

test('deduplicates a retried submit request before consulting routing again', async () => {
  let resolverCalls = 0;
  const harness = createHarness({
    resolveIntent: async () => {
      resolverCalls += 1;
      return { kind: 'discussion' };
    },
  });
  const command = {
    kind: 'submit' as const,
    requestId: 'request-retried',
    text: 'Let us discuss this first.',
  };

  const first = await harness.orchestrator.handle(command);
  const second = await harness.orchestrator.handle(command);

  assert.deepEqual(second, first);
  assert.equal(resolverCalls, 1);
  assert.equal(harness.host.listCalls.length, 1);
  assert.equal((await inspect(harness)).items.length, 2);
});

test('treats an explicit Work as a hard binding and projects its later outcome', async () => {
  const completion = deferred<WorkHubTurnOutcome>();
  const candidate = workCandidate({ archived: true });
  const harness = createHarness({
    candidates: [candidate],
    completion: completion.promise,
    resolveIntent: async () => {
      throw new Error('explicit binding must bypass semantic routing');
    },
  });

  const result = await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'request-bound',
    text: 'Continue and give one concrete recommendation.',
    explicitWork: candidate.work,
  });

  assert.equal(result.kind, 'work');
  if (result.kind !== 'work') return;
  assert.equal(result.block.status, 'running');
  assert.equal(result.block.turnId, 'turn-1');
  assert.deepEqual(harness.host.restoreCalls, [candidate.work]);
  assert.deepEqual(harness.host.startCalls, [
    { work: candidate.work, text: 'Continue and give one concrete recommendation.' },
  ]);

  completion.resolve({ status: 'completed', detail: 'Recommendation ready.' });
  await waitFor(async () => (await inspect(harness)).items.some(
    (item) => item.kind === 'work' && item.status === 'completed',
  ));
  const snapshot = await inspect(harness);
  const block = snapshot.items.find((item) => item.kind === 'work');
  assert.equal(block?.kind, 'work');
  if (block?.kind === 'work') {
    assert.equal(block.status, 'completed');
    assert.equal(block.detail, 'Recommendation ready.');
  }
});

test('forwards attachments only when the user has explicitly selected a Work', async () => {
  const candidate = workCandidate();
  const harness = createHarness({ candidates: [candidate] });
  const attachmentItems: AttachmentIngestItem[] = [{
    name: 'requirements.txt',
    mimeType: 'text/plain',
    base64: '5paw55qE6ZyA5rGC',
  }];

  const result = await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'request-with-attachment',
    text: 'Use the attached requirements.',
    explicitWork: candidate.work,
    attachmentItems,
  });

  assert.equal(result.kind, 'work');
  assert.deepEqual(harness.host.startCalls[0], {
    work: candidate.work,
    text: 'Use the attached requirements.',
    attachmentItems,
  });

  await assert.rejects(
    harness.orchestrator.handle({
      kind: 'submit',
      requestId: 'request-without-target',
      text: 'Use this attachment somewhere.',
      attachmentItems,
    }),
    /WORKHUB_ATTACHMENTS_REQUIRE_TARGET/,
  );
  assert.equal(harness.host.startCalls.length, 1);
});

test('degrades an invented semantic target to bounded clarification options', async () => {
  const candidate = workCandidate();
  const harness = createHarness({
    candidates: [candidate],
    resolveIntent: async () => ({ kind: 'resume_work', candidateId: 'invented-target' }),
  });

  const result = await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'request-invented',
    text: 'Fix that issue.',
  });

  assert.equal(result.kind, 'clarification');
  if (result.kind !== 'clarification') return;
  assert.deepEqual(result.item.options.map((option) => option.candidateId), [
    candidate.candidateId,
  ]);
  assert.equal(harness.host.startCalls.length, 0);
});

test('filters invented clarification ids instead of exposing model-created targets', async () => {
  const first = workCandidate();
  const second = workCandidate({
    candidateId: 'candidate-2',
    work: { workspaceId: 'workspace-1', sessionId: 'session-2' },
    workName: 'Authentication timeout audit',
  });
  const harness = createHarness({
    candidates: [first, second],
    resolveIntent: async () => ({
      kind: 'clarify',
      candidateIds: ['candidate-2', 'invented-target'],
      question: 'Which authentication task?',
    }),
  });

  const result = await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'request-clarify',
    text: 'Continue the authentication task.',
  });

  assert.equal(result.kind, 'clarification');
  if (result.kind === 'clarification') {
    assert.equal(result.item.question, 'Which authentication task?');
    assert.deepEqual(result.item.options.map((option) => option.candidateId), ['candidate-2']);
  }
});

test('keeps clarification candidates bounded even if a Host adapter over-returns', async () => {
  const candidates = Array.from({ length: 10 }, (_, index) =>
    workCandidate({
      candidateId: `candidate-${index}`,
      work: { workspaceId: 'workspace-1', sessionId: `session-${index}` },
      workName: `Work ${index}`,
    }),
  );
  const harness = createHarness({
    candidates,
    resolveIntent: async () => ({ kind: 'clarify' }),
  });

  const result = await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'request-bounded',
    text: 'Continue one of those Works.',
  });

  assert.equal(result.kind, 'clarification');
  if (result.kind === 'clarification') assert.equal(result.item.options.length, 8);
  assert.equal(harness.host.listCalls[0]?.limit, 32);
});

test('resolving a clarification is idempotent and makes the old card non-actionable', async () => {
  const candidate = workCandidate();
  const harness = createHarness({
    candidates: [candidate],
    resolveIntent: async () => ({ kind: 'clarify' }),
  });
  const result = await harness.orchestrator.handle({
    kind: 'submit', requestId: 'clarification-once', text: '继续那个工作。',
  });
  assert.equal(result.kind, 'clarification');
  if (result.kind !== 'clarification') return;

  const command: WorkHubCommand = {
    kind: 'resolve_clarification',
    clarificationId: result.item.id,
    work: candidate.work,
  };
  const first = await harness.orchestrator.handle(command);
  const second = await harness.orchestrator.handle(command);

  assert.equal(first.kind, 'work');
  assert.deepEqual(second, first);
  assert.equal(harness.host.startCalls.length, 1);
  const clarification = (await inspect(harness)).items.find((item) => item.id === result.item.id);
  assert.equal(clarification?.kind, 'clarification');
  if (clarification?.kind === 'clarification') {
    assert.deepEqual(clarification.resolvedTo, candidate.work);
    assert.equal(typeof clarification.resolvedAt, 'number');
  }
});

test('reconciles a legacy clarification that was completed by the old resubmit flow', async () => {
  const candidate = workCandidate();
  const clarificationId = 'legacy-clarification';
  const harness = createHarness({
    candidates: [candidate],
    initialSnapshot: {
      revision: 2,
      items: [
        {
          kind: 'clarification',
          id: clarificationId,
          sourceRequestId: 'legacy-question',
          text: '继续重复问题。',
          question: '你指的是哪项工作？',
          options: [candidate],
          createdAt: 10,
        },
        {
          kind: 'work',
          id: 'legacy-answer-work',
          sourceRequestId: 'legacy-random-resubmit',
          work: candidate.work,
          projectName: candidate.projectName,
          workName: candidate.workName,
          requestText: '继续重复问题。',
          permissionMode: candidate.permissionMode,
          status: 'completed',
          createdAt: 11,
          updatedAt: 12,
        },
      ],
    },
  });

  const snapshot = await inspect(harness);
  const clarification = snapshot.items.find((item) => item.id === clarificationId);
  assert.equal(clarification?.kind, 'clarification');
  if (clarification?.kind === 'clarification') {
    assert.deepEqual(clarification.resolvedTo, candidate.work);
    assert.equal(clarification.resolvedAt, 11);
  }
  const replay = await harness.orchestrator.handle({
    kind: 'resolve_clarification', clarificationId, work: candidate.work,
  });
  assert.equal(replay.kind, 'work');
  assert.equal(harness.host.startCalls.length, 0);
});

test('a clarification remains actionable when its chosen Work still has a pending interaction', async () => {
  const candidate = workCandidate();
  const harness = createHarness({
    candidates: [candidate],
    resolveIntent: async () => ({ kind: 'clarify' }),
  });
  await harness.orchestrator.handle({
    kind: 'submit', requestId: 'waiting-before-clarification', text: '先检查。', explicitWork: candidate.work,
  });
  await harness.host.reportProgress?.({
    status: 'waiting_for_user',
    interaction: {
      interactionId: 'waiting-before-clarification-interaction',
      request: {
        kind: 'permission',
        toolUseId: 'waiting-before-clarification-tool',
        prompt: {
          kind: 'tool_permission',
          toolName: 'Bash',
          category: 'shell_unsafe',
          reason: 'shell_dangerous',
          review: { kind: 'command', command: 'npm test' },
          rememberForTurnAllowed: true,
        },
      },
    },
  });
  await waitFor(async () => (await inspect(harness)).items.some(
    (item) => item.kind === 'work' && item.status === 'waiting_for_user',
  ));
  const clarification = await harness.orchestrator.handle({
    kind: 'submit', requestId: 'clarification-while-waiting', text: '继续那个工作。',
  });
  assert.equal(clarification.kind, 'clarification');
  if (clarification.kind !== 'clarification') return;

  const result = await harness.orchestrator.handle({
    kind: 'resolve_clarification',
    clarificationId: clarification.item.id,
    work: candidate.work,
  });

  assert.equal(result.kind, 'work_waiting');
  const persisted = (await inspect(harness)).items.find((item) => item.id === clarification.item.id);
  assert.equal(persisted?.kind, 'clarification');
  if (persisted?.kind === 'clarification') assert.equal(persisted.resolvedTo, undefined);
  assert.equal(harness.host.startCalls.length, 1);
});

test('a new request for a Work waiting for the user returns an actionable state instead of starting a second root Turn', async () => {
  const candidate = workCandidate();
  const harness = createHarness({ candidates: [candidate] });
  await harness.orchestrator.handle({
    kind: 'submit', requestId: 'waiting-first', text: '先检查。', explicitWork: candidate.work,
  });
  await harness.host.reportProgress?.({
    status: 'waiting_for_user',
    interaction: {
      interactionId: 'waiting-interaction',
      request: {
        kind: 'permission',
        toolUseId: 'waiting-tool',
        prompt: {
          kind: 'tool_permission',
          toolName: 'Bash',
          category: 'shell_unsafe',
          reason: 'shell_dangerous',
          review: { kind: 'command', command: 'npm test' },
          rememberForTurnAllowed: true,
        },
      },
    },
  });
  await waitFor(async () => (await inspect(harness)).items.some(
    (item) => item.kind === 'work' && item.status === 'waiting_for_user',
  ));

  const result = await harness.orchestrator.handle({
    kind: 'submit', requestId: 'waiting-second', text: '再补充一项。', explicitWork: candidate.work,
  });

  assert.equal(result.kind, 'work_waiting');
  assert.equal(harness.host.startCalls.length, 1);
});

test('changing a Work permission updates every projected message block for the filtered Composer', async () => {
  const candidate = workCandidate({ permissionMode: 'execute' });
  const firstDone = deferred<WorkHubTurnOutcome>();
  const secondDone = deferred<WorkHubTurnOutcome>();
  const harness = createHarness({
    candidates: [candidate],
    completions: [firstDone.promise, secondDone.promise],
  });
  await harness.orchestrator.handle({
    kind: 'submit', requestId: 'permission-first', text: '第一项。', explicitWork: candidate.work,
  });
  firstDone.resolve({ status: 'completed', detail: '完成。' });
  await waitFor(async () => (await inspect(harness)).items.some(
    (item) => item.kind === 'work' && item.status === 'completed',
  ));
  await harness.orchestrator.handle({
    kind: 'submit', requestId: 'permission-second', text: '第二项。', explicitWork: candidate.work,
  });

  await harness.orchestrator.handle({
    kind: 'set_permission', work: candidate.work, mode: 'ask',
  });
  const blocks = (await inspect(harness)).items.filter(
    (item): item is Extract<WorkHubSnapshot['items'][number], { kind: 'work' }> =>
      item.kind === 'work' && item.work.sessionId === candidate.work.sessionId,
  );

  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((block) => block.permissionMode), ['ask', 'ask']);
});

test('creates a Work with the default permission through the same command interface', async () => {
  const created = workCandidate({
    candidateId: 'created-candidate',
    work: { workspaceId: 'workspace-2', sessionId: 'session-created' },
    permissionMode: 'execute',
    workName: 'Fix login timeout',
  });
  const harness = createHarness({
    createdCandidate: created,
    defaultPermissionMode: 'execute',
    resolveIntent: async () => ({
      kind: 'create_work',
      workspaceId: 'workspace-2',
      title: 'Fix login timeout',
    }),
  });

  const result = await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'request-create',
    text: 'Check the login timeout and fix it.',
    modelSelection: { llmConnectionSlug: 'primary', model: 'model-a' },
  });

  assert.equal(result.kind, 'work');
  assert.deepEqual(harness.host.createCalls, [
    {
      workspaceId: 'workspace-2',
      title: 'Fix login timeout',
      permissionMode: 'execute',
      modelSelection: { llmConnectionSlug: 'primary', model: 'model-a' },
    },
  ]);
  assert.equal(harness.host.startCalls[0]?.work.sessionId, 'session-created');
  assert.deepEqual(harness.host.startCalls[0]?.modelSelection, {
    llmConnectionSlug: 'primary',
    model: 'model-a',
  });
});

test('routes permission changes and stop through handle without widening the interface', async () => {
  const candidate = workCandidate();
  const harness = createHarness({ candidates: [candidate] });
  await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'request-control',
    text: 'Continue this Work.',
    explicitWork: candidate.work,
  });

  await harness.orchestrator.handle({
    kind: 'set_permission',
    work: candidate.work,
    mode: 'ask',
  });
  await harness.orchestrator.handle({ kind: 'stop_work', work: candidate.work });

  assert.deepEqual(harness.host.permissionCalls, [{ work: candidate.work, mode: 'ask' }]);
  assert.deepEqual(harness.host.stopCalls, [candidate.work]);
  const snapshot = await inspect(harness);
  const block = snapshot.items.find((item) => item.kind === 'work');
  assert.equal(block?.kind, 'work');
  if (block?.kind === 'work') {
    assert.equal(block.permissionMode, 'ask');
    assert.equal(block.status, 'stopped');
  }
});

test('answers a pending Host interaction through the same WorkHub block', async () => {
  const candidate = workCandidate();
  const harness = createHarness({ candidates: [candidate] });
  const result = await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'request-interaction',
    text: 'Continue this Work.',
    explicitWork: candidate.work,
  });
  assert.equal(result.kind, 'work');
  if (result.kind !== 'work') return;
  await harness.host.reportProgress?.({
    status: 'waiting_for_user',
    interaction: {
      interactionId: 'interaction-1',
      request: {
        kind: 'permission',
        toolUseId: 'tool-1',
        prompt: {
          kind: 'tool_permission',
          toolName: 'Bash',
          category: 'shell_unsafe',
          reason: 'shell_dangerous',
          review: { kind: 'command', command: 'npm test' },
          rememberForTurnAllowed: true,
        },
      },
    },
  });
  await waitFor(async () => (await inspect(harness)).items.some(
    (item) => item.kind === 'work' && item.status === 'waiting_for_user',
  ));

  await harness.orchestrator.handle({
    kind: 'answer_interaction',
    work: candidate.work,
    interactionId: 'interaction-1',
    answer: { kind: 'permission', decision: 'allow', rememberForTurn: false },
  });
  assert.deepEqual(harness.host.answerCalls, [{
    work: candidate.work,
    interactionId: 'interaction-1',
    answer: { kind: 'permission', decision: 'allow', rememberForTurn: false },
  }]);
  const snapshot = await inspect(harness);
  const block = snapshot.items.find((item) => item.kind === 'work');
  assert.equal(block?.kind, 'work');
  if (block?.kind === 'work') {
    assert.equal(block.status, 'running');
    assert.equal(block.interaction, undefined);
  }
});

test('does not let a late turn outcome revive a stopped Work', async () => {
  const completion = deferred<WorkHubTurnOutcome>();
  const candidate = workCandidate();
  const harness = createHarness({ candidates: [candidate], completion: completion.promise });
  await harness.orchestrator.handle({
    kind: 'submit',
    requestId: 'request-stop-race',
    text: 'Continue this Work.',
    explicitWork: candidate.work,
  });
  await harness.orchestrator.handle({ kind: 'stop_work', work: candidate.work });

  completion.resolve({ status: 'completed', detail: 'Late completion.' });
  await new Promise((resolve) => setImmediate(resolve));
  const snapshot = await inspect(harness);
  const block = snapshot.items.find((item) => item.kind === 'work');

  assert.equal(block?.kind, 'work');
  if (block?.kind === 'work') {
    assert.equal(block.status, 'stopped');
    assert.notEqual(block.detail, 'Late completion.');
  }
});

test('serializes concurrent commands through compare-and-swap storage', async () => {
  const harness = createHarness({
    resolveIntent: async () => ({ kind: 'discussion' }),
  });

  await Promise.all([
    harness.orchestrator.handle({ kind: 'submit', requestId: 'request-a', text: 'A' }),
    harness.orchestrator.handle({ kind: 'submit', requestId: 'request-b', text: 'B' }),
  ]);

  const snapshot = await inspect(harness);
  assert.equal(snapshot.revision, 2);
  assert.deepEqual(
    snapshot.items
      .filter((item) => item.kind === 'discussion' && item.role === 'user')
      .map((item) => item.sourceRequestId),
    ['request-a', 'request-b'],
  );
});

test('reattaches persisted running Work to its Runtime Host Turn after restart', async () => {
  const completion = deferred<WorkHubTurnOutcome>();
  const initialSnapshot: WorkHubSnapshot = {
    revision: 4,
    items: [{
      kind: 'work',
      id: 'persisted-block',
      sourceRequestId: 'persisted-request',
      work: { workspaceId: 'workspace-1', sessionId: 'session-1' },
      projectName: 'maka',
      workName: 'Login timeout',
      requestText: 'Fix the login timeout.',
      permissionMode: 'execute',
      status: 'running',
      turnId: 'persisted-turn',
      createdAt: 10,
      updatedAt: 11,
    }],
  };
  const harness = createHarness({ initialSnapshot, completion: completion.promise });

  await harness.orchestrator.handle({ kind: 'inspect' });
  assert.deepEqual(harness.host.observeCalls, [{
    work: { workspaceId: 'workspace-1', sessionId: 'session-1' },
    turnId: 'persisted-turn',
  }]);

  completion.resolve({ status: 'completed', detail: 'Recovered completion.' });
  await waitFor(async () => (await inspect(harness)).items.some(
    (item) => item.kind === 'work' && item.status === 'completed',
  ));
  const snapshot = await inspect(harness);
  const block = snapshot.items[0];
  assert.equal(block?.kind, 'work');
  if (block?.kind === 'work') assert.equal(block.detail, 'Recovered completion.');
});

test('runs a cross-Work graph in dependency order and completes its projection', async () => {
  const firstDone = deferred<WorkHubTurnOutcome>();
  const secondDone = deferred<WorkHubTurnOutcome>();
  const first = workCandidate({ workName: 'Change API' });
  const second = workCandidate({
    candidateId: 'candidate-2',
    work: { workspaceId: 'workspace-2', sessionId: 'session-2' },
    projectName: 'client',
    workName: 'Update caller',
  });
  const harness = createHarness({
    candidates: [first, second],
    completions: [firstDone.promise, secondDone.promise],
    resolveIntent: async () => ({
      kind: 'coordinate',
      title: 'Change API and update caller',
      nodes: [
        { nodeId: 'api', candidateId: first.candidateId, instruction: 'Change the API.' },
        { nodeId: 'caller', candidateId: second.candidateId, instruction: 'Update the caller.' },
      ],
      edges: [{ fromNodeId: 'api', toNodeId: 'caller' }],
    }),
  });

  const result = await harness.orchestrator.handle({
    kind: 'submit', requestId: 'coordinate-1', text: '先改 API，然后更新调用方。',
  });
  assert.equal(result.kind, 'coordination');
  assert.deepEqual(harness.host.startCalls.map((call) => call.work), [first.work]);

  firstDone.resolve({ status: 'completed', detail: 'API changed.' });
  await waitFor(async () => harness.host.startCalls.length === 2);
  assert.deepEqual(harness.host.startCalls[1], { work: second.work, text: 'Update the caller.' });

  secondDone.resolve({ status: 'completed', detail: 'Caller updated.' });
  await waitFor(async () => (await inspect(harness)).items.some(
    (item) => item.kind === 'coordination' && item.status === 'completed',
  ));
  const coordination = (await inspect(harness)).items.find((item) => item.kind === 'coordination');
  assert.equal(coordination?.kind, 'coordination');
  if (coordination?.kind === 'coordination') {
    assert.deepEqual(coordination.nodes.map((node) => node.status), ['completed', 'completed']);
  }
});

test('starts independent graph roots in parallel', async () => {
  const first = workCandidate({ workName: 'Server' });
  const second = workCandidate({
    candidateId: 'candidate-2',
    work: { workspaceId: 'workspace-2', sessionId: 'session-2' },
    projectName: 'web',
    workName: 'Client',
  });
  const harness = createHarness({
    candidates: [first, second],
    resolveIntent: async () => ({
      kind: 'coordinate', title: 'Run both checks',
      nodes: [
        { nodeId: 'server', candidateId: first.candidateId, instruction: 'Check server.' },
        { nodeId: 'client', candidateId: second.candidateId, instruction: 'Check client.' },
      ],
      edges: [],
    }),
  });

  await harness.orchestrator.handle({
    kind: 'submit', requestId: 'coordinate-parallel', text: '同时检查服务端和客户端。',
  });
  assert.equal(harness.host.startCalls.length, 2);
});

test('propagates a failed dependency as blocked without starting downstream Work', async () => {
  const failed = deferred<WorkHubTurnOutcome>();
  const first = workCandidate({ workName: 'Schema' });
  const second = workCandidate({
    candidateId: 'candidate-2',
    work: { workspaceId: 'workspace-2', sessionId: 'session-2' },
    workName: 'Consumer',
  });
  const harness = createHarness({
    candidates: [first, second],
    completions: [failed.promise],
    resolveIntent: async () => ({
      kind: 'coordinate', title: 'Schema migration',
      nodes: [
        { nodeId: 'schema', candidateId: first.candidateId, instruction: 'Change schema.' },
        { nodeId: 'consumer', candidateId: second.candidateId, instruction: 'Update consumer.' },
      ],
      edges: [{ fromNodeId: 'schema', toNodeId: 'consumer' }],
    }),
  });
  await harness.orchestrator.handle({
    kind: 'submit', requestId: 'coordinate-fail', text: '先改 schema，再改 consumer。',
  });
  failed.resolve({ status: 'failed', detail: 'Migration rejected.' });
  await waitFor(async () => (await inspect(harness)).items.some(
    (item) => item.kind === 'coordination' && item.status === 'failed',
  ));
  assert.equal(harness.host.startCalls.length, 1);
  const coordination = (await inspect(harness)).items.find((item) => item.kind === 'coordination');
  if (coordination?.kind === 'coordination') {
    assert.deepEqual(coordination.nodes.map((node) => node.status), ['failed', 'blocked']);
  }
});

test('rejects cyclic semantic plans and asks for a bounded clarification', async () => {
  const first = workCandidate();
  const second = workCandidate({
    candidateId: 'candidate-2',
    work: { workspaceId: 'workspace-2', sessionId: 'session-2' },
  });
  const harness = createHarness({
    candidates: [first, second],
    resolveIntent: async () => ({
      kind: 'coordinate', title: 'Cycle',
      nodes: [
        { nodeId: 'a', candidateId: first.candidateId, instruction: 'A' },
        { nodeId: 'b', candidateId: second.candidateId, instruction: 'B' },
      ],
      edges: [
        { fromNodeId: 'a', toNodeId: 'b' },
        { fromNodeId: 'b', toNodeId: 'a' },
      ],
    }),
  });
  const result = await harness.orchestrator.handle({
    kind: 'submit', requestId: 'coordinate-cycle', text: 'Coordinate these.',
  });
  assert.equal(result.kind, 'clarification');
  assert.equal(harness.host.startCalls.length, 0);
});

test('stops active and pending nodes through one coordination command', async () => {
  const first = workCandidate();
  const second = workCandidate({
    candidateId: 'candidate-2',
    work: { workspaceId: 'workspace-2', sessionId: 'session-2' },
  });
  const harness = createHarness({
    candidates: [first, second],
    resolveIntent: async () => ({
      kind: 'coordinate', title: 'Stop me',
      nodes: [
        { nodeId: 'a', candidateId: first.candidateId, instruction: 'A' },
        { nodeId: 'b', candidateId: second.candidateId, instruction: 'B' },
      ],
      edges: [{ fromNodeId: 'a', toNodeId: 'b' }],
    }),
  });
  const result = await harness.orchestrator.handle({
    kind: 'submit', requestId: 'coordinate-stop', text: 'A then B.',
  });
  assert.equal(result.kind, 'coordination');
  if (result.kind !== 'coordination') return;
  await harness.orchestrator.handle({
    kind: 'stop_coordination', coordinationId: result.coordination.id,
  });
  assert.deepEqual(harness.host.stopCalls, [first.work]);
  const coordination = (await inspect(harness)).items.find((item) => item.kind === 'coordination');
  if (coordination?.kind === 'coordination') {
    assert.equal(coordination.status, 'stopped');
    assert.deepEqual(coordination.nodes.map((node) => node.status), ['stopped', 'stopped']);
  }
});

test('continues runnable coordination nodes after a desktop restart', async () => {
  const second = workCandidate({
    candidateId: 'candidate-2',
    work: { workspaceId: 'workspace-2', sessionId: 'session-2' },
    workName: 'Update caller',
  });
  const initialSnapshot: WorkHubSnapshot = {
    revision: 7,
    items: [{
      kind: 'coordination',
      id: 'persisted-coordination',
      sourceRequestId: 'persisted-request',
      title: 'Resume rollout',
      status: 'active',
      nodes: [
        {
          nodeId: 'api',
          work: { workspaceId: 'workspace-1', sessionId: 'session-1' },
          projectName: 'maka',
          workName: 'Change API',
          instruction: 'Change API.',
          status: 'completed',
        },
        {
          nodeId: 'caller',
          work: second.work,
          projectName: second.projectName,
          workName: second.workName,
          instruction: 'Update caller.',
          status: 'pending',
        },
      ],
      edges: [{ edgeId: 'edge-1', fromNodeId: 'api', toNodeId: 'caller' }],
      createdAt: 1,
      updatedAt: 2,
    }],
  };
  const harness = createHarness({ candidates: [second], initialSnapshot });

  await harness.orchestrator.handle({ kind: 'inspect' });

  assert.deepEqual(harness.host.startCalls, [{ work: second.work, text: 'Update caller.' }]);
  const coordination = (await inspect(harness)).items.find((item) => item.kind === 'coordination');
  if (coordination?.kind === 'coordination') {
    assert.equal(coordination.nodes[1]?.status, 'running');
    assert.ok(coordination.nodes[1]?.blockId);
  }
});

function createHarness(options: {
  candidates?: WorkHubCandidate[];
  createdCandidate?: WorkHubCandidate;
  completion?: Promise<WorkHubTurnOutcome>;
  completions?: Promise<WorkHubTurnOutcome>[];
  defaultPermissionMode?: PermissionMode;
  resolveIntent?: Parameters<typeof createWorkHubOrchestrator>[0]['resolveIntent'];
  answerDiscussion?: Parameters<typeof createWorkHubOrchestrator>[0]['answerDiscussion'];
  initialSnapshot?: WorkHubSnapshot;
  listCandidates?: (query: string, limit: number) => WorkHubCandidate[];
} = {}) {
  const store = new InMemoryWorkHubStore(options.initialSnapshot);
  const host = new InMemoryWorkHubHost(
    options.candidates ?? [],
    options.createdCandidate,
    options.completion,
    options.completions,
    options.listCandidates,
  );
  let nextId = 0;
  let clock = 100;
  const orchestrator = createWorkHubOrchestrator({
    store,
    hosts: host,
    resolveIntent: options.resolveIntent,
    answerDiscussion: options.answerDiscussion ?? (() => new Promise(() => {})),
    defaultPermissionMode: async () => options.defaultPermissionMode ?? 'explore',
    createId: () => `workhub-${++nextId}`,
    now: () => ++clock,
  });
  return { orchestrator, host, store };
}

class InMemoryWorkHubStore implements WorkHubStateStore {
  #snapshot: WorkHubSnapshot;
  #metrics = {
    workhubOpened: 0,
    submissions: 0,
    clarifications: 0,
    manualSessionSwitches: 0,
  };

  constructor(initialSnapshot: WorkHubSnapshot = { revision: 0, items: [] }) {
    this.#snapshot = structuredClone(initialSnapshot);
  }

  async read(): Promise<WorkHubSnapshot> {
    return structuredClone(this.#snapshot);
  }

  async write(expectedRevision: number, snapshot: WorkHubSnapshot): Promise<void> {
    assert.equal(this.#snapshot.revision, expectedRevision, 'stale WorkHub snapshot write');
    assert.equal(snapshot.revision, expectedRevision + 1, 'revision must advance exactly once');
    this.#snapshot = structuredClone(snapshot);
  }

  async readMetrics() {
    return structuredClone(this.#metrics);
  }

  async incrementMetric(metric: import('@maka/core/workhub').WorkHubMetricName): Promise<void> {
    if (metric === 'workhub_opened') this.#metrics.workhubOpened += 1;
    else if (metric === 'submission') this.#metrics.submissions += 1;
    else if (metric === 'clarification') this.#metrics.clarifications += 1;
    else this.#metrics.manualSessionSwitches += 1;
  }
}

class InMemoryWorkHubHost implements WorkHubHostDirectory {
  readonly listCalls: Array<{ query: string; limit: number }> = [];
  readonly createCalls: Array<{
    workspaceId: string;
    title: string;
    permissionMode: PermissionMode;
    modelSelection?: import('@maka/core/workhub').WorkHubModelSelection;
  }> = [];
  readonly restoreCalls: WorkHubWorkRef[] = [];
  readonly startCalls: Array<{
    work: WorkHubWorkRef;
    text: string;
    modelSelection?: import('@maka/core/workhub').WorkHubModelSelection;
    attachmentItems?: readonly AttachmentIngestItem[];
  }> = [];
  readonly permissionCalls: Array<{ work: WorkHubWorkRef; mode: PermissionMode }> = [];
  readonly stopCalls: WorkHubWorkRef[] = [];
  readonly observeCalls: Array<{ work: WorkHubWorkRef; turnId: string }> = [];
  readonly answerCalls: Array<{
    work: WorkHubWorkRef;
    interactionId: string;
    answer: import('@maka/core/interaction').InteractionAnswer;
  }> = [];
  reportProgress?: (outcome: WorkHubTurnOutcome) => void;

  constructor(
    private readonly candidates: WorkHubCandidate[],
    private readonly createdCandidate = workCandidate({
      candidateId: 'created-candidate',
      work: { workspaceId: 'workspace-1', sessionId: 'created-session' },
    }),
    private readonly completion: Promise<WorkHubTurnOutcome> = new Promise(() => {}),
    private readonly completions?: Promise<WorkHubTurnOutcome>[],
    private readonly candidateLister?: (query: string, limit: number) => WorkHubCandidate[],
  ) {}

  async listCandidates(query: string, limit: number): Promise<WorkHubCandidate[]> {
    this.listCalls.push({ query, limit });
    return structuredClone(this.candidateLister?.(query, limit) ?? this.candidates);
  }

  async findWork(work: WorkHubWorkRef): Promise<WorkHubCandidate | undefined> {
    const candidate = this.candidates.find(
      (item) =>
        item.work.workspaceId === work.workspaceId && item.work.sessionId === work.sessionId,
    );
    return candidate ? structuredClone(candidate) : undefined;
  }

  async createWork(input: {
    workspaceId: string;
    title: string;
    permissionMode: PermissionMode;
    modelSelection?: import('@maka/core/workhub').WorkHubModelSelection;
  }): Promise<WorkHubCandidate> {
    this.createCalls.push(structuredClone(input));
    return structuredClone(this.createdCandidate);
  }

  async restoreWork(work: WorkHubWorkRef): Promise<void> {
    this.restoreCalls.push(structuredClone(work));
  }

  async startTurn(
    work: WorkHubWorkRef,
    text: string,
    onProgress?: (outcome: WorkHubTurnOutcome) => void,
    modelSelection?: import('@maka/core/workhub').WorkHubModelSelection,
    attachmentItems?: readonly AttachmentIngestItem[],
  ): Promise<{ turnId: string; completion: Promise<WorkHubTurnOutcome> }> {
    this.startCalls.push({
      work: structuredClone(work),
      text,
      ...(modelSelection ? { modelSelection: structuredClone(modelSelection) } : {}),
      ...(attachmentItems ? { attachmentItems: structuredClone([...attachmentItems]) } : {}),
    });
    this.reportProgress = onProgress;
    return {
      turnId: `turn-${this.startCalls.length}`,
      completion: this.completions?.[this.startCalls.length - 1] ?? this.completion,
    };
  }

  async observeTurn(work: WorkHubWorkRef, turnId: string): Promise<WorkHubTurnOutcome> {
    this.observeCalls.push({ work: structuredClone(work), turnId });
    return this.completion;
  }

  async setPermissionMode(work: WorkHubWorkRef, mode: PermissionMode): Promise<void> {
    this.permissionCalls.push({ work: structuredClone(work), mode });
  }

  async answerInteraction(
    work: WorkHubWorkRef,
    interactionId: string,
    answer: import('@maka/core/interaction').InteractionAnswer,
  ): Promise<void> {
    this.answerCalls.push({ work: structuredClone(work), interactionId, answer: structuredClone(answer) });
  }

  async stopWork(work: WorkHubWorkRef): Promise<void> {
    this.stopCalls.push(structuredClone(work));
  }
}

function workCandidate(overrides: Partial<WorkHubCandidate> = {}): WorkHubCandidate {
  return {
    candidateId: 'candidate-1',
    work: { workspaceId: 'workspace-1', sessionId: 'session-1' },
    projectName: 'maka',
    workName: 'Target recognition',
    permissionMode: 'explore',
    searchableText: 'maka target recognition unified routing',
    archived: false,
    ...overrides,
  };
}

async function inspect(harness: ReturnType<typeof createHarness>): Promise<WorkHubSnapshot> {
  const result = await harness.orchestrator.handle({ kind: 'inspect' });
  assert.equal(result.kind, 'snapshot');
  return (result as Extract<WorkHubCommandResult, { kind: 'snapshot' }>).snapshot;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for WorkHub state');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
