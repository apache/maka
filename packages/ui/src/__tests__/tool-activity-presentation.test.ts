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
import { UI_LOCALES, type UiCatalog, type UiLocale } from '@maka/core/ui-locale';
import { ToolCallDetail, ToolTrow } from '../tool-activity.js';
import type { ToolActivityItem } from '../materialize.js';
import { LocaleProvider } from '../locale-context.js';
import { ToolResultPreview } from '../tool-activity/tool-result-preview.js';
import { getToolActivityCopy } from '../tool-activity/copy.js';
import {
  computerActionLabel,
  computerRunningLabel,
  isComputerTool,
} from '../tool-activity/computer-action-label.js';

function renderToStaticMarkup(node: ReactNode, locale: UiLocale = 'zh-CN'): string {
  return renderReactToStaticMarkup(createElement(LocaleProvider, {
    locale,
    children: node,
  }));
}

function outputPanelCount(markup: string): number {
  return (markup.match(/data-slot="tool-output"/g) ?? []).length;
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
    assert.equal(outputPanelCount(zh), 0);
    assert.match(en, /Bypass mode required/);
    assert.match(en, /Switch and retry/);

    const errorMessages = {
      'zh-CN': '需要“绕过”模式。此操作会直接控制本机应用，无法在沙箱模式下执行。',
      'zh-TW': '需要“繞過”模式。此操作會直接控制本機應用，無法在沙箱模式下執行。',
      en: 'Bypass mode required. This action controls a local app directly and cannot run inside the sandbox.',
    } satisfies UiCatalog<string>;
    for (const locale of UI_LOCALES) {
      const row = renderToStaticMarkup(createElement(ToolTrow, { items: [item] }), locale);
      assert.ok(row.includes(`title="${errorMessages[locale]}"`), `${locale}: full bypass error`);
      assert.doesNotMatch(row, /Client Capability tools require/);
      const copy = getToolActivityCopy(locale).requiresBypass;
      assert.ok(copy.errorMessage.startsWith(copy.title), `${locale}: tooltip opens with the banner title`);
      assert.ok(copy.errorMessage.endsWith(copy.description), `${locale}: tooltip ends with the banner description`);
    }
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
    // Group summaries expose the target; per-call progress is visible on an
    // individual row, not in the group's unmounted collapsed body.
    assert.match(renderToStaticMarkup(createElement(ToolTrow, { items: [sequence] })), />7\/11</);
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
    assert.doesNotMatch(detail, /maka-tool-output-stack/);
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
    assert.equal(outputPanelCount(markup), 1);
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
    assert.equal(outputPanelCount(markup), 1);
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

  it('renders each owned-panel family through one un-nested output surface', () => {
    const cases: Array<{ item: ToolActivityItem; kind: string; text: RegExp; panels?: number }> = [
      {
        item: {
          toolUseId: 'owned-diff',
          toolName: 'apply_patch',
          status: 'completed',
          args: { patch: 'ignored' },
          result: { kind: 'file_diff', paths: ['src/a.ts'], diff: '@@ -1 +1 @@\n-old\n+new' },
        },
        kind: 'file_diff',
        text: /src\/a\.ts/,
      },
      {
        item: {
          toolUseId: 'owned-terminal',
          toolName: 'Bash',
          status: 'completed',
          args: { command: 'npm test' },
          result: {
            kind: 'terminal',
            cwd: '/repo',
            cmd: 'npm test',
            status: 'completed',
            exitCode: 0,
            output: {
              mode: 'pipes',
              stdout: 'terminal-output',
              stderr: '',
              stdoutTruncated: false,
              stderrTruncated: false,
              redacted: false,
            },
          },
        },
        kind: 'terminal',
        text: /terminal-output/,
      },
      {
        item: {
          toolUseId: 'owned-shell-pipes',
          toolName: 'Bash',
          status: 'completed',
          args: { command: 'npm test' },
          result: {
            kind: 'shell_run',
            ref: 'maka://runtime/background-tasks/pipes',
            mode: 'pipes',
            status: 'completed',
            cwd: '/repo',
            cmd: 'npm test',
            startedAt: 1,
            updatedAt: 2,
            completedAt: 2,
            exitCode: 0,
            revision: 1,
            output: {
              mode: 'pipes',
              stdout: 'pipe-output',
              stderr: '',
              stdoutTruncated: false,
              stderrTruncated: false,
              redacted: false,
            },
          },
        },
        kind: 'shell_run',
        text: /pipe-output/,
      },
      {
        item: {
          toolUseId: 'owned-shell-pty',
          toolName: 'Bash',
          status: 'completed',
          args: { command: 'npm test' },
          result: {
            kind: 'shell_run',
            ref: 'maka://runtime/background-tasks/pty',
            mode: 'pty',
            status: 'completed',
            cwd: '/repo',
            cmd: 'npm test',
            startedAt: 1,
            updatedAt: 2,
            completedAt: 2,
            exitCode: 0,
            revision: 1,
            output: {
              mode: 'pty',
              screen: 'pty-output',
              scrollback: '',
              cols: 80,
              rows: 24,
              cursor: { x: 0, y: 0, visible: true },
              alternateScreen: false,
              lastAlternateScreen: '',
              truncated: false,
              redacted: false,
            },
          },
        },
        kind: 'pty-shell',
        text: /pty-output/,
      },
      {
        item: {
          toolUseId: 'owned-web-search',
          toolName: 'web_search',
          status: 'completed',
          args: { query: 'Maka' },
          result: {
            kind: 'web_search',
            provider: 'tavily',
            query: 'Maka',
            rows: [],
          },
        },
        kind: 'web_search',
        text: /Maka/,
        panels: 0,
      },
      {
        item: {
          toolUseId: 'owned-web-search-error',
          toolName: 'web_search',
          status: 'completed',
          args: { query: 'Maka' },
          result: {
            kind: 'web_search_error',
            ok: false,
            provider: 'tavily',
            query: 'Maka',
            reason: 'invalid_credentials',
            message: 'search failed',
          },
        },
        kind: 'web_search_error',
        text: /search failed/,
        panels: 0,
      },
      {
        item: {
          toolUseId: 'owned-rive-workflow',
          toolName: 'rive_workflow',
          status: 'completed',
          args: { action: 'run' },
          result: {
            kind: 'rive_workflow',
            ok: true,
            action: 'run',
            command: [],
            ids: {},
            summary: 'workflow complete',
          },
        },
        kind: 'rive_workflow',
        text: /workflow complete/,
        panels: 0,
      },
    ];

    for (const { item, kind, text, panels } of cases) {
      const markup = renderToStaticMarkup(createElement(ToolCallDetail, { item }));
      assert.match(markup, new RegExp(`data-kind="${kind}"`));
      assert.match(markup, text);
      assert.equal(outputPanelCount(markup), panels ?? 1, `${kind} owns its expected panel count`);
    }
  });

  it('keeps plain JSON in the shared quiet panel', () => {
    const plain = renderToStaticMarkup(createElement(ToolCallDetail, {
      item: {
        toolUseId: 'plain-json',
        toolName: 'ReadMetadata',
        status: 'completed',
        args: { path: '/repo/data.json' },
        result: { kind: 'json', value: { path: '/repo/data.json', content: 'quiet-body' } },
      } satisfies ToolActivityItem,
    }));
    assert.match(plain, /quiet-body/);
    assert.match(plain, /data\.json/);
    assert.doesNotMatch(plain, /data-kind="load_tool"/);
    assert.equal(outputPanelCount(plain), 1);
  });

  it('routes WriteStdin shell results to the PTY control presentation', () => {
    const markup = renderToStaticMarkup(createElement(ToolCallDetail, {
      item: {
        toolUseId: 'write-stdin',
        toolName: 'WriteStdin',
        status: 'completed',
        args: { inputPreview: { text: 'yes', bytes: 4, truncated: false } },
        result: {
          kind: 'shell_run',
          ref: 'maka://runtime/background-tasks/pty-control',
          mode: 'pty',
          status: 'completed',
          cwd: '/repo',
          cmd: 'npm install',
          startedAt: 1,
          updatedAt: 2,
          completedAt: 2,
          revision: 1,
          output: {
            mode: 'pty',
            screen: '',
            scrollback: '',
            cols: 80,
            rows: 24,
            cursor: { x: 0, y: 0, visible: true },
            alternateScreen: false,
            lastAlternateScreen: '',
            truncated: false,
            redacted: false,
          },
          operation: {
            kind: 'pty_control',
            failed: false,
            input: { bytes: 4, queued: true },
          },
        },
      } satisfies ToolActivityItem,
    }));

    assert.match(markup, /yes/);
    assert.match(markup, /已输入/);
    assert.doesNotMatch(markup, /data-kind="pty-shell"/);
  });

  it('renders shared descriptor results and args-only details without inventing panels', () => {
    const cases: Array<{ result: NonNullable<ToolActivityItem['result']>; expected: RegExp }> = [
      { result: { kind: 'text', text: 'plain-text-result' }, expected: /plain-text-result/ },
      { result: { kind: 'file_write', path: '/tmp/out.txt', bytes: 9 }, expected: /已向 \/tmp\/out\.txt 写入 9 字节/ },
      {
        result: { kind: 'future_result' } as unknown as NonNullable<ToolActivityItem['result']>,
        expected: /\[future_result\]/,
      },
    ];
    for (const [index, { result, expected }] of cases.entries()) {
      const markup = renderToStaticMarkup(createElement(ToolCallDetail, {
        item: {
          toolUseId: `descriptor-${index}`,
          toolName: 'CustomTool',
          status: 'completed',
          args: { input: 'ignored while result exists' },
          result,
        } satisfies ToolActivityItem,
      }));
      assert.match(markup, expected);
      assert.equal(outputPanelCount(markup), 1);
    }

    const argsOnly = renderToStaticMarkup(createElement(ToolCallDetail, {
      item: {
        toolUseId: 'args-only',
        toolName: 'todo_write',
        status: 'completed',
        args: {},
      } satisfies ToolActivityItem,
    }));
    assert.match(argsOnly, /language="json"/);
    assert.match(argsOnly, /（空）/);
    assert.equal(outputPanelCount(argsOnly), 1);
  });

  it('switches a shared call from live output to its settled result', () => {
    const item = {
      toolUseId: 'live-shared',
      toolName: 'CustomTool',
      status: 'running',
      args: { query: 'status' },
      outputChunks: [
        { seq: 1, stream: 'stdout', text: 'live-output', redacted: false, createdAt: 1 },
      ],
      result: { kind: 'text', text: 'settled-output' },
    } satisfies ToolActivityItem;

    const observed = renderToStaticMarkup(createElement(ToolCallDetail, {
      item,
      activityObserved: true,
    }));
    assert.match(observed, /data-kind="live_stream"/);
    assert.match(observed, /data-live="true"/);
    assert.match(observed, /live-output/);
    assert.doesNotMatch(observed, /settled-output/);

    const unobserved = renderToStaticMarkup(createElement(ToolCallDetail, {
      item,
      activityObserved: false,
    }));
    assert.doesNotMatch(unobserved, /data-kind="live_stream"/);
    assert.doesNotMatch(unobserved, /live-output/);
    assert.match(unobserved, /settled-output/);
  });

  it('hides permission-denied output but keeps cancelled output visible without a failure banner', () => {
    const permissionDenied = renderToStaticMarkup(createElement(ToolCallDetail, {
      item: {
        toolUseId: 'permission-denied',
        toolName: 'Read',
        status: 'errored',
        args: { path: '/private/data' },
        result: { kind: 'text', text: 'User denied permission request' },
      } satisfies ToolActivityItem,
    }));
    assert.doesNotMatch(permissionDenied, /private\/data|用户已拒绝权限请求|User denied permission/);
    assert.equal(outputPanelCount(permissionDenied), 0);

    const cancelledItem = {
      toolUseId: 'cancelled-terminal',
      toolName: 'Bash',
      status: 'errored',
      args: { command: 'sleep 10' },
      result: {
        kind: 'terminal',
        cwd: '/repo',
        cmd: 'sleep 10',
        status: 'cancelled',
        output: {
          mode: 'pipes',
          stdout: 'partial-output',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
      },
    } satisfies ToolActivityItem;
    const detail = renderToStaticMarkup(createElement(ToolCallDetail, { item: cancelledItem }));
    assert.match(detail, /partial-output/);
    assert.match(detail, /已取消/);
    assert.doesNotMatch(detail, /maka-sandbox-blocked-banner/);
  });

  it('lets sandbox-blocked output coexist with its banner', () => {
    const sandboxBlocked = renderToStaticMarkup(createElement(ToolCallDetail, {
      item: {
        toolUseId: 'sandbox-blocked',
        toolName: 'Bash',
        status: 'errored',
        args: { command: 'cat /private/data' },
        result: {
          kind: 'terminal',
          cwd: '/repo',
          cmd: 'cat /private/data',
          status: 'failed',
          exitCode: 1,
          failureMessage: 'operation not permitted',
          sandboxDenial: { likely: true, backend: 'macos-seatbelt' },
          output: {
            mode: 'pipes',
            stdout: '',
            stderr: 'blocked-output',
            stdoutTruncated: false,
            stderrTruncated: false,
            redacted: false,
          },
        },
      } satisfies ToolActivityItem,
    }));
    assert.match(sandboxBlocked, /maka-sandbox-blocked-banner/);
    assert.match(sandboxBlocked, /blocked-output/);
    assert.equal(outputPanelCount(sandboxBlocked), 1);
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

it('uses WorkHub status once in the collapsed row and retains arguments in details', () => {
  for (const args of [{ args: { status: '正在打开扩展', request: { operation: 'observe' } } }, { argsPreview: { status: '正在打开扩展' } }]) {
    const item: ToolActivityItem = { toolUseId: 'workhub-control', toolName: 'mcp__desktop_workhub__control', status: 'running', args: undefined, ...args };
    const row = renderToStaticMarkup(createElement(ToolTrow, { items: [item] }));
    assert.match(row, /正在打开扩展/);
    assert.doesNotMatch(row, /status:|request:/);
    const detail = renderToStaticMarkup(createElement(ToolCallDetail, { item }));
    assert.match(detail, /status/);
  }
});
