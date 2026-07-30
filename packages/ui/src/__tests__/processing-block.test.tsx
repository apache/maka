import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup as renderReactToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import type { ToolActivityItem, TurnViewModel } from '../materialize.js';
import { TurnView } from '../chat-turn.js';

function renderToStaticMarkup(node: ReactNode): string {
  return renderReactToStaticMarkup(createElement(LocaleProvider, {
    locale: 'zh',
    children: node,
  }));
}

function turnWithTools(tools: ToolActivityItem[]): TurnViewModel {
  return {
    turnId: 'turn-1',
    status: 'completed',
    partialOutputRetained: false,
    tools,
    notes: [],
    timeline: [
      { kind: 'thinking', text: 'reasoning', messageId: 'a1' },
      { kind: 'tools', items: tools },
    ],
    startedAt: 1,
  };
}

describe('ProcessingBlock disclosure wiring (#1307)', () => {
  it('opens for waiting permission without nesting a duplicate tool-group disclosure', () => {
    const markup = renderToStaticMarkup(createElement(TurnView, {
      turn: turnWithTools([
        { toolUseId: 'b1', toolName: 'Bash', activityKind: 'command', status: 'completed', args: {} },
        { toolUseId: 'w1', toolName: 'Write', activityKind: 'edit', status: 'waiting_permission', args: {}, intent: '写入配置' },
      ]),
    }));
    // Processing owns the group summary. Its expanded panel exposes each tool
    // row directly, so the hierarchy is Processing → tool rather than the
    // duplicate Processing → tool group → tool seen in the regression.
    assert.match(markup, /data-processing="block"/);
    assert.doesNotMatch(markup, /data-trow="group"/);
    assert.equal((markup.match(/data-trow="row"/g) ?? []).length, 2);
  });

  it('ordinary settled work stays collapsed (no panel content in static markup)', () => {
    const markup = renderToStaticMarkup(createElement(TurnView, {
      turn: turnWithTools([
        { toolUseId: 'r1', toolName: 'Read', activityKind: 'read', status: 'completed', args: {} },
      ]),
    }));
    assert.match(markup, /data-processing="block"/);
    assert.doesNotMatch(markup, /data-trow="group"/);
  });

  it('keeps the collapsed block icon aligned with the first summarized tool kind', () => {
    const commandFirst = renderToStaticMarkup(createElement(TurnView, {
      turn: turnWithTools([
        { toolUseId: 'b1', toolName: 'Bash', activityKind: 'command', status: 'completed', args: {} },
        { toolUseId: 'r1', toolName: 'Read', activityKind: 'read', status: 'completed', args: {} },
      ]),
    }));
    assert.match(commandFirst, /lucide-terminal/);
    assert.match(commandFirst, /运行 1 条命令，读取 1 个文件/);
    assert.doesNotMatch(commandFirst, /lucide-file-text|lucide-cpu/);

    const readFirst = renderToStaticMarkup(createElement(TurnView, {
      turn: turnWithTools([
        { toolUseId: 'r1', toolName: 'Read', activityKind: 'read', status: 'completed', args: {} },
        { toolUseId: 'b1', toolName: 'Bash', activityKind: 'command', status: 'completed', args: {} },
      ]),
    }));
    assert.match(readFirst, /lucide-file-text/);
    assert.match(readFirst, /读取 1 个文件，运行 1 条命令/);
    assert.doesNotMatch(readFirst, /lucide-terminal|lucide-cpu/);
  });
});
