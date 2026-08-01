import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup as renderReactToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import { ToolTrow } from '../tool-activity.js';
import { summarizeTrowTools } from '../tool-activity/trow-summary.js';
import type { ToolActivityItem } from '../materialize.js';

const toolActivitySource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'tool-activity.tsx'),
  'utf8',
);

function renderToStaticMarkup(node: ReactNode): string {
  return renderReactToStaticMarkup(createElement(LocaleProvider, {
    locale: 'zh',
    children: node,
  }));
}

describe('tool trow summary aggregation', () => {
  it('uses the native Astryx multi-call summary and keeps tool intents in the rows', () => {
    const markup = renderToStaticMarkup(createElement(ToolTrow, {
      items: [
        { toolUseId: 'r1', toolName: 'Read', activityKind: 'read', status: 'running', args: {}, intent: '读取 a.ts' },
        { toolUseId: 'r2', toolName: 'Read', activityKind: 'read', status: 'running', args: {}, intent: '读取 b.ts' },
        { toolUseId: 'g1', toolName: 'Grep', activityKind: 'search', status: 'running', args: {}, intent: '搜索 foo' },
      ] satisfies ToolActivityItem[],
    }));

    assert.match(markup, /class="astryx-chat-tool-calls\b/);
    assert.match(markup, />3 tool calls</);
    assert.match(markup, /读取 a\.ts/);
    assert.match(markup, /读取 b\.ts/);
    assert.match(markup, /搜索 foo/);
  });

  it('keeps the native group count stable while individual tools settle', () => {
    const markup = renderToStaticMarkup(createElement(ToolTrow, {
      items: [
        { toolUseId: 'r1', toolName: 'Read', activityKind: 'read', status: 'running', args: {} },
        { toolUseId: 'r2', toolName: 'Read', activityKind: 'read', status: 'completed', args: {} },
        { toolUseId: 'g1', toolName: 'Grep', activityKind: 'search', status: 'running', args: {} },
      ] satisfies ToolActivityItem[],
    }));
    assert.match(markup, />3 tool calls</);
    assert.match(markup, /astryx-spinner/);
  });

  it('uses the native Astryx group icon instead of Maka activity-kind icons', () => {
    const markup = renderToStaticMarkup(createElement(ToolTrow, {
      items: [
        { toolUseId: 'r1', toolName: 'Read', activityKind: 'read', status: 'running', args: {} },
        { toolUseId: 'g1', toolName: 'Grep', activityKind: 'search', status: 'running', args: {} },
      ] satisfies ToolActivityItem[],
    }));
    assert.match(markup, />2 tool calls</);
    assert.doesNotMatch(markup, /lucide-file-text|lucide-search/);
  });

  it('keeps the failed count visible in the live summary (the group no longer force-opens on error)', () => {
    const items: ToolActivityItem[] = [
      { toolUseId: 'r1', toolName: 'Read', activityKind: 'read', status: 'completed', args: {} },
      { toolUseId: 'g1', toolName: 'Grep', activityKind: 'search', status: 'errored', args: {} },
    ];
    // Errored tools stay collapsed now, so the summary line is the failure
    // signal and must carry the count live, not only once settled.
    assert.equal(summarizeTrowTools(items, { live: true }), '正在读取 1 个文件，搜索 1 次，1 个失败');
    assert.equal(summarizeTrowTools(items), '读取 1 个文件，搜索 1 次，1 个失败');
  });

  it('counts sandbox denials separately from ordinary failures', () => {
    const items: ToolActivityItem[] = [
      {
        toolUseId: 'g1',
        toolName: 'Grep',
        activityKind: 'search',
        status: 'errored',
        args: {},
        result: {
          kind: 'text',
          text: 'Filesystem access was denied.',
          sandboxDenial: { likely: true, backend: 'macos-seatbelt' },
        },
      },
      {
        toolUseId: 'b1',
        toolName: 'Bash',
        activityKind: 'command',
        status: 'errored',
        args: {},
        result: { kind: 'text', text: 'Command failed.' },
      },
    ];

    assert.equal(
      summarizeTrowTools(items),
      '搜索 1 次，运行 1 条命令，1 个可能被沙箱阻止，1 个失败',
    );
  });

  it('marks an errored row with a visible 失败 word inside an expanded group', () => {
    const markup = renderToStaticMarkup(createElement(ToolTrow, {
      items: [
        // waiting_permission mounts the group panel in static markup, so the
        // per-row headers render.
        { toolUseId: 'w1', toolName: 'Write', activityKind: 'edit', status: 'waiting_permission', args: {}, intent: '写入配置' },
        { toolUseId: 'e1', toolName: 'Bash', activityKind: 'command', status: 'errored', args: {}, intent: '运行测试' },
      ] satisfies ToolActivityItem[],
    }));
    // A collapsed errored row must not rely on the destructive tint alone —
    // the failure is a word, not just a color.
    assert.match(markup, /运行测试 · 失败/);
  });

  it('marks a sandbox-denied row without labeling it as failed', () => {
    const markup = renderToStaticMarkup(createElement(ToolTrow, {
      items: [
        { toolUseId: 'w1', toolName: 'Write', activityKind: 'edit', status: 'waiting_permission', args: {}, intent: '写入配置' },
        {
          toolUseId: 'g1',
          toolName: 'Grep',
          activityKind: 'search',
          status: 'errored',
          args: {},
          intent: '搜索源码',
          result: {
            kind: 'text',
            text: 'Filesystem access was denied.',
            sandboxDenial: { likely: true, backend: 'macos-seatbelt' },
          },
        },
      ] satisfies ToolActivityItem[],
    }));

    assert.match(markup, /搜索源码 · 可能被沙箱阻止/);
    assert.doesNotMatch(markup, /搜索源码 · 失败/);
  });

  it('ToolTrowRow never reintroduces the per-row settle fade or the motion abstraction', () => {
    // The per-row seam is a light-band stop only. The group keeps one
    // SETTLE_FADE (its summary span); rows must not bring back the motion
    // abstraction (deriveToolRowMotion / motion.* / settleFade) that would
    // re-stack parallel fades. A dynamic running→settled rerender contract is
    // tracked separately (packages/ui has only renderToStaticMarkup); this
    // source contract locks the implementation shape until that infra exists.
    assert.doesNotMatch(toolActivitySource, /deriveToolRowMotion/);
    assert.doesNotMatch(toolActivitySource, /\bmotion\.(settling|shimmer|settled)\b/);
    assert.doesNotMatch(toolActivitySource, /\bsettleFade\b/);
    assert.equal((toolActivitySource.match(/\bSETTLE_FADE\b/g) ?? []).length, 2);
  });
});
