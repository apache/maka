/**
 * Segmented control chrome governance (PR #1128).
 *
 * The `.maka-segmented` recipe (shared by the sidebar view-mode toggle,
 * daily-review range tabs, and the usage/appearance settings pages) has
 * exactly one home: `styles/segmented.css`. It must keep its interaction
 * states (the original chrome had none) and sit on the ui type tier
 * (controls are 13px chrome per the #546 scale — the 11px caption size
 * was a leftover from the recipe's settings-page origin). Location is
 * asserted against the file itself, not the concatenated import graph,
 * so the recipe cannot silently migrate into another surface file.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';
import { stripCssComments } from './css-test-helpers.js';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const RENDERER = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer');

describe('segmented control chrome contract', () => {
  it('owns the full recipe in styles/segmented.css, wired into the entry file', async () => {
    const recipe = stripCssComments(await readFile(resolve(RENDERER, 'styles', 'segmented.css'), 'utf8'));

    const rootRule = recipe.match(/\.maka-segmented\s*\{[^}]*\}/)?.[0] ?? '';
    // The track is one unbroken switch: it neither folds across rows nor
    // shrinks below its content (the label stack beside it absorbs the
    // squeeze, and below 460px the whole row stacks). Wrapping produced a
    // ragged two-row plate in the en locale.
    assert.match(rootRule, /flex-wrap:\s*nowrap/, 'the segmented track never folds across rows');
    assert.match(rootRule, /flex:\s*0 0 auto/, 'the track keeps its intrinsic width; the label wraps instead');
    // Concentric with the app radius scale — a 999px pill read as a foreign
    // shape beside the 6px fields it shares a settings card with.
    assert.match(rootRule, /border-radius:\s*var\(--radius-surface\)/, 'track sits on the surface radius tier');
    assert.doesNotMatch(rootRule, /--radius-pill/, 'the pill radius is off the concentric scale');

    const buttonRule = recipe.match(/\.maka-segmented button\s*\{[^}]*\}/)?.[0] ?? '';
    assert.match(buttonRule, /font-size:\s*var\(--font-size-ui\)/, 'controls sit on the ui tier, not caption');
    assert.match(buttonRule, /white-space:\s*nowrap/, 'labels never break inside a button');
    assert.match(
      buttonRule,
      /border-radius:\s*var\(--radius-control\)/,
      'segment buttons sit one tier in from the track, keeping the curves concentric',
    );
    assert.match(buttonRule, /transition:/);
    assert.match(recipe, /\.maka-segmented button:enabled:hover:not\(\[data-pressed\]\)/);
    assert.match(recipe, /\.maka-segmented button:enabled:active:not\(\[data-pressed\]\)/);
    assert.match(recipe, /\.maka-segmented button:focus-visible/);
    assert.match(recipe, /\.maka-segmented button\[data-pressed\]/);
    assert.match(recipe, /\.maka-segmented button:disabled\s*\{[^}]*opacity:\s*var\(--opacity-disabled\)/);

    const entry = await readFile(resolve(RENDERER, 'styles.css'), 'utf8');
    assert.match(entry, /@import "\.\/styles\/segmented\.css";/);
  });

  it('keeps the recipe out of every other renderer stylesheet', async () => {
    const combined = await readRendererContractCss();
    // The full effective CSS must not resurrect the settings-scoped name.
    assert.doesNotMatch(combined, /\.settingsSegmented/);

    // No second .maka-segmented rule block outside styles/segmented.css:
    // count rule occurrences in the combined CSS against the recipe file.
    const recipe = stripCssComments(await readFile(resolve(RENDERER, 'styles', 'segmented.css'), 'utf8'));
    const count = (s: string) => (s.match(/\.maka-segmented[^,{]*\{/g) ?? []).length;
    assert.equal(
      count(stripCssComments(combined)),
      count(recipe),
      'a .maka-segmented rule exists outside styles/segmented.css',
    );
  });
});
