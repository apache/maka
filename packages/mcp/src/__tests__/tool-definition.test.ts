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
import type { Tool } from '@modelcontextprotocol/client';
import { fingerprintMcpToolDefinition } from '../tool-definition.js';

describe('MCP Tool definition fingerprint', () => {
  test('rejects oversized and excessively deep definitions', () => {
    assert.throws(
      () =>
        fingerprintMcpToolDefinition({
          name: 'large',
          description: 'x'.repeat(1_048_577),
          inputSchema: { type: 'object' },
        }),
      /tool definition exceeds/u,
    );

    let schema: Record<string, unknown> = { type: 'string' };
    for (let depth = 0; depth < 101; depth += 1) {
      schema = { type: 'object', properties: { child: schema } };
    }
    assert.throws(
      () =>
        fingerprintMcpToolDefinition({
          name: 'deep',
          inputSchema: schema as Tool['inputSchema'],
        }),
      /definition exceeds depth/u,
    );
  });
});
