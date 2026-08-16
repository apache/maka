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
