import { test, expect } from './fixtures.js';
import type { Page } from '@playwright/test';

/**
 * Rendered-geometry contract for the single window-drag band.
 *
 * `.maka-titlebar-drag-layer` is the only element allowed to declare
 * `-webkit-app-region: drag` (that part is a static gate in
 * `app-region-hygiene-contract.test.ts`). What a static gate cannot see is the
 * band's RENDERED rectangle against whatever the window currently contains, and
 * that is where both known defects in this area lived:
 *
 *   1. The bug this band replaced: the sidebar's drag strip reserved room for
 *      two titlebar buttons while the collapsed rail renders three, so the third
 *      one sat under a drag rect and its clicks reached the OS as window drags.
 *      Chromium builds the draggable region in DOCUMENT ORDER — adding `drag`
 *      rects, subtracting `no-drag` ones — so a control only escapes a drag rect
 *      declared before it.
 *   2. A band that covers more than the titlebar: any interactive element that
 *      intersects it without `no-drag` loses the top part of its hit area, and a
 *      band touching the window edge steals the OS resize hit area (the P0
 *      WAWQAQ reported in `af681c1`, msg `5b85fdb1`).
 *
 * Neither is visible to a static analysis, and neither is caught by clicking:
 * Playwright and CDP synthesise input into the renderer, bypassing the OS
 * hit-test that both defects live in. So this spec asserts the CARVE-OUT and the
 * band's rectangle instead of trying to click:
 *
 *   (a) the layer is the first element child of the shell, so every `no-drag`
 *       below it can be subtracted from it;
 *   (b) the band keeps a resize corridor on the top, left, and right window
 *       edges;
 *   (c) every interactive element intersecting the band resolves to `no-drag`
 *       and sits after the layer in document order.
 *
 * It sweeps the states where the band's neighbours actually change: both sidebar
 * states, the chat surface and the module surfaces, and a viewport narrow enough
 * to cross the 820px module-shell breakpoint (below it `.maka-module-main` drops
 * to `--space-4` padding and pulls its header up into the band).
 */

const SHELL = '.maka-shell-2col';
const LAYER = '.maka-titlebar-drag-layer';

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

interface BandReport {
  layerIsFirstElementChild: boolean;
  band: { top: number; left: number; right: number; bottom: number; width: number };
  viewport: { width: number; height: number };
  edges: { top: number; left: number; right: number };
  offenders: Array<{
    label: string;
    selector: string;
    box: string;
    region: string;
    afterLayer: boolean;
    overlapPx: number;
  }>;
}

async function readBand(page: Page, interactiveSelector: string): Promise<BandReport> {
  return page.evaluate((selector) => {
    const shell = document.querySelector('.maka-shell-2col');
    const layer = document.querySelector('.maka-titlebar-drag-layer');
    if (!shell || !layer) throw new Error('shell or drag layer missing from the rendered tree');
    const band = layer.getBoundingClientRect();

    const appRegionOf = (el: Element): string => {
      for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        const region = style.webkitAppRegion || style.getPropertyValue('-webkit-app-region');
        if (region === 'drag' || region === 'no-drag') {
          return `${region}@${node === el ? 'self' : (node.className && typeof node.className === 'string' ? node.className.trim().split(/\s+/)[0] : node.tagName.toLowerCase())}`;
        }
      }
      return 'NONE';
    };

    const describe = (el: Element): string => {
      const classes = typeof el.className === 'string' && el.className
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
      return `${el.tagName.toLowerCase()}${classes}`;
    };

    const offenders: BandReport['offenders'] = [];
    for (const el of document.querySelectorAll(selector)) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      // Only elements that actually overlap the band can lose hit area to it.
      const overlap = Math.min(rect.bottom, band.bottom) - Math.max(rect.top, band.top);
      const horizontallyInside = rect.left < band.right && rect.right > band.left;
      if (overlap <= 0 || !horizontallyInside) continue;
      const region = appRegionOf(el);
      const afterLayer = Boolean(
        layer.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      if (region === 'no-drag' || region.startsWith('no-drag@')) {
        if (afterLayer) continue;
      }
      offenders.push({
        label: el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 24) || el.tagName,
        selector: describe(el),
        box: `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
        region,
        afterLayer,
        overlapPx: Math.round(overlap),
      });
    }

    return {
      layerIsFirstElementChild: shell.firstElementChild === layer,
      band: {
        top: Math.round(band.top),
        left: Math.round(band.left),
        right: Math.round(band.right),
        bottom: Math.round(band.bottom),
        width: Math.round(band.width),
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      edges: {
        top: Math.round(band.top),
        left: Math.round(band.left),
        right: Math.round(window.innerWidth - band.right),
      },
      offenders,
    };
  }, interactiveSelector);
}

async function assertBandIsWellFormed(page: Page, label: string): Promise<void> {
  const report = await readBand(page, INTERACTIVE_SELECTOR);
  expect(
    report.layerIsFirstElementChild,
    `${label}: the drag layer must be the first element child of ${SHELL}; Chromium subtracts a \`no-drag\` rect only from drag rects declared before it, so anything hoisted above the layer silently loses its hit area`,
  ).toBe(true);

  expect(report.band.width, `${label}: the drag band must be rendered`).toBeGreaterThan(0);

  // A band flush against a window edge takes the OS resize hit area with it.
  for (const edge of ['top', 'left', 'right'] as const) {
    expect(
      report.edges[edge],
      `${label}: the drag band must leave a resize corridor on the ${edge} window edge, otherwise the OS cannot resize the window there (regression class of the af681c1 P0). Band ${JSON.stringify(report.band)} in viewport ${JSON.stringify(report.viewport)}`,
    ).toBeGreaterThan(0);
  }

  expect(
    report.offenders,
    `${label}: every interactive element overlapping the drag band must resolve to \`-webkit-app-region: no-drag\` AND sit after the layer in document order. Offenders lose the overlapping part of their hit area to a window drag`,
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

test('the window-drag band stays inside the titlebar across surfaces, sidebar states, and the narrow breakpoint', async ({
  window: page,
}) => {
  const wide = { width: 1280, height: 900 };
  const narrow = { width: 760, height: 900 };

  await page.setViewportSize(wide);
  await collapseSidebar(page);
  await assertBandIsWellFormed(page, 'chat surface, sidebar collapsed, wide');

  await openSidebar(page);
  await assertBandIsWellFormed(page, 'chat surface, sidebar expanded, wide');

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
    await assertBandIsWellFormed(page, `${destination} surface, sidebar expanded, wide`);

    // Below 820px `.maka-module-main` drops to compact padding, which used to
    // lift its first row into the band. This is the state the wide sweep cannot
    // see.
    await page.setViewportSize(narrow);
    await expect(page.locator('.maka-module-main button').first()).toBeVisible();
    await assertBandIsWellFormed(page, `${destination} surface, narrow`);
    await page.setViewportSize(wide);
  }
});
