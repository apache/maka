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
import { McpToolCallPreparer } from '../tool-output-validation.js';

describe('MCP Tool output validation preparation', () => {
  test('strips only the SDK outputSchema view and validates from the owned definition', () => {
    const preparer = new McpToolCallPreparer();
    const definition: Tool = {
      name: 'echo',
      inputSchema: {
        type: 'object',
        properties: {
          value: {
            type: 'string',
            'x-vendor-extension': 'opaque',
          },
        },
      },
      outputSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
    };

    const prepared = preparer.prepare(definition);

    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal(prepared.value.definitionForSdk.outputSchema, undefined);
    assert.deepEqual(prepared.value.definitionForSdk.inputSchema, definition.inputSchema);
    assert.notEqual(prepared.value.definitionForSdk, definition);
    assert.ok(definition.outputSchema);
    assert.equal(prepared.value.validateOutput?.({ ok: true }).valid, true);
    assert.equal(prepared.value.validateOutput?.({ wrong: true }).valid, false);
  });

  test('reports malformed schemas during pre-wire preparation', () => {
    const prepared = new McpToolCallPreparer().prepare({
      name: 'invalid',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string', pattern: '[' },
    });

    assert.equal(prepared.ok, false);
  });

  test('compiles each tool against its own schema when $ids collide', () => {
    const preparer = new McpToolCallPreparer();
    const first = preparer.prepare({
      name: 'first',
      inputSchema: { type: 'object' },
      outputSchema: {
        $id: 'shared-id',
        type: 'object',
        properties: { a: { type: 'number' } },
        required: ['a'],
      },
    });
    const second = preparer.prepare({
      name: 'second',
      inputSchema: { type: 'object' },
      outputSchema: {
        $id: 'shared-id',
        type: 'object',
        properties: { b: { type: 'number' } },
        required: ['b'],
      },
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.value.validateOutput?.({ a: 1 }).valid, true);
    assert.equal(first.value.validateOutput?.({ b: 1 }).valid, false);
    assert.equal(second.value.validateOutput?.({ b: 1 }).valid, true);
    assert.equal(second.value.validateOutput?.({ a: 1 }).valid, false);
  });
});
