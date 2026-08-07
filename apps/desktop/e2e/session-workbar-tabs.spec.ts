import type { Page } from '@playwright/test';
import { test, expect, COMPOSER_INPUT } from './fixtures';

async function openWorkbarTool(page: Page, name: RegExp | string) {
  await page.getByRole('button', { name: '打开工作栏工具' }).click();
  await page.getByRole('menuitem', { name }).click();
}

async function tabLabels(page: Page): Promise<string[]> {
  return page.locator('.maka-workbar-tab-label').allTextContents();
}

async function dragTab(page: Page, sourceName: string, targetName: string) {
  const source = page.locator('.maka-workbar-tab-label', {
    hasText: new RegExp(`^${sourceName}$`),
  });
  const target = page.locator('.maka-workbar-tab-label', {
    hasText: new RegExp(`^${targetName}$`),
  });
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error('Expected visible workbar tabs');

  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
}

test('workbar tabs reorder, persist, and expose Codex-style close actions', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('workbar tab controller source');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: workbar tab controller source/)).toBeVisible();

  await openWorkbarTool(page, '任务');
  await openWorkbarTool(page, /文件/);
  await openWorkbarTool(page, '追踪');
  await openWorkbarTool(page, /侧边对话/);
  await expect.poll(() => tabLabels(page)).toEqual([
    '任务',
    '文件',
    '追踪',
    '侧边对话',
  ]);

  await dragTab(page, '追踪', '任务');
  await expect.poll(() => tabLabels(page)).toEqual([
    '追踪',
    '任务',
    '文件',
    '侧边对话',
  ]);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem('maka-session-workbar-panels-v3');
        if (!raw) return [];
        return (
          JSON.parse(raw) as {
            right: { tabs: Array<{ kind: string }> };
          }
        ).right.tabs.map((tab) => tab.kind);
      }),
    )
    .toEqual(['inspector', 'tasks', 'files']);

  await page.reload();
  await page.waitForSelector(COMPOSER_INPUT);
  await expect.poll(() => tabLabels(page)).toEqual(['追踪', '任务', '文件']);

  await page.getByRole('tab', { name: /^任务/ }).click({
    button: 'right',
  });
  await page.getByRole('menuitem', { name: '关闭右侧标签' }).click();
  await expect.poll(() => tabLabels(page)).toEqual(['追踪', '任务']);

  await page.getByRole('tab', { name: /^任务/ }).click({
    button: 'right',
  });
  await page.getByRole('menuitem', { name: '关闭其他标签' }).click();
  await expect.poll(() => tabLabels(page)).toEqual(['任务']);
});

test('closing a tab returns to the most recently active tab', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('workbar activation history source');
  await composer.press('Enter');
  await expect(
    page.getByText(/Fake backend received: workbar activation history source/),
  ).toBeVisible();

  await openWorkbarTool(page, '任务');
  await openWorkbarTool(page, /文件/);
  await openWorkbarTool(page, '追踪');
  await page.getByRole('tab', { name: /^任务/ }).click();
  await page.getByRole('tab', { name: /^文件/ }).click();
  await page.getByRole('button', { name: '关闭文件' }).click();

  await expect(page.getByRole('tab', { name: /^任务/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('workbar tabs and launcher follow desktop keyboard navigation', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('workbar keyboard navigation source');
  await composer.press('Enter');
  await expect(
    page.getByText(/Fake backend received: workbar keyboard navigation source/),
  ).toBeVisible();

  await openWorkbarTool(page, '任务');
  await openWorkbarTool(page, /文件/);
  await openWorkbarTool(page, '追踪');

  const tasksTab = page.getByRole('tab', { name: /^任务/ });
  const filesTab = page.getByRole('tab', { name: /^文件/ });
  const inspectorTab = page.getByRole('tab', { name: '追踪' });
  await tasksTab.focus();
  await tasksTab.press('ArrowRight');
  await expect(filesTab).toBeFocused();
  await expect(filesTab).toHaveAttribute('aria-selected', 'true');
  await filesTab.press('End');
  await expect(inspectorTab).toBeFocused();
  await inspectorTab.press('Home');
  await expect(tasksTab).toBeFocused();

  await page.getByRole('button', { name: '打开工作栏标签' }).click();
  const sideChatItem = page.getByRole('menuitem', { name: /侧边对话/ });
  const reviewItem = page.getByRole('menuitem', { name: '审阅' });
  const inspectorItem = page.getByRole('menuitem', { name: '追踪' });
  await expect(sideChatItem).toBeFocused();
  await sideChatItem.press('ArrowDown');
  await expect(reviewItem).toBeFocused();
  await reviewItem.press('End');
  await expect(inspectorItem).toBeFocused();
  await inspectorItem.press('Escape');
  await expect(tasksTab).toBeFocused();
  await expect(tasksTab).toHaveAttribute('aria-selected', 'true');
});
