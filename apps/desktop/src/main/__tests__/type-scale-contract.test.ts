/**
 * Type-scale contracts.
 *
 * The renderer has exactly one type-scale authority: `typography.scale` in
 * astryx-theme/makaTheme.ts, whose generated ladder the product aliases. Three
 * things make that arrangement work, and all three are invisible at the call
 * site — reverting any one of them silently hands back Astryx's neutral
 * defaults or an implicit rem multiplier, with nothing else failing:
 *
 *   1. the root font-size stays at the browser default,
 *   2. the generated theme layer sits after the Astryx component layer,
 *   3. the product size names stay aliases instead of holding values.
 *
 * Each is a pure text declaration, so it belongs here rather than in e2e —
 * the same demotion #1854 made for the settings floor layout. What text
 * cannot prove is what the three resolve to together in a live document;
 * `apps/desktop/e2e/type-scale.spec.ts` measures that with computed styles.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  REPO_ROOT,
  stripCssComments,
  cssRuleBody,
  assertCssRuleDecls,
  assertCustomPropPinnedOnce,
  findFontShorthandOffenders,
  findLeadingPairingOffenders,
  parseCssCustomProps,
  readAllRendererCss,
} from './css-test-helpers.js';

const RENDERER = resolve(REPO_ROOT, 'apps/desktop/src/renderer');

async function read(rel: string): Promise<string> {
  return readFile(resolve(RENDERER, rel), 'utf8');
}

describe('type scale contracts', () => {
  it('leaves the root font-size at the browser default', async () => {
    // `html { font-size: 13px }` is not a type scale: it is an implicit
    // ×0.8125 on every rem in the document, including Astryx's Icon size
    // atoms, which it authors as the px-equivalents at a 16px root and which
    // the pin therefore rendered at 9.75/13/16.25/19.5. The whole generated
    // ladder is expressed in rem, so a re-pinned root moves every tier at
    // once and nothing else in the suite notices.
    const tokens = stripCssComments(await read('maka-tokens.css'));
    assert.equal(
      cssRuleBody(tokens, 'html'),
      null,
      'maka-tokens.css must not declare an `html` rule — the root is not a density knob',
    );
    // Qualified selectors count. maka-tokens.css already ships
    // `html[data-os="darwin"]` rules, so an attribute-scoped re-pin is the
    // natural shape a density knob would come back in, and the earlier
    // `html\s*\{` form did not see it.
    assert.doesNotMatch(
      stripCssComments(await readAllRendererCss()),
      /(?:^|[{}])\s*(?:html|:root)[^{]*\{[^}]*\bfont-size\s*:/,
      'no renderer stylesheet may pin font-size on html or :root, qualified or not',
    );
  });

  it('layers the generated theme after the Astryx component sheet', async () => {
    // astryx.css ships the neutral defaults on `:root`; a theme layered
    // before it can never override them there, so the product aliases below
    // would resolve to neutral values. This is also the order Astryx's own
    // README integration snippet prescribes.
    const decl = /@layer\s+([^;]+);/.exec(await read('cascade-layers.css'));
    assert.ok(decl, 'cascade-layers.css must declare the layer order');
    const layers = decl![1].split(',').map((s) => s.trim());
    assert.ok(
      layers.indexOf('astryx-tokens') > layers.indexOf('astryx-components'),
      `astryx-tokens must come after astryx-components; got ${layers.join(', ')}`,
    );
    assert.equal(layers.at(-1), 'components', 'product CSS must stay last');
  });

  it('keeps the product size names as aliases of the ladder', async () => {
    const tokens = await read('maka-tokens.css');
    assertCustomPropPinnedOnce(tokens, '--font-size-heading', 'var(--font-size-lg)');
    assertCustomPropPinnedOnce(tokens, '--font-size-stat', 'var(--font-size-2xl)');
    assertCustomPropPinnedOnce(tokens, '--font-size-ui', 'var(--font-size-base)');
    assertCustomPropPinnedOnce(tokens, '--font-size-caption', 'var(--font-size-sm)');
    assertCustomPropPinnedOnce(tokens, '--font-sans', 'var(--font-family-body)');
    assertCustomPropPinnedOnce(tokens, '--font-mono', 'var(--font-family-code)');
    assert.equal(
      parseCssCustomProps(tokens).get('--font-size-base'),
      undefined,
      '--font-size-base IS the Astryx token; redefining it here shadows the scale and makes --font-size-ui self-referential',
    );
  });

  it('derives the transcript baseline instead of typing it in', async () => {
    // The one token in this PR that is computed rather than aliased, and the
    // only one whose failure is silent in both directions: typed in as a
    // literal it drifts the next time the scale moves, and undefined it
    // resolves to nothing and lands as `line-height: <invalid>` — which
    // renders as normal leading, not as a visible break. Deleting the
    // declaration outright left every other case in this file green.
    assertCustomPropPinnedOnce(
      await read('maka-tokens.css'),
      '--maka-line-body',
      'calc(var(--text-body-size) * var(--text-body-leading))',
    );
  });

  it('pins the ladder rungs those aliases point at', async () => {
    // Only the four rungs the product consumes. Pinning all twelve would
    // charge every Astryx upgrade a test rewrite — the failure mode that got
    // the previous generation of scanner contracts deleted.
    const theme = await read('astryx-theme/maka.css');
    const rung = (name: string, rem: string) =>
      assertCustomPropPinnedOnce(theme, name, rem, 'astryx-theme/maka.css');
    rung('--font-size-sm', '0.75rem'); //   12px — caption
    rung('--font-size-base', '0.875rem'); // 14px — body / ui
    rung('--font-size-lg', '1rem'); //       16px — heading
    rung('--font-size-2xl', '1.25rem'); //   20px — stat
  });

  it('routes code elements through the monospace token', async () => {
    // Astryx's reset hard-codes a stack on :where(code, kbd, samp, pre) that
    // never consults --font-family-code, so every code element silently opted
    // out of the theme. The regression is subtle enough that only a contract
    // catches it.
    assertCssRuleDecls(
      stripCssComments(await read('maka-tokens.css')),
      ':where(code, kbd, samp, pre)',
      [/font-family:\s*var\(--font-mono\)/],
    );
  });

  it('flattens transcript headings to two steps, inside the turn only', async () => {
    // An agent turn is not a document, but a Daily Review report is — and
    // both render through the same MarkdownBody contract, so the scope has to
    // be the turn rather than the contract.
    const chat = stripCssComments(await read('styles/chat-message.css'));
    assertCssRuleDecls(
      chat,
      '.maka-turn [data-maka-contract="markdown"] h1',
      [/font-size:\s*var\(--font-size-lg\)/],
    );
    assertCssRuleDecls(
      chat,
      '.maka-turn [data-maka-contract="markdown"] :is(h2, h3, h4, h5, h6)',
      [/font-size:\s*var\(--text-body-size\)/],
    );
    // Scanned repo-wide, not just in this file: the invariant is about the
    // shared MarkdownBody contract, and the Daily Review panel it protects
    // renders from a different stylesheet. The same rule added to
    // chat-detail.css was invisible to the file-local form of this check.
    assert.doesNotMatch(
      stripCssComments(await readAllRendererCss()),
      /(?:^|[{},])\s*\[data-maka-contract="markdown"\]\s+(?:h[1-6]|:is\(h)/,
      'heading overrides must be scoped to .maka-turn, not to the shared Markdown contract',
    );
  });

  it('retunes the disclosure rows by rebinding the role token', async () => {
    // Not by restyling spans. `> span:not(:last-child)` looked like "every
    // span but the chevron" and was in fact "whatever Astryx happens to put
    // there this release" — it missed ChatReasoning's nested label entirely.
    const chat = stripCssComments(await read('styles/chat-message.css'));
    assertCssRuleDecls(
      chat,
      '.maka-turn :is(.astryx-chat-reasoning, .astryx-chat-tool-calls) [role="button"]',
      [
        /--text-supporting-size:\s*var\(--text-body-size\)/,
        /--text-supporting-leading:\s*var\(--maka-line-body\)/,
      ],
    );
    // Repo-wide, and deliberately wider than the rule above it. A
    // `font-size: … !important` anywhere in the renderer is a site declaring
    // itself exempt from the ladder, which is the thing this branch exists to
    // end; the sidebar's section-title pin was exactly that shape, and it
    // survived because the ban only looked at one file. Product CSS sits in
    // the last cascade layer, so nothing here needs the keyword to win.
    assert.doesNotMatch(
      stripCssComments(await readAllRendererCss()),
      /font-size:[^;]*!important/,
      'no renderer stylesheet may force a font-size — product CSS is already in the last layer',
    );
  });

  it('leaves no product leading vocabulary to compete with the roles', async () => {
    // Both halves matter. A surviving `--leading-*` DEFINITION is a second
    // authority waiting to be used; a surviving REFERENCE with the definition
    // gone resolves to nothing and lands as `line-height: <invalid>`, which
    // renders as the inherited leading rather than as a visible break. The
    // scan covers packages/ui too — its bare `@import "@maka/ui/styles.css"`
    // is expanded by readAllRendererCss, and it held eight of the literals.
    const css = stripCssComments(await readAllRendererCss());
    assert.deepEqual(
      [...css.matchAll(/--leading-[\w-]+/g)].map((m) => m[0]),
      [],
      'no renderer stylesheet may define or read a product --leading-* tier',
    );
    // Literals are the same divergence written inline. `1.4286` typed out is
    // not the body role: it is a copy of what the role happened to compute
    // before the last scale change.
    assert.deepEqual(
      [...css.matchAll(/line-height\s*:\s*[\d.]+/g)].map((m) => m[0]),
      [],
      'line-height must name an Astryx role token, not a literal ratio',
    );
    // The bypass the two checks above cannot see, and the one this branch is
    // most exposed to: rebinding a role token itself. The transcript uses that
    // mechanism deliberately (`--text-supporting-leading: var(--maka-line-body)`
    // in chat-message.css), so a rebind is legal — but only to another token.
    // Rebound to a literal, one line re-establishes a second leading authority
    // for a whole subtree and reaches every `line-height: var(--text-*-leading)`
    // site under it, with every other check in this file still green.
    assert.deepEqual(
      [...css.matchAll(/--text-[\w-]+-leading\s*:\s*[\d.]+/g)].map((m) => m[0]),
      [],
      'an Astryx leading role may be rebound to another token, never to a literal',
    );
    // Product CSS is already in the last cascade layer, so the keyword buys
    // nothing here and costs the ability to retune a tier from the theme. The
    // font-size ban below has always said this; leading was left out.
    assert.deepEqual(
      [...css.matchAll(/line-height:[^;]*!important/g)].map((m) => m[0]),
      [],
      'no renderer stylesheet may force a line-height',
    );
    // `font:` shorthand carries a leading in its `/` slot (`12px/1.9 sans`),
    // which every longhand scan above is blind to. The backstop for exactly
    // this existed in css-test-helpers.ts with no caller anywhere in the repo
    // outside its own unit test — a guard that was written but never posted.
    assert.deepEqual(findFontShorthandOffenders(css, 'renderer'), []);
  });

  it('pairs every font-size and every line-height with its own tier', async () => {
    // The pairing this branch exists to make unbreakable. Size and leading
    // were separately chosen per site, so a site could move one and leave the
    // other — measured, `.maka-onboarding-setup header h1` had done exactly
    // that, overriding the size to 18px while the leading came from a 16px
    // rule one selector up, and rendering 22.5px.
    //
    // Both directions, because both are ways for the pair to come apart: a
    // size with no leading takes whatever ratio it inherits, and a leading
    // with no size pins a ratio to a size it was never chosen against. The
    // second half found three blocks in this tree that no check anywhere saw.
    //
    // Resolved through the generated theme rather than a copied table, so
    // this tracks an Astryx scale change instead of failing on one.
    const offenders = findLeadingPairingOffenders(
      await readAllRendererCss(),
      await read('astryx-theme/maka.css'),
      await read('maka-tokens.css'),
    );
    assert.deepEqual(offenders, [], `size/leading pairs must name one tier:\n${offenders.join('\n')}`);
  });

  it('keeps font-size off em multipliers and rem', async () => {
    // Both are ways of re-deriving the ladder per site. `em` compounds off
    // whatever the parent happens to be (the hero title was hand-derived from
    // a 15px body, then silently rendered 27.7px under a 13px one); `rem`
    // reintroduces the root as a density knob. The ladder is the only source.
    const css = stripCssComments(await readAllRendererCss());
    assert.deepEqual(
      [...css.matchAll(/font-size:\s*[\d.]+(?:em|rem)\b/g)].map((m) => m[0]),
      [],
      'font-size must reference the type scale, not an em/rem multiplier',
    );
  });
});
