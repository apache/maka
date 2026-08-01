import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, IconButton } from '../index.js';
import { X } from '../icons.js';

test('the public Button preserves native and tooltip-disabled semantics', () => {
  const nativeDisabled = renderToStaticMarkup(
    createElement(Button, { label: 'Send', isDisabled: true }),
  );
  const tooltipDisabled = renderToStaticMarkup(
    createElement(Button, {
      label: 'Send',
      isDisabled: true,
      tooltip: 'Enter a message first',
    }),
  );

  assert.match(nativeDisabled, /^<button[^>]* disabled=""/);
  assert.doesNotMatch(nativeDisabled, /aria-disabled="true"/);
  assert.match(tooltipDisabled, /^<button[^>]* aria-disabled="true"/);
  assert.doesNotMatch(tooltipDisabled, / disabled=""/);
  assert.match(tooltipDisabled, /role="tooltip"/);
});

test('the public IconButton renders an accessible icon-only control', () => {
  const markup = renderToStaticMarkup(
    createElement(IconButton, {
      label: 'Close',
      icon: createElement(X, { 'aria-hidden': 'true' }),
    }),
  );

  assert.match(markup, /^<button[^>]* aria-label="Close"/);
  assert.doesNotMatch(markup, />Close</);
  assert.match(markup, /<svg/);
});
