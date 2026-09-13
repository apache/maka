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

describe('tool_result_preview permission modes', () => {
  const preview = {
    kind: 'subagent',
    childSessionId: 'child-1',
    agentName: 'Explore',
    turnId: 't',
    status: 'running',
    permissionMode: 'ask',
  } as const;

  it('rejects a retired mode on the live wire', () => {
    // Live open facts, not a stored record: the compatibility epoch already
    // refuses a peer old enough to send a retired mode, so accepting one here
    // would only hide a handshake that should never have succeeded.
    assert.throws(() => decodeToolResultPreviewContent({ ...preview, permissionMode: 'execute' }));
  });

  it('accepts every live mode', () => {
    for (const permissionMode of ['explore', 'ask', 'bypass'] as const) {
      assert.deepEqual(decodeToolResultPreviewContent({ ...preview, permissionMode }), {
        ...preview,
        permissionMode,
      });
    }
  });
});
