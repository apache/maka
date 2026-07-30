/**
 * PR-RESPONSIVE-BREAKPOINT-CONVERGE-0 (issue #520 PR4 item 16, 2026-07-05):
 * govern the responsive seams — @media breakpoints and the shared chat
 * content measure — so individual PRs can't drift to ad-hoc values.
 *
 * Two tracks:
 *
 * 1. @media breakpoints. CSS @media queries are evaluated at parse time,
 *    before custom properties resolve, so `@media (max-width: var(--bp))`
 *    is INVALID — breakpoints cannot be tokenized with var(). Instead the
 *    contract whitelists the eight max/min-width pixel values the app
 *    actually uses (620 / 720 / 760 / 820 / 900 / 980 / 990 / 1100) and
 *    bans any other bare `@media (max-width: Npx)`. A new breakpoint must
 *    be added to the whitelist here, which forces a conscious decision
 *    instead of a silent drift. (prefers-reduced-motion /
 *    prefers-color-scheme are not width breakpoints and are out of scope.)
 *
 * 2. The chat content measure (--maka-chat-measure: 680px). This IS a
 *    regular property value, so it can be tokenized. It was a local token
 *    on .mainColumn with a `680px` fallback at every call site; item 16
 *    promotes it to :root in maka-tokens.css so it is canonical and the
 *    fallbacks are redundant. The contract pins it exactly-once in the
 *    token file, bans a local re-declaration in styles/, and bans a bare
 *    `680px` in any width / max-width / min-width declaration so the chat
 *    column, tool output, composer, and onboarding hero all share one
 *    measure. (A 680px HEIGHT cap on the settings form modal is a different
 *    semantic and stays bare — the contract scopes to width.)
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  TOKENS_FILE,
  readAllRendererCss,
  stripCssComments,
  assertCustomPropPinnedOnce,
} from './css-test-helpers.js';

/** The eight max/min-width pixel values the app gates layout on. A new
 *  breakpoint must be added here (and the value used in the CSS). */
const ALLOWED_BREAKPOINT_PX = new Set([620, 720, 760, 820, 900, 980, 990, 1100]);

/** #1362: same governance for @container width queries. Container queries
 *  respond to an element's own width instead of the viewport (the settings
 *  content column is narrower than the window by the nav sidebar, so
 *  viewport breakpoints systematically misfire there — the #1361/#1364
 *  lesson). The app keeps ONE container width: 460px, shared by the
 *  permission dialog and the settings rows card. A second value must be a
 *  conscious decision here, exactly like the @media whitelist above. */
const ALLOWED_CONTAINER_PX = new Set([460]);

// --- @media breakpoint whitelist ------------------------------------------

/** Match `@media (max-width: Npx)` / `@media (min-width: Npx)` and capture N.
 *  Does NOT match prefers-* queries (those are not width breakpoints). */
const MEDIA_WIDTH_RE = /@media\s*\(\s*(max|min)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/g;

function findBreakpointOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];
  for (const m of stripped.matchAll(MEDIA_WIDTH_RE)) {
    const px = Number(m[2]);
    if (!ALLOWED_BREAKPOINT_PX.has(px)) {
      offenders.push(`${label}: ${m[0]} [${px}px not in the breakpoint whitelist ${[...ALLOWED_BREAKPOINT_PX].join('/')}px]`);
    }
  }
  return offenders;
}

// --- @container width whitelist --------------------------------------------

/** Match `@container [name] (max-width: Npx)` / `(min-width: Npx)` and
 *  capture N. Non-width container features (e.g. scroll-state) are out of
 *  scope. */
const CONTAINER_WIDTH_RE = /@container\s+[^{(]*\(\s*(max|min)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/g;

function findContainerWidthOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];
  for (const m of stripped.matchAll(CONTAINER_WIDTH_RE)) {
    const px = Number(m[2]);
    if (!ALLOWED_CONTAINER_PX.has(px)) {
      offenders.push(`${label}: ${m[0]} [${px}px not in the container-width whitelist ${[...ALLOWED_CONTAINER_PX].join('/')}px]`);
    }
  }
  return offenders;
}

// --- chat content measure --------------------------------------------------

/** Bare `680px` in a width / max-width / min-width declaration — must use
 *  var(--maka-chat-measure) so the chat column shares one measure. A 680px
 *  HEIGHT cap (e.g. the settings form modal) is a different semantic and
 *  is not flagged. */
const WIDTH_DECL_RE = /(?:^|\n)\s*(?:width|max-width|min-width|inline-size|max-inline-size|min-inline-size)\s*:\s*([^;}\n]+)/gi;

function findChatMeasureOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];
  for (const m of stripped.matchAll(WIDTH_DECL_RE)) {
    const val = m[1];
    // bare 680px not inside var()/calc()/min()/max()/clamp()
    if (/\b680px\b/.test(val) && !/var\(--maka-chat-measure/.test(val)) {
      offenders.push(`${label}: ${m[0].replace(/\s+/g, ' ').trim()} [bare 680px width — use var(--maka-chat-measure)]`);
    }
  }
  return offenders;
}

// === tests =================================================================

describe('PR-RESPONSIVE-BREAKPOINT-CONVERGE-0 contract', () => {
  it('@media (max/min-width: Npx) uses only the whitelisted breakpoints (no ad-hoc Npx)', async () => {
    const css = await readAllRendererCss();
    const offenders = findBreakpointOffenders(css, 'renderer CSS');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('@container (max/min-width: Npx) uses only the whitelisted container widths (no ad-hoc Npx)', async () => {
    const css = await readAllRendererCss();
    const offenders = findContainerWidthOffenders(css, 'renderer CSS');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('--maka-chat-measure is pinned to 680px exactly-once in maka-tokens.css', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assertCustomPropPinnedOnce(tokens, '--maka-chat-measure', '680px', 'maka-tokens.css');
  });

  it('--maka-chat-measure is not redeclared in styles/ (canonical in maka-tokens.css only)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    // readAllRendererCss includes maka-tokens.css; count declarations of the
    // token and require exactly one (the :root pin). A local re-declaration
    // in styles/ would be a second declaration.
    const decls = [...css.matchAll(/^\s*--maka-chat-measure\s*:\s*([^;}\n]+)/gm)];
    assert.equal(decls.length, 1, `--maka-chat-measure must be declared exactly once (in maka-tokens.css :root); got ${decls.length}: ${decls.map((d) => d[0].trim()).join(' | ')}`);
  });

  it('no bare 680px in width / max-width / min-width declarations (use var(--maka-chat-measure))', async () => {
    const css = await readAllRendererCss();
    const offenders = findChatMeasureOffenders(css, 'renderer CSS');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });
});

describe('responsive breakpoint whitelist negative cases', () => {
  it('findBreakpointOffenders flags a value outside the whitelist and spares the eight allowed', () => {
    const ok = '@media (max-width: 820px) { … } @media (min-width: 990px) { … } @media (max-width: 620px) { … }';
    assert.deepEqual(findBreakpointOffenders(ok, 't'), [], 'the eight whitelisted values must pass');
    const bad = '@media (max-width: 850px) { … } @media (min-width: 1200px) { … }';
    assert.ok(findBreakpointOffenders(bad, 't').length === 2, '850px and 1200px must fail (not whitelisted)');
  });

  it('does not flag prefers-reduced-motion / prefers-color-scheme (not width breakpoints)', () => {
    const css = '@media (prefers-reduced-motion: reduce) { … } @media (prefers-color-scheme: dark) { … }';
    assert.deepEqual(findBreakpointOffenders(css, 't'), [], 'prefers-* queries are out of scope');
  });

  it('findContainerWidthOffenders flags a value outside the whitelist and spares 460 + non-width features', () => {
    const ok = '@container (max-width: 460px) { … } @container settings-rows (max-width: 460px) { … }';
    assert.deepEqual(findContainerWidthOffenders(ok, 't'), [], '460px (unnamed and named) must pass');
    const bad = '@container (max-width: 540px) { … } @container card (min-width: 400px) { … }';
    assert.ok(findContainerWidthOffenders(bad, 't').length === 2, '540px and 400px must fail (not whitelisted)');
    const scrollState = '@container not scroll-state(scrollable: bottom) { … }';
    assert.deepEqual(findContainerWidthOffenders(scrollState, 't'), [], 'scroll-state containers are not width breakpoints');
  });

  it('findChatMeasureOffenders flags a bare 680px width but spares var(--maka-chat-measure) and a 680px height', () => {
    assert.ok(findChatMeasureOffenders('width: min(680px, 100%);', 't').length > 0, 'bare 680px width must fail');
    assert.deepEqual(findChatMeasureOffenders('width: min(var(--maka-chat-measure), 100%);', 't'), [], 'token width must pass');
    assert.deepEqual(findChatMeasureOffenders('max-width: var(--maka-chat-measure);', 't'), [], 'token max-width must pass');
    assert.deepEqual(findChatMeasureOffenders('height: min(76vh, 680px);', 't'), [], '680px height (form modal cap) is out of scope');
  });
});