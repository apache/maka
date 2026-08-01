import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('settings delegate shell geometry and scrolling to Astryx Layout', () => {
  const surfaceSource = read('apps/desktop/src/renderer/settings/settings-surface.tsx');
  const formCss = read('apps/desktop/src/renderer/styles/settings/form.css');
  const navCss = read('apps/desktop/src/renderer/styles/settings/nav-sidebar.css');
  const rowsCss = read('apps/desktop/src/renderer/styles/settings/rows.css');

  assert.match(surfaceSource, /Layout,\s*LayoutContent,\s*LayoutHeader,\s*LayoutPanel/);
  assert.match(surfaceSource, /const isNarrowSettings = useMediaQuery\(NARROW_SETTINGS_QUERY\)/);
  assert.match(surfaceSource, /contentWidth=\{640\}/);
  assert.match(surfaceSource, /<LayoutPanel[\s\S]*?width=\{isNarrowSettings \? 48 : 260\}/);
  assert.match(surfaceSource, /<LayoutContent padding=\{6\}/);
  assert.doesNotMatch(surfaceSource, /OverlayScrollArea|useSyncExternalStore|subscribeToNarrowSettings/);
  assert.doesNotMatch(formCss, /grid-template-columns:\s*260px|@media\s*\(max-width:\s*760px\)/);
  assert.doesNotMatch(navCss, /settingsPageContent(?:Viewport|Inner)|calc\(\(100% - 640px\)/);
  assert.doesNotMatch(rowsCss, /min-height:\s*72px/);
});
