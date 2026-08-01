import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TurnView } from '../chat-turn.js';
import { LocaleProvider } from '../locale-context.js';
import type { TurnViewModel } from '../materialize.js';

test('marks a Goal continuation as Host-authored and does not offer user-message editing', () => {
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <TurnView turn={goalTurn()} onEditUserMessage={() => {}} />
    </LocaleProvider>,
  );

  assert.match(markup, /Continued by Goal/);
  assert.match(markup, /Continued by Goal · goal-1/);
  assert.doesNotMatch(markup, /Edit &amp; resend/);
});

function goalTurn(): TurnViewModel {
  return {
    turnId: 'turn-1',
    status: 'completed',
    partialOutputRetained: false,
    user: {
      id: 'message-1',
      role: 'user',
      text: '[Goal continuation] Keep working.',
      hostOrigin: { kind: 'goal', goalId: 'goal-1' },
    },
    tools: [],
    timeline: [],
    notes: [],
    startedAt: 1,
  };
}
