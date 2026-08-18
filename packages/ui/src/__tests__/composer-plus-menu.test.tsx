/**
 * The ＋ menu's divider separates the action rows from the mode group. Every
 * prop that feeds it is optional, so a host can wire the mode choice alone —
 * and then there is nothing above the divider for it to divide.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';

function plusMenu(props: Parameters<typeof Composer>[0]): string {
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Composer {...props} />
    </LocaleProvider>,
  );
  const parts = markup.split('maka-composer-plus-menu');
  // Without the marker `split` returns the whole markup, and a menu that
  // stopped rendering would still satisfy an absence assertion.
  assert.ok(parts.length > 1, 'the composer rendered no ＋ menu');
  return parts[parts.length - 1] ?? '';
}

const base = {
  onSend: () => undefined,
  onStop: () => undefined,
  sessionMode: 'default' as const,
  onSessionModeChange: () => undefined,
};

test('the mode choice alone opens the menu on a row, not on a rule', () => {
  assert.equal(plusMenu(base).includes('astryx-dropdown-menu-divider'), false);
});

test('an action row above the mode group keeps the divider', () => {
  const withAction = plusMenu({ ...base, onPickAttachments: () => undefined });
  assert.equal(withAction.includes('astryx-dropdown-menu-divider'), true);
});
