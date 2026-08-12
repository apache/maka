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
    status: 'completed',
    partialOutputRetained: false,
    user: { id: 'original', role: 'user', text: 'original request', ts: 1 },
    userInterjections: [
      { id: 'steer-1', role: 'user', text: 'inserted instruction', ts: 3 },
    ],
    tools: [],
    notes: [],
    startedAt: 1,
    timeline: [
      {
        kind: 'text',
        text: 'output visible before steering',
        messageId: 'before-steer',
        ts: 2,
      },
      {
        kind: 'user',
        message: { id: 'steer-1', role: 'user', text: 'inserted instruction', ts: 3 },
        messageId: 'steer-1',
      },
      {
        kind: 'text',
        text: 'output visible after steering',
        messageId: 'after-steer',
        ts: 4,
      },
    ],
  };

  const markup = renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(TurnView, { turn }),
    }),
  );
  const before = markup.indexOf('output visible before steering');
  const steering = markup.indexOf('inserted instruction');
  const after = markup.indexOf('output visible after steering');

  assert.notEqual(before, -1);
  assert.notEqual(steering, -1);
  assert.notEqual(after, -1);
  assert.equal(before < steering && steering < after, true);
});
