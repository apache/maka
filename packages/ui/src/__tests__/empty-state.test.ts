import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyState } from '../empty-state.js';

// The block EmptyState is an IN-PAGE card, and its edge is the only thing
// separating it from the surface behind it: measured live, the card composites
// to the same pure white as the panel it sits on, so `bg-card/70` contributes
// no contrast at all. The border is the separation.
//
// It shipped with `border-border` and no width utility. That sets a colour and
// nothing else, so the rendered border-width was 0 and the edge the author
// meant to draw never existed — what outlined the card was the incidental
// `0 0 0 1px var(--border)` ring inside `shadow-maka-panel`.

function cardClass(): string {
  const markup = renderToStaticMarkup(
    createElement(EmptyState, { title: 'Nothing here', body: 'Add something.' }),
  );
  const match = /class="([^"]*maka-empty-state[^"]*)"/.exec(markup);
  assert.ok(match, 'the block EmptyState should render a .maka-empty-state root');
  return match[1] ?? '';
}

test('the block EmptyState draws a real border, not just a border colour', () => {
  const cls = cardClass();
  assert.match(
    cls,
    /(^|\s)border(\s|$)/,
    'border-border alone sets no width — the card needs the `border` utility too',
  );
  assert.match(cls, /(^|\s)border-border(\s|$)/, 'the border colour must stay on the token');
});

test('the block EmptyState does not wear the overlay shadow', () => {
  // `shadow-maka-panel` is the floating-overlay family (mention popup, model
  // picker, select popup, dialog). Its `0 0 0 1px var(--border)` ring is what
  // used to stand in for the missing border here; keeping both would draw the
  // edge twice, and an in-page card has no reason to cast a popup's shadow.
  assert.doesNotMatch(cardClass(), /shadow-maka-panel/);
});

test('the inline EmptyState variant stays chrome-free', () => {
  // The inline variant is a bare <p> used where a card would be too heavy;
  // it must not pick up the card recipe.
  const markup = renderToStaticMarkup(
    createElement(EmptyState, { variant: 'inline', title: 'Nothing here', body: '' }),
  );
  assert.match(markup, /data-slot="empty-state-inline"/);
  assert.doesNotMatch(markup, /maka-empty-state[^-]/);
  assert.doesNotMatch(markup, /border-border/);
});
