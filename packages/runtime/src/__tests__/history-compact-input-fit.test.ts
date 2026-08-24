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
import { stableJsonLength } from '../context-budget-helpers.js';
import { HistoryCompactSummarizerError } from '../history-compact-error.js';
import { fitHistoryCompactMessages } from '../history-compact-input-fit.js';
import type { ModelMessage } from '../model-protocol.js';

describe('history compaction input fitting', () => {
  test('bounds oversized tool evidence without breaking the call/result pair', () => {
    const oversizedOutput = 'raw-tool-output-'.repeat(1_024);
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'shell',
            input: { command: 'inspect' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'shell',
            output: { type: 'text', value: oversizedOutput },
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'The inspection completed.' }] },
    ];

    const bounded = fitHistoryCompactMessages(messages, {
      maxInputEstimatedTokens: 600,
      charsPerToken: 1,
    });

    assert.ok(stableJsonLength(bounded) <= 600);
    assert.equal(JSON.stringify(bounded).includes(oversizedOutput), false);
    assert.deepEqual(
      bounded.flatMap((message) =>
        typeof message.content === 'string'
          ? []
          : message.content
              .filter((part) => part.type === 'tool-call' || part.type === 'tool-result')
              .map((part) => ({ type: part.type, toolCallId: part.toolCallId })),
      ),
      [
        { type: 'tool-call', toolCallId: 'call-1' },
        { type: 'tool-result', toolCallId: 'call-1' },
      ],
    );
  });

  test('fails before dispatch when non-tool history cannot fit', () => {
    assert.throws(
      () =>
        fitHistoryCompactMessages(
          [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(1_000) }] }],
          { maxInputEstimatedTokens: 10, charsPerToken: 1 },
        ),
      (error) =>
        error instanceof HistoryCompactSummarizerError && error.reason === 'input_too_large',
    );
  });

  test('keeps the projection unchanged without a budget or when it already fits', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'bounded history' }] },
    ];

    assert.deepEqual(fitHistoryCompactMessages(messages, {}), messages);
    assert.deepEqual(
      fitHistoryCompactMessages(messages, {
        maxInputEstimatedTokens: 1_000,
        charsPerToken: 1,
      }),
      messages,
    );
  });
});
