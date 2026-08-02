import { test, expect } from './fixtures.js';
import type { Page } from '@playwright/test';

/**
 * Rendered-geometry contract for the window titlebar.
 *
 * `.maka-window-titlebar` is the only element allowed to declare
 * `-webkit-app-region: drag`. It is a transparent absolute overlay on the
 * frame (not an AppShell topNav row) so column surfaces paint to the window
 * top; static gates live in `app-region-hygiene-contract.test.ts`. What no
 * static gate can see is the RENDERED rectangle against whatever the window
 * currently contains, and that is where every known defect in this area lived:
 *
 *   1. The original bug: the sidebar's drag strip reserved room for two titlebar
 *      buttons while the collapsed rail renders three, so the third one sat under
 *      a drag rect and its clicks reached the OS as window drags. Chromium builds
 *      the draggable region in DOCUMENT ORDER — adding `drag` rects, subtracting
 *      `no-drag` ones — so a control only escapes a drag rect declared before it.
 *   2. A drag rect reaching past the titlebar: any interactive element it
 *      intersects loses that part of its hit area, and a rect touching the window
 *      frame steals the OS resize corridor (the P0 WAWQAQ reported in `af681c1`,
 *      msg `5b85fdb1`).
 *   3. A drag rect with no height at all: the window simply cannot be dragged,
 *      and nothing else in the suite notices.
 *
 * None of these is visible to static analysis, and none is caught by clicking:
 * Playwright and CDP synthesise input into the renderer, bypassing the OS
 * hit-test the defects live in. So this spec measures rectangles:
 *
 *   (a) the titlebar precedes column surfaces in document order, so every
 *       `no-drag` below it can be subtracted from it;
 *   (b) it keeps a resize corridor on the top, left, and right window edges;
 *   (c) column surfaces extend under the transparent strip, for color
 *       continuity only — no CONTROL may sit under it;
 *   (d) every interactive element REACHABLE inside it resolves to `no-drag` — via
 *       an ancestor whose own rect actually covers the intersection — and sits
 *       after it in document order.
 *
 * (c) and (d) split along one line: is the element inside the strip's own
 * subtree or beneath it. The strip is an absolute overlay with default
 * `pointer-events`, so it is the topmost hit surface at EVERY point of the
 * band. Its own children are reachable and are judged by the app-region rules
 * in (d); anything beneath it is not reachable at all — the click lands on the
 * strip and the OS reads a window drag — so its presence there is the defect,
 * and no app-region annotation can rescue it.
 *
 * That distinction is why the sweep probes with `elementsFromPoint` and drops
 * the strip's subtree from the stack. A plain `elementFromPoint` returns the
 * strip for every point in the band, so every element underneath silently
 * fails the "is this reachable" precondition and is skipped — which made this
 * spec pass while real controls sat dead under the strip.
 *
 * It sweeps the states where the titlebar's neighbours change: both sidebar
 * states, the chat and module surfaces, a viewport narrow enough to cross the
 * 820px module-shell breakpoint, and the overlays — which render after the shell
 * without removing it, so the drag rect is still underneath them.
 */

const SHELL = '.maka-shell-astryx';

const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[role="separator"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[tabindex]:not([tabindex="-1"])',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
].join(', ');

interface TitlebarReport {
  isFirstElementChild: boolean;
  band: { top: number; left: number; right: number; bottom: number; width: number; height: number };
  viewport: { width: number; height: number };
  edges: { top: number; left: number; right: number };
  /** Topmost edge of anything in the shell's content row. */
  contentTop: number | null;
  offenders: Array<{
    label: string;
    selector: string;
    box: string;
    region: string;
    afterTitlebar: boolean;
    overlapPx: number;
    reason: string;
  }>;
}

async function readTitlebar(page: Page, interactiveSelector: string): Promise<TitlebarReport> {
  return page.evaluate((selector) => {
    const shell = document.querySelector('.maka-shell-astryx');
    const titlebar = document.querySelector('.maka-window-titlebar');
    if (!shell || !titlebar) throw new Error('shell or titlebar missing from the rendered tree');
    const band = titlebar.getBoundingClientRect();

    const regionOf = (node: Element): string => {
      const style = getComputedStyle(node);
      return style.webkitAppRegion || style.getPropertyValue('-webkit-app-region') || '';
    };

    const name = (node: Element): string =>
      node.className && typeof node.className === 'string'
        ? node.className.trim().split(/\s+/)[0]!
        : node.tagName.toLowerCase();

    /**
     * Resolve the app-region that actually applies AT a point of `el`.
     *
     * Per-point rather than per-element, because a `no-drag` inherited from an
     * ancestor carves out the ANCESTOR's rect: a child can overflow that rect
     * (absolute positioning, negative margins) and the overflowing part stays
     * inside the drag region even though the computed style reads `no-drag`. So
     * the annotated ancestor's rect has to contain the point being judged.
     */
    const resolveRegionAt = (el: Element, x: number, y: number): { region: string; covered: boolean } => {
      for (
        let node: Element | null = el;
        node && node !== document.documentElement;
        node = node.parentElement
      ) {
        const region = regionOf(node);
        if (region !== 'drag' && region !== 'no-drag') continue;
        const rect = node.getBoundingClientRect();
        const covered =
          rect.left <= x + 0.5 &&
          rect.right >= x - 0.5 &&
          rect.top <= y + 0.5 &&
          rect.bottom >= y - 0.5;
        return { region: `${region}@${node === el ? 'self' : name(node)}`, covered };
      }
      return { region: 'NONE', covered: false };
    };

    /**
     * Sample points across a rect: centre, corners, and edge midpoints, inset by
     * 1px so a corner sample lands on the element rather than its neighbour.
     *
     * The centre alone is not enough. A control whose centre is occluded (a
     * dropdown, a tooltip, a sibling drawn on top) but whose corner is exposed is
     * still clickable there, and that corner is what the OS drag region would
     * swallow.
     */
    const samplePoints = (r: DOMRect): Array<[number, number]> => {
      const xs = [...new Set([r.left + 1, r.left + r.width / 2, r.right - 1])];
      const ys = [...new Set([r.top + 1, r.top + r.height / 2, r.bottom - 1])];
      const points: Array<[number, number]> = [];
      for (const y of ys) {
        for (const x of xs) {
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) points.push([x, y]);
        }
      }
      return points;
    };

    const inTitlebar = (node: Element): boolean => node === titlebar || titlebar.contains(node);

    /**
     * What the user would reach at a point if the chrome strip were not there.
     *
     * The strip is a transparent absolute overlay that never sets
     * `pointer-events: none`, so it is the topmost hit at every point of the
     * band and `elementFromPoint` returns it and nothing else. Walking the full
     * stack and dropping its subtree keeps the browser's own clipping and
     * occlusion answers — which is why this is a probe and not a re-derivation
     * of layout — while seeing past the one occluder the band is made of.
     */
    const hitBeneathTitlebarAt = (x: number, y: number): Element | null => {
      for (const node of document.elementsFromPoint(x, y)) {
        if (!inTitlebar(node)) return node;
      }
      return null;
    };

    const describe = (el: Element): string => {
      const classes =
        typeof el.className === 'string' && el.className
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
          : '';
      return `${el.tagName.toLowerCase()}${classes}`;
    };

    const offenders: TitlebarReport['offenders'] = [];
    for (const el of document.querySelectorAll(selector)) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      // Only elements that actually overlap the titlebar can lose hit area to it.
      const overlap = Math.min(rect.bottom, band.bottom) - Math.max(rect.top, band.top);
      const horizontallyInside = rect.left < band.right && rect.right > band.left;
      if (overlap <= 0 || !horizontallyInside) continue;

      const intersection = new DOMRect(
        Math.max(rect.left, band.left),
        Math.max(rect.top, band.top),
        Math.min(rect.right, band.right) - Math.max(rect.left, band.left),
        overlap,
      );

      // Only a point the user can actually REACH inside the drag rect can lose hit
      // area to it. A rect overlapping the titlebar is not enough: a chat
      // transcript row scrolled above its viewport reports a rect at negative y,
      // clipped by an `overflow: auto` ancestor and unreachable there. Asking the
      // browser what is at each point is both more faithful than re-deriving
      // clipping and occlusion, and shorter.
      const afterTitlebar = Boolean(
        titlebar.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      const ownedByTitlebar = inTitlebar(el);
      let failure: { region: string; reason: string } | null = null;
      for (const [x, y] of samplePoints(intersection)) {
        const at = `at ${Math.round(x)},${Math.round(y)}`;

        // Beneath the strip: reachability is judged with the strip removed from
        // the stack, and any hit at all is the defect. `no-drag` cannot save it
        // — that property only shapes the OS drag rect, while the click is lost
        // one layer earlier, to the strip's own hit-testing.
        if (!ownedByTitlebar) {
          const probe = hitBeneathTitlebarAt(x, y);
          if (!probe || !(probe === el || el.contains(probe))) continue;
          failure = {
            region: resolveRegionAt(el, x, y).region,
            reason: `sits under the chrome strip ${at}: the strip is the topmost hit surface across the whole band, so this control cannot be clicked there at all and the point reaches the OS as a window drag`,
          };
          break;
        }

        const probe = document.elementFromPoint(x, y);
        if (!probe || !(probe === el || el.contains(probe))) continue;

        const { region, covered } = resolveRegionAt(el, x, y);
        if (!region.startsWith('no-drag')) {
          failure = { region, reason: `resolves to ${region}, not no-drag, ${at}` };
        } else if (!covered) {
          failure = { region, reason: `${region} does not cover the reachable point ${at}` };
        } else if (!afterTitlebar) {
          failure = {
            region,
            reason: `declared before the titlebar, so its no-drag is not subtracted (${at})`,
          };
        }
        if (failure) break;
      }
      if (!failure) continue;

      offenders.push({
        label:
          el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 24) || el.tagName,
        selector: describe(el),
        box: `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
        region: failure.region,
        afterTitlebar,
        overlapPx: Math.round(overlap),
        reason: failure.reason,
      });
    }

    const contentElements = [...shell.querySelectorAll('.maka-session-panel, .maka-panel-detail')];
    const contentTops = contentElements
      .map((child) => child.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => rect.top);

    return {
      isFirstElementChild: contentElements.every(
        (content) => Boolean(titlebar.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING),
      ),
      band: {
        top: Math.round(band.top),
        left: Math.round(band.left),
        right: Math.round(band.right),
        bottom: Math.round(band.bottom),
        width: Math.round(band.width),
        height: Math.round(band.height),
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      edges: {
        top: Math.round(band.top),
        left: Math.round(band.left),
        right: Math.round(window.innerWidth - band.right),
      },
      contentTop: contentTops.length ? Math.round(Math.min(...contentTops)) : null,
      offenders,
    };
  }, interactiveSelector);
}

async function assertTitlebarIsWellFormed(page: Page, label: string): Promise<void> {
  const report = await readTitlebar(page, INTERACTIVE_SELECTOR);
  const context = `Band ${JSON.stringify(report.band)} in viewport ${JSON.stringify(report.viewport)}`;

  expect(
    report.isFirstElementChild,
    `${label}: the titlebar must precede column surfaces in document order; Chromium subtracts a \`no-drag\` rect only from drag rects declared before it, so anything hoisted above the titlebar silently loses its hit area`,
  ).toBe(true);

  // Width alone is not enough: a zero-height drag rect is still full-width, and
  // makes the window completely undraggable.
  expect(
    report.band.height,
    `${label}: the titlebar must have height. ${context}`,
  ).toBeGreaterThan(0);
  expect(report.band.width, `${label}: the titlebar must have width. ${context}`).toBeGreaterThan(0);

  // A drag rect flush against a window edge takes the OS resize hit area with it.
  for (const edge of ['top', 'left', 'right'] as const) {
    expect(
      report.edges[edge],
      `${label}: the titlebar must leave a resize corridor on the ${edge} window edge, otherwise the OS cannot resize the window there (regression class of the af681c1 P0). ${context}`,
    ).toBeGreaterThan(0);
  }

  // "the drag rect keeps an uncovered run to grab" is deliberately NOT asserted.
  // Reverse-injection showed it cannot discriminate: the row's own padding
  // gutters are part of the drag rect and are never carved out, so a run always
  // exists — even with a cluster stretched across the whole row. `height > 0`
  // above already covers the case that motivated it (a drag rect with no surface
  // at all), and filling the titlebar edge-to-edge with controls would be a
  // visible design change rather than the silent geometry drift this spec exists
  // to catch.

  // Column SURFACES extend under the transparent chrome strip so sidebar canvas
  // and session --background paint to the window top. This asserts that colour
  // continuity and nothing else — it says where the columns' paint starts, not
  // what is safe to put there. Controls under the strip are the offenders check
  // below; the two are independent, and reading this one as a hit-test guard is
  // what let real controls sit dead under the band while this spec stayed green.
  expect(
    report.contentTop,
    `${label}: the shell must render session/detail columns for this check to mean anything`,
  ).not.toBeNull();
  expect(
    report.contentTop,
    `${label}: column surfaces must reach the top of the frame under the chrome strip (content top ${report.contentTop}, band bottom ${report.band.bottom}). ${context}`,
  ).toBeLessThanOrEqual(report.band.bottom);

  // Scope, stated honestly: semantically interactive elements matching
  // INTERACTIVE_SELECTOR, judged at the sampled points of their overlap with the
  // drag rect that the browser reports as reachable — with the strip's own
  // subtree removed from the stack, so elements beneath it are visible to this
  // check rather than skipped as unreachable. A custom control that is neither a
  // button, a link, a form field, nor role/tabindex/contenteditable annotated is
  // invisible here — and would be a hit-testing bug of its own.
  expect(
    report.offenders,
    `${label}: no interactive element may be reachable inside the titlebar band unless it belongs to the titlebar itself and resolves to \`-webkit-app-region: no-drag\` through an ancestor whose rect covers that point, after the titlebar in document order. Controls beneath the strip cannot be clicked at all; controls inside it lose that part of their hit area to a window drag`,
  ).toEqual([]);
}

async function openSidebar(page: Page): Promise<void> {
  const expand = page.getByRole('button', { name: '展开侧边栏' });
  if (await expand.count()) await expand.click();
  await expect(page.getByRole('button', { name: '收起侧边栏' })).toBeVisible();
}

async function collapseSidebar(page: Page): Promise<void> {
  const collapse = page.getByRole('button', { name: '收起侧边栏' });
  if (await collapse.count()) await collapse.click();
  await expect(page.getByRole('button', { name: '展开侧边栏' })).toBeVisible();
}

test('the window titlebar owns its row across surfaces, sidebar states, and the narrow breakpoint', async ({
  window: page,
}) => {
  const wide = { width: 1280, height: 900 };
  const narrow = { width: 760, height: 900 };

  await page.setViewportSize(wide);
  await collapseSidebar(page);
  await assertTitlebarIsWellFormed(page, 'chat surface, sidebar collapsed, wide');

  await openSidebar(page);
  await assertTitlebarIsWellFormed(page, 'chat surface, sidebar expanded, wide');

  const sidebar = page.getByRole('navigation', { name: '对话列表' });
  for (const destination of ['扩展', '定时任务'] as const) {
    await sidebar.getByRole('button', { name: destination, exact: true }).click();
    await expect(page.getByRole('main', { name: destination })).toBeVisible();
    // Module pages mount behind a lazy boundary whose skeleton renders no
    // controls at all, so measuring it would pass vacuously. Wait for real
    // content — not every module page has a `.maka-module-main-header`, so the
    // readiness probe is "the skeleton is gone and a control is rendered".
    await expect(page.locator('.maka-lazy-fallback')).toHaveCount(0);
    await expect(page.locator('.maka-module-main button').first()).toBeVisible();
    await assertTitlebarIsWellFormed(page, `${destination} surface, sidebar expanded, wide`);

    // Below 820px `.maka-module-main` drops to compact padding, which used to
    // lift its first row into the overlay drag band. This is the state the wide
    // sweep cannot see.
    await page.setViewportSize(narrow);
    await expect(page.locator('.maka-module-main button').first()).toBeVisible();
    await assertTitlebarIsWellFormed(page, `${destination} surface, narrow`);
    await page.setViewportSize(wide);
  }

  // Overlays render after the shell but do not remove it, so the titlebar's drag
  // rect is still there underneath them. Any control an overlay puts in the top
  // 36px is inside that rect: Settings already needs `no-drag` on its back
  // button for exactly this reason. These states are the remaining place the
  // carve-out can silently break.
  await page.getByRole('button', { name: '搜索对话' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await assertTitlebarIsWellFormed(page, 'search modal open');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('main', { name: '设置内容' })).toBeVisible();
  await assertTitlebarIsWellFormed(page, 'settings surface open');
});
