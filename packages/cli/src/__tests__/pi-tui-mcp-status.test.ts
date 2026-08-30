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
import { McpManagementOverlay } from '../pi-tui-mcp-status.js';
import type { TuiMcpAction, TuiMcpManagement, TuiMcpSnapshot } from '../tui-mcp-control.js';
import { stripAnsi } from '../tui-ansi.js';

describe('MCP management overlay', () => {
  test('renders the local publication and negotiated server status', () => {
    const overlay = new McpManagementOverlay({
      locale: 'en',
      surface: surface({
        initialization: 'ready',
        configuration: 'ready',
        publication: 'published',
        toolCount: 2,
        servers: [
          {
            serverId: 'filesystem',
            configured: true,
            synchronized: true,
            state: 'connected',
            transport: 'stdio',
            negotiatedProtocol: { era: 'modern', revision: '2026-07-28' },
            toolCount: 2,
          },
        ],
      }),
      viewportRows: () => 8,
      onClose: () => undefined,
      onChange: () => undefined,
    });

    const text = overlay.render(100).map(stripAnsi).join('\n');
    assert.match(text, /published · 2 tools/u);
    assert.match(text, /filesystem  connected · stdio · modern 2026-07-28 · 2 tools/u);
  });

  test('states the remote limitation instead of implying an empty local config', () => {
    const overlay = new McpManagementOverlay({
      locale: 'zh',
      viewportRows: () => 6,
      onClose: () => undefined,
      onChange: () => undefined,
    });

    const text = overlay.render(100).map(stripAnsi).join('\n');
    assert.match(text, /未连接本地 MCP 控制面/u);
    assert.match(text, /远程 Runtime Host/u);
    assert.doesNotMatch(text, /尚未配置/u);
  });

  test('localizes manager states without changing their source values', () => {
    const overlay = new McpManagementOverlay({
      locale: 'zh',
      surface: surface({
        initialization: 'ready',
        configuration: 'ready',
        publication: 'not_published',
        toolCount: 0,
        servers: [
          {
            serverId: 'oauth',
            configured: true,
            synchronized: true,
            state: 'needs-auth',
            transport: 'streamable-http',
            toolCount: 0,
          },
        ],
      }),
      viewportRows: () => 6,
      onClose: () => undefined,
      onChange: () => undefined,
    });

    const text = overlay.render(100).map(stripAnsi).join('\n');
    assert.match(text, /oauth  需要登录 · streamable-http/u);
    assert.doesNotMatch(text, /needs-auth/u);
  });

  test('subscribes only for the overlay lifetime', () => {
    let subscribed = 0;
    let disposed = 0;
    let closed = 0;
    const mcp = surface({
      initialization: 'ready',
      configuration: 'ready',
      publication: 'not_published',
      toolCount: 0,
      servers: [],
    });
    mcp.subscribe = () => {
      subscribed += 1;
      return () => {
        disposed += 1;
      };
    };
    const overlay = new McpManagementOverlay({
      locale: 'en',
      surface: mcp,
      viewportRows: () => 6,
      onClose: () => {
        closed += 1;
      },
      onChange: () => undefined,
    });

    assert.equal(subscribed, 1);
    overlay.handleInput('q');
    assert.equal(disposed, 1);
    assert.equal(closed, 1);
  });

  test('keeps long-list selection visible and applies actions to the visible server', async () => {
    const actions: TuiMcpAction[] = [];
    const mcp = surface({
      initialization: 'ready',
      configuration: 'ready',
      publication: 'not_published',
      toolCount: 0,
      servers: Array.from({ length: 8 }, (_, index) => ({
        serverId: `s${index}`,
        configured: true,
        synchronized: true,
        enabled: true,
        configuredTransport: 'stdio' as const,
        configuredProtocol: 'legacy' as const,
        ...(index === 5 ? { state: 'error' as const, error: 'visible diagnostic' } : {}),
        toolCount: 0,
      })),
    });
    mcp.execute = async (action) => {
      actions.push(action);
      return { status: 'applied', effect: 'published' };
    };
    const overlay = new McpManagementOverlay({
      locale: 'en',
      surface: mcp,
      viewportRows: () => 6,
      onClose: () => undefined,
      onChange: () => undefined,
    });
    overlay.render(100);

    for (let index = 0; index < 5; index += 1) overlay.handleInput('\u001b[B');
    let text = overlay.render(100).map(stripAnsi).join('\n');
    assert.match(text, /› ● s5/u);
    assert.match(text, /visible diagnostic/u);

    overlay.handleInput(' ');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(actions, [{ kind: 'set_enabled', serverId: 's5', enabled: false }]);

    overlay.handleInput('\u001b[H');
    text = overlay.render(100).map(stripAnsi).join('\n');
    assert.match(text, /› ○ s0/u);
    overlay.handleInput('\u001b[6~');
    text = overlay.render(100).map(stripAnsi).join('\n');
    assert.match(text, /› ○ s4/u);
    overlay.handleInput('\u001b[F');
    text = overlay.render(100).map(stripAnsi).join('\n');
    assert.match(text, /› ○ s7/u);
    overlay.handleInput('\u001b[5~');
    text = overlay.render(100).map(stripAnsi).join('\n');
    assert.match(text, /› ○ s4/u);
  });
});

function surface(
  snapshot: TuiMcpSnapshot,
): TuiMcpManagement & { subscribe(listener: () => void): () => void } {
  return {
    snapshot: () => snapshot,
    subscribe: () => () => undefined,
    configForEdit: () => undefined,
    previewImport: () => ({ status: 'invalid', reason: 'invalid-config' }),
    discardImportPreview: () => undefined,
    execute: async () => ({ status: 'failed', reason: 'manager-failed' }),
  };
}
