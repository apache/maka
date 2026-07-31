/**
 * PR-FE-BUG-HUNT-9 (kenji audit reminder 9, finding #4):
 * lock the z-index vocabulary in styles.css so future PRs can't
 * silently drift back to arbitrary bare digits.
 *
 * Rule: every `z-index: <bare integer>;` site in styles.css must
 * either (a) be a `var(--z-*)` reference, or (b) be on the explicit
 * `BARE_ALLOWLIST` below — meaning the bare value is intentional,
 * local-stacking-only, and reviewers acknowledged it as part of
 * this contract.
 *
 * Adding a new bare site without updating the allowlist will fail
 * this test. That's the point.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, readAllRendererCss, stripCssComments } from './css-test-helpers.js';

/** Sites where a bare integer z-index is intentional. Local stacking
 *  inside a single container, no global side-effects. Each entry is
 *  a substring of a styles.css selector that uniquely identifies the
 *  rule containing the bare z-index. */
const BARE_ALLOWLIST: ReadonlyArray<{ selector: string; value: number; reason: string }> = [
  {
    selector: '.maka-skill-featured-art span:nth-child(2)',
    value: 2,
    reason: 'decorative sticker stack — 3 spans inside a fixed container, no escape',
  },
];

describe('PR-FE-BUG-HUNT-9 z-index contract', () => {
  it('every bare `z-index: <integer>` in renderer CSS is either tokenized or explicitly allowlisted', async () => {
    const stripped = stripCssComments(await readAllRendererCss());

    // Find all bare integer z-index occurrences. Skip `var(...)`.
    const bareMatches = [...stripped.matchAll(/z-index:\s*(\d+)\s*;/g)];

    // Each match: walk back to the nearest selector header `{` to
    // identify what rule it lives in.
    const violations: Array<{ value: number; nearby: string }> = [];

    for (const match of bareMatches) {
      const idx = match.index ?? 0;
      const value = Number(match[1]);

      // Heuristic: the nearest `{` looking backwards bounds this rule.
      // Take ~200 chars before that `{` to capture the selector.
      const beforeBrace = stripped.lastIndexOf('{', idx);
      if (beforeBrace === -1) continue;
      const selectorWindow = stripped.slice(Math.max(0, beforeBrace - 200), beforeBrace);
      const lastSelectorStart = Math.max(
        selectorWindow.lastIndexOf('}'),
        selectorWindow.lastIndexOf(';'),
        -1,
      );
      const selector = selectorWindow.slice(lastSelectorStart + 1).trim();

      const allowed = BARE_ALLOWLIST.some(
        (entry) => selector.includes(entry.selector) && entry.value === value,
      );
      if (!allowed) {
        violations.push({ value, nearby: selector.slice(-160) });
      }
    }

      assert.deepEqual(
      violations,
      [],
      `Found bare z-index sites not on the allowlist. Either tokenize the value (use one of --z-* in maka-tokens.css) or add an entry to BARE_ALLOWLIST with a justification. Sites: ${JSON.stringify(violations, null, 2)}`,
    );
  });

  it('every allowlisted bare z-index is actually present in renderer CSS', async () => {
    const stripped = stripCssComments(await readAllRendererCss());
    for (const entry of BARE_ALLOWLIST) {
      const selectorIdx = stripped.indexOf(entry.selector);
      assert.notEqual(
        selectorIdx,
        -1,
        `Allowlist entry's selector \`${entry.selector}\` is no longer in renderer CSS. Remove the stale entry from BARE_ALLOWLIST.`,
      );
      const ruleBlock = stripped.slice(selectorIdx, selectorIdx + 600);
      assert.match(
        ruleBlock,
        new RegExp(`z-index:\\s*${entry.value}\\s*;`),
        `Allowlist entry for \`${entry.selector}\` expects bare \`z-index: ${entry.value};\` but it's no longer there. Remove the stale entry from BARE_ALLOWLIST.`,
      );
    }
  });

  it('semantic z-* tokens stay defined in maka-tokens.css', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    const required = [
      '--z-base',
      '--z-sticky',
      '--z-titlebar',
      '--z-panel',
      '--z-dropdown',
      '--z-tooltip',
      '--z-modal',
      '--z-overlay',
      '--z-panel-action',
      '--z-settings-fullpage',
    ];
    for (const name of required) {
      assert.match(
        tokens,
        new RegExp(`${name}:\\s*\\d+\\s*;`),
        `Token ${name} missing from maka-tokens.css. PR-FE-BUG-HUNT-9 z-index contract requires these tokens to exist.`,
      );
    }
  });

  it('removes the retired Select positioner layer now that Astryx uses the native top layer', async () => {
    const stripped = stripCssComments(await readAllRendererCss());
    assert.doesNotMatch(stripped, /\.settingsSelectPositioner\s*\{/, 'the Base UI Select positioner recipe must be deleted');
  });

  it('Select and Combobox are Astryx-backed with no Base UI or z-layer pin', async () => {
    const [ui, index, permissionMode, modelPicker] = await Promise.all([
      readFile(resolve(REPO_ROOT, 'packages', 'ui', 'src', 'ui.tsx'), 'utf8'),
      readFile(resolve(REPO_ROOT, 'packages', 'ui', 'src', 'index.ts'), 'utf8'),
      readFile(resolve(REPO_ROOT, 'packages', 'ui', 'src', 'permission-mode-menu.tsx'), 'utf8'),
      readFile(resolve(REPO_ROOT, 'packages', 'ui', 'src', 'model-picker.tsx'), 'utf8'),
    ]);
    const source = `${ui}\n${index}\n${permissionMode}\n${modelPicker}`;
    assert.doesNotMatch(source, /@base-ui\/react\/(?:select|combobox)/);
    assert.match(source, /@astryxdesign\/core\/Selector/);
    assert.match(modelPicker, /@astryxdesign\/core\/Popover/);
    assert.doesNotMatch(source, /z-\[var\(--z-overlay\)\]/);
  });

  it('removes the generic Maka Popover shell after its TimePicker consumer is deleted', async () => {
    const ui = await readFile(
      resolve(REPO_ROOT, 'packages', 'ui', 'src', 'ui.tsx'),
      'utf8',
    );
    assert.doesNotMatch(ui, /@(?:base-ui\/react|astryxdesign\/core)\/Popover/);
    assert.doesNotMatch(ui, /Popover(?:Root|Trigger|Portal|Positioner|Popup)/);
  });
});
