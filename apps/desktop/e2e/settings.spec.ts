import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

function settingsNavigation(page: Page) {
  return page.getByRole('navigation', { name: /^(设置分组|Settings sections)$/ });
}

test('general default-model options keep provider marks inside the Selector slot', async ({
  window: page,
}) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  const settings = page.getByRole('main', { name: '设置内容' });
  await settingsNavigation(page).getByRole('button', { name: '通用', exact: true }).click();

  await settings.getByRole('button', { name: '默认模型' }).click();
  const mark = page.getByRole('listbox').locator('.modelPickerProviderMark').first();
  await expect(mark).toBeVisible();
  await expect
    .poll(() =>
      mark.evaluate((element) => {
        const markRect = element.getBoundingClientRect();
        const asset = element.firstElementChild;
        const option = element.closest('[role="option"]');
        const label = option?.querySelector('.modelPickerOptionLabel');
        if (!asset || !label) return null;
        const assetRect = asset.getBoundingClientRect();
        const labelRect = label.getBoundingClientRect();
        return {
          usesSettingsPlate: element.querySelector('.providerLogo') !== null,
          square: markRect.width === markRect.height && assetRect.width === assetRect.height,
          contained:
            assetRect.width <= markRect.width &&
            assetRect.height <= markRect.height &&
            markRect.width <= 16 &&
            markRect.height <= 16,
          aligned:
            Math.abs(
              markRect.top + markRect.height / 2 -
                (labelRect.top + labelRect.height / 2),
            ) <= 1,
        };
      }),
    )
    .toEqual({ usesSettingsPlate: false, square: true, contained: true, aligned: true });
});

/**
 * Settings take effect: open settings, switch the theme to dark, and confirm
 * the <html> root picks up the `dark` class (theme.ts applies it via
 * classList.toggle). This exercises the settings open → navigate → mutate →
 * apply path without depending on pixel colors.
 */
test('changing the theme in settings applies to the UI', async ({ window: page }) => {
  // The sidebar starts collapsed on a fresh workspace; expand it to reach
  // the settings entry in the sidebar footer.
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByLabel('设置内容')).toBeVisible();

  await settingsNavigation(page).getByRole('button', { name: '外观', exact: true }).click();
  const themeGroup = page.getByRole('radiogroup', { name: '主题' });
  const lightTheme = themeGroup.getByRole('radio', { name: '浅色' });
  const darkTheme = themeGroup.getByRole('radio', { name: '深色' });
  await lightTheme.focus();
  await lightTheme.press('ArrowDown');
  await expect(darkTheme).toBeChecked();

  await expect.poll(
    async () => page.evaluate(() => document.documentElement.classList.contains('dark')),
  ).toBe(true);
});

test('settings textareas use Astryx native resizing and persist edits across section re-entry', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await settingsNavigation(page).getByRole('button', { name: '通用', exact: true }).click();

  const textarea = page.getByRole('textbox', { name: '助手语气偏好' });
  await expect(textarea).toBeVisible();
  await expect(textarea).toHaveCSS('resize', 'vertical');
  const edited = Array.from({ length: 7 }, (_, index) => `偏好 ${index + 1}`).join('\n');
  await textarea.fill(edited);
  await expect(textarea).toHaveValue(edited);

  await settingsNavigation(page).getByRole('button', { name: '记忆', exact: true }).click();
  await expect(page.locator('label').filter({ hasText: '记忆标题' })).toBeVisible();
  await expect(page.locator('label').filter({ hasText: '记忆标签' })).toBeVisible();
  await expect(page.locator('label').filter({ hasText: '记忆内容' })).toBeVisible();
  await expect(page.locator('label').filter({ hasText: 'MEMORY.md 内容' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '记忆内容' })).toHaveCSS('resize', 'vertical');
  await expect(page.getByRole('textbox', { name: 'MEMORY.md 内容' })).toHaveCSS('resize', 'vertical');

  await settingsNavigation(page).getByRole('button', { name: '数据', exact: true }).click();
  await expect(page.locator('label').filter({ hasText: '导入时同名连接的处理方式' })).toBeVisible();

  await settingsNavigation(page).getByRole('button', { name: '通用', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '助手语气偏好' })).toHaveValue(edited);
});

test('voice settings expose Astryx-owned fields and persist a draft on blur', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  const settings = page.getByRole('main', { name: '设置内容' });
  await settingsNavigation(page).getByRole('button', { name: '语音', exact: true }).click();

  await expect(settings.getByRole('combobox', { name: '模型连接' })).toHaveCount(2);
  await expect(settings.getByRole('textbox', { name: '模型 ID' })).toHaveCount(2);
  const language = settings.getByRole('textbox', { name: '语言（可选）' });
  await expect(language).toBeVisible();
  await expect(settings.getByRole('textbox', { name: '识别提示词（可选）' })).toBeVisible();

  await language.fill('en');
  await language.press('Tab');
  await settingsNavigation(page).getByRole('button', { name: '通用', exact: true }).click();
  await settingsNavigation(page).getByRole('button', { name: '语音', exact: true }).click();
  await expect(settings.getByRole('textbox', { name: '语言（可选）' })).toHaveValue('en');
});

test('remote access opens a channel detail from the overview and returns', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();

  const settings = page.getByRole('main', { name: '设置内容' });
  await settingsNavigation(page).getByRole('button', { name: '远程接入' }).click();

  await expect(settings.getByRole('heading', { name: '远程接入' })).toBeVisible();
  await expect(settings.getByRole('heading', { name: '接入更多渠道' })).toBeVisible();

  const telegramRow = settings.getByRole('button', { name: /接入 Telegram/ });
  await expect.poll(
    () => telegramRow.evaluate((element) => getComputedStyle(element).boxShadow),
  ).toBe('none');

  await telegramRow.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect.poll(
    () => telegramRow.evaluate((element) => getComputedStyle(element).boxShadow),
  ).not.toBe('none');

  await telegramRow.click();
  await expect(settings.getByRole('heading', { name: /Telegram/ })).toBeVisible();
  const backButton = settings.getByRole('button', { name: '返回远程接入' });
  await expect(backButton).toBeVisible();
  await expect(settings.getByRole('heading', { name: '连接配置' })).toBeVisible();
  const tokenInput = settings.getByRole('textbox', { name: /Telegram Bot Token/ });
  await expect(tokenInput).toBeVisible();

  const detailHeadings = await settings.getByRole('heading').allTextContents();
  expect(detailHeadings.indexOf('待配置')).toBeLessThan(detailHeadings.indexOf('连接配置'));

  const disabledSwitch = settings.getByRole('switch', { name: '启用Telegram渠道' });
  const configDocs = settings.getByRole('link', { name: '查看配置文档' });
  const connectButton = settings.getByRole('button', { name: '测试并连接' });
  await expect(disabledSwitch).toBeDisabled();
  await expect(disabledSwitch).toHaveAccessibleDescription('先测试并连接后才能启用。');
  await backButton.focus();
  await page.keyboard.press('Tab');
  await expect(disabledSwitch).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(configDocs).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(connectButton).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(tokenInput).toBeFocused();

  const identityValue = settings.getByLabel('Telegram运行状态').locator('dd').first();
  await expect(identityValue).toHaveCSS('white-space', 'normal');
  await expect(identityValue).toHaveCSS('overflow-wrap', 'anywhere');

  await backButton.click();
  await expect(settings.getByRole('heading', { name: '接入更多渠道' })).toBeVisible();
});

test('remote access prioritizes a configured channel that needs attention', async ({ window: page }) => {
  const runtimeError = 'runtime-diagnostic-'.repeat(10);
  await page.setViewportSize({ width: 480, height: 820 });
  await page.evaluate(async (lastError) => {
    await window.maka.settings.update({
      botChat: {
        channels: {
          telegram: {
            connected: true,
            readiness: 'operational',
            token: 'e2e-telegram-placeholder',
          },
          discord: {
            connected: true,
            readiness: 'degraded',
            token: 'e2e-discord-placeholder',
            lastError,
          },
        },
      },
    });
  }, runtimeError);
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  const settings = page.getByRole('main', { name: '设置内容' });
  await settingsNavigation(page).getByRole('button', { name: '远程接入' }).click();

  const activeChannels = page.getByRole('region', { name: '正在使用' }).getByRole('button');
  await expect(activeChannels).toHaveCount(2);
  await expect(activeChannels.nth(0)).toHaveAccessibleName(/管理 Discord/);
  await expect(activeChannels.nth(0)).toHaveAccessibleName(new RegExp(runtimeError));
  await expect(settings.getByText(runtimeError, { exact: true })).toBeVisible();
  await expect(activeChannels.nth(1)).toHaveAccessibleName(/管理 Telegram/);

  const overview = settings.locator('.settingsRemoteAccessOverview');
  const attentionRow = settings.locator('.settingsRemoteAccessChannelRow').first();
  const catalogRows = settings.locator('.settingsRemoteAccessCatalogRow');
  await expect(attentionRow.locator('.settingsRemoteAccessItemTitle')).toHaveCSS('flex-wrap', 'wrap');
  await expect(attentionRow.locator('.settingsRemoteAccessItemDescription')).toHaveCSS('overflow-wrap', 'anywhere');
  await expect(attentionRow.locator('.settingsRemoteAccessItemActions')).toHaveCSS('display', 'none');
  await expect(catalogRows.first()).toBeVisible();
  await expect(catalogRows.first().locator('.settingsRemoteAccessItemActions')).toHaveCSS('display', 'none');
  await expect(settings.locator('.settingsRemoteAccessSectionHeader').first()).toHaveCSS('flex-direction', 'column');
  await expect.poll(
    () =>
      overview.evaluate((element) => ({
        overviewContained: element.scrollWidth <= element.clientWidth,
        rowsContained: Array.from(element.querySelectorAll('.settingsRemoteAccessChannelRow'))
          .every((row) => row.scrollWidth <= row.clientWidth),
        catalogRowsContained: Array.from(element.querySelectorAll('.settingsRemoteAccessCatalogRow'))
          .every((row) => row.scrollWidth <= row.clientWidth),
      })),
  ).toEqual({ overviewContained: true, rowsContained: true, catalogRowsContained: true });

  await activeChannels.nth(0).click();
  const detailHeader = settings.locator('.settingsBotDetailHeader');
  const detailHeaderBody = settings.locator('.settingsBotDetailHeaderBody');
  const runtimeStatus = settings.locator('.settingsBotStatusGrid');
  const enabledSwitch = settings.getByRole('switch', { name: '启用Discord渠道' });
  const configDocs = settings.getByRole('link', { name: '查看配置文档' });
  const connectButton = settings.getByRole('button', { name: '测试并连接' });
  await expect(enabledSwitch).toBeEnabled();
  await settings.getByRole('button', { name: '返回远程接入' }).focus();
  await page.keyboard.press('Tab');
  await expect(enabledSwitch).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(configDocs).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(connectButton).toBeFocused();
  await expect(detailHeaderBody).toHaveCSS('grid-column-start', '1');
  await expect(detailHeaderBody).toHaveCSS('grid-column-end', '-1');
  await expect.poll(
    () =>
      detailHeader.evaluate((element) => ({
        contained: element.scrollWidth <= element.clientWidth,
        bodyUsesFullRow: (() => {
          const body = element.querySelector<HTMLElement>('.settingsBotDetailHeaderBody');
          if (!body) return false;
          const headerStyle = getComputedStyle(element);
          const expectedWidth = element.clientWidth
            - Number.parseFloat(headerStyle.paddingLeft)
            - Number.parseFloat(headerStyle.paddingRight);
          return body.getBoundingClientRect().width >= expectedWidth - 1;
        })(),
        switchPrecedesDocs: (() => {
          const toggle = element.querySelector<HTMLElement>('.settingsBotDetailSwitch');
          const docs = element.querySelector<HTMLElement>('.settingsBotConfigDocLink');
          return toggle && docs
            ? Boolean(toggle.compareDocumentPosition(docs) & Node.DOCUMENT_POSITION_FOLLOWING)
            : false;
        })(),
        headingPrecedesSwitch: (() => {
          const heading = element.querySelector<HTMLElement>('h3');
          const toggle = element.querySelector<HTMLElement>('.settingsBotDetailSwitch');
          return heading && toggle
            ? Boolean(heading.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING)
            : false;
        })(),
      })),
  ).toEqual({
    contained: true,
    bodyUsesFullRow: true,
    switchPrecedesDocs: true,
    headingPrecedesSwitch: true,
  });
  await expect.poll(
    () =>
      runtimeStatus.evaluate((element) => {
        const columns = getComputedStyle(element).gridTemplateColumns.trim();
        return {
          defined: columns !== 'none',
          count: columns.split(/\s+/).length,
        };
      }),
  ).toEqual({ defined: true, count: 1 });

  const recentFailure = settings.getByRole('alert').filter({ hasText: '最近一次失败' });
  await expect(recentFailure).toContainText(runtimeError);
  await expect(recentFailure.getByText(runtimeError)).toHaveCSS('overflow-wrap', 'anywhere');
  await expect.poll(
    () => settings.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});
