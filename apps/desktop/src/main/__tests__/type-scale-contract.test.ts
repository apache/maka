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
  findBadgeClassNames,
  findTextRoleOffenders,
  findUnreadableBadgeCallSites,
  mergeByContext,
  mergeBySelector,
  parseCssBlocks,
  parseCssCustomProps,
  readAllRendererCss,
  splitSelectorList,
  UNCONDITIONAL,
} from './css-test-helpers.js';

/**
 * TWO height vocabularies, deliberately different, because two different
 * questions are being asked and the same regex answers one of them wrongly.
 *
 * `CONSTRAINS_BLOCK_SIZE` — "does anything here fix this box's block size?"
 * That is the wrap contract's question and the Badge contract's question, and
 * `min-height` and `max-height` answer it just as `height` does: measured,
 * `min-height: 40px` on a Badge className beats the component's own
 * `height: var(--spacing-5)`, and `min-height: 20px; max-height: 20px` on a
 * wrapping row clips its second line exactly as `height: 20px` would. Both
 * used to pass this file green.
 *
 * `HEIGHT_DECL_G` — "is this box's height taken FROM the ruler?" There
 * `min-height` is emphatically not an answer, and this PR is where that was
 * learned: `.settingsUsageDetailToggle` declared `min-height: 34px` and still
 * grew to 40px when its leading moved, which is why settings/bot.css now
 * declares a real `height`. Widening this one too would have re-accepted the
 * exact declaration the fix replaced.
 *
 * `line-height` and custom properties are excluded from both by the negative
 * lookbehind. `block-size` is the logical alias and is the same declaration to
 * a browser, so a check that reads one and not the other is a check with a
 * documented bypass. The `\s*` before the colon is not cosmetic: `height :
 * 20px` is valid CSS.
 */
const CONSTRAINS_BLOCK_SIZE = /(?<![-\w])(?:min-|max-)?(?:height|block-size)\s*:/;
const HEIGHT_DECL_G = /(?<![-\w])(?:height|block-size)\s*:([^;}]*)/g;
const RULER_VALUE = /^\s*var\((--h-control-[a-z0-9-]+)\)\s*$/;
/** A height that hands the box back to its content. */
const CONTENT_DRIVEN = /^\s*(?:auto|inherit|initial|unset|revert|(?:fit|min|max)-content)\b/;

/**
 * The padding vocabulary, ONE authority, shared by the two contracts that read
 * it — a chip is a box with its own padding, and a Badge className may not
 * restate the padding the component computes.
 *
 * Written out because both shorthand families are real CSS and a guard that
 * knows one of them is a guard with a documented bypass. Measured, both
 * directions of that mistake have shipped in this file: `padding(?:-[a-z]+)?`
 * missed `padding-inline-start`, and the rewrite that added the logical family
 * dropped `padding-top/right/bottom/left` — a Badge className given
 * `padding-left: 9px` redrew the component's box while the contract stayed
 * green.
 *
 * A DECLARATION, not a substring. `/padding/` also matches
 * `background-clip: padding-box`, which is not padding and not a chip: it is
 * how a scrollbar thumb — a box no reader perceives as an object, whose block
 * size is the scroll geometry's business — entered the chip population and
 * earned an exemption group of its own. The group is deleted with the
 * substring that created it.
 */
const PADDING = 'padding(?:-(?:inline|block|top|right|bottom|left))?(?:-(?:start|end))?';
const DECLARES_PADDING = new RegExp(`(?<![-\\w])${PADDING}\\s*:`);

/**
 * This box's EFFECTIVE height declaration, or undefined.
 *
 * Effective, not "mentioned anywhere": CSS takes the last declaration, so a
 * body reading `height: var(--h-control-xs); … height: auto` is an unpinned
 * box that a test matching anywhere in the text reports as pinned. That is a
 * legal, one-line bypass of the whole contract, and this file already
 * documents the same false-green for custom properties.
 */
function effectiveHeight(body: string): string | undefined {
  return [...body.matchAll(HEIGHT_DECL_G)].map((m) => m[1]).at(-1);
}

/**
 * Does this box's effective height come from the control ruler?
 *
 * `rungs` is the set of tiers the ruler actually defines. Naming a tier that
 * does not exist makes the declaration invalid at computed-value time, so the
 * box falls back to `auto` — #1879 restored by a typo, with every text check
 * green. A name-is-defined arm is the same guard #1893 already runs over role
 * tokens; the tiers are read from maka-tokens.css rather than listed here so
 * there is one authority for what the ruler contains.
 */
function pinnedToRuler(body: string, rungs: Set<string>): boolean {
  const last = effectiveHeight(body);
  if (last === undefined) return false;
  const tier = RULER_VALUE.exec(last)?.[1];
  return tier !== undefined && rungs.has(tier);
}

/** The tiers `--h-control-*` defines, read from the ruler's OWN scope.
 *
 * The scope is the guard, not decoration. `parseCssCustomProps` reads the
 * whole file, so a `--h-control-xss` declared under `.dark` — or in any other
 * qualified rule — counted as a rung the ruler does not have: a chip naming it
 * falls back to `auto` in every other theme, which is #1879 again, and the
 * membership arm that exists to catch a typo waved it through. A rung is a
 * rung only where every chip can inherit it. */
async function rulerRungs(): Promise<Set<string>> {
  const names = rootCustomProps(await read('maka-tokens.css'), '--h-control-');
  assert.ok(names.size >= 6, `the control ruler must define its tiers; found ${names.size}`);
  return names;
}

/** Custom properties with the given prefix declared unconditionally on `:root`. */
function rootCustomProps(css: string, prefix: string): Set<string> {
  const out = new Set<string>();
  for (const { rule, conditions, decls } of parseCssBlocks(stripCssComments(css))) {
    if (conditions.length > 0) continue;
    if (!splitSelectorList(rule).includes(':root')) continue;
    for (const { prop } of decls) if (prop.startsWith(prefix)) out.add(prop);
  }
  return out;
}

/**
 * The pill-shaped boxes that do NOT take a `--h-control-*` height, grouped by
 * WHY — because the three reasons are three different invariants, and a set
 * that merges them can only be honoured by skipping.
 *
 * Skipping was the earlier shape and it was wrong twice over. It let a review
 * mutation add `height: 1px` to a rule excused as "the component sizes this"
 * and stay green, and it made an entry whose check could never have fired read
 * exactly like an entry whose check would have. An exemption that suppresses
 * nothing is the defect class this file exists to retire: a stated reason that
 * is false about the code it governs.
 *
 * So each group below is ASSERTED, not skipped. Every entry has to keep
 * earning its place, and an entry that stops being true fails the contract
 * that names it rather than silently widening it.
 */

/** Wraps by design: content is a sentence, so nothing may fix its block size.
 * Asserted by 'leaves the boxes that wrap unpinned', which is where these live
 * — they are not a second list. */
const WRAPS = [
  // A system-note block, not a chip: pinning clips every line but the first.
  // Keyed by its FULL prelude — the old key was the last line of a multi-line
  // selector, which also exempted any future rule ending that way.
  '.maka-chat-message[data-sender="system"] pre:not([data-maka-contract="markdown"] pre)',
  // `flex-wrap: wrap` is load-bearing — its buttons flow to a second line
  // inside the pill on the floor column (see that rule's own comment).
  '.settingsMemoryBackupCandidate',
  // Measured: its English copy is 317px on one line in a 260px column. A pin
  // here is only safe with `white-space: nowrap`, which trades a clipped
  // second line for a 57px overflow past the card. See that rule.
  '.settingsCapabilityOsPermissions li',
  // Both of these hold a Badge plus a message that grows without bound; the
  // 20px they measure at comes from the Badge, and must keep coming from it.
  '.maka-plan-card-run',
  '.maka-plan-card-schedule',
] as const;

/** Sized by the Astryx component that renders them, which is the stronger form
 * of the same invariant: the box comes from `--size-element-*` instead of from
 * a product rule racing it. Asserted as "declares no block size AT ALL" —
 * the positive form of the reason, so re-adding the override #1879 removed
 * fails here instead of being waved through.
 *
 * `.maka-composer-model-chip` sat in the old merged list on a reason that was
 * false: its class is on `ModelChipStatic`'s inert `<span>`, never on the
 * `Button` it renders when clickable, so no component was sizing it and the
 * exemption hid a 22px box next to a 28px Selector. It pins like any other
 * chip now. */
const COMPONENT_OWNED = [
  '.maka-model-switcher-trigger.astryx-selector',
  '.maka-new-chat-model-selector.astryx-selector',
  '.maka-thinking-level-selector.astryx-selector',
  // Takes its pill shape from Astryx `Button` via `--_button-radius` rather
  // than a `border-radius` of its own, so the chip scan cannot see it and only
  // this group governs it. An earlier revision dropped it as inert on the
  // reasoning that neither filter selects it — true while the groups were
  // skips, false the moment they became assertions: a skip nothing reaches is
  // dead weight, but an assertion nothing reaches is the only thing standing
  // between this rule and the `height` override #1879 removed.
  '.maka-sidebar-update-button',
] as const;

/** Pinned boxes whose flex display comes from a BASE rule, not from the
 * modifier that pins them. `mergeBySelector` keys on literal selector text, so
 * `.maka-quote-chip-collapsed` cannot see the `display: inline-flex` its
 * `.maka-quote-chip` base declares. Restating the display on the modifier
 * would be a product rule duplicating a product rule — the thing this PR
 * removes everywhere else — so the pair is named here and the base is asserted
 * to still carry it. Modifier → base. */
const CENTRED_BY_A_BASE_RULE: ReadonlyArray<readonly [string, string]> = [
  ['.maka-quote-chip-collapsed', '.maka-quote-chip'],
];

const NOT_ON_THE_RULER = new Set<string>([...WRAPS, ...COMPONENT_OWNED]);

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

  it('pins every pill chip to the control ruler', async () => {
    // #1879. #1878 and #1893 made every line box name a role; they did not stop
    // a line box from DECIDING a box. Where a chip declares no height, leading
    // and box height are one decision, so the next role retune is a layout
    // change — measured, these boxes doubled when their own leading was bumped
    // to 40px, and the inline ones took their parent's line box with them.
    //
    // Derived, not enumerated. The first revision of this contract listed
    // eight selectors, which could only fail for a chip someone remembered to
    // add: measured against that list, nine identically-defective chips were
    // shipping in the same files, one of them sixteen lines from a selector
    // the list did contain. A rule that reads the stylesheet cannot have that
    // failure mode, and it is less code than the table it replaces.
    //
    // The predicate is deliberately the visual definition of a chip rather
    // than a naming convention: pill radius plus its own padding. That is a box
    // a reader perceives as a discrete object, which is exactly the population
    // whose height should come from the control ruler.
    //
    // TWO arms, not three. An earlier revision also required the rule to
    // declare its own type — a `font:` role or a `--text-*-leading` pair — on
    // the theory that a discrete object names its own text. It does not: a
    // COMPOUND chip delegates its type to a child, and a simple one may just
    // inherit. Measured, that third arm was hiding exactly three shipping
    // chips with the #1879 defect — `.maka-quote-chip-collapsed` (type on its
    // `.maka-quote-chip-text` child), `.maka-deep-research-run-count` (no type
    // declaration anywhere, it inherits) and `.maka-firstrun-step` — while the
    // scan reported the other 15 green. The arm did not narrow the population
    // to real chips; it narrowed it to chips that happen to write text rules.
    //
    // Dropping it also changed what guards this scan against going quiet. The
    // third arm read the type vocabulary, which #1893 had moved out from under
    // it once already, so a `chips.length >= 8` floor sat here — an unanchored
    // number, deleted with the arm it watched. But the two surviving arms read
    // token NAMES, and a name that is not defined resolves to nothing: measured,
    // renaming `--radius-pill` across the tree reported CHIP POPULATION 0 and
    // this contract passed. So the floor is replaced by the thing it was
    // approximating and the same arm `rulerRungs` already runs — the tokens the
    // predicate reads must exist — which fails on the rename rather than
    // reporting an empty population as compliance.
    //
    // Merged per selector, not per rule block. A chip whose type lives in one
    // rule and whose pill chrome lives in another is one box to a browser and
    // was two invisible halves to the first revision of this scan — which is
    // exactly how `.plan-proposal-revision` sat five lines from a selector
    // this scan did catch and went unseen. Splitting a rule in two is not a
    // way to be exempt from it.
    const merged = mergeBySelector(stripCssComments(await readAllRendererCss()));
    const rungs = await rulerRungs();

    // Pill radius only, and that boundary was measured rather than assumed:
    // widening the arm to `--radius-control` reported 27 offenders, among them
    // `pre` blocks, failure banners, sidebar rows and buttons — every one a box
    // a pin would clip. `--radius-control` is the repo's general control shape,
    // not a chip signal. The squared chips that motivated trying it are Astryx
    // `Badge`s now, so that population is empty rather than unguarded.
    assert.ok(
      rootCustomProps(await read('maka-tokens.css'), '--radius-pill').size === 1,
      'the pill radius this scan derives its population from must exist on :root',
    );
    const isChip = (body: string) =>
      /border-radius:\s*var\(--radius-pill\)/.test(body) && DECLARES_PADDING.test(body);

    // Anything not named in one of the three reason-groups must pin, and each
    // group is asserted by its own contract below rather than merely skipped
    // here — so a name in this filter is a name that has to keep being true.
    const offenders = [...merged]
      .filter(([, body]) => isChip(body))
      .filter(([selector]) => !NOT_ON_THE_RULER.has(selector))
      .filter(([, body]) => !pinnedToRuler(body, rungs))
      .map(([selector]) => selector);
    assert.deepEqual(
      offenders,
      [],
      `every chip must take its height from --h-control-*, or be named in one of WRAPS / COMPONENT_OWNED with a measured reason:\n${offenders.join('\n')}`,
    );
  });

  it('holds every off-ruler exemption to the reason it claims', async () => {
    // The half of an exemption set that a skip cannot express. Each group
    // states WHY a pill is off the ruler; without this, "why" is a comment and
    // the code is an unconditional pass — measured, a review mutation added
    // `height: 1px` to a rule excused as "the Astryx component sizes this" and
    // the whole suite stayed green.
    //
    // WHICH VIEW follows from which question, and the two groups below ask
    // opposite ones. "Does any rule, under any condition, declare a block size
    // here" is a must-NOT question with no conditional distinction — measured,
    // `@media (max-width: 620px) { .maka-model-switcher-trigger.astryx-selector
    // { height: 40px } }` is verbatim the override #1879 removed and passed the
    // unconditional view green. "Is this box still pinned" is a must-HOLD
    // question about the unconditional box, and folding breakpoints into it
    // would read a responsive value as the pin.
    const css = stripCssComments(await readAllRendererCss());
    const anyCondition = mergeBySelector(css, { includeConditional: true });
    const merged = mergeBySelector(css);
    const rungs = await rulerRungs();

    for (const selector of COMPONENT_OWNED) {
      const body = anyCondition.get(selector) ?? '';
      assert.ok(body !== '', `${selector} must still exist for its exemption to mean anything`);
      assert.doesNotMatch(
        body,
        CONSTRAINS_BLOCK_SIZE,
        `${selector} is excused because its Astryx component sizes it; declaring any block size here is the override #1879 removed`,
      );
    }
  });

  it('pins the chrome-less chips the scan cannot see', async () => {
    // The scan above finds chips by their chrome. These two are chips by
    // behaviour and not by appearance — a timestamp and a ⌘N hint, both
    // deliberately styled with no pill, no background and no border — so no
    // predicate over declarations can distinguish them from ordinary inline
    // text. They are the two #1879 measured first, so they are listed rather
    // than derived, and the list is short because it can only ever hold boxes
    // that carry no chrome at all.
    const rungs = await rulerRungs();
    for (const [file, selector] of [
      ['styles/chat-message.css', '.maka-message-time-inline'],
      ['styles/sidebar.css', '.maka-nav-kbd'],
    ] as const) {
      const body = cssRuleBody(stripCssComments(await read(file)), selector);
      assert.ok(body, `${file} must still declare ${selector}`);
      assert.ok(pinnedToRuler(body, rungs), `${selector} must take its height from --h-control-*`);
    }
  });

  it('centres the line box inside every box it pins', async () => {
    // A height with nothing centring the line box inside it clips off-centre
    // once the two disagree, which is the failure the pin exists to prevent
    // rather than to cause. Asserted as a PAIR: `align-items` is inert text on
    // a `display: block` box, so a mutation that keeps the property and drops
    // the flex display passed a version of this check that read only the
    // alignment. `grid` is accepted alongside `flex` because it honours
    // `align-items` identically; measured, every selector this currently
    // selects uses flex, so the grid arm guards a shape nothing has taken yet
    // rather than one that was observed.
    //
    // No exemption list. This question is "is this pin safe", and the reasons
    // a pill may sit off the ruler have nothing to say about it — a box that
    // IS pinned has to centre its line box whatever the reason for its tier.
    // The earlier revision filtered `EXEMPT` here, inherited from a different
    // question; measured, it excluded nothing, so it was a silent widening
    // waiting for its first entry.
    // LAST declaration, not "matches somewhere". Both halves are overridable
    // in place: measured, appending `display: block` after an `inline-flex`
    // left the earlier text in the merged body and passed this check, which is
    // precisely the inert-`align-items` failure the pair form was adopted to
    // catch, one property over. `lastValue` is what a browser reads.
    const lastValue = (body: string, prop: string) =>
      [...body.matchAll(new RegExp(`(?<![-\\w])${prop}\\s*:([^;}]*)`, 'g'))].map((m) => m[1]).at(-1) ?? '';
    const CENTRES = (body: string) =>
      /^\s*(?:inline-)?(?:flex|grid)\b/.test(lastValue(body, 'display')) &&
      /^\s*(?:safe\s+|unsafe\s+)?center\b/.test(
        lastValue(body, 'place-items') || lastValue(body, 'align-items'),
      );
    const rungs = await rulerRungs();
    const merged = mergeBySelector(stripCssComments(await readAllRendererCss()));
    // The base half of the pair, asserted rather than assumed: a modifier is
    // only excused because its base centres for it, and that has to stay true.
    for (const [modifier, base] of CENTRED_BY_A_BASE_RULE) {
      const pair = `${merged.get(base) ?? ''} ${merged.get(modifier) ?? ''}`;
      assert.ok(
        CENTRES(pair),
        `${modifier} is pinned and is excused from centring because ${base} does it; together they no longer do`,
      );
    }
    const excused = new Set(CENTRED_BY_A_BASE_RULE.map(([modifier]) => modifier));
    const offenders = [...merged]
      .filter(([selector, body]) => pinnedToRuler(body, rungs) && !excused.has(selector))
      .filter(([, body]) => !CENTRES(body))
      .map(([selector]) => selector);
    assert.deepEqual(
      offenders,
      [],
      `a box pinned to --h-control-* must centre its line box with a flex/grid display AND align-items: center:\n${offenders.join('\n')}`,
    );
  });

  it('lets no product rule redraw the box an Astryx Badge already owns', async () => {
    // The other half of #1879, and the half the derived scan above cannot see.
    // Twelve chips stopped hand-drawing a pill and became `<Badge>`s, which is
    // the stronger form of the invariant — the box comes from the component
    // instead of from a rule a scan has to police. But it moved them OUT of
    // that scan's population: a Badge has no product rule, so `isChip` is
    // false and nothing above would notice `.maka-turn-truncation-badge
    // { height: auto }` reappearing. Product CSS is in the last cascade layer,
    // so such a rule would win — the guard and the fix had moved in opposite
    // directions.
    //
    // This is the same invariant read from the other end: whatever a Badge is
    // handed as a `className` may add layout and may add what the component
    // has no opinion on (tracking, mono figures, flex-shrink), but may not
    // restate or override the geometry and type Badge computes for itself.
    // `font` is in the banned set as well as `font-size`: naming a role on a
    // component that composes its own type is the type-axis form of pinning
    // its box, and it is the shape the rules deleted here left behind.
    //
    // Read on the CONDITIONAL-INCLUSIVE view, unlike the chip and wrap scans
    // above. Those two ask about the unconditional box, where folding a
    // breakpoint in produces both false greens and false reds. This one asks
    // whether ANY product rule, under any condition, restates what the
    // component computes — a question with no unconditional/conditional
    // distinction. The difference was not academic: `.settingsHealthBlockerBadge`
    // lives entirely inside `@media (max-width: 620px)` (settings/health.css),
    // so on the unconditional view its merged body was empty, it could never
    // have been flagged, and the exemption naming it suppressed nothing. That
    // is the same defect this file exists to retire — a stated reason that is
    // false about the code it governs — so the view was widened rather than
    // the entry deleted.
    const css = stripCssComments(await readAllRendererCss());
    const merged = mergeBySelector(css, { includeConditional: true });
    const OWNED = new RegExp(
      `(?<![-\\w])(?:(?:min-|max-)?(?:height|block-size)|line-height|font|font-size|${PADDING}|border-radius)\\s*:`,
    );
    // The wrap/no-wrap duality again, read from the Badge side. A Badge is a
    // single-line pill by construction (`white-space: nowrap` and a fixed
    // `--spacing-5` height); a call site whose content genuinely wraps has to
    // release BOTH or the second line is clipped. That is a real need, not a
    // rule racing the component — but it is the only one, so it is named here
    // rather than pattern-matched.
    const RELEASES_THE_SINGLE_LINE_BOX = new Set([
      // Health blockers are sentences, not labels: at the 620px floor a full
      // sentence in a pill is wider than the content column, so this one
      // releases `height` and `white-space` together. Predates #1879.
      '.settingsHealthBlockerBadge',
    ]);
    const roots = [
      resolve(REPO_ROOT, 'apps/desktop/src/renderer'),
      resolve(REPO_ROOT, 'packages/ui/src'),
    ];
    const badges = await findBadgeClassNames(roots);
    // Guard the exemption, not just the rule, and guard it POSITIVELY. An
    // entry that suppresses nothing is indistinguishable in review from one
    // that suppresses a real finding — but "declares something OWNED" is too
    // weak a test of that, because re-pinning this badge to a fixed 20px also
    // declares something OWNED while doing the exact opposite of what the
    // exemption is for. The reason is "it releases the single-line box", so
    // that is what gets asserted: height genuinely released, and `white-space`
    // with it, since releasing one without the other still clips.
    //
    // BOTH IN ONE CASCADE CONTEXT. The flattened inclusive view is the right
    // instrument for the must-not scan below and the wrong one here: it answers
    // "does any rule anywhere say X" twice, which two rules under mutually
    // exclusive conditions satisfy without ever applying together. Measured,
    // leaving `height: auto` in `@media (max-width: 620px)` and moving
    // `white-space: normal` into `@media (min-width: 621px)` releases the box
    // at no viewport at all and passed both matches. So the pair is checked
    // per context, each read as the unconditional rules plus that context's.
    const contexts = mergeByContext(css);
    for (const selector of RELEASES_THE_SINGLE_LINE_BOX) {
      const byContext = contexts.get(selector) ?? new Map<string, string>();
      const base = byContext.get(UNCONDITIONAL) ?? '';
      const applied = [...byContext].map(([key, body]) => (key === UNCONDITIONAL ? body : base + body));
      assert.ok(
        applied.some(
          (body) =>
            /(?<![-\w])height\s*:\s*auto\b/.test(body) &&
            /white-space\s*:\s*(?:normal|pre-wrap|pre-line)\b/.test(body),
        ),
        `${selector} is exempted because it releases Badge's fixed height AND its nowrap; no single cascade context does both, so at every viewport the box is still clipped`,
      );
      assert.ok(
        badges.some(({ className }) => `.${className}` === selector),
        `${selector} is exempted from the Badge-geometry contract but is not on any <Badge>`,
      );
    }
    const offenders = badges
      .filter(({ className }) => !RELEASES_THE_SINGLE_LINE_BOX.has(`.${className}`))
      .filter(({ className }) => OWNED.test(merged.get(`.${className}`) ?? ''))
      .map(({ file, className }) => `.${className} (${file.replace(`${REPO_ROOT}/`, '')})`);
    assert.deepEqual(
      offenders,
      [],
      `a class on an Astryx <Badge> must not declare its height, padding, radius or type:\n${offenders.join('\n')}`,
    );
  });

  it('keeps every Badge className readable to the contract above', async () => {
    // `className={x}` would take a call site out of the scan without deleting
    // anything, which is how the enumerated inventories this file replaced
    // used to rot. There is no legitimate need for a computed class on a Badge
    // today; if one arrives, it needs a seam that stays checkable rather than
    // a quiet exit.
    //
    // A prop SPREAD is the same exit and was open until measured: rewriting a
    // real call site as `<Badge {...{ className: 'settingsOsPermissionImpactLabel' }} />`
    // is legal JSX that the static scan cannot read and that a `className={`
    // check does not match, so the contract above read it as a Badge with no
    // class at all and a `height` added to that class passed everything green.
    // Anything this scan cannot read has to say so rather than resolve to
    // "nothing to govern here".
    const unreadable = (await findUnreadableBadgeCallSites([
      resolve(REPO_ROOT, 'apps/desktop/src/renderer'),
      resolve(REPO_ROOT, 'packages/ui/src'),
    ])).map((file) => file.replace(`${REPO_ROOT}/`, ''));
    assert.deepEqual(
      unreadable,
      [],
      `a <Badge> whose className is computed or spread cannot be read statically, so it escapes the Badge-geometry contract:\n${unreadable.join('\n')}`,
    );
  });

  it('leaves the boxes that wrap unpinned', async () => {
    // The other half of #1879, and the half that is easy to "fix" wrongly: a
    // pinned height is only sound for content that cannot wrap. #1879 read
    // `.maka-plan-card-run` as already pinned and proposed it as the shape for
    // the rest. It declares no height — the 20px it measures at comes from the
    // Badge beside the message — and it must not gain one: measured, replacing
    // the message with a long string grows the row to many lines, so a 20px
    // pin would clip all but the first. The exact figure is deliberately not
    // recorded: a wrap threshold is a font metric, so it differs per platform
    // and would be a number that rots rather than an invariant.
    //
    // The selectors are `WRAPS` itself, not a second list beside it. Naming
    // them twice — once to excuse them from the pin scan, once to require
    // wrapping — let the two copies drift, and a selector dropped from one
    // while kept in the other reads as governed by both while governed by
    // neither.
    //
    // `CONSTRAINS_BLOCK_SIZE`, not `height` alone. `min-height: 20px;
    // max-height: 20px` clips a wrapping row exactly as `height: 20px` does,
    // and used to pass this check green.
    //
    // Repo-wide rather than file-local. The earlier revision read one
    // stylesheet, so appending `.maka-plan-card-run { height: 20px }` from any
    // other file satisfied it — the same bypass the heading and font-size
    // checks in this file already went repo-wide to close.
    //
    // And condition-inclusive, for the same reason as the component-owned
    // group: this is a must-NOT question. Measured, pinning `.maka-plan-card-run`
    // to 20px inside `@media (max-width: 620px)` clips its sentence at exactly
    // the width where the column is narrowest and wrapping likeliest, and the
    // unconditional view reported it green.
    const merged = mergeBySelector(stripCssComments(await readAllRendererCss()), {
      includeConditional: true,
    });
    for (const selector of WRAPS) {
      const body = merged.get(selector) ?? '';
      assert.ok(body !== '', `${selector} must still exist for its exemption to mean anything`);
      assert.doesNotMatch(
        body,
        CONSTRAINS_BLOCK_SIZE,
        `${selector} wraps by design; a fixed block size clips it rather than stabilising it`,
      );
    }
  });
});
