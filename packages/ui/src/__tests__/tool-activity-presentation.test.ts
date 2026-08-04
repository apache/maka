import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup as renderReactToStaticMarkup } from 'react-dom/server';
import { ToolCallDetail, ToolTrow } from '../tool-activity.js';
import { ToolResultPreview } from '../tool-activity/tool-result-preview.js';
import type { ToolActivityItem } from '../materialize.js';
import { LocaleProvider } from '../locale-context.js';

function renderToStaticMarkup(node: ReactNode): string {
  return renderReactToStaticMarkup(createElement(LocaleProvider, {
    locale: 'zh',
    children: node,
  }));
}

/** The collapsed row. Astryx owns its expansion, so detail asserts use ToolCallDetail. */
function renderTool(item: ToolActivityItem): string {
  return renderToStaticMarkup(createElement(ToolTrow, { items: [item] }));
}

describe('tool activity presentation', () => {
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

    // The row says "blocked", never "failed"; the raw stderr stays available to
    // assistive tech via Astryx's errorMessage but is not the visible word.
    const collapsed = renderTool(item);
    assert.match(collapsed, /可能被沙箱阻止/);
    assert.doesNotMatch(collapsed, /失败/);

    const expanded = renderToStaticMarkup(createElement(ToolCallDetail, { item }));
    assert.match(expanded, /可能被沙箱阻止/);
    assert.match(expanded, /操作可能被沙箱阻止/);
    assert.match(expanded, /失败前可能已经产生部分结果/);
    assert.doesNotMatch(expanded, /因此未执行/);
    assert.doesNotMatch(expanded, /工具调用失败/);
  });

  it('keeps an ordinary filesystem permission error as Astryx error detail, not a sandbox block', () => {
    const markup = renderToStaticMarkup(createElement(ToolCallDetail, {
      item: {
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
      } satisfies ToolActivityItem,
    }));

    assert.match(markup, /astryx-codeblock/);
    assert.match(markup, /Filesystem access was denied/);
    assert.doesNotMatch(markup, /工具调用失败/);
    assert.doesNotMatch(markup, /可能被沙箱阻止/);
  });

  it('shows diagnostic flags without exposing transport chunk counts', () => {
    const markup = renderToStaticMarkup(createElement(ToolCallDetail, {
      item: {
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
      } satisfies ToolActivityItem,
    }));

    assert.doesNotMatch(markup, /stdout\s+2/i);
    assert.doesNotMatch(markup, /stderr\s+1/i);
    // Body still carries the failed stream text; no transport counts.
    assert.match(markup, /failed/);
    assert.match(markup, /已脱敏/);
    assert.match(markup, /已截断|输出已截断/);
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

  it('never dumps pretty JSON for an arbitrary tool result object', () => {
    const markup = renderToStaticMarkup(createElement(ToolCallDetail, {
      item: {
        toolUseId: 'tool-custom',
        toolName: 'CustomInspect',
        status: 'running',
        args: { target: 'packages/ui', depth: 2 },
        result: {
          kind: 'json',
          value: {
            ok: true,
            notes: 'looks fine',
            detail: 'line one\nline two',
          },
        },
      } satisfies ToolActivityItem,
    }));

    assert.match(markup, /packages\/ui|target: packages\/ui/);
    assert.match(markup, /looks fine|notes:/);
    assert.match(markup, /line one/);
    assert.doesNotMatch(markup, /\{\s*&quot;ok&quot;/);
    assert.doesNotMatch(markup, /line one\\nline two/);
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

  it('keeps error diagnostics when a list field is also present', () => {
    const markup = renderToStaticMarkup(createElement(ToolCallDetail, {
      item: {
        toolUseId: 'tool-mixed',
        toolName: 'CustomInspect',
        status: 'errored',
        args: {},
        result: {
          kind: 'json',
          value: { results: [], error: 'permission denied', ok: false },
        },
      } satisfies ToolActivityItem,
    }));

    assert.match(markup, /permission denied/);
    assert.match(markup, /ok:\s*false|未完成|false/);
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
    const markup = renderToStaticMarkup(createElement(ToolCallDetail, {
      item: {
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
      } satisfies ToolActivityItem,
    }));

    assert.match(markup, /未排队：echo x\\n/);
    assert.match(markup, /已调整为 100x30/);
    assert.match(markup, /后台终端交互失败/);
    assert.doesNotMatch(markup, /PRIVATE-CWD|PRIVATE-COMMAND|PRIVATE-FAILURE|PRIVATE-TERMINAL-FRAME/);
    assert.equal((markup.match(/data-slot="tool-output"/g) ?? []).length, 0);
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

  it('surfaces terminal cancel and runtime truncation flags', () => {
    const cancelled = renderToStaticMarkup(createElement(ToolCallDetail, {
      item: {
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
      } satisfies ToolActivityItem,
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
    assert.match(cancelledTrow, /已中断/);
    assert.doesNotMatch(cancelledTrow, /失败/);

    const truncated = renderToStaticMarkup(createElement(ToolCallDetail, {
      item: {
        toolUseId: 'tool-trunc',
        toolName: 'Bash',
        status: 'running',
        args: { command: 'run' },
        result: {
          kind: 'terminal',
          cwd: '/repo',
          cmd: 'run',
          status: 'completed',
          exitCode: 0,
          output: { ...pipeOutput('tail only'), stdoutTruncated: true },
        },
      } satisfies ToolActivityItem,
    }));
    assert.match(truncated, /tail only/);
    assert.match(truncated, /输出已截断/);
  });

  // The bug this replaced: a running command rendered in a bespoke trow and
  // switched to Astryx chrome the moment it settled. Crossing a status
  // boundary must not change which component draws the row.
  it('draws every status through the same Astryx row', () => {
    const base = {
      toolUseId: 'tool-status-sweep',
      toolName: 'Bash',
      activityKind: 'command' as const,
      intent: '运行测试',
      args: { command: 'npm test' },
    };
    for (const status of ['pending', 'running', 'completed', 'errored', 'interrupted'] as const) {
      const markup = renderTool({ ...base, status });
      assert.match(markup, /astryx-chat-tool-calls/, `${status} renders through Astryx`);
    }
  });

  // Expansion is Astryx's call, not the product's: a settled group stays
  // collapsed even when an earlier row failed, and the collapsed header shows
  // the last call alone. Accepting that density trade-off is what "one visual
  // language" costs — a bespoke group summary is exactly what this PR removed.
  describe('group expansion follows Astryx', () => {
    const trailingSuccess = {
      toolUseId: 'ok-1',
      toolName: 'Read',
      activityKind: 'read' as const,
      status: 'completed' as const,
      args: {},
    };

    function renderGroup(first: ToolActivityItem): string {
      return renderToStaticMarkup(createElement(ToolTrow, { items: [first, trailingSuccess] }));
    }

    it('stays collapsed when a settled group holds an interrupted call', () => {
      const markup = renderGroup({
        toolUseId: 'cut-1',
        toolName: 'Bash',
        activityKind: 'command',
        status: 'interrupted',
        args: { command: 'sleep 600' },
      });
      assert.match(markup, /aria-expanded="false"/);
    });

    // Two items on purpose: Astryx renders a lone call as a bare row that owns
    // its own expansion, so defaultIsExpanded only reaches a real group.
    it('opens while any call in the group is still running', () => {
      const markup = renderGroup({
        toolUseId: 'live-1',
        toolName: 'Bash',
        activityKind: 'command',
        status: 'running',
        args: { command: 'npm test' },
      });
      assert.match(markup, /aria-expanded="true"/);
    });

    // `pending` is in flight too: tool_start opens a call there and it only
    // reaches `running` once output arrives, so a tool that never streams stays
    // pending for its whole life. With parallel calls the last one can settle
    // first, and the collapsed header would then show a green check for a group
    // whose sibling is still working.
    it('opens when a parallel call is still pending behind a settled one', () => {
      const markup = renderGroup({
        toolUseId: 'quiet-1',
        toolName: 'Bash',
        activityKind: 'command',
        status: 'pending',
        args: { command: 'sleep 600' },
      });
      assert.match(markup, /aria-expanded="true"/);
    });
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
