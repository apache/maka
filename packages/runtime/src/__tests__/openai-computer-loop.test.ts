import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CuAction } from '@maka/core/computer-use';
import { runOpenAIComputerLoop } from '../openai-computer-loop.js';
import type { OpenAIComputerRequest } from '../openai-computer-codec.js';

const success = () => ({
  outcome: { ok: true as const, tier: 'coordinate-background' as const },
});

const call = (over: Record<string, unknown> = {}) => ({
  type: 'computer_call',
  id: 'item_1',
  call_id: 'call_1',
  status: 'completed',
  pending_safety_checks: [],
  actions: [],
  ...over,
});

describe('runOpenAIComputerLoop', () => {
  test('executes actions[] in order, captures once, and continues with the call id', async () => {
    const requests: OpenAIComputerRequest[] = [];
    const executed: CuAction[] = [];
    const responses = [
      {
        id: 'resp_1',
        output: [
          call({
            actions: [
              { type: 'move', x: 1, y: 2 },
              { type: 'click', button: 'left', x: 1, y: 2 },
              { type: 'type', text: 'ok' },
            ],
          }),
        ],
      },
      { id: 'resp_2', output: [{ type: 'message', content: [] }] },
    ];
    const result = await runOpenAIComputerLoop({
      dialect: 'ga',
      model: 'gpt',
      prompt: 'go',
      transport: {
        async create(request) {
          requests.push(request);
          return responses.shift();
        },
      },
      executor: {
        async execute(action) {
          executed.push(action);
          return success();
        },
      },
      screenshot: {
        async capture() {
          return { base64: 'AA==', mimeType: 'image/png' };
        },
      },
      allowAction: async () => true,
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(
      executed.map((action) => action.type),
      ['mouse_move', 'left_click', 'type'],
    );
    assert.equal(requests[1].previous_response_id, 'resp_1');
    assert.equal((requests[1].input as Array<{ call_id: string }>)[0].call_id, 'call_1');
  });

  test('blocks pending safety checks before executing any action', async () => {
    let executions = 0;
    const result = await runOpenAIComputerLoop({
      dialect: 'ga',
      model: 'gpt',
      prompt: 'go',
      transport: {
        async create() {
          return {
            id: 'resp_1',
            output: [
              call({
                pending_safety_checks: [{ id: 'safe_1', code: 'confirm', message: 'Confirm' }],
                actions: [{ type: 'click', button: 'left', x: 1, y: 2 }],
              }),
            ],
          };
        },
      },
      executor: {
        async execute() {
          executions += 1;
          return success();
        },
      },
      screenshot: {
        async capture() {
          throw new Error('must not capture');
        },
      },
    });
    assert.equal(result.status, 'safety_blocked');
    assert.equal(executions, 0);
  });

  test('prevalidates the entire batch so an unsupported later action causes zero execution', async () => {
    let executions = 0;
    const result = await runOpenAIComputerLoop({
      dialect: 'ga',
      model: 'gpt',
      prompt: 'go',
      transport: {
        async create() {
          return {
            id: 'resp_1',
            output: [
              call({
                actions: [
                  { type: 'click', button: 'left', x: 1, y: 2 },
                  { type: 'scroll', x: 1, y: 2, scroll_x: 0, scroll_y: 100 },
                ],
              }),
            ],
          };
        },
      },
      executor: {
        async execute() {
          executions += 1;
          return success();
        },
      },
      screenshot: {
        async capture() {
          throw new Error('must not capture');
        },
      },
      allowAction: async () => true,
    });
    assert.equal(result.status, 'unsupported_action');
    if (result.status === 'unsupported_action') {
      assert.equal(result.actionIndex, 1);
      assert.equal(result.failure.code, 'unsupported_scroll_delta');
    }
    assert.equal(executions, 0);
  });

  test('rejects a mixed batch before execution when it contains compatibility input', async () => {
    let executions = 0;
    const result = await runOpenAIComputerLoop({
      dialect: 'ga',
      model: 'gpt',
      prompt: 'go',
      transport: {
        async create() {
          return {
            id: 'resp_1',
            output: [
              call({
                actions: [{ type: 'screenshot' }, { type: 'click', button: 'left', x: 1, y: 2 }],
              }),
            ],
          };
        },
      },
      executor: {
        async execute() {
          executions += 1;
          return success();
        },
      },
      screenshot: {
        async capture() {
          throw new Error('must not capture');
        },
      },
    });
    assert.equal(result.status, 'unsupported_action');
    if (result.status === 'unsupported_action') {
      assert.equal(result.actionIndex, 1);
      assert.equal(result.failure.code, 'unsupported_action_policy');
    }
    assert.equal(executions, 0);
  });

  test('an explicit scenario policy can opt into a converted action', async () => {
    const executed: CuAction[] = [];
    const responses = [
      {
        id: 'resp_1',
        output: [
          call({
            actions: [{ type: 'click', button: 'left', x: 1, y: 2 }],
          }),
        ],
      },
      { id: 'resp_2', output: [] },
    ];
    const result = await runOpenAIComputerLoop({
      dialect: 'ga',
      model: 'gpt',
      prompt: 'go',
      transport: {
        async create() {
          return responses.shift();
        },
      },
      executor: {
        async execute(action) {
          executed.push(action);
          return success();
        },
      },
      screenshot: {
        async capture() {
          return { base64: 'AA==', mimeType: 'image/png' };
        },
      },
      allowAction: async () => true,
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(executed, [
      {
        type: 'left_click',
        coordinate: { x: 1, y: 2 },
      },
    ]);
  });

  test('does not treat failed or incomplete responses as completion', async () => {
    for (const response of [
      {
        id: 'failed',
        status: 'failed',
        error: { type: 'server_error', code: 'capacity', message: 'No capacity' },
        output: [],
      },
      { id: 'incomplete', status: 'incomplete', error: null, output: [] },
    ]) {
      await assert.rejects(
        () =>
          runOpenAIComputerLoop({
            dialect: 'ga',
            model: 'gpt',
            prompt: 'go',
            transport: {
              async create() {
                return response;
              },
            },
            executor: {
              async execute() {
                return success();
              },
            },
            screenshot: {
              async capture() {
                return { base64: 'AA==', mimeType: 'image/png' };
              },
            },
          }),
        /openai_computer_response_(failed|not_completed)/,
      );
    }
  });

  test('executes an acknowledged safety batch and echoes acknowledgements', async () => {
    const requests: OpenAIComputerRequest[] = [];
    const responses = [
      {
        id: 'resp_1',
        output: [
          call({
            pending_safety_checks: [{ id: 'safe_1', code: 'confirm', message: 'Confirm' }],
            actions: [{ type: 'screenshot' }],
          }),
        ],
      },
      { id: 'resp_2', output: [] },
    ];
    const result = await runOpenAIComputerLoop({
      dialect: 'ga',
      model: 'gpt',
      prompt: 'go',
      transport: {
        async create(request) {
          requests.push(request);
          return responses.shift();
        },
      },
      executor: {
        async execute() {
          return success();
        },
      },
      screenshot: {
        async capture() {
          return { base64: 'AA==', mimeType: 'image/png' };
        },
      },
      acknowledgeSafetyChecks: async () => true,
    });
    assert.equal(result.status, 'completed');
    const item = (requests[1].input as Array<{ acknowledged_safety_checks?: unknown }>)[0];
    assert.deepEqual(item.acknowledged_safety_checks, [
      {
        id: 'safe_1',
        code: 'confirm',
        message: 'Confirm',
      },
    ]);
  });

  test('keeps the preview request contract across the loop', async () => {
    const requests: OpenAIComputerRequest[] = [];
    const responses = [
      {
        id: 'resp_1',
        output: [
          {
            type: 'computer_call',
            id: 'item_1',
            call_id: 'call_1',
            status: 'completed',
            pending_safety_checks: [],
            action: { type: 'wait' },
          },
        ],
      },
      { id: 'resp_2', output: [] },
    ];
    const result = await runOpenAIComputerLoop({
      dialect: 'preview',
      model: 'computer-use-preview',
      prompt: 'go',
      display: { widthPx: 1024, heightPx: 768, environment: 'browser' },
      transport: {
        async create(request) {
          requests.push(request);
          return responses.shift();
        },
      },
      executor: {
        async execute() {
          return success();
        },
      },
      screenshot: {
        async capture() {
          return { base64: 'AA==', mimeType: 'image/png' };
        },
      },
    });
    assert.equal(result.status, 'completed');
    assert.equal(requests[0].truncation, 'auto');
    assert.deepEqual(requests[1].tools, [
      {
        type: 'computer_use_preview',
        display_width: 1024,
        display_height: 768,
        environment: 'browser',
      },
    ]);
    assert.equal(requests[1].truncation, 'auto');
  });
});
