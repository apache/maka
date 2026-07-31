import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('read-only settings rows use Astryx Item named props', () => {
  const source = read('apps/desktop/src/renderer/settings/settings-rows.tsx');

  assert.match(source, /import\s+\{[^}]*\bItem\b[^}]*\}\s+from '@astryxdesign\/core'/s);
  assert.match(source, /<Item\b/);
  assert.match(source, /\blabel=\{props\.title\}/);
  assert.match(source, /\bdescription=\{props\.detail\}/);
  assert.match(source, /\bendContent=/);
  assert.doesNotMatch(source, /className="settingsRow"/);
});
