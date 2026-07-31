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

function processingTrigger(markup: string): string {
  const trigger = markup.match(/data-processing="block"[\s\S]*?(<button[\s\S]*?<\/button>)/)?.[1];
  assert.ok(trigger, 'processing disclosure must expose a trigger button');
  return trigger;
}

describe('ProcessingBlock disclosure wiring (#1307)', () => {
  it('delegates disclosure semantics and chrome to Astryx Collapsible', () => {
    const markup = renderToStaticMarkup(createElement(TurnView, {
      turn: turnWithTools([
        { toolUseId: 'r1', toolName: 'Read', activityKind: 'read', status: 'completed', args: {} },
      ]),
    }));

    assert.match(markup, /class="[^"]*astryx-collapsible[^"]*"/);
    assert.match(markup, /<button[^>]*aria-expanded="false"[^>]*aria-controls="[^"]+"/);
    assert.match(markup, /class="[^"]*astryx-collapsible-content[^"]*"/);
    assert.doesNotMatch(markup, /data-trow="row"/);
    assert.doesNotMatch(processingTrigger(markup), /lucide-chevron-right/);
  });

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
    assert.match(processingTrigger(markup), /aria-expanded="true"/);
    assert.doesNotMatch(markup, /data-trow="group"/);
    assert.equal((markup.match(/data-trow="row"/g) ?? []).length, 2);
  });

  it('ordinary settled work reports a collapsed Astryx trigger', () => {
    const markup = renderToStaticMarkup(createElement(TurnView, {
      turn: turnWithTools([
        { toolUseId: 'r1', toolName: 'Read', activityKind: 'read', status: 'completed', args: {} },
      ]),
    }));
    assert.match(markup, /data-processing="block"/);
    assert.match(processingTrigger(markup), /aria-expanded="false"/);
    assert.doesNotMatch(markup, /data-trow="group"/);
  });

  it('keeps the collapsed block icon aligned with the first summarized tool kind', () => {
    const commandFirst = renderToStaticMarkup(createElement(TurnView, {
      turn: turnWithTools([
        { toolUseId: 'b1', toolName: 'Bash', activityKind: 'command', status: 'completed', args: {} },
        { toolUseId: 'r1', toolName: 'Read', activityKind: 'read', status: 'completed', args: {} },
      ]),
    }));
    const commandTrigger = processingTrigger(commandFirst);
    assert.match(commandTrigger, /lucide-terminal/);
    assert.match(commandTrigger, /运行 1 条命令，读取 1 个文件/);
    assert.doesNotMatch(commandTrigger, /lucide-file-text|lucide-cpu/);

    const readFirst = renderToStaticMarkup(createElement(TurnView, {
      turn: turnWithTools([
        { toolUseId: 'r1', toolName: 'Read', activityKind: 'read', status: 'completed', args: {} },
        { toolUseId: 'b1', toolName: 'Bash', activityKind: 'command', status: 'completed', args: {} },
      ]),
    }));
    const readTrigger = processingTrigger(readFirst);
    assert.match(readTrigger, /lucide-file-text/);
    assert.match(readTrigger, /读取 1 个文件，运行 1 条命令/);
    assert.doesNotMatch(readTrigger, /lucide-terminal|lucide-cpu/);
  });
});

describe('deep-thinking disclosure', () => {
  it('starts collapsed and delegates its trigger, chevron, and keyboard semantics to Astryx', () => {
    const markup = renderToStaticMarkup(createElement(TurnView, {
      turn: {
        turnId: 'thinking-turn',
        status: 'completed',
        partialOutputRetained: false,
        tools: [],
        notes: [],
        timeline: [{ kind: 'thinking', text: 'private reasoning', messageId: 'thinking-1' }],
        startedAt: 1,
      },
    }));

    assert.match(markup, /class="[^"]*astryx-collapsible[^"]*"/);
    assert.match(markup, /<button[^>]*aria-expanded="false"[^>]*aria-controls="[^"]+"/);
    const trigger = markup.match(/(<button[^>]*aria-expanded="false"[\s\S]*?<\/button>)/)?.[1];
    assert.ok(trigger, 'deep-thinking disclosure must expose a collapsed trigger');
    assert.doesNotMatch(trigger, /lucide-chevron-right/);
    assert.doesNotMatch(markup, /private reasoning/);
  });
});
