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
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const TOKENS_PATH = join(process.cwd(), 'src', 'renderer', 'maka-tokens.css');
const APP_SHELL_CHROME_ACTIONS_PATH = join(
  process.cwd(),
  'src',
  'renderer',
  'app-shell-chrome-actions.tsx',
);

/**
 * The single element allowed to declare `-webkit-app-region: drag`.
 *
 * Chromium builds the OS draggable region by walking annotated elements in
 * DOCUMENT ORDER, adding each `drag` rect and subtracting each `no-drag` rect.
 * A `no-drag` control therefore only escapes a `drag` region that was declared
 * BEFORE it. When drag regions were spread across containers, each one had to
 * reserve space for its neighbours with a hand-computed margin ruler encoding
 * "how many titlebar buttons exist right now" — and the sidebar's strip only
 * ever reserved room for two, so the third button the rail renders while the
 * sidebar is collapsed (新任务) sat under a live drag region and its clicks
 * reached the OS as window drags instead of clicks.
 *
 * One band declared first, plus `no-drag` on the controls inside it, makes that
 * class of bug unrepresentable: any control added to the band later carves
 * itself out automatically.
 */
const DRAG_AUTHORITY_SELECTOR = '.maka-titlebar-drag-layer';

/**
 * Selectors that, if they ever carry `-webkit-app-region: drag`,
 * would cover the full window and defeat the OS resize handler.
 * The test asserts none of them appear in a rule body containing
 * the drag declaration.
 */
const FORBIDDEN_DRAG_HOSTS = [
  '.appFrame',
  '.app',
  '.maka-modal-backdrop',
  '.settingsModalBackdrop',
  '.maka-search-modal-backdrop',
  '.permissionBackdrop',
  '.maka-shell-2col',
  // Generic html/body — if someone ever adds a global rule we
  // want it flagged immediately.
  'html',
  'body',
];

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

  for (const host of FORBIDDEN_DRAG_HOSTS) {
    it(`'${host}' selector does NOT carry -webkit-app-region: drag (would steal OS resize hit area)`, async () => {
      const stylesSources = [
        ['renderer CSS', await readRendererContractCss()],
        [TOKENS_PATH, await readFile(TOKENS_PATH, 'utf8')],
      ] as const;
      for (const [sourceLabel, src] of stylesSources) {
        const offender = findRuleWithBoth(src, host, '-webkit-app-region: drag');
        assert.equal(
          offender,
          null,
          `selector '${host}' must NOT declare \`-webkit-app-region: drag\` in ${sourceLabel} — full-window containers steal the OS resize hit area (WAWQAQ ${'`5b85fdb1`'}, xuan ${'`eea556cd`'}). Found rule:\n${offender}`,
        );
      }
    });
  }

  it(`declares -webkit-app-region: drag on exactly one selector (${DRAG_AUTHORITY_SELECTOR})`, async () => {
    const stylesSources = [
      ['renderer CSS', await readRendererContractCss()],
      [TOKENS_PATH, await readFile(TOKENS_PATH, 'utf8')],
    ] as const;
    const selectors: string[] = [];
    for (const [sourceLabel, src] of stylesSources) {
      for (const rule of findRulesWithDeclaration(src, '-webkit-app-region: drag')) {
        selectors.push(`${rule.selector} (${sourceLabel})`);
        assert.equal(
          rule.selector.trim(),
          DRAG_AUTHORITY_SELECTOR,
          `\`-webkit-app-region: drag\` on selector '${rule.selector}' (in ${sourceLabel}) adds a second window-drag authority. Drag belongs to ${DRAG_AUTHORITY_SELECTOR} alone; a container that merely sits in the titlebar band should declare nothing, and a control inside the band should declare \`no-drag\`.`,
        );
      }
    }
    assert.equal(
      selectors.length,
      1,
      `expected exactly one \`-webkit-app-region: drag\` rule (${DRAG_AUTHORITY_SELECTOR}), found ${selectors.length}: ${selectors.join(', ')}`,
    );
  });

  // The document-order requirement — the layer must precede every control that
  // carves itself out of it — is NOT gated here. Its owner is the rendered tree,
  // so `e2e/titlebar-drag-band.spec.ts` asserts `shell.firstElementChild === layer`
  // against the live window, along with the band's rectangle and the carve-out of
  // every interactive element that overlaps it. A source-text approximation was
  // tried first and rejected: matching a fixed set of JSX needles by string
  // position passes for any control it does not know about, which is precisely
  // the failure mode (an unlisted titlebar control) it would need to catch.

  it('carves the full-height column resize handle out of the drag band', async () => {
    // The handle spans the whole window height, so its top overlaps the drag
    // band. It used to escape only because the retired sidebar drag strip
    // happened to stop 2px to its left.
    const css = await readRendererContractCss();
    const rule = findRuleWithBoth(css, '.maka-resize-handle', '-webkit-app-region: no-drag');
    assert.ok(
      rule,
      '.maka-resize-handle must declare `-webkit-app-region: no-drag`; otherwise the top of the column resizer starts a window drag',
    );
  });

  it('retires the per-container drag strips the single band replaced', async () => {
    const css = await readRendererContractCss();
    // Selector-level, not text-level: the CSS comments that explain why the
    // strip was retired are allowed to name it.
    const revived = [...iterateRules(css)].filter((rule) =>
      selectorMatches(rule.selector, '.maka-sidebar-drag-strip'),
    );
    assert.deepEqual(
      revived.map((rule) => rule.selector),
      [],
      'the sidebar drag strip existed only to donate a drag region; it is replaced by the single drag band and must not come back',
    );
    const chatHeader = findRuleWithBoth(css, '.maka-chat-header', '-webkit-app-region');
    assert.equal(
      chatHeader,
      null,
      '.maka-chat-header must not declare an app-region: the drag band covers this strip, and re-declaring drag here would again require a hand-tuned margin ruler to keep the titlebar buttons clickable',
    );
  });

  it('topbar chrome UiButtons and their icon subtrees carve out no-drag hit regions', async () => {
    const topbarButtonClasses = extractStaticUiButtonClassNames(
      await readFile(APP_SHELL_CHROME_ACTIONS_PATH, 'utf8'),
    );
    assert.ok(
      topbarButtonClasses.length > 0,
      'app-shell-chrome-actions.tsx must expose topbar UiButton class names for app-region hygiene checks',
    );

    const stylesSources = [
      ['renderer CSS', await readRendererContractCss()],
      [TOKENS_PATH, await readFile(TOKENS_PATH, 'utf8')],
    ] as const;
    const selectors = new Set<string>();
    for (const [, src] of stylesSources) {
      for (const rule of findRulesWithDeclaration(src, '-webkit-app-region: no-drag')) {
        for (const selector of rule.selector.split(',')) {
          selectors.add(selector.trim());
        }
      }
    }

    for (const className of topbarButtonClasses) {
      for (const selector of [`.${className}`, `.${className} *`]) {
        assert.ok(
          selectors.has(selector),
          `${selector} must declare \`-webkit-app-region: no-drag\` so clicks on topbar icons are not treated as titlebar drags`,
        );
      }
    }
  });
});

/**
 * Walk every top-level CSS rule and return the rule that BOTH
 * (a) has a selector containing `hostSelector` as a token, AND
 * (b) declares `declaration` in its body.
 * Returns `null` if no such rule exists.
 */
function findRuleWithBoth(css: string, hostSelector: string, declaration: string): string | null {
  for (const rule of iterateRules(css)) {
    if (!rule.body.includes(declaration)) continue;
    if (selectorMatches(rule.selector, hostSelector)) {
      return `${rule.selector} { ${rule.body.trim()} }`;
    }
  }
  return null;
}

function findRulesWithDeclaration(
  css: string,
  declaration: string,
): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  for (const rule of iterateRules(css)) {
    if (rule.body.includes(declaration)) {
      out.push(rule);
    }
  }
  return out;
}

function extractStaticUiButtonClassNames(src: string): string[] {
  const classes = new Set<string>();
  // A topbar UiButton appears either as a direct element
  // (<UiButton>…</UiButton>) or, after the Tooltip migration, as the
  // render target of a TooltipTrigger
  // (<TooltipTrigger render={<UiButton …/>} className="…">…</TooltipTrigger>).
  const uiButtonBlocks = [
    ...(src.match(/<UiButton\b[\s\S]*?<\/UiButton>/g) ?? []),
    ...(src.match(/<TooltipTrigger\b[\s\S]*?render=\{<UiButton\b[\s\S]*?<\/TooltipTrigger>/g) ?? []),
  ];
  for (const block of uiButtonBlocks) {
    const match = block.match(/\bclassName="([^"]+)"/);
    assert.ok(
      match,
      'Each app-shell chrome UiButton must use a static className so app-region hygiene can be contract-checked',
    );
    for (const className of match[1]!.split(/\s+/)) {
      if (className.length > 0) {
        classes.add(className);
      }
    }
  }
  return [...classes].sort();
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
