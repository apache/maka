import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readRendererContractCss } from './contract-css-helpers.js';

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
    for (const ruler of [
      '--maka-sidebar-collapsed-topbar-inset',
      '--maka-workspace-top-actions-inset',
      '--maka-sidebar-topbar-button-size',
      '--maka-titlebar-drag-band-height',
    ]) {
      assert.doesNotMatch(
        css,
        new RegExp(`${ruler}\\s*:`),
        `${ruler} reserved space for a sibling by restating facts the layout already knows (button count, button size, titlebar height). The titlebar row makes all of them unnecessary; reintroducing one means the overlay arrangement is back.`,
      );
    }
  });

  it('derives the native control gutters from the platform, not from measurements', async () => {
    const css = await readRendererContractCss();
    const titlebar = ruleBody(css, '.maka-window-titlebar');

    // macOS draws the traffic lights over the renderer, so their width is the one
    // titlebar fact the DOM cannot read. Windows puts its controls on the other
    // side and DOES expose them, through the `titlebar-area-*` env vars — that
    // path must not regress into a hardcoded native width or a platform
    // attribute selector (it was both, once).
    // A plain token reference, not `calc(token - resize-edge)`: both are
    // safe-AREA minimums, so the row's own 4px inset just yields more clearance
    // than required. Subtracting it would restate the inset here and on the right
    // gutter purely to pin an exact pixel.
    assert.match(
      titlebar,
      /padding-left:\s*var\(--maka-titlebar-control-safe-left\)\s*;/,
      "the titlebar row's left gutter must come from the traffic-light safe-area token",
    );
    assert.match(
      titlebar,
      /padding-right:\s*var\(--maka-workspace-top-actions-right\)\s*;/,
      "the titlebar row's right gutter must come from the native-overlay-derived token",
    );
    assert.doesNotMatch(
      css,
      /\[data-platform=["']win32["']\]/,
      'Windows titlebar avoidance must not depend on a renderer platform attribute',
    );
    assert.doesNotMatch(
      css,
      /\b138px\b/,
      'Windows titlebar avoidance must not hard-code the native control width',
    );
    assert.match(css, /--maka-titlebar-area-x:\s*env\(titlebar-area-x,\s*0px\)\s*;/);
    assert.match(css, /--maka-titlebar-area-width:\s*env\(titlebar-area-width,\s*100vw\)\s*;/);
    assert.match(
      css,
      /--maka-titlebar-overlay-right-width:\s*max\(\s*0px,\s*calc\(100vw - var\(--maka-titlebar-area-x\) - var\(--maka-titlebar-area-width\)\s*\)\s*\)\s*;/,
      'the right-side native control width must be derived from the titlebar safe-area x/width pair',
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
