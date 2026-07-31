import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, IconButton } from '../index.js';
import { X } from '../icons.js';
import { buttonVariants } from '../ui.js';
import { cn } from '../utils.js';

test('legacy buttonVariants exposes only the governed 32px and 28px geometry tiers', () => {
  const medium = buttonVariants({ size: 'md' });
  const small = buttonVariants({ size: 'sm' });
  const icon = buttonVariants({ size: 'icon' });
  const iconSmall = buttonVariants({ size: 'icon-sm' });

  assert.match(medium, /\bh-8\b/);
  assert.match(medium, /\bpx-3\b/);
  assert.match(small, /\bh-7\b/);
  assert.match(small, /\bpx-2\b/);
  assert.match(icon, /\bh-8\b/);
  assert.match(icon, /\bw-8\b/);
  assert.match(iconSmall, /\bh-7\b/);
  assert.match(iconSmall, /\bw-7\b/);
});

test('legacy buttonVariants neutral variants share one restrained interaction hierarchy', () => {
  const secondary = buttonVariants({ variant: 'secondary' });
  const ghost = buttonVariants({ variant: 'ghost' });
  const quiet = buttonVariants({ variant: 'quiet' });

  assert.match(secondary, /\bborder\b/);
  assert.match(secondary, /\bbg-transparent\b/);
  for (const classes of [secondary, ghost, quiet]) {
    assert.match(classes, /\bfont-normal\b/);
    assert.match(classes, /hover:bg-\[var\(--state-hover-bg\)\]/);
    assert.match(classes, /active:bg-\[var\(--state-selected-bg\)\]/);
  }
});

test('legacy buttonVariants focus and solid states stay visibly distinct without elevation', () => {
  const primary = buttonVariants({ variant: 'default' });
  const destructive = buttonVariants({ variant: 'destructive' });

  assert.match(primary, /\bfont-medium\b/);
  assert.match(destructive, /\bfont-medium\b/);
  assert.ok(!primary.includes('shadow-'));
  assert.ok(!primary.includes('ring-offset'));
  assert.notEqual(primary.match(/hover:[^ ]+/)?.[0], primary.match(/active:[^ ]+/)?.[0]);
  assert.notEqual(destructive.match(/hover:[^ ]+/)?.[0], destructive.match(/active:[^ ]+/)?.[0]);
});

test('legacy aria-disabled buttonVariants keep their resting tone during hover and active', () => {
  const quiet = buttonVariants({ variant: 'quiet' });
  const primary = buttonVariants({ variant: 'default' });

  assert.match(quiet, /aria-disabled:hover:bg-transparent/);
  assert.match(quiet, /aria-disabled:active:bg-transparent/);
  assert.match(quiet, /aria-disabled:hover:text-foreground-secondary/);
  assert.match(primary, /aria-disabled:hover:bg-primary/);
  assert.match(primary, /aria-disabled:active:bg-primary/);
});

test('legacy buttonVariants pill shape lands on the governed pill radius tier', () => {
  const pill = cn(buttonVariants({ size: 'icon', shape: 'pill' }));
  const resting = cn(buttonVariants({ size: 'icon' }));

  // rounded-full resolves to --radius-pill (999px) per the radius-converge
  // contract; tailwind-merge must drop the base rounded-sm so the pill wins.
  assert.match(pill, /\brounded-full\b/);
  assert.ok(!pill.includes('rounded-sm'), 'pill shape must override the base rounded-sm');
  assert.match(resting, /\brounded-sm\b/);
  assert.ok(!resting.includes('rounded-full'));
});

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
