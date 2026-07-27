import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionEvent } from '@maka/core/events';
import type { SessionHeader } from '@maka/core/session';

import { buildAdditionalPermissionProposal } from '../additional-permissions.js';
import { buildAskUserQuestionTool } from '../ask-user-question-tool.js';
import { AsyncEventQueue } from '../async-queue.js';
import {
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionClosedError,
  RuntimeInteractionInvariantError,
  RuntimeInteractionRunBinding,
  bindRuntimeInteractionRun,
  type RuntimeInteractionAuthority,
  type RuntimeInteractionRunOwner,
  type RuntimePermissionContinuation,
  type RuntimeUserQuestionContinuation,
} from '../interaction-authority.js';
import { PermissionEngine } from '../permission-engine.js';
import { planDeclaredBashSandboxEscalation } from '../sandbox-escalation.js';
import { SessionManager } from '../session-manager.js';
import { ToolRuntime, type DurableSessionEventSink, type MakaTool } from '../tool-runtime.js';

describe('Runtime Interaction authority seam', () => {
  test('binds the exact Run and rejects release before durable close', async () => {
    const log: string[] = [];
    const binding = await bindRuntimeInteractionRun(
      authority({
        close: async (reason) => {
          log.push(`close:${reason}`);
        },
        release: () => log.push('release'),
      }),
      RUN,
    );

    assert.throws(() => binding.release(), RuntimeInteractionInvariantError);
    await binding.close('turn_terminal');
    await binding.settleLocalClosures();
    binding.release();
    assert.deepEqual(log, ['close:turn_terminal', 'release']);

    let failedFinalizerReleased = false;
    const failedFinalizer = new RuntimeInteractionRunBinding(
      authority({
        release: () => {
          failedFinalizerReleased = true;
        },
      }).bindRun({ ...RUN, runId: 'failed-finalizer-run' }),
    );
    failedFinalizer.deferLocalClosure(() => {
      throw new Error('local closure failed');
    });
    await failedFinalizer.close('turn_terminal');
    await assert.rejects(failedFinalizer.settleLocalClosures(), /local closure failed/);
    assert.throws(() => failedFinalizer.release(), RuntimeInteractionInvariantError);
    assert.equal(failedFinalizerReleased, false);
  });

  test('durably reclaims an owner that returns the wrong Run identity', async () => {
    const log: string[] = [];
    await assert.rejects(
      bindRuntimeInteractionRun(
        {
          bindRun: () => ({
            ...RUN,
            runId: 'wrong-run',
            acceptPermissionRequest: async () => ({ state: 'pending' }),
            commitPermissionAnswer: async ({ answer }) => ({
              kind: 'permission_answer',
              answer,
            }),
            commitPermissionTimeout: async () => ({ kind: 'closure', reason: 'timed_out' }),
            acceptUserQuestionRequest: async () => {},
            close: async (reason) => {
              log.push(`close:${reason}`);
            },
            release: () => log.push('release'),
          }),
        },
        RUN,
      ),
      RuntimeInteractionInvariantError,
    );
    assert.deepEqual(log, ['close:turn_terminal', 'release']);
  });

  test('fails closed when Run close wins the publication linearization point', async () => {
    const binding = await bindRuntimeInteractionRun(authority(), RUN);
    const request = {
      type: 'permission_request',
      id: 'event-close-race',
      turnId: RUN.turnId,
      ts: 1,
      requestId: 'request-close-race',
      toolUseId: 'tool-close-race',
      toolName: 'Write',
      category: 'file_write',
      args: { path: '/tmp/a' },
      kind: 'tool_permission',
      reason: 'file_write',
      rememberForTurnAllowed: true,
    } as const;
    await binding.admitPermissionRequest({
      request,
      settlement: {
        applyAnswer: async () => {},
        applyClosure: async () => {},
      },
    });

    await binding.close('turn_stopped');

    assert.throws(() => binding.assertPendingAdmission(request), RuntimeInteractionInvariantError);
  });

  test('fails closed when continuation settlement wins the publication linearization point', async () => {
    const localSettlement = deferred<void>();
    let continuation: RuntimePermissionContinuation | undefined;
    const binding = await bindRuntimeInteractionRun(
      authority({
        acceptPermissionRequest: async ({ continuation: admitted }) => {
          continuation = admitted;
          return { state: 'pending' };
        },
      }),
      RUN,
    );
    const request = {
      type: 'permission_request',
      id: 'event-settlement-race',
      turnId: RUN.turnId,
      ts: 1,
      requestId: 'request-settlement-race',
      toolUseId: 'tool-settlement-race',
      toolName: 'Write',
      category: 'file_write',
      args: { path: '/tmp/a' },
      kind: 'tool_permission',
      reason: 'file_write',
      rememberForTurnAllowed: true,
    } as const;
    await binding.admitPermissionRequest({
      request,
      settlement: {
        applyAnswer: async () => localSettlement.promise,
        applyClosure: async () => {},
      },
    });

    const settlement = continuation!.applyAnswer({ decision: 'allow' });

    assert.throws(() => binding.assertPendingAdmission(request), RuntimeInteractionInvariantError);
    localSettlement.resolve();
    await settlement;
    await binding.close('turn_terminal');
    await binding.settleLocalClosures();
    binding.release();
  });

  test('keeps embedded answers unchanged and gates hosted answers on durable commit', async () => {
    const embedded = permissionEngine();
    embedded.beginTurn('embedded-turn');
    const embeddedPrompt = embedded.evaluate({
      sessionId: 'embedded-session',
      turnId: 'embedded-turn',
      toolUseId: 'embedded-tool',
      toolName: 'Write',
      args: { path: '/tmp/a' },
      mode: 'ask',
    });
    assert.equal(embeddedPrompt.kind, 'prompt');
    if (embeddedPrompt.kind !== 'prompt') return;
    embedded.recordResponse('embedded-turn', {
      requestId: embeddedPrompt.event.requestId,
      decision: 'allow',
    });
    assert.equal((await embeddedPrompt.parked).decision, 'allow');

    const commitGate = deferred<void>();
    const log: string[] = [];
    const binding = await bindRuntimeInteractionRun(
      authority({
        commitPermissionAnswer: async (input) => {
          log.push('commit-start');
          await commitGate.promise;
          log.push('commit-durable');
          await input.continuation.applyAnswer(input.answer);
          return { kind: 'permission_answer', answer: input.answer };
        },
      }),
      RUN,
    );
    const hosted = permissionEngine();
    hosted.beginTurn(RUN.turnId);
    const prompt = hosted.evaluate({
      ...RUN,
      hostedInteraction: binding,
      toolUseId: 'tool-1',
      toolName: 'Write',
      args: { path: '/tmp/a' },
      mode: 'ask',
    });
    assert.equal(prompt.kind, 'prompt');
    if (prompt.kind !== 'prompt') return;
    assert.ok(prompt.settlement);
    await binding.admitPermissionRequest({
      request: prompt.event,
      ...(prompt.rememberScopeId ? { rememberScopeId: prompt.rememberScopeId } : {}),
      settlement: prompt.settlement,
    });

    let settled = false;
    void prompt.parked.then(() => {
      settled = true;
      log.push('local-resolve');
    });
    hosted.recordResponse(RUN.turnId, {
      requestId: prompt.event.requestId,
      decision: 'allow',
    });
    await immediate();
    assert.equal(settled, false);
    assert.deepEqual(log, ['commit-start']);

    commitGate.resolve();
    assert.equal((await prompt.parked).decision, 'allow');
    assert.deepEqual(log, ['commit-start', 'commit-durable', 'local-resolve']);
    hosted.endTurn(RUN.turnId);
    await binding.close('turn_terminal');
    await binding.settleLocalClosures();
    binding.release();
  });

  test('accepts explicit remember false for hosted one-shot allow and deny outcomes', async () => {
    const binding = await bindRuntimeInteractionRun(
      authority({
        commitPermissionAnswer: async ({ continuation, answer }) => {
          await continuation.applyAnswer(answer);
          return { kind: 'permission_answer', answer };
        },
      }),
      RUN,
    );
    const engine = permissionEngine();
    engine.beginTurn(RUN.turnId);

    const cases = [
      { kind: 'additional_permissions', decision: 'allow' },
      { kind: 'additional_permissions', decision: 'deny' },
      { kind: 'sandbox_escalation', decision: 'allow' },
      { kind: 'sandbox_escalation', decision: 'deny' },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const toolUseId = `one-shot-${index}`;
      let prompt: ReturnType<PermissionEngine['evaluate']>;
      if (testCase.kind === 'additional_permissions') {
        const args = { path: `/workspace/output-${index}.txt`, content: 'ok' };
        prompt = engine.evaluate({
          ...RUN,
          hostedInteraction: binding,
          toolUseId,
          toolName: 'Write',
          args,
          mode: 'execute',
          cwd: '/workspace',
          additionalPermissionProposal: buildAdditionalPermissionProposal({
            profile: { network: { enabled: true } },
            normalizedPaths: [],
            justification: 'Allow network access for this call.',
            toolName: 'Write',
            args,
            workspaceRoots: ['/workspace'],
          }),
        });
      } else {
        const command = `printf ok > /outside/result-${index}.txt`;
        const declaration = {
          mode: 'require_escalated',
          justification: 'The requested output directory is outside the workspace.',
        } as const;
        const args = { command, sandbox_permissions: declaration };
        const plan = planDeclaredBashSandboxEscalation({
          declaration,
          command,
          cwd: '/workspace',
          mode: 'execute',
          args,
        });
        if (plan.kind !== 'request') assert.fail('expected a sandbox escalation request');
        prompt = engine.evaluate({
          ...RUN,
          hostedInteraction: binding,
          toolUseId,
          toolName: 'Bash',
          args,
          mode: 'execute',
          cwd: '/workspace',
          sandboxEscalationProposal: plan.proposal,
        });
      }

      assert.equal(prompt.kind, 'prompt');
      if (prompt.kind !== 'prompt') assert.fail(`expected ${testCase.kind} prompt`);
      assert.equal(prompt.event.kind, testCase.kind);
      assert.ok(prompt.settlement);
      await binding.admitPermissionRequest({
        request: prompt.event,
        ...(prompt.rememberScopeId ? { rememberScopeId: prompt.rememberScopeId } : {}),
        settlement: prompt.settlement,
      });

      engine.recordResponse(RUN.turnId, {
        requestId: prompt.event.requestId,
        decision: testCase.decision,
        rememberForTurn: false,
      });
      assert.deepEqual(await prompt.parked, {
        requestId: prompt.event.requestId,
        decision: testCase.decision,
      });
    }

    assert.equal(engine.pendingCount(RUN.turnId), 0);
    engine.endTurn(RUN.turnId);
    await binding.close('turn_terminal');
    await binding.settleLocalClosures();
    binding.release();
  });

  test('lets durable close settle an auto-approval rejected because the Run closed', async () => {
    const runClosed = deferred<void>();
    const commitRejected = deferred<void>();
    const applyCloseContinuation = deferred<void>();
    const log: string[] = [];
    let continuation: RuntimePermissionContinuation | undefined;
    const binding = await bindRuntimeInteractionRun(
      authority({
        acceptPermissionRequest: async ({ continuation: admitted }) => {
          continuation = admitted;
          return { state: 'pending' };
        },
        commitPermissionAnswer: async ({ continuation: current }) => {
          log.push('commit-start');
          await runClosed.promise;
          log.push('commit-run-closed');
          commitRejected.resolve();
          throw new RuntimeInteractionAdmissionRejectedError(
            current.requestId,
            'run_closed',
            'turn_stopped',
          );
        },
        close: async (reason) => {
          log.push('close-start');
          runClosed.resolve();
          await applyCloseContinuation.promise;
          log.push('close-durable');
          await continuation?.applyClosure(reason);
          log.push('close-local');
        },
      }),
      RUN,
    );
    const engine = permissionEngine();
    engine.beginTurn(RUN.turnId);
    const prompt = engine.evaluate({
      ...RUN,
      hostedInteraction: binding,
      toolUseId: 'tool-1',
      toolName: 'Write',
      args: { path: '/tmp/a' },
      mode: 'ask',
    });
    assert.equal(prompt.kind, 'prompt');
    if (prompt.kind !== 'prompt') return;
    assert.ok(prompt.settlement);
    await binding.admitPermissionRequest({
      request: prompt.event,
      ...(prompt.rememberScopeId ? { rememberScopeId: prompt.rememberScopeId } : {}),
      settlement: prompt.settlement,
    });

    let localSettlement: 'pending' | 'resolved' | 'rejected' = 'pending';
    const localOutcome = prompt.parked.then(
      (value) => {
        localSettlement = 'resolved';
        return { kind: 'resolved', value } as const;
      },
      (error: unknown) => {
        localSettlement = 'rejected';
        return { kind: 'rejected', error } as const;
      },
    );
    engine.recordResponse(RUN.turnId, {
      requestId: prompt.event.requestId,
      decision: 'allow',
      reviewer: 'auto_review',
    });
    engine.endTurn(RUN.turnId, 'aborted');
    const close = binding.close('turn_stopped');

    await commitRejected.promise;
    await Promise.resolve();
    assert.equal(engine.pendingCount(RUN.turnId), 1);
    assert.equal(localSettlement, 'pending');
    assert.deepEqual(log, ['commit-start', 'close-start', 'commit-run-closed']);

    applyCloseContinuation.resolve();
    await close;
    const outcome = await localOutcome;
    assert.equal(outcome.kind, 'rejected');
    if (outcome.kind !== 'rejected') assert.fail('expected the close continuation to reject');
    assert.ok(outcome.error instanceof RuntimeInteractionClosedError);
    assert.equal(outcome.error.reason, 'turn_stopped');
    assert.equal(engine.pendingCount(RUN.turnId), 0);
    assert.deepEqual(log, [
      'commit-start',
      'close-start',
      'commit-run-closed',
      'close-durable',
      'close-local',
    ]);
    await binding.settleLocalClosures();
    binding.release();
  });

  test('publishes a hosted question only after admission and resolves only through its continuation', async () => {
    const admission = deferred<void>();
    let question: RuntimeUserQuestionContinuation | undefined;
    const events: SessionEvent[] = [];
    const binding = await bindRuntimeInteractionRun(
      authority({
        acceptUserQuestionRequest: async ({ continuation }) => {
          question = continuation;
          await admission.promise;
        },
      }),
      RUN,
    );
    const runtime = toolRuntime(events);
    runtime.beginTurn(RUN.turnId, binding);
    const pending = settleTool(
      runtime,
      buildAskUserQuestionTool(),
      RUN.turnId,
      durableEventSink(events),
    )(
      {
        questions: [
          {
            question: 'Continue?',
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );

    await immediate();
    assert.ok(question);
    assert.equal(
      events.some((event) => event.type === 'user_question_request'),
      false,
    );
    admission.resolve();
    await waitFor(() => events.some((event) => event.type === 'user_question_request'));

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await immediate();
    assert.equal(settled, false);
    assert.throws(
      () =>
        runtime.respondToUserQuestion(RUN.turnId, {
          requestId: question!.requestId,
          answers: ['Yes'],
        }),
      RuntimeInteractionInvariantError,
    );
    assert.equal(runtime.pendingUserQuestionCount(RUN.turnId), 1);
    await question!.applyAnswer({ answers: ['Yes'] });
    assert.deepEqual(await pending, {
      answers: [{ question: 'Continue?', answer: 'Yes' }],
    });

    runtime.endTurn(RUN.turnId);
    await binding.close('turn_terminal');
    await binding.settleLocalClosures();
    binding.release();
  });

  test('keeps aggregate pending state until every hosted question settles', async () => {
    const continuations: RuntimeUserQuestionContinuation[] = [];
    const events: SessionEvent[] = [];
    const finishSecondAdmission = deferred<void>();
    const binding = await bindRuntimeInteractionRun(
      authority({
        acceptUserQuestionRequest: async ({ continuation }) => {
          continuations.push(continuation);
          if (continuations.length === 2) await finishSecondAdmission.promise;
        },
      }),
      RUN,
    );
    const runtime = toolRuntime(events);
    runtime.beginTurn(RUN.turnId, binding);
    const execute = settleTool(
      runtime,
      buildAskUserQuestionTool(),
      RUN.turnId,
      durableEventSink(events),
    );
    const first = execute(
      {
        questions: [
          {
            question: 'First?',
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );
    const second = execute(
      {
        questions: [
          {
            question: 'Second?',
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      },
      { toolCallId: 'tool-2', abortSignal: new AbortController().signal },
    );

    await waitFor(() => continuations.length === 2);
    await assert.rejects(
      binding.canResumeAfterSettlementAck({
        type: 'user_question_answer_ack',
        id: 'unknown-answer',
        turnId: RUN.turnId,
        ts: 1,
        requestId: 'unknown-question',
        toolUseId: 'tool-unknown',
      }),
      RuntimeInteractionInvariantError,
    );
    await continuations[0]!.applyAnswer({ answers: ['Yes'] });
    await first;
    await assert.rejects(
      binding.canResumeAfterSettlementAck({
        type: 'user_question_answer_ack',
        id: 'mismatched-answer',
        turnId: RUN.turnId,
        ts: 1,
        requestId: continuations[0]!.requestId,
        toolUseId: 'wrong-tool',
      }),
      RuntimeInteractionInvariantError,
    );
    assert.equal(
      await binding.canResumeAfterSettlementAck({
        type: 'user_question_answer_ack',
        id: 'first-answer',
        turnId: RUN.turnId,
        ts: 1,
        requestId: continuations[0]!.requestId,
        toolUseId: 'tool-1',
      }),
      false,
    );
    finishSecondAdmission.resolve();
    await waitFor(
      () => events.filter((event) => event.type === 'user_question_request').length === 2,
    );
    await continuations[1]!.applyAnswer({ answers: ['No'] });
    await second;
    assert.equal(
      await binding.canResumeAfterSettlementAck({
        type: 'user_question_answer_ack',
        id: 'second-answer',
        turnId: RUN.turnId,
        ts: 2,
        requestId: continuations[1]!.requestId,
        toolUseId: 'tool-2',
      }),
      true,
    );

    runtime.endTurn(RUN.turnId);
    await binding.close('turn_terminal');
    await binding.settleLocalClosures();
    binding.release();
  });

  test('commits a hosted permission timeout before applying local closure', async () => {
    const events: SessionEvent[] = [];
    const log: string[] = [];
    const binding = await bindRuntimeInteractionRun(
      authority({
        acceptPermissionRequest: async () => {
          log.push('accepted');
          return { state: 'pending' };
        },
        commitPermissionTimeout: async ({ continuation }) => {
          log.push('timeout-durable');
          await continuation.applyClosure('timed_out');
          log.push('timeout-local');
          return { kind: 'closure', reason: 'timed_out' };
        },
      }),
      RUN,
    );
    const runtime = toolRuntime(events, 1);
    runtime.beginTurn(RUN.turnId, binding);
    let implementationCalled = false;
    const tool: MakaTool = {
      name: 'Write',
      description: 'test',
      parameters: {},
      impl: () => {
        implementationCalled = true;
        return { ok: true };
      },
    };
    const result = await settleTool(
      runtime,
      tool,
      RUN.turnId,
      durableEventSink(events),
    )({ path: '/tmp/a' }, { toolCallId: 'tool-1', abortSignal: new AbortController().signal });

    assert.equal(implementationCalled, false);
    assert.deepEqual(log, ['accepted', 'timeout-durable', 'timeout-local']);
    assert.match((result as { error: string }).error, /timed_out/);
    const closureAck = events.find((event) => event.type === 'permission_closure_ack');
    if (closureAck?.type !== 'permission_closure_ack') {
      assert.fail('expected a durable permission timeout acknowledgement');
    }
    await assert.rejects(
      binding.canResumeAfterSettlementAck({
        ...closureAck,
        type: 'permission_answer_ack',
      }),
      RuntimeInteractionInvariantError,
    );
    assert.equal(await binding.canResumeAfterSettlementAck(closureAck), true);
    runtime.endTurn(RUN.turnId);
    await binding.close('turn_terminal');
    await binding.settleLocalClosures();
    binding.release();
  });

  test('uses the canonical answer when it wins the hosted timeout attempt', async () => {
    const events: SessionEvent[] = [];
    const binding = await bindRuntimeInteractionRun(
      authority({
        commitPermissionTimeout: async ({ continuation }) => {
          const answer = {
            decision: 'allow',
            rememberForTurn: false,
            reviewer: 'user',
          } as const;
          await continuation.applyAnswer(answer);
          return { kind: 'permission_answer', answer };
        },
      }),
      RUN,
    );
    const runtime = toolRuntime(events, 1);
    runtime.beginTurn(RUN.turnId, binding);
    let implementationCalled = false;
    const result = await settleTool(
      runtime,
      {
        name: 'Write',
        description: 'test',
        parameters: {},
        impl: () => {
          implementationCalled = true;
          return { ok: true };
        },
      },
      RUN.turnId,
      durableEventSink(events),
    )({ path: '/tmp/a' }, { toolCallId: 'tool-1', abortSignal: new AbortController().signal });

    assert.equal(implementationCalled, true);
    assert.deepEqual(result, { ok: true });
    assert.equal(events.filter((event) => event.type === 'permission_answer_ack').length, 1);
    assert.equal(
      events.some((event) => event.type === 'permission_closure_ack'),
      false,
    );
    runtime.endTurn(RUN.turnId);
    await binding.close('turn_terminal');
    await binding.settleLocalClosures();
    binding.release();
  });

  test('rejects an authority outcome that disagrees with exact local settlement', async () => {
    const binding = await bindRuntimeInteractionRun(
      authority({
        commitPermissionTimeout: async ({ continuation }) => {
          await continuation.applyClosure('timed_out');
          return {
            kind: 'permission_answer',
            answer: { decision: 'allow', rememberForTurn: false, reviewer: 'user' },
          };
        },
      }),
      RUN,
    );
    await binding.admitPermissionRequest({
      request: {
        type: 'permission_request',
        id: 'event-inconsistent-outcome',
        turnId: RUN.turnId,
        ts: 1,
        requestId: 'request-inconsistent-outcome',
        toolUseId: 'tool-inconsistent-outcome',
        toolName: 'Write',
        category: 'file_write',
        args: { path: '/tmp/a' },
        kind: 'tool_permission',
        reason: 'file_write',
        rememberForTurnAllowed: true,
      },
      settlement: {
        applyAnswer: async () => {},
        applyClosure: async () => {},
      },
    });

    await assert.rejects(
      binding.commitPermissionTimeout({ requestId: 'request-inconsistent-outcome' }),
      /inconsistent outcome/,
    );
    await binding.close('turn_terminal');
    await binding.settleLocalClosures();
    binding.release();
  });

  test('keeps an admitted permission timeout bound to its exact Run after turn cleanup', async () => {
    const events: SessionEvent[] = [];
    let timeoutCommits = 0;
    const binding = await bindRuntimeInteractionRun(
      authority({
        commitPermissionTimeout: async ({ continuation }) => {
          timeoutCommits += 1;
          await continuation.applyClosure('timed_out');
          return { kind: 'closure', reason: 'timed_out' };
        },
      }),
      RUN,
    );
    const runtime = toolRuntime(events, 20);
    runtime.beginTurn(RUN.turnId, binding);
    let implementationCalled = false;
    const pending = settleTool(
      runtime,
      {
        name: 'Write',
        description: 'test',
        parameters: {},
        impl: () => {
          implementationCalled = true;
          return { ok: true };
        },
      },
      RUN.turnId,
      durableEventSink(events),
    )({ path: '/tmp/a' }, { toolCallId: 'tool-1', abortSignal: new AbortController().signal });
    await waitFor(() => events.some((event) => event.type === 'permission_request'));

    runtime.endTurn(RUN.turnId, 'aborted');
    const result = await pending;

    assert.equal(timeoutCommits, 1);
    assert.equal(implementationCalled, false);
    assert.match((result as { error: string }).error, /timed_out/);
    assert.equal(events.filter((event) => event.type === 'permission_closure_ack').length, 1);
    await binding.close('turn_terminal');
    await binding.settleLocalClosures();
    binding.release();
  });

  test('defers question teardown after backend cleanup clears current run identity', async () => {
    const events: SessionEvent[] = [];
    const log: string[] = [];
    let question: RuntimeUserQuestionContinuation | undefined;
    const binding = await bindRuntimeInteractionRun(
      authority({
        acceptUserQuestionRequest: async ({ continuation }) => {
          question = continuation;
        },
        close: async (reason) => {
          log.push(`close-durable:${reason}`);
          await question?.applyClosure(reason);
          log.push('local-closure-applied');
        },
        release: () => log.push('release'),
      }),
      RUN,
    );
    let currentRunId: string | undefined = RUN.runId;
    const runtime = toolRuntime(events, undefined, () => currentRunId);
    runtime.beginTurn(RUN.turnId, binding);
    const pending = settleTool(
      runtime,
      buildAskUserQuestionTool(),
      RUN.turnId,
      durableEventSink(events),
    )(
      {
        questions: [
          {
            question: 'Continue?',
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );
    await waitFor(() => question !== undefined);

    const rejected = assert.rejects(pending, /turn_stopped/);
    currentRunId = undefined;
    runtime.endTurn(RUN.turnId, 'aborted');
    await immediate();
    assert.deepEqual(log, []);
    await binding.close('turn_stopped');
    await binding.settleLocalClosures();
    binding.release();
    assert.deepEqual(log, ['close-durable:turn_stopped', 'local-closure-applied', 'release']);
    await rejected;
  });

  test('removes a rejected admission without publishing or leaving a parked question', async () => {
    const events: SessionEvent[] = [];
    const binding = await bindRuntimeInteractionRun(
      authority({
        acceptUserQuestionRequest: async ({ continuation }) => {
          throw new RuntimeInteractionAdmissionRejectedError(
            continuation.requestId,
            'invalid_request',
          );
        },
      }),
      RUN,
    );
    const runtime = toolRuntime(events);
    runtime.beginTurn(RUN.turnId, binding);
    await assert.rejects(
      settleTool(
        runtime,
        buildAskUserQuestionTool(),
        RUN.turnId,
        durableEventSink(events),
      )(
        {
          questions: [
            {
              question: 'Continue?',
              options: [{ label: 'Yes' }, { label: 'No' }],
            },
          ],
        },
        { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
      ),
      (error: unknown) =>
        error instanceof RuntimeInteractionAdmissionRejectedError &&
        error.requestId === 'runtime-2' &&
        error.reason === 'invalid_request',
    );
    assert.equal(runtime.pendingUserQuestionCount(RUN.turnId), 0);
    assert.equal(
      events.some((event) => event.type === 'user_question_request'),
      false,
    );
    runtime.endTurn(RUN.turnId);
    await binding.close('turn_terminal');
    await binding.settleLocalClosures();
    binding.release();
  });

  test('does not locally resolve remember-for-turn siblings before each Host outcome', async () => {
    const continuations: RuntimePermissionContinuation[] = [];
    const durable: string[] = [];
    const binding = await bindRuntimeInteractionRun(
      authority({
        acceptPermissionRequest: async ({ continuation }) => {
          continuations.push(continuation);
          return { state: 'pending' };
        },
      }),
      RUN,
    );
    const engine = permissionEngine();
    engine.beginTurn(RUN.turnId);
    const first = engine.evaluate({
      ...RUN,
      hostedInteraction: binding,
      toolUseId: 'tool-1',
      toolName: 'Write',
      args: { path: '/tmp/shared' },
      mode: 'ask',
    });
    const second = engine.evaluate({
      ...RUN,
      hostedInteraction: binding,
      toolUseId: 'tool-2',
      toolName: 'Write',
      args: { path: '/tmp/shared' },
      mode: 'ask',
    });
    assert.equal(first.kind, 'prompt');
    assert.equal(second.kind, 'prompt');
    if (first.kind !== 'prompt' || second.kind !== 'prompt') return;
    assert.equal(first.rememberScopeId, second.rememberScopeId);

    for (const prompt of [first, second]) {
      assert.ok(prompt.settlement);
      await binding.admitPermissionRequest({
        request: prompt.event,
        rememberScopeId: prompt.rememberScopeId,
        settlement: prompt.settlement,
      });
    }
    await continuations[0]!.applyAnswer({ decision: 'allow', rememberForTurn: true });
    assert.equal(
      await binding.canResumeAfterSettlementAck({
        type: 'permission_answer_ack',
        id: 'first-permission-answer',
        turnId: RUN.turnId,
        ts: 1,
        requestId: continuations[0]!.requestId,
        toolUseId: 'tool-1',
      }),
      false,
    );
    await assert.rejects(
      binding.canResumeAfterSettlementAck({
        type: 'permission_decision_ack',
        id: 'legacy-hosted-decision',
        turnId: RUN.turnId,
        ts: 1,
        requestId: continuations[0]!.requestId,
        toolUseId: 'tool-1',
        decision: 'allow',
      }),
      RuntimeInteractionInvariantError,
    );
    let secondSettled = false;
    void second.parked.then(() => {
      secondSettled = true;
    });
    await immediate();
    assert.equal(secondSettled, false);

    durable.push('sibling-durable');
    await continuations[1]!.applyAnswer({ decision: 'allow', rememberForTurn: true });
    assert.equal((await second.parked).decision, 'allow');
    assert.equal(
      await binding.canResumeAfterSettlementAck({
        type: 'permission_answer_ack',
        id: 'second-permission-answer',
        turnId: RUN.turnId,
        ts: 2,
        requestId: continuations[1]!.requestId,
        toolUseId: 'tool-2',
      }),
      true,
    );
    assert.deepEqual(durable, ['sibling-durable']);
    await first.parked;
    engine.endTurn(RUN.turnId);
    await binding.close('turn_terminal');
    await binding.settleLocalClosures();
    binding.release();
  });

  test('consumes a late remembered sibling settled during admission without republishing it', async () => {
    const admittedScopes: string[] = [];
    let rememberedWinner = false;
    let first: RuntimePermissionContinuation | undefined;
    const binding = await bindRuntimeInteractionRun(
      authority({
        acceptPermissionRequest: async ({ continuation, rememberScopeId }) => {
          if (rememberScopeId) admittedScopes.push(rememberScopeId);
          if (rememberedWinner) {
            await continuation.applyAnswer({ decision: 'allow', rememberForTurn: true });
            return { state: 'settled' };
          }
          first = continuation;
          return { state: 'pending' };
        },
      }),
      RUN,
    );
    const events: SessionEvent[] = [];
    const runtime = toolRuntime(events);
    runtime.beginTurn(RUN.turnId, binding);
    let implementationCalls = 0;
    const tool: MakaTool = {
      name: 'Write',
      description: 'test',
      parameters: {},
      impl: () => {
        implementationCalls += 1;
        return { ok: true };
      },
    };
    const execute = settleTool(runtime, tool, RUN.turnId, durableEventSink(events));

    const firstResult = execute(
      { path: '/tmp/shared' },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );
    await waitFor(() => events.some((event) => event.type === 'permission_request'));
    const published = events.find((event) => event.type === 'permission_request');
    if (published?.type !== 'permission_request') assert.fail('expected first permission request');
    binding.assertPendingAdmission(published);
    rememberedWinner = true;
    await first!.applyAnswer({ decision: 'allow', rememberForTurn: true });
    await firstResult;
    await assert.rejects(
      first!.applyAnswer({ decision: 'allow', rememberForTurn: true }),
      RuntimeInteractionInvariantError,
    );

    await execute(
      { path: '/tmp/shared' },
      { toolCallId: 'tool-2', abortSignal: new AbortController().signal },
    );
    assert.equal(events.filter((event) => event.type === 'permission_request').length, 1);
    assert.equal(implementationCalls, 2);
    assert.equal(admittedScopes.length, 2);
    assert.equal(admittedScopes[0], admittedScopes[1]);

    runtime.endTurn(RUN.turnId);
    await binding.close('turn_terminal');
    await binding.settleLocalClosures();
    binding.release();
  });

  test('fails closed instead of broadcasting Session-level hosted answers', async () => {
    let permissionBroadcasts = 0;
    let questionBroadcasts = 0;
    const manager = new SessionManager({
      store: {} as never,
      backends: {} as never,
      newId: () => 'id',
      now: () => 1,
      interactionAuthority: authority(),
      canonicalPermissionOutcomes: {
        readPermissionOutcome: async () => undefined,
      },
      runtimeKernel: {
        respondToPermission: async () => {
          permissionBroadcasts += 1;
        },
        respondToUserQuestion: async () => {
          questionBroadcasts += 1;
        },
      } as never,
    });

    await assert.rejects(
      manager.respondToPermission(RUN.sessionId, {
        requestId: 'permission-1',
        decision: 'allow',
      }),
      RuntimeInteractionInvariantError,
    );
    await assert.rejects(
      manager.respondToUserQuestion(RUN.sessionId, {
        requestId: 'question-1',
        answers: ['Yes'],
      }),
      RuntimeInteractionInvariantError,
    );
    assert.equal(permissionBroadcasts, 0);
    assert.equal(questionBroadcasts, 0);
  });
});

const RUN = Object.freeze({
  sessionId: 'session-1',
  turnId: 'turn-1',
  runId: 'run-1',
});

function authority(
  overrides: Partial<RuntimeInteractionRunOwner> = {},
): RuntimeInteractionAuthority {
  return {
    bindRun: (identity) => ({
      ...identity,
      acceptPermissionRequest: async () => ({ state: 'pending' }),
      commitPermissionAnswer: async ({ answer }) => ({
        kind: 'permission_answer',
        answer,
      }),
      commitPermissionTimeout: async () => ({
        kind: 'closure',
        reason: 'timed_out',
      }),
      acceptUserQuestionRequest: async () => {},
      close: async () => {},
      release: () => {},
      ...overrides,
    }),
  };
}

function permissionEngine(): PermissionEngine {
  let id = 0;
  return new PermissionEngine({
    newId: () => `permission-${++id}`,
    now: () => 1,
  });
}

function toolRuntime(
  events: SessionEvent[],
  permissionTimeoutMs?: number,
  getCurrentRunId: () => string | undefined = () => RUN.runId,
): ToolRuntime {
  let id = 0;
  const engine = new PermissionEngine({
    newId: () => `permission-${++id}`,
    now: () => 1,
  });
  return new ToolRuntime({
    sessionId: RUN.sessionId,
    header: header(),
    connection: { providerType: 'openai', slug: 'c' } as never,
    modelId: 'm',
    appendMessage: async () => {},
    permissionEngine: engine,
    newId: () => `runtime-${++id}`,
    now: () => 1,
    getPermissionPauseTarget: () => null,
    getCurrentRunId,
    ...(permissionTimeoutMs === undefined ? {} : { permissionTimeoutMs }),
    recordToolInvocation: () => void events,
  });
}

function settleTool(
  runtime: ToolRuntime,
  tool: MakaTool,
  turnId: string,
  eventSink: DurableSessionEventSink,
) {
  return async (
    input: unknown,
    context: { toolCallId: string; abortSignal: AbortSignal },
  ): Promise<unknown> =>
    (
      await runtime.settleToolCall({
        tool,
        turnId,
        toolCallId: context.toolCallId,
        input,
        abortSignal: context.abortSignal,
        eventSink,
      })
    ).result;
}

function durableEventSink(events: SessionEvent[]): AsyncEventQueue<SessionEvent> {
  const queue = new AsyncEventQueue<SessionEvent>();
  void (async () => {
    for await (const event of queue) {
      events.push(event);
      queue.ackConsumed();
    }
  })();
  return queue;
}

function header(): SessionHeader {
  return {
    id: RUN.sessionId,
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'c',
    connectionLocked: true,
    model: 'm',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function immediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await immediate();
  }
  assert.fail('condition was not reached');
}
