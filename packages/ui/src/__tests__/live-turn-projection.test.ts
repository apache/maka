import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  applyLiveTurnEvent,
  armLiveTurn,
  confirmLiveTurn,
  reconcileTerminalLiveTurn,
  settleLiveTurnStep,
  type LiveTurnProjection,
} from '../live-turn-projection.js';
import { overlayLiveTurn, type ToolActivityItem } from '../materialize.js';

// A client that just sent cannot read "has my turn started" off session status:
// it is the same before the turn starts and after it ends. The arm carries
// `unconfirmed` until the authority says something about THAT turn, which is
// what stops a snapshot taken before the send landed from retiring it.
describe('the unconfirmed claim an arm carries', () => {
  it('is set at arm and dropped by an answer naming the same turn', () => {
    const armed = armLiveTurn('turn-1');
    assert.equal(armed.unconfirmed, true);

    const confirmed = confirmLiveTurn(armed, 'turn-1');
    assert.equal(confirmed?.unconfirmed, undefined);
    assert.equal(confirmed?.turnId, 'turn-1');
    assert.equal(confirmed?.phase, 'waiting', 'confirming is not the same as streaming');
  });

  // Another client's turn, or a scheduled task's, says nothing about this send.
  it('survives an answer that names a different turn', () => {
    const armed = armLiveTurn('turn-mine');

    assert.equal(confirmLiveTurn(armed, 'turn-theirs'), armed);
  });

  it('is dropped by the turn\'s own events, not just by an explicit answer', () => {
    const streamed = applyLiveTurnEvent(armLiveTurn('turn-1'), {
      type: 'text_delta',
      id: 'event-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 100,
      text: '你',
    });

    assert.equal(streamed.unconfirmed, undefined);
  });
});

describe('applyLiveTurnEvent', () => {
  it('folds replayed absolute deltas instead of appending a resubscription seed', () => {
    const seed = {
      type: 'text_delta' as const,
      id: 'seed-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 100,
      startOffset: 0,
      text: 'Hello',
    };
    const first = applyLiveTurnEvent(undefined, seed);
    const replayed = applyLiveTurnEvent(first, { ...seed, id: 'seed-2', ts: 200 });
    const extended = applyLiveTurnEvent(replayed, {
      ...seed,
      id: 'delta-3',
      ts: 300,
      startOffset: 5,
      text: ' world',
    });

    assert.equal(replayed.steps[0]?.text?.text, 'Hello');
    assert.equal(extended.steps[0]?.text?.text, 'Hello world');
    assert.equal(extended.steps[0]?.text?.sourceEndOffset, 11);
  });

  it('tracks absolute thinking offsets independently from redacted display text', () => {
    const first = applyLiveTurnEvent(undefined, {
      type: 'thinking_delta',
      id: 'thinking-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 100,
      startOffset: 0,
      text: 'Authorization: Bearer secret-value',
    });
    const replayed = applyLiveTurnEvent(first, {
      type: 'thinking_delta',
      id: 'thinking-2',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 200,
      startOffset: 0,
      text: 'Authorization: Bearer secret-value',
    });

    assert.equal(replayed.steps[0]?.thinking?.text, first.steps[0]?.thinking?.text);
    assert.equal(
      replayed.steps[0]?.thinking?.sourceEndOffset,
      'Authorization: Bearer secret-value'.length,
    );
  });


  it('projects transient provider retry progress until the next model output', () => {
    const scheduled = applyLiveTurnEvent(armLiveTurn('turn-1'), {
      type: 'provider_retry',
      id: 'retry-1',
      turnId: 'turn-1',
      ts: 100,
      phase: 'scheduled',
      attempt: 2,
      maxAttempts: 10,
      delayMs: 4_000,
      reason: 'rate_limit',
    });
    assert.deepEqual(scheduled?.providerRetry, {
      type: 'provider_retry',
      id: 'retry-1',
      turnId: 'turn-1',
      ts: 100,
      phase: 'scheduled',
      attempt: 2,
      maxAttempts: 10,
      delayMs: 4_000,
      reason: 'rate_limit',
    });

    const started = applyLiveTurnEvent(scheduled, {
      type: 'provider_retry',
      id: 'retry-2',
      turnId: 'turn-1',
      ts: 101,
      phase: 'started',
      attempt: 2,
      maxAttempts: 10,
      reason: 'rate_limit',
    });
    assert.equal(started?.providerRetry?.phase, 'started');

    const streamed = applyLiveTurnEvent(started, {
      type: 'text_delta',
      id: 'event-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 102,
      text: '恢复',
    });
    assert.equal(streamed?.providerRetry, undefined);
  });



  it('replaces the live reasoning with thinking_complete on the same step', () => {
    const partial = applyLiveTurnEvent(undefined, {
      type: 'thinking_delta',
      id: 'event-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 100,
      text: '部分',
    });
    const projection = applyLiveTurnEvent(partial, {
      type: 'thinking_complete',
      id: 'event-2',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 101,
      text: '完整思考',
    });

    assert.deepEqual(projection.steps[0]?.thinking, {
      text: '完整思考',
      truncated: false,
      complete: true,
    });
  });




  it('retains live nested tool activity identity', () => {
    const projection = applyLiveTurnEvent(undefined, {
      type: 'tool_start',
      id: 'event-1',
      turnId: 'turn-1',
      stepId: 'step-1',
      toolUseId: 'nested-1',
      toolName: 'Read',
      args: { path: 'README.md' },
      origin: 'code_mode',
      modelVisibility: 'hidden',
      parentToolCallId: 'exec-1',
      parentOperationId: 'exec-operation-1',
      ts: 100,
    });

    assert.deepEqual(projection.steps[0]?.tools[0], {
      toolUseId: 'nested-1',
      toolName: 'Read',
      stepId: 'step-1',
      status: 'pending',
      args: { path: 'README.md' },
      origin: 'code_mode',
      modelVisibility: 'hidden',
      parentToolCallId: 'exec-1',
      parentOperationId: 'exec-operation-1',
    });
  });

  it('retains nested identity when a tool result arrives before its start', () => {
    const projection = applyLiveTurnEvent(undefined, {
      type: 'tool_result',
      id: 'event-1',
      turnId: 'turn-1',
      toolUseId: 'nested-1',
      isError: false,
      content: { kind: 'text', text: 'ok' },
      origin: 'code_mode',
      modelVisibility: 'hidden',
      parentToolCallId: 'exec-1',
      parentOperationId: 'exec-operation-1',
      ts: 100,
    });

    assert.deepEqual(projection.steps[0]?.tools[0], {
      toolUseId: 'nested-1',
      toolName: 'Tool',
      status: 'completed',
      args: undefined,
      result: { kind: 'text', text: 'ok' },
      origin: 'code_mode',
      modelVisibility: 'hidden',
      parentToolCallId: 'exec-1',
      parentOperationId: 'exec-operation-1',
    });
  });

  it('maps cancelled terminal tool_result to interrupted, not errored', () => {
    const started = applyLiveTurnEvent(undefined, {
      type: 'tool_start',
      id: 'event-1',
      turnId: 'turn-1',
      stepId: 'step-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args: { command: 'sleep 99' },
      ts: 100,
    });
    const projection = applyLiveTurnEvent(started, {
      type: 'tool_result',
      id: 'event-2',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      isError: true,
      content: {
        kind: 'terminal',
        cwd: '/repo',
        cmd: 'sleep 99',
        status: 'cancelled',
        exitCode: 130,
        output: {
          mode: 'pipes',
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
      },
      ts: 101,
    });

    assert.equal(projection.steps[0]?.tools[0]?.status, 'interrupted');
  });


  it('moves an output-first tool into its real step without duplicating or regressing it', () => {
    const output = applyLiveTurnEvent(undefined, {
      type: 'tool_output_delta',
      id: 'event-1',
      turnId: 'turn-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      toolUseId: 'tool-1',
      seq: 0,
      stream: 'stdout',
      chunk: 'hello\n',
      redacted: false,
      createdAt: 100,
      ts: 100,
    });
    const projection = applyLiveTurnEvent(output, {
      type: 'tool_start',
      id: 'event-2',
      turnId: 'turn-1',
      stepId: 'step-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args: { command: 'printf hello' },
      ts: 101,
    });

    assert.equal(projection.steps.length, 1);
    assert.equal(projection.steps[0]?.stepId, 'step-1');
    assert.deepEqual(projection.steps[0]?.tools, [{
      toolUseId: 'tool-1',
      toolName: 'Bash',
      stepId: 'step-1',
      status: 'running',
      args: { command: 'printf hello' },
      outputChunks: [{
        seq: 0,
        stream: 'stdout',
        text: 'hello\n',
        redacted: false,
        createdAt: 100,
      }],
      outputTruncated: false,
    }]);
  });

  it('preserves steering positions when an output-first tool receives its real step', () => {
    const firstSteer = applyLiveTurnEvent(undefined, {
      type: 'steering_message', id: 'steer-event-1', messageId: 'steer-1',
      turnId: 'turn-1', ts: 99, content: { text: 'before tool' },
    });
    const output = applyLiveTurnEvent(firstSteer, {
      type: 'tool_output_delta', id: 'output-1', turnId: 'turn-1',
      sessionId: 'session-1', toolCallId: 'tool-1', toolUseId: 'tool-1',
      seq: 0, stream: 'stdout', chunk: 'hello\n', redacted: false,
      createdAt: 100, ts: 100,
    });
    const answer = applyLiveTurnEvent(output, {
      type: 'text_delta', id: 'text-1', messageId: 'step-1',
      turnId: 'turn-1', ts: 101, text: 'answer',
    });
    const secondSteer = applyLiveTurnEvent(answer, {
      type: 'steering_message', id: 'steer-event-2', messageId: 'steer-2',
      turnId: 'turn-1', ts: 102, content: { text: 'after tool' },
    });
    const projection = applyLiveTurnEvent(secondSteer, {
      type: 'tool_start', id: 'start-1', turnId: 'turn-1', stepId: 'step-1',
      toolUseId: 'tool-1', toolName: 'Bash', args: {}, ts: 103,
    });

    assert.equal(projection.steps.flatMap((step) => step.tools).length, 1);
    assert.deepEqual(
      overlayLiveTurn([], projection)[0]?.timeline.map((item) =>
        item.kind === 'user' ? `user:${item.message.text}` : item.kind),
      ['user:before tool', 'text', 'tools', 'user:after tool'],
    );
  });


  it('appends late thinking without moving an already visible tool', () => {
    const tool = applyLiveTurnEvent(undefined, {
      type: 'tool_start',
      id: 'event-1',
      turnId: 'turn-1',
      stepId: 'step-1',
      toolUseId: 'tool-1',
      toolName: 'Read',
      args: {},
      ts: 100,
    });
    const withLateThinking = applyLiveTurnEvent(tool, {
      type: 'thinking_complete',
      id: 'event-2',
      turnId: 'turn-1',
      messageId: 'step-1',
      text: 'late reasoning',
      ts: 101,
    });

    const timeline = overlayLiveTurn([], withLateThinking)[0]?.timeline;
    assert.deepEqual(timeline?.map((item) => item.kind), ['tools', 'thinking']);
  });

  it('drops a terminal projection only after its last live step settles', () => {
    const streaming = applyLiveTurnEvent(armLiveTurn('turn-1'), {
      type: 'text_delta',
      id: 'event-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 100,
      text: 'answer',
    });
    const running = applyLiveTurnEvent(streaming, {
      type: 'tool_start',
      id: 'event-2',
      turnId: 'turn-1',
      stepId: 'step-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args: {},
      ts: 101,
    });
    const terminal = applyLiveTurnEvent(running, {
      type: 'complete',
      id: 'event-3',
      turnId: 'turn-1',
      ts: 102,
      stopReason: 'end_turn',
    });

    assert.equal(terminal?.terminal, true);
    assert.equal(terminal?.steps[0]?.text?.complete, true);
    assert.equal(terminal?.steps[0]?.tools[0]?.status, 'interrupted');
    assert.equal(settleLiveTurnStep(terminal!, 'step-1'), undefined);
  });

  it('marks an aborted projection terminal with in-flight tools interrupted', () => {
    const thinking = applyLiveTurnEvent(undefined, {
      type: 'thinking_delta',
      id: 'event-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      text: 'partial reasoning',
      ts: 100,
    });
    const streaming = applyLiveTurnEvent(thinking, {
      type: 'text_delta',
      id: 'event-2',
      turnId: 'turn-1',
      messageId: 'step-1',
      text: 'partial answer',
      ts: 101,
    });
    const running = applyLiveTurnEvent(streaming, {
      type: 'tool_start',
      id: 'event-3',
      turnId: 'turn-1',
      stepId: 'step-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args: {},
      ts: 102,
    });
    const aborted = applyLiveTurnEvent(running, {
      type: 'abort',
      id: 'event-4',
      turnId: 'turn-1',
      ts: 103,
      reason: 'user_stop',
    });

    assert.equal(aborted?.terminal, true);
    assert.equal(aborted?.steps[0]?.thinking?.complete, true);
    assert.equal(aborted?.steps[0]?.text?.complete, true);
    assert.equal(aborted?.steps[0]?.tools[0]?.status, 'interrupted');
  });
});

describe('settleLiveTurnStep', () => {
  it('removes only the committed step and drops an empty projection', () => {
    const projection = {
      turnId: 'turn-1',
      phase: 'streamed' as const,
      steps: [
        { stepId: 'step-1', tools: [] },
        { stepId: 'step-2', tools: [] },
      ],
    };

    assert.deepEqual(settleLiveTurnStep(projection, 'step-1'), {
      turnId: 'turn-1',
      phase: 'streamed',
      steps: [{ stepId: 'step-2', tools: [] }],
    });
    assert.deepEqual(
      settleLiveTurnStep({ turnId: 'turn-1', phase: 'streamed', steps: [{ stepId: 'step-1', tools: [] }] }, 'step-1'),
      { turnId: 'turn-1', phase: 'streamed', steps: [] },
    );
  });

  it('keeps co-located tool stream evidence when text handoff settles', () => {
    const projection: LiveTurnProjection = {
      turnId: 'turn-1',
      phase: 'streamed',
      terminal: true,
      steps: [{
        stepId: 'step-1',
        text: { text: 'done', truncated: false, complete: true },
        tools: [{
          toolUseId: 'tool-1',
          toolName: 'Bash',
          status: 'completed',
          args: { command: 'npm test' },
          outputChunks: [
            { seq: 0, stream: 'stdout', text: 'starting-live-output\n', redacted: true, createdAt: 1 },
          ],
          outputTruncated: true,
        }],
      }],
    };

    const settled = settleLiveTurnStep(projection, 'step-1');
    assert.ok(settled);
    assert.equal(settled!.steps.length, 1);
    assert.equal(settled!.steps[0]!.text, undefined);
    assert.equal(settled!.steps[0]!.tools[0]!.outputChunks?.[0]?.text, 'starting-live-output\n');
  });

  it('still drops tools without live stream evidence on text settle', () => {
    const projection: LiveTurnProjection = {
      turnId: 'turn-1',
      phase: 'streamed',
      terminal: true,
      steps: [{
        stepId: 'step-1',
        text: { text: 'done', truncated: false, complete: true },
        tools: [{
          toolUseId: 'tool-1',
          toolName: 'Bash',
          status: 'interrupted',
          args: {},
        }],
      }],
    };
    assert.equal(settleLiveTurnStep(projection, 'step-1'), undefined);
  });
});

describe('reconcileTerminalLiveTurn', () => {
  const toolOnly: LiveTurnProjection = {
    turnId: 'turn-1',
    phase: 'streamed' as const,
    terminal: true,
    steps: [{
      stepId: 'step-1',
      tools: [{ toolUseId: 'tool-1', toolName: 'Bash', status: 'completed' as const, args: {} }],
    }],
  };

  it('settles a tool-only terminal step once persisted history covers it', () => {
    assert.equal(reconcileTerminalLiveTurn(toolOnly, [
      { type: 'tool_call', id: 'tool-1', turnId: 'turn-1', stepId: 'step-1', ts: 1, toolName: 'Bash', args: {} },
      { type: 'tool_result', id: 'result-1', turnId: 'turn-1', ts: 2, toolUseId: 'tool-1', isError: false, content: { kind: 'text', text: 'ok' } },
    ]), undefined);
  });

  it('keeps a non-terminal projection armed once persisted history covers all steps', () => {
    const inFlight: LiveTurnProjection = {
      turnId: 'turn-1',
      phase: 'streamed',
      steps: toolOnly.steps,
    };
    assert.deepEqual(reconcileTerminalLiveTurn(inFlight, [
      { type: 'tool_call', id: 'tool-1', turnId: 'turn-1', stepId: 'step-1', ts: 1, toolName: 'Bash', args: {} },
      { type: 'tool_result', id: 'result-1', turnId: 'turn-1', ts: 2, toolUseId: 'tool-1', isError: false, content: { kind: 'text', text: 'ok' } },
    ]), { turnId: 'turn-1', phase: 'streamed', steps: [] });
  });

  it('retains terminal evidence while persisted history does not cover it', () => {
    assert.equal(reconcileTerminalLiveTurn(toolOnly, []), toolOnly);
  });

  it('keeps terminal live steering until the terminal transcript catches up', () => {
    const message = { id: 'steer-1', content: { text: 'change direction' }, ts: 2 };
    const withSteering: LiveTurnProjection = {
      ...toolOnly,
      steps: [{ ...toolOnly.steps[0]!, leadingSteering: [message] }],
    };

    assert.equal(reconcileTerminalLiveTurn(withSteering, []), withSteering);
    const steeringOnly = { ...withSteering, steps: [] };
    assert.equal(reconcileTerminalLiveTurn(steeringOnly, []), steeringOnly);
    assert.deepEqual(reconcileTerminalLiveTurn(withSteering, [{
      type: 'turn_state', id: 'state-1', turnId: 'turn-1', ts: 3,
      status: 'completed', partialOutputRetained: false,
    }]), toolOnly);
  });

  it('keeps steering-only aborts visible for transcript handoff', () => {
    const message = { id: 'steer-1', content: { text: 'change direction' }, ts: 2 };
    const withSteering = applyLiveTurnEvent(undefined, {
      type: 'steering_message', id: 'steer-event', messageId: message.id,
      turnId: 'turn-1', ts: message.ts, content: message.content,
    });
    const aborted = applyLiveTurnEvent(withSteering, {
      type: 'abort', id: 'abort-1', turnId: 'turn-1', ts: 3, reason: 'user_stop',
    });

    assert.equal(aborted?.terminal, true);
    assert.deepEqual(aborted?.pendingSteering, [message]);
  });

  it('retains interrupted live output until a persisted result covers it', () => {
    const withOutput: LiveTurnProjection = {
      ...toolOnly,
      steps: [{
        ...toolOnly.steps[0]!,
        tools: [{
          ...toolOnly.steps[0]!.tools[0]!,
          status: 'interrupted',
          outputChunks: [{ seq: 0, stream: 'stdout', text: 'partial evidence', redacted: false, createdAt: 1 }],
        }],
      }],
    };
    const toolCallOnly = [
      { type: 'tool_call' as const, id: 'tool-1', turnId: 'turn-1', stepId: 'step-1', ts: 1, toolName: 'Bash', args: {} },
    ];

    assert.equal(reconcileTerminalLiveTurn(withOutput, toolCallOnly), withOutput);
  });

  it('keeps live stream evidence when persisted shell_run streams are still empty', () => {
    const withOutput: LiveTurnProjection = {
      ...toolOnly,
      steps: [{
        ...toolOnly.steps[0]!,
        tools: [{
          ...toolOnly.steps[0]!.tools[0]!,
          status: 'completed',
          outputChunks: [
            { seq: 0, stream: 'stdout', text: 'starting-live-output\n', redacted: true, createdAt: 1 },
          ],
          outputTruncated: true,
        }],
      }],
    };
    const emptyContent = {
      kind: 'shell_run' as const,
      ref: 'maka://runtime/background-tasks/bg',
      mode: 'pipes' as const,
      status: 'running' as const,
      cwd: '/repo',
      cmd: 'npm test',
      startedAt: 1,
      updatedAt: 2,
      revision: 1,
    };
    const emptyShellRun = [
      { type: 'tool_call' as const, id: 'tool-1', turnId: 'turn-1', stepId: 'step-1', ts: 1, toolName: 'Bash', args: {} },
      {
        type: 'tool_result' as const,
        id: 'result-1',
        turnId: 'turn-1',
        ts: 2,
        toolUseId: 'tool-1',
        isError: false,
        content: emptyContent,
      },
    ];

    assert.equal(reconcileTerminalLiveTurn(withOutput, emptyShellRun), withOutput);

    const filled = [
      emptyShellRun[0]!,
      {
        type: 'tool_result' as const,
        id: 'result-1',
        turnId: 'turn-1',
        ts: 2,
        toolUseId: 'tool-1',
        isError: false,
        content: {
          ...emptyContent,
          output: {
            mode: 'pipes' as const,
            stdout: 'starting-live-output\n',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            redacted: false,
          },
        },
      },
    ];
    assert.equal(reconcileTerminalLiveTurn(withOutput, filled), undefined);
  });

  it('leaves text steps to the streaming display handoff', () => {
    const textTurn: LiveTurnProjection = {
      ...toolOnly,
      steps: [{
        ...toolOnly.steps[0]!,
        text: { text: 'answer', truncated: false, complete: true },
      }],
    };
    assert.equal(reconcileTerminalLiveTurn(textTurn, [
      { type: 'assistant', id: 'step-1', turnId: 'turn-1', ts: 1, text: 'answer', modelId: 'm' },
      { type: 'tool_call', id: 'tool-1', turnId: 'turn-1', stepId: 'step-1', ts: 2, toolName: 'Bash', args: {} },
    ]), textTurn);
  });

  it('settles a persisted thinking-only step whose text slot is empty', () => {
    const thinkingOnly: LiveTurnProjection = {
      turnId: 'turn-1',
      phase: 'streamed',
      terminal: true,
      steps: [{
        stepId: 'step-1',
        thinking: { text: 'reasoning', truncated: false, complete: true },
        text: { text: '', truncated: false, complete: true },
        tools: [],
      }],
    };

    assert.equal(reconcileTerminalLiveTurn(thinkingOnly, [
      { type: 'assistant', id: 'step-1', turnId: 'turn-1', ts: 1, text: '', thinking: { text: 'reasoning' }, modelId: 'm' },
    ]), undefined);
  });

  it('drops persisted stream evidence before the next tool batch settles', () => {
    const evidence = (toolUseId: string): ToolActivityItem => ({
      toolUseId,
      toolName: 'Bash',
      status: 'completed',
      args: {},
      outputChunks: [{ seq: 0, stream: 'stdout', text: 'ok\n', redacted: false, createdAt: 1 }],
    });
    const current = (toolUseId: string): ToolActivityItem => ({
      toolUseId,
      toolName: 'Bash',
      status: 'running',
      args: {},
    });
    const projection: LiveTurnProjection = {
      turnId: 'turn-1',
      phase: 'streamed',
      steps: [
        { stepId: 'step-1', tools: ['old-1', 'old-2', 'old-3'].map(evidence), contentOrder: ['tools'] },
        { stepId: 'step-2', tools: ['new-1', 'new-2', 'new-3', 'new-4'].map(current), contentOrder: ['tools'] },
      ],
    };
    const persisted = ['old-1', 'old-2', 'old-3'].flatMap((toolUseId, index) => ([
      { type: 'tool_call' as const, id: toolUseId, turnId: 'turn-1', stepId: 'step-1', ts: index * 2 + 1, toolName: 'Bash', args: {} },
      { type: 'tool_result' as const, id: `result-${toolUseId}`, turnId: 'turn-1', ts: index * 2 + 2, toolUseId, isError: false, content: { kind: 'text' as const, text: 'ok\n' } },
    ]));

    assert.deepEqual(reconcileTerminalLiveTurn(projection, persisted), {
      ...projection,
      steps: [projection.steps[1]!],
    });
  });
});

describe('tool_result_preview live projection', () => {
  it('attaches live open-facts and replaces them with the durable result', () => {
    const previewed = previewedSubagentTurn();
    const previewedTool = previewed.steps[0]?.tools[0];

    assert.equal(previewedTool?.status, 'running');
    assert.equal(
      previewedTool?.result?.kind === 'subagent'
        ? previewedTool.result.childSessionId
        : undefined,
      'child-session',
    );

    const settled = applyLiveTurnEvent(previewed, {
      type: 'tool_result',
      id: 'event-3',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      isError: false,
      content: {
        kind: 'subagent',
        childSessionId: 'child-session',
        agentId: 'local_read',
        agentName: 'Local Read',
        turnId: 'child-turn',
        runId: 'child-run',
        status: 'completed',
        permissionMode: 'explore',
        summary: 'done',
        artifactIds: [],
      },
      ts: 102,
    });
    assert.equal(settled.steps[0]?.tools[0]?.status, 'completed');
    assert.equal(
      settled.steps[0]?.tools[0]?.result &&
        settled.steps[0]?.tools[0]?.result.kind === 'subagent'
        ? settled.steps[0]?.tools[0]?.result.summary
        : undefined,
      'done',
    );
  });

  it('keeps open-facts when RH-style empty tool_result settles the row', () => {
    const previewed = previewedSubagentTurn();
    const settled = applyLiveTurnEvent(previewed, {
      type: 'tool_result',
      id: 'event-3',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      isError: false,
      content: { kind: 'text', text: '' },
      ts: 102,
    });

    assert.equal(settled.steps[0]?.tools[0]?.status, 'completed');
    assert.deepEqual(settled.steps[0]?.tools[0]?.result, previewed.steps[0]?.tools[0]?.result);
  });
});

function previewedSubagentTurn(): LiveTurnProjection {
  const started = applyLiveTurnEvent(undefined, {
    type: 'tool_start',
    id: 'event-1',
    turnId: 'turn-1',
    stepId: 'step-1',
    toolUseId: 'tool-1',
    toolName: 'agent_spawn',
    args: { profile: 'local_read', task: 'Inspect' },
    ts: 100,
  });
  return applyLiveTurnEvent(started, {
    type: 'tool_result_preview',
    id: 'event-2',
    turnId: 'turn-1',
    toolUseId: 'tool-1',
    isError: false,
    content: {
      kind: 'subagent',
      childSessionId: 'child-session',
      agentId: 'local_read',
      agentName: 'Local Read',
      turnId: 'child-turn',
      runId: 'child-run',
      status: 'running',
      permissionMode: 'explore',
    },
    ts: 101,
  });
}
