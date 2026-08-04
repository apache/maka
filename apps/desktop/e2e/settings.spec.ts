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
          // Seeded DISABLED on purpose: the editor's own switch reads from the
          // preset, so this run is what proves saving an unrelated field makes
          // the round trip without quietly re-enabling a preset the user
          // turned off.
          enabled: false,
        }],
      },
    });
  });

  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  const navItem = settingsNavigation(page).getByRole('button', { name: '子 Agent', exact: true });
  await navItem.click();

  const settings = page.getByRole('main', { name: '设置内容' });
  await expect(settings.getByRole('heading', { name: '子 Agent', exact: true })).toBeVisible();
  await expect(settings.getByText('E2E 快速阅读', { exact: true })).toBeVisible();
  // The row's switch states the disabled preset; a badge beside it would be the
  // same fact twice.
  const rowSwitch = settings.getByRole('switch', { name: '启用: E2E 快速阅读' });
  await expect(rowSwitch).not.toBeChecked();
  // Arriving is not navigating: focus stays on the settings nav item the user
  // just clicked. Only a level change moves it.
  await expect(navItem).toBeFocused();

  // The editor is a route level, not a dialog: the list is replaced in place
  // and the back affordance is the only way out.
  await settings.getByRole('button', { name: '配置“E2E 快速阅读”' }).click();
  await expect(settings.getByRole('heading', { name: 'E2E 快速阅读', exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: '添加子 Agent' })).toBeHidden();
  // A level change moves focus to the level itself; without it the chevron
  // that had focus unmounts and a keyboard user restarts from document.body.
  await expect(settings.locator('[data-maka-contract="subagent-detail"]')).toBeFocused();
  // The level owns the whole preset, so it carries the two things the list row
  // deliberately does not: the settled id, and deletion.
  await expect(settings.getByText('e2e-fast-reader', { exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: '删除', exact: true })).toBeVisible();
  // Renaming is the one edit that could re-key the preset: the id derives from
  // the name while creating, and an existing preset must never follow it.
  await settings.getByRole('textbox', { name: '显示名称' }).fill('E2E 快速阅读 v2');
  await settings.getByRole('textbox', { name: '适用场景' }).fill('快速阅读代码，并总结关键调用链。');
  await settings.getByRole('button', { name: '保存', exact: true }).click();

  await expect(settings.getByRole('button', { name: '添加子 Agent' })).toBeVisible();
  await expect(settings.getByText('快速阅读代码，并总结关键调用链。', { exact: true })).toBeVisible();
  // Returning to the list puts focus back on the row the user left from.
  await expect(settings.locator('[data-subagent-preset="e2e-fast-reader"]')).toBeFocused();
  await expect.poll(async () => page.evaluate(async () => {
    const current = await window.maka.settings.get();
    const preset = current.subagents.presets[0];
    return { id: preset?.id, name: preset?.name, description: preset?.description, enabled: preset?.enabled };
  })).toEqual({
    id: 'e2e-fast-reader',
    name: 'E2E 快速阅读 v2',
    description: '快速阅读代码，并总结关键调用链。',
    enabled: false,
  });
});

test('deleting a subagent preset is reversible until the confirm is accepted', async ({ window: page }) => {
  await page.evaluate(async () => {
    const connections = await window.maka.connections.list();
    const connection = connections[0];
    if (!connection) throw new Error('E2E subagent settings requires a seeded connection');
    await window.maka.settings.update({
      subagents: {
        presets: [{
          id: 'e2e-doomed',
          name: 'E2E 待删除',
          description: '这个配置会在本次测试里被删除。',
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
  await settings.getByRole('button', { name: '配置“E2E 待删除”' }).click();
  const deleteButton = settings.getByRole('button', { name: '删除', exact: true });

  // Cancelling the confirm has to leave the preset alone — the destructive path
  // is the one place where "it did nothing" cannot be checked by eye.
  await deleteButton.click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(settings.getByText('e2e-doomed', { exact: true })).toBeVisible();

  await deleteButton.click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '删除', exact: true }).click();
  await expect(confirm).toBeHidden();

  // Deletion is the only way the row a user came from can be missing, so it is
  // the only thing that exercises the focus fallback.
  await expect(settings.getByText('E2E 待删除', { exact: true })).toBeHidden();
  await expect(settings.getByRole('button', { name: '添加子 Agent' })).toBeFocused();
  await expect.poll(async () => page.evaluate(async () => {
    const current = await window.maka.settings.get();
    return current.subagents.presets.length;
  })).toBe(0);
});

test('a subagent preset can be created disabled and then enabled from its row', async ({ window: page }) => {
  await page.evaluate(async () => {
    await window.maka.settings.update({ subagents: { presets: [] } });
  });

  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await settingsNavigation(page).getByRole('button', { name: '子 Agent', exact: true }).click();

  const settings = page.getByRole('main', { name: '设置内容' });
  // The create branch is a structurally different tree from the edit branch —
  // a typed id instead of a settled one, and no delete section — so it needs
  // its own journey rather than riding on the edit one.
  await settings.getByRole('button', { name: '添加子 Agent' }).click();
  await settings.getByRole('textbox', { name: '显示名称' }).fill('E2E Web Research');
  // The id derives from the name until the user takes it over.
  await expect(settings.getByRole('textbox', { name: 'subagent_id' })).toHaveValue('e2e-web-research');
  // Taking the id over stops the derivation for good: a later name edit must
  // not walk over what the user typed.
  await settings.getByRole('textbox', { name: 'subagent_id' }).fill('web-research-owned');
  await settings.getByRole('textbox', { name: '显示名称' }).fill('E2E Web Research 2');
  await expect(settings.getByRole('textbox', { name: 'subagent_id' })).toHaveValue('web-research-owned');
  await settings.getByRole('textbox', { name: '适用场景' }).fill('查找外部资料。');
  await settings.getByRole('switch', { name: '启用', exact: true }).click();
  await settings.getByRole('button', { name: '创建', exact: true }).click();

  await expect(settings.getByText('E2E Web Research 2', { exact: true })).toBeVisible();
  await expect.poll(async () => page.evaluate(async () => {
    const current = await window.maka.settings.get();
    const preset = current.subagents.presets[0];
    return { id: preset?.id, enabled: preset?.enabled };
  })).toEqual({ id: 'web-research-owned', enabled: false });

  await settings.getByRole('switch', { name: '启用: E2E Web Research 2' }).click();
  await expect.poll(async () => page.evaluate(async () => {
    const current = await window.maka.settings.get();
    return current.subagents.presets[0]?.enabled;
  })).toBe(true);
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
