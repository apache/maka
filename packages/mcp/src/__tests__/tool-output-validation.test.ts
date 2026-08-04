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
});
