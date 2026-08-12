import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMcpImport } from '../../renderer/mcp-import.js';

test('MCP import rejects unsupported versions and malformed full configs', () => {
  assert.throws(
    () => parseMcpImport('{"version":2,"mcpServers":{}}'),
    /当前仅支持 version 1/u,
  );
  assert.throws(() => parseMcpImport('{"version":1}'), /mcpServers 必须是 object/u);
});
