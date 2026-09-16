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
import { mcpConfigChangeRetiresCredentials, type McpServerConfig } from '../mcp.js';

describe('MCP credential retirement', () => {
  const stdio: McpServerConfig = { command: 'server' };
  const remote: McpServerConfig = { url: 'https://one.example/mcp' };

  it('retires credentials when an id is removed, repointed, or changes transport', () => {
    assert.equal(mcpConfigChangeRetiresCredentials(remote, undefined), true);
    assert.equal(
      mcpConfigChangeRetiresCredentials(remote, { url: 'https://two.example/mcp' }),
      true,
    );
    assert.equal(mcpConfigChangeRetiresCredentials(remote, stdio), true);
    // A stale credential record can exist under a currently-stdio id after
    // an offline edit. Do not let it become the new remote endpoint's token.
    assert.equal(mcpConfigChangeRetiresCredentials(stdio, remote), true);
  });

  it('keeps credentials when endpoint ownership does not change', () => {
    assert.equal(
      mcpConfigChangeRetiresCredentials(remote, {
        ...remote,
        headers: { Authorization: 'Bearer replacement' },
        enabled: false,
      }),
      false,
    );
    assert.equal(mcpConfigChangeRetiresCredentials(stdio, { command: 'different-server' }), false);
  });
});
