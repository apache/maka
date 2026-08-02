/**
 * Type-scale contracts.
 *
 * The renderer has exactly one type-scale authority: `typography.scale` in
 * astryx-theme/makaTheme.ts, whose generated ladder the role table composes.
 * Three things make that arrangement work, and all three are invisible at the
 * call site — reverting any one of them silently hands back Astryx's neutral
 * defaults or an implicit rem multiplier, with nothing else failing:
 *
 *   1. the root font-size stays at the browser default,
 *   2. the generated theme layer sits after the Astryx component layer,
 *   3. the product keeps no name of its own for a size, a family or a
 *      leading, so there is nothing that can drift from the Astryx one.
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
  findTextRoleOffenders,
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

  it('keeps no product name for a size or a family', async () => {
    // The previous shape of this test pinned six aliases —
    // --font-size-heading/stat/ui/caption, --font-sans, --font-mono — because
    // a call site named a size or a family and the alias was what kept that
    // name pointing at the ladder. A call site names a role now, so all six
    // reached zero consumers (check-dead-css found them) and are deleted. What
    // has to hold is the stronger thing the aliases were only approximating:
    // there is no product name for a size or a family at all, so there is
    // nothing to drift from the Astryx one.
    const tokens = parseCssCustomProps(await read('maka-tokens.css'));
    for (const gone of [
      '--font-size-heading',
      '--font-size-stat',
      '--font-size-ui',
      '--font-size-caption',
      '--font-sans',
      '--font-mono',
      '--font-default',
      // --font-size-base was never defined here: it IS the Astryx token, and
      // redefining the name would shadow the scale.
      '--font-size-base',
    ]) {
      assert.equal(tokens.get(gone), undefined, `${gone} is superseded by the role table — do not reintroduce it`);
    }
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

  it('composes each role from its own Astryx atoms, on both anchors', async () => {
    // The role table is the whole mechanism, so its shape is the one thing a
    // call-site scan cannot see. Three properties, each of which failed
    // silently while every other check here stayed green:
    //
    //   - a role must read ONLY its own atoms. `--maka-text-body` built from
    //     `--text-heading-4-weight` is a hand-rolled tuple wearing a role name,
    //     and it is exactly what this branch spent 348 call sites removing.
    //   - the table must be declared on the code group as well as `:root`.
    //     var() in a custom property is substituted where the property is
    //     DECLARED, and the resolved string is what inherits — so a table
    //     composed only on `:root` freezes the sans stack into every role, and
    //     no rebind further down can reach it. Measured before the second
    //     anchor landed: `.maka-tool-diff-body`, a real <pre>, read
    //     `--maka-font-family: "Geist Mono Variable"` and computed
    //     `font-family: -apple-system`.
    //   - the family axis must be pinned once per anchor. A second definition
    //     is a second family authority, which is the divergence the shorthand's
    //     mandatory family slot exists to close.
    const tokens = stripCssComments(await read('maka-tokens.css'));
    const roles = [...tokens.matchAll(/(--maka-text-([\w-]+))\s*:\s*([^;]+);/g)];
    assert.ok(roles.length >= 12, `expected the full role table, found ${roles.length}`);
    for (const [, name, role, value] of roles) {
      for (const [, atom] of value.matchAll(/var\((--text-[\w-]+)\)/g)) {
        assert.match(
          atom,
          new RegExp(`^--text-${role}-(?:size|weight|leading)$`),
          `${name} reads ${atom} — a role may only be composed from its own atoms`,
        );
      }
    }
    // Both anchors, and the family longhand that serves elements naming no
    // role at all. Asserted as text because the tokens file is the one place
    // the call-site scan below cannot reach.
    assert.match(
      tokens,
      /:root,\s*:where\(code, kbd, samp, pre\)\s*\{[^}]*--maka-text-body:/,
      'the role table must be anchored on :root AND the code element group',
    );
    assertCssRuleDecls(tokens, ':where(code, kbd, samp, pre)', [
      /--maka-font-family:\s*var\(--font-family-code\)/,
      /font-family:\s*var\(--font-family-code\)/,
    ]);
    // Twice, not once: the axis is declared on each anchor, and that is the
    // whole point of the second anchor. A third declaration would be a third
    // family authority, which is what the pin exists to prevent.
    assert.deepEqual(parseCssCustomProps(tokens).get('--maka-font-family'), [
      'var(--font-family-body)',
      'var(--font-family-code)',
    ]);
  });

  it('flattens transcript headings to two steps, inside the turn only', async () => {
    // An agent turn is not a document, but a Daily Review report is — and
    // both render through the same MarkdownBody contract, so the scope has to
    // be the turn rather than the contract.
    const chat = stripCssComments(await read('styles/chat-message.css'));
    assertCssRuleDecls(
      chat,
      '.maka-turn [data-maka-contract="markdown"] h1',
      [/font:\s*var\(--maka-text-heading-3\)/],
    );
    assertCssRuleDecls(
      chat,
      '.maka-turn [data-maka-contract="markdown"] :is(h2, h3, h4, h5, h6)',
      [/font:\s*var\(--maka-text-heading-4\)/],
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
  });

  it('lets a rule name a text role and nothing else', async () => {
    // This one assertion replaces six. Before the roles, size / leading /
    // weight / family were four independent properties, so each needed its
    // own guard — a ban on `--leading-*` tiers, on literal ratios, on
    // `!important` leadings and sizes, on em/rem multipliers, a ban on the
    // `font:` shorthand, and a pairing check that resolved a block's size and
    // leading through the generated theme to prove they named the same tier.
    // Every one of those describes a way for the four to come apart. None of
    // them is expressible now: a rule that cannot write a font longhand cannot
    // write a literal ratio, an em multiplier, a forced size, or a mismatched
    // pair, and the shorthand is inverted from the bypass into the only legal
    // form. The atom-rebind arm folded in here too, for the same reason:
    // two authorities on "may this name hold a value" would leave people
    // reading the weaker one.
    //
    // Scope is every renderer stylesheet, this file included. Excluding
    // maka-tokens.css wholesale — which the first shape of this contract did,
    // to spare the one family longhand the role table needs — exempted the
    // ~40 ordinary component rules that also live there from the only
    // remaining guard.
    const offenders = findTextRoleOffenders(
      await readAllRendererCss(),
      await read('maka-tokens.css'),
      'renderer',
    );
    assert.deepEqual(offenders, [], `rules must name a text role:\n${offenders.join('\n')}`);
  });

  it('keeps no product leading vocabulary to compete with the roles', async () => {
    // Not covered by the scan above, because this is about a NAME rather than
    // a declaration: a surviving `--leading-*` definition is a second leading
    // authority waiting to be used, and a surviving reference with the
    // definition gone resolves to nothing and lands as an invalid
    // `line-height` — which renders as the inherited leading, not as a
    // visible break.
    const css = stripCssComments(await readAllRendererCss());
    assert.deepEqual(
      [...css.matchAll(/--leading-[\w-]+/g)].map((m) => m[0]),
      [],
      'no renderer stylesheet may define or read a product --leading-* tier',
    );
  });
});
