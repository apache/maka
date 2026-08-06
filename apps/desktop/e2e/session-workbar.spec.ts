import { test, expect } from './fixtures';

// Workbar product journey. Narrow max-height and "toggle unmounted without a
// session" are pinned in chat-shell-layout-contract (CSS + chrome actions source).
test('session tools share one user-controlled workbar', async ({ sessionWorkbarWindow: page }) => {
  const workbar = page.getByRole('complementary', { name: '会话工作栏' });
  const tabs = workbar.getByRole('navigation', { name: '会话工作栏栏目' });

  await expect(tabs.getByRole('button', { name: /任务/ })).toHaveAttribute('aria-current', 'page');
  await expect(tabs.getByRole('button', { name: /浏览器/ })).toHaveCount(0);
  await expect(tabs.getByRole('button', { name: /文件/ })).toBeEnabled();
  await expect(
    workbar.getByRole('tree', { name: '活跃会话任务' }).getByText('完成会话任务台账升级'),
  ).toBeVisible();

  // Sizing is config handed to Astryx Resizable (#1861), and each part fails
  // silently: a vertical separator is what makes the drag read clientX, and
  // ArrowLeft has to widen an end-of-row panel. The width assertion is the
  // load-bearing one — the aria-* values mirror hook state, not the panel.
  const resize = page.getByRole('separator', { name: '调整会话工作栏宽度' });
  await expect(resize).toHaveAttribute('aria-orientation', 'vertical');
  await expect(resize).toHaveAttribute('aria-valuemin', '320');
  await expect(resize).toHaveAttribute('aria-valuemax', '600');
  await resize.focus();
  await resize.press('ArrowLeft');
  // 480 default (session-workbar-layout.ts) + the hook's 10px keyboard step.
  await expect(resize).toHaveAttribute('aria-valuenow', '490');
  await expect(workbar).toHaveCSS('width', '490px');

  // The seam is the canvas between two plates, and it is asserted as a GAP,
  // not as a colour. Comparing the workbar's tone to another surface is what
  // this used to do, and it passed while the column was invisible: it was
  // compared to the sidebar, which paints the same value the conversation does,
  // so "the workbar matches" and "the workbar has no boundary" were the same
  // assertion. Every default palette but darwin dark resolves all three to
  // `oklch(1 0 0)`.
  const conversation = page.locator('.mainColumn');
  const workbarBox = (await workbar.boundingBox())!;
  const conversationBox = (await conversation.boundingBox())!;
  const gutter = workbarBox.x - (conversationBox.x + conversationBox.width);
  expect(Math.round(gutter)).toBe(4);
  // And it is really canvas showing through, not a third surface: the frame
  // holding both plates paints nothing.
  await expect(page.locator('.maka-panel-detail')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  );
  await expect(workbar).toHaveCSS('border-left-width', '0px');

  // Two plates, one line. Each keeps the titlebar clearance as its own padding,
  // so their top edges agree without either reaching outside its box for it —
  // the previous formulation hung the column above the frame's padding box,
  // which made the frame scroll the overhang into view on the first focus.
  // Measured after the handle above took focus, which is what caught that.
  expect(Math.round(workbarBox.y)).toBe(Math.round(conversationBox.y));
  expect(Math.round(workbarBox.height)).toBe(Math.round(conversationBox.height));

  // Pointer drag, grabbed near the bottom of the divider: Astryx's default
  // side-placed grab zone lifts itself half its height off the handle, so a
  // low grab is what proves `pillPlacement="center"` is still holding the hit
  // area open. The fractional delta proves the width stays a whole pixel in
  // both the panel and the value screen readers announce.
  const box = (await resize.boundingBox())!;
  const y = box.y + box.height * 0.9;
  await page.mouse.move(box.x, y);
  await page.mouse.down();
  await page.mouse.move(box.x - 20.5, y, { steps: 2 });
  await page.mouse.up();
  await expect(workbar).toHaveCSS('width', '511px');
  await expect(resize).toHaveAttribute('aria-valuenow', '511');

  // Cmd+Tab mid-drag and release outside the app: Astryx only ends a drag on
  // pointerup/pointercancel, so without a blur guard the listeners survive and
  // the panel keeps tracking a button-less pointer while `body` stays stuck at
  // `user-select: none`.
  await page.mouse.move(box.x - 20.5, y);
  await page.mouse.down();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.move(box.x - 200, y, { steps: 2 });
  await page.mouse.up();
  await expect(workbar).toHaveCSS('width', '511px');
  await expect(page.locator('body')).toHaveCSS('user-select', 'auto');

  // Which key the width lands on is the load-bearing decision of #1861 and the
  // one thing every assertion above stays green through: `useResizable`'s
  // `autoSaveId` writes synchronously on each committed size (~90 writes per
  // drag), so the width stays on Maka's debounced key instead. Switching to
  // `autoSaveId` would orphan the user's stored width silently.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('maka-session-workbar-width-v1')))
    .toBe('511');
  expect(
    await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('astryx-resizable:'))),
  ).toEqual([]);

  // Keyboard-driven disclosure, observed through what the user can read: a
  // collapsed section hides its rows, and Enter on the trigger reveals them.
  const recent = workbar.getByRole('button', { name: /最近结束/ });
  const recentRow = workbar.getByText('验证 Goal 一次提醒门禁');
  await expect(recent).toHaveAttribute('aria-expanded', 'false');
  await expect(recentRow).toBeHidden();

  await recent.focus();
  await recent.press('Enter');
  await expect(recent).toHaveAttribute('aria-expanded', 'true');
  await expect(recentRow).toBeVisible();

  // One toggle, in one place, across its own state change. It used to hand off
  // to a second button inside the workbar's tab row while the workbar was open,
  // so the control a user clicks twice moved between those two clicks. The
  // titlebar is also the only row that already reserves `env(titlebar-area-*)`,
  // which is what keeps this button clear of the Windows caption strip.
  const collapse = page.getByRole('button', { name: '收起会话工作栏' });
  const openBox = (await collapse.boundingBox())!;
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await collapse.click();

  // Collapsing animates, which is only possible because ONE box survives it.
  // The column itself does not — it subscribes to task changes and can own a
  // live embedded browser — so the box stays behind at zero width and the column
  // is torn down when the width transition ends. Each half fails silently: lose
  // the box and the panel snaps shut, leave the column mounted and a closed
  // panel keeps working. `toBeHidden` alone would pass for both, so the count is
  // what actually holds the teardown.
  // The frames themselves are not observable here — the E2E fixture caps every
  // transition to 0.01ms on purpose — so what animates is held by the CSS
  // contract in session-workbar-layout.test.ts, and this covers the end state.
  const motion = page.locator('.maka-workbar-motion');
  await expect(workbar).toHaveCount(0);
  await expect(motion).toHaveCount(1);
  await expect(motion).toHaveCSS('width', '0px');
  await expect(page.locator('.maka-workbar-resize-handle')).toHaveCount(0);

  const expand = page.getByRole('button', { name: '展开会话工作栏' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  expect(await expand.boundingBox()).toMatchObject({ x: openBox.x, y: openBox.y });
  await expand.click();
  await expect(workbar).toBeVisible();
  // The width the drag above landed on, restored rather than reset.
  await expect(motion).toHaveCSS('width', '511px');
  await tabs.getByRole('button', { name: /文件/ }).click();
  await expect(workbar.getByText('暂无生成文件')).toBeVisible();

  await page.locator('button[aria-label="展开侧边栏"]').dispatchEvent('click');
  await page
    .getByRole('navigation', { name: '对话列表' })
    .getByRole('button', { name: '扩展', exact: true })
    .dispatchEvent('click');
  await expect(workbar).toBeHidden();
  await expect(page.getByRole('main', { name: '扩展' })).toBeVisible();
});

// The journey above runs under the fixture's global 0.01ms transition cap, so
// it can only ever see settled states. That cap is deliberate — every other
// assertion in this file would be timing-dependent without it — but it also
// means nothing in the suite watches the collapse actually happen, and the one
// defect that lived here was invisible for exactly that reason: the column was
// torn down 5ms into the slide and the 280ms animation ran on an empty box,
// which no settled-state assertion can distinguish from a correct collapse.
//
// So this test lifts the cap for itself and watches the frames. It collapses
// TWICE, because the first collapse was the one that worked.
test('the column stays mounted for the whole slide, every time', async ({
  sessionWorkbarWindow: page,
}) => {
  await expect(page.getByRole('complementary', { name: '会话工作栏' })).toBeVisible();
  await page.evaluate(() => document.documentElement.removeAttribute('data-maka-e2e-fixture'));

  const motion = page.locator('.maka-workbar-motion');
  const collapseOnce = async () => {
    // Sample the box's width and whether the column is still under it, on every
    // frame, from the click until the box reaches zero.
    const frames = await page.evaluate(async () => {
      const box = document.querySelector('.maka-workbar-motion') as HTMLElement;
      const seen: { width: number; mounted: boolean }[] = [];
      (document.querySelector('button[aria-label="收起会话工作栏"]') as HTMLElement).click();
      const started = performance.now();
      while (performance.now() - started < 600) {
        seen.push({
          width: Number.parseFloat(getComputedStyle(box).width),
          mounted: document.querySelector('.maka-session-workbar') !== null,
        });
        if (seen.length > 1 && seen.at(-1)!.width === 0) break;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return seen;
    });
    // It really animated — a snap would give two samples, not a spread.
    const widths = new Set(frames.map((frame) => frame.width));
    expect(widths.size).toBeGreaterThan(8);
    // And the column was under the box the whole way down, not just at the top.
    const carried = frames.filter((frame) => frame.width > 0);
    expect(carried.every((frame) => frame.mounted)).toBe(true);
    // Then it goes, once the box is shut.
    await expect(page.getByRole('complementary', { name: '会话工作栏' })).toHaveCount(0);
    await expect(motion).toHaveCSS('width', '0px');
  };

  await collapseOnce();
  await page.getByRole('button', { name: '展开会话工作栏' }).click();
  await expect(page.getByRole('complementary', { name: '会话工作栏' })).toBeVisible();
  await expect(motion).toHaveCSS('width', '480px');
  await collapseOnce();
});
