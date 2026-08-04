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

  // Another client's turn, or an automation's, says nothing about this send.
  it('survives an answer that names a different turn', () => {
    const armed = armLiveTurn('turn-mine');

    assert.equal(confirmLiveTurn(armed, 'turn-theirs'), armed);
  });

  // A late answer about a turn this arm has already replaced must not confirm
  // the newer send.
  it('survives a late answer about the turn the arm moved past', () => {
    const rearmed = armLiveTurn('turn-2');

    assert.equal(confirmLiveTurn(rearmed, 'turn-1'), rearmed);
  });

  it('is identity-preserving when there is nothing to confirm', () => {
    const confirmed = confirmLiveTurn(armLiveTurn('turn-1'), 'turn-1')!;

    assert.equal(confirmLiveTurn(confirmed, 'turn-1'), confirmed);
  });

  // Any event about the turn is itself the authority answering, so the claim
  // must not outlive the first one — otherwise a turn that ended while its
  // stream wasn't followed could never be settled.
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

  it('is dropped when the turn terminates', () => {
    const streamed = applyLiveTurnEvent(armLiveTurn('turn-1'), {
      type: 'text_delta',
      id: 'event-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 100,
      text: '你',
    });
    const rearmed = { ...streamed, unconfirmed: true as const };
    const done = applyLiveTurnEvent(rearmed, {
      type: 'complete',
      id: 'event-2',
      turnId: 'turn-1',
      ts: 200,
      stopReason: 'end_turn',
    });

    assert.equal(done?.terminal, true);
    assert.equal(done?.unconfirmed, undefined);
  });
});

describe('applyLiveTurnEvent', () => {
  it('moves an armed turn from waiting to streamed on its first content event', () => {
    const waiting = armLiveTurn('turn-1');
    assert.equal(waiting.phase, 'waiting');

    const streamed = applyLiveTurnEvent(waiting, {
      type: 'thinking_delta',
      id: 'event-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 100,
      text: '开始',
    });
    assert.equal(streamed.phase, 'streamed');
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

  it('keeps the thinking message id as the live step identity', () => {
    const projection = applyLiveTurnEvent(undefined, {
      type: 'thinking_delta',
      id: 'event-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 100,
      text: '先检查工具',
    });

    assert.equal(projection.turnId, 'turn-1');
    assert.deepEqual(projection.steps, [{
      stepId: 'step-1',
      contentOrder: ['thinking'],
      thinking: {
        text: '先检查工具',
        truncated: false,
        complete: false,
      },
      tools: [],
    }]);
  });

  it('places a tool in the live step identified by tool_start.stepId', () => {
    const thinking = applyLiveTurnEvent(undefined, {
      type: 'thinking_delta',
      id: 'event-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 100,
      text: '先检查工具',
    });
    const projection = applyLiveTurnEvent(thinking, {
      type: 'tool_start',
      id: 'event-2',
      turnId: 'turn-1',
      stepId: 'step-1',
      toolUseId: 'tool-1',
      toolName: 'Task List',
      activityKind: 'command',
      args: {},
      ts: 101,
    });

    assert.equal(projection.steps.length, 1);
    assert.deepEqual(projection.steps[0]?.tools, [{
      toolUseId: 'tool-1',
      toolName: 'Task List',
      activityKind: 'command',
      stepId: 'step-1',
      status: 'pending',
      args: {},
    }]);
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

  it('keeps answer text in the same step as its reasoning', () => {
    const thinking = applyLiveTurnEvent(undefined, {
      type: 'thinking_delta',
      id: 'event-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 100,
      text: '先分析',
    });
    const projection = applyLiveTurnEvent(thinking, {
      type: 'text_delta',
      id: 'event-2',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 101,
      text: '答案',
    });

    assert.equal(projection.steps.length, 1);
    assert.deepEqual(projection.steps[0]?.text, {
      text: '答案',
      truncated: false,
      complete: false,
    });
  });

  it('marks final answer text complete without changing its step identity', () => {
    const partial = applyLiveTurnEvent(undefined, {
      type: 'text_delta',
      id: 'event-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 100,
      text: '答',
    });
    const projection = applyLiveTurnEvent(partial, {
      type: 'text_complete',
      id: 'event-2',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 101,
      text: '答案',
    });

    assert.equal(projection.steps[0]?.stepId, 'step-1');
    assert.deepEqual(projection.steps[0]?.text, {
      text: '答案',
      truncated: false,
      complete: true,
    });
  });

  it('settles a tool result in place inside its live step', () => {
    const started = applyLiveTurnEvent(undefined, {
      type: 'tool_start',
      id: 'event-1',
      turnId: 'turn-1',
      stepId: 'step-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args: {},
      ts: 100,
    });
    const projection = applyLiveTurnEvent(started, {
      type: 'tool_result',
      id: 'event-2',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      isError: false,
      content: { kind: 'text', text: 'ok' },
      durationMs: 12,
      ts: 101,
    });

    assert.equal(projection.steps.length, 1);
    assert.deepEqual(projection.steps[0]?.tools[0], {
      toolUseId: 'tool-1',
      toolName: 'Bash',
      stepId: 'step-1',
      status: 'completed',
      args: {},
      result: { kind: 'text', text: 'ok' },
      durationMs: 12,
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

  it('appends streamed tool output to the existing tool without changing its step', () => {
    const started = applyLiveTurnEvent(undefined, {
      type: 'tool_start',
      id: 'event-1',
      turnId: 'turn-1',
      stepId: 'step-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args: {},
      ts: 100,
    });
    const projection = applyLiveTurnEvent(started, {
      type: 'tool_output_delta',
      id: 'event-2',
      turnId: 'turn-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      toolUseId: 'tool-1',
      seq: 0,
      stream: 'stdout',
      chunk: 'hello\n',
      redacted: false,
      createdAt: 101,
      ts: 101,
    });

    assert.equal(projection.steps[0]?.stepId, 'step-1');
    assert.equal(projection.steps[0]?.tools[0]?.status, 'running');
    assert.deepEqual(projection.steps[0]?.tools[0]?.outputChunks, [{
      seq: 0,
      stream: 'stdout',
      text: 'hello\n',
      redacted: false,
      createdAt: 101,
    }]);
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

  it('ignores legacy generic permission events in the live projection', () => {
    const started = applyLiveTurnEvent(undefined, {
      type: 'tool_start',
      id: 'event-1',
      turnId: 'turn-1',
      stepId: 'step-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args: { command: 'rm file' },
      ts: 100,
    });
    const waiting = applyLiveTurnEvent(started, {
      type: 'permission_request',
      kind: 'tool_permission',
      id: 'event-2',
      turnId: 'turn-1',
      requestId: 'request-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      args: { command: 'rm file' },
      rememberForTurnAllowed: true,
      ts: 101,
    });
    const allowed = applyLiveTurnEvent(waiting, {
      type: 'permission_decision_ack',
      id: 'event-3',
      turnId: 'turn-1',
      requestId: 'request-1',
      toolUseId: 'tool-1',
      decision: 'allow',
      ts: 102,
    });

    assert.equal(waiting, started);
    assert.equal(allowed, started);
    assert.equal(allowed?.steps[0]?.tools[0]?.status, 'pending');
    assert.equal(allowed?.steps[0]?.stepId, 'step-1');
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
