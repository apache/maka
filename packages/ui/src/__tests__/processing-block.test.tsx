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
  it('does not wrap native reasoning and tool disclosures in another processing layer', () => {
    const markup = renderToStaticMarkup(createElement(TurnView, {
      turn: turnWithTools([
        { toolUseId: 'r1', toolName: 'Read', activityKind: 'read', status: 'completed', args: {} },
      ]),
    }));

    assert.doesNotMatch(markup, /data-processing="block"/);
    assert.match(markup, /class="[^"]*astryx-chat-tool-calls[^"]*"/);
    assert.match(markup, /深度思考/);
  });

  it('keeps waiting permission in the product-owned disclosure without a processing wrapper', () => {
    const markup = renderToStaticMarkup(createElement(TurnView, {
      turn: turnWithTools([
        { toolUseId: 'b1', toolName: 'Bash', activityKind: 'command', status: 'completed', args: {} },
        { toolUseId: 'w1', toolName: 'Write', activityKind: 'edit', status: 'waiting_permission', args: {}, intent: '写入配置' },
      ]),
    }));
    assert.doesNotMatch(markup, /data-processing="block"/);
    assert.match(markup, /data-trow="group"/);
    assert.match(markup, /aria-expanded="true"/);
    assert.match(markup, /写入配置/);
  });
});

describe('deep-thinking disclosure', () => {
  it('starts collapsed with the same compact activity-row structure as Astryx tool calls', () => {
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

    assert.match(markup, /data-slot="reasoning-disclosure"/);
    assert.match(markup, /<button[^>]*data-slot="reasoning-trigger"[^>]*aria-expanded="false"[^>]*aria-controls="[^"]+"/);
    const trigger = markup.match(/(<button[^>]*data-slot="reasoning-trigger"[\s\S]*?<\/button>)/)?.[1];
    assert.ok(trigger, 'deep-thinking disclosure must expose a collapsed trigger');
    assert.match(trigger, /lucide-chevron-down/);
    assert.match(trigger, /min-h-6/);
    assert.match(trigger, /class="[^"]*astryx-text supporting[^"]*"/);
    assert.doesNotMatch(markup, /private reasoning/);
  });
});
