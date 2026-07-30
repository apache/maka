import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Tool } from '@modelcontextprotocol/client';
import { fingerprintMcpToolDefinition } from '../tool-definition.js';

describe('MCP Tool definition fingerprint', () => {
  test('is stable across object key order and covers raw-only fields', () => {
    const first: Tool = {
      name: 'echo',
      description: 'Echo',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
      },
    };
    const reordered: Tool = {
      inputSchema: {
        properties: { value: { type: 'string' } },
        type: 'object',
      },
      description: 'Echo',
      name: 'echo',
    };
    const changed: Tool = {
      ...first,
      outputSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
      },
    };

    assert.equal(
      fingerprintMcpToolDefinition(first).value,
      fingerprintMcpToolDefinition(reordered).value,
    );
    assert.notEqual(
      fingerprintMcpToolDefinition(first).value,
      fingerprintMcpToolDefinition(changed).value,
    );
  });

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
