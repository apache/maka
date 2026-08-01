import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('settings navigation delegates grouping and row interaction to Astryx SideNav', () => {
  const source = read('apps/desktop/src/renderer/settings/settings-surface.tsx');

  for (const component of ['SideNav', 'SideNavSection', 'SideNavItem', 'Badge']) {
    assert.match(source, new RegExp(`\\b${component}\\b`));
  }
  assert.doesNotMatch(source, /\bBaseButton\b/);
  assert.doesNotMatch(source, /settingsNav(?:Group|GroupLabel|Item|Glyph|Badge)/);

  const css = read('apps/desktop/src/renderer/styles/settings/nav-sidebar.css');
  assert.doesNotMatch(css, /\.settingsNav(?:Group|GroupLabel|Item|Glyph|Badge)\b/);
});

test('settings navigation collapses through the Astryx API at the narrow window floor', () => {
  const source = read('apps/desktop/src/renderer/settings/settings-surface.tsx');
  const css = read('apps/desktop/src/renderer/styles/settings/form.css');

  assert.match(source, /useMediaQuery\(NARROW_SETTINGS_QUERY\)/);
  assert.match(source, /collapsible=\{\{[\s\S]*?isCollapsed: isNarrowSettings/);
  assert.match(source, /<LayoutPanel[\s\S]*?width=\{isNarrowSettings \? 48 : 260\}/);
  assert.doesNotMatch(source, /useSyncExternalStore|subscribeToNarrowSettings/);
  assert.doesNotMatch(css, /@media \(max-width: 760px\)|grid-template-columns/);
});
