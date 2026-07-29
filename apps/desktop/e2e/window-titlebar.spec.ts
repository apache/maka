import { test, expect } from './fixtures.js';
import type { Page } from '@playwright/test';

/**
 * Rendered-geometry contract for the window titlebar.
 *
 * `.maka-window-titlebar` is the only element allowed to declare
 * `-webkit-app-region: drag`, and it occupies the shell's first grid row — both
 * static gates live in `app-region-hygiene-contract.test.ts` and
 * `window-titlebar-contract.test.ts`. What no static gate can see is the
 * RENDERED rectangle against whatever the window currently contains, and that is
 * where every known defect in this area lived:
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
 *   3. A drag rect with no usable empty area, or no height at all: the window
 *      simply cannot be dragged, and nothing else in the suite notices.
 *
 * None of these is visible to static analysis, and none is caught by clicking:
 * Playwright and CDP synthesise input into the renderer, bypassing the OS
 * hit-test the defects live in. So this spec measures rectangles:
 *
 *   (a) the titlebar is the shell's first element child, so every `no-drag`
 *       below it can be subtracted from it;
 *   (b) it keeps a resize corridor on the top, left, and right window edges;
 *   (c) it leaves a non-empty run for the user to grab;
 *   (d) its bottom edge does not reach into the content row;
 *   (e) every interactive element intersecting it resolves to `no-drag` — via an
 *       ancestor whose own rect actually covers the intersection — and sits after
 *       it in document order.
 *
 * It sweeps the states where the titlebar's neighbours change: both sidebar
 * states, the chat surface and the module surfaces, and a viewport narrow enough
 * to cross the 820px module-shell breakpoint.
 */

const SHELL = '.maka-shell-2col';

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
].join(', ');

interface TitlebarReport {
  isFirstElementChild: boolean;
  band: { top: number; left: number; right: number; bottom: number; width: number; height: number };
  viewport: { width: number; height: number };
  edges: { top: number; left: number; right: number };
  /** Widest run of the titlebar not covered by a `no-drag` cluster. */
  dragGapPx: number;
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
    const shell = document.querySelector('.maka-shell-2col');
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
     * Resolve the app-region that actually applies to the part of `el` inside the
     * drag rect.
     *
     * A `no-drag` inherited from an ancestor carves out the ANCESTOR's rect. A
     * child can overflow that rect (absolute positioning, negative margins), and
     * the overflowing part stays inside the drag region even though the computed
     * style reads `no-drag`. So when the declaration comes from an ancestor, the
     * ancestor's rect has to contain the overlapping part.
     */
    const resolveRegion = (el: Element, target: DOMRect): { region: string; covered: boolean } => {
      for (
        let node: Element | null = el;
        node && node !== document.documentElement;
        node = node.parentElement
      ) {
        const region = regionOf(node);
        if (region !== 'drag' && region !== 'no-drag') continue;
        if (node === el) return { region: `${region}@self`, covered: true };
        const rect = node.getBoundingClientRect();
        const covered =
          rect.left <= target.left + 0.5 &&
          rect.right >= target.right - 0.5 &&
          rect.top <= target.top + 0.5 &&
          rect.bottom >= target.bottom - 0.5;
        return { region: `${region}@${name(node)}`, covered };
      }
      return { region: 'NONE', covered: false };
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
      const { region, covered } = resolveRegion(el, intersection);
      const afterTitlebar = Boolean(
        titlebar.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
      );

      let reason = '';
      if (!region.startsWith('no-drag')) reason = `resolves to ${region}, not no-drag`;
      else if (!covered) reason = `${region} does not cover the part inside the drag rect`;
      else if (!afterTitlebar) {
        reason = 'declared before the titlebar, so its no-drag is not subtracted';
      }
      if (!reason) continue;

      offenders.push({
        label:
          el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 24) || el.tagName,
        selector: describe(el),
        box: `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
        region,
        afterTitlebar,
        overlapPx: Math.round(overlap),
        reason,
      });
    }

    // Widest horizontal run of the titlebar not covered by a `no-drag` cluster:
    // the area the user can actually grab. Zero means the window is undraggable
    // even though every other assertion here would still pass.
    const blocked = [...titlebar.querySelectorAll('*')]
      .filter((node) => regionOf(node) === 'no-drag')
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.bottom > band.top && rect.top < band.bottom)
      .map((rect) => [Math.max(rect.left, band.left), Math.min(rect.right, band.right)] as const)
      .sort((a, b) => a[0] - b[0]);
    let cursor = band.left;
    let dragGapPx = 0;
    for (const [start, end] of blocked) {
      if (start > cursor) dragGapPx = Math.max(dragGapPx, start - cursor);
      cursor = Math.max(cursor, end);
    }
    dragGapPx = Math.max(dragGapPx, band.right - cursor);

    const contentTops = [...shell.children]
      .filter((child) => child !== titlebar)
      .map((child) => child.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => rect.top);

    return {
      isFirstElementChild: shell.firstElementChild === titlebar,
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
      dragGapPx: Math.round(dragGapPx),
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
    `${label}: the titlebar must be the first element child of ${SHELL}; Chromium subtracts a \`no-drag\` rect only from drag rects declared before it, so anything hoisted above the titlebar silently loses its hit area`,
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

  // Having a drag rect is not the same as having somewhere to grab it.
  expect(
    report.dragGapPx,
    `${label}: the titlebar must leave an uncovered run for the user to drag the window by; its action clusters cover the rest. ${context}`,
  ).toBeGreaterThan(0);

  // The titlebar owns a row. If its rect reached past the row into content, the
  // overlapping content would silently lose its hit area — the failure mode the
  // previous overlay band had, and the reason the row exists.
  expect(
    report.contentTop,
    `${label}: the shell must render content below the titlebar for this check to mean anything`,
  ).not.toBeNull();
  expect(
    report.band.bottom,
    `${label}: the titlebar's drag rect must stop at or before the content row's top edge (content starts at ${report.contentTop}). ${context}`,
  ).toBeLessThanOrEqual(report.contentTop!);

  expect(
    report.offenders,
    `${label}: every interactive element overlapping the titlebar must resolve to \`-webkit-app-region: no-drag\` through an ancestor whose rect covers the overlapping part, AND sit after the titlebar in document order. Offenders lose that part of their hit area to a window drag`,
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

  const sidebar = page.getByRole('complementary', { name: '对话列表' });
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
});
