import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup as renderReactToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import type { ToolActivityItem } from '../materialize.js';
import { ToolTrow } from '../tool-activity.js';

function runningTool(id: string, name: string): ToolActivityItem {
  return { toolUseId: id, toolName: name, status: 'running', args: {} };
}

function renderToStaticMarkup(node: ReactNode): string {
  return renderReactToStaticMarkup(createElement(LocaleProvider, {
    locale: 'zh',
    children: node,
  }));
}

describe('ToolTrow stable structure', () => {
  it('keeps the Astryx tool-call root when a second tool arrives', () => {
    const first = runningTool('tool-1', 'Read');
    const one = renderToStaticMarkup(createElement(ToolTrow, { items: [first] }));
    const two = renderToStaticMarkup(createElement(ToolTrow, {
      items: [first, runningTool('tool-2', 'Grep')],
    }));

    assert.match(one, /class="astryx-chat-tool-calls\b/);
    assert.match(one, /aria-expanded="false"/);
    assert.match(two, /class="astryx-chat-tool-calls\b/);
    // Still collapsed, and its header projects the last call on its own.
    assert.doesNotMatch(two, /aria-expanded="true"/);
    assert.match(two, />Grep</);
  });

  it('renders addition and deletion counts for a file_diff result', () => {
    const item: ToolActivityItem = {
      toolUseId: 'tool-1',
      toolName: 'Edit',
      status: 'completed',
      args: { path: 'a.ts' },
      result: {
        kind: 'file_diff',
        paths: ['a.ts'],
        diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more',
      },
    };

    const html = renderToStaticMarkup(createElement(ToolTrow, { items: [item] }));

    assert.match(html, />\+2</);
    assert.match(html, />-1</);
  });

  it('omits a zero count instead of painting -0 on a pure-additions write', () => {
    const item: ToolActivityItem = {
      toolUseId: 'tool-1',
      toolName: 'Write',
      status: 'completed',
      args: { path: 'new.md' },
      result: {
        kind: 'file_diff',
        paths: ['new.md'],
        diff: '--- /dev/null\n+++ b/new.md\n@@ -0,0 +1,2 @@\n+alpha\n+beta',
      },
    };

    const html = renderToStaticMarkup(createElement(ToolTrow, { items: [item] }));

    assert.match(html, />\+2</);
    assert.doesNotMatch(html, />-0</);
  });

  // Guard for patches/@astryxdesign+core+0.3.0.patch — a contiguous run is one
  // group, a group collapses by default, and the unpatched collapsed header
  // projects the latest call's name and target alone. Several edits in one turn
  // is the most common shape there is and it showed no counts at all.
  it('sums the run when a collapsed group carries more than one diff', () => {
    const edit = (id: string, path: string, diff: string): ToolActivityItem => ({
      toolUseId: id,
      toolName: 'Edit',
      status: 'completed',
      args: { path },
      result: { kind: 'file_diff', paths: [path], diff },
    });

    const html = renderToStaticMarkup(createElement(ToolTrow, {
      items: [
        edit('tool-1', 'a.ts', '--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more'),
        edit('tool-2', 'b.ts', '--- a/b.ts\n+++ b/b.ts\n@@ -1,2 +1,2 @@\n keep\n-gone\n+here'),
      ],
    }));

    // Collapsed: the rows inside are not what these counts come from.
    assert.doesNotMatch(html, /aria-expanded="true"/);
    assert.match(html, />\+3</);
    assert.match(html, />-2</);
  });

  it('leaves the collapsed group header alone when the run changed no file', () => {
    const html = renderToStaticMarkup(createElement(ToolTrow, {
      items: [runningTool('tool-1', 'Read'), runningTool('tool-2', 'Grep')],
    }));

    assert.doesNotMatch(html, />\+0</);
    assert.doesNotMatch(html, />-0</);
  });
});
