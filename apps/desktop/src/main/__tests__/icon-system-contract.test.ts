import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';

// Chrome icon-size contract (PR-ICON-SCALE).
//
// The hand-rolled desktop chrome routes nav glyphs through one `--icon-size`
// token. Shared actions use Astryx Button/IconButton geometry. Deliberately
// small dense-meta icons (12-14px)
// and large hero/emphasis icons (20px+) stay set at their call sites — they are
// intentional, not drift, so this contract does NOT flatten them, and it
// explicitly forbids reintroducing a blanket `svg.lucide { width }` rule that
// would silently resize every icon in the app.

const rendererDir = join(process.cwd(), 'src', 'renderer');
const repoRoot = resolve(process.cwd(), '..', '..');

function ruleBody(css: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1];
}

describe('icon system contract (single chrome size token)', () => {
  it('defines --icon-size as the chrome glyph token', async () => {
    const tokens = await readFile(join(rendererDir, 'maka-tokens.css'), 'utf8');
    assert.match(tokens, /--icon-size:\s*16px/, 'chrome icon size token = 16px');
  });

  it('routes nav glyphs through the token, not hardcoded px', async () => {
    const styles = await readRendererContractCss();
    // PR-DELETE-ORPHAN-CSS: `.maka-nav-primary-icon` was an orphan
    // class (no TSX consumer); deleted alongside the dead CSS sweep.
    // The icon-token check now covers `.maka-nav-icon` and the
    // `.maka-nav-row` column track, which is what actually renders.
    const navIcon = ruleBody(styles, '.maka-nav-icon');
    const navRow = ruleBody(styles, '.maka-nav-row');
    assert.ok(navIcon && navRow, 'nav rules must exist');
    assert.match(navIcon, /width:\s*var\(--icon-size\)/);
    assert.match(navIcon, /height:\s*var\(--icon-size\)/);
    assert.doesNotMatch(navIcon, /\b(width|height):\s*\d+px/, '.maka-nav-icon must not re-hardcode px');
    assert.match(navRow, /grid-template-columns:\s*var\(--icon-size\)/, 'nav-row glyph column tracks the token');
  });

  it('keeps every .maka-nav-icon selector free of px sizes and color (PR-ICON-CHROME-CONSISTENCY)', async () => {
    const styles = await readRendererContractCss();
    // The gear once carried a qualified 18px + currentColor override
    // (`.maka-sidebar-settings-button .maka-nav-icon`), and the base rule
    // carried `color: var(--muted-foreground)` — unlayered CSS that
    // silently beat the tone/active color utilities in
    // session-sidebar-nav.tsx. Geometry belongs to the token; color
    // belongs to the component variants.
    const rules = [...styles.matchAll(/([^{}]*\.maka-nav-icon[^{}]*)\{([^}]*)\}/g)];
    assert.ok(rules.length > 0, 'the .maka-nav-icon base rule must exist');
    for (const [, selector, body] of rules) {
      const sel = selector.trim().replace(/\s+/g, ' ');
      for (const [, prop, value] of body.matchAll(/(?<!-)\b(width|height)\s*:\s*([^;]+)/g)) {
        assert.equal(
          value.trim(),
          'var(--icon-size)',
          `\`${sel}\` ${prop} must be exactly var(--icon-size), got \`${value.trim()}\``,
        );
      }
      assert.ok(
        !/(?<!-)\bcolor\s*:/.test(body),
        `\`${sel}\` must not declare color — glyph color is owned by the component variants`,
      );
    }
  });

  it('locks the nav glyph color model in the component variants (PR-ICON-CHROME-CONSISTENCY)', async () => {
    const nav = await readFile(
      join(repoRoot, 'packages', 'ui', 'src', 'session-sidebar-nav.tsx'),
      'utf8',
    );
    // The darwin glass override (theme-glass.css) forces nav-row TEXT to
    // full foreground, so glyphs must be tinted directly, not inherit:
    // 80%-ink base (same tone as the titlebar icon actions), elevated to
    // foreground on the active row. Without these utilities the icons
    // silently follow the row color and go full-black on macOS.
    assert.match(
      nav,
      /\[&_\.maka-nav-icon\]:text-\[var\(--foreground-secondary\)\]/,
      'nav glyphs must pin to the 80%-ink chrome tone in the variants base',
    );
    assert.match(
      nav,
      /data-\[active=true\]:\[&_\.maka-nav-icon\]:text-foreground/,
      'active rows must elevate the glyph to full foreground',
    );
  });

  it('keeps the settings gear on the shared nav glyph column (PR-ICON-CHROME-CONSISTENCY)', async () => {
    const styles = await readRendererContractCss();
    const settings = ruleBody(styles, '.maka-sidebar-settings-button');
    assert.ok(settings, 'the settings button rule must exist');
    assert.match(
      settings!,
      /grid-template-columns:\s*var\(--icon-size\)/,
      'settings gear column tracks --icon-size so it shares the nav rows\' icon axis',
    );
  });

  it('unifies lucide stroke weight through one governed rule (D5)', async () => {
    const styles = await readRendererContractCss();
    const blanket = ruleBody(styles, 'svg.lucide');
    assert.ok(blanket, 'the global svg.lucide stroke governance rule must exist');
    assert.match(
      blanket!,
      /stroke-width:\s*1\.75/,
      'all lucide glyphs render at one stroke weight (1.75) — call-site strokeWidth props are overridden by design',
    );
  });

  it('forbids a blanket svg.lucide size rule (no app-wide resize hammer)', async () => {
    const styles = await readRendererContractCss();
    const blanket = ruleBody(styles, 'svg.lucide');
    assert.ok(
      // (?<!-) so the governed `stroke-width` rule doesn't false-positive.
      !blanket || !/(?<!-)\b(width|height)\s*:/.test(blanket),
      'a global `svg.lucide { width/height }` rule would silently resize every '
        + 'icon, including intentional 11-14px dense glyphs — it must not exist',
    );
  });

});
