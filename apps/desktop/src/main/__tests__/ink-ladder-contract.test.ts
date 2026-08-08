import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';

/**
 * The ink ladder's aliasing invariant (visual system 2.0, T1).
 *
 * `--foreground-dimmed` and `--foreground-secondary` were both written as
 * "80% ink", but one mixed in srgb and the other in oklch, so the same words
 * produced two different colours — 10.51:1 against 12.01:1, measured. That is
 * the failure this pins: not a wrong value, but a SECOND definition of one
 * tier that drifted because nothing said the two had to agree.
 *
 * Asserted on the source text rather than a rendered page because the point is
 * that dimmed has no independent definition to drift from. A screenshot would
 * only prove they happen to match today.
 */
const TOKENS_PATH = join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'maka-tokens.css');

describe('ink ladder', () => {
  it('keeps --foreground-dimmed an alias, never its own mix', async () => {
    const css = await readFile(TOKENS_PATH, 'utf8');
    const declarations = [...css.matchAll(/^\s*--foreground-dimmed:\s*([^;]+);/gm)].map(
      (match) => match[1].trim(),
    );

    assert.ok(declarations.length > 0, '--foreground-dimmed must still be defined');
    for (const value of declarations) {
      assert.equal(
        value,
        'var(--foreground-secondary)',
        'dimmed is the secondary tier under another name; giving it its own color-mix is how the two drifted apart before',
      );
    }
  });

  it('derives every ink tier in one colour space', async () => {
    const css = await readFile(TOKENS_PATH, 'utf8');
    // A tier mixed in srgb while its siblings mix in oklch is the exact defect
    // above, and it is invisible in review because the percentages match.
    const srgbInk = [...css.matchAll(/^\s*(--[a-z-]*foreground[a-z-]*):\s*color-mix\(in srgb[^;]*;/gm)];
    assert.deepEqual(
      srgbInk.map((match) => match[1]),
      [],
      'ink tiers derive in oklch; an srgb mix gives the same words a different colour',
    );
  });
});
