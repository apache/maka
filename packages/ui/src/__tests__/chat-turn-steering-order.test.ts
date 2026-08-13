import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TurnView } from '../chat-turn.js';
import { LocaleProvider } from '../locale-context.js';
import type { TurnViewModel } from '../materialize.js';

test('renders steering where it arrived in the assistant timeline', () => {
  const turn: TurnViewModel = {
    turnId: 'turn-1',
    status: 'failed',
    partialOutputRetained: false,
    user: { id: 'original', role: 'user', text: 'original request', ts: 1 },
    tools: [],
    notes: [],
    startedAt: 1,
    timeline: [
      { kind: 'text', text: 'output visible before steering', messageId: 'before-steer', ts: 2 },
      {
        kind: 'user',
        message: { id: 'steer-1', role: 'user', text: 'inserted instruction', ts: 3 },
        messageId: 'steer-1',
      },
      { kind: 'text', text: 'output visible after steering', messageId: 'after-steer', ts: 4 },
    ],
  };

  const markup = renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(TurnView, { turn, failedReasonLabel: 'failure detail' }),
    }),
  );
  const texts = [
    'output visible before steering',
    'inserted instruction',
    'output visible after steering',
  ];
  const [before, steering, after] = texts.map((text) => markup.indexOf(text));
  assert.equal(before < steering && steering < after, true);
  for (const text of [...texts, 'failure detail']) {
    assert.equal(markup.split(text).length - 1, 1, `${text} should render exactly once`);
  }
});

test('renders the admitted model transition before its user message', () => {
  const turn: TurnViewModel = {
    turnId: 'turn-model-change',
    status: 'failed',
    partialOutputRetained: false,
    modelChange: {
      id: 'model-change',
      ts: 1,
      data: {
        from: { connectionSlug: 'openai', model: 'gpt-5.5' },
        to: { connectionSlug: 'anthropic', model: 'claude-opus' },
      },
    },
    user: { id: 'user', role: 'user', text: 'continue here', ts: 1 },
    tools: [],
    notes: [],
    startedAt: 1,
    timeline: [],
  };

  const markup = renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(TurnView, { turn, failedReasonLabel: 'provider failure' }),
    }),
  );

  const change = 'Model changed from gpt-5.5 (openai) to claude-opus (anthropic).';
  const warning = 'Switching models mid-conversation may reduce performance.';
  assert.equal(markup.indexOf(change) < markup.indexOf('continue here'), true);
  assert.match(markup, new RegExp(`aria-label="${warning.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
});
