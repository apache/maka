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
