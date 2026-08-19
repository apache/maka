/**
 * The ＋ menu's two mode controls and the divider above them.
 *
 * Plan and orchestration are separate Session state, so they are separate
 * controls here — a toggle and a one-of-N choice — and a Session can hold
 * both. Every prop that feeds them is optional, so a host can wire the modes
 * alone, and then there is nothing above the divider for it to divide.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';

function render(props: Parameters<typeof Composer>[0]): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Composer {...props} />
    </LocaleProvider>,
  );
}

function plusMenu(props: Parameters<typeof Composer>[0]): string {
  const parts = render(props).split('maka-composer-plus-menu');
  // Without the marker `split` returns the whole markup, and a menu that
  // stopped rendering would still satisfy an absence assertion.
  assert.ok(parts.length > 1, 'the composer rendered no ＋ menu');
  return parts[parts.length - 1] ?? '';
}

function count(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

/** Opening tags carrying every one of these attributes, in any order. */
function tagsWith(markup: string, ...attributes: readonly string[]): readonly string[] {
  return (markup.match(/<[a-z]+[^>]*>/g) ?? []).filter(
    (tag) => attributes.every((attribute) => tag.includes(attribute)),
  );
}

const base = {
  onSend: () => undefined,
  onStop: () => undefined,
  planModeActive: false,
  onPlanModeChange: () => undefined,
  orchestrationMode: 'default' as const,
  onOrchestrationModeChange: () => undefined,
};

test('the mode controls alone open the menu on a row, not on a rule', () => {
  assert.equal(plusMenu(base).includes('astryx-dropdown-menu-divider'), false);
});

test('an action row above the mode controls keeps the divider', () => {
  const withAction = plusMenu({ ...base, onPickAttachments: () => undefined });
  assert.equal(withAction.includes('astryx-dropdown-menu-divider'), true);
});

test('Plan is a toggle and orchestration is a one-of-three choice', () => {
  const menu = plusMenu(base);
  assert.equal(count(menu, 'role="menuitemcheckbox"'), 1, 'Plan is one checkable row');
  assert.equal(count(menu, 'role="menuitemradio"'), 3, 'default, Swarm and Graph are one group');
});

test('Plan and an orchestration mode are both on at once', () => {
  const markup = render({ ...base, planModeActive: true, orchestrationMode: 'swarm' });
  const menu = markup.split('maka-composer-plus-menu')[1] ?? '';
  assert.equal(
    tagsWith(menu, 'role="menuitemcheckbox"', 'aria-checked="true"').length,
    1,
    'Plan is not checked while an orchestration mode is chosen',
  );
  assert.equal(
    tagsWith(menu, 'role="menuitemradio"', 'aria-checked="true"').length,
    1,
    'the orchestration choice lost its selection while Plan is on',
  );
  // Each one keeps its own readout and its own way out, so neither hides the
  // other: a Plan excursion does not clear the orchestration default.
  assert.equal(count(markup, 'maka-composer-mode-button'), 2);
  assert.ok(markup.includes('data-mode="plan"'));
  assert.ok(markup.includes('data-mode="swarm"'));
});
