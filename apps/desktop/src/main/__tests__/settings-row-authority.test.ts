import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('read-only settings rows use Astryx Item named props', () => {
  const source = read('apps/desktop/src/renderer/settings/settings-rows.tsx');

  assert.doesNotMatch(source, /export function SettingsRows/);
  assert.match(source, /import\s+\{[^}]*\bItem\b[^}]*\}\s+from '@astryxdesign\/core'/s);
  assert.match(source, /<Item\b/);
  assert.match(source, /\blabel=\{props\.title\}/);
  assert.match(source, /\bdescription=\{props\.detail\}/);
  assert.match(source, /\bendContent=/);
  assert.doesNotMatch(source, /className="settingsRow"/);
});

test('horizontal setting controls use Astryx Item slots', () => {
  for (const rel of [
    'apps/desktop/src/renderer/settings/general-settings-page.tsx',
    'apps/desktop/src/renderer/settings/memory-settings-page.tsx',
    'apps/desktop/src/renderer/settings/daily-review-settings-page.tsx',
    'apps/desktop/src/renderer/settings/web-search-settings-page.tsx',
  ]) {
    const source = read(rel);
    assert.match(source, /import\s+\{[^}]*\bItem\b[^}]*\}\s+from '@astryxdesign\/core'/s);
    assert.match(source, /<Item\b/);
    assert.doesNotMatch(source, /className="settings(?:Form)?Row\b/);
  }

  const css = read('apps/desktop/src/renderer/styles/settings/rows.css');
  assert.doesNotMatch(css, /\.settingsRow\b|\.settingsFormRow\b/);
});

test('MCP server entities use Astryx Item slots and supporting-text status', () => {
  const source = read('apps/desktop/src/renderer/mcp-page.tsx');
  const css = read('apps/desktop/src/renderer/styles/module-pages/mcp.css');

  assert.match(source, /<Item[\s\S]*?className="maka-mcp-server-summary"/);
  assert.match(source, /\blabel=/);
  assert.match(source, /\bdescription=/);
  assert.match(source, /\bendContent=/);
  assert.doesNotMatch(source, /maka-mcp-status-dot/);
  assert.doesNotMatch(css, /\.maka-mcp-status-dot\b/);
});
