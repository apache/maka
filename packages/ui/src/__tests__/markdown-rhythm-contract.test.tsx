/**
 * Transcript markdown rhythm contract.
 *
 * The defect #2348 fixed was not a wrong number — it was a wrong ORDER. Under
 * `density="compact"` list items sat ~10px apart (Astryx's List control row
 * padding, which `density` cannot reach from outside) while paragraphs sat 4px
 * apart, so items at the same level read as further apart than separate
 * paragraphs. Visual distance stopped tracking semantic distance.
 *
 * So the invariant is the ladder's ORDER, not its values: retuning a rung is a
 * design decision and stays green here, while list gaps meeting block gaps must
 * fail. And the table keys entirely on DOM Astryx generates at runtime —
 * `data-density`, `astryx-markdown-heading` + `data-level`, `astryx-list-item`.
 * None of those names exist in Maka source outside these selectors, so an
 * Astryx bump that renames one makes every rule stop matching with nothing
 * failing anywhere.
 *
 * Both halves live here on purpose. Split across two files they each stayed
 * green against the half they could not see, and the stylesheet half was the
 * one that got deleted (#2425), leaving styles.css citing a guard that no
 * longer existed.
 *
 * Deliberately NOT pinned, because they are how the table works rather than
 * what it promises: the adjacent-sibling gap form, the `hr` rung, the
 * ListItem padding reset, and the two heading size tiers.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownBody } from '../markdown-body.js';

const UI_SRC = resolve(import.meta.dirname, '..', '..', 'src');

/** The compact ladder, ordered from tightest (same level) to widest (chapter). */
const LADDER = ['--md-gap-list', '--md-gap-block', '--md-gap-section', '--md-gap-chapter'] as const;

/** `var(--space-N)` → N, the 4px-grid step count. Non-scale values return null. */
function spaceSteps(value: string): number | null {
  const match = /^var\(\s*--space-(\d+)\s*\)$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Comments carry the rung names in prose — the table's own header lists the
 * ladder and tells the next reader to "retune `--md-gap-block`" — so the usage
 * check below would pass on documentation alone without this.
 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

async function readUiStylesheet(): Promise<string> {
  return stripCssComments(await readFile(join(UI_SRC, 'styles.css'), 'utf8'));
}

async function tsxFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsxFiles(path)));
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) out.push(path);
  }
  return out;
}

const SAMPLE = ['## Heading two', '', 'A paragraph.', '', '1. First item', '2. Second item'].join('\n');

function compactMarkup(): string {
  return renderToStaticMarkup(<MarkdownBody text={SAMPLE} density="compact" />);
}

describe('transcript markdown rhythm', () => {
  it('declares the compact ladder in strictly increasing order', async () => {
    const css = await readUiStylesheet();
    const block = /\.astryx-markdown\[data-density="compact"\]\s*\{([^}]*)\}/.exec(css);
    assert.ok(block, 'no `.astryx-markdown[data-density="compact"]` custom-property block found');

    const declared = new Map<string, string>();
    for (const m of block[1].matchAll(/(--md-gap-[\w-]+)\s*:\s*([^;]+);/g)) {
      declared.set(m[1], m[2].trim());
    }

    const steps = LADDER.map((name) => {
      const value = declared.get(name);
      assert.ok(value, `${name} is not declared on the compact surface`);
      const n = spaceSteps(value);
      assert.ok(
        n !== null,
        `${name} is \`${value}\`; the ladder must stay on the --space-* scale so the ` +
          'order is comparable and a bare px value cannot drift off the 4px grid',
      );
      return { name, steps: n };
    });

    for (let i = 1; i < steps.length; i += 1) {
      const prev = steps[i - 1];
      const cur = steps[i];
      assert.ok(
        cur.steps > prev.steps,
        `${cur.name} (--space-${cur.steps}) must be strictly wider than ${prev.name} ` +
          `(--space-${prev.steps}). Visual distance has to rise with semantic distance: ` +
          'same-level list items closer than blocks, blocks closer than section breaks.',
      );
    }
  });

  /**
   * Declaration and usage are separate failures. Hardcode a gap and the ladder
   * above stays declared but unspent — the first test then asserts nothing
   * about the spacing anyone sees, and an inversion can be reintroduced
   * without failing anything.
   */
  it('spends every rung it declares', async () => {
    const css = await readUiStylesheet();
    for (const name of LADDER) {
      assert.match(
        css,
        new RegExp(String.raw`var\(\s*${name}\s*\)`),
        `${name} is declared but never read. A rule spending a literal instead leaves the ` +
          'ladder test green while the rendered spacing ignores it, which turns the whole ' +
          'table into decoration.',
      );
    }
  });

  it('emits the DOM hooks the rhythm table selects on', () => {
    const markup = compactMarkup();
    // Every rule in the table is prefixed with this, so it is the one hook
    // whose two halves — selector prefix and runtime attribute — nothing else
    // joins. Rename it and all compact spacing dies silently.
    assert.match(
      markup,
      /data-maka-contract="markdown"/,
      'the `data-maka-contract="markdown"` wrapper is gone. Every rule in the rhythm table ' +
        'is scoped on it, so all compact prose spacing and the heading scale are now dead.',
    );
    assert.match(
      markup,
      /<div[^>]*role="document"[^>]*data-density="compact"|<div[^>]*data-density="compact"[^>]*role="document"/,
      'the document root no longer carries `data-density="compact"`. Every rule in the ' +
        'rhythm table is scoped on it, so all compact prose spacing is now dead.',
    );
    assert.match(
      markup,
      /class="[^"]*\bastryx-markdown\b/,
      'the document root no longer carries the `astryx-markdown` class the table selects on',
    );
    assert.match(
      markup,
      /<h2[^>]*class="[^"]*\bastryx-markdown-heading\b/,
      'headings no longer carry `astryx-markdown-heading`; the transcript heading scale is dead',
    );
    assert.match(
      markup,
      /<h2[^>]*data-level="2"/,
      'headings no longer carry `data-level`. The table splits h1/h2 from h3-h6 on it, so ' +
        'without it every heading collapses to one tier — the exact defect #2348 replaced.',
    );
    assert.match(
      markup,
      /class="[^"]*\bastryx-list-item\b/,
      'list rows no longer carry `astryx-list-item`; the rule that spends their control-row ' +
        'padding no longer applies and list items revert to sitting wider apart than paragraphs',
    );
  });

  /**
   * The rhythm table carries the transcript's heading TYPOGRAPHY, not just its
   * spacing, and keys both on `density`. That is a deliberate bet, and it is a
   * bet: Astryx's density RFC (facebook/astryx#839) draws the line at "density
   * shifts heights and spacing, not typography", so the key is honest only
   * while `compact` and "transcript" name the same set. They do today — the
   * transcript is the only caller asking for compact, and the Daily Review
   * renders a document at the default.
   *
   * A separate surface attribute would decouple them, but nothing needs it yet
   * and it would add a prop to a public component for a caller that does not
   * exist. Guard the assumption instead: the moment a second surface asks for
   * compact markdown it silently inherits transcript heading sizes and dimmed
   * deep headings, and this is what tells whoever adds it that they have to
   * choose — inherit deliberately, or split the key then.
   */
  it('keeps compact markdown a transcript-only surface', async () => {
    const callers: string[] = [];
    for (const file of await tsxFiles(UI_SRC)) {
      const source = await readFile(file, 'utf8');
      // `<Markdown …>` opening tags only — not MarkdownBody's internal plumbing
      // and not the density Maka hands its own code-block renderers.
      for (const tag of source.matchAll(/<Markdown\s[^>]*?\/?>/gs)) {
        if (/density=(["'])compact\1/.test(tag[0])) callers.push(relative(UI_SRC, file));
      }
    }

    assert.deepEqual(
      [...new Set(callers)].sort(),
      ['chat-turn.tsx'],
      'a new caller renders markdown at compact density. The rhythm table treats ' +
        '`density="compact"` as "this is a transcript" and gives it flattened heading sizes ' +
        'plus secondary-colour h4-h6 — typography, which Astryx\'s density is explicitly not ' +
        'supposed to carry (facebook/astryx#839). Either that is what the new surface wants, ' +
        'and this list grows, or the typography rules need their own key. ' +
        `Found: ${JSON.stringify([...new Set(callers)].sort())}`,
    );
  });
});
