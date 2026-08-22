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
import {
  createMcpToolBinding,
  parseMcpToolBinding,
  type McpToolBindingIdentity,
} from '../tool-binding.js';

const identity: McpToolBindingIdentity = {
  managerId: 'abcdefghijklmnopqrstuv',
  connectionGeneration: 1,
  serverId: 'fixture',
  toolName: 'echo',
  definitionFingerprint: 'a'.repeat(43),
};

describe('MCP Tool binding', () => {
  test('round-trips only the canonical bounded encoding', () => {
    const binding = createMcpToolBinding(identity);
    assert.deepEqual(parseMcpToolBinding(binding), {
      managerId: identity.managerId,
      connectionGeneration: identity.connectionGeneration,
    });
    assert.ok(binding.length <= 96);

    assert.equal(parseMcpToolBinding(binding.replace('.1.', '.01.')), undefined);
  });

  test('rejects malformed, oversized, and invalid generation identities', () => {
    assert.equal(parseMcpToolBinding('not-a-binding'), undefined);
    assert.equal(parseMcpToolBinding(`mcpb1.${'a'.repeat(97)}`), undefined);
    assert.throws(
      () => createMcpToolBinding({ ...identity, connectionGeneration: 0 }),
      /Invalid MCP tool binding identity/u,
    );
  });

  test('keeps the opaque binding bounded without restricting server or Tool names', () => {
    const short = createMcpToolBinding(identity);
    const long = createMcpToolBinding({ ...identity, toolName: 'x'.repeat(10_000) });
    const emptyTool = createMcpToolBinding({ ...identity, toolName: '' });
    const emptyServer = createMcpToolBinding({ ...identity, serverId: '' });

    assert.notEqual(long, short);
    assert.notEqual(emptyTool, short);
    assert.notEqual(emptyServer, short);
    assert.equal(long.length, short.length);
    assert.equal(emptyTool.length, short.length);
    assert.equal(emptyServer.length, short.length);
    assert.deepEqual(parseMcpToolBinding(long), {
      managerId: identity.managerId,
      connectionGeneration: identity.connectionGeneration,
    });
  });

  test('changes when any consistency identity input changes', () => {
    const binding = createMcpToolBinding(identity);
    assert.notEqual(createMcpToolBinding({ ...identity, connectionGeneration: 2 }), binding);
    assert.notEqual(createMcpToolBinding({ ...identity, serverId: 'other' }), binding);
    assert.notEqual(createMcpToolBinding({ ...identity, toolName: 'other' }), binding);
    assert.notEqual(
      createMcpToolBinding({ ...identity, definitionFingerprint: 'b'.repeat(43) }),
      binding,
    );
  });
});
