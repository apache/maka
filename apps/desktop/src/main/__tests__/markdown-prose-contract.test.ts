/**
 * MARKDOWN-PROSE-CONVERGE-0 (issue #546 PR4): the Markdown prose element
 * layer (.maka-prose) is the single home for assistant-message body
 * typography — p / h* / ul / ol / li / a / code / pre / blockquote / table
 * / th / td / hr. It is split off the .maka-bubble-assistant shell so the
 * same prose rules can be reused by other Markdown consumers (tool-result
 * bodies, #546 PR6) without inheriting bubble geometry (padding) that
 * belongs to the assistant surface specifically.
 *
 * Three invariants:
 *
 * 1. Prose element rules live under .maka-prose, not .maka-bubble-assistant.
 *    The shell keeps only container geometry (padding); element typography
 *    (margins, font-size, list style, link/border, code padding,
 *    blockquote/table chrome) and the load-bearing base typography
 *    (color / line-height / break-word / edge trims — #618
 *    item 2, locked by PROSE-SELF-CONTAINED in the polish contract below)
 *    live on .maka-prose.
 *
 * 2. The assistant Bubble variant carries `maka-prose` alongside
 *    `maka-bubble-assistant`, so an assistant message actually renders the
 *    prose layer (the class is what activates the descendant rules).
 *
 * 3. .maka-prose is authored in prose.css (the reusable markdown surface
 *    file, split out of chat-message.css at the PR6 boundary — #618 item 3)
 *    — one home, not scattered back into chat-message.css or maka-tokens.css.
 *
 * Scope note: this contract locks prose-element *ownership* (which selector
 * scope owns p/h/ul/... rules). The *values* those rules use (font-size,
 * spacing, line-height, radius) are governed by the existing typography /
 * line-height / spacing / radius / border-width converge contracts — this
 * test does not re-scan them.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, stripCssComments } from './css-test-helpers.js';

const PROSE_CSS = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles', 'prose.css');
const MARKDOWN_BODY = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'markdown-body.tsx');
const CHAT_MESSAGE_CSS = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles', 'chat-message.css');
const TOKENS_CSS = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'maka-tokens.css');
const CHAT_PRIMITIVE = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'primitives', 'chat.tsx');

/** Markdown block + inline elements whose typography the prose layer owns. */
const PROSE_ELEMENTS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'a',
  'code', 'pre', 'blockquote', 'table', 'th', 'td', 'hr', 'img',
] as const;

/**
 * Split CSS into individual leaf selectors (the comma-separated, pre-`{`
 * selector text of every rule block), so a grouped selector list like
 * `.maka-prose h1, .maka-prose h2,` yields two entries.
 *
 * Strips comments first; treats the CSS as flat (chat-message.css has no
 * nesting — only `@media` / `@keyframes` at-rules, whose inner selectors
 * are still extracted, which is fine because none of the prose elements
 * live inside them).
 */
function leafSelectors(css: string): string[] {
  const stripped = stripCssComments(css);
  // Everything between a `}` (or start) and the next `{` is a selector list.
  const selectorLists = stripped
    .split('{')
    .map((chunk, i, arr) => (i < arr.length - 1 ? chunk.split('}').pop()! : ''))
    .filter(Boolean);
  return selectorLists.flatMap((list) => list.split(',').map((s) => s.trim()));
}

describe('MARKDOWN-PROSE-CONVERGE-0 contract (#546 PR4)', () => {
  it('every Markdown prose element has a rule scoped under .maka-prose', async () => {
    const css = await readFile(PROSE_CSS, 'utf8');
    const selectors = leafSelectors(css);
    const missing: string[] = [];
    for (const el of PROSE_ELEMENTS) {
      const has = selectors.some((sel) => sel.startsWith('.maka-prose') && new RegExp(`\\b${el}\\b`).test(sel));
      if (!has) missing.push(el);
    }
    assert.deepEqual(
      missing,
      [],
      `prose.css must scope these prose elements under .maka-prose (found none): ${missing.join(', ')}`,
    );
  });

  it('no prose element rule lingers scoped under .maka-bubble-assistant', async () => {
    const css = [
      await readFile(CHAT_MESSAGE_CSS, 'utf8'),
      await readFile(PROSE_CSS, 'utf8'),
    ].join('\n');
    const lingering: string[] = [];
    for (const el of PROSE_ELEMENTS) {
      // `.maka-bubble-assistant <el>` as a descendant — the old prose form.
      // The shell's own `.maka-bubble-assistant {…}` and its generic
      // `> :first-child` / `> :last-child` resets are element-agnostic, so
      // they don't trip this (no bare element type).
      const re = new RegExp(`\\.maka-bubble-assistant\\s+${el}\\b`);
      if (re.test(stripCssComments(css))) lingering.push(el);
    }
    assert.deepEqual(
      lingering,
      [],
      `these prose elements are still scoped under .maka-bubble-assistant — move them to .maka-prose: ${lingering.join(', ')}`,
    );
  });

  it('the assistant Bubble variant carries maka-prose so the prose layer applies', async () => {
    const src = await readFile(CHAT_PRIMITIVE, 'utf8');
    // bubbleVariants assistant emits both the shell and the prose layer.
    assert.match(
      src,
      /assistant:\s*["'`]maka-bubble-assistant\s+maka-prose["'`]/,
      'bubbleVariants assistant must be "maka-bubble-assistant maka-prose" so .maka-prose descendant rules render on assistant messages',
    );
  });

  it('.maka-prose is authored in prose.css, not repooled into chat-message.css or maka-tokens.css', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_CSS, 'utf8'));
    assert.ok(
      !/\.maka-prose\b/.test(tokens),
      '.maka-prose must live in prose.css (the reusable markdown surface), not maka-tokens.css',
    );
    const chat = stripCssComments(await readFile(CHAT_MESSAGE_CSS, 'utf8'));
    assert.ok(
      !/\.maka-prose\b/.test(chat),
      '.maka-prose must live in prose.css — chat-message.css keeps only message-surface chrome (#618 item 3)',
    );
  });
});

/**
 * Split a comment-stripped CSS string into [selectorList, decls] block pairs.
 * Flat parser (chat-message.css has no nesting beyond @media/@keyframes, whose
 * inner rules still split cleanly).
 */
function cssBlocks(css: string): Array<{ selectors: string; decls: string }> {
  return css
    .split('}')
    .map((chunk) => chunk.split('{'))
    .filter((parts) => parts.length === 2)
    .map(([selectors, decls]) => ({ selectors: selectors.trim(), decls: (decls ?? '').trim() }));
}

describe('MARKDOWN-CODE-LITERAL-LIGATURES-0 contract (#1431)', () => {
  // Geist Mono enables programming ligatures by default. On Markdown code
  // that collapses runs like `###` / `===` / `=>` into combined glyphs whose
  // ink and advance can extend left of the source column, so fenced lines
  // appear misaligned. Other literal surfaces already pin
  // `font-variant-ligatures: none` (`.maka-code`). The prose code boundary
  // must do the same so both inline and fenced code inherit literal shaping.
  // Non-code prose typography stays untouched.

  it('.maka-prose code disables font ligatures for literal character shaping', async () => {
    const css = stripCssComments(await readFile(PROSE_CSS, 'utf8'));
    const blocks = cssBlocks(css);
    const code = blocks.find(({ selectors }) => /^\.maka-prose\s+code$/.test(selectors));
    assert.ok(code, 'expected a bare .maka-prose code rule in prose.css');
    assert.match(
      code!.decls,
      /font-variant-ligatures:\s*none/,
      '.maka-prose code must set font-variant-ligatures: none so Markdown inline and fenced code render ### / === / => literally (#1431)',
    );
  });

  it('non-code prose base does not disable ligatures (prose typography unchanged)', async () => {
    const css = stripCssComments(await readFile(PROSE_CSS, 'utf8'));
    const blocks = cssBlocks(css);
    const prose = blocks.find(({ selectors }) => selectors === '.maka-prose');
    assert.ok(prose, 'expected a bare .maka-prose base rule');
    assert.ok(
      !/font-variant-ligatures/.test(prose!.decls),
      '.maka-prose must not disable ligatures globally — only the code surface is a literal glyph surface (#1431)',
    );
  });
});

describe('CODE-BLOCK-PRE-FONT-TIER-0 contract (#546 PR5)', () => {
  // The assistant code block <pre> must render at the UI/chrome tier
  // (--font-size-ui), NOT inherit the prose body size. A pre-existing reset
  //   [data-slot="message"] pre { margin: 0; font: inherit }   (specificity 0,1,1)
  // in chat-message.css sits in the same layer(components) as prose.css, so a
  // bare `.maka-prose pre` rule (also 0,1,1) would win or lose on nothing but
  // styles.css import order — a footgun either way. The code-block pre rule
  // must therefore carry an extra class — `.maka-prose .maka-code-block pre`
  // (specificity 0,2,1) — so it outweighs the reset regardless of file order
  // and the token tier holds. The reset itself stays, so non-code-block raw
  // <pre> (user / system) still inherits the message font instead of falling
  // back to the UA monospace.

  it('the code-block pre is scoped to outweigh the [data-slot=message] reset and uses --font-size-ui', async () => {
    const css = stripCssComments(await readFile(PROSE_CSS, 'utf8'));
    const blocks = cssBlocks(css);
    const cb = blocks.find(({ selectors, decls }) =>
      /\.maka-code-block\s+pre\b/.test(selectors)
      && /font-size:\s*var\(--font-size-ui\)/.test(decls));
    assert.ok(
      cb,
      'expected a rule scoped `.maka-prose .maka-code-block pre { font-size: var(--font-size-ui) }` (specificity 0,2,1) to outweigh the `[data-slot="message"] pre { font: inherit }` reset (0,1,1); a bare `.maka-prose pre` is clobbered by the later reset',
    );
  });

  it('the [data-slot=message] pre reset still exists for non-code-block raw pre', async () => {
    const css = stripCssComments(await readFile(CHAT_MESSAGE_CSS, 'utf8'));
    assert.match(
      css,
      /\[data-slot="message"\]\s+pre\s*\{[^}]*font:\s*inherit/,
      'the [data-slot="message"] pre { font: inherit } reset must remain so non-code-block raw <pre> (user / system) inherits the message font instead of UA monospace',
    );
  });
});

describe('PROSE-POLISH-13PX-0 contract (#546 Phase B)', () => {
  // Four rendering defects fixed in the 13px prose-polish pass. Each is the
  // kind of regression that survives visual review (subtle in light theme,
  // state-dependent, or masked by fixture structure), so the shape of the
  // fix is pinned here.

  it('no structural :nth-last-child hacks on prose containers (PR #212 timestamp leftovers)', async () => {
    const css = stripCssComments([
      await readFile(CHAT_MESSAGE_CSS, 'utf8'),
      await readFile(PROSE_CSS, 'utf8'),
    ].join('\n'));
    // The bubble stopped ending with an inline timestamp child long ago;
    // these selectors instead zeroed/inlined the second-to-last *markdown*
    // block (paragraph glued to a heading/table/code block above it).
    assert.ok(
      !/\.maka-bubble-assistant\s*>\s*:nth-last-child/.test(css)
      && !/\.maka-prose\s*>\s*p:nth-last-child/.test(css),
      'structural :nth-last-child prose hacks must not return — they assume a trailing non-markdown child that no longer exists',
    );
    // The streaming ▎ caret (and its trailing-<p> inline hack) was retired by
    // the streaming UI rework — the "still writing" signal is the per-word
    // fade-in — so the streaming bubble must NOT re-introduce a
    // `p:last-child { display: inline }` rule that would collapse block spacing.
    assert.ok(
      !/\.maka-bubble-streaming\s*>\s*p:last-child\s*\{[^}]*display:\s*inline/.test(css),
      'the retired caret-inline hack must not return — the trailing paragraph keeps normal block layout',
    );
    // Negative side of the same contract: an unscoped variant on the
    // committed-message classes would inline the final paragraph of every
    // settled message — the exact regression this pass removed.
    assert.ok(
      !/\.maka-prose\s*>\s*p:last-child/.test(css)
      && !/\.maka-bubble-assistant\s*>\s*p:last-child/.test(css),
      'no p:last-child inlining on .maka-prose / .maka-bubble-assistant — committed messages must keep block paragraphs',
    );
  });

  it('the code-block pre code reset clears the inline-code border', async () => {
    const css = stripCssComments(await readFile(PROSE_CSS, 'utf8'));
    const blocks = cssBlocks(css);
    const reset = blocks.find(({ selectors, decls }) =>
      /\.maka-code-block\s+pre\s+code\b/.test(selectors) && /border:\s*0/.test(decls));
    assert.ok(
      reset,
      '`.maka-prose .maka-code-block pre code` must reset `border: 0` — the inline-code pill dropped its border in this pass, but if one ever returns it paints a rounded outline around every wrapped line box inside the pre (inline elements paint per line box)',
    );
  });

  it('prose tables are frameless with a reinforced header rule', async () => {
    const css = stripCssComments(await readFile(PROSE_CSS, 'utf8'));
    const blocks = cssBlocks(css);
    const table = blocks.find(({ selectors }) => /^\.maka-prose\s+table$/.test(selectors));
    assert.ok(table, 'expected a .maka-prose table rule');
    // Style picked from a four-way comparison (#546 Phase B): no outer
    // frame, no radius, no header fill — the header/body split is carried
    // by semibold + a rule stronger than the hairline row separators.
    assert.ok(
      !/(^|;)\s*border\s*:/.test(table!.decls) && !/border-radius/.test(table!.decls),
      'prose tables are frameless — no outer border/radius on .maka-prose table',
    );
    // `border-collapse` is the declaration that actually reaches the
    // anonymous inner table box (inherited); `border-spacing: 0` is intent
    // documentation — the property is not inherited and its initial value
    // is already 0.
    assert.match(table!.decls, /border-collapse:\s*separate/, 'separate border model — collapse would void radius/outer borders if chrome ever returns');
    assert.match(table!.decls, /border-spacing:\s*0/, 'zero border-spacing keeps the row separators seamless single hairlines');
    const th = blocks.find(({ selectors }) => /^\.maka-prose\s+th$/.test(selectors));
    assert.ok(th, 'expected a .maka-prose th rule');
    assert.ok(
      !/background/.test(th!.decls)
      && /border-bottom:\s*var\(--border-width-hairline\)\s+solid\s+oklch\(from var\(--foreground\)/.test(th!.decls),
      'th carries no fill and a foreground-alpha rule stronger than --border for the header split',
    );
    // Cascade guard: the last-row border reset must be tbody-scoped. The
    // GFM thead row is its parent's :last-child too, and an unscoped
    // `.maka-prose tr:last-child th` (0,2,2) out-specifies `.maka-prose th`
    // (0,1,1) — it silently erases the reinforced header rule asserted
    // above while this declaration-level scan keeps passing.
    assert.ok(
      !/\.maka-prose\s+tr:last-child/.test(css),
      'the last-row border reset must not use an unscoped `.maka-prose tr:last-child` — it matches the thead row and kills the header rule; scope it to tbody',
    );
    assert.match(
      css,
      /\.maka-prose\s+tbody\s+tr:last-child\s+th,\s*\.maka-prose\s+tbody\s+tr:last-child\s+td\s*\{[^}]*border-bottom:\s*0/,
      'frameless tables must still drop the stray rule under the final body row',
    );
  });

  it('the .maka-prose base rule is self-contained: load-bearing typography lives on the prose layer, not the shell', async () => {
    // #618 item 2 (PR6 prerequisite): a bare `.maka-prose` consumer — none
    // exists today beyond the assistant/system bubble (the tool-result-body
    // consumer was reverted), but the layer must stay reusable — must not
    // depend on `.maka-bubble-assistant` for line-height (the
    // WCAG 1.4.12 floor — var(--leading-normal) = 1.5), word-wrap (no global
    // overflow-wrap fallback exists — long URLs/tokens overflow horizontally),
    // color, or the first/last-child edge-margin trims. (The reading
    // measure is NOT set here — see the max-width assertion below.)
    // Moving them is behavior-neutral in chat: the assistant div carries both
    // classes, same specificity, same layer.
    const css = stripCssComments(await readFile(PROSE_CSS, 'utf8'));
    const blocks = cssBlocks(css);
    const prose = blocks.find(({ selectors }) => selectors === '.maka-prose');
    assert.ok(prose, 'expected a bare .maka-prose base rule in prose.css');
    assert.match(prose!.decls, /color:\s*var\(--foreground\)/, '.maka-prose must set its own text color — a bare consumer would inherit whatever UI chrome surrounds it');
    assert.match(prose!.decls, /font-family:\s*var\(--font-sans\)/, '.maka-prose must pin font-family — the tool card item shell sets font-mono, which inherits into the text-kind prose body (codex review P2)');
    assert.match(prose!.decls, /font-size:\s*var\(--font-size-base\)/, '.maka-prose must pin font-size to the body tier — the tool card item shell sets text-xs (11px caption), which inherits into the prose body and scales the whole em-based heading ladder down (codex review P2)');
    assert.match(prose!.decls, /line-height:\s*var\(--leading-normal\)/, '.maka-prose must pin line-height to var(--leading-normal): it is the WCAG 1.4.12 floor (1.5) — inherited UI line-heights can dip below it at 13px');
    assert.match(prose!.decls, /(?:word-wrap|overflow-wrap):\s*break-word/, '.maka-prose must carry break-word — no global overflow-wrap fallback exists, so a bare consumer gets horizontally overflowing URLs/tokens');
    assert.ok(
      !/max-width\s*:/.test(prose!.decls),
      '.maka-prose must not set its own max-width — the reading measure is owned by .maka-message-row (var(--maka-chat-measure), the same cap the composer uses), so the assistant block matches the composer width instead of being narrowed by an inner readability cap',
    );
    assert.match(
      css,
      /\.maka-prose\s*>\s*:first-child\s*\{[^}]*margin-top:\s*0/,
      '.maka-prose > :first-child must trim the leading margin — a bare consumer opening with a heading would carry its 20px top margin',
    );
    assert.match(
      css,
      /\.maka-prose\s*>\s*:last-child\s*\{[^}]*margin-bottom:\s*0/,
      '.maka-prose > :last-child must trim the trailing margin',
    );
    assert.match(
      css,
      /\.maka-prose\s*>\s*\.maka-markdown-root\s*>\s*:first-child\s*\{[^}]*margin-top:\s*0/,
      'the Streamdown root must forward the leading edge trim to its first Markdown block',
    );
    assert.match(
      css,
      /\.maka-prose\s*>\s*\.maka-markdown-root\s*>\s*:last-child\s*\{[^}]*margin-bottom:\s*0/,
      'the Streamdown root must forward the trailing edge trim to its last Markdown block',
    );
    // One home: the shell keeps only container geometry (padding). Duplicated
    // typography on the shell would silently drift from the prose layer.
    const chat = stripCssComments(await readFile(CHAT_MESSAGE_CSS, 'utf8'));
    const shell = cssBlocks(chat).find(({ selectors }) => selectors === '.maka-bubble-assistant');
    assert.ok(shell, 'expected a .maka-bubble-assistant shell rule in chat-message.css');
    for (const prop of ['color', 'line-height', 'word-wrap', 'overflow-wrap', 'max-width']) {
      assert.ok(
        !new RegExp(`(?:^|;)\\s*${prop}:`).test(shell!.decls),
        `.maka-bubble-assistant must not duplicate ${prop} — it moved to .maka-prose (#618 item 2); the shell keeps only container geometry`,
      );
    }
    assert.ok(
      !/\.maka-bubble-assistant\s*>\s*:(first|last)-child/.test(chat),
      'the edge-margin trims moved to .maka-prose > :first/:last-child — the shell must not keep a duplicate pair',
    );
    // Source-order guard (codex review P3): `.maka-prose > :last-child`
    // (0,2,0) TIES with class-carrying children — `.maka-prose
    // .maka-table-scroll` and `.maka-prose .maka-code-block` are also
    // (0,2,0) — so whichever is declared later wins. The trims must be
    // authored after every margin-declaring prose rule or a trailing
    // table/code block keeps its 12px bottom margin and the edge trim
    // silently dies.
    const trimIdx = blocks.findIndex(({ selectors }) => /^\.maka-prose\s*>\s*:last-child$/.test(selectors));
    assert.ok(trimIdx >= 0, 'expected a .maka-prose > :last-child trim rule');
    for (const sel of [/^\.maka-prose\s+\.maka-table-scroll$/, /^\.maka-prose\s+\.maka-code-block$/]) {
      const idx = blocks.findIndex(({ selectors }) => sel.test(selectors));
      assert.ok(idx >= 0, `expected a rule matching ${sel}`);
      assert.ok(
        trimIdx > idx,
        `the .maka-prose > :last-child trim must be authored AFTER ${sel} — equal specificity (0,2,0) means source order decides, and the margin rule would beat the trim`,
      );
    }
  });

  it('prose images flow inline again despite the Tailwind preflight block', async () => {
    // #618 item 4: Tailwind v4 preflight sets `img { display: block;
    // max-width: 100% }` in @layer base. A markdown image mid-paragraph
    // (badge, inline icon) then breaks the line. layer(components)
    // outranks base, so a .maka-prose img rule restores the inline flow;
    // preflight's max-width: 100% + height: auto stay in effect.
    const css = stripCssComments(await readFile(PROSE_CSS, 'utf8'));
    const blocks = cssBlocks(css);
    const img = blocks.find(({ selectors }) => /^\.maka-prose\s+img$/.test(selectors));
    assert.ok(img, 'expected a .maka-prose img rule');
    assert.match(img!.decls, /display:\s*inline-block/, 'prose img must restore inline flow (inline-block) over the preflight display: block');
  });

  it('blockquote inner block margins are neutralized at both ends', async () => {
    const css = stripCssComments(await readFile(PROSE_CSS, 'utf8'));
    const blocks = cssBlocks(css);
    const last = blocks.find(({ selectors, decls }) =>
      /\.maka-prose\s+blockquote\s*>\s*:last-child/.test(selectors) && /margin-bottom:\s*0/.test(decls));
    assert.ok(
      last,
      'blockquote > :last-child must zero margin-bottom — a trailing p margin stacks on the quote padding (8px top vs 20px bottom) and tilts the quote',
    );
    const first = blocks.find(({ selectors, decls }) =>
      /\.maka-prose\s+blockquote\s*>\s*:first-child/.test(selectors) && /margin-top:\s*0/.test(decls));
    assert.ok(
      first,
      'blockquote > :first-child must zero margin-top — the other end of the same stacking asymmetry',
    );
  });
});

describe('TABLE-A11Y-SEMANTICS-0 contract (#618 item 5)', () => {
  // The Phase B shrink-wrap shape put `display: block` on the table itself
  // (GitHub's markdown CSS trade-off): the element stops generating a table
  // box, Chromium drops the implicit table/row/cell ARIA roles, and screen
  // readers lose table navigation. Proper fix: the markdown component layer
  // wraps <table> in a scroll <div> and the table keeps `display: table` —
  // semantics come back, the shrink-wrap (width: max-content) + 100% cap +
  // overflow-x scroller behavior moves to the wrapper.

  it('markdown-body wraps tables in a scroll div so the table keeps its ARIA semantics', async () => {
    const src = await readFile(MARKDOWN_BODY, 'utf8');
    assert.match(
      src,
      /table:[\s\S]{0,200}maka-table-scroll/,
      'markdown-body.tsx must override `table` with a .maka-table-scroll wrapper div — scrolling on the table itself requires display: block, which strips the ARIA table roles',
    );
  });

  it('prose tables keep display: table; the scroll behavior lives on the wrapper', async () => {
    const css = stripCssComments(await readFile(PROSE_CSS, 'utf8'));
    const blocks = cssBlocks(css);
    const table = blocks.find(({ selectors }) => /^\.maka-prose\s+table$/.test(selectors));
    assert.ok(table, 'expected a .maka-prose table rule');
    assert.match(table!.decls, /display:\s*table/, '.maka-prose table must generate a real table box (display: table) so Chromium keeps the implicit table/row/cell ARIA roles');
    assert.ok(!/overflow-x/.test(table!.decls), 'the overflow-x scroller belongs on .maka-table-scroll, not the table (scrolling tables need display: block, which kills the semantics)');
    const wrapper = blocks.find(({ selectors }) => /\.maka-prose\s+\.maka-table-scroll$/.test(selectors));
    assert.ok(wrapper, 'expected a .maka-prose .maka-table-scroll wrapper rule');
    assert.match(wrapper!.decls, /overflow-x:\s*auto/, 'the wrapper carries the horizontal scroller for over-wide tables');
    assert.match(wrapper!.decls, /max-width:\s*100%/, 'the wrapper caps at the prose measure so wide tables scroll instead of stretching the bubble');
  });
});

describe('MARKDOWN-PROSE-HEADING-HIERARCHY-0 contract (#739)', () => {
  // Issue #739: the #546 Phase B ladder (1.4615 / 1.2308 / 1.0769 / 1) chased
  // integer px targets at the 13px base, but h3 (1.0769em, +8% over body) was
  // too close to body copy — long answers relied on weight alone to
  // distinguish H3 sections. #739 re-pins the ladder to a uniform 0.15em
  // step (1.45 / 1.30 / 1.15 / 1): each tier clears the one below by a fixed
  // 0.15em increment (≈2px at the 13px base; the relative gap widens per tier
  // — +15% over body for h3, +13% over h3 for h2, +12% over h2 for h1),
  // CDP-verified as the minimum distinguishable step.
  //
  // This contract locks the STEP, not specific em values: a future patch
  // may widen the step (e.g. 0.20em for a roomier ladder), but must not
  // narrow it back to the #546 shape where h3-h4 = 0.08em and hierarchy
  // collapses back onto weight. h4 stays at 1em (GitHub's 1em h4
  // convention: a heading via weight + secondary color, not size).
  //
  // Source of truth: issue #739 acceptance ("H2/H3 sections clearly
  // distinguishable from body copy") + CDP comparison of +8% / +15% / +23%
  // h3 tiers — the 0.15em step was the smallest gap that read as a section.
  const HEADING_STEP_EM = 0.15;

  const headingEm = (blocks: ReturnType<typeof cssBlocks>, sel: string): number => {
    const b = blocks.find(({ selectors }) => selectors === sel);
    assert.ok(b, `expected ${sel} rule in prose.css`);
    const m = b!.decls.match(/font-size:\s*([\d.]+)em/);
    assert.ok(m, `expected a font-size em declaration on ${sel}; got ${b!.decls}`);
    return parseFloat(m![1]);
  };

  it('each heading tier clears the one below by >=0.15em so hierarchy reads by size, not weight alone', async () => {
    const css = stripCssComments(await readFile(PROSE_CSS, 'utf8'));
    const blocks = cssBlocks(css);
    const h1 = headingEm(blocks, '.maka-prose h1');
    const h2 = headingEm(blocks, '.maka-prose h2');
    const h3 = headingEm(blocks, '.maka-prose h3');
    const h4 = headingEm(blocks, '.maka-prose h4');
    // Compare via toFixed(4) — exact enough to reject a 0.1451em gap, but
    // robust to float noise (1.15 - 1.0 = 0.14999... rounds to 0.1500). A
    // centi-em Math.round(x*100) check would let 1.1451em through (115 vs
    // 100, gap "15"), understating the threshold.
    const gap = (a: number, b: number) => parseFloat((a - b).toFixed(4));
    assert.equal(h4, 1, 'h4 sits at 1em and reads as a heading via weight + secondary color (GitHub 1em h4 convention)');
    assert.ok(gap(h3, h4) >= HEADING_STEP_EM, `h3 (${h3}em) must clear body by >=${HEADING_STEP_EM}em so it reads as a section, not body; got ${gap(h3, h4)}em (the #546 ladder's 0.0769em gap was the #739 defect)`);
    assert.ok(gap(h2, h3) >= HEADING_STEP_EM, `h2 (${h2}em) must clear h3 by >=${HEADING_STEP_EM}em; got ${gap(h2, h3)}em`);
    assert.ok(gap(h1, h2) >= HEADING_STEP_EM, `h1 (${h1}em) must clear h2 by >=${HEADING_STEP_EM}em; got ${gap(h1, h2)}em`);
  });
});

describe('MARKDOWN-PROSE-RENDER-OWNER-0 contract (#739)', () => {
  // Streamdown's default components tag every markdown element with Tailwind
  // utility classes (h1 "text-3xl", h3 "text-xl", th/td "px-4 py-2 text-sm",
  // thead "bg-muted/80", tbody "divide-y", blockquote "border-l-4", ul
  // "list-disc", ...). Those sit in the `utilities` cascade layer and override
  // prose.css's `components`-layer markdown rules, so the .maka-prose layer
  // never reached the rendered DOM — the heading ladder and table padding
  // declared in prose.css were silently overwritten (#739). markdown-body.tsx
  // renders bare semantic elements via bareElement so prose.css owns all
  // markdown typography. This contract locks the bare override for the
  // heading + table-structure elements so a future patch does not silently
  // drop it and let Streamdown's utilities back in (which would re-break the
  // heading ladder and table fit the moment Tailwind generates those classes
  // from elsewhere in the codebase).
  const BARE_OVERRIDDEN = ['h1', 'h2', 'h3', 'h4', 'blockquote', 'ul', 'li', 'thead', 'tbody', 'tr', 'th', 'td'] as const;
  const NOT_OVERRIDDEN = ['p', 'ol', 'section', 'h5', 'h6'] as const;

  it('markdown-body overrides heading + table-structure elements with bareElement so prose.css reaches the DOM', async () => {
    const src = await readFile(MARKDOWN_BODY, 'utf8');
    assert.match(src, /function bareElement/, 'markdown-body.tsx must define a bareElement helper that strips Streamdown utility classes so prose.css reaches the rendered markdown (#739)');
    for (const tag of BARE_OVERRIDDEN) {
      assert.match(
        src,
        new RegExp(`\\b${tag}:\\s*bareElement\\(['"]${tag}['"]\\)`),
        `markdown-body.tsx components prop must override ${tag} with bareElement('${tag}') so prose.css rules reach the rendered ${tag} instead of Streamdown's Tailwind utilities`,
      );
    }
  });

  it('markdown-body does NOT override p/ol/section/h5/h6 (functional logic or no prose.css rule)', async () => {
    const src = await readFile(MARKDOWN_BODY, 'utf8');
    for (const tag of NOT_OVERRIDDEN) {
      assert.ok(
        !new RegExp(`\\b${tag}:\\s*bareElement\\(['"]${tag}['"]\\)`).test(src),
        `markdown-body.tsx must NOT override ${tag} with bareElement — p/ol/section carry Streamdown functional logic (p unwraps a lone image; ol/section clean streaming footnotes), and h5/h6 have no prose.css rule so stripping would lose Streamdown's heading styling`,
      );
    }
  });

  it('Daily Review section-body carries .maka-prose so heading/table get a prose-css owner outside the chat bubble', async () => {
    const src = await readFile(resolve(REPO_ROOT, 'packages', 'ui', 'src', 'daily-review-panel.tsx'), 'utf8');
    assert.match(
      src,
      /maka-daily-review-archive-section-body[^"]* maka-prose|maka-prose[^"]* maka-daily-review-archive-section-body/,
      'daily-review-panel.tsx must put .maka-prose on the section-body div so heading/table/blockquote get prose.css styling — they have no Streamdown utility fallback now that markdown-body strips utilities, and Daily Review has no chat-bubble .maka-prose ancestor (#739)',
    );
  });
});

/**
 * MARKDOWN-PROSE-CJK-MIXED-SPACING-0: Maka is CJK-first and its assistant
 * prose is dense mixed script, so `.maka-prose` asks for CJK/Latin autospace
 * and gives inline code pills their own margin. Both rationales live next to
 * the rules in prose.css; this locks that they are still there.
 *
 * The third pair of tests is the one that matters. Both spacing rules are
 * PROSE decoration that reaches fenced code unless carved back out —
 * autospace inherits, and `.maka-prose code` (0,1,1) matches `pre > code` too.
 * Shipping them uncarved put the first line of every code block 3.25px right
 * of the lines below it and drifted mixed-script lines off the monospace grid.
 * That is the invariant #1431 already locked for ligatures, reached a second
 * time by different properties, so these guard the BOUNDARY as a property
 * class: they fail for any future shaping declaration too, not just these two.
 *
 * Numbers here come from the built Electron app, never headless — headless
 * falls PingFang SC back to a serif face while `document.fonts.check` still
 * returns true, which voids every font-dependent measurement taken there.
 */
describe('MARKDOWN-PROSE-CJK-MIXED-SPACING-0 contract', () => {
  it('.maka-prose asks for CJK/Latin autospace (Chromium defaults to no-autospace)', async () => {
    const css = stripCssComments(await readFile(PROSE_CSS, 'utf8'));
    const prose = cssBlocks(css).find(({ selectors }) => selectors === '.maka-prose');
    assert.ok(prose, 'expected a bare .maka-prose base rule in prose.css');
    assert.match(
      prose!.decls,
      /text-autospace:\s*normal/,
      ".maka-prose must set text-autospace: normal — Chromium's initial value is no-autospace, so a CJK-first product gets no CJK/Latin boundary spacing unless it asks (measured +1.55px per boundary at 13px)",
    );
  });

  it('inline code keeps a margin gap so code pills do not glue to surrounding Chinese', async () => {
    const css = stripCssComments(await readFile(PROSE_CSS, 'utf8'));
    const code = cssBlocks(css).find(({ selectors }) => /^\.maka-prose\s+code$/.test(selectors));
    assert.ok(code, 'expected a .maka-prose code rule');
    assert.match(
      code!.decls,
      /margin-inline:\s*0\.25em/,
      '.maka-prose code must carry margin-inline: 0.25em — text-autospace alone leaves only 1.55px against a pill that already has inline padding and a background',
    );
  });

  /**
   * Glyph-reshaping properties that INHERIT into fenced code, each with the
   * value that actually neutralises it there. The first version of this
   * contract only checked that the property NAME reappeared in the code-block
   * tier, which passed when a carve-out was reverted to the leaking value —
   * a presence check wearing a neutralisation check's error message.
   */
  const INHERITED_SHAPING: Array<[property: string, neutral: RegExp]> = [
    ['text-autospace', /no-autospace/],
    ['text-spacing-trim', /space-all/],
    ['letter-spacing', /normal|:\s*0/],
    ['word-spacing', /normal|:\s*0/],
    ['font-variant-ligatures', /none/],
    ['font-feature-settings', /normal/],
    ['text-transform', /none/],
  ];

  /**
   * Pill chrome on `.maka-prose code`, which also matches `pre > code`. The
   * block reset must zero each — `border`/`padding` already leaked once, and
   * `margin` leaked in round 1 (the pill's margin-inline offset the first
   * source line of every code block by 3.25px).
   */
  const PILL_CHROME = ['margin', 'padding', 'background', 'border', 'border-radius'];

  /** Longhand-aware property match: `margin` also matches `margin-inline`. */
  const declares = (decls: string, property: string) =>
    new RegExp(`(?:^|;)\\s*${property}(?:-[a-z-]+)?\\s*:`).test(decls);

  /** The declaration text for `property` in `decls`, longhands included. */
  const valueOf = (decls: string, property: string) =>
    decls.match(new RegExp(`(?:^|;)\\s*${property}(?:-[a-z-]+)?\\s*:([^;]*)`))?.[1]?.trim() ?? '';

  /**
   * Rules that can hold a fenced block, so an inherited property set on them
   * reaches code. A list item and a blockquote can contain one; `h1`–`h4`,
   * `th` and `td` cannot (headings are single-line and GFM table cells are
   * line-delimited), which is why `.maka-prose h1`'s letter-spacing is not a
   * leak and must not trip this.
   *
   * Known limit: `cssBlocks` is a flat splitter, so a rule nested inside an
   * at-rule is invisible here. prose.css has no `@media`; if one is added,
   * this scan needs to grow with it.
   */
  const fencedCodeAncestors = (blocks: Array<{ selectors: string; decls: string }>) =>
    blocks.filter(({ selectors }) => selectors
      .split(',')
      .some((one) => /^\.maka-prose(\s+(li|blockquote))?$/.test(one.trim())));

  it('prose text shaping is neutralised at the fenced-code boundary', async () => {
    const css = stripCssComments(await readFile(PROSE_CSS, 'utf8'));
    const blocks = cssBlocks(css);
    const pre = blocks.find(({ selectors }) => selectors === '.maka-prose .maka-code-block pre');
    const preCode = blocks.find(({ selectors }) => selectors === '.maka-prose .maka-code-block pre code');
    assert.ok(pre, 'expected a .maka-prose .maka-code-block pre rule');
    assert.ok(preCode, 'expected a .maka-prose .maka-code-block pre code reset');
    const carvedOut = `${pre!.decls};${preCode!.decls}`;

    for (const [property, neutral] of INHERITED_SHAPING) {
      const setter = fencedCodeAncestors(blocks).find(({ decls }) => declares(decls, property));
      if (!setter) continue;
      assert.ok(
        declares(carvedOut, property),
        `${setter.selectors} sets ${property}, which inherits into fenced code and shifts glyphs off the monospace grid. Code is a literal surface (#1431) — the .maka-code-block pre tier must carve ${property} back out`,
      );
      assert.match(
        valueOf(carvedOut, property),
        neutral,
        `the code-block carve-out for ${property} must actually neutralise it, not just re-declare it — a carve-out reverted to the prose value re-ships the leak`,
      );
    }
  });

  it('inline-pill chrome is zeroed at the fenced-code boundary', async () => {
    const css = stripCssComments(await readFile(PROSE_CSS, 'utf8'));
    const blocks = cssBlocks(css);
    const code = blocks.find(({ selectors }) => /^\.maka-prose\s+code$/.test(selectors));
    const preCode = blocks.find(({ selectors }) => selectors === '.maka-prose .maka-code-block pre code');
    assert.ok(code, 'expected a .maka-prose code rule');
    assert.ok(preCode, 'expected a .maka-prose .maka-code-block pre code reset');

    for (const property of PILL_CHROME) {
      if (!declares(code!.decls, property)) continue;
      assert.ok(
        declares(preCode!.decls, property),
        `.maka-prose code (0,1,1) matches pre > code too, so ${property} leaks into fenced code. The .maka-code-block pre code reset must neutralise ${property}`,
      );
      assert.match(
        valueOf(preCode!.decls, property),
        /^(0(px)?|none|transparent)$/,
        `the pre code reset for ${property} must zero it — re-declaring it with a non-neutral value re-ships the leak (round 1: margin-inline offset the first source line by 3.25px)`,
      );
    }
  });

  it('the inline pill does not indent the block it starts', async () => {
    const css = stripCssComments(await readFile(PROSE_CSS, 'utf8'));
    const blocks = cssBlocks(css);
    const code = blocks.find(({ selectors }) => /^\.maka-prose\s+code$/.test(selectors));
    if (!declares(code!.decls, 'margin')) return;
    const edge = blocks.find(({ selectors }) => /\.maka-prose\s+code:first-child/.test(selectors));
    assert.ok(
      edge,
      'the pill margin is an inline gap between the pill and its NEIGHBOURING text, but at a block edge there is no neighbour — it indents the block instead (measured 2.98px on a paragraph, list item and blockquote that open with inline code, against 0 for one opening with plain text). A .maka-prose code:first-child rule must drop the leading margin',
    );
    assert.match(
      edge!.decls,
      /margin-inline-start:\s*0/,
      '.maka-prose code:first-child must zero margin-inline-start so a block opening with a pill keeps the same left edge as its neighbours',
    );
  });

  it('hard breaks render as a block span with height — a native <br> cannot be spaced by CSS', async () => {
    const css = stripCssComments(await readFile(PROSE_CSS, 'utf8'));
    const hb = cssBlocks(css).find(({ selectors }) => /\.maka-hardbreak$/.test(selectors));
    assert.ok(hb, 'expected a .maka-hardbreak rule in prose.css');
    assert.match(
      hb!.decls,
      /display:\s*block/,
      '.maka-hardbreak must be display: block — an inline box cannot take a height, which is exactly why a native <br> is unfixable in CSS',
    );
    assert.match(
      hb!.decls,
      /height:\s*var\(--space-1-5\)/,
      '.maka-hardbreak must take its 6px from --space-1-5 so the hard-break gap lands between the 4px line gap and the 16px paragraph gap',
    );
    // The DOM half — `<br>` + span, and remark-breaks still producing the
    // break — is locked by rendering in packages/ui's markdown-body.test.ts.

    // `remark-breaks` makes EVERY single newline a hard break, so the 6px
    // lands on list-item and blockquote continuation lines too, where it
    // inverts the grouping: measured 10.5px inside one list item against
    // 6.5px between two of them. Those containers already group their own
    // content; only a paragraph break carries the section split.
    const scoped = cssBlocks(css).find(({ selectors }) =>
      /\.maka-prose\s+li\s+\.maka-hardbreak/.test(selectors));
    assert.ok(
      scoped,
      'the hard-break gap must be dropped inside li/blockquote — a continuation line there rendered further apart (10.5px) than two separate list items (6.5px), inverting the grouping',
    );
    assert.match(
      scoped!.selectors,
      /blockquote\s+\.maka-hardbreak/,
      'blockquote needs the same carve-out as li — its content is already grouped, so a break inside it is a continuation, not a section split',
    );
    assert.match(scoped!.decls, /height:\s*0/, 'the carve-out must zero the gap');
  });
});
