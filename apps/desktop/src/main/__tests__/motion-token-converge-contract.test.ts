/**
 * PR-MOTION-TOKEN-CONVERGE-0 (kenji's category 4, 2026-06-24):
 * lock the motion vocabulary so individual PRs can't silently drift
 * back to ad-hoc easing / `transition: all`.
 *
 * Three invariants:
 *
 * 1. `cubic-bezier(0.16, 1, 0.3, 1)` (the project's canonical out-strong
 *    curve) MUST be referenced via `var(--ease-out-strong)` — only the
 *    token definition in `maka-tokens.css` is allowed to spell the raw
 *    curve. Bare uses in styles.css drift visually and require an
 *    apparent-but-unobvious update when the curve gets retuned.
 *
 * 2. `transition: all` is banned everywhere. It animates properties
 *    that shouldn't move (layout, color, transform together) and
 *    triggers compositor-heavy reflows. Enumerate the properties.
 *
 * 3. `--duration-{quick,base,emphasized,large}` tokens are defined in
 *    `maka-tokens.css`. This test pins the names so a rename gets
 *    flagged at the test layer before any styles.css site drifts.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, readAllRendererCss, stripCssComments, stripKeyframes, assertCustomPropPinnedOnce } from './css-test-helpers.js';

describe('PR-MOTION-TOKEN-CONVERGE-0 contract', () => {
  it('bare cubic-bezier(0.16, 1, 0.3, 1) appears ONLY in the --ease-out-strong token declaration', async () => {
    // Self-review: the original test only scanned styles.css, so
    // bare curves in maka-tokens.css itself slipped through (one site
    // at maka-tokens.css:1017 transition rule). Now we scan BOTH
    // files; the only allowed site is the `--ease-out-strong: <curve>;`
    // token declaration line itself (which we whitelist by stripping
    // it before counting).
    const RAW_CURVE = /cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\)/g;
    const TOKEN_DECL = /--ease-out-strong:\s*cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\)\s*;?/g;

    // `readAllRendererCss()` expands `@import` chains, so the styles
    // blob now includes maka-tokens.css — including the legitimate
    // `--ease-out-strong: cubic-bezier(0.16, 1, 0.3, 1);` declaration
    // line. Strip that one declaration before counting so the token
    // file's own definition doesn't trip the bare-curve assertion.
    const styles = stripCssComments(await readAllRendererCss()).replace(TOKEN_DECL, '');
    const stylesMatches = styles.match(RAW_CURVE) ?? [];
    assert.equal(
      stylesMatches.length,
      0,
      `renderer CSS must not spell the canonical curve directly — use var(--ease-out-strong). Found ${stylesMatches.length} site(s).`,
    );

    const tokensRaw = await readFile(TOKENS_FILE, 'utf8');
    assert.match(
      tokensRaw,
      /--ease-out-strong:\s*cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\)/,
      '--ease-out-strong must be defined in maka-tokens.css with the canonical curve.',
    );

    // Strip the token declaration site + comments before scanning;
    // any remaining bare curve is a violation in the tokens file too.
    const tokens = stripCssComments(tokensRaw).replace(TOKEN_DECL, '');
    const tokensMatches = tokens.match(RAW_CURVE) ?? [];
    assert.equal(
      tokensMatches.length,
      0,
      `maka-tokens.css must not spell the canonical curve directly outside the --ease-out-strong declaration — use var(--ease-out-strong). Found ${tokensMatches.length} site(s).`,
    );
  });

  it('`transition: all` is banned in renderer CSS — properties must be enumerated', async () => {
    const styles = stripCssComments(await readAllRendererCss());
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    for (const [name, body] of [['renderer CSS', styles] as const, ['maka-tokens.css', tokens] as const]) {
      const matches = body.match(/transition:\s*all\b/g) ?? [];
      assert.equal(
        matches.length,
        0,
        `${name} must not use \`transition: all\` — enumerate the properties (e.g. \`transition: background 150ms var(--ease-out-strong), color 150ms var(--ease-out-strong)\`).`,
      );
    }
  });

  it('Tailwind `transition-all` is banned in @maka/ui primitives', async () => {
    // PR-FE-BUG-HUNT-0 (kenji bug-hunt 2026-06-24): the previous
    // checks only scanned renderer CSS files. shadcn primitives use
    // Tailwind class strings that don't show up there. Three sites
    // were caught (command/sheet overlays + sidebar rail) where
    // `transition-all` animates every changing property — including
    // layout-trigger ones like width/transform/etc. — instead of
    // just the `opacity` / `transform` that actually animates.
    // Enumerate the moving properties: `transition-opacity`,
    // `transition-[transform,opacity]`, etc.
    const { readdir } = await import('node:fs/promises');
    const offenders: string[] = [];
    async function walk(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && /\.(tsx|ts)$/.test(entry.name)) {
          const src = await readFile(full, 'utf8');
          if (/\btransition-all\b/.test(src)) {
            offenders.push(full.replace(REPO_ROOT + '/', ''));
          }
        }
      }
    }
    await walk(resolve(REPO_ROOT, 'packages/ui/src/primitives'));
    await walk(resolve(REPO_ROOT, 'apps/desktop/src/renderer'));
    assert.deepEqual(
      offenders,
      [],
      `\`transition-all\` is banned. Enumerate the moving properties (e.g. \`transition-opacity\` or \`transition-[transform,opacity]\`):\n  ${offenders.join('\n  ')}`,
    );
  });

  it('--duration-{quick,base,emphasized,large} + --scale-{press,hover} + --lift-hover tokens are declared exactly once with pinned values', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assertCustomPropPinnedOnce(tokens, '--duration-quick', '120ms');
    assertCustomPropPinnedOnce(tokens, '--duration-base', '150ms');
    assertCustomPropPinnedOnce(tokens, '--duration-emphasized', '180ms');
    assertCustomPropPinnedOnce(tokens, '--duration-large', '280ms');
    assertCustomPropPinnedOnce(tokens, '--scale-press', '0.96');
    assertCustomPropPinnedOnce(tokens, '--scale-hover', '1.03');
    assertCustomPropPinnedOnce(tokens, '--lift-hover', '-1px');
  });

  it('--ease-out-strong / --ease-in-out-strong / --ease-drawer / --ease-linear tokens are defined', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assert.match(tokens, /--ease-out-strong:\s*cubic-bezier/);
    assert.match(tokens, /--ease-in-out-strong:\s*cubic-bezier/);
    assert.match(tokens, /--ease-drawer:\s*cubic-bezier/);
    assert.match(tokens, /--ease-linear:\s*linear/);
  });

  // Single longest-match-first matcher. Using one regex with matchAll
  // means `ease-in-out` is reported once as `ease-in-out` (not also as
  // `ease-in`), and `ease-linear` (a Tailwind class that compiles to
  // `transition-timing-function: linear`) is caught explicitly. Token
  // declarations (`--ease-out-strong:`) and Tailwind arbitrary values
  // (`ease-[var(--ease-out-strong)]`) are safe: the lookbehind/lookahead
  // `(?<![\w-])` / `(?![\w-])` reject the surrounding hyphens.
  //
  // The `--ease-linear: linear;` declaration itself is stripped before
  // scanning (same pattern as the it1 `--ease-out-strong` declaration).
  // `linear` for infinite-loop animations (spinners, shimmer) goes
  // through `var(--ease-linear)` — no whitelist, no per-line/per-segment
  // exemption, so there is no bypass vector.
  const TIMING_KEYWORD = /(?<![\w-])(ease-in-out|ease-linear|ease-in|ease-out|ease|linear)(?![\w-])/g;
  const EASE_LINEAR_DECL = /--ease-linear:\s*linear\s*;?/g;

  function scanBareTimingKeywords(src: string, label: string): string[] {
    const offenders: string[] = [];
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const m of line.matchAll(TIMING_KEYWORD)) {
        offenders.push(`${label}:${i + 1}: bare \`${m[1]}\``);
      }
    }
    return offenders;
  }

  it('bare ease/linear timing keywords are banned — use var(--ease-*) tokens', async () => {
    // PR-MOTION-TOKEN-CONVERGE-1 (#430 PR1): the four easing tokens
    // (--ease-out-strong / --ease-in-out-strong / --ease-drawer /
    // --ease-linear) are the single source of truth. Any bare
    // `ease` / `ease-in` / `ease-out` / `ease-in-out` / `ease-linear` /
    // `linear` drifts visually and can't be retuned in one place.
    // Infinite-loop animations use `var(--ease-linear)`.
    const offenders: string[] = [];
    offenders.push(
      ...scanBareTimingKeywords(
        stripCssComments(await readAllRendererCss()).replace(EASE_LINEAR_DECL, ''),
        'renderer CSS',
      ),
    );

    const { readdir } = await import('node:fs/promises');
    async function walk(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && /\.(tsx|ts)$/.test(entry.name)) {
          // Strip //-line and /*-block comments before scanning so a
          // prose word like "ease" or "linear" in a doc comment can't
          // false-positive (the CSS path already strips comments —
          // this closes the asymmetry noted in #431 review).
          const raw = await readFile(full, 'utf8');
          const withoutComments = raw
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
          offenders.push(...scanBareTimingKeywords(withoutComments, full.replace(REPO_ROOT + '/', '')));
        }
      }
    }
    await walk(resolve(REPO_ROOT, 'packages/ui/src'));
    await walk(resolve(REPO_ROOT, 'apps/desktop/src/renderer'));

    assert.deepEqual(
      offenders,
      [],
      `Bare ease/linear timing keywords are banned — use var(--ease-out-strong), var(--ease-in-out-strong), var(--ease-drawer), or var(--ease-linear).\n  ${offenders.join('\n  ')}`,
    );
  });


  it('bare ms in transition/animation is banned — use var(--duration-*) (0ms/0.01ms a11y whitelisted)', async () => {
    const stripped = stripKeyframes(stripCssComments(await readAllRendererCss()))
      .replace(/^\s*--duration-[\w-]+:\s*\d+ms\s*;.*$/gm, ''); // strip duration token declarations
    const offenders: string[] = [];
    for (const m of stripped.matchAll(/\b(\d+(?:\.\d+)?)ms\b/g)) {
      const value = m[1];
      // 0ms (disable transition) + 0.01ms (prefers-reduced-motion / e2e-fixture) are a11y/test hacks
      if (value === '0' || value === '0.01') continue;
      offenders.push(`${value}ms`);
    }
    assert.deepEqual(offenders, [], `Bare ms in transition/animation must use var(--duration-*). 0ms/0.01ms a11y whitelisted:\n  ${offenders.join('\n  ')}`);
  });

  it('--duration-fast is not referenced (was an undefined token; fixed to --duration-quick)', async () => {
    const css = await readAllRendererCss();
    assert.doesNotMatch(css, /--duration-fast\b/, '--duration-fast was an undefined reference; use --duration-quick');
  });

  it('transform amplitude uses var(--scale-press/hover) + var(--lift-hover) (bare static scale/translateY banned, keyframes excluded)', async () => {
    const stripped = stripKeyframes(stripCssComments(await readAllRendererCss()));
    const offenders: string[] = [];
    for (const m of stripped.matchAll(/(?<![\w-])scale\(\s*(var\(--[\w-]+\)|[-\w.]+)\s*\)/g)) {
      const value = m[1].trim();
      if (value === '1') continue; // literal reset
      if (/^var\(--scale-(press|hover)\)$/.test(value)) continue;
      if (value === '1.1') continue; // decorative onboarding scale, whitelisted
      offenders.push(`scale(${value})`);
    }
    for (const m of stripped.matchAll(/(?<![\w-])translateY\(\s*(var\(--[\w-]+\)|[-\w.]+)\s*\)/g)) {
      const value = m[1].trim();
      if (value === '0') continue; // literal reset
      if (/^var\(--lift-hover\)$/.test(value)) continue;
      if (value === '-3px') continue; // strong lift, whitelisted
      offenders.push(`translateY(${value})`);
    }
    assert.deepEqual(offenders, [], `Bare transform amplitude must use var(--scale-press/hover) or var(--lift-hover). 1/-3px decorative/strong whitelisted, keyframes excluded:\n  ${offenders.join('\n  ')}`);
  });
});
