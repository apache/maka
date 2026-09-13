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
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { McpToolCallError, normalizeToolCallError } from '../tool-call-error.js';

test('normalizes the SDK unsupported-result error to the stable Maka boundary', () => {
  const causes = [
    new SdkError(
      SdkErrorCode.UnsupportedResultType,
      "Unsupported result type 'input_required' for tools/call",
    ),
    ...["'task'", "'inputRequests'", "'requestState'"].map(
      (marker) =>
        new SdkError(
          SdkErrorCode.InvalidResult,
          `Invalid result for tools/call: content is required when the body carries ${marker} — another result family cannot default into an empty tools/call success`,
        ),
    ),
  ];

  for (const cause of causes) {
    const error = normalizeToolCallError('fixture', 'deferred', cause);

    assert.ok(error instanceof McpToolCallError);
    assert.equal(error.serverId, 'fixture');
    assert.equal(error.toolName, 'deferred');
    assert.match(error.message, /unsupported deferred tool result/u);
    assert.equal(error.cause, cause);
  }
});

test('preserves the invalid-result classification for unrelated schema failures', () => {
  const error = normalizeToolCallError(
    'fixture',
    'invalid',
    new SdkError(SdkErrorCode.InvalidResult, 'Invalid result for tools/call: not an object'),
  );

  assert.ok(error instanceof McpToolCallError);
  assert.match(error.message, /invalid tool result/u);
  assert.doesNotMatch(error.message, /unsupported deferred/u);
});

test('wraps generic SDK and transport failures without exposing their message', () => {
  const cause = new SyntaxError('sk-live-secret-token-value\r\nforged\u2028message');
  const error = normalizeToolCallError('fixture', 'parse', cause);

  assert.ok(error instanceof McpToolCallError);
  assert.notEqual(error, cause);
  assert.equal(error.cause, cause);
  assert.match(error.message, /tool call failed/u);
  assert.doesNotMatch(error.message, /sk-live|forged/u);
  assert.doesNotMatch(error.message, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
});

test('keeps raw identity fields while rendering a bounded log-safe message', () => {
  const serverId = 'server\u2028token=sk-live-server-secret';
  const toolName = `tool\r\n${'x'.repeat(100)}`;
  const error = new McpToolCallError(
    serverId,
    toolName,
    `failed with password=tool-secret ${'detail'.repeat(500)}`,
  );

  assert.equal(error.serverId, serverId);
  assert.equal(error.toolName, toolName);
  assert.doesNotMatch(error.message, /[\r\n\u2028\u2029]/u);
  assert.doesNotMatch(error.message, /sk-live|tool-secret/u);
  assert.ok(error.message.length < 2_250);
});
