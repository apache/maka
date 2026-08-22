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
import { decodeToolResultPreviewContent } from '../tool-result-preview.js';

describe('tool_result_preview open-facts', () => {
  it('rejects missing childSessionId, bulk fields, and non-running status', () => {
    assert.throws(() =>
      decodeToolResultPreviewContent({
        kind: 'subagent',
        agentName: 'X',
        turnId: 't',
        status: 'running',
        permissionMode: 'ask',
      }),
    );
    assert.throws(() =>
      decodeToolResultPreviewContent({
        kind: 'subagent',
        childSessionId: 'child-1',
        agentName: 'X',
        turnId: 't',
        status: 'running',
        permissionMode: 'ask',
        summary: 'nope',
      }),
    );
    assert.throws(() =>
      decodeToolResultPreviewContent({
        kind: 'subagent',
        childSessionId: 'child-1',
        agentName: 'X',
        turnId: 't',
        status: 'waiting_for_user',
        permissionMode: 'ask',
      }),
    );
    assert.throws(() =>
      decodeToolResultPreviewContent({ kind: 'agent_swarm', status: 'running', items: [] }),
    );
  });
});
