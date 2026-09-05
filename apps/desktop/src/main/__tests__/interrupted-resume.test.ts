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
import { describe, it } from 'node:test';
import { materializeTurns } from '@maka/ui';
import { latestInterruptedResumeTurnId } from '../../renderer/interrupted-resume.js';

describe('latest interrupted resume candidate', () => {
  it('recognizes a timeout after a completed tool result', () => {
    assert.equal(
      latestInterruptedResumeTurnId([
        {
          turnId: 'turn-1',
          status: 'failed',
          errorClass: 'timeout',
          tools: [{ status: 'completed' }],
        },
      ]),
      'turn-1',
    );
  });

  it('does not offer continuation for an incomplete or errored tool', () => {
    assert.equal(
      latestInterruptedResumeTurnId([
        {
          turnId: 'turn-1',
          status: 'failed',
          errorClass: 'timeout',
          tools: [{ status: 'running' }],
        },
      ]),
      undefined,
    );
    assert.equal(
      latestInterruptedResumeTurnId([
        {
          turnId: 'turn-1',
          status: 'failed',
          errorClass: 'timeout',
          tools: [{ status: 'completed' }, { status: 'interrupted' }],
        },
      ]),
      undefined,
    );
    assert.equal(
      latestInterruptedResumeTurnId([
        {
          turnId: 'turn-1',
          status: 'failed',
          errorClass: 'timeout',
          tools: [{ status: 'errored' }],
        },
      ]),
      undefined,
    );
  });

  it('rejects the mixed shape produced by materializeTurns', () => {
    const [turn] = materializeTurns([
      { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'inspect' },
      {
        type: 'turn_state',
        id: 'state-1',
        turnId: 'turn-1',
        ts: 2,
        status: 'failed',
        errorClass: 'timeout',
        partialOutputRetained: false,
      },
      { type: 'tool_call', id: 'call-1', turnId: 'turn-1', ts: 3, toolName: 'Read', args: {} },
      {
        type: 'tool_result',
        id: 'result-1',
        turnId: 'turn-1',
        ts: 4,
        toolUseId: 'call-1',
        isError: false,
        content: { kind: 'text', text: 'ok' },
      },
      { type: 'tool_call', id: 'call-2', turnId: 'turn-1', ts: 5, toolName: 'Read', args: {} },
    ], 'en');

    assert.deepEqual(turn?.tools.map((tool) => tool.status), ['completed', 'interrupted']);
    assert.equal(latestInterruptedResumeTurnId(turn ? [turn] : []), undefined);
  });
});
