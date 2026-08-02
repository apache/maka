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
  const motion = page.locator('.maka-sidenav-motion');
  const handle = page.getByTestId('astryx-sidenav-resize-handle');
  const panelWidth = () => panel.evaluate((element) => element.getBoundingClientRect().width);

  // Choose a non-default width from the keyboard, so the restore assertion can
  // tell "came back" apart from "fell back to the 260px default".
  await handle.focus();
  const chosenWidth = Number(await handle.getAttribute('aria-valuenow')) + 10;
  await handle.press('ArrowRight');
  await expect.poll(panelWidth).toBe(chosenWidth);

  // Brand the node the ease is declared on. A CSS transition interpolates only
  // when the SAME element holds a previously-rendered value, and the whole
  // reason `.maka-sidenav-motion` exists is that SideNav's own root does not
  // qualify: it swaps element type across the toggle (`showResizeHandle =
  // isResizable && !collapsed`), so React remounts that subtree. Survival is
  // therefore the invariant — a declared `transition-property` proves nothing,
  // because the nav on main declared it too and still snapped.
  await motion.evaluate((element) => {
    (element as HTMLElement & { __motionBrand?: number }).__motionBrand = 1;
  });

  await page.getByRole('button', { name: '收起侧边栏' }).click();
  await expect(shell).toHaveAttribute('data-sidebar-state', 'collapsed');

  // The collapsed rail is 48px, and that number is load-bearing rather than
  // cosmetic: the column edge is dropped in this state precisely BECAUSE the
  // traffic lights (~62px) are wider than the rail, so an edge there would cut
  // through the light cluster. A wider rail silently invalidates that argument.
  // Astryx owns the value (`rootCollapsed` → --spacing-12); the product's own
  // collapsed rule reads the same token, so this asserts they agree.
  await expect.poll(panelWidth).toBe(48);

  // At 48px there is no history column left for the two hairlines to separate,
  // so both go transparent. Asserted here because this is the only test that
  // stands in the collapsed state; the rhythm test below owns them expanded.
  await expect
    .poll(() =>
      panel.evaluate((nav) => {
        const topHost = [...nav.children].find((child) =>
          child.querySelector('.maka-session-panel-top'),
        );
        const footHost = nav.querySelector('.maka-session-panel-footer')?.parentElement;
        if (!topHost || !footHost) return null;
        return [
          getComputedStyle(topHost).borderBottomColor,
          getComputedStyle(footHost).borderTopColor,
        ];
      }),
    )
    .toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);

  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await expect(shell).toHaveAttribute('data-sidebar-state', 'expanded');
  await expect.poll(panelWidth).toBe(chosenWidth);
  expect(chosenWidth).toBeGreaterThanOrEqual(180);

  // Same node, both toggles later. Moving the class back inside SideNav, or
  // hanging it off the nav, loses the brand here while every width assertion
  // above still passes — which is exactly the shipped defect.
  expect(
    await motion.evaluate(
      (element) => (element as HTMLElement & { __motionBrand?: number }).__motionBrand,
    ),
  ).toBe(1);

  // And the ease is declared on that surviving node.
  await expect
    .poll(() => motion.evaluate((element) => getComputedStyle(element).transitionProperty))
    .toBe('width');

  // ...and that a pointer drag suppresses it, so the rail does not trail the
  // cursor by one 280ms ease per pointer-move. The suppression is derived from
  // the handle's own `data-resizing` rather than stored in React, so it is
  // asserted by setting exactly the attribute Astryx sets while dragging.
  // Driving a real drag is not available: since the Astryx 0.2.0 upgrade the
  // handle ignores synthesised pointer input (see the round-trip test above),
  // so this pins the CSS contract the drag depends on.
  await handle.evaluate((element) => element.setAttribute('data-resizing', 'true'));
  await expect
    .poll(() => motion.evaluate((element) => getComputedStyle(element).transitionProperty))
    .toBe('none');
  await handle.evaluate((element) => element.removeAttribute('data-resizing'));
  await expect
    .poll(() => motion.evaluate((element) => getComputedStyle(element).transitionProperty))
    .toBe('width');

  // Focus alone must NOT suppress it. `:focus` answers "the handle was used at
  // some point", not "is being used now", so gating on it left the ease dead for
  // every later collapse until something else took focus.
  await handle.focus();
  await expect(handle).toBeFocused();
  await expect
    .poll(() => motion.evaluate((element) => getComputedStyle(element).transitionProperty))
    .toBe('width');
});

/**
 * The rail actually animates.
 *
 * Everything above runs on `sidebarLongSessionsWindow`, an e2e-fixture window —
 * and `base.css` caps every transition there to 0.01ms so screenshots and
 * geometry are deterministic. Nothing in that window can prove an ease runs; a
 * declared `transition-property` survives a zeroed duration, a suppressed gate,
 * and a remounted node alike. This is the one place with the product's real
 * durations, so it is where the animation itself gets locked.
 *
 * `getAnimations()` is the discriminating probe rather than sampling widths:
 * the browser creates a CSSTransition object only when a real interpolation
 * starts on that element between two different used values. A zero duration, a
 * `transition: none` gate, or a fresh node with no before-change style each
 * produce no object at all — which is exactly the set of ways this has broken.
 */
test('collapsing the rail starts a real width transition', async ({ window: page }) => {
  const shell = page.locator('.appFrame');
  const motion = page.locator('.maka-sidenav-motion');

  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await expect(shell).toHaveAttribute('data-sidebar-state', 'expanded');
  // Let the expand settle, so the collapse below starts from a resting width
  // and the transition it creates is unambiguously its own.
  await expect
    .poll(() => motion.evaluate((element) => element.getAnimations().length))
    .toBe(0);

  await page.getByRole('button', { name: '收起侧边栏' }).click();

  const running = await motion.evaluate((element) =>
    element.getAnimations().map((animation) => ({
      property: (animation as CSSTransition).transitionProperty,
      duration: Number(animation.effect?.getTiming().duration ?? 0),
    })),
  );
  expect(running, JSON.stringify(running)).toContainEqual(
    expect.objectContaining({ property: 'width' }),
  );
  expect(
    running.find((animation) => animation.property === 'width')!.duration,
    'a capped or zeroed duration is not an ease',
  ).toBeGreaterThan(50);
});

/**
 * Column-edge contract.
 *
 * The session column is separated from the content column by two things and no
 * others: the material difference AppShell paints from the theme's
 * `--color-background-body` / `--color-background-surface`, and the 1px rule
 * makaTheme.ts adds to the nav panel. Both were absent before this landed —
 * Maka ran `variant="surface"`, which paints both columns the same and draws no
 * divider — and the boundary was invisible.
 *
 * Neither half has a static gate: the material comes from a generated theme
 * file, the rule from a component override inside it, and a CSS grep would pass
 * on declarations that never reach the element. This asserts the rendered
 * result instead, in both sidebar states, because collapsed deliberately drops
 * BOTH halves — the traffic lights are wider than the 48px rail, so any column
 * edge there cuts through the light cluster.
 *
 * Both samples are taken off AppShell's OWN elements — the nav panel and
 * `.astryx-layout-content` — because those are what the theme paints. Sampling
 * the product's `.maka-panel-detail` inside the content column measured a copy:
 * it declared the same color itself, so the assertion held even when AppShell
 * painted nothing at all.
 */
test('the session column carries an edge expanded and drops it collapsed', async ({
  window: page,
}) => {
  const shell = page.locator('.appFrame');
  const navColumn = page.locator('.astryx-app-shell-sidenav');
  const contentColumn = page.locator('.maka-shell-astryx .astryx-layout-content');
  const edge = () =>
    navColumn.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        borderWidth: style.borderInlineEndWidth,
        borderColor: style.borderInlineEndColor,
      };
    });
  const contentBackground = () =>
    contentColumn.evaluate((element) => getComputedStyle(element).backgroundColor);

  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await expect(shell).toHaveAttribute('data-sidebar-state', 'expanded');

  // Both halves of the edge ease between states, so settle on the resting
  // value rather than sampling mid-interpolation (the transition passes through
  // oklab() on the way).
  await expect
    .poll(async () => (await edge()).background === (await contentBackground()))
    .toBe(false);
  const expanded = await edge();
  expect(expanded.borderWidth).toBe('1px');
  expect(expanded.borderColor).not.toBe('rgba(0, 0, 0, 0)');

  await page.getByRole('button', { name: '收起侧边栏' }).click();
  await expect(shell).toHaveAttribute('data-sidebar-state', 'collapsed');

  await expect
    .poll(async () => (await edge()).background === (await contentBackground()))
    .toBe(true);
  await expect.poll(async () => (await edge()).borderColor).toBe('rgba(0, 0, 0, 0)');
});

/**
 * Rail rhythm: the two hairlines that bracket the session history must read as
 * one component, and the group labels as peers of the rows they label.
 *
 * Both were off in the shipped rail. The top line was an Astryx <Divider> placed
 * inside `topContent`, so it drew at --color-border — twice the footer rule's
 * alpha — and sat inside the sticky shell's inline padding, stopping 8px short at
 * each end (x=8 w=244 against the footer's x=0 w=260); it also sat flush against
 * 定时任务 while the footer's line cleared its icon by 9px. And SideNavSection
 * titles came from Astryx's `supporting` tier, a step below the rows they label,
 * which at Maka's 14px body reads as a caption rather than a heading.
 *
 * Neither has a static gate that would bite: a CSS grep passes on declarations
 * that never reach the element, and the type tier resolves through two levels of
 * custom property. Measure what rendered, and measure the two lines AGAINST EACH
 * OTHER rather than against fixed numbers — the invariant is that they match,
 * not what they match at.
 */
test('the sidebar rail keeps its hairlines and group labels on one rhythm', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const sidebar = page.getByRole('navigation', { name: '对话列表' });
  await expect(sidebar).toBeVisible();

  const lines = await sidebar.evaluate((nav) => {
    const topHost = [...nav.children].find((child) =>
      child.querySelector('.maka-session-panel-top'),
    );
    const footHost = nav.querySelector('.maka-session-panel-footer')?.parentElement;
    if (!topHost || !footHost) return null;
    const topStyle = getComputedStyle(topHost);
    const footStyle = getComputedStyle(footHost);
    const items = topHost.querySelectorAll('.astryx-side-nav-item');
    const lastNavItem = items[items.length - 1];
    const settings = footHost.querySelector('.astryx-side-nav-item');
    const rect = (element: Element) => element.getBoundingClientRect();
    return {
      top: {
        width: rect(topHost).width,
        thickness: topStyle.borderBottomWidth,
        color: topStyle.borderBottomColor,
        // Distance from the line to the control it separates.
        clearance: Math.round(rect(topHost).bottom - rect(lastNavItem).bottom),
      },
      foot: {
        width: rect(footHost).width,
        thickness: footStyle.borderTopWidth,
        color: footStyle.borderTopColor,
        clearance: settings ? Math.round(rect(settings).top - rect(footHost).top) : -1,
      },
      panelWidth: rect(nav).width,
    };
  });

  expect(lines, 'both sticky zones must render').not.toBeNull();
  const { top, foot, panelWidth } = lines!;
  expect(top.thickness).toBe(foot.thickness);
  expect(top.color).toBe(foot.color);
  expect(top.clearance).toBe(foot.clearance);
  // Full-bleed: a line inset from the panel edge reads as a box border rather
  // than a separator, which is exactly how the Divider version read. Drawing
  // both on their zone shells makes this structural, so the assertion is a
  // regression guard against the line moving back inside a padded element.
  expect(top.width).toBe(panelWidth);
  expect(foot.width).toBe(panelWidth);

  // 会话 / 最近 sit on the same step as the rows beneath them, with weight and
  // color carrying the hierarchy instead of size.
  const type = await sidebar.evaluate((nav) => {
    const read = (element: Element | null) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        size: style.fontSize,
        leading: style.lineHeight,
        weight: Number(style.fontWeight),
      };
    };
    const label = nav.querySelector('.maka-session-group [id$="-title"]');
    const row = nav.querySelector('.maka-session-row .astryx-side-nav-item span');
    return { label: read(label), row: read(row) };
  });
  expect(type.label, 'a group label must render').not.toBeNull();
  expect(type.row, 'a session row must render').not.toBeNull();
  expect(type.label!.size).toBe(type.row!.size);
  // Both halves of the tier, not just size: leaving the supporting multiplier
  // on a 14px font lands the line box at 23.33px, off the 4px grid.
  expect(type.label!.leading).toBe(type.row!.leading);
  expect(type.label!.weight).toBeGreaterThan(type.row!.weight);

  // The tier is rebound for the section HEADER, and must stop there.
  // SideNavSection wraps the whole list body in the same element as its title,
  // and custom properties inherit, so binding it on the section root instead
  // pulls row metadata up with it — measured live, this badge went 12px → 14px.
  // Project grouping is where that metadata renders.
  await page.getByRole('radio', { name: '按项目' }).click();
  const badge = sidebar.locator('.astryx-badge').first();
  await expect(badge).toBeVisible();
  const badgeSize = await badge.evaluate((element) => getComputedStyle(element).fontSize);
  expect(Number.parseFloat(badgeSize), 'the tier must not reach row metadata').toBeLessThan(
    Number.parseFloat(type.row!.size),
  );
});
