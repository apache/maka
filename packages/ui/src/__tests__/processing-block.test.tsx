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
  it('renders through official Astryx ChatReasoning with its native collapsed preview', () => {
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

    assert.match(markup, /class="[^"]*astryx-chat-reasoning[^"]*min-w-0[^"]*"/);
    assert.match(markup, /class="flex min-w-0 w-full flex-col gap-2"/);
    assert.match(markup, /role="button"[^>]*aria-expanded="false"/);
    assert.match(markup, /private reasoning/);
    assert.doesNotMatch(markup, /data-slot="reasoning-trigger"/);
    assert.doesNotMatch(markup, /复制思考过程/);
    assert.doesNotMatch(markup, /data-slot="reasoning-disclosure"/);
  });

  it('places assistant actions on ChatMessageMetadata, not a product Marker footer shell', () => {
    const markup = renderToStaticMarkup(createElement(TurnView, {
      turn: {
        turnId: 'footer-turn',
        status: 'completed',
        partialOutputRetained: false,
        tools: [],
        notes: [],
        timeline: [{ kind: 'text', text: 'answer body', messageId: 'a1', ts: 1 }],
        startedAt: 1,
        assistant: { id: 'a1', role: 'assistant', text: 'answer body', ts: 1 },
      },
      footerActions: [
        { id: 'copy', label: '复制', enabled: true },
        { id: 'regenerate', label: '重新生成', enabled: true },
      ],
    }));

    assert.match(markup, /astryx-chat-message-metadata|chat-message-metadata/);
    assert.match(markup, /data-action="copy"/);
    assert.match(markup, /data-action="regenerate"/);
    assert.doesNotMatch(markup, /data-variant="footer"/);
  });

  it('keeps redaction and truncation product behavior outside the Astryx disclosure', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const markup = renderToStaticMarkup(createElement(TurnView, {
      turn: {
        turnId: 'safe-thinking-turn',
        status: 'completed',
        partialOutputRetained: false,
        tools: [],
        notes: [],
        timeline: [{
          kind: 'thinking',
          text: `api_key=${secret}`,
          truncated: true,
          messageId: 'thinking-2',
        }],
        startedAt: 1,
      },
    }));

    assert.match(markup, /深度思考 · 已截断/);
    assert.match(markup, /&lt;redacted&gt;/);
    assert.doesNotMatch(markup, new RegExp(secret));
    assert.doesNotMatch(markup, /data-truncated="true"/);
  });
});
