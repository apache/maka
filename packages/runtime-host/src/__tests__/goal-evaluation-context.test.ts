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
import { test } from 'node:test';
import type { ToolResultContent } from '@maka/core/events';
import type { StoredMessage, ToolCallMessage, ToolResultMessage } from '@maka/core/session';
import { buildGoalEvaluationContext } from '../server/goal-evaluation-context.js';
import type { GoalFormAnswer } from '../server/goal-form-evidence.js';

function call(id: string, turnId = 'turn'): ToolCallMessage {
  return {
    type: 'tool_call',
    id,
    turnId,
    ts: 1,
    toolName: 'Bash',
    args: { command: `run ${id}` },
  };
}

function result(toolUseId: string, content: ToolResultContent, turnId = 'turn'): ToolResultMessage {
  return {
    type: 'tool_result',
    id: `${turnId}-${toolUseId}-result`,
    turnId,
    ts: 2,
    toolUseId,
    isError: false,
    outcome: 'success',
    content,
  };
}

function toolRows(context: string): string[] {
  return context.split('\n').filter((row) => row.startsWith('[tool]:'));
}

function formAnswer(index: number): GoalFormAnswer {
  return {
    turnId: 'turn',
    toolUseId: `form-${index}`,
    requestId: `request-${index}`,
    action: 'accept',
    message: `Question ${index}`,
    fields: [{ name: 'target', label: 'Deployment target' }],
    values: { target: `choice-${index}` },
  };
}

test('tool-heavy turns retain six nonempty prose rows and the six latest tool activities', () => {
  const messages: StoredMessage[] = [];
  for (let index = 0; index < 8; index++) {
    messages.push({
      type: 'user',
      id: `user-${index}`,
      turnId: 'turn',
      ts: index,
      text: `Constraint ${index}`,
    });
    messages.push(call(`call-${index}`));
    messages.push(result(`call-${index}`, { kind: 'text', text: `Output ${index}` }));
    messages.push({
      type: 'assistant',
      id: `thinking-${index}`,
      turnId: 'turn',
      ts: index,
      text: '  ',
      thinking: { text: 'Private reasoning' },
      modelId: 'fake-model',
    });
  }
  // An earlier parallel call settles last: its new evidence is recent even
  // though the call itself preceded the other seven activities.
  messages.push(result('call-0', { kind: 'text', text: 'Late output 0' }));
  const context = buildGoalEvaluationContext(messages);
  assert.deepEqual(
    context.split('\n').filter((row) => row.startsWith('[user]:')),
    Array.from({ length: 6 }, (_, index) => `[user]: Constraint ${index + 2}`),
  );
  assert.equal(toolRows(context).length, 6);
  assert.match(context, /\[tools omitted\]: 2/);
  assert.doesNotMatch(context, /"callId":"call-[12]"/);
  assert.match(toolRows(context).at(-1)!, /Late output 0/);
  assert.doesNotMatch(context, /Private reasoning|\[assistant\]:/);
});

test('parallel results pair by call ID and Turn rather than name, position or arrival order', () => {
  const context = buildGoalEvaluationContext([
    call('reused', 'first-turn'),
    call('parallel', 'first-turn'),
    result('parallel', { kind: 'text', text: 'Parallel output' }, 'first-turn'),
    result('reused', { kind: 'text', text: 'First Turn output' }, 'first-turn'),
    call('reused', 'second-turn'),
    result('reused', { kind: 'text', text: 'Second Turn output' }, 'second-turn'),
  ]);
  const rows = toolRows(context);
  assert.equal(rows.length, 3);
  assert.match(rows[0]!, /"callId":"parallel"/);
  assert.match(rows[0]!, /Parallel output/);
  assert.match(rows[1]!, /"turnId":"first-turn"/);
  assert.match(rows[1]!, /"callId":"reused"/);
  assert.match(rows[1]!, /First Turn output/);
  assert.doesNotMatch(rows[1]!, /Second Turn output/);
  assert.match(rows[2]!, /"turnId":"second-turn"/);
  assert.match(rows[2]!, /Second Turn output/);
});

test('missing calls and results are explicit, while hidden nested Code Mode evidence is usable', () => {
  const nestedCall: ToolCallMessage = {
    ...call('nested'),
    origin: 'code_mode',
    modelVisibility: 'hidden',
    parentToolCallId: 'code-mode-parent',
  };
  const nestedResult: ToolResultMessage = {
    ...result('nested', { kind: 'text', text: 'Nested command failed' }),
    origin: 'code_mode',
    modelVisibility: 'hidden',
    isError: true,
    outcome: 'error',
    parentToolCallId: 'code-mode-parent',
  };
  const rows = toolRows(
    buildGoalEvaluationContext([
      call('unsettled'),
      result('orphan', { kind: 'text', text: 'Orphan result' }),
      nestedCall,
      nestedResult,
    ]),
  );
  assert.match(rows[0]!, /result_missing/);
  assert.match(rows[0]!, /\[unavailable\]/);
  assert.match(rows[1]!, /call_unavailable/);
  assert.match(rows[1]!, /Orphan result/);
  assert.match(rows[2]!, /Nested command failed/);
  assert.match(rows[2]!, /"outcome":"error"/);
  assert.match(rows[2]!, /"isError":true/);
});

test('shell evidence preserves terminal status and exit code even without an output snapshot', () => {
  const rows = toolRows(
    buildGoalEvaluationContext([
      call('terminal'),
      result('terminal', {
        kind: 'terminal',
        cwd: '/work',
        cmd: 'npm test',
        status: 'failed',
        exitCode: 1,
        output: {
          mode: 'pipes',
          stdout: 'Tests started',
          stderr: 'FAIL: assertion failed',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
      }),
      call('background'),
      result('background', {
        kind: 'shell_run',
        ref: 'shell-resource',
        mode: 'pipes',
        cwd: '/work',
        cmd: 'npm test',
        status: 'failed',
        exitCode: 2,
        startedAt: 1,
        updatedAt: 2,
        revision: 1,
      }),
    ]),
  );
  assert.match(rows[0]!, /"status":"failed"/);
  assert.match(rows[0]!, /"exitCode":1/);
  assert.match(rows[0]!, /FAIL: assertion failed/);
  assert.match(rows[1]!, /"status":"failed"/);
  assert.match(rows[1]!, /"exitCode":2/);
  assert.match(rows[1]!, /"output":"\[unavailable\]"/);
});

test('archived, image and summary results do not reopen original or binary evidence', () => {
  const context = buildGoalEvaluationContext([
    call('archive'),
    result('archive', {
      kind: 'archived_tool_result',
      status: 'not_loaded',
      runtimeEventId: 'private-runtime-event',
      toolCallId: 'archive',
      toolName: 'Bash',
      artifactId: 'private-artifact',
      resourceRef: 'private-resource',
      originalEstimatedTokens: 10,
      originalBytes: 100,
      rewriteVersion: 1,
      reason: 'tool_result_pruned',
    }),
    call('image'),
    result('image', {
      kind: 'image',
      mimeType: 'image/png',
      ref: { kind: 'external_file', absolutePath: '/private/raw-image.png' },
    }),
    call('summary'),
    result('summary', {
      kind: 'summary',
      original: 'Original private unbounded output',
      summarized: 'A safe summary',
      reason: 'too_large',
    }),
  ]);
  assert.match(context, /not_loaded/);
  assert.match(context, /\[unavailable\]/);
  assert.match(context, /\[omitted\]/);
  assert.match(context, /A safe summary/);
  assert.doesNotMatch(context, /private-runtime-event|private-artifact|private-resource/);
  assert.doesNotMatch(context, /raw-image\.png|Original private unbounded output/);
});

test('secrets and opaque metadata are excluded while ordinary nested MCP JSON stays useful', () => {
  const tool = {
    ...call('private'),
    args: { command: 'API_TOKEN=sk-command-secret001 npm test' },
    providerOptions: { privateData: 'Call provider metadata' },
  };
  const output = {
    ...result('private', {
      kind: 'json',
      value: {
        credentials: 'Plain credential value',
        nested: { api_key: 'Plain API key', note: 'token=sk-nested-secret001' },
        'sk-label-secret001': 'Ordinary value under a secret-looking label',
        data: { value: 'Business record' },
        content: [
          { type: 'image', data: 'Raw image bytes' },
          { type: 'audio', data: 'Raw audio bytes' },
          { type: 'text', text: 'Readable MCP text' },
        ],
        providerOutput: 'Nested provider replay',
        providerOptions: { privateData: 'Nested provider metadata' },
        signature: 'Signed private payload',
      },
    }),
    providerOutput: 'Outer provider replay',
  };
  const context = buildGoalEvaluationContext([
    {
      type: 'assistant',
      id: 'assistant',
      turnId: 'turn',
      ts: 0,
      text: 'Readable report API_TOKEN=sk-prose-secret001',
      modelId: 'fake-model',
      thinking: {
        text: 'Private reasoning',
        signature: 'Private thinking signature',
        providerOptions: { privateData: 'Private thinking metadata' },
      },
    },
    tool,
    output,
  ]);
  assert.match(context, /\[redacted\]/);
  assert.match(context, /Business record/);
  assert.match(context, /Readable MCP text/);
  assert.doesNotMatch(context, /sk-(?:command|nested|label|prose)-secret001/);
  assert.doesNotMatch(context, /Plain credential value|Plain API key/);
  assert.doesNotMatch(context, /Raw image bytes|Raw audio bytes/);
  assert.doesNotMatch(context, /provider metadata|provider replay|Signed private payload/);
  assert.doesNotMatch(context, /Private reasoning|Private thinking/);
});

test('malformed JSON remains unavailable without invoking serialization hooks or echoing errors', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let serializationHookCalled = false;
  const hostile = {
    toJSON() {
      serializationHookCalled = true;
      return 'Raw serialization fallback';
    },
    get unsafe() {
      throw new Error('Secret getter failure detail');
    },
  };
  let context = '';
  assert.doesNotThrow(() => {
    context = buildGoalEvaluationContext([
      call('cyclic'),
      result('cyclic', { kind: 'json', value: cyclic }),
      call('hostile'),
      result('hostile', { kind: 'json', value: hostile }),
      call('bigint'),
      result('bigint', { kind: 'json', value: 1n }),
    ]);
  });
  assert.equal(serializationHookCalled, false);
  assert.equal(toolRows(context).length, 3);
  for (const row of toolRows(context)) assert.match(row, /\[unavailable\]/);
  assert.doesNotMatch(context, /Raw serialization fallback|Secret getter failure detail/);
});

test('the selected option label gives meaning to an otherwise opaque form answer', () => {
  const messages = [call('form')];
  const answer: GoalFormAnswer = {
    ...formAnswer(0),
    message: 'Should the deployment proceed?',
    fields: [{ name: 'decision', label: 'Deployment decision' }],
    values: { decision: 'opaque-choice-1' },
  };
  const allowed = buildGoalEvaluationContext(messages, [
    {
      ...answer,
      selectedOptions: { decision: [{ value: 'opaque-choice-1', label: 'Allow deployment' }] },
    },
  ]);
  const rejected = buildGoalEvaluationContext(messages, [
    {
      ...answer,
      selectedOptions: { decision: [{ value: 'opaque-choice-1', label: 'Reject deployment' }] },
    },
  ]);
  assert.notEqual(
    allowed,
    rejected,
    'the same opaque value must not erase its human-facing meaning',
  );
  assert.match(allowed, /Allow deployment/);
  assert.doesNotMatch(allowed, /Reject deployment/);
  assert.match(rejected, /Reject deployment/);
  assert.doesNotMatch(rejected, /Allow deployment/);
});

test('decorated credential labels redact values and their duplicate selected-option payloads', () => {
  const context = buildGoalEvaluationContext(
    [call('form')],
    [
      {
        ...formAnswer(0),
        fields: [
          { name: 'value', label: 'Password (required)' },
          { name: 'api_key', label: 'Account key' },
        ],
        values: { value: 'short-private-password', api_key: 'short-private-key' },
        selectedOptions: {
          value: [{ value: 'short-private-password', label: 'Saved password' }],
          api_key: [{ value: 'short-private-key', label: 'Saved key' }],
        },
      },
    ],
  );
  assert.match(context, /Password \(required\)/);
  assert.match(context, /\[redacted\]/);
  assert.doesNotMatch(context, /short-private-password|short-private-key/);
  assert.doesNotMatch(context, /Saved password|Saved key/);
});

test('AskUserQuestion credential answers are redacted while an ordinary chosen answer stays visible', () => {
  const context = buildGoalEvaluationContext([
    {
      ...call('question'),
      toolName: 'AskUserQuestion',
      args: {
        questions: [
          { question: 'Password (required)', options: [{ label: 'Enter a password' }] },
          { question: 'Publish?', options: [{ label: 'Yes' }, { label: 'No' }] },
        ],
      },
    },
    result('question', {
      kind: 'json',
      value: {
        answers: [
          { question: 'Password (required)', answer: 'plain-user-password' },
          { question: 'Publish?', answer: 'No' },
        ],
      },
    }),
  ]);
  assert.doesNotMatch(context, /plain-user-password/);
  assert.match(context, /"question":"Password \(required\)","answer":"\[redacted\]"/);
  assert.match(context, /"question":"Publish\?","answer":"No"/);
});

test('a stale form answer outside both recent prose and tool Turns is not reused as current evidence', () => {
  const messages: StoredMessage[] = [
    {
      type: 'user',
      id: 'old-user',
      turnId: 'old-turn',
      ts: 0,
      text: 'An older task',
    },
    call('old-form', 'old-turn'),
    result('old-form', { kind: 'text', text: 'Old tool finished' }, 'old-turn'),
  ];
  for (let index = 0; index < 6; index++) {
    messages.push({
      type: 'user',
      id: `new-user-${index}`,
      turnId: 'current-turn',
      ts: index + 1,
      text: `Current task constraint ${index}`,
    });
    messages.push(call(`new-call-${index}`, 'current-turn'));
    messages.push(
      result(`new-call-${index}`, { kind: 'text', text: 'Current output' }, 'current-turn'),
    );
  }
  const context = buildGoalEvaluationContext(messages, [
    { ...formAnswer(0), turnId: 'current-turn', values: { target: 'current-staging' } },
    {
      ...formAnswer(1),
      turnId: 'old-turn',
      requestId: 'old-form-request',
      values: { target: 'stale-production-approval' },
    },
  ]);
  assert.match(context, /current-staging/);
  assert.doesNotMatch(context, /stale-production-approval|old-form-request/);
  assert.equal(context.split('\n').filter((row) => row.startsWith('[form answer]:')).length, 1);
});

test('separate form quota and massive Unicode payloads stay inside the complete context budget', () => {
  const payload = `Opening ${'🧪漢'.repeat(20_000)} Ending token=sk-tail-secret001`;
  const messages: StoredMessage[] = [];
  for (let index = 0; index < 6; index++) {
    messages.push({
      type: 'user',
      id: `user-${index}`,
      turnId: 'turn',
      ts: index,
      text: payload,
    });
    messages.push({ ...call(`call-${index}`), args: { command: payload } });
    messages.push(result(`call-${index}`, { kind: 'text', text: payload }));
  }
  const forms = Array.from({ length: 4 }, (_, index) => ({
    ...formAnswer(index),
    message: payload,
    values: { target: `choice-${index}`, detail: payload, password: 'Plain form password' },
  }));
  const context = buildGoalEvaluationContext(messages, forms);
  assert.equal(toolRows(context).length, 6);
  assert.equal(context.split('\n').filter((row) => row.startsWith('[form answer]:')).length, 3);
  assert.match(context, /\[forms omitted\]: 1/);
  assert.doesNotMatch(context, /choice-0/);
  for (const index of [1, 2, 3]) assert.match(context, new RegExp(`choice-${index}`));
  assert.ok(context.length < 16_000, `context contained ${context.length} code units`);
  assert.ok(Buffer.byteLength(context, 'utf8') < 48_000, 'UTF-8 bytes are bounded too');
  assert.match(context, /\[truncated\]/);
  assert.doesNotMatch(context, /sk-tail-secret001|Plain form password/);
  assert.doesNotMatch(
    context,
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    'excerpt boundaries must not split a paired surrogate',
  );
});
