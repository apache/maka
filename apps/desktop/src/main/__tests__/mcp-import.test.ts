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
import test from 'node:test';
import { MCP_CONFIG_VERSION } from '@maka/core/mcp';
import { parseMcpImport } from '../../renderer/mcp-import.js';

test('MCP import migrates version 1 and unwrapped server maps to version 2', () => {
  assert.deepEqual(parseMcpImport('{"version":1,"mcpServers":{"local":{"command":"node"}}}'), {
    version: MCP_CONFIG_VERSION,
    mcpServers: { local: { command: 'node' } },
  });
  assert.deepEqual(parseMcpImport('{"remote":{"url":"https://example.com/mcp"}}'), {
    version: MCP_CONFIG_VERSION,
    mcpServers: { remote: { url: 'https://example.com/mcp' } },
  });
  assert.deepEqual(parseMcpImport('{"version":{"command":"node"}}'), {
    version: MCP_CONFIG_VERSION,
    mcpServers: { version: { command: 'node' } },
  });
  assert.deepEqual(parseMcpImport('{"mcpServers":{"command":"node"}}'), {
    version: MCP_CONFIG_VERSION,
    mcpServers: { mcpServers: { command: 'node' } },
  });
});

test('MCP import preserves remote protocol preferences from a version 2 wrapper', () => {
  assert.deepEqual(
    parseMcpImport(
      '{"version":2,"mcpServers":{"remote":{"url":"https://example.com/mcp","protocol":"2026-07-28"}}}',
    ),
    {
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        remote: { url: 'https://example.com/mcp', protocol: '2026-07-28' },
      },
    },
  );
});

test('MCP import rejects protocol under a version 1 or missing wrapper', () => {
  for (const source of [
    '{"version":1,"mcpServers":{"remote":{"url":"https://example.com/mcp","protocol":"auto"}}}',
    '{"mcpServers":{"remote":{"url":"https://example.com/mcp","protocol":"auto"}}}',
    '{"remote":{"url":"https://example.com/mcp","protocol":"auto"}}',
  ]) {
    assert.throws(() => parseMcpImport(source), /protocol.*version 2/u);
  }
});

test('MCP import rejects unsupported versions and malformed full configs', () => {
  assert.throws(
    () => parseMcpImport('{"version":3,"mcpServers":{}}'),
    /当前支持 version 1 和 2/u,
  );
  assert.throws(() => parseMcpImport('{"version":2}'), /mcpServers 必须是 object/u);
});
