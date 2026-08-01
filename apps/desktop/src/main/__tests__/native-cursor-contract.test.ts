/**
 * Contract: one product sheet owns the native-cursor convention.
 *
 * Hand cursor = links only. Astryx StyleX sets pointer on buttons/options;
 * styles/native-cursor.css restores default with !important in that sheet
 * only — no per-control cursor patches.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  REPO_ROOT,
  readAllRendererCss,
  stripCssComments,
} from './css-test-helpers.js';

const NATIVE_CURSOR_CSS = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/styles/native-cursor.css',
);
const STYLES_ENTRY = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/styles.css',
);
const MODEL_SWITCHER_CSS = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/styles/model-switcher.css',
);

describe('native-cursor convention', () => {
  it('ships a single maka.legacy sheet that defaults interactive roles and keeps pointer on links', async () => {
    const sheet = stripCssComments(await readFile(NATIVE_CURSOR_CSS, 'utf8'));
    const entry = await readFile(STYLES_ENTRY, 'utf8');

    assert.match(
      entry,
      /native-cursor\.css"\s+layer\(maka\.legacy\)/,
      'native-cursor.css must load in maka.legacy (above astryx-components)',
    );

    assert.match(
      sheet,
      /:where\([\s\S]*button[\s\S]*\[role="option"\][\s\S]*\)[\s\S]*cursor:\s*default\s*!important/,
      'interactive roles must set cursor: default !important',
    );
    assert.match(
      sheet,
      /:where\([\s\S]*\blabel\b[\s\S]*\[role="treeitem"\][\s\S]*\)[\s\S]*cursor:\s*default\s*!important/,
      'FieldLabel and TreeList rows must neutralize Astryx pointer',
    );
    assert.match(
      sheet,
      /:where\([\s\S]*a\[href\][\s\S]*\[role="link"\][\s\S]*\)[\s\S]*cursor:\s*pointer\s*!important/,
      'links must keep cursor: pointer !important',
    );
    // Selector trigger shell: StyleX pointer is on the outer .astryx-selector
    // div; chevron is a sibling of the inner button (not covered by button rules).
    assert.match(
      sheet,
      /\.astryx-selector[\s\S]*cursor:\s*default\s*!important/,
      'Astryx Selector shell must be neutralized (model / thinking pickers)',
    );
  });

  it('forbids per-control cursor: default !important patches outside native-cursor.css', async () => {
    const all = stripCssComments(await readAllRendererCss());
    const native = stripCssComments(await readFile(NATIVE_CURSOR_CSS, 'utf8'));
    const outside = all.replace(native, '');
    const patches = outside.match(/cursor:\s*default\s*!important/g) ?? [];
    assert.equal(
      patches.length,
      0,
      'cursor: default !important belongs only in styles/native-cursor.css',
    );
  });

  it('keeps thinking trigger content-sized (geometry only; cursor is global)', async () => {
    const css = stripCssComments(await readFile(MODEL_SWITCHER_CSS, 'utf8'));
    assert.match(
      css,
      /\.maka-thinking-level-selector[\s\S]*?width:\s*max-content/,
      'thinking trigger must size to content',
    );
    assert.doesNotMatch(
      css,
      /\.maka-thinking-level-selector\s*\{[^}]*width:\s*\d+px/,
      'thinking trigger must not use a fixed px width',
    );
  });
});
