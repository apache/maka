import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('provider advanced settings delegate disclosure behavior to Astryx Collapsible', () => {
  const source = read('apps/desktop/src/renderer/settings/provider-connection-detail.tsx');

  assert.match(source, /\bCollapsible\b/);
  assert.match(source, /<Collapsible\b[^>]*defaultIsOpen=\{false\}/s);
  assert.doesNotMatch(source, /<(?:details|summary)\b/);
  assert.doesNotMatch(source, /\bBaseButton\b/);

  const css = read('apps/desktop/src/renderer/styles/settings/provider-editor.css');
  assert.doesNotMatch(css, /\.providerAdvancedSettings\s+summary\b/);
});

test('MCP diagnostics and advanced fields delegate disclosure behavior to Astryx Collapsible', () => {
  const source = read('apps/desktop/src/renderer/mcp-page.tsx');

  assert.match(source, /\bCollapsible\b/);
  assert.doesNotMatch(source, /<(?:details|summary)\b/);

  const css = read('apps/desktop/src/renderer/styles/module-pages/mcp.css');
  assert.doesNotMatch(css, /\.maka-mcp-(?:server-details|advanced)\s+summary\b/);
});
