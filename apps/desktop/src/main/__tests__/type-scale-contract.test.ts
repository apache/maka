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
  findDynamicBadgeClassNames,
  findTextRoleOffenders,
  mergeBySelector,
  parseCssCustomProps,
  readAllRendererCss,
} from './css-test-helpers.js';

/**
 * A `height` declaration, excluding `min-height`, `max-height`, `line-height`
 * and custom properties. `block-size` is the logical alias and is the same
 * declaration to a browser, so a check that reads one and not the other is a
 * check with a documented bypass. The `\s*` before the colon is not cosmetic:
 * `height : 20px` is valid CSS.
 */
const HEIGHT_DECL = /(?<![-\w])(?:height|block-size)\s*:/;
const HEIGHT_DECL_G = /(?<![-\w])(?:height|block-size)\s*:([^;}]*)/g;
const RULER_VALUE = /^\s*var\(--h-control-[a-z0-9]+\)\s*$/;

/**
 * Does this box's EFFECTIVE height come from the control ruler?
 *
 * Effective, not "mentioned anywhere": CSS takes the last declaration, so a
 * body reading `height: var(--h-control-xs); … height: auto` is an unpinned
 * box that a test matching anywhere in the text reports as pinned. That is a
 * legal, one-line bypass of the whole contract, and this file already
 * documents the same false-green for custom properties.
 */
function pinnedToRuler(body: string): boolean {
  const values = [...body.matchAll(HEIGHT_DECL_G)].map((m) => m[1]);
  const last = values.at(-1);
  return last !== undefined && RULER_VALUE.test(last);
}

/**
 * The chips that carry pill chrome but must not take a `--h-control-*` height,
 * each for a reason that was measured rather than asserted. Anything not named
 * here has to pin, so growing this set is a deliberate act visible in review —
 * the property the enumerated inventory this replaced did not have.
 */
const EXEMPT = new Set([
  // A system-note block, not a chip: it wraps, and pinning clips every line but
  // the first. Keyed by its FULL prelude — the old key was the last line of a
  // multi-line selector, which also exempted any future rule ending that way.
  '.maka-chat-message[data-sender="system"] pre:not([data-maka-contract="markdown"] pre)',
  // `flex-wrap: wrap` is load-bearing — its buttons flow to a second line
  // inside the pill on the floor column (see that rule's own comment).
  '.settingsMemoryBackupCandidate',
  // Wraps too, and measured: its English copy is 317px on one line in a 260px
  // column. A pin here is only safe with `white-space: nowrap`, which trades a
  // clipped second line for a 57px overflow past the card. See that rule.
  '.settingsCapabilityOsPermissions li',
  // Sized by its Astryx component, which is the stronger form of the same
  // invariant: the height comes from `--size-element-*` rather than from a
  // product rule racing it. Declaring a height here would reintroduce the
  // override #1879 removed. The three composer `.astryx-selector` rules used
  // to sit in this list while still declaring a height — a reason that was
  // false about the CSS it excused. They declare no height at all now, so the
  // reason is finally true of every entry under it.
  //
  // `.maka-composer-model-chip` sat here too, on the same false reason: its
  // class is on `ModelChipStatic`'s inert `<span>`, never on the `Button` it
  // renders when it is clickable, so no component was sizing it and the
  // exemption hid a 22px box next to a 28px Selector. It pins like any other
  // chip now. `.maka-sidebar-update-button` is gone from the list for the
  // opposite reason — it declares neither a height nor pill chrome any more,
  // so neither filter selects it and the entry was inert.
  '.maka-model-switcher-trigger.astryx-selector',
  '.maka-new-chat-model-selector.astryx-selector',
  '.maka-thinking-level-selector.astryx-selector',
  // Deliberate literal. A `pointer-events: none` overlay on a button's corner:
  // it aligns with no control, so no neighbour names a tier, and the ruler's
  // smallest rung would grow a decorative badge by 25%. It is already pinned,
  // which is the invariant; only the vocabulary differs. Reasoning at the rule.
  '.maka-composer-skill-trigger-count',
]);

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
    // than a naming convention: pill radius plus its own padding plus its own
    // type. That is a box a reader perceives as a discrete object, which is
    // exactly the population whose height should come from the control ruler.
    // Merged per selector, not per rule block. A chip whose type lives in one
    // rule and whose pill chrome lives in another is one box to a browser and
    // was two invisible halves to the first revision of this scan — which is
    // exactly how `.plan-proposal-revision` sat five lines from a selector
    // this scan did catch and went unseen. Splitting a rule in two is not a
    // way to be exempt from it.
    const merged = mergeBySelector(stripCssComments(await readAllRendererCss()));

    // Pill radius only, and that boundary was measured rather than assumed:
    // widening the arm to `--radius-control` reported 27 offenders, among them
    // `pre` blocks, failure banners, sidebar rows and buttons — every one a box
    // a pin would clip. `--radius-control` is the repo's general control shape,
    // not a chip signal. The squared chips that motivated trying it are Astryx
    // `Badge`s now, so that population is empty rather than unguarded.
    //
    // Both type vocabularies count. #1893 folded the size/leading pair into a
    // `font:` role shorthand, and a scan that only knew the pair would have
    // gone green on an empty population the day that landed — the loudest
    // possible failure mode for a derived check is one that finds nothing.
    const OWNS_ITS_TYPE = /font:\s*var\(--maka-text-[\w-]+\)|line-height:\s*var\(--text-[\w-]+-leading\)/;
    const isChip = (body: string) =>
      /border-radius:\s*var\(--radius-pill\)/.test(body) &&
      /padding/.test(body) &&
      OWNS_ITS_TYPE.test(body);

    // Guard the guard: a predicate over declarations goes quiet, not red, when
    // the vocabulary it reads moves out from under it. #1893 moved it once
    // already.
    const chips = [...merged].filter(([, body]) => isChip(body));
    assert.ok(
      chips.length >= 8,
      `the chip predicate selected ${chips.length} rules — it has stopped seeing the population it governs`,
    );

    // Named exemptions, each with a measured reason. Anything not listed here
    // must pin, so adding a chip to this list is a deliberate act that shows
    // up in review — the property the eight-row table did not have.
    const offenders = chips
      .filter(([selector]) => !EXEMPT.has(selector))
      .filter(([, body]) => !pinnedToRuler(body))
      .map(([selector]) => selector);
    assert.deepEqual(
      offenders,
      [],
      `every chip must take its height from --h-control-*, or be named in EXEMPT with a measured reason:\n${offenders.join('\n')}`,
    );
  });

  it('pins the chrome-less chips the scan cannot see', async () => {
    // The scan above finds chips by their chrome. These two are chips by
    // behaviour and not by appearance — a timestamp and a ⌘N hint, both
    // deliberately styled with no pill, no background and no border — so no
    // predicate over declarations can distinguish them from ordinary inline
    // text. They are the two #1879 measured first, so they are listed rather
    // than derived, and the list is short because it can only ever hold boxes
    // that carry no chrome at all.
    for (const [file, selector] of [
      ['styles/chat-message.css', '.maka-message-time-inline'],
      ['styles/sidebar.css', '.maka-nav-kbd'],
    ] as const) {
      const body = cssRuleBody(stripCssComments(await read(file)), selector);
      assert.ok(body, `${file} must still declare ${selector}`);
      assert.ok(pinnedToRuler(body), `${selector} must take its height from --h-control-*`);
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
    const offenders = [...mergeBySelector(stripCssComments(await readAllRendererCss()))]
      .filter(([selector, body]) => pinnedToRuler(body) && !EXEMPT.has(selector))
      .filter(
        ([, body]) =>
          !(
            /display:\s*(?:inline-)?(?:flex|grid)/.test(body) &&
            /(?:align-items|place-items):\s*(?:safe\s+|unsafe\s+)?center/.test(body)
          ),
      )
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
    const css = stripCssComments(await readAllRendererCss());
    const merged = mergeBySelector(css);
    const OWNED = /(?<![-\w])(?:height|block-size|line-height|font|font-size|padding(?:-[a-z]+)?|border-radius)\s*:/;
    // The wrap/no-wrap duality again, read from the Badge side. A Badge is a
    // single-line pill by construction (`white-space: nowrap` and a fixed
    // `--spacing-5` height); a call site whose content genuinely wraps has to
    // release BOTH or the second line is clipped. That is a real need, not a
    // rule racing the component — but it is the only one, so it is named here
    // rather than pattern-matched.
    const RELEASES_THE_SINGLE_LINE_BOX = new Set([
      // Health blockers are sentences, not labels. Predates #1879.
      '.settingsHealthBlockerBadge',
    ]);
    const roots = [
      resolve(REPO_ROOT, 'apps/desktop/src/renderer'),
      resolve(REPO_ROOT, 'packages/ui/src'),
    ];
    const offenders = (await findBadgeClassNames(roots))
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
    const dynamic = (await findDynamicBadgeClassNames([
      resolve(REPO_ROOT, 'apps/desktop/src/renderer'),
      resolve(REPO_ROOT, 'packages/ui/src'),
    ])).map((file) => file.replace(`${REPO_ROOT}/`, ''));
    assert.deepEqual(
      dynamic,
      [],
      `<Badge className={…}> cannot be read statically, so it escapes the Badge-geometry contract:\n${dynamic.join('\n')}`,
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
    // Repo-wide rather than file-local. The earlier revision read one
    // stylesheet, so appending `.maka-plan-card-run { height: 20px }` from any
    // other file satisfied it — the same bypass the heading and font-size
    // checks in this file already went repo-wide to close.
    const merged = mergeBySelector(stripCssComments(await readAllRendererCss()));
    for (const selector of [
      '.maka-plan-card-run',
      '.maka-plan-card-schedule',
      '.settingsMemoryBackupCandidate',
      '.settingsCapabilityOsPermissions li',
    ]) {
      const body = merged.get(selector) ?? '';
      const offenders = HEIGHT_DECL.test(body) ? [body.trim()] : [];
      assert.deepEqual(
        offenders,
        [],
        `${selector} wraps by design; a pinned height clips it rather than stabilising it`,
      );
    }
  });
});
