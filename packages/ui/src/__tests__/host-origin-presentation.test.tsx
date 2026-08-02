import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TurnView } from '../chat-turn.js';
import { LocaleProvider } from '../locale-context.js';
import type { TurnViewModel } from '../materialize.js';

type HostOrigin = NonNullable<NonNullable<TurnViewModel['user']>['hostOrigin']>;

// One case per Host origin the transcript can carry. The three markers are
// separate branches in chat-turn.tsx with separate copy, so covering only one
// leaves the others free to render nothing — which reads in the app as a
// Host-injected turn impersonating typed user input.
const ORIGINS: Array<{ name: string; hostOrigin: HostOrigin; marker: RegExp; title: RegExp }> = [
  {
    name: 'an automation-triggered turn',
    hostOrigin: { kind: 'automation', automationId: 'daily-review' },
    marker: /Triggered by automation/,
    title: /Triggered by automation · daily-review/,
  },
  {
    name: 'a Goal continuation',
    hostOrigin: { kind: 'goal', goalId: 'goal-1' },
    marker: /Continued by Goal/,
    title: /Continued by Goal · goal-1/,
  },
  {
    name: 'an Agent Graph continuation',
    hostOrigin: {
      kind: 'agent_graph',
      graphId: 'graph-1',
      wakeId: 'wake-1',
      attemptId: 'attempt-1',
    },
    marker: /Continued by Agent Graph/,
    title: /Triggered by the Agent Graph scheduler · graph-1/,
  },
];

for (const origin of ORIGINS) {
  test(`marks ${origin.name} as Host-authored and does not offer user-message editing`, () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <TurnView turn={hostTurn(origin.hostOrigin)} onEditUserMessage={() => {}} />
      </LocaleProvider>,
    );

    assert.match(markup, origin.marker);
    assert.match(markup, origin.title);
    assert.doesNotMatch(markup, /Edit &amp; resend/);
  });
}

function hostTurn(hostOrigin: HostOrigin): TurnViewModel {
  return {
    turnId: 'turn-1',
    status: 'completed',
    partialOutputRetained: false,
    user: {
      id: 'message-1',
      role: 'user',
      text: '[Host continuation] Keep working.',
      hostOrigin,
    },
    tools: [],
    timeline: [],
    notes: [],
    startedAt: 1,
  };
}
