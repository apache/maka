import type { Page } from '@playwright/test';
import { test, expect, COMPOSER_INPUT } from './fixtures';

async function waitForSourceSessionToSettle(page: Page) {
  await expect
    .poll(async () => {
      const [source] = await page.evaluate(() => window.maka.sessions.list());
      return source?.status;
    })
    .not.toBe('running');
}

async function openReadySideConversation(page: Page) {
  await page.getByRole('button', { name: '打开工作栏工具' }).click();
  await page.getByRole('menuitem', { name: /侧边对话/ }).click();
  await expect(
    page
      .locator(
        '.maka-workbar-tab[data-active][data-workbar-tab-id^="side-chat:"]',
      )
      .getByRole('tab'),
  ).not.toHaveAttribute('aria-busy', 'true');
}

test('side chat moves between right and bottom panels without losing its fork', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const mainComposer = page.locator(COMPOSER_INPUT);
  await mainComposer.fill('dual panel side chat source');
  await mainComposer.press('Enter');
  await expect(page.getByText(/Fake backend received: dual panel side chat source/)).toBeVisible();
  await waitForSourceSessionToSettle(page);

  await openReadySideConversation(page);
  const sideComposer = page.locator('.maka-quote-workbar-panel:not([hidden])').locator(
    COMPOSER_INPUT,
  );
  await sideComposer.fill('keep this side chat alive');
  await sideComposer.press('Enter');
  await expect(
    page.getByText(/Fake backend received: keep this side chat alive/),
  ).toBeVisible();
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(2);

  const rightPanel = page.locator('[data-maka-contract="session-workbar-right"]');
  const bottomPanel = page.locator('[data-maka-contract="session-workbar-bottom"]');
  await rightPanel.getByRole('tab', { name: 'keep this side chat alive' }).click({
    button: 'right',
  });
  await page.getByRole('menuitem', { name: '移动到底部面板' }).click();

  await expect(bottomPanel).toBeVisible();
  await expect(
    bottomPanel.getByRole('tab', { name: 'keep this side chat alive' }),
  ).toBeVisible();
  await expect(
    page.getByText(/Fake backend received: keep this side chat alive/),
  ).toBeVisible();
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(2);

  await bottomPanel.getByRole('tab', { name: 'keep this side chat alive' }).click({
    button: 'right',
  });
  await page.getByRole('menuitem', { name: '移动到右侧面板' }).click();
  await expect(
    rightPanel.getByRole('tab', { name: 'keep this side chat alive' }),
  ).toBeVisible();
  await expect(bottomPanel).toBeVisible();
  await expect(
    bottomPanel.getByRole('menuitem', { name: /侧边对话/ }),
  ).toBeVisible();
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(2);
});

test('minimum-width side chat keeps the active tab, launcher, and composer controls usable', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const mainComposer = page.locator(COMPOSER_INPUT);
  await mainComposer.fill('minimum width side chat source');
  await mainComposer.press('Enter');
  await expect(
    page.getByText(/Fake backend received: minimum width side chat source/),
  ).toBeVisible();
  await waitForSourceSessionToSettle(page);

  for (const name of ['任务', '追踪', '审阅']) {
    await page.getByRole('button', { name: '打开工作栏工具' }).click();
    await page.getByRole('menuitem', { name }).click();
  }
  await openReadySideConversation(page);

  const resizeHandle = page.locator('.maka-workbar-resize-handle-right');
  await resizeHandle.focus();
  await resizeHandle.press('Home');

  const panel = page.locator('[data-maka-contract="session-workbar-right"]');
  await expect(panel).toHaveCSS('width', '320px');
  const activeTab = panel.getByRole('tab', { name: '侧边对话' });
  const launcher = panel.getByRole('button', { name: '打开工作栏标签' });
  await expect(activeTab).toBeVisible();
  await expect(launcher).toBeVisible();
  await expect
    .poll(async () => {
      const [tabBox, listBox, launcherBox, panelBox] = await Promise.all([
        activeTab.boundingBox(),
        panel.locator('.maka-workbar-tab-list').boundingBox(),
        launcher.boundingBox(),
        panel.boundingBox(),
      ]);
      if (!tabBox || !listBox || !launcherBox || !panelBox) return false;
      return (
        tabBox.x >= listBox.x &&
        tabBox.x + tabBox.width <= listBox.x + listBox.width + 1 &&
        listBox.x + listBox.width <= launcherBox.x + 1 &&
        launcherBox.x + launcherBox.width <= panelBox.x + panelBox.width + 1 &&
        (await panel.evaluate((element) => element.scrollLeft)) === 0
      );
    })
    .toBe(true);

  const companion = page.locator(
    '.maka-session-workbar-panel[data-overlay][data-placement="right"] .maka-quote-companion',
  );
  await expect(companion).not.toHaveAttribute('data-preparing', 'true');
  const footerControls = [
    companion.locator('.maka-composer-plus-menu button').first(),
    companion.locator('.permissionModeIcon button').first(),
    companion.locator('.maka-composer-model-chip'),
    companion.locator('form.maka-composer button[type="submit"]'),
  ];
  await expect
    .poll(async () => {
      const [boxes, composerBox, noOverflow] = await Promise.all([
        Promise.all(footerControls.map((control) => control.boundingBox())),
        companion.locator('form.maka-composer').boundingBox(),
        companion
          .locator('form.maka-composer')
          .evaluate((form) => form.scrollWidth <= form.clientWidth + 1),
      ]);
      if (!composerBox || boxes.some((box) => box === null)) {
        return { noOverflow, aligned: false, outsideIndex: -2 };
      }
      const presentBoxes = boxes.filter((box): box is NonNullable<typeof box> => box !== null);
      const centerLines = presentBoxes.map((box) => box.y + box.height / 2);
      const outsideIndex = presentBoxes.findIndex(
        (box) =>
          box.x < composerBox.x ||
          box.x + box.width > composerBox.x + composerBox.width + 1,
      );
      return {
        noOverflow,
        aligned: Math.max(...centerLines) - Math.min(...centerLines) < 4,
        outsideIndex,
      };
    })
    .toEqual({ noOverflow: true, aligned: true, outsideIndex: -1 });

  await resizeHandle.focus();
  await resizeHandle.press('End');
  await expect(panel).toHaveCSS('width', '600px');
  await expect(activeTab).toBeVisible();
  await expect(launcher).toBeVisible();
});

test('static bottom-panel topology survives a reload', async ({ window: page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('dual panel persistence source');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: dual panel persistence source/)).toBeVisible();

  await page.getByRole('button', { name: '打开工作栏工具' }).click();
  await page.getByRole('menuitem', { name: /文件/ }).click();
  const rightPanel = page.locator('[data-maka-contract="session-workbar-right"]');
  await rightPanel.getByRole('tab', { name: /^文件/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移动到底部面板' }).click();

  const bottomPanel = page.locator('[data-maka-contract="session-workbar-bottom"]');
  await expect(bottomPanel.getByRole('tab', { name: /^文件/ })).toBeVisible();
  const initialBox = await bottomPanel.boundingBox();
  const resizeHandle = page.locator('.maka-workbar-resize-handle-bottom');
  const handleBox = await resizeHandle.boundingBox();
  if (!initialBox || !handleBox) throw new Error('Expected visible bottom panel resize handle');
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y - 70,
    { steps: 10 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await bottomPanel.boundingBox())?.height ?? 0)
    .toBeGreaterThan(initialBox.height + 40);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Number(localStorage.getItem('maka-session-bottom-panel-height-v1')),
      ),
    )
    .toBeGreaterThan(initialBox.height + 40);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem('maka-session-workbar-panels-v3');
        if (!raw) return [];
        return (
          JSON.parse(raw) as {
            bottom: { tabs: Array<{ kind: string }> };
          }
        ).bottom.tabs.map((tab) => tab.kind);
      }),
    )
    .toEqual(['files']);

  await page.reload();
  await page.waitForSelector(COMPOSER_INPUT);
  await expect(bottomPanel.getByRole('tab', { name: /^文件/ })).toBeVisible();
  await expect
    .poll(async () => (await bottomPanel.boundingBox())?.height ?? 0)
    .toBeGreaterThan(initialBox.height + 40);
});

test('browser page state follows its tab across panels', async ({ window: page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('dual panel browser source');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: dual panel browser source/)).toBeVisible();
  const [session] = await page.evaluate(() => window.maka.sessions.list());
  expect(session).toBeDefined();

  await page.getByRole('button', { name: '打开工作栏工具' }).click();
  await page.getByRole('menuitem', { name: /浏览器/ }).click();
  const rightPanel = page.locator('[data-maka-contract="session-workbar-right"]');
  const address = page
    .locator('.maka-session-workbar-panel[data-placement="right"]')
    .getByRole('textbox', { name: '浏览器地址' });
  await address.fill('http://127.0.0.1:5173/');
  await address.press('Enter');
  await expect
    .poll(async () => {
      const state = await page.evaluate(
        (sessionId) => window.maka.browser.getState(sessionId),
        session!.id,
      );
      return state?.url ?? '';
    })
    .toContain('127.0.0.1:5173');

  await rightPanel.getByRole('tab', { name: '浏览器' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移动到底部面板' }).click();
  const bottomPanel = page.locator('[data-maka-contract="session-workbar-bottom"]');
  await expect(
    page
      .locator('.maka-session-workbar-panel[data-placement="bottom"]')
      .getByRole('textbox', { name: '浏览器地址' }),
  ).toHaveValue(/127\.0\.0\.1:5173/);

  await bottomPanel.getByRole('tab', { name: '浏览器' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移动到右侧面板' }).click();
  await expect(
    page
      .locator('.maka-session-workbar-panel[data-placement="right"]')
      .getByRole('textbox', { name: '浏览器地址' }),
  ).toHaveValue(/127\.0\.0\.1:5173/);
});

test('quoted context reuses the right side chat before a focused bottom chat', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('focused panel quote source');
  await composer.press('Enter');
  const sourceReply = page.getByText(/Fake backend received: focused panel quote source/);
  await expect(sourceReply).toBeVisible();

  for (let index = 0; index < 2; index += 1) {
    await page.getByRole('button', { name: '打开工作栏工具' }).click();
    await page.getByRole('menuitem', { name: /侧边对话/ }).click();
  }
  const rightPanel = page.locator('[data-maka-contract="session-workbar-right"]');
  await rightPanel.getByRole('tab', { name: '侧边对话 2' }).click({
    button: 'right',
  });
  await page.getByRole('menuitem', { name: '移动到底部面板' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem('maka-session-workbar-panels-v3');
        return raw
          ? (JSON.parse(raw) as { focusedPanel?: string }).focusedPanel
          : null;
      }),
    )
    .toBe('bottom');

  await sourceReply.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    document.dispatchEvent(
      new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }),
    );
  });
  const askInSidePanel = page.getByRole('button', { name: '在侧栏追问' });
  await expect(askInSidePanel).toBeVisible();
  await askInSidePanel.click();

  const bottomTokens = page.locator(
    '.maka-session-workbar-panel[data-placement="bottom"] .maka-composer-context-drawer .astryx-token',
  );
  const rightTokens = page.locator(
    '.maka-session-workbar-panel[data-placement="right"] .maka-composer-context-drawer .astryx-token',
  );
  await expect(bottomTokens).toHaveCount(0);
  await expect(rightTokens).toHaveCount(1);
});
