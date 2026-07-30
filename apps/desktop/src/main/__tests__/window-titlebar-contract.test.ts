import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readRendererContractCss } from './contract-css-helpers.js';
import { REPO_ROOT } from './main-process-contract-source-helpers.js';

function readMainWindowSource(): Promise<string> {
  return readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/main-window.ts'), 'utf8');
}

/**
 * Static CSS contract for the window titlebar's LAYOUT.
 *
 * Window-drag ownership is not checked here — that belongs to
 * `app-region-hygiene-contract.test.ts`, which pins the single
 * `.maka-window-titlebar` authority. The rendered-geometry invariants (the
 * titlebar is the shell's first child, its drag rect stops at the row boundary,
 * every overlapping control is carved out) belong to
 * `e2e/window-titlebar.spec.ts`, which can measure them.
 *
 * What is checkable in the stylesheet is the shape that makes those invariants
 * cheap to hold: the titlebar occupies a ROW of the shell grid, sized by the one
 * shared `--h-titlebar` token, and no sibling reserves space for it or for
 * another sibling's width. This file is the gate against reintroducing the
 * overlay-plus-rulers arrangement that produced two P0s in this area.
 */
describe('window titlebar layout contract', () => {
  it('gives the titlebar its own shell row, sized by the shared titlebar height', async () => {
    const css = await readRendererContractCss();
    const shell = ruleBody(css, '.maka-shell-2col');
    assert.match(
      shell,
      /grid-template-rows:\s*var\(--h-titlebar\)\s+minmax\(\s*0\s*,\s*1fr\s*\)/,
      'the shell must place the titlebar in a real grid row sized by --h-titlebar, so content below it cannot overlap the drag region. An overlay titlebar forces every neighbouring surface to reserve the height by hand, which is how the module pages ended up with controls inside the drag region.',
    );

    const titlebar = ruleBody(css, '.maka-window-titlebar');
    assert.match(titlebar, /grid-row:\s*1\b/, '.maka-window-titlebar must occupy the first row');
    assert.match(
      titlebar,
      /grid-column:\s*1\s*\/\s*-1/,
      '.maka-window-titlebar must span every shell column; a partial-width titlebar leaves a strip of the window undraggable',
    );
    assert.doesNotMatch(
      titlebar,
      /position:\s*(?:absolute|fixed)/,
      'the titlebar must stay in flow — as an overlay it stops reserving space and its neighbours have to compensate again',
    );
  });

  it('keeps the titlebar drag rect out of the OS resize corridor', async () => {
    // A drag rect flush against a window edge takes the native resize hit area
    // with it: that is the P0 WAWQAQ reported on `af681c1` (msg `5b85fdb1`),
    // where the window could not be resized from its edges.
    const css = await readRendererContractCss();
    const titlebar = ruleBody(css, '.maka-window-titlebar');
    assert.match(
      titlebar,
      /margin:\s*var\(--maka-window-resize-edge\)\s+var\(--maka-window-resize-edge\)\s+0/,
      'the titlebar must be inset from the top/left/right window edges by --maka-window-resize-edge so the OS keeps its resize corridor',
    );
  });

  it('positions the titlebar clusters from flow, not from sibling widths', async () => {
    const css = await readRendererContractCss();

    // The left cluster is a plain flex child; the right one is pushed over by
    // `margin-left: auto`. Neither needs to know the other's width.
    const rail = ruleBody(css, '.maka-shell-topbar-rail');
    assert.doesNotMatch(
      rail,
      /position:\s*absolute/,
      'the topbar rail must be an in-flow child of the titlebar row; absolutely positioning it is what forced siblings to reserve its footprint by hand',
    );
    const actions = ruleBody(css, '.maka-workspace-top-actions');
    assert.match(
      actions,
      /margin-left:\s*auto/,
      "the workspace actions must be pushed to the titlebar row's end by flow, not anchored with a `right` offset",
    );
    assert.doesNotMatch(
      actions,
      /position:\s*absolute/,
      'the workspace actions must be an in-flow child of the titlebar row',
    );

    // The rulers these clusters used to require. Each summed a sibling's width
    // from its button count, so both drifted whenever a button was added,
    // removed, or resized — one was 12px out of sync with the button size it
    // claimed to add up, and only looked right because the detail panel
    // contributed a 4px margin of its own.
    // Declarations only, not prose: the comments explaining why each ruler was
    // retired are allowed to name it, and one of them writes out the old
    // `name: value` pair verbatim.
    const declarations = stripComments(css);
    for (const ruler of [
      '--maka-sidebar-collapsed-topbar-inset',
      '--maka-workspace-top-actions-inset',
      '--maka-sidebar-topbar-button-size',
      '--maka-titlebar-drag-band-height',
      // Not a sibling ruler but the same habit: a hand-measured stand-in for a
      // number the platform reports (see the gutter test below).
      '--maka-titlebar-control-safe-left',
    ]) {
      assert.doesNotMatch(
        declarations,
        new RegExp(`${ruler}\\s*:`),
        `${ruler} reserved space for a sibling by restating facts the layout already knows (button count, button size, titlebar height). The titlebar row makes all of them unnecessary; reintroducing one means the overlay arrangement is back.`,
      );
    }
  });

  it('derives the native control gutters from the platform, not from measurements', async () => {
    const css = await readRendererContractCss();
    const titlebar = ruleBody(css, '.maka-window-titlebar');

    // Both gutters are "our design floor, or the platform's safe area when that
    // is wider" — no platform branch, no measured control width. Chromium's
    // Window Controls Overlay reports the safe area on every platform where we
    // hide the native titlebar (main-window.ts enables it), and the `env()`
    // fallbacks collapse to the floor where nothing overlaps.
    //
    // A hand-measured `--maka-titlebar-control-safe-left: 94px` stood in for the
    // macOS side until the overlay was enabled there and reported 83.
    //
    // Plain gutters, not `calc(gutter - resize-edge)`: both are safe-AREA
    // minimums, so the row's own 4px inset just yields more clearance than
    // required. Subtracting it would restate the inset twice more to pin an exact
    // pixel.
    assert.match(
      titlebar,
      /padding-left:\s*max\(\s*var\(--space-6\),\s*var\(--maka-titlebar-area-x\)\s*\)\s*;/,
      "the titlebar row's left gutter must be the larger of the design floor and the platform's reported safe-area start",
    );
    assert.match(
      titlebar,
      /padding-right:\s*calc\(\s*var\(--space-6\)\s*\+\s*var\(--maka-titlebar-overlay-right-width\)\s*\)\s*;/,
      "the titlebar row's right gutter must add the platform's reported right-hand control width to the design floor",
    );
    assert.match(css, /--maka-titlebar-area-x:\s*env\(titlebar-area-x,\s*0px\)\s*;/);
    assert.match(css, /--maka-titlebar-area-width:\s*env\(titlebar-area-width,\s*100vw\)\s*;/);
    assert.match(
      css,
      /--maka-titlebar-overlay-right-width:\s*max\(\s*0px,\s*calc\(100vw - var\(--maka-titlebar-area-x\) - var\(--maka-titlebar-area-width\)\s*\)\s*\)\s*;/,
      'the right-side native control width must be derived from the titlebar safe-area x/width pair',
    );
    // Two blacklists used to live here: no `138px` anywhere in the renderer CSS,
    // and no `[data-platform="win32"]` selector — the two shapes the Windows
    // gutter took before it was derived. The assertions above pin the mechanism
    // positively, which subsumes both, and neither ban could tell a titlebar
    // regression apart from an unrelated rule that happens to use 138px or to
    // style something else per platform.
  });

  it('hands the native titlebar overlay the same height the shell row uses', async () => {
    // The one number that genuinely exists twice: CSS cannot read the main
    // process and main cannot read CSS. So it is stated in both and gated here —
    // the failure Chromium would produce is a native control strip taller or
    // shorter than the row of app controls beside it.
    const css = await readRendererContractCss();
    const rowHeight = /--h-titlebar:\s*(\d+)px\s*;/.exec(css)?.[1];
    assert.ok(rowHeight, '--h-titlebar must be declared as a px value');

    const mainSrc = await readMainWindowSource();
    const overlayHeight = /const TITLEBAR_OVERLAY_HEIGHT\s*=\s*(\d+)\s*;/.exec(mainSrc)?.[1];
    assert.ok(overlayHeight, 'main-window.ts must declare TITLEBAR_OVERLAY_HEIGHT');
    assert.equal(
      overlayHeight,
      rowHeight,
      `the native titleBarOverlay height (${overlayHeight}) must equal the shell titlebar row height --h-titlebar (${rowHeight})`,
    );
  });

  it('enables the Window Controls Overlay wherever the native titlebar is hidden', async () => {
    // This is what makes the gutters derivable: without `titleBarOverlay` the
    // `titlebar-area-*` env vars are unsupported and every fallback applies, so
    // the renderer is back to hard-coding where the OS controls end. macOS gets
    // the height alone (the only option it supports there); Windows also gets the
    // color pair, which `setTitleBarOverlayTheme` re-syncs.
    const mainSrc = await readMainWindowSource();
    const darwinBranch = /platform === 'darwin'\s*\?\s*\{([\s\S]*?)\n\s*\}\s*:/.exec(mainSrc)?.[1];
    assert.ok(darwinBranch, 'the BrowserWindow options must keep a darwin branch');
    assert.match(
      darwinBranch,
      /titleBarOverlay:\s*\{\s*height:\s*TITLEBAR_OVERLAY_HEIGHT\s*\}/,
      'macOS must enable titleBarOverlay (height only) so the renderer can read the traffic lights\u2019 safe area from `env(titlebar-area-x)` instead of hard-coding it',
    );
    const win32Branch = /platform === 'win32'\s*\?\s*\{([\s\S]*?)\n\s*\}\s*:/.exec(mainSrc)?.[1];
    assert.ok(win32Branch, 'the BrowserWindow options must keep a win32 branch');
    assert.match(
      win32Branch,
      /titleBarOverlay:\s*titleBarOverlayOptions\(/,
      'Windows must enable titleBarOverlay so its caption-button width is reported through the titlebar safe area',
    );
  });

  it('leaves no surface reserving titlebar height on its own', async () => {
    // Every one of these used to pad or offset itself to clear the titlebar.
    // With the titlebar in its own row they are simply in row 2, and a
    // reintroduced clearance would mean the row stopped reserving space.
    const css = await readRendererContractCss();
    for (const selector of ['.maka-session-panel', '.maka-session-workbar', '.maka-chat-header']) {
      const body = exactRuleBody(css, selector);
      assert.doesNotMatch(
        body,
        /padding-top:\s*(?:calc\(\s*)?var\(--(?:h-titlebar|maka-titlebar)/,
        `${selector} must not reserve the titlebar height: it lives in the shell's content row, below the titlebar`,
      );
    }
    assert.doesNotMatch(
      css,
      /\.maka-session-panel-header\s*[,{]/,
      'the blank `.maka-session-panel-header` placeholder is retired; it existed only to donate a drag strip',
    );
  });
});

/** Drop `/* … *\/` blocks so a negative assertion cannot be tripped by a comment
 *  that names the very thing it explains as retired. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function ruleBody(css: string, selector: string): string {
  const body = optionalRuleBody(css, selector);
  assert.ok(body, `${selector} rule must exist`);
  return body;
}

function optionalRuleBody(css: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`).exec(css)?.[1];
}

/**
 * Body of the rule whose selector is EXACTLY `selector`.
 *
 * `optionalRuleBody` matches the selector as a substring, so asking it for
 * `.maka-session-panel` returns whichever rule mentions it first — including
 * `.maka-shell-2col .maka-panel-list > .maka-session-panel`. That is fine for
 * selectors that appear once, but not for one that also exists as a descendant
 * in another rule.
 */
function exactRuleBody(css: string, selector: string): string {
  const pattern = new RegExp(
    `(?:^|[};])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`,
    'm',
  );
  const body = pattern.exec(css)?.[1];
  assert.ok(body, `a rule with the exact selector '${selector}' must exist`);
  return body;
}
