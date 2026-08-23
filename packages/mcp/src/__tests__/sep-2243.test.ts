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
  formatMcpHeaderExclusionWarning,
  MCP_HEADER_WARNING_LENGTH_LIMIT,
  partitionMcpHeaderToolDefinitions,
  validateMcpHeaderArguments,
  validateMcpHeaderDefinition,
  type McpHeaderToolRejection,
} from '../sep-2243.js';

describe('SEP-2243 definition validation', () => {
  test('collects nested string, integer, and boolean properties', () => {
    const result = validateMcpHeaderDefinition({
      type: 'object',
      properties: {
        region: { type: 'string', 'x-mcp-header': 'Region' },
        options: {
          type: 'object',
          properties: {
            attempt: { type: 'integer', 'x-mcp-header': 'Attempt' },
            dryRun: { type: 'boolean', 'x-mcp-header': 'Dry-Run' },
          },
        },
      },
    });

    assert.equal(result.valid, true);
    if (!result.valid) return;
    assert.deepEqual(result.declarations, [
      { path: ['region'], headerName: 'Region', type: 'string' },
      { path: ['options', 'attempt'], headerName: 'Attempt', type: 'integer' },
      { path: ['options', 'dryRun'], headerName: 'Dry-Run', type: 'boolean' },
    ]);
  });

  test('rejects number even though the pinned SDK accepts it', () => {
    assertInvalid(
      {
        type: 'object',
        properties: {
          ratio: { type: 'number', 'x-mcp-header': 'Ratio' },
        },
      },
      'property_type_unsupported',
      ['ratio'],
    );
  });

  test('uses stable codes for malformed annotation values and property types', () => {
    assertInvalid(schemaFor({ type: 'string', 'x-mcp-header': 42 }), 'annotation_not_string', [
      'value',
    ]);
    assertInvalid(schemaFor({ type: 'string', 'x-mcp-header': '' }), 'header_name_empty', [
      'value',
    ]);
    assertInvalid(
      schemaFor({ type: ['string', 'null'], 'x-mcp-header': 'Value' }),
      'property_type_unsupported',
      ['value'],
    );
  });

  test('requires an RFC 9110 token for the header name', () => {
    for (const headerName of ['My Region', 'Region:Primary', 'Région', 'Region\t1']) {
      assertInvalid(
        schemaFor({ type: 'string', 'x-mcp-header': headerName }),
        'header_name_invalid',
        ['value'],
      );
    }

    const allowed = validateMcpHeaderDefinition(
      schemaFor({ type: 'string', 'x-mcp-header': "!#$%&'*+-.^_`|~09Az" }),
    );
    assert.equal(allowed.valid, true);
  });

  test('requires case-insensitively unique header names across nesting levels', () => {
    assertInvalid(
      {
        type: 'object',
        properties: {
          first: { type: 'string', 'x-mcp-header': 'Region' },
          nested: {
            type: 'object',
            properties: {
              second: { type: 'string', 'x-mcp-header': 'rEgIoN' },
            },
          },
        },
      },
      'header_name_duplicate',
      ['nested', 'second'],
    );
  });

  test('rejects annotations outside a properties-only static path', () => {
    assertInvalid({ type: 'object', 'x-mcp-header': 'Root' }, 'not_statically_reachable', []);

    const unreachableSchemas: Array<[string, unknown]> = [
      ['items', { type: 'string', 'x-mcp-header': 'Item' }],
      ['additionalProperties', { type: 'string', 'x-mcp-header': 'Additional' }],
      ['oneOf', [{ type: 'string', 'x-mcp-header': 'Choice' }]],
      ['$defs', { declared: { type: 'string', 'x-mcp-header': 'Definition' } }],
      ['patternProperties', { '^dynamic': { type: 'string', 'x-mcp-header': 'Pattern' } }],
    ];

    for (const [keyword, subschema] of unreachableSchemas) {
      assertInvalid({ type: 'object', [keyword]: subschema }, 'not_statically_reachable', [
        `<${keyword}>`,
      ]);
    }
  });
});

test('partitioning excludes only malformed Tools and preserves valid references', () => {
  const valid = {
    name: 'search',
    inputSchema: schemaFor({ type: 'string', 'x-mcp-header': 'Region' }),
  };
  const invalid = {
    name: 'calculate',
    inputSchema: schemaFor({ type: 'number', 'x-mcp-header': 'Ratio' }),
  };
  const plain = { name: 'echo', inputSchema: { type: 'object' } };

  const result = partitionMcpHeaderToolDefinitions([valid, invalid, plain]);

  assert.deepEqual(
    result.valid.map(({ tool }) => tool),
    [valid, plain],
  );
  assert.deepEqual(result.rejected, [
    {
      toolName: 'calculate',
      issue: { code: 'property_type_unsupported', path: ['value'] },
    },
  ]);
});

describe('SEP-2243 exclusion warning', () => {
  test('reports the total and a capped sample using stable reason codes', () => {
    const rejections = Array.from({ length: 8 }, (_, index) =>
      rejection(
        `tool-${index}`,
        index % 2 === 0 ? 'header_name_invalid' : 'property_type_unsupported',
      ),
    );

    const warning = formatMcpHeaderExclusionWarning(rejections);

    assert.ok(warning);
    assert.match(warning, /excluded 8 Tool definition/u);
    assert.match(warning, /\[header_name_invalid\]/u);
    assert.match(warning, /\[property_type_unsupported\]/u);
    assert.match(warning, /3 more not shown/u);
    assert.doesNotMatch(warning, /tool-5-/u);
    assert.ok(warning.length <= MCP_HEADER_WARNING_LENGTH_LIMIT);
  });

  test('sanitizes control characters and always honors the rendered-length cap', () => {
    const warning = formatMcpHeaderExclusionWarning([
      rejection(`line\r\n\u2028\u2029${'😀\\'.repeat(200)}`, 'header_name_invalid'),
      rejection('second', 'header_name_duplicate'),
      rejection('third', 'annotation_not_string'),
      rejection('fourth', 'header_name_empty'),
      rejection('fifth', 'not_statically_reachable'),
    ]);

    assert.ok(warning);
    assert.doesNotMatch(warning, /[\r\n\u2028\u2029]/u);
    assert.match(warning, /…/u);
    assert.ok(warning.length <= MCP_HEADER_WARNING_LENGTH_LIMIT);
  });

  test('redacts secret-shaped Tool names before logging them', () => {
    const secret = 'sk-ant-1234567890abcdef';
    const warning = formatMcpHeaderExclusionWarning([
      rejection(`tool-${secret}`, 'header_name_invalid'),
    ]);

    assert.ok(warning);
    assert.doesNotMatch(warning, new RegExp(secret, 'u'));
    assert.match(warning, /\[redacted\]/u);
  });

  test('returns undefined when no Tool was excluded', () => {
    assert.equal(formatMcpHeaderExclusionWarning([]), undefined);
  });
});

describe('SEP-2243 call-time integer validation', () => {
  const definition = validateMcpHeaderDefinition({
    type: 'object',
    properties: {
      routing: {
        type: 'object',
        properties: {
          shard: { type: 'integer', 'x-mcp-header': 'Shard' },
        },
      },
    },
  });
  assert.equal(definition.valid, true);
  if (!definition.valid) throw new Error('test setup is invalid');

  test('accepts safe boundaries and leaves other schema validation to the caller', () => {
    for (const value of [
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      undefined,
      null,
      'not-a-number',
      1.5,
      Number.POSITIVE_INFINITY,
    ]) {
      assert.deepEqual(
        validateMcpHeaderArguments(definition.declarations, {
          routing: { shard: value },
        }),
        { valid: true },
      );
    }
  });

  test('returns a stable local failure for unsafe integer arguments', () => {
    assert.deepEqual(
      validateMcpHeaderArguments(definition.declarations, {
        routing: { shard: Number.MAX_SAFE_INTEGER + 1 },
      }),
      {
        valid: false,
        code: 'unsafe_integer_argument',
        path: ['routing', 'shard'],
      },
    );
  });
});

function schemaFor(property: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    properties: { value: property },
  };
}

function assertInvalid(
  schema: unknown,
  code: McpHeaderToolRejection['issue']['code'],
  path: readonly string[],
): void {
  const result = validateMcpHeaderDefinition(schema);
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.deepEqual(result.issue, { code, path });
}

function rejection(
  toolName: string,
  code: McpHeaderToolRejection['issue']['code'],
): McpHeaderToolRejection {
  return { toolName, issue: { code, path: ['value'] } };
}
