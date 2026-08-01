import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

function settingsNavigation(page: Page) {
  return page.getByRole('navigation', { name: /^(设置分组|Settings sections)$/ });
}

/**
 * #1361 — one live window-floor smoke. CSS contracts pin the load-bearing
 * declarations; this still measures the user-visible synthesis (row body
 * floor + page horizontal containment) at SAFE_MIN_WIDTH.
 */
test('permission rows keep their text at the window floor', async ({ permissionSettingsWindow: page }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  const settings = page.getByRole('main', { name: '设置内容' });
  await expect(settings.getByRole('heading', { name: '系统权限' })).toBeVisible();

  // Prove the fixture renders the three-button guided row before measuring —
  // that shape is what used to squeeze the body to 0px.
  const rows = settings.locator('.settingsOsPermissionRow');
  await expect(rows).toHaveCount(5);
  const guidedRows = rows.filter({
    has: page.getByRole('button', { name: '引导授权', exact: true }),
  });
  await expect(guidedRows).toHaveCount(1);
  await expect(guidedRows.getByRole('button')).toHaveCount(3);

  await expect.poll(
    () =>
      rows.evaluateAll((elements) =>
        elements.every((element) => {
          const body = element.querySelector('.settingsOsPermissionBody');
          if (!body) return false;
          return (
            body.getBoundingClientRect().width >= 101 && body.scrollWidth <= body.clientWidth
          );
        }),
      ),
  ).toBe(true);

  await expect.poll(
    () => settings.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});

/**
 * Settings take effect: open settings, switch the theme to dark, and confirm
 * the <html> root picks up the `dark` class (theme.ts applies it via
 * classList.toggle). This exercises the settings open → navigate → mutate →
 * apply path without depending on pixel colors.
 */
test('changing the theme in settings applies to the UI', async ({ window: page }) => {
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

test('settings textareas persist edits across section re-entry', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await settingsNavigation(page).getByRole('button', { name: '通用', exact: true }).click();

  const textarea = page.getByRole('textbox', { name: '助手语气偏好' });
  await expect(textarea).toBeVisible();
  const edited = Array.from({ length: 7 }, (_, index) => `偏好 ${index + 1}`).join('\n');
  await textarea.fill(edited);
  await expect(textarea).toHaveValue(edited);

  await settingsNavigation(page).getByRole('button', { name: '记忆', exact: true }).click();
  await expect(page.locator('label').filter({ hasText: '记忆标题' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '记忆内容' })).toBeVisible();

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

  await settings.getByRole('button', { name: /接入 Telegram/ }).click();
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

  await backButton.click();
  await expect(settings.getByRole('heading', { name: '接入更多渠道' })).toBeVisible();
});

test('remote access prioritizes a configured channel that needs attention', async ({ window: page }) => {
  const runtimeError = 'runtime-diagnostic-'.repeat(10);
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

  await activeChannels.nth(0).click();
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

  const recentFailure = settings.getByRole('alert').filter({ hasText: '最近一次失败' });
  await expect(recentFailure).toContainText(runtimeError);
});
