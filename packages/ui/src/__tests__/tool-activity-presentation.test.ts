import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup as renderReactToStaticMarkup } from 'react-dom/server';
import type { StoredMessage, ToolResultContent } from '@maka/core';
import { ToolActivity, ToolTrow } from '../tool-activity.js';
import { ToolResultPreview } from '../tool-activity/tool-result-preview.js';
import {
  createToolDisclosureState,
  deriveToolActivityPresentation as derivePresentation,
  setToolDisclosureOpen,
  syncToolDisclosureState,
} from '../tool-activity/presentation.js';
import { materializeTools, type ToolActivityItem } from '../materialize.js';
import { LocaleProvider } from '../locale-context.js';

function renderToStaticMarkup(node: ReactNode): string {
  return renderReactToStaticMarkup(createElement(LocaleProvider, {
    locale: 'zh',
    children: node,
  }));
}

function deriveToolActivityPresentation(item: ToolActivityItem) {
  return derivePresentation(item, 'zh');
}

function renderTool(item: ToolActivityItem): string {
  return renderToStaticMarkup(createElement(ToolTrow, { items: [item] }));
}

describe('tool activity presentation', () => {
  it('prefers a declared semantic kind over the legacy tool-name fallback', () => {
    const item: ToolActivityItem = {
      toolUseId: 'tool-kind',
      toolName: 'Read',
      activityKind: 'command',
      status: 'running',
      args: {},
    };

    assert.equal(deriveToolActivityPresentation(item).kind, 'command');
  });

  it('materializes a persisted activity kind for replay', () => {
    const messages: StoredMessage[] = [{
      type: 'tool_call',
      id: 'tool-replay',
      turnId: 'turn-replay',
      ts: 1,
      toolName: 'CustomPatch',
      activityKind: 'edit',
      args: {},
    }];

    assert.equal(materializeTools(messages)[0]?.activityKind, 'edit');
  });

  it('keeps a running command detail collapsed by default', () => {
    const markup = renderTool({
      toolUseId: 'tool-running',
      toolName: 'Bash',
      intent: '检查当前项目结构',
      status: 'running',
      args: { command: 'Get-ChildItem -Recurse -Depth 1' },
      outputChunks: [
        { seq: 1, stream: 'stdout', text: 'packages\n', redacted: false, createdAt: 1 },
      ],
    });

    assert.doesNotMatch(markup, /Get-ChildItem/);
    assert.doesNotMatch(markup, /实时输出/);
    assert.match(markup, /检查当前项目结构/);
  });

  it('preserves a manual expansion across ordinary status changes', () => {
    const running: ToolActivityItem = {
      toolUseId: 'tool-manual',
      toolName: 'Bash',
      status: 'running',
      args: { command: 'npm test' },
    };
    const completed: ToolActivityItem = {
      ...running,
      status: 'completed',
    };
    const initial = createToolDisclosureState(deriveToolActivityPresentation(running));
    const expanded = setToolDisclosureOpen(initial, true);

    assert.deepEqual(
      syncToolDisclosureState(expanded, deriveToolActivityPresentation(completed)),
      { open: true, manuallySet: true },
    );
  });

  it('preserves a manual expansion through a permission attention cycle', () => {
    const running: ToolActivityItem = {
      toolUseId: 'tool-permission',
      toolName: 'Bash',
      status: 'running',
      args: { command: 'npm test' },
    };
    const waiting: ToolActivityItem = {
      ...running,
      status: 'waiting_permission',
    };
    const expanded = setToolDisclosureOpen(
      createToolDisclosureState(deriveToolActivityPresentation(running)),
      true,
    );
    const duringPermission = syncToolDisclosureState(
      expanded,
      deriveToolActivityPresentation(waiting),
    );

    assert.deepEqual(
      syncToolDisclosureState(duringPermission, deriveToolActivityPresentation(running)),
      { open: true, manuallySet: true },
    );
  });

  it('keeps a tool collapsed when it errors, even after an earlier manual collapse', () => {
    const running: ToolActivityItem = {
      toolUseId: 'tool-error',
      toolName: 'Bash',
      status: 'running',
      args: { command: 'npm test' },
    };
    const errored: ToolActivityItem = {
      ...running,
      status: 'errored',
    };

    // An error is not an attention state: the initial disclosure stays closed…
    assert.deepEqual(
      createToolDisclosureState(deriveToolActivityPresentation(errored)),
      { open: false, manuallySet: false },
    );

    // …and an earlier manual collapse is not overridden when the tool errors.
    const collapsed = setToolDisclosureOpen(
      createToolDisclosureState(deriveToolActivityPresentation(running)),
      false,
    );
    assert.deepEqual(
      syncToolDisclosureState(collapsed, deriveToolActivityPresentation(errored)),
      { open: false, manuallySet: true },
    );
  });

  it('keeps a settled errored tool collapsed while the summary carries the failure signal', () => {
    const markup = renderTool({
      toolUseId: 'tool-errored-collapsed',
      toolName: 'Bash',
      activityKind: 'command',
      intent: '跑测试',
      status: 'errored',
      args: { command: 'npm test' },
      result: {
        kind: 'terminal',
        cwd: '/tmp/maka',
        cmd: 'npm test',
        status: 'failed',
        exitCode: 1,
        output: pipeOutput('', 'Error: boom\n'),
      },
    });

    // Collapsed: the diagnostic body is not mounted…
    assert.doesNotMatch(markup, /Error: boom/);
    // …but the failure stays visible on the summary line.
    assert.match(markup, /1 个失败/);
  });

  it('presents a command sandbox denial as blocked instead of failed', () => {
    const item: ToolActivityItem = {
      toolUseId: 'tool-sandbox-blocked',
      toolName: 'Bash',
      activityKind: 'command',
      intent: '写入工作区外文件',
      status: 'errored',
      args: { command: 'printf blocked > ../outside.txt' },
      result: {
        kind: 'terminal',
        cwd: '/tmp/maka',
        cmd: 'printf blocked > ../outside.txt',
        status: 'failed',
        exitCode: 1,
        output: pipeOutput('', 'Operation not permitted\n'),
        sandboxDenial: {
          likely: true,
          backend: 'macos-seatbelt',
          recovery: 'require_escalated',
        },
      },
    };

    const collapsed = renderTool(item);
    assert.match(collapsed, /1 个可能被沙箱阻止/);
    assert.doesNotMatch(collapsed, /1 个失败/);

    const expanded = renderToStaticMarkup(createElement(ToolActivity, {
      items: [item],
      open: true,
    }));
    assert.match(expanded, /可能被沙箱阻止/);
    assert.match(expanded, /操作可能被沙箱阻止/);
    assert.match(expanded, /失败前可能已经产生部分结果/);
    assert.doesNotMatch(expanded, /因此未执行/);
    assert.doesNotMatch(expanded, /工具调用失败/);
  });

  it('presents a filesystem worker sandbox denial as blocked instead of failed', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-filesystem-sandbox-blocked',
        toolName: 'Grep',
        activityKind: 'search',
        intent: '搜索文件',
        status: 'errored',
        args: { pattern: 'needle', path: '/workspace' },
        result: {
          kind: 'text',
          text: 'Filesystem access was denied.',
          sandboxDenial: {
            likely: true,
            backend: 'macos-seatbelt',
          },
        },
      } satisfies ToolActivityItem],
      open: true,
    }));

    assert.match(markup, /可能被沙箱阻止/);
    assert.match(markup, /操作可能被沙箱阻止/);
    assert.match(markup, /Filesystem access was denied/);
    assert.doesNotMatch(markup, /工具调用失败/);
  });

  it('keeps an ordinary filesystem permission error in the generic failure state', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-filesystem-denied',
        toolName: 'Read',
        activityKind: 'read',
        intent: '读取受限文件',
        status: 'errored',
        args: { path: '/workspace/private.txt' },
        result: {
          kind: 'text',
          text: 'Filesystem access was denied.',
        },
      } satisfies ToolActivityItem],
      open: true,
    }));

    assert.match(markup, /工具调用失败/);
    assert.doesNotMatch(markup, /可能被沙箱阻止/);
  });

  it('shows diagnostic flags without exposing transport chunk counts', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-output',
        toolName: 'Bash',
        status: 'errored',
        args: { command: 'npm test' },
        outputChunks: [
          { seq: 1, stream: 'stdout', text: 'one\n', redacted: false, createdAt: 1 },
          { seq: 2, stream: 'stdout', text: 'two\n', redacted: true, createdAt: 2 },
          { seq: 3, stream: 'stderr', text: 'failed\n', redacted: false, createdAt: 3 },
        ],
        outputTruncated: true,
      } satisfies ToolActivityItem],
      open: true,
    }));

    assert.doesNotMatch(markup, /stdout\s+2/i);
    assert.doesNotMatch(markup, /stderr\s+1/i);
    // Body still carries the failed stream text; no transport counts.
    assert.match(markup, /failed/);
    assert.match(markup, /已脱敏/);
    assert.match(markup, /已截断|输出已截断/);
  });

  it('renders expanded terminal output as one quiet panel without diagnostic chrome', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-terminal-panel',
        toolName: 'Bash',
        intent: '跑测试',
        status: 'errored',
        args: { command: 'npm run -w @maka/ui test' },
        result: {
          kind: 'terminal',
          cwd: '/tmp/maka',
          cmd: 'npm run -w @maka/ui test',
          status: 'failed',
          exitCode: 1,
          output: pipeOutput('packages/ui ok\n', 'Error: boom\n'),
        },
      } satisfies ToolActivityItem],
      open: true,
    }));

    // Command without shell prompt; no cwd / success-style exit badge bar.
    assert.match(markup, /npm run -w @maka\/ui test/);
    assert.doesNotMatch(markup, /\$\s*npm run -w @maka\/ui test/);
    assert.doesNotMatch(markup, /\/tmp\/maka/);
    assert.doesNotMatch(markup, /实时输出/);
    // Failure note, not a permanent exit-code chrome row for successes.
    assert.match(markup, /失败 · 退出码 1|失败.*退出码 1/);
    assert.match(markup, /Error: boom/);
    // Unified panel surface (Codex-like well).
    assert.match(markup, /bg-\[var\(--foreground-3\)\]|data-slot="tool-output"/);
    // Tool output body uses base 13px, not caption 11px.
    assert.match(markup, /font-size-base/);
    // No always-on copy control on the output well (error banner may still copy).
    assert.doesNotMatch(markup, /复制研读提示/);
  });

  it('contains a malformed persisted terminal result instead of crashing the renderer', () => {
    const malformed = {
      kind: 'terminal',
      cwd: '/tmp/maka',
      cmd: 'npm test',
      status: 'failed',
      exitCode: 1,
    } as unknown as NonNullable<ToolActivityItem['result']>;
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-malformed-terminal',
        toolName: 'Bash',
        status: 'errored',
        args: { command: 'npm test' },
        result: malformed,
      } satisfies ToolActivityItem],
      open: true,
    }));

    assert.match(markup, /npm test/);
    assert.match(markup, /终端输出不可用/);
    assert.match(markup, /失败 · 退出码 1|失败.*退出码 1/);
  });

  it('keeps live tool output in the same quiet panel language when open', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-live-panel',
        toolName: 'Bash',
        intent: '检查结构',
        status: 'waiting_permission',
        args: { command: 'Get-ChildItem -Depth 1' },
        outputChunks: [
          { seq: 1, stream: 'stdout', text: 'packages\n', redacted: false, createdAt: 1 },
        ],
        outputTruncated: true,
      } satisfies ToolActivityItem],
    }));

    assert.match(markup, /Get-ChildItem -Depth 1/);
    assert.doesNotMatch(markup, /\$\s*Get-ChildItem/);
    assert.doesNotMatch(markup, /实时输出/);
    assert.match(markup, /packages/);
    assert.match(markup, /已截断|输出已截断/);
    assert.match(markup, /bg-\[var\(--foreground-3\)\]|data-slot="tool-output"/);
    assert.match(markup, /max-h-64/);
  });

  it('renders Read as path + file text, not tool-call/result JSON', () => {
    // waiting_permission opens the panel without the error banner (which would
    // otherwise stringify the JSON result for copy).
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-read',
        toolName: 'Read',
        activityKind: 'read',
        intent: '读取 tool-runtime',
        status: 'waiting_permission',
        args: { path: 'packages/runtime/src/tool-runtime.ts', limit: 100 },
        result: {
          kind: 'json',
          value: {
            content: 'import type {\n  SessionEvent,\n  ToolOutputStream,\n} from \'@maka/core/events\';\n',
          },
        },
      } satisfies ToolActivityItem],
    }));

    assert.match(markup, /packages\/runtime\/src\/tool-runtime\.ts/);
    assert.match(markup, /SessionEvent/);
    assert.match(markup, /ToolOutputStream/);
    assert.doesNotMatch(markup, /&quot;path&quot;\s*:|"path"\s*:/);
    assert.doesNotMatch(markup, /&quot;limit&quot;\s*:|"limit"\s*:/);
    assert.doesNotMatch(markup, /&quot;content&quot;\s*:|"content"\s*:/);
    assert.doesNotMatch(markup, /import type \{\\n/);
  });

  it('renders Grep as pattern + match lines, not raw JSON', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-grep',
        toolName: 'Grep',
        activityKind: 'search',
        intent: '搜索 ToolOutputStream',
        status: 'waiting_permission',
        args: { pattern: 'ToolOutputStream', path: 'packages/ui/src' },
        result: {
          kind: 'json',
          value: {
            matches: [
              'packages/ui/src/tool-activity.tsx:10:function ToolOutputStream',
              'packages/ui/src/tool-activity.tsx:20:  chunks',
            ],
          },
        },
      } satisfies ToolActivityItem],
    }));

    assert.match(markup, /ToolOutputStream/);
    assert.match(markup, /packages\/ui\/src\/tool-activity\.tsx:10/);
    assert.doesNotMatch(markup, /&quot;pattern&quot;\s*:|"pattern"\s*:/);
    assert.doesNotMatch(markup, /&quot;matches&quot;\s*:|"matches"\s*:/);
  });

  it('never dumps pretty JSON for an arbitrary tool result object', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-custom',
        toolName: 'CustomInspect',
        status: 'waiting_permission',
        args: { target: 'packages/ui', depth: 2 },
        result: {
          kind: 'json',
          value: {
            ok: true,
            notes: 'looks fine',
            detail: 'line one\nline two',
          },
        },
      } satisfies ToolActivityItem],
    }));

    assert.match(markup, /packages\/ui|target: packages\/ui/);
    assert.match(markup, /looks fine|notes:/);
    assert.match(markup, /line one/);
    assert.doesNotMatch(markup, /\{\s*&quot;ok&quot;/);
    assert.doesNotMatch(markup, /line one\\nline two/);
  });

  it('redacts credential-bearing property names in quiet key/value output', () => {
    const secret = 'sk-1234567890abcdefghi';
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-secret-key',
        toolName: 'CustomInspect',
        status: 'waiting_permission',
        args: { [`api_key=${secret}`]: true },
        result: {
          kind: 'json',
          value: { nested: { [`token=${secret}`]: 'ok' } },
        },
      } satisfies ToolActivityItem],
    }));

    assert.doesNotMatch(markup, new RegExp(secret));
    assert.match(markup, /redacted|api_key|&lt;redacted&gt;|ok/i);
  });

  it('redacts short secrets under sensitive keys like password', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-password',
        toolName: 'CustomInspect',
        status: 'waiting_permission',
        args: { password: 'correct-horse' },
        result: {
          kind: 'json',
          value: { token: 'short-secret', ok: true },
        },
      } satisfies ToolActivityItem],
    }));

    assert.doesNotMatch(markup, /correct-horse/);
    assert.doesNotMatch(markup, /short-secret/);
    assert.match(markup, /redacted|password|token/i);
  });

  it('redacts secrets embedded in property names', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-password-key',
        toolName: 'CustomInspect',
        status: 'waiting_permission',
        args: { 'password=correct-horse': true },
        result: { kind: 'json', value: { ok: true } },
      } satisfies ToolActivityItem],
    }));

    assert.doesNotMatch(markup, /correct-horse/);
    assert.match(markup, /password=&lt;redacted&gt;|password=&lt;redacted&gt;|password=&lt;redacted&gt;|password=<redacted>|redacted/i);
  });

  it('redacts secrets in keys that use colon or space separators', () => {
    for (const key of [
      'password: correct-horse',
      'password correct-horse',
      'token: short-secret',
      'Authorization: Bearer SENTINEL_TOKEN',
      'password: correct horse',
      // Multi-word key names + bare auth= payloads
      'api key: correct horse',
      'private key: gamma delta',
      'auth=correct horse',
      'auth: short secret',
      'access token: alpha beta',
    ]) {
      const markup = renderToStaticMarkup(createElement(ToolActivity, {
        items: [{
          toolUseId: `tool-key-${key}`,
          toolName: 'CustomInspect',
          status: 'waiting_permission',
          args: { [key]: true },
          result: { kind: 'json', value: { ok: true } },
        } satisfies ToolActivityItem],
      }));
      assert.doesNotMatch(
        markup,
        /correct-horse|short-secret|SENTINEL_TOKEN|\bhorse\b|gamma|delta|alpha|beta/,
      );
      assert.match(markup, /redacted/i);
    }
  });

  it('keeps error diagnostics when a list field is also present', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-mixed',
        toolName: 'CustomInspect',
        status: 'errored',
        args: {},
        result: {
          kind: 'json',
          value: { results: [], error: 'permission denied', ok: false },
        },
      } satisfies ToolActivityItem],
      open: true,
    }));

    assert.match(markup, /permission denied/);
    assert.match(markup, /ok:\s*false|未完成|false/);
  });

  it('keeps the Write path when args and result headlines match', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-write',
        toolName: 'Write',
        activityKind: 'edit',
        status: 'waiting_permission',
        args: { path: 'packages/ui/src/secret.ts', content: 'x' },
        result: {
          kind: 'json',
          value: { ok: true, path: 'packages/ui/src/secret.ts', bytes: 1 },
        },
      } satisfies ToolActivityItem],
    }));

    assert.match(markup, /packages\/ui\/src\/secret\.ts/);
    assert.match(markup, /已完成|1 B/);
  });

  it('renders shell_run with command, status, and captured output', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-shell-run',
        toolName: 'Bash',
        activityKind: 'command',
        status: 'waiting_permission',
        args: { command: 'npm test' },
        result: {
          kind: 'shell_run',
          ref: 'maka://runtime/background-tasks/bg-1',
          mode: 'pipes',
          status: 'running',
          cwd: '/repo',
          cmd: 'npm test',
          startedAt: 1,
          updatedAt: 2,
          revision: 2,
          output: pipeOutput('starting\n'),
        },
      } satisfies ToolActivityItem],
    }));

    assert.match(markup, /npm test/);
    assert.match(markup, /后台运行中|background-tasks/);
    assert.match(markup, /starting/);
    assert.doesNotMatch(markup, /\[shell_run\]/);
    // One quiet well only — not nested shared + shell_run panels.
    const panels = markup.match(/data-slot="tool-output"/g) ?? [];
    assert.equal(panels.length, 1);
    const commands = markup.match(/npm test/g) ?? [];
    assert.equal(commands.length, 1);
  });

  it('renders PTY output in one unwrapped surface without the generic line cap', () => {
    const scrollback = Array.from({ length: 500 }, (_, index) => `scroll-${index + 1}`).join('\n');
    const screen = Array.from({ length: 24 }, (_, index) => `screen-${index + 1}`).join('\n');
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-pty-run',
        toolName: 'Bash',
        activityKind: 'command',
        status: 'waiting_permission',
        args: { command: 'interactive', pty: true },
        result: {
          kind: 'shell_run',
          ref: 'maka://runtime/background-tasks/pty-1',
          mode: 'pty',
          status: 'running',
          cwd: '/repo',
          cmd: 'interactive',
          startedAt: 1,
          updatedAt: 2,
          revision: 2,
          output: {
            mode: 'pty',
            screen,
            scrollback,
            lastAlternateScreen: 'STALE-ALTERNATE-FRAME',
            cols: 80,
            rows: 24,
            cursor: { x: 0, y: 23, visible: true },
            alternateScreen: false,
            truncated: false,
            redacted: false,
          },
        },
      } satisfies ToolActivityItem],
    }));

    assert.equal((markup.match(/data-stream="pty"/g) ?? []).length, 1);
    assert.equal((markup.match(/data-slot="tool-output"/g) ?? []).length, 1);
    assert.match(markup, /data-kind="pty-shell"/);
    assert.match(markup, />Shell</);
    assert.match(markup, /\$ interactive/);
    assert.match(markup, />运行中</);
    assert.doesNotMatch(markup, /80×24/);
    assert.match(markup, /scroll-1/);
    assert.match(markup, /scroll-250/);
    assert.match(markup, /screen-24/);
    assert.doesNotMatch(markup, /STALE-ALTERNATE-FRAME|已隐藏 \d+ 行/);
    assert.match(markup, /white-space:pre/);
  });

  it('labels a running inherited PTY by source-session ownership', () => {
    const markup = renderToStaticMarkup(createElement(ToolResultPreview, {
      toolName: 'Bash',
      shellRunSource: 'owned',
      content: {
        kind: 'shell_run',
        ref: 'maka://runtime/background-tasks/pty-branch',
        mode: 'pty',
        status: 'running',
        cwd: '/repo',
        cmd: 'interactive',
        startedAt: 1,
        updatedAt: 2,
        revision: 2,
        output: {
          mode: 'pty',
          screen: 'ready',
          scrollback: '',
          cols: 80,
          rows: 24,
          cursor: { x: 5, y: 0, visible: true },
          alternateScreen: false,
          truncated: false,
          redacted: false,
        },
      },
    }));

    assert.match(markup, /由源会话管理/);
    assert.doesNotMatch(markup, />运行中</);

    const unavailableMarkup = renderToStaticMarkup(createElement(ToolResultPreview, {
      toolName: 'Bash',
      shellRunSource: 'unavailable',
      content: {
        kind: 'shell_run',
        ref: 'maka://runtime/background-tasks/pty-branch',
        mode: 'pty',
        status: 'running',
        cwd: '/repo',
        cmd: 'interactive',
        startedAt: 1,
        updatedAt: 2,
        revision: 2,
      },
    }));
    assert.match(unavailableMarkup, /源会话不可用/);
    assert.doesNotMatch(unavailableMarkup, />运行中</);
  });

  it('renders a failed WriteStdin as operation metadata without its ShellRun panel', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-pty-control',
        toolName: 'WriteStdin',
        activityKind: 'command',
        status: 'errored',
        args: {
          ref: 'maka://runtime/background-tasks/pty-1',
          inputPreview: { text: 'echo x\\n', bytes: 7, truncated: false },
          size: { cols: 100, rows: 30 },
        },
        result: {
          kind: 'shell_run',
          ref: 'maka://runtime/background-tasks/pty-1',
          mode: 'pty',
          status: 'failed',
          cwd: '/PRIVATE-CWD',
          cmd: 'PRIVATE-COMMAND',
          startedAt: 1,
          updatedAt: 2,
          completedAt: 2,
          failureMessage: 'PRIVATE-FAILURE',
          revision: 2,
          output: {
            mode: 'pty',
            screen: 'PRIVATE-TERMINAL-FRAME',
            scrollback: '',
            cols: 100,
            rows: 30,
            cursor: { x: 0, y: 0, visible: true },
            alternateScreen: false,
            truncated: false,
            redacted: false,
          },
          operation: {
            kind: 'pty_control',
            failed: true,
            input: { bytes: 7, queued: false },
            resize: { cols: 100, rows: 30, applied: true, changed: true },
          },
        },
      } satisfies ToolActivityItem],
      open: true,
    }));

    assert.match(markup, /未排队：echo x\\n/);
    assert.match(markup, /已调整为 100x30/);
    assert.match(markup, /后台终端交互失败/);
    assert.doesNotMatch(markup, /PRIVATE-CWD|PRIVATE-COMMAND|PRIVATE-FAILURE|PRIVATE-TERMINAL-FRAME/);
    assert.equal((markup.match(/data-slot="tool-output"/g) ?? []).length, 0);
  });

  it('renders useful WriteStdin input while suppressing a repeated no-op size', () => {
    const args = {
      ref: 'maka://runtime/background-tasks/pty-1',
      inputPreview: { text: 'echo hello\\n', bytes: 11, truncated: false },
      size: { cols: 80, rows: 24 },
    };
    const content = {
      kind: 'shell_run',
      ref: 'maka://runtime/background-tasks/pty-1',
      mode: 'pty',
      status: 'running',
      cwd: '/workspace',
      cmd: 'bash',
      startedAt: 1,
      updatedAt: 2,
      revision: 2,
      output: {
        mode: 'pty',
        screen: '$ ',
        scrollback: '',
        cols: 80,
        rows: 24,
        cursor: { x: 2, y: 0, visible: true },
        alternateScreen: false,
        truncated: false,
        redacted: false,
      },
      operation: {
        kind: 'pty_control',
        failed: false,
        input: { bytes: 11, queued: true },
        resize: { cols: 80, rows: 24, applied: true, changed: false },
      },
    } satisfies ToolResultContent;
    const markup = renderToStaticMarkup(createElement(ToolResultPreview, {
      content,
      toolName: 'WriteStdin',
      args,
    }));

    assert.match(markup, /已排队：echo hello\\n/);
    assert.doesNotMatch(markup, /11 字节|80x24|已调整/);
  });

  it('keeps pre-handoff live output when shell_run lands with empty streams', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-shell-run-empty',
        toolName: 'Bash',
        activityKind: 'command',
        status: 'waiting_permission',
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
      } satisfies ToolActivityItem],
    }));

    assert.match(markup, /starting-live-output/);
    assert.match(markup, /已脱敏/);
    assert.match(markup, /输出已截断/);
    assert.doesNotMatch(markup, /尚无输出/);
    const panels = markup.match(/data-slot="tool-output"/g) ?? [];
    assert.equal(panels.length, 1);
  });

  it('keeps redacted/truncated meta when live chunks are empty bodies', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-shell-run-empty-meta',
        toolName: 'Bash',
        activityKind: 'command',
        status: 'waiting_permission',
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
      } satisfies ToolActivityItem],
    }));

    assert.match(markup, /已脱敏/);
    assert.match(markup, /输出已截断/);
    const panels = markup.match(/data-slot="tool-output"/g) ?? [];
    assert.equal(panels.length, 1);
  });

  it('does not wrap subagent preview in an outer quiet panel', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-subagent',
        toolName: 'Subagent',
        status: 'waiting_permission',
        args: {},
        result: {
          kind: 'subagent',
          agentName: 'Review Agent',
          turnId: 'turn',
          status: 'completed',
          permissionMode: 'ask',
          summary: 'done',
          artifactIds: [],
          startedAt: 1,
          durationMs: 1,
        },
      } satisfies ToolActivityItem],
    }));
    assert.match(markup, /data-kind="subagent"/);
    // Subagent owns its surface — no outer tool-output well wrapping it.
    assert.equal((markup.match(/data-slot="tool-output"/g) ?? []).length, 0);
  });

  it('renders a bounded localized swarm card and maps aggregate cancellation to the activity label', () => {
    const longSummary = 'x'.repeat(600);
    const item = {
      toolUseId: 'tool-agent-swarm',
      toolName: 'agent_swarm',
      displayName: 'Agent Swarm',
      status: 'interrupted',
      args: {},
      result: {
        kind: 'agent_swarm',
        status: 'cancelled',
        items: [
          {
            itemId: 'auth',
            index: 0,
            profile: 'local_read',
            started: true,
            turnId: 'turn-auth',
            runId: 'run-auth',
            resumedFromRunId: 'run-auth-source',
            status: 'completed',
            summary: longSummary,
            artifactIds: ['artifact-auth'],
            durationMs: 1250,
          },
          {
            itemId: 'tests',
            index: 1,
            profile: 'local_read',
            started: false,
            status: 'cancelled',
            summary: 'Cancelled before start.',
            artifactIds: [],
            failureClass: 'ParentCancelled',
          },
        ],
        startedAt: 1,
        completedAt: 1251,
        durationMs: 1250,
      },
    } satisfies ToolActivityItem;
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      open: true,
      items: [item],
    }));
    const enMarkup = renderReactToStaticMarkup(createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(ToolActivity, { open: true, items: [item] }),
    }));

    assert.match(markup, /data-kind="agent_swarm"/);
    assert.match(markup, /Agent Swarm/);
    assert.match(markup, /2 个任务/);
    assert.match(markup, /1 完成/);
    assert.match(markup, /1 取消/);
    assert.match(markup, /run run-auth/);
    assert.match(markup, /turn turn-auth/);
    assert.match(markup, /resumed from run-auth-source/);
    assert.match(markup, /ParentCancelled/);
    assert.match(markup, />已取消</);
    assert.doesNotMatch(markup, /x{300}/);
    assert.equal((markup.match(/data-slot="tool-output"/g) ?? []).length, 0);
    assert.match(enMarkup, /2 tasks/);
    assert.match(enMarkup, /1 completed/);
    assert.match(enMarkup, /1 cancelled/);
    assert.match(enMarkup, /Duration 1\.3s/);
    assert.doesNotMatch(enMarkup, /个任务|完成|取消|耗时|产物|另有/);
  });

  it('surfaces terminal cancel and runtime truncation flags', () => {
    const cancelled = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-cancel',
        toolName: 'Bash',
        status: 'interrupted',
        args: { command: 'sleep 99' },
        result: {
          kind: 'terminal',
          cwd: '/repo',
          cmd: 'sleep 99',
          status: 'cancelled',
          exitCode: 130,
          output: pipeOutput(),
        },
      } satisfies ToolActivityItem],
    }));
    assert.match(cancelled, /已取消/);
    assert.doesNotMatch(cancelled, /失败 · 退出码 130/);
    assert.doesNotMatch(cancelled, /工具调用失败/);
    // Outer status must not say 失败 either.
    assert.doesNotMatch(cancelled, />失败</);

    const cancelledTrow = renderToStaticMarkup(createElement(ToolTrow, {
      items: [{
        toolUseId: 'tool-cancel-trow',
        toolName: 'Bash',
        activityKind: 'command',
        status: 'interrupted',
        args: { command: 'sleep 99' },
        result: {
          kind: 'terminal',
          cwd: '/repo',
          cmd: 'sleep 99',
          status: 'cancelled',
          exitCode: 130,
          output: pipeOutput(),
        },
      } satisfies ToolActivityItem],
    }));
    assert.match(cancelledTrow, /运行 1 条命令/);
    assert.doesNotMatch(cancelledTrow, /1 个失败/);

    const truncated = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-trunc',
        toolName: 'Bash',
        status: 'waiting_permission',
        args: { command: 'run' },
        result: {
          kind: 'terminal',
          cwd: '/repo',
          cmd: 'run',
          status: 'completed',
          exitCode: 0,
          output: { ...pipeOutput('tail only'), stdoutTruncated: true },
        },
      } satisfies ToolActivityItem],
    }));
    assert.match(truncated, /tail only/);
    assert.match(truncated, /输出已截断/);
  });
});

function pipeOutput(stdout = '', stderr = '') {
  return {
    mode: 'pipes' as const,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    redacted: false,
  };
}
