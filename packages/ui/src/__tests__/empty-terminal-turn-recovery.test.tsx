import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { StoredMessage } from '@maka/core';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TurnView, type TurnFooterActionMeta } from '../chat-turn.js';
import { LocaleProvider } from '../locale-context.js';
import { materializeTurns, type TurnViewModel } from '../materialize.js';

const USER_MESSAGE = {
  type: 'user',
  id: 'user-1',
  turnId: 'turn-1',
  ts: 1,
  text: 'Continue',
} satisfies StoredMessage;

const FOOTER_ACTIONS = [
  {
    id: 'regenerate',
    label: 'Regenerate',
    enabled: true,
    tooltip: 'Generate another response to this turn',
  },
  {
    id: 'branch',
    label: 'Branch',
    enabled: true,
    tooltip: 'Branch a new conversation from this response',
  },
  {
    id: 'copy',
    label: 'Copy',
    enabled: false,
    tooltip: 'This response has no content to copy',
  },
] satisfies ReadonlyArray<TurnFooterActionMeta>;

function conversationalTurnWithState(status: 'running' | 'failed'): TurnViewModel {
  const messages: StoredMessage[] = [
    USER_MESSAGE,
    {
      type: 'turn_state',
      id: `state-${status}`,
      turnId: 'turn-1',
      ts: 2,
      status,
      ...(status === 'failed' ? { errorClass: 'timeout' } : {}),
      partialOutputRetained: false,
    },
  ];
  const turn = materializeTurns(messages)[0];
  assert.ok(turn);
  assert.equal(turn.timeline.length, 0);
  return turn;
}

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, { locale: 'en', children: node }),
  );
}

describe('empty terminal turn recovery', () => {
  it('mounts failure state and Regenerate after a turn fails before assistant output', () => {
    const markup = render(
      createElement(TurnView, {
        turn: conversationalTurnWithState('failed'),
        failedReasonLabel: 'Request timed out',
        footerActions: FOOTER_ACTIONS,
        onFooterAction: () => {},
      }),
    );

    assert.match(markup, /role="alert"/);
    assert.match(markup, /Request timed out/);
    const regenerate = markup.match(/<button\b[^>]*data-action="regenerate"[^>]*>/)?.[0];
    assert.ok(regenerate);
    assert.match(regenerate, /aria-label="Regenerate"/);
    assert.doesNotMatch(regenerate, /aria-disabled="true"/);
  });

  it('keeps recovery actions out of an empty turn while it is still running', () => {
    const markup = render(
      createElement(TurnView, {
        turn: conversationalTurnWithState('running'),
        footerActions: FOOTER_ACTIONS,
      }),
    );

    assert.doesNotMatch(markup, /data-action="(?:regenerate|branch)"/);
    assert.doesNotMatch(markup, /role="toolbar"/);
  });

  it('does not invent recovery actions for an inferred legacy turn', () => {
    const turn = materializeTurns([USER_MESSAGE])[0];
    assert.ok(turn);
    assert.equal(turn.statusSource, 'inferred');

    const markup = render(
      createElement(TurnView, {
        turn,
        footerActions: FOOTER_ACTIONS,
      }),
    );

    assert.doesNotMatch(markup, /data-action="(?:regenerate|branch)"/);
  });

  it('does not offer conversational recovery for an internal terminal record', () => {
    const turn = materializeTurns([
      {
        type: 'turn_state',
        id: 'state-internal',
        turnId: 'turn-internal',
        ts: 1,
        status: 'completed',
        partialOutputRetained: false,
      },
    ])[0];
    assert.ok(turn);
    assert.equal(turn.statusSource, 'recorded');
    assert.equal(turn.user, undefined);

    const markup = render(
      createElement(TurnView, {
        turn,
        footerActions: FOOTER_ACTIONS,
      }),
    );

    assert.doesNotMatch(markup, /data-action="(?:regenerate|branch)"/);
  });
});
