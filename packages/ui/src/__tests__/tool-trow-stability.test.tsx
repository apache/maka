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
});
