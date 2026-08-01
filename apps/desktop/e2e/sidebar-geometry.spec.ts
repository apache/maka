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
  // (0) The fixture seeds 60 `sidebar-long-sessions` rows (named "会话 NN"),
  // all rendered in the expanded panel. `seedE2eFixture` also always writes a
  // handful of baseline chat sessions; their exact count is not this
  // contract's concern — the 60-row pin alone proves the overflow
  // precondition the geometry assertions depend on.
  await expect(page.locator('[data-session-id][title^="会话 "]')).toHaveCount(60);

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

test('official SideNav resize handle updates the sidebar width from the keyboard', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const shell = page.locator('.appFrame');
  const panel = page.locator('.maka-session-panel');
  const handle = page.getByTestId('astryx-sidenav-resize-handle');

  await expect(shell).toHaveAttribute('data-sidebar-state', 'expanded');
  await handle.focus();
  await expect(handle).toBeFocused();

  const beforeWidth = Number(await handle.getAttribute('aria-valuenow'));
  await handle.press('ArrowRight');
  await expect.poll(async () => Number(await handle.getAttribute('aria-valuenow'))).toBe(beforeWidth + 10);
  await expect.poll(() => panel.evaluate((element) => element.getBoundingClientRect().width))
    .toBe(beforeWidth + 10);
});

/**
 * A collapse/expand round trip must return the sidebar to a usable width, and
 * to the width the user had chosen rather than the default.
 *
 * This used to drive the collapse by dragging the resize handle past its
 * minimum. That no longer works: since the Astryx 0.2.0 upgrade (#1750) the
 * handle does not respond to synthesised pointer input at all. Measured on this
 * branch — after `mouse.down()` on the handle and a drag across the panel,
 * `aria-valuenow` and the panel's rendered width both stay at 260, and
 * dispatching a hand-built `PointerEvent` sequence (correct `pointerId`,
 * `buttons`, and `isPrimary`, delivered both to the handle and to `window`)
 * moves neither. The handle still works from the keyboard, which the test above
 * covers, so this is specific to pointer drag. The test kept asserting
 * `data-sidebar-state="collapsed"` after a drag that no longer collapsed
 * anything, which is why it has failed on every CI run since #1750.
 *
 * Collapsing through the titlebar control is the same round trip by the path a
 * user actually has, and it is drivable.
 *
 * NOT covered here, and deliberately: `app-shell.tsx` refuses to persist a
 * width below `SESSION_LIST_EXPANDED_MIN_WIDTH`, which is what stops a
 * drag-to-collapse from writing a sub-minimum width that the next expand would
 * restore. Reaching that guard needs Astryx to report an under-minimum width,
 * and pointer drag is the only thing that produces one. It has no renderer-side
 * test seam today, so it is currently unlocked rather than silently "covered".
 */
test('titlebar restores the chosen SideNav width across a collapse round trip', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const shell = page.locator('.appFrame');
  const panel = page.locator('.maka-session-panel');
  const handle = page.getByTestId('astryx-sidenav-resize-handle');
  const panelWidth = () => panel.evaluate((element) => element.getBoundingClientRect().width);

  // Choose a non-default width from the keyboard, so the restore assertion can
  // tell "came back" apart from "fell back to the 260px default".
  await handle.focus();
  const chosenWidth = Number(await handle.getAttribute('aria-valuenow')) + 10;
  await handle.press('ArrowRight');
  await expect.poll(panelWidth).toBe(chosenWidth);

  await page.getByRole('button', { name: '收起侧边栏' }).click();
  await expect(shell).toHaveAttribute('data-sidebar-state', 'collapsed');

  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await expect(shell).toHaveAttribute('data-sidebar-state', 'expanded');
  await expect.poll(panelWidth).toBe(chosenWidth);
  expect(chosenWidth).toBeGreaterThanOrEqual(180);
});
