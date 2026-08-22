/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { LlmConnection } from '@maka/core/llm-connections';

import type { SessionEvent } from '@maka/core/events';

import type { SessionHeader, StoredMessage } from '@maka/core/session';
import { jsonSchema } from 'ai';
import { z } from 'zod';

import { repairMakaToolCall } from '../ai-sdk-backend.js';
import { computerWireParams } from '../computer-use-tools.js';
import {
  TOOL_ERROR_RESULT_MAX_CHARS,
  formatToolArgsViolationText,
  toolParameterFields,
  type MakaTool,
} from '../tool-runtime.js';
import { createTestToolRuntime } from './execution-boundary-test-helpers.js';

const readSchema = z
  .object({
    file_path: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  })
  .strict();

describe('tool argument field lookup', () => {
  test('reads the field names off a plain object schema', () => {
    assert.deepEqual(toolParameterFields(readSchema), ['file_path', 'offset', 'limit']);
  });

  test('still reads them through a refinement', () => {
    const refined = readSchema.refine((value) => value.file_path.length > 0, 'empty path');

    assert.deepEqual(toolParameterFields(refined), ['file_path', 'offset', 'limit']);
  });

  test('picks the branch a discriminated union was called on', () => {
    const schema = z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('list'), limit: z.number().optional() }),
      z.object({ mode: z.literal('create'), name: z.string() }),
    ]);

    assert.deepEqual(toolParameterFields(schema, { mode: 'create', nmae: 'x' }), ['mode', 'name']);
  });

  test('says nothing rather than something wrong when the branch is unknown', () => {
    const schema = z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('list') }),
      z.object({ mode: z.literal('create'), name: z.string() }),
    ]);

    // No discriminator, a bogus one, and a bare union all mean the same thing:
    // the schema cannot say which fields this call takes. Merging the branches
    // would advertise combinations it rejects.
    assert.equal(toolParameterFields(schema, {}), undefined);
    assert.equal(toolParameterFields(schema, { mode: 'destroy' }), undefined);
    assert.equal(
      toolParameterFields(z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]), {}),
      undefined,
    );
  });

  test('reads provider schemas declared as JSON Schema', () => {
    const schema = jsonSchema({
      type: 'object',
      properties: { query: { type: 'string' }, count: { type: 'number' } },
    });

    assert.deepEqual(toolParameterFields(schema), ['query', 'count']);
  });

  test('degrades to no answer on a schema it cannot read', () => {
    assert.equal(toolParameterFields(undefined), undefined);
    assert.equal(toolParameterFields({}), undefined);
    assert.equal(toolParameterFields(z.string()), undefined);
    assert.equal(
      toolParameterFields({
        get shape() {
          throw new Error('exploding getter');
        },
      }),
      undefined,
    );
  });

  test('an empty schema is a different answer from an unreadable one', () => {
    assert.deepEqual(toolParameterFields(z.object({})), []);
  });

  test('Computer Use answers per action, not with every field of every action', () => {
    // Its wire schema is one flat object, because a function-tool JSON schema
    // must have an object at the top. Read as an object it names all 22 keys,
    // so a `click_element` with a camelCase key was told `maka_computer` takes
    // `menu`, `duration` and `region` — the model added one and was refused
    // again. The strict union knows which fields belong to which action.
    const perAction = toolParameterFields(
      computerWireParams,
      { action: 'click_element', elementId: '4' },
      'computer_use',
    );
    assert.deepEqual(perAction, ['observation_id', 'element_id', 'app', 'window_id']);
    for (const foreign of ['menu', 'duration', 'region', 'position', 'size', 'steps']) {
      assert.ok(!perAction?.includes(foreign), `${foreign} is not a click_element field`);
    }

    // An action the union does not know is undefined — say nothing — rather
    // than the whole flat shape.
    assert.equal(
      toolParameterFields(computerWireParams, { action: 'teleport' }, 'computer_use'),
      undefined,
    );
  });
});

describe('tool argument refusal text', () => {
  test('names the tool and the fields the call does take', () => {
    const refusal = readSchema.safeParse({ filePath: '/tmp/a', maxLines: 10 });
    assert.equal(refusal.success, false);

    const said = formatToolArgsViolationText({
      toolName: 'Read',
      parameters: readSchema,
      args: { filePath: '/tmp/a', maxLines: 10 },
      error: refusal.error,
    });

    assert.match(said, /Tool "Read" arguments failed validation/);
    assert.match(said, /Read takes `file_path`, `offset`, `limit`\./);
  });

  test('says nothing about fields when the schema could not answer', () => {
    const said = formatToolArgsViolationText({
      toolName: 'Mystery',
      parameters: undefined,
      error: new Error('input did not match'),
    });

    assert.match(said, /input did not match/);
    assert.doesNotMatch(said, / takes /);
  });

  test('keeps the field list when a long error has to be cut', () => {
    const said = formatToolArgsViolationText({
      toolName: 'Read',
      parameters: readSchema,
      error: new Error('x'.repeat(TOOL_ERROR_RESULT_MAX_CHARS * 2)),
    });

    assert.ok(said.length <= TOOL_ERROR_RESULT_MAX_CHARS);
    assert.match(said, /Read takes `file_path`, `offset`, `limit`\.$/);
  });

  test('names fields and never values', () => {
    const secret = 'hunter2-correct-horse';
    const said = formatToolArgsViolationText({
      toolName: 'Write',
      parameters: z.object({ file_path: z.string(), content: z.string() }),
      args: { file_path: '/tmp/a', content: secret },
      error: new Error('content is required'),
    });

    assert.match(said, /`content`/);
    assert.equal(said.includes(secret), false);
  });
});

test('ToolRuntime enforces the declared schema before impl without a permissionArgs workaround', async () => {
  const messages: StoredMessage[] = [];
  const events: SessionEvent[] = [];
  const runtime = createTestToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    modelId: 'mock-model',
    appendMessage: async (message) => {
      messages.push(message);
    },
    newId: nextId(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
  });
  const tool: MakaTool = {
    name: 'Read',
    description: 'test',
    parameters: readSchema,
    impl: async () => {
      assert.fail('invalid arguments must not reach the implementation');
    },
  };

  const { result } = await runtime.settleToolCall({
    tool,
    turnId: 'turn-1',
    toolCallId: 'tool-invalid',
    input: { filePath: '/workspace/a.ts' },
    abortSignal: new AbortController().signal,
    eventSink: {
      push: (event) => events.push(event),
      pushAndWaitUntilConsumed: async (event) => {
        events.push(event);
      },
    },
  });

  const said = (result as { error?: string }).error ?? '';
  assert.match(said, /Tool "Read" arguments failed validation/);
  assert.match(said, /Read takes `file_path`, `offset`, `limit`\./);
});

test('ToolRuntime validates without rewriting arguments at permission and implementation boundaries', async () => {
  const observed: unknown[] = [];
  const runtime = createTestToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    modelId: 'mock-model',
    appendMessage: async () => {},
    newId: nextId(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
  });
  const parameters = z.object({
    file_path: z.string().transform((value) => value.trim()),
    limit: z.number().default(25),
  });
  const tool: MakaTool = {
    name: 'Read',
    description: 'test',
    parameters,
    permissionArgs: (args) => {
      observed.push(structuredClone(args));
      return args;
    },
    impl: async (args) => {
      observed.push(structuredClone(args));
      return args;
    },
  };

  const { result } = await runtime.settleToolCall({
    tool,
    turnId: 'turn-1',
    toolCallId: 'tool-normalized',
    input: { file_path: '  /workspace/a.ts  ' },
    abortSignal: new AbortController().signal,
    eventSink: {
      push: () => {},
      pushAndWaitUntilConsumed: async () => {},
    },
  });

  const expected = { file_path: '  /workspace/a.ts  ' };
  assert.deepEqual(observed, [expected, expected]);
  assert.deepEqual(result, expected);
});

test('a sandbox denial names the tool that widens the boundary', async () => {
  const messages: StoredMessage[] = [];
  const events: SessionEvent[] = [];
  const runtime = createTestToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    modelId: 'mock-model',
    appendMessage: async (message) => {
      messages.push(message);
    },
    newId: nextId(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
  });
  const tool: MakaTool = {
    name: 'Bash',
    description: 'test',
    parameters: z.object({ command: z.string() }),
    impl: async () => {
      throw Object.assign(new Error('denied'), {
        code: 1,
        stdout: '',
        stderr: 'operation not permitted',
        reason: 'sandbox_denial',
        sandboxed: true,
        sandboxType: 'macos-seatbelt',
      });
    },
  };

  const { result } = await runtime.settleToolCall({
    tool,
    turnId: 'turn-1',
    toolCallId: 'tool-denied',
    input: { command: 'cat /etc/hosts' },
    abortSignal: new AbortController().signal,
    eventSink: {
      push: (event) => events.push(event),
      pushAndWaitUntilConsumed: async (event) => {
        events.push(event);
      },
    },
  });

  // Naming the marker without the tool that acts on it is a dead end: the model
  // is told a boundary can be widened and not by what.
  assert.match((result as { error?: string }).error ?? '', /request_sandbox_boundary/);
});

describe('unrepairable tool calls', () => {
  test('an unknown tool name is answered with the names that exist', () => {
    const repaired = repairMakaToolCall({
      toolCall: { toolCallId: 'tool-1', toolName: 'ReadFile', input: '{"path":"/tmp/a"}' },
      availableToolNames: ['Bash', 'Read', 'Write'],
      error: new Error('No such tool: ReadFile'),
    });

    const input = JSON.parse(repaired?.input ?? '{}') as { error?: string };
    assert.match(input.error ?? '', /Available tools: Bash, Read, Write\./);
  });

  test('a known tool called with the wrong shape is told its fields', () => {
    const repaired = repairMakaToolCall({
      toolCall: { toolCallId: 'tool-1', toolName: 'Read', input: '{"filePath":"/tmp/a"}' },
      availableToolNames: ['Bash', 'Read'],
      toolParameters: (name) => (name === 'Read' ? readSchema : undefined),
      error: new Error('Invalid arguments for tool Read'),
    });

    const input = JSON.parse(repaired?.input ?? '{}') as { error?: string };
    assert.match(input.error ?? '', /Read takes `file_path`, `offset`, `limit`\./);
    // The tool exists; listing every other tool would answer a question the
    // model did not ask.
    assert.doesNotMatch(input.error ?? '', /Available tools/);
  });

  test('still redacts secret-shaped text in what it relays', () => {
    const repaired = repairMakaToolCall({
      toolCall: { toolCallId: 'tool-1', toolName: 'Nope', input: '{}' },
      availableToolNames: ['Bash'],
      error: new Error('No such tool: Authorization: Bearer sk-live-secret-token-value'),
    });

    const input = JSON.parse(repaired?.input ?? '{}') as { error?: string };
    assert.equal((input.error ?? '').includes('sk-live-secret-token-value'), false);
  });
});

function nextId(): () => string {
  let sequence = 0;
  return () => `id-${++sequence}`;
}

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace',
    cwd: '/workspace',
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
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'mock-model',
    permissionMode: 'bypass',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'test',
    name: 'Test',
    providerType: 'openai-compatible',
    baseUrl: 'https://example.invalid',
    defaultModel: 'mock-model',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
