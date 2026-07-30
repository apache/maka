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
