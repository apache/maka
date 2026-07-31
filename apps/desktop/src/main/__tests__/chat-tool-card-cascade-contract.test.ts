import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, readAllRendererCss, stripCssComments } from './css-test-helpers.js';

/**
 * Zero-visual governance contract for issue #332 PR3b — the `ToolActivity` card
 * shell (the inline section + count pill, the `<details>` card, its `<summary>`
 * header row + status dot, the body / intent, and the args `<pre>` override)
 * moved onto the `@maka/ui` chat substrate's `toolVariants` literalize table.
 *
 * The retired shell declarations compiled 1:1 to literal utilities. This
 * contract locks the invariants that remain meaningful in the current tree:
 *   1. the ABSENCE of the retired selectors (a diff of computed styles can't show
 *      a selector is gone), scoped so the still-bespoke `.maka-tool-error*`
 *      (PR3c), `.maka-tool-diff*` / `.maka-tool-terminal*` (result previews, out
 *      of scope), and shared `.maka-code` base survive untouched;
 *   2. the running status dot's `@keyframes maka-tool-pulse` ring frames — an
 *      animation can't be a leaf-literal and `getComputedStyle` reads a phase-
 *      dependent value, so the breath is pinned here + by the `chat.tsx` literal;
 *   3. the `[data-slot="tool"]` base residue (opacity/transform/border-color
 *      transition) — the native `<summary>` marker reset that used to live here is
 *      gone after the disclosure → Collapsible migration (the trigger is a button
 *      with no native marker).
 */
describe('chat tool-card migration contract (#332 PR3b)', () => {
  it('retires the bespoke tool-card shell selectors (without touching error/preview/maka-code)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    for (const selector of [
      // inline section + args override (styles/tool-output.css)
      '.toolInline',
      '.toolItem',
      '.toolArgs',
      // summary header row + status dot + body / intent / count (maka-tokens.css)
      '.maka-tool-header',
      '.maka-tool-name',
      '.maka-tool-meta',
      '.maka-tool-duration',
      '.maka-tool-status-label',
      '.maka-tool-status-dot',
      '.maka-tool-body',
      '.maka-tool-intent',
      '.maka-tool-count',
      // the retired native-disclosure card base + status/open selectors
      '.maka-tool {',
      '.maka-tool >',
      '.maka-tool[open]',
      '.maka-tool[data-status',
    ]) {
      assert.ok(
        !css.includes(selector),
        `retired tool-card selector "${selector}" still present in renderer CSS`,
      );
    }

    // Adjacent concern that PR3b must leave alone: the shared inline-code base.
    // (The error banner `.maka-tool-error*` was PR3b-era out-of-scope but has since
    // retired onto the `Alert` primitive in PR3c, and the result-preview renderers
    // `.maka-tool-diff*` / `.maka-tool-terminal*` onto `previewVariants` in PR4, so
    // neither is asserted as kept here anymore.)
    for (const kept of [
      '.maka-code',
    ]) {
      assert.ok(
        css.includes(kept),
        `PR3b must not retire the out-of-scope selector "${kept}"`,
      );
    }
  });

  it('keeps the @keyframes maka-tool-pulse ring frames (the dot breath the diff cannot see)', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    assert.ok(
      tokens.includes('@keyframes maka-tool-pulse'),
      '`@keyframes maka-tool-pulse` must stay in maka-tokens.css — a keyframe is a global rule, not an element property',
    );
    const pulse = tokens.slice(
      tokens.indexOf('@keyframes maka-tool-pulse'),
      tokens.indexOf('@keyframes maka-tool-pulse') + 220,
    );
    // The box-shadow RING grows 3px → 5px and fades 0.15 → 0.06. This is the
    // running dot's zero-visual proof; it can't be machine-diffed, so it is pinned.
    for (const frame of [
      'box-shadow: 0 0 0 3px oklch(from var(--status-running) l c h / 0.15)',
      'box-shadow: 0 0 0 5px oklch(from var(--status-running) l c h / 0.06)',
    ]) {
      assert.ok(pulse.includes(frame), `maka-tool-pulse must pin the retired ring frame "${frame}"`);
    }
  });

  it('keeps the tool-card base residue on [data-slot="tool"]', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    assert.ok(
      !tokens.includes('.maka-tool {') && !tokens.includes('@starting-style {\n    .maka-tool'),
      'the retired `.maka-tool` class must not return',
    );
    assert.ok(!tokens.includes('@starting-style'), 'decorative tool-card entrance styles are banned');
    for (const residue of [
      '[data-slot="tool"] {',
      'transform: translateY(0)',
      'transition: border-color var(--duration-base) var(--ease-out-strong);',
    ]) {
      assert.ok(
        tokens.includes(residue),
        `tool-card residue must keep "${residue}" on the [data-slot="tool"] hook`,
      );
    }
  });

  it('pins the running-dot escape literals in chat.tsx + guards against scale drift', async () => {
    const rawSrc = await readFile(
      resolve(REPO_ROOT, 'packages', 'ui', 'src', 'primitives', 'chat.tsx'),
      'utf8',
    );
    const chatSrc = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const start = chatSrc.indexOf('const toolVariants');
    const block = chatSrc.slice(start, chatSrc.indexOf('export { toolVariants }', start));
    assert.ok(start !== -1 && block.length > 0, 'toolVariants table must exist in chat.tsx');

    // The diff harness proves the static shell; the running dot's animation is the
    // one part it cannot reach. Pin the breath + its leaf box-shadow ring here.
    for (const literal of [
      '[animation:maka-tool-pulse_1.5s_ease-in-out_infinite]',
      '[box-shadow:0_0_0_3px_oklch(from_var(--status-running)_l_c_h_/_0.15)]',
    ]) {
      assert.ok(
        block.includes(literal),
        `running dot must carry the literal "${literal}" mirroring the retired CSS`,
      );
    }
    // The dot must never fall back to Tailwind's built-in `animate-pulse` (a
    // different opacity-only keyframe); it uses the distinct `maka-tool-pulse`
    // ring keyframe.
    for (const banned of ['animate-pulse']) {
      assert.ok(
        !block.includes(banned),
        `tool dot must use the governed maka-tool-pulse ring, not "${banned}"`,
      );
    }
    // Astryx owns the disclosure trigger, focus ring, chevron, and open-state
    // chrome; the Maka header recipe only owns its product data grid.
    assert.ok(
      !rawSrc.includes('[open]>summary'),
      'tool card source must not keep the old native details `[open]>summary` selector, even in comments',
    );
    assert.ok(
      !rawSrc.includes('group-data-[open]/tool'),
      'tool card source must not keep the retired root-group disclosure state',
    );
    const itemStart = block.indexOf('item:');
    const headerStart = block.indexOf('header:', itemStart);
    const dotStart = block.indexOf('dot:', headerStart);
    assert.ok(itemStart !== -1 && headerStart !== -1 && dotStart !== -1, 'toolVariants item/header/dot parts must stay parseable');
    const itemBlock = block.slice(itemStart, headerStart);
    const headerBlock = block.slice(headerStart, dotStart);
    assert.ok(!itemBlock.includes('group/tool'), 'tool card root must not add a named disclosure-state group');
    assert.ok(!itemBlock.includes('border-bottom'), 'tool card root must not duplicate Astryx open-state chrome');
    assert.ok(!headerBlock.includes('data-[panel-open]'), 'tool card header must not read the retired Base UI state hook');
    // Anti-drift: pin the distinctive literals and ban the semantic-scale
    // forms they would be swapped for. Radius uses the `--radius-surface`
    // token per #406 gap 4. Spacing now uses the Tailwind scale (gap-2.5)
    // per #430 PR3 spacing converge — arbitrary px literals are banned.
    // Typography (text-*) converged onto the token scale by #546 PR0, so it
    // is no longer pinned as a literal and text-xs/sm are allowed; only radius /
    // spacing literals stay pinned and radius scale drift stays banned.
    for (const literal of ['rounded-[var(--radius-surface)]', 'gap-2.5', 'min-w-[22px]']) {
      assert.ok(block.includes(literal), `toolVariants must keep the literal "${literal}"`);
    }
    for (const scale of ['rounded-lg', 'rounded-xl']) {
      assert.ok(
        !block.includes(scale),
        `toolVariants must stay literal on radius, not adopt the semantic-scale "${scale}"`,
      );
    }

    // The `waiting_permission` status must keep the `String.raw` `\_` escape: a
    // bare `data-[status=waiting_permission]` compiles to `[data-status="waiting
    // permission"]` (Tailwind `_`→space) and silently falls back to the base
    // color — a zero-visual break the diff harness caught but a careless
    // "simplification" could reintroduce. Assert the escaped form is present and
    // the bare form is absent across the whole module.
    assert.ok(
      chatSrc.includes('waiting\\_permission'),
      'waiting_permission must keep its `String.raw` `\\_` escape so the emitted class matches',
    );
    assert.ok(
      !chatSrc.includes('data-[status=waiting_permission]'),
      'the bare (underscore-as-space) `data-[status=waiting_permission]` form must never appear',
    );
  });
});
