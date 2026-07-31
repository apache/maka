/**
 * Tests for the pure trow-summary helpers (streaming UI rework). The subject
 * lives in `@maka/ui`; the test rides in the desktop workspace where node:test
 * is wired, like materialize-turns.test.ts.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  isTrowRunning,
  summarizeTrowTools,
  trowActivityKind,
  trowNeedsAttention,
  type ToolActivityItem,
} from '@maka/ui';

function tool(
  toolName: string,
  status: ToolActivityItem['status'] = 'completed',
  toolUseId = toolName + Math.random(),
): ToolActivityItem {
  return { toolUseId, toolName, status, args: {} };
}

describe('trowActivityKind', () => {
  it('buckets canonical maka tool names case-insensitively', () => {
    assert.equal(trowActivityKind('Read'), 'read');
    assert.equal(trowActivityKind('Glob'), 'search');
    assert.equal(trowActivityKind('Grep'), 'search');
    assert.equal(trowActivityKind('WebSearch'), 'websearch');
    assert.equal(trowActivityKind('WebFetch'), 'webfetch');
    assert.equal(trowActivityKind('Write'), 'edit');
    assert.equal(trowActivityKind('Edit'), 'edit');
    assert.equal(trowActivityKind('Bash'), 'command');
    assert.equal(trowActivityKind('StopBackgroundTask'), 'command');
    assert.equal(trowActivityKind('stop_background_task'), 'command');
    assert.equal(trowActivityKind('ExploreAgent'), 'explore');
    assert.equal(trowActivityKind('browser_click'), 'browser');
    assert.equal(trowActivityKind('ImaginaryTool'), 'tool');
  });
});

describe('summarizeTrowTools', () => {
  it('buckets by type in first-seen order joined with 「，」', () => {
    const summary = summarizeTrowTools([
      tool('Read'),
      tool('Read'),
      tool('Read'),
      tool('Grep'),
      tool('Grep'),
    ]);
    assert.equal(summary, '读取 3 个文件，搜索 2 次');
  });

  it('preserves first-seen order even when kinds interleave', () => {
    const summary = summarizeTrowTools([tool('Grep'), tool('Read'), tool('Grep')]);
    assert.equal(summary, '搜索 2 次，读取 1 个文件');
  });

  it('appends 「N 个失败」 while still counting failed tools in their type bucket', () => {
    const summary = summarizeTrowTools([
      tool('Read'),
      tool('Read', 'errored'),
      tool('Bash', 'errored'),
    ]);
    assert.equal(summary, '读取 2 个文件，运行 1 条命令，2 个失败');
  });

  it('falls back to the generic bucket for unknown tools', () => {
    assert.equal(summarizeTrowTools([tool('ImaginaryTool'), tool('RiveWorkflow')]), '调用 2 个工具');
  });
});

describe('isTrowRunning', () => {
  it('reports running while any tool is in flight', () => {
    const items = [tool('Read', 'completed'), tool('Bash', 'running'), tool('Grep', 'completed')];
    assert.equal(isTrowRunning(items), true);
  });

  it('reports settled when nothing is in flight', () => {
    const items = [tool('Read'), tool('Grep')];
    assert.equal(isTrowRunning(items), false);
  });
});

describe('trowNeedsAttention', () => {
  it('forces the group open only for a permission prompt', () => {
    // A permission prompt is actionable: a collapsed summary line would hide
    // it, so the group still force-opens for it.
    assert.equal(trowNeedsAttention([tool('Read'), tool('Bash', 'waiting_permission')]), true);
  });

  it('stays collapsed for errored, settled, or merely running groups', () => {
    // An errored tool no longer force-opens the group: the settled summary
    // line keeps the failure signal (「N 个失败」 in destructive color), and
    // the error banner + output stay one click away.
    assert.equal(trowNeedsAttention([tool('Read'), tool('Bash', 'errored')]), false);
    assert.equal(trowNeedsAttention([tool('Read'), tool('Grep')]), false);
    assert.equal(trowNeedsAttention([tool('Read', 'running'), tool('Grep', 'pending')]), false);
    assert.equal(trowNeedsAttention([tool('Read', 'interrupted')]), false);
  });
});
