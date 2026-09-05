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
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup as renderReactToStaticMarkup } from 'react-dom/server';
import { computerUseModelCallArgs } from '@maka/core/computer-use';
import { ToolCallDetail, ToolTrow } from '../tool-activity.js';
import type { ToolActivityItem } from '../materialize.js';
import { LocaleProvider } from '../locale-context.js';
import { ToolResultPreview } from '../tool-activity/tool-result-preview.js';
import {
  computerActionLabel,
  computerRunningLabel,
  isComputerTool,
} from '../tool-activity/computer-action-label.js';

function renderToStaticMarkup(node: ReactNode, locale: 'zh-CN' | 'en' = 'zh-CN'): string {
  return renderReactToStaticMarkup(createElement(LocaleProvider, {
    locale,
    children: node,
  }));
}

describe('tool activity presentation', () => {
  it('localizes client capability boundary failures and offers recovery', () => {
    const item: ToolActivityItem = {
      toolUseId: 'client-capability-boundary',
      toolName: 'maka_computer',
      displayName: '列出打开的应用',
      activityKind: 'computer',
      status: 'errored',
      args: { action: 'list_apps' },
      result: {
        kind: 'text',
        text: 'Client Capability tools require the Bypass execution boundary.',
        sandboxFailure: {
          reason: 'requires_bypass',
          source: 'client_capability',
        },
      },
    };

    const zh = renderToStaticMarkup(createElement(ToolCallDetail, {
      item,
      onSwitchToBypassAndRetry: async () => undefined,
    }));
    const en = renderToStaticMarkup(createElement(ToolCallDetail, {
      item,
      onSwitchToBypassAndRetry: async () => undefined,
    }), 'en');

    assert.match(zh, /需要“绕过”模式/);
    assert.match(zh, /此操作会直接控制本机应用，无法在沙箱模式下执行。/);
    assert.match(zh, /切换并重试/);
    assert.doesNotMatch(zh, /Client Capability tools require/);
    assert.match(en, /Bypass mode required/);
    assert.match(en, /Switch and retry/);
  });

  it('keeps generic requires-bypass failures verbatim', () => {
    const markup = renderToStaticMarkup(createElement(ToolCallDetail, {
      item: {
        toolUseId: 'filesystem-boundary',
        toolName: 'Write',
        status: 'errored',
        args: { path: '/etc/hosts' },
        result: {
          kind: 'text',
          text: 'This path requires the Bypass execution boundary.',
          sandboxFailure: { reason: 'requires_bypass' },
        },
      } satisfies ToolActivityItem,
      onSwitchToBypassAndRetry: async () => undefined,
    }));

    assert.match(markup, /This path requires the Bypass execution boundary./);
    assert.doesNotMatch(markup, /控制本机应用|切换并重试/);
  });

  it('localizes file-write result summaries', () => {
    const result = {
      kind: 'file_write' as const,
      path: '/tmp/output.txt',
      bytes: 42,
    };
    assert.match(
      renderToStaticMarkup(createElement(ToolResultPreview, { content: result })),
      /已向 \/tmp\/output.txt 写入 42 字节/,
    );
    assert.match(
      renderToStaticMarkup(createElement(ToolResultPreview, { content: result }), 'en'),
      /Wrote 42 bytes to \/tmp\/output.txt/,
    );
  });

  it('describes Computer Use proxy calls by action instead of the generic tool name', () => {
    const item: ToolActivityItem = {
      toolUseId: 'computer-observe',
      toolName: 'mcp__desktop_computer_use__maka_computer',
      displayName: 'Maka Computer',
      activityKind: 'tool',
      status: 'completed',
      args: computerUseModelCallArgs({
        action: 'observe',
        app: '计算器',
        window_id: 7,
      }),
    };

    assert.equal(isComputerTool(item), true);
    assert.equal(computerActionLabel(item, 'zh-CN'), '观察「计算器」窗口');
    const markup = renderToStaticMarkup(
      createElement(ToolTrow, { items: [item] }),
    );
    assert.match(markup, /观察「计算器」窗口/);
    assert.doesNotMatch(markup, /Maka Computer/);
  });

  it('inherits the confirmed target and exposes live sequence progress', () => {
    const observed: ToolActivityItem = {
      toolUseId: 'computer-observe',
      toolName: 'maka_computer',
      activityKind: 'computer',
      status: 'completed',
      args: computerUseModelCallArgs({
        action: 'observe',
        app: '计算器',
        window_id: 7,
      }),
    };
    const sequence: ToolActivityItem = {
      toolUseId: 'computer-sequence',
      toolName: 'maka_computer',
      activityKind: 'computer',
      status: 'running',
      args: computerUseModelCallArgs({
        action: 'element_sequence',
        observation_id: '00000000-0000-0000-0000-000000000001',
        steps: Array.from({ length: 11 }, (_, index) => ({ label: String(index) })),
      }),
      progress: { current: 7, total: 11 },
    };

    const markup = renderToStaticMarkup(
      createElement(ToolTrow, { items: [observed, sequence] }),
    );
    assert.match(markup, /连续操作 11 个控件/);
    assert.match(markup, /「计算器」窗口/);
    assert.match(markup, />7\/11</);
    assert.equal(
      computerRunningLabel([observed, sequence], 'zh-CN'),
      '正在操作「计算器」窗口 · 连续操作第 7/11 步',
    );
  });

  it('renders a tool_search activation as a localized capability summary', () => {
    const item: ToolActivityItem = {
      toolUseId: 'search-computer-use',
      toolName: 'tool_search',
      activityKind: 'tool',
      status: 'completed',
      args: { query: 'operate local desktop application' },
      result: {
        kind: 'json',
        value: {
          activated: ['mcp__desktop_computer_use__maka_computer'],
        },
      },
    };

    const row = renderToStaticMarkup(createElement(ToolTrow, { items: [item] }));
    assert.match(row, /启用桌面操作/);
    const detail = renderToStaticMarkup(createElement(ToolCallDetail, { item }));
    assert.match(detail, /桌面操作已启用/);
    assert.match(detail, /可以查看和操作已授权的本地应用/);
    assert.match(detail, /1 项能力可用/);
    assert.match(detail, /技术详情/);
    assert.match(detail, /mcp__desktop_computer_use__maka_computer/);
  });

  it('keeps legacy Computer Use activations friendly without result metadata', () => {
    const item: ToolActivityItem = {
      toolUseId: 'legacy-load-computer-use',
      toolName: 'load_tool',
      status: 'completed',
      args: { namespace: 'client_legacy_desktop_computer_use' },
      result: {
        kind: 'json',
        value: { loaded: ['mcp__desktop_computer_use__maka_computer'] },
      },
    };

    const markup = renderToStaticMarkup(createElement(ToolCallDetail, { item }));
    assert.match(markup, /桌面操作已启用/);
    assert.doesNotMatch(markup, /已加载 client_legacy_desktop_computer_use 工具组/);
  });

  it('uses supplied labels for third-party capability groups', () => {
    const item: ToolActivityItem = {
      toolUseId: 'load-third-party',
      toolName: 'load_tools',
      status: 'completed',
      args: { group: 'client_external_notionsuite' },
      result: {
        kind: 'json',
        value: {
          loaded: ['mcp__notion__search', 'mcp__notion__create_page'],
          group: {
            id: 'client_external_notionsuite',
            label: 'Notion',
            description: 'Search and update the connected workspace.',
          },
        },
      },
    };

    const row = renderToStaticMarkup(createElement(ToolTrow, { items: [item] }));
    assert.match(row, /启用 Notion/);
    const detail = renderToStaticMarkup(createElement(ToolCallDetail, { item }));
    assert.match(detail, /Notion 已启用/);
    assert.match(detail, /Search and update the connected workspace/);
    assert.match(detail, /2 项能力可用/);
  });

  it('uses one localized presentation model for every first-party capability group', () => {
    const cases = [
      {
        id: 'browser',
        label: 'Browser',
        tool: 'browser_navigate',
        row: '启用浏览器操作',
        title: '浏览器操作已启用',
      },
      {
        id: 'client_desktop_mcp',
        label: 'MCP',
        tool: 'mcp__desktop_mcp__list',
        row: '连接 MCP',
        title: 'MCP 工具已连接',
      },
      {
        id: 'rive',
        label: 'Rive',
        tool: 'RiveWorkflow',
        row: '启用 Rive 工作流',
        title: 'Rive 工作流已启用',
      },
      {
        id: 'agent',
        label: 'Agent',
        tool: 'agent_spawn',
        row: '启用子智能体',
        title: '子智能体协作已启用',
      },
      {
        id: 'client_desktop_settings',
        label: 'Client settings',
        tool: 'mcp__desktop_settings__MakaSettingsGet',
        row: '启用设置工具',
        title: '设置工具已启用',
      },
    ] as const;

    for (const capability of cases) {
      const item: ToolActivityItem = {
        toolUseId: `load-${capability.id}`,
        toolName: 'load_tools',
        status: 'completed',
        args: { group: capability.id },
        result: {
          kind: 'json',
          value: {
            loaded: [capability.tool],
            group: { id: capability.id, label: capability.label },
          },
        },
      };

      const row = renderToStaticMarkup(createElement(ToolTrow, { items: [item] }));
      assert.match(row, new RegExp(capability.row));
      const detail = renderToStaticMarkup(createElement(ToolCallDetail, { item }));
      assert.match(detail, new RegExp(capability.title));
      assert.doesNotMatch(detail, new RegExp(`>${capability.id}</p>`));
    }
  });

  it('contains a malformed persisted terminal result instead of crashing the renderer', () => {
    const malformed = {
      kind: 'terminal',
      cwd: '/tmp/maka',
      cmd: 'npm test',
      status: 'failed',
      exitCode: 1,
    } as unknown as NonNullable<ToolActivityItem['result']>;
    const markup = renderToStaticMarkup(createElement(ToolCallDetail, {
      item: {
        toolUseId: 'tool-malformed-terminal',
        toolName: 'Bash',
        status: 'errored',
        args: { command: 'npm test' },
        result: malformed,
      } satisfies ToolActivityItem,
    }));

    assert.match(markup, /npm test/);
    assert.match(markup, /终端输出不可用/);
    assert.doesNotMatch(markup, /失败 · 退出码|退出码 1/);
  });

  it('redacts secrets in sensitive values and property names', () => {
    const cases: Array<Record<string, unknown>> = [
      { password: 'correct-horse', token: 'short-secret' },
      { 'api_key=sk-1234567890abcdefghi': true },
      { 'Authorization: Bearer SENTINEL_TOKEN': true },
      { 'private key: gamma delta': true },
      { 'access token: alpha beta': true },
    ];
    for (const args of cases) {
      const markup = renderToStaticMarkup(createElement(ToolCallDetail, {
        item: {
          toolUseId: 'tool-secret',
          toolName: 'CustomInspect',
          status: 'running',
          args,
          result: { kind: 'json', value: { ok: true } },
        } satisfies ToolActivityItem,
      }));
      assert.doesNotMatch(
        markup,
        /correct-horse|short-secret|sk-1234567890abcdefghi|SENTINEL_TOKEN|gamma|delta|alpha|beta/,
      );
      assert.match(markup, /redacted/i);
    }
  });

  it('keeps pre-handoff live output when shell_run lands with empty streams', () => {
    const markup = renderToStaticMarkup(createElement(ToolCallDetail, {
      item: {
        toolUseId: 'tool-shell-run-empty',
        toolName: 'Bash',
        activityKind: 'command',
        status: 'running',
        args: { command: 'npm test' },
        outputChunks: [
          { seq: 1, stream: 'stdout', text: 'starting-live-output\n', redacted: true, createdAt: 1 },
        ],
        outputTruncated: true,
        result: {
          kind: 'shell_run',
          ref: 'maka://runtime/background-tasks/bg-empty',
          mode: 'pipes',
          status: 'running',
          cwd: '/repo',
          cmd: 'npm test',
          startedAt: 1,
          updatedAt: 2,
          revision: 1,
        },
      } satisfies ToolActivityItem,
    }));

    assert.match(markup, /starting-live-output/);
    assert.match(markup, /已脱敏/);
    assert.match(markup, /输出已截断/);
    assert.doesNotMatch(markup, /尚无输出/);
    const panels = markup.match(/data-slot="tool-output"/g) ?? [];
    assert.equal(panels.length, 1);
  });

  it('keeps redacted/truncated meta when live chunks are empty bodies', () => {
    const markup = renderToStaticMarkup(createElement(ToolCallDetail, {
      item: {
        toolUseId: 'tool-shell-run-empty-meta',
        toolName: 'Bash',
        activityKind: 'command',
        status: 'running',
        args: { command: 'npm test' },
        outputChunks: [
          { seq: 1, stream: 'stdout', text: '', redacted: true, createdAt: 1 },
        ],
        outputTruncated: true,
        result: {
          kind: 'shell_run',
          ref: 'maka://runtime/background-tasks/bg-meta',
          mode: 'pipes',
          status: 'running',
          cwd: '/repo',
          cmd: 'npm test',
          startedAt: 1,
          updatedAt: 2,
          revision: 1,
        },
      } satisfies ToolActivityItem,
    }));

    assert.match(markup, /已脱敏/);
    assert.match(markup, /输出已截断/);
    const panels = markup.match(/data-slot="tool-output"/g) ?? [];
    assert.equal(panels.length, 1);
  });

  it('keeps provider call ids out of output action names', () => {
    const render = (toolUseId: string) =>
      renderToStaticMarkup(createElement(ToolCallDetail, {
        item: {
          toolUseId,
          toolName: 'Bash',
          status: 'running',
          args: { command: 'npm test' },
          outputChunks: [
            { seq: 1, stream: 'stdout', text: 'running\n', redacted: false, createdAt: 1 },
          ],
        } satisfies ToolActivityItem,
      }));
    const firstId = 'provider-call-first-12345678';
    const secondId = 'provider-call-second-12345678';

    assert.doesNotMatch(render(firstId), new RegExp(firstId));
    assert.doesNotMatch(render(secondId), new RegExp(secondId));
    assert.match(render(firstId), /Bash/);
  });

  it('disambiguates code copy actions by their tool call', () => {
    const details = createElement('div', null,
      createElement(ToolCallDetail, {
        item: {
          toolUseId: 'tool-alpha',
          toolName: 'AlphaTool',
          status: 'completed',
          args: {},
          result: { kind: 'json', value: { ok: true } },
        } satisfies ToolActivityItem,
      }),
      createElement(ToolCallDetail, {
        item: {
          toolUseId: 'tool-beta',
          toolName: 'BetaTool',
          status: 'completed',
          args: {},
          result: { kind: 'json', value: { ok: true } },
        } satisfies ToolActivityItem,
      }),
    );
    const zhMarkup = renderToStaticMarkup(details);
    const enMarkup = renderToStaticMarkup(details, 'en');

    assert.match(zhMarkup, /aria-label="复制：AlphaTool"/);
    assert.match(zhMarkup, /aria-label="复制：BetaTool"/);
    assert.match(enMarkup, /aria-label="Copy: AlphaTool"/);
    assert.match(enMarkup, /aria-label="Copy: BetaTool"/);
  });
});

describe('collapsed tool row target', () => {
  const baseItem = {
    toolUseId: 'tool-collapsed',
    toolName: 'Bash',
    status: 'running' as const,
  };

  it('shows the invocation line derived from args when no intent exists', async () => {
    const { ToolTrow } = await import('../tool-activity.js');
    const markup = renderToStaticMarkup(createElement(ToolTrow, {
      items: [{
        ...baseItem,
        args: { command: 'git status --porcelain' },
      }],
    }));
    assert.match(markup, /git status --porcelain/);
  });

  it('prefers the runtime-authored intent over the args-derived line', async () => {
    const { ToolTrow } = await import('../tool-activity.js');
    const markup = renderToStaticMarkup(createElement(ToolTrow, {
      items: [{
        ...baseItem,
        intent: '检查渲染入口',
        args: { command: 'rg renderEntry' },
      }],
    }));
    assert.match(markup, /检查渲染入口/);
  });

  it('names a live call from the wire args preview before full args arrive', async () => {
    const { ToolTrow } = await import('../tool-activity.js');
    const markup = renderToStaticMarkup(createElement(ToolTrow, {
      items: [{
        ...baseItem,
        args: undefined,
        argsPreview: { command: 'npm test' },
      }],
    }));
    assert.match(markup, /npm test/);
  });

  it('caps a long command so the collapsed row stays single-line', async () => {
    const { ToolTrow } = await import('../tool-activity.js');
    const markup = renderToStaticMarkup(createElement(ToolTrow, {
      items: [{
        ...baseItem,
        args: { command: `echo ${'x'.repeat(300)}` },
      }],
    }));
    const matches = markup.match(/x{100,}/g) ?? [];
    for (const run of matches) {
      assert.ok(run.length <= 119, `expected a capped run, got ${run.length}`);
    }
    assert.match(markup, /…/);
  });

  it('redacts secrets in the collapsed target', async () => {
    const { ToolTrow } = await import('../tool-activity.js');
    const markup = renderToStaticMarkup(createElement(ToolTrow, {
      items: [{
        ...baseItem,
        args: { command: 'curl -H "Authorization: Bearer live-secret-token" https://example.com' },
      }],
    }));
    assert.doesNotMatch(markup, /live-secret-token/);
    assert.match(markup, /redacted/i);
  });
});
