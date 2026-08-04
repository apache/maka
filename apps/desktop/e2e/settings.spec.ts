import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

function settingsNavigation(page: Page) {
  return page.getByRole('navigation', { name: /^(设置分组|Settings sections)$/ });
}

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
  const lightTheme = page.getByRole('checkbox', { name: '浅色' });
  const darkTheme = page.getByRole('checkbox', { name: '深色' });
  await darkTheme.locator('..').click();
  await expect(darkTheme).toBeChecked();
  await expect(lightTheme).not.toBeChecked();

  await expect.poll(
    async () => page.evaluate(() => document.documentElement.classList.contains('dark')),
  ).toBe(true);
});

test('subagent presets can be reviewed and edited in desktop settings', async ({ window: page }) => {
  await page.evaluate(async () => {
    const connections = await window.maka.connections.list();
    const connection = connections[0];
    if (!connection) throw new Error('E2E subagent settings requires a seeded connection');
    await window.maka.settings.update({
      subagents: {
        presets: [{
          id: 'e2e-fast-reader',
          name: 'E2E 快速阅读',
          description: '快速阅读大型代码仓库。',
          profile: 'local_read',
          connectionSlug: connection.slug,
          model: connection.enabledModelIds?.[0] ?? connection.defaultModel,
          enabled: true,
        }],
      },
    });
  });

  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await settingsNavigation(page).getByRole('button', { name: '子 Agent', exact: true }).click();

  const settings = page.getByRole('main', { name: '设置内容' });
  await expect(settings.getByRole('heading', { name: '子 Agent', exact: true })).toBeVisible();
  await expect(settings.getByText('E2E 快速阅读', { exact: true })).toBeVisible();
  await expect(settings.getByText('可用', { exact: true })).toBeVisible();

  await settings.getByRole('button', { name: '编辑', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑子 Agent' });
  const description = dialog.getByRole('textbox', { name: '适用场景' });
  await description.fill('快速阅读代码，并总结关键调用链。');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(settings.getByText('快速阅读代码，并总结关键调用链。', { exact: true })).toBeVisible();
  await expect.poll(async () => page.evaluate(async () => {
    const current = await window.maka.settings.get();
    return current.subagents.presets[0]?.description;
  })).toBe('快速阅读代码，并总结关键调用链。');
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
