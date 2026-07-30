/**
 * Static-analysis contract test for app-region hygiene
 * (PR-SIDEBAR-IA-0 Phase 3 P0 fixup v5, WAWQAQ msg `5b85fdb1`,
 * xuan `eea556cd`, kenji `0b94f7e9`).
 *
 * Background:
 *   WAWQAQ reported that the macOS window cannot be dragged/resized
 *   from the edges in real-window use of `af681c1`. xuan + kenji
 *   gated the merge on locking down `-webkit-app-region` placement
 *   so a future patch can't accidentally claim the window edge as a
 *   drag region (which would defeat the OS resize hit area on
 *   `titleBarStyle: 'hiddenInset'` windows).
 *
 *   Specifically:
 *   - `-webkit-app-region: drag` must NEVER appear on a full-window
 *     container (.appFrame, .app, .maka-modal-backdrop,
 *     .settingsModalBackdrop). Those covers the whole viewport;
 *     declaring them draggable would steal every click from the
 *     native OS resize handler.
 *   - drag regions are allowed on narrow header / tab / nav strips
 *     where the user expects to drag the window.
 *
 * This file is a grep-style gate. The runtime exercise (4 edges + 4
 * corners actually resize + Search modal open path doesn't block
 * resize) MUST happen in a real Electron window — kenji `0b94f7e9`
 * + xuan `eea556cd` are explicit that screenshots and jsdom can't
 * replace that. The gate here is the SOURCE bound for what is /
 * isn't allowed to declare `drag`.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readRendererTsxFiles } from './css-test-helpers.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

/**
 * The single element allowed to declare `-webkit-app-region: drag`.
 *
 * Chromium builds the OS draggable region by walking annotated elements in
 * DOCUMENT ORDER, adding each `drag` rect and subtracting each `no-drag` rect.
 * A `no-drag` control therefore only escapes a `drag` region that was declared
 * BEFORE it. When drag regions were spread across containers, each one had to
 * reserve space for its neighbours with a hand-summed margin ruler encoding
 * "how many titlebar buttons exist right now" — and the sidebar's strip only
 * ever reserved room for two, so the third button the rail renders while the
 * sidebar is collapsed (新任务) sat under a live drag region and its clicks
 * reached the OS as window drags instead of clicks.
 *
 * One titlebar row, plus `no-drag` on the clusters inside it, makes that class
 * of bug unrepresentable: a control added to the row later carves itself out
 * automatically, and content outside the row cannot overlap it at all.
 */
const DRAG_AUTHORITY_SELECTOR = '.maka-window-titlebar';

/**
 * There used to be a nine-case loop here asserting that `.appFrame`, `.app`,
 * `.maka-shell-2col`, the four modal backdrops, `html` and `body` each do NOT
 * declare `drag` — full-window containers whose drag region would swallow the OS
 * resize handler (WAWQAQ `5b85fdb1`, gated by xuan `eea556cd` + kenji
 * `0b94f7e9`).
 *
 * The "exactly one drag selector" test below subsumes all nine: it asserts the
 * ONLY rule declaring `drag` has the selector `.maka-window-titlebar`, so any of
 * them acquiring it fails there, by name, with the same diagnosis. Nine test
 * cases restating one constraint is nine places to update for every future
 * backdrop, and it would still miss the tenth.
 */

describe('app-region hygiene contract (PR-SIDEBAR-IA-0 Phase 3 P0 fixup v5)', () => {
  it('BrowserWindow declares `resizable: true` explicitly (defensive against future silent disable)', async () => {
    // xuan `eea556cd` + kenji `0b94f7e9`: even though the default
    // is true, pin it in source so a future patch that toggles it
    // off becomes visible in diff review.
    const src = await readMainProcessCombinedSource();
    assert.match(
      src,
      /new BrowserWindow\([\s\S]*?resizable:\s*true/,
      'main.ts must declare `resizable: true` on the main BrowserWindow constructor (WAWQAQ 5b85fdb1)',
    );
  });

  it('BrowserWindow enforces a runtime min height aligned with the sanitizeBounds restore floor (#824)', async () => {
    // Without a BrowserWindow minHeight, the both-present dvh layout fix
    // (#824) can be defeated by dragging the window below the 320px
    // restore floor that sanitizeBounds enforces. Pin minHeight to the
    // shared SAFE_MIN_HEIGHT constant so the runtime resize floor matches
    // the restore floor and the two can't drift apart.
    const mainSrc = await readMainProcessCombinedSource();
    assert.match(
      mainSrc,
      /new BrowserWindow\([\s\S]*?minHeight:\s*SAFE_MIN_HEIGHT\b/,
      'main BrowserWindow must set `minHeight: SAFE_MIN_HEIGHT` so the runtime resize floor matches the sanitizeBounds restore floor (#824)',
    );
    const windowStateSrc = await readFile(join(process.cwd(), 'src', 'main', 'window-state.ts'), 'utf8');
    assert.match(
      windowStateSrc,
      /export const SAFE_MIN_HEIGHT\s*=\s*320\b/,
      'window-state.ts must export `SAFE_MIN_HEIGHT = 320` as the single source of truth for the minimum window height (shared by sanitizeBounds + BrowserWindow minHeight)',
    );
  });

  it(`declares -webkit-app-region: drag on exactly one selector (${DRAG_AUTHORITY_SELECTOR})`, async () => {
    // One source: `readRendererContractCss()` expands `styles.css`'s @import
    // graph, which includes `maka-tokens.css`. Reading the tokens file again on
    // top of that counted every declaration in it twice — harmless while no token
    // file declares an app-region, and a spurious "found 2 drag rules" the moment
    // one legitimately did.
    const css = await readRendererContractCss();
    const selectors: string[] = [];
    for (const rule of findRulesWithDeclaration(css, 'drag')) {
      selectors.push(rule.selector);
      assert.equal(
        rule.selector.trim(),
        DRAG_AUTHORITY_SELECTOR,
        `\`-webkit-app-region: drag\` on selector '${rule.selector}' adds a second window-drag authority. Drag belongs to ${DRAG_AUTHORITY_SELECTOR} alone; a container that merely sits in the titlebar row should declare nothing, and a control inside it should declare \`no-drag\`. If '${rule.selector}' is a full-window container (\`.appFrame\`, \`.app\`, a modal backdrop, \`html\`/\`body\`), it also swallows the OS resize hit area — the P0 in WAWQAQ ${'`5b85fdb1`'}.`,
      );
    }
    assert.equal(
      selectors.length,
      1,
      `expected exactly one \`-webkit-app-region: drag\` rule (${DRAG_AUTHORITY_SELECTOR}), found ${selectors.length}: ${selectors.join(', ')}`,
    );
  });

  it('keeps the drag authority out of component source, where the CSS gate cannot see it', async () => {
    // The check above reads stylesheets. An inline `style={{ WebkitAppRegion:
    // 'drag' }}` or a Tailwind arbitrary property would declare a second drag
    // authority that never appears in any .css file — same P0, invisible to the
    // gate. `no-drag` in component source is fine (it only ever subtracts).
    const offenders: string[] = [];
    for (const { relPath, source } of await readRendererTsxFiles()) {
      // Declarations, not prose: `app-shell.tsx` documents the titlebar row by
      // naming the property and its value, which is not a declaration.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const match of code.matchAll(
        /(?:WebkitAppRegion\s*:\s*|-webkit-app-region\s*:\s*|app-region-\[)['"]?(no-drag|drag)/g,
      )) {
        if (match[1] === 'drag') offenders.push(`${relPath}: ${match[0]}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `window-drag must be declared in CSS, on ${DRAG_AUTHORITY_SELECTOR} alone, so the single-authority gate above can see it: ${offenders.join(', ')}`,
    );
  });

  // Two invariants are deliberately NOT gated here, because their owner is the
  // rendered tree rather than the stylesheet text:
  //   - the titlebar must be the shell's first child (document order), and
  //   - the drag rect must stop at the titlebar row, covering no content below.
  // `e2e/window-titlebar.spec.ts` measures both against the live window, along
  // with the carve-out of every interactive element that overlaps the titlebar.
  // A source-text approximation of the ordering rule was tried first and
  // rejected: matching a fixed set of JSX needles by string position passes for
  // any control it does not know about, which is exactly the failure mode (an
  // unlisted titlebar control) it would need to catch.

  it('carves the titlebar action clusters out of the drag row', async () => {
    // Container-level, not per-button: each cluster's rect covers its children,
    // so one declaration per cluster is what the OS needs. The buttons used to
    // repeat it individually — plus a `.maka-titlebar-action *` rule for their
    // icons — which added nothing and made a correct simplification look like a
    // contract violation.
    const css = await readRendererContractCss();
    for (const cluster of ['.maka-shell-topbar-rail', '.maka-workspace-top-actions']) {
      assert.ok(
        findRuleWithBoth(css, cluster, 'no-drag'),
        `${cluster} must declare \`-webkit-app-region: no-drag\`; it sits inside the titlebar's drag row, so without it every button in it reaches the OS as a window drag`,
      );
    }
  });

  it('retires the per-container drag surfaces the titlebar row replaced', async () => {
    const css = await readRendererContractCss();
    // Selector-level, not text-level: the CSS comments explaining why these were
    // retired are allowed to name them.
    // Elements that existed ONLY to donate a drag region, and so should not
    // exist at all now.
    const retiredElements = ['.maka-sidebar-drag-strip', '.maka-titlebar-drag-layer'];
    const revived = [...iterateRules(css)]
      .filter((rule) => retiredElements.some((selector) => selectorMatches(rule.selector, selector)))
      .map((rule) => rule.selector);
    assert.deepEqual(
      revived,
      [],
      'these were empty elements whose only job was to declare a drag region; the titlebar row replaced them and they must not come back',
    );

    // Selectors that legitimately survive but must no longer carry an
    // app-region. `.maka-titlebar-action` still opts its buttons out of text
    // selection, for instance — it just has no reason to repeat the carve-out
    // its cluster already provides.
    for (const [selector, why] of [
      [
        '.maka-chat-header',
        'it is a content-row status strip now, and giving it a drag region again would reintroduce the hand-summed margin rulers that kept the titlebar buttons clickable',
      ],
      [
        '.maka-titlebar-action',
        'its cluster (`.maka-shell-topbar-rail` / `.maka-workspace-top-actions`) already carves out a rect covering it, so a per-button declaration only duplicates that',
      ],
      [
        '.maka-resize-handle',
        'it spans the content row only; it needed a carve-out when it ran the full window height and overlapped the drag band',
      ],
    ] as const) {
      assert.equal(
        findRuleWithBoth(css, selector, '(?:no-)?drag'),
        null,
        `${selector} must not declare an app-region: ${why}`,
      );
    }
  });
});

/**
 * Match `-webkit-app-region: <valuePattern>` as a DECLARATION, not as a
 * substring.
 *
 * A plain `body.includes('-webkit-app-region: drag')` is bypassed by any
 * formatting the CSS grammar allows but the string does not — `-webkit-app-region:drag`,
 * a newline before the value, extra spaces. That is a silent hole in a gate whose
 * entire job is "there is exactly one drag authority", so it has to match the
 * property/value pair with the whitespace the grammar permits. `no-drag` is a
 * distinct value, so the `drag` pattern anchors on a value boundary to avoid
 * matching it.
 */
function appRegionPattern(valuePattern: string): RegExp {
  return new RegExp(`(?:^|[;{])\\s*-webkit-app-region\\s*:\\s*${valuePattern}\\s*(?:;|$)`);
}

/**
 * Walk every top-level CSS rule and return the rule that BOTH
 * (a) has a selector containing `hostSelector` as a token, AND
 * (b) declares `-webkit-app-region` with a value matching `valuePattern`.
 * Returns `null` if no such rule exists.
 */
function findRuleWithBoth(css: string, hostSelector: string, valuePattern: string): string | null {
  const declaration = appRegionPattern(valuePattern);
  for (const rule of iterateRules(css)) {
    if (!declaration.test(rule.body)) continue;
    if (selectorMatches(rule.selector, hostSelector)) {
      return `${rule.selector} { ${rule.body.trim()} }`;
    }
  }
  return null;
}

function findRulesWithDeclaration(
  css: string,
  valuePattern: string,
): Array<{ selector: string; body: string }> {
  const declaration = appRegionPattern(valuePattern);
  const out: Array<{ selector: string; body: string }> = [];
  for (const rule of iterateRules(css)) {
    if (declaration.test(rule.body)) {
      out.push(rule);
    }
  }
  return out;
}

/**
 * Yield each top-level `selector { body }` rule. Naive — only
 * handles flat rules; nested at-rules (`@media`, `@layer`) keep the
 * inner rules as sub-yields by recursing. Good enough for our
 * scanned files (only `@media (prefers-reduced-motion)` and
 * `@starting-style` blocks).
 */
function* iterateRules(css: string): Generator<{ selector: string; body: string }> {
  let i = 0;
  while (i < css.length) {
    // Skip whitespace and comments.
    while (i < css.length && /\s/.test(css[i]!)) i++;
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      if (end === -1) return;
      i = end + 2;
      continue;
    }
    // Find selector — text up to first `{`.
    const braceIdx = css.indexOf('{', i);
    if (braceIdx === -1) return;
    const selector = css.slice(i, braceIdx).trim();
    // Find matching `}` (track nesting).
    let depth = 1;
    let j = braceIdx + 1;
    while (j < css.length && depth > 0) {
      const ch = css[j];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      j++;
    }
    if (depth !== 0) return;
    const body = css.slice(braceIdx + 1, j - 1);
    // If the selector starts with `@`, recurse into the body (it's
    // an at-rule wrapping inner rules). Otherwise yield as-is.
    if (selector.startsWith('@')) {
      yield* iterateRules(body);
    } else {
      yield { selector, body };
    }
    i = j;
  }
}

/**
 * Return true if the selector string contains `target` as a
 * standalone token (not a substring inside a longer class name).
 * `target` itself is a class selector starting with `.` or a tag
 * name; we tolerate trailing `:hover`, `::before`, descendants, etc.
 */
function selectorMatches(selectorList: string, target: string): boolean {
  // Split on `,` to consider each selector in the list.
  for (const raw of selectorList.split(',')) {
    const selector = raw.trim();
    // Tokenize on whitespace + combinators (` >+~`).
    const tokens = selector.split(/[\s>+~]+/).filter((tok) => tok.length > 0);
    for (const tok of tokens) {
      // Strip pseudo-classes / pseudo-elements / attribute selectors
      // so `.foo:hover` matches `.foo`.
      const base = tok.replace(/[:[].*$/, '');
      if (base === target) return true;
    }
  }
  return false;
}
