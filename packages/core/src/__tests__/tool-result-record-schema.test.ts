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
import type { StoredMessage } from '../session.js';
import { decodeStoredMessage } from '../session.js';
import { decodeCanonicalToolResultContent } from '../tool-result-record-schema.js';

describe('sandbox denial tool result metadata', () => {
  test('accepts a canonical text result carrying a sandbox denial signal', () => {
    const result = {
      kind: 'text',
      text: 'Filesystem access was denied.',
      sandboxDenial: {
        likely: true,
        backend: 'macos-seatbelt',
      },
    } as const;

    assert.deepEqual(decodeCanonicalToolResultContent(result), result);
    assert.deepEqual(toolResultContent(decodeStoredMessage(storedToolResult(result))), result);
  });

  test('rejects malformed or widened sandbox denial signals', () => {
    for (const sandboxDenial of [
      { likely: false },
      { likely: true, backend: 'none' },
      { likely: true, backend: 'macos-seatbelt', recovery: 'require_escalated' },
      { likely: true, unexpected: true },
    ]) {
      assert.throws(
        () =>
          decodeCanonicalToolResultContent({
            kind: 'text',
            text: 'denied',
            sandboxDenial,
          }),
        /Invalid tool result content/,
      );
    }
  });
});

describe('sandbox boundary failure tool result metadata', () => {
  test('preserves the machine-readable reason and exact required expansion', () => {
    const result = {
      kind: 'text',
      text: 'Bash requires an approved session sandbox boundary expansion.',
      sandboxFailure: {
        reason: 'sandbox_boundary_required',
        requiredExpansion: { network: { enabled: true } },
      },
    } as const;

    assert.deepEqual(decodeCanonicalToolResultContent(result), result);
    assert.deepEqual(toolResultContent(decodeStoredMessage(storedToolResult(result))), result);
  });

  test('rejects malformed or widened boundary failure signals', () => {
    for (const sandboxFailure of [
      { reason: 'sandbox_denial' },
      { reason: 'requires_bypass', unexpected: true },
      { reason: 'sandbox_boundary_required', requiredExpansion: {} },
    ]) {
      assert.throws(
        () =>
          decodeCanonicalToolResultContent({
            kind: 'text',
            text: 'denied',
            sandboxFailure,
          }),
        /Invalid tool result content/,
      );
    }
  });
});

describe('uncertain tool outcome metadata', () => {
  test('preserves a non-retryable outcome_unknown signal', () => {
    const result = {
      kind: 'text',
      text: 'outcome_unknown: the provider accepted the action but did not return a result.',
      uncertainOutcome: {
        code: 'outcome_unknown',
        retrySafe: false,
      },
    } as const;

    assert.deepEqual(decodeCanonicalToolResultContent(result), result);
    assert.deepEqual(toolResultContent(decodeStoredMessage(storedToolResult(result))), result);
  });

  test('rejects widened or retryable uncertain outcome signals', () => {
    for (const uncertainOutcome of [
      { code: 'outcome_unknown', retrySafe: true },
      { code: 'provider_failed', retrySafe: false },
      { code: 'outcome_unknown', retrySafe: false, unexpected: true },
    ]) {
      assert.throws(
        () =>
          decodeCanonicalToolResultContent({
            kind: 'text',
            text: 'uncertain',
            uncertainOutcome,
          }),
        /Invalid tool result content/,
      );
    }
  });
});

function storedToolResult(content: unknown) {
  return {
    type: 'tool_result',
    id: 'result-1',
    turnId: 'turn-1',
    ts: 1,
    toolUseId: 'call-1',
    isError: false,
    content,
  };
}

function toolResultContent(message: StoredMessage) {
  if (message.type !== 'tool_result') throw new Error('Expected tool result');
  return message.content;
}
