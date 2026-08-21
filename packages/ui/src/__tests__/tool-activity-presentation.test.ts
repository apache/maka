import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup as renderReactToStaticMarkup } from 'react-dom/server';
import { ToolCallDetail } from '../tool-activity.js';
import type { ToolActivityItem } from '../materialize.js';
import { LocaleProvider } from '../locale-context.js';

function renderToStaticMarkup(node: ReactNode): string {
  return renderReactToStaticMarkup(createElement(LocaleProvider, {
    locale: 'zh',
    children: node,
  }));
}

describe('tool activity presentation', () => {
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
        toolName: 'ExploreAgent',
        intent: '只读探索:定位渲染入口',
        args: { objective: '定位渲染入口' },
      }],
    }));
    assert.match(markup, /只读探索/);
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

  it('names a task ledger call by its first subject', async () => {
    const { ToolTrow } = await import('../tool-activity.js');
    const markup = renderToStaticMarkup(createElement(ToolTrow, {
      items: [{
        ...baseItem,
        toolName: 'task_create',
        displayName: 'Task Create',
        args: { tasks: [{ subject: '修复登录 bug' }, { subject: '补测试' }] },
      }],
    }));
    assert.match(markup, /修复登录 bug 等 2 项/);
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
