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
import { decodeClientCapabilitySessionGrant } from '../client-capability-grant.js';

test('MCP grants preserve exact Session/provider/contract/tool authority without changing Desktop grants', () => {
  for (const capability of ['mcp', 'desktop_mcp']) {
    const record = {
      version: 1,
      sessionId: 'session',
      providerId: 'provider',
      contractId: 'contract',
      serverId: 'server',
      toolName: 'tool',
      capability,
      scope: { kind: 'mcp_tool', serverId: 'server', toolName: 'tool' },
      grantedAt: 1,
    };
    assert.deepEqual(decodeClientCapabilitySessionGrant(record), record);
    assert.throws(
      () => decodeClientCapabilitySessionGrant({ ...record, scope: { kind: 'capability' } }),
      /scope does not match/,
    );
    assert.throws(
      () =>
        decodeClientCapabilitySessionGrant({
          ...record,
          scope: { kind: 'browser_origin', origin: 'https://example.com' },
        }),
      /scope does not match/,
    );
  }
});
