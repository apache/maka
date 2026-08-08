import { test, expect } from './fixtures';

test('generated files use list-to-preview navigation with a compact action menu', async ({ artifactPaneWindow: page }) => {
  const pane = page.getByRole('region', { name: '生成文件预览面板' });
  const list = pane.getByRole('listbox', { name: '生成文件列表' });
  const notes = list.getByRole('option', { name: 'notes.md' });

  await expect(list).toBeVisible();
  await notes.click();

  await expect(list).toHaveCount(0);
  await expect(pane.getByRole('region', { name: '预览 notes.md' })).toBeVisible();
  await expect(pane.getByRole('button', { name: '返回生成文件列表' })).toBeVisible();

  await pane.getByRole('button', { name: 'notes.md 的更多操作' }).click();
  await expect(page.getByRole('menuitem', { name: '在 Finder 中打开' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '另存为' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '复制' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '删除' })).toBeVisible();
  await page.keyboard.press('Escape');

  await pane.getByRole('button', { name: '返回生成文件列表' }).click();
  await expect(list).toBeVisible();
  await expect(list).toBeFocused();

  await list.press('Enter');
  await expect(list).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(list).toBeVisible();
  await expect(list).toBeFocused();
});

// Workbar product journey. Narrow max-height and "toggle unmounted without a
// session" are pinned in chat-shell-layout-contract (CSS + chrome actions source).
test('session tools share one user-controlled workbar that stays mounted across repeated collapse', async ({ sessionWorkbarWindow: page }) => {
  const workbar = page.getByRole('complementary', { name: '会话工作栏' });
  const rightWorkbar = page.locator(
    '[data-maka-contract="session-workbar-right"]',
  );
  const tabs = workbar.getByRole('tablist', { name: '会话工作栏标签' });

  await expect(tabs.getByRole('tab', { name: /任务/ })).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.getByRole('tab', { name: /浏览器/ })).toHaveCount(0);
  const launcher = workbar.getByRole('button', { name: '打开工作栏标签' });
  await launcher.click();
  await expect(page.getByRole('menuitem', { name: '生成文件' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(
    page
      .getByLabel('活跃会话任务')
      .getByText(/完成会话任务台账升级/),
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
  const recent = page.getByRole('button', { name: /最近结束/ });
  const recentRow = page.getByText('验证 Goal 一次提醒门禁');
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

  // Right and bottom panel topology is persistent now: collapse hides the
  // right grid plate without destroying its tabs, drafts, or embedded views.
  await expect(rightWorkbar).toHaveCount(1);
  await expect(rightWorkbar).toBeHidden();
  await expect(rightWorkbar).toHaveAttribute('data-collapsed', 'true');
  await expect(page.locator('.maka-workbar-resize-handle')).toHaveCount(0);

  const expand = page.getByRole('button', { name: '展开会话工作栏' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  expect(await expand.boundingBox()).toMatchObject({ x: openBox.x, y: openBox.y });
  await expand.click();
  await expect(rightWorkbar).toBeVisible();
  // The width the drag above landed on, restored rather than reset.
  await expect(rightWorkbar).toHaveCSS('width', '511px');

  // A second collapse/expand cycle: the right plate must stay mounted (count
  // 1, hidden, data-collapsed) rather than remount, and the user-set width
  // must survive repetition, not just the first restore.
  await collapse.click();
  await expect(rightWorkbar).toHaveCount(1);
  await expect(rightWorkbar).toBeHidden();
  await expect(rightWorkbar).toHaveAttribute('data-collapsed', 'true');
  await expand.click();
  await expect(rightWorkbar).toBeVisible();
  await expect(rightWorkbar).toHaveCSS('width', '511px');

  await rightWorkbar.getByRole('button', { name: '打开工作栏标签' }).click();
  await page.getByRole('menuitem', { name: '生成文件' }).click();
  await expect(page.getByText('暂无生成文件')).toBeVisible();

  // The record-file row is a fact about the workspace, not the session: it
  // exists even when the trace is empty, and it reads the exact database path
  // from `app:info`'s operationalStateDatabasePath (resolved in main, the
  // same single source of truth the data-settings row shows) — no second
  // channel, so nothing to register per boot mode.
  // Then pin the 320px minimum: the directory truncates while the filename
  // keeps its glyphs (the row's whole point at that width), the tooltip
  // trigger is keyboard-reachable, and the copy actually lands the FULL path
  // on the clipboard.
  await rightWorkbar.getByRole('button', { name: '打开工作栏标签' }).click();
  await page.getByRole('menuitem', { name: '追踪' }).click();
  const inspectorTab = tabs.getByRole('tab', { name: /追踪/ });
  await expect(inspectorTab).toHaveAttribute('aria-selected', 'true');
  const recordFileRow = page.locator(
    '[data-maka-contract="session-inspector-record-file"]',
  );
  await expect(recordFileRow).toBeVisible();
  // The filename is its own box, never truncated by the row's ellipsis — the
  // only part of the row whose glyphs matter. `toBeVisible` cannot tell a
  // visible box from a clipped one (overflow-hidden content stays "visible"),
  // so prove there is no overflow: the box must be as wide as its content.
  const recordFileName = recordFileRow.locator('.maka-inspector-record-file-name');
  await expect(recordFileName).toHaveText(/runtime\.sqlite$/);
  await expect
    .poll(() =>
      recordFileName.evaluate((el) => el.scrollWidth <= el.clientWidth),
    )
    .toBe(true);
  // The path also renders once inside the Astryx Tooltip's popover (hidden
  // until hover/focus). The tooltip trigger is the row's path box, a real Tab
  // stop: keyboard focus opens the tooltip (focus-visible) and Escape closes
  // it — mouse users are not the only ones who can read the full path.
  const recordFilePath = recordFileRow.locator('.maka-inspector-record-file');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await inspectorTab.focus();
  for (
    let step = 0;
    step < 5 && !(await recordFilePath.evaluate((el) => el === document.activeElement));
    step += 1
  ) {
    await page.keyboard.press('Tab');
  }
  await expect(recordFilePath).toBeFocused();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  const copyButton = recordFileRow.getByRole('button', { name: '复制文件路径' });
  await expect(copyButton).toBeEnabled();
  // Drag the divider all the way right: the workbar is an end-of-row panel
  // (the shell hands Astryx `isReversed`), so dragging right shrinks it, and
  // the width model clamps at the same 320px minimum the keyboard arrow uses,
  // landing the panel on the smallest surface the row is allowed to live in —
  // the filename still fits, the copy button stays inside the panel, and the
  // clipboard receives the full path, not the truncated display.
  const resizeBox = (await resize.boundingBox())!;
  const handleY = resizeBox.y + resizeBox.height / 2;
  await page.mouse.move(resizeBox.x, handleY);
  await page.mouse.down();
  await page.mouse.move(resizeBox.x + 400, handleY, { steps: 5 });
  await page.mouse.up();
  await expect(resize).toHaveAttribute('aria-valuenow', '320');
  await expect(rightWorkbar).toHaveCSS('width', '320px');
  await expect(recordFileRow).toBeVisible();
  await expect(copyButton).toBeVisible();
  await expect
    .poll(() =>
      recordFileName.evaluate((el) => el.scrollWidth <= el.clientWidth),
    )
    .toBe(true);
  await copyButton.click();
  await expect(page.getByText('已复制文件路径')).toBeVisible();
  // The row carries the FULL authoritative path from `app:info`, while the
  // visible directory is allowed to truncate. Clipboard read is intentionally
  // denied by the app's permission policy; the success toast proves the write.
  const fullPath = await recordFileRow.getAttribute('data-full-path');
  expect(fullPath).toMatch(/runtime\.sqlite$/);

  await page.locator('button[aria-label="展开侧边栏"]').dispatchEvent('click');
  await page
    .getByRole('navigation', { name: '对话列表' })
    .getByRole('button', { name: '扩展', exact: true })
    .dispatchEvent('click');
  await expect(workbar).toBeHidden();
  await expect(page.getByRole('main', { name: '扩展' })).toBeVisible();
});
