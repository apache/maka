import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('settings use a 640px form column without the retired 72px row density', () => {
  const navCss = read('apps/desktop/src/renderer/styles/settings/nav-sidebar.css');
  const rowsCss = read('apps/desktop/src/renderer/styles/settings/rows.css');

  assert.match(navCss, /\.settingsPageContentInner\s*\{[^}]*max-width:\s*640px/s);
  assert.match(navCss, /calc\(\(100% - 640px\)/);
  assert.doesNotMatch(navCss, /768px/);
  assert.doesNotMatch(rowsCss, /min-height:\s*72px/);
});
