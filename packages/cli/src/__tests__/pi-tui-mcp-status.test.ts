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
import type { TUI } from '@earendil-works/pi-tui';
import type { McpTestResult } from '@maka/core/mcp';
import { McpManagementOverlay } from '../pi-tui-mcp-status.js';
import type {
  TuiMcpAction,
  TuiMcpActionResult,
  TuiMcpManagement,
  TuiMcpSnapshot,
} from '../tui-mcp-control.js';
import { TUI_COPY_RESOURCES } from '../tui-copy-catalog.js';
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

  test('masks remote provider credentials while typing and clears them after submission', async () => {
    const actions: TuiMcpAction[] = [];
    const mcp = surface({
      initialization: 'ready',
      configuration: 'ready',
      publication: 'credential_rejected',
      canManagePublicationCredential: true,
      toolCount: 0,
      servers: [],
    });
    mcp.execute = async (action) => {
      actions.push(action);
      return { status: 'applied', effect: 'published' };
    };
    const overlay = new McpManagementOverlay({
      locale: 'en',
      tui: {} as TUI,
      surface: mcp,
      viewportRows: () => 8,
      onClose: () => undefined,
      onChange: () => undefined,
    });

    let text = overlay.render(160).map(stripAnsi).join('\n');
    assert.match(text, /provider credential rejected/u);
    assert.match(text, /p Set provider credential/u);
    overlay.handleInput('p');
    overlay.handleInput('maka_rh_secret-marker');
    text = overlay.render(160).map(stripAnsi).join('\n');
    assert.match(text, /•••••••••••••••••••••/u);
    assert.doesNotMatch(text, /maka_rh_secret-marker/u);

    overlay.handleInput('\n');
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(actions, [
      { kind: 'set_publication_credential', credential: 'maka_rh_secret-marker' },
    ]);
    assert.doesNotMatch(overlay.render(160).map(stripAnsi).join('\n'), /maka_rh_secret-marker/u);
  });

  test('renders a competing remote provider as a visible conflict', () => {
    const overlay = new McpManagementOverlay({
      locale: 'en',
      surface: surface({
        initialization: 'ready',
        configuration: 'ready',
        publication: 'provider_conflict',
        toolCount: 0,
        servers: [],
      }),
      viewportRows: () => 6,
      onClose: () => undefined,
      onChange: () => undefined,
    });

    assert.match(overlay.render(100).map(stripAnsi).join('\n'), /provider active in another TUI/u);
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

  test('routes the guided add flow through catalog headings, labels, and hints', () => {
    const locale = 'en';
    const expected = TUI_COPY_RESOURCES['mcp-status'][locale].editor;
    const overlay = new McpManagementOverlay({
      locale,
      tui: fakeTui(),
      surface: surface(listSnapshot()),
      viewportRows: () => 14,
      onClose: () => undefined,
      onChange: () => undefined,
    });
    const rendered = () => overlay.render(100).map(stripAnsi).join('\n');

    overlay.handleInput('a');
    assert.ok(rendered().includes(expected.addTitle));
    overlay.handleInput('g');
    let text = rendered();
    assert.ok(text.includes(expected.inputLabels.server_id));
    assert.ok(text.includes(expected.hints.submit));
    for (const char of 'demo') overlay.handleInput(char);
    overlay.handleInput('\r');
    assert.ok(rendered().includes(expected.transportTitle));
    overlay.handleInput('1');
    text = rendered();
    assert.ok(text.includes(expected.inputLabels.command));
    for (const char of 'echo') overlay.handleInput(char);
    overlay.handleInput('\r');
    text = rendered();
    assert.ok(text.includes(expected.inputLabels.args));
    assert.ok(text.includes(expected.hints.args));
    overlay.handleInput('\r');
    assert.ok(rendered().includes(expected.protocolTitle));
    overlay.handleInput('2');
    text = rendered();
    assert.ok(text.includes(expected.inputLabels.cwd));
    assert.ok(text.includes(expected.hints.optional));
    overlay.handleInput('\r');
    text = rendered();
    assert.ok(text.includes(expected.inputLabels.env));
    assert.ok(text.includes(expected.hints.map));
    overlay.handleInput('\r');
    text = rendered();
    assert.ok(text.includes(expected.confirmAddTitle));
    assert.ok(text.includes('demo · stdio · auto'));
    assert.ok(text.includes('echo'));
    assert.ok(text.includes(expected.confirmHint));
  });

  test('routes remove confirmation copy and interpolates the server id', () => {
    const locale = 'en';
    const expected = TUI_COPY_RESOURCES['mcp-status'][locale].editor;
    const overlay = new McpManagementOverlay({
      locale,
      surface: surface(listSnapshot()),
      viewportRows: () => 8,
      onClose: () => undefined,
      onChange: () => undefined,
    });
    overlay.render(100);

    overlay.handleInput('d');
    const text = overlay.render(100).map(stripAnsi).join('\n');
    assert.ok(text.includes(expected.confirmRemoveTitle.replace('{serverId}', 'filesystem')));
    assert.ok(text.includes(expected.confirmHint));
  });

  for (const locale of ['en', 'zh'] as const) {
    test(`labels the busy phase per action kind in ${locale}`, () => {
      const expected = TUI_COPY_RESOURCES['mcp-status'][locale].editor;
      const mcp = surface(listSnapshot());
      mcp.execute = () => new Promise(() => undefined);
      const overlay = new McpManagementOverlay({
        locale,
        surface: mcp,
        viewportRows: () => 8,
        onClose: () => undefined,
        onChange: () => undefined,
      });
      overlay.render(100);

      const labels: [string, string][] = [
        ['t', expected.action.test],
        ['r', expected.action.reconnect],
        [' ', expected.action.apply],
      ];
      for (const [key, label] of labels) {
        overlay.handleInput(key);
        assert.ok(overlay.render(100).map(stripAnsi).join('\n').includes(label));
        overlay.handleInput('\u001b');
      }
    });
  }

  const resultCopy = TUI_COPY_RESOURCES['mcp-status'].en.editor.results;
  const RESULT_CASES: readonly [TuiMcpActionResult, keyof typeof resultCopy][] = [
    [{ status: 'conflict', reason: 'exists' }, 'exists'],
    [{ status: 'conflict', reason: 'stale_config' }, 'stale_config'],
    [{ status: 'conflict', reason: 'stale_edit' }, 'stale_edit'],
    [{ status: 'conflict', reason: 'stale_import' }, 'stale_import'],
    [{ status: 'conflict', reason: 'missing' }, 'missing'],
    [{ status: 'failed', reason: 'closed' }, 'closed'],
    [{ status: 'failed', reason: 'invalid-config' }, 'invalid-config'],
    [{ status: 'failed', reason: 'credential-cleanup-failed' }, 'credential-cleanup-failed'],
    [{ status: 'failed', reason: 'persist-failed' }, 'persist-failed'],
    [{ status: 'failed', reason: 'manager-failed' }, 'manager-failed'],
    [{ status: 'applied', effect: 'published' }, 'published'],
    [{ status: 'applied', effect: 'pending_host' }, 'pending_host'],
    [{ status: 'applied', effect: 'sync_failed' }, 'sync_failed'],
    [{ status: 'applied', effect: 'publication_failed' }, 'publication_failed'],
    [{ status: 'tested', test: testResult(true), effect: 'published' }, 'test_ok'],
    [{ status: 'tested', test: testResult(false), effect: 'published' }, 'test_failed'],
    [
      { status: 'tested', test: testResult(true), effect: 'publication_failed' },
      'test_publication_failed',
    ],
    [{ status: 'tested', test: testResult(true), effect: 'pending_host' }, 'test_pending_host'],
  ];

  test('routes every action result to its catalog notice', async () => {
    for (const [result, code] of RESULT_CASES) {
      const mcp = surface(listSnapshot());
      mcp.execute = async () => result;
      const overlay = new McpManagementOverlay({
        locale: 'en',
        surface: mcp,
        viewportRows: () => 8,
        onClose: () => undefined,
        onChange: () => undefined,
      });
      overlay.render(100);

      overlay.handleInput(' ');
      await new Promise<void>((resolve) => setImmediate(resolve));
      const text = overlay.render(100).map(stripAnsi).join('\n');
      assert.ok(text.includes(resultCopy[code]), code);
    }
  });
});

function testResult(ok: boolean): McpTestResult {
  return {
    ok,
    latencyMs: 1,
    status: {
      serverId: 'filesystem',
      state: ok ? 'connected' : 'error',
      toolCount: 0,
      tools: [],
      updatedAt: 0,
    },
  };
}

function listSnapshot(): TuiMcpSnapshot {
  return {
    initialization: 'ready',
    configuration: 'ready',
    publication: 'published',
    toolCount: 0,
    servers: [
      { serverId: 'filesystem', configured: true, synchronized: true, enabled: true, toolCount: 0 },
    ],
  };
}

function fakeTui(): TUI {
  return {
    requestRender: () => undefined,
    terminal: { rows: 24, columns: 80 },
  } as unknown as TUI;
}

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
