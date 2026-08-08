import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Sidebar footer-visibility geometry contract (`sidebar-long-sessions`).
 *
 * The `sidebar-long-sessions` fixture seeds 60 active sessions so the sidebar
 * scroll container can be verified end-to-end: the session list must scroll
 * inside its own constrained grid row while the footer (Settings entry +
 * version info) stays pinned at the bottom of the sidebar panel — never pushed
 * off-screen — regardless of session count.
 *
 * History: this invariant was the P0 WAWQAQ flagged (msg `761141c5`),
 * historically attributed to `min-height: 0` / `minmax(0, 1fr)` dropping out of
 * the sidebar grid. At this fixture's window size those grid constraints are
 * mutually redundant (removing any one of them leaves the layout
 * byte-identical); the declaration this spec actually bites on is
 * `.maka-session-panel { height: 100% }` — the definite height the whole
 * minmax chain resolves against. Remove it and the panel grows to content
 * height: the list stops overflowing and the footer lands far below the
 * window (verified red run: footer bottom ~2521px in an 820px viewport).
 * Before #1308 the only regression lock was a screenshot baseline that never
 * ran in CI; #1308 retired the screenshot harness, leaving the geometry
 * explicitly unlocked (issue #1311):
 *   - `sidebar-scroll-contract.test.ts` is a static grep gate over the CSS
 *     grid constraints (minmax / min-height); it does not pin `height: 100%`
 *     and does not assert rendered footer-visibility geometry. The two layers
 *     deliberately lock different declarations.
 *   - `scroll-geometry.spec.ts` boots `long-transcript` and probes
 *     Astryx `ChatLayout`, not the sidebar.
 *
 * This spec is the rendered-geometry lock. It boots the `sidebar-long-sessions`
 * fixture and asserts, against the live desktop shell:
 *   (a) the sidebar list scroller actually overflows and scrolling it moves its
 *       own scrollTop while the chat viewport's scrollTop is unaffected, and
 *   (b) the footer's bounding rect stays fully inside both the sidebar panel
 *       and the window viewport — before and after scrolling the list to the
 *       bottom.
 *
 * Scroll-independence note: the scenario opens the newest session (`...-00`),
 * whose transcript is a single short exchange, so the chat viewport does NOT
 * overflow and its scrollTop is fixed at 0. Independence is therefore asserted
 * in the form the seed makes meaningful — the sidebar list has its own
 * overflowing scroll container whose scrollTop changes under a scroll, while
 * the chat scroller's scrollTop stays put. If the panel loses its constrained
 * height, the list stops being a constrained scroller (its own overflow
 * collapses) and the footer leaves the viewport; both are caught below.
 */

const LIST_CONTENT = '.maka-session-list';
const CHAT_VIEWPORT = '[data-chat-scroll-container="true"]';

interface ScrollerMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

interface Rect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

interface Geometry {
  footer: Rect | null;
  panel: Rect | null;
  viewport: { width: number; height: number };
  list: ScrollerMetrics | null;
  chat: ScrollerMetrics | null;
}

async function readGeometry(page: Page): Promise<Geometry> {
  return page.evaluate((listContentSelector) => {
    const rect = (el: Element | null): Rect | null => {
      if (!el) return null;
      const { top, right, bottom, left, width, height } = el.getBoundingClientRect();
      return { top, right, bottom, left, width, height };
    };
    const scroller = (el: Element | null): { scrollTop: number; scrollHeight: number; clientHeight: number } | null => {
      if (!el) return null;
      const node = el as HTMLElement;
      return { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
    };
    return {
      footer: rect(document.querySelector('.maka-session-panel-footer')),
      panel: rect(document.querySelector('.maka-session-panel')),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      list: scroller(document.querySelector(listContentSelector)?.parentElement ?? null),
      chat: scroller(document.querySelector('[data-chat-scroll-container="true"]')),
    };
  }, LIST_CONTENT);
}

// The footer must sit fully inside the sidebar panel AND inside the window
// viewport. A 1px tolerance absorbs sub-pixel rounding between
// getBoundingClientRect and the integer window metrics; the regression this
// guards against pushes the footer hundreds of pixels past the window bottom,
// so the tolerance never masks it.
function expectFooterContained(geo: Geometry, label: string): void {
  const diag = `${label}: ${JSON.stringify(geo)}`;
  const { footer, panel, viewport } = geo;
  expect(footer, diag).not.toBeNull();
  expect(panel, diag).not.toBeNull();
  if (!footer || !panel) return;
  // A real, laid-out footer occupies space.
  expect(footer.height, diag).toBeGreaterThan(0);
  expect(footer.width, diag).toBeGreaterThan(0);
  // Inside the sidebar panel.
  expect(footer.top, diag).toBeGreaterThanOrEqual(panel.top - 1);
  expect(footer.bottom, diag).toBeLessThanOrEqual(panel.bottom + 1);
  expect(footer.left, diag).toBeGreaterThanOrEqual(panel.left - 1);
  expect(footer.right, diag).toBeLessThanOrEqual(panel.right + 1);
  // Inside the window viewport (the "not pushed off-screen" invariant).
  expect(footer.top, diag).toBeGreaterThanOrEqual(0);
  expect(footer.bottom, diag).toBeLessThanOrEqual(viewport.height + 1);
  expect(footer.left, diag).toBeGreaterThanOrEqual(0);
  expect(footer.right, diag).toBeLessThanOrEqual(viewport.width + 1);
}

// Drive the sidebar scroller to the bottom and poll until scrollTop settles.
// No fixed sleep: OverlayScrollbars may clamp the assigned scrollTop over a
// frame, so we re-assign and wait for two agreeing reads at the bottom edge.
async function scrollListToBottom(page: Page): Promise<number> {
  let previous = -1;
  await expect
    .poll(
      async () => {
        const metrics = await page.evaluate((selector) => {
          const el = document.querySelector(selector)?.parentElement as HTMLElement | null;
          if (!el) return null;
          el.scrollTop = el.scrollHeight;
          return {
            scrollTop: Math.round(el.scrollTop),
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          };
        }, LIST_CONTENT);
        if (!metrics) return false;
        const atBottom =
          metrics.scrollTop > 0 &&
          metrics.scrollTop === previous &&
          Math.abs(metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight) <= 2;
        previous = metrics.scrollTop;
        return atBottom;
      },
      { timeout: 10_000, intervals: [200] },
    )
    .toBe(true);
  return previous;
}

test('sidebar list scrolls independently and keeps the footer in view with 60 sessions', async ({
  sidebarLongSessionsWindow: page,
}) => {
  // (0) No row-count pin here: its only purpose was to prove the list
  // overflows, which (1a) asserts directly on the scroller metrics — and the
  // rows' `title` is session metadata (formatSessionMeta), not the session
  // name, so a title-based count could not select them anyway. Seed
  // completeness (60 sessions on disk) lives in the fixture unit tests.

  // The list scroller and the chat scroller are distinct elements.
  await expect(page.locator(LIST_CONTENT)).toHaveCount(1);
  await expect(page.locator(CHAT_VIEWPORT)).toHaveCount(1);

  // Astryx owns the chat's initial fill and follows transcript geometry
  // asynchronously. Establish its terminal pinned position before using the
  // chat scrollTop as the sidebar-independence control value.
  await expect(page.locator(`${CHAT_VIEWPORT}[data-turn-warmup="settled"]`)).toBeAttached();
  await expect.poll(async () => {
    const geometry = await readGeometry(page);
    return geometry.chat
      ? Math.round(geometry.chat.scrollHeight - geometry.chat.scrollTop - geometry.chat.clientHeight)
      : Number.POSITIVE_INFINITY;
  }).toBeLessThanOrEqual(1);

  // The newest fixture session is one short exchange. It already fits above
  // the composer, so reaching its final message must not create a second,
  // composer-height scroll range below the conversation.
  const settledChat = (await readGeometry(page)).chat;
  expect(settledChat, JSON.stringify(settledChat)).not.toBeNull();
  if (settledChat) {
    const diagnostics = JSON.stringify(settledChat);
    expect(settledChat.scrollHeight - settledChat.clientHeight, diagnostics).toBeLessThanOrEqual(1);
    expect(settledChat.scrollTop, diagnostics).toBeLessThanOrEqual(1);
  }

  // (1a) The sidebar list scroller actually overflows its constrained grid
  // row — this is what makes it an independent scroll container. If the panel
  // loses its constrained height, the row grows to content height and this
  // never holds.
  await expect
    .poll(
      async () => {
        const geo = await readGeometry(page);
        return geo.list ? geo.list.scrollHeight - geo.list.clientHeight : 0;
      },
      { timeout: 10_000, intervals: [200] },
    )
    .toBeGreaterThan(50);

  // (b) Footer contained before any scrolling.
  const before = await readGeometry(page);
  expectFooterContained(before, 'initial');
  expect(before.list, JSON.stringify(before)).not.toBeNull();
  expect(before.chat, JSON.stringify(before)).not.toBeNull();
  const chatScrollTopBefore = before.chat?.scrollTop ?? -1;
  const listScrollTopBefore = before.list?.scrollTop ?? -1;
  expect(listScrollTopBefore).toBe(0);

  // (1b) Scroll the sidebar list to the bottom.
  const settledListScrollTop = await scrollListToBottom(page);
  expect(settledListScrollTop).toBeGreaterThan(0);

  const after = await readGeometry(page);
  const afterDiag = JSON.stringify(after);

  // The sidebar's own scrollTop moved...
  expect(after.list?.scrollTop ?? -1, afterDiag).toBeGreaterThan(listScrollTopBefore);
  // ...while the already-settled chat viewport's scrollTop is unaffected.
  // This is the scroll-independence lock for this seed.
  expect(after.chat?.scrollTop ?? -1, afterDiag).toBe(chatScrollTopBefore);

  // (b) Footer still fully inside the panel and the window after scrolling the
  // list all the way down — the core "footer never gets pushed off-screen"
  // invariant #1311 locks.
  expectFooterContained(after, 'after-scroll-to-bottom');
});

test('keyboard resize survives a collapse round trip', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const shell = page.locator('.appFrame');
  const panel = page.locator('.maka-session-panel');
  const handle = page.getByTestId('astryx-sidenav-resize-handle');
  const panelWidth = () =>
    panel.evaluate((element) => element.getBoundingClientRect().width);

  await expect(shell).toHaveAttribute('data-sidebar-state', 'expanded');
  await handle.focus();
  const chosenWidth = Number(await handle.getAttribute('aria-valuenow')) + 10;
  await handle.press('ArrowRight');
  await expect.poll(panelWidth).toBe(chosenWidth);

  await page.getByRole('button', { name: '收起侧边栏' }).click();
  await expect(shell).toHaveAttribute('data-sidebar-state', 'collapsed');
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await expect(shell).toHaveAttribute('data-sidebar-state', 'expanded');
  await expect.poll(panelWidth).toBe(chosenWidth);
});

/**
 * The rail's material contract. AppShell owns both column materials; the rail
 * takes --color-background-body and the content column takes the product's
 * --agents-layout-bg, and makaTheme.ts points BOTH at --surface-canvas, so the
 * two columns are one surface and the transparent titlebar band above them
 * reads as one band across the window.
 *
 * Collapsing must not re-material the rail. Product CSS used to repaint it
 * --color-background-surface at 48px so the traffic lights would not straddle a
 * column edge narrower than they are; by the time the content column was moved
 * onto --agents-layout-bg that override was the only thing splitting the band,
 * and in dark mode it landed the rail on a third tone (L 0.205 against the
 * canvas's 0.18) that ran to the window top past the plate's 4px gutter.
 *
 * A screenshot cannot lock this — the bug is a state-dependent token mapping,
 * invisible in light mode because --color-background-surface happens to equal
 * the plate's fill there. Read the resolved colors instead, in both collapse
 * states, and compare the rail against the column it must match rather than
 * against a literal: the contract is "same material", not "this exact gray", so
 * it survives a palette or theme change.
 *
 * Colors are compared as painted RGBA bytes, not as computed-style strings:
 * Chromium serializes the same color differently depending on how it was
 * derived (a relative `oklch(from …)` token resolves to `oklab()`), so equal
 * paint could read as unequal text.
 *
 * The read must SETTLE before it is asserted, which is why this takes two
 * agreeing samples rather than one read or a plain poll-until-equal. A
 * re-materialing rule reaches its new color through an ease, so immediately
 * after the toggle the rail still reports its old value — the collapsed
 * material it is supposed to keep. Both a single fast read and a poll that
 * stops at its first match would accept exactly the frame the bug flies
 * through; measured against the pre-fix rule, poll-until-equal passed.
 */
interface RailMaterial {
  rail: string;
  column: string;
  railEdge: string;
  railEdgeWidth: string;
}

async function readRailMaterial(page: Page): Promise<RailMaterial | null> {
  return page.evaluate(() => {
    const rail = document.querySelector('.astryx-app-shell-sidenav');
    const column = document.querySelector('.astryx-layout-content');
    if (!rail || !column) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) return null;
    const bytes = (color: string): string => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data).join(',');
    };
    return {
      rail: bytes(getComputedStyle(rail).backgroundColor),
      column: bytes(getComputedStyle(column).backgroundColor),
      railEdge: bytes(getComputedStyle(rail).borderInlineEndColor),
      railEdgeWidth: getComputedStyle(rail).borderInlineEndWidth,
    };
  });
}

// Two agreeing consecutive reads, 250ms apart — longer than --duration-base
// (the ease the pre-fix rule used) so a value still in flight cannot agree with
// itself. Same shape as scrollListToBottom above.
async function settledRailMaterial(page: Page): Promise<RailMaterial | null> {
  let previous: string | null = null;
  let settled: RailMaterial | null = null;
  await expect
    .poll(
      async () => {
        const current = await readRailMaterial(page);
        const serialized = JSON.stringify(current);
        const agrees = current !== null && serialized === previous;
        previous = serialized;
        if (agrees) settled = current;
        return agrees;
      },
      { timeout: 10_000, intervals: [250] },
    )
    .toBe(true);
  return settled;
}

const TRANSPARENT = '0,0,0,0';
const NO_EDGE = '0px';

test('the rail wears its column material in both collapse states', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const shell = page.locator('.appFrame');

  await expect(shell).toHaveAttribute('data-sidebar-state', 'expanded');
  const expanded = await settledRailMaterial(page);
  expect(expanded, 'expanded').not.toBeNull();
  expect(expanded?.rail, JSON.stringify(expanded)).toBe(expanded?.column);
  // The plate's edge is the one boundary on this seam; the theme's own
  // full-height sidenav hairline stays dropped in both states — in color, and
  // in the 1px of layout it used to occupy while invisible. That phantom pixel
  // started the content column 1px right of where the sidebar column ended, so
  // the titlebar breadcrumb could not align to the seam it opens at.
  expect(expanded?.railEdge, JSON.stringify(expanded)).toBe(TRANSPARENT);
  expect(expanded?.railEdgeWidth, JSON.stringify(expanded)).toBe(NO_EDGE);

  await page.getByRole('button', { name: '收起侧边栏' }).click();
  await expect(shell).toHaveAttribute('data-sidebar-state', 'collapsed');
  const collapsed = await settledRailMaterial(page);
  // Collapsing is a width change, not a material change: the rail keeps wearing
  // its column's material, and the column's material has not moved either.
  expect(collapsed, JSON.stringify({ expanded, collapsed })).toEqual({
    rail: expanded?.column,
    column: expanded?.column,
    railEdge: TRANSPARENT,
    railEdgeWidth: NO_EDGE,
  });
});
