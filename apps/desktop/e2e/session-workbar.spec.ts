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
  await expect(resize).toHaveAttribute('aria-valuenow', '410');
  await expect(workbar).toHaveCSS('width', '410px');

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
  await expect(workbar).toHaveCSS('width', '431px');
  await expect(resize).toHaveAttribute('aria-valuenow', '431');

  // Cmd+Tab mid-drag and release outside the app: Astryx only ends a drag on
  // pointerup/pointercancel, so without a blur guard the listeners survive and
  // the panel keeps tracking a button-less pointer while `body` stays stuck at
  // `user-select: none`.
  await page.mouse.move(box.x - 20.5, y);
  await page.mouse.down();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.move(box.x - 200, y, { steps: 2 });
  await page.mouse.up();
  await expect(workbar).toHaveCSS('width', '431px');
  await expect(page.locator('body')).toHaveCSS('user-select', 'auto');

  // Which key the width lands on is the load-bearing decision of #1861 and the
  // one thing every assertion above stays green through: `useResizable`'s
  // `autoSaveId` writes synchronously on each committed size (~90 writes per
  // drag), so the width stays on Maka's debounced key instead. Switching to
  // `autoSaveId` would orphan the user's stored width silently.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('maka-session-workbar-width-v1')))
    .toBe('431');
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

  await page.getByRole('button', { name: '收起会话工作栏' }).click();
  await expect(workbar).toBeHidden();

  await page.getByRole('button', { name: '展开会话工作栏' }).click();
  await expect(workbar).toBeVisible();
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
