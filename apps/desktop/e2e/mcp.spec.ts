import path from 'node:path';
import { test, expect } from './fixtures.js';

const fixtureServer = path.resolve(
  process.cwd(),
  '../../packages/mcp/dist/__fixtures__/stdio-server.js',
);

test('MCP module completes stdio add, discovery, disable, JSON import, and delete', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  const sidebar = page.getByRole('navigation', { name: '对话列表' });
  const extensions = sidebar.getByRole('button', { name: '扩展', exact: true });
  await expect(sidebar.getByRole('button', { name: '技能', exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: 'MCP', exact: true })).toHaveCount(0);
  await extensions.click();
  await expect(extensions).toHaveAttribute('aria-current', 'page');
  await expect(sidebar.getByRole('button', { name: '会话分组方式' })).toBeVisible();
  await expect(sidebar.locator('.maka-session-list')).toBeVisible();

  const extensionSelector = page.locator('.maka-module-hub-selector');
  await expect(extensionSelector).toHaveAccessibleName('扩展内容：技能');
  await extensionSelector.getByRole('button', { name: 'MCP' }).click();
  const mcp = page.getByRole('main', { name: '扩展' });
  await expect(mcp.getByRole('heading', { name: '扩展' })).toBeVisible();
  await expect(extensionSelector).toHaveAccessibleName('扩展内容：MCP');

  // Each hub restores its last module when the user returns from another
  // sidebar destination.
  await sidebar.getByRole('button', { name: '定时任务', exact: true }).click();
  await extensions.click();
  await expect(page.getByRole('main', { name: '扩展' })).toBeVisible();
  await expect(extensionSelector).toHaveAccessibleName('扩展内容：MCP');

  const dingtalkCard = mcp.getByRole('article').filter({ hasText: '钉钉' });
  const installDingtalk = dingtalkCard.getByRole('button', { name: '安装 钉钉' });
  await installDingtalk.click();
  const cancelDingtalk = dingtalkCard.getByRole('button', { name: '取消安装 钉钉' });
  await expect(cancelDingtalk).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(cancelDingtalk.locator('.maka-mcp-install-spinner')).toHaveCSS('opacity', '1');
  await cancelDingtalk.hover();
  await expect(cancelDingtalk.locator('.maka-mcp-install-cancel')).toHaveCSS('opacity', '1');
  await cancelDingtalk.click();
  await expect(dingtalkCard.getByRole('button', { name: '安装 钉钉' })).toBeVisible();
  await expect.poll(async () => {
    const next = await page.evaluate(() => window.maka.mcp.getConfig());
    return next.mcpServers.dingtalk;
  }).toBeUndefined();

  await mcp.getByRole('button', { name: '添加 MCP' }).click();
  const editor = page.getByRole('dialog', { name: '添加 MCP' });
  await expect(editor.getByLabel('服务器 ID')).toBeFocused();
  await expect(editor.locator('label').filter({ hasText: '服务器 ID' })).toBeVisible();
  await expect(editor.locator('label').filter({ hasText: '命令' })).toBeVisible();
  await expect(editor.locator('label').filter({ hasText: '参数' })).toBeVisible();
  await editor.getByRole('button', { name: '保存并连接' }).click();
  await expect(editor.getByLabel('服务器 ID')).toHaveAttribute('aria-invalid', 'true');
  await expect(editor.getByLabel('命令')).toHaveAttribute('aria-invalid', 'true');
  await editor.getByLabel('服务器 ID').fill('e2e-fixture');
  await expect(editor.getByLabel('命令')).toHaveAttribute('aria-invalid', 'true');
  await editor.getByRole('radio', { name: '远程 URL' }).click();
  await editor.getByText('高级设置', { exact: true }).click();
  await expect(editor.locator('label').filter({ hasText: '传输协议' })).toBeVisible();
  await editor.getByRole('radio', { name: '本地 stdio' }).click();
  await editor.getByLabel('命令').fill(process.execPath);
  await editor.getByLabel('参数').fill(fixtureServer);
  await editor.getByRole('button', { name: '保存并连接' }).click();

  await expect(mcp.getByText('e2e-fixture', { exact: true })).toBeVisible();
  await expect(mcp.getByText(/^本地 stdio ·/)).toBeVisible();
  await expect(mcp.getByText('4 个工具', { exact: true }).first()).toBeVisible();
  await mcp.getByText('4 个工具', { exact: true }).last().click();
  await expect(mcp.getByText('echo', { exact: true })).toBeVisible();
  await expect(mcp.getByText('rich', { exact: true })).toBeVisible();

  const config = await page.evaluate(() => window.maka.mcp.getConfig());
  expect(config.mcpServers['e2e-fixture']).toMatchObject({
    enabled: true,
    command: process.execPath,
    args: [fixtureServer],
  });

  const edit = mcp.getByRole('button', { name: '编辑 e2e-fixture' });
  await edit.click();
  const editDialog = page.getByRole('dialog', { name: '编辑 e2e-fixture' });
  await expect(editDialog.getByLabel('服务器 ID')).toBeDisabled();
  await expect(editDialog.getByLabel('命令')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(editDialog).toBeHidden();
  await expect(edit).toBeFocused();

  await mcp.getByLabel('e2e-fixture 启用状态').click();
  await expect(mcp.getByText(/已停用 · 本地 stdio/)).toBeVisible();
  await expect.poll(async () => {
    const next = await page.evaluate(() => window.maka.mcp.getConfig());
    return next.mcpServers['e2e-fixture']?.enabled;
  }).toBe(false);

  await mcp.getByRole('button', { name: '删除 e2e-fixture' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect(mcp.getByText('还没有安装 MCP')).toBeVisible();
  await expect.poll(async () => {
    const next = await page.evaluate(() => window.maka.mcp.getConfig());
    return next.mcpServers['e2e-fixture'];
  }).toBeUndefined();

  await mcp.getByRole('button', { name: 'JSON 导入' }).click();
  const jsonEditor = page.getByRole('dialog', { name: '通过 JSON 导入' });
  await jsonEditor.getByLabel('JSON 配置').fill(JSON.stringify({
    mcpServers: {
      'remote-disabled': { url: 'https://example.com/mcp', enabled: false },
    },
  }));
  await jsonEditor.getByRole('button', { name: '导入并连接' }).click();
  await expect(mcp.getByText('remote-disabled', { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const next = await page.evaluate(() => window.maka.mcp.getConfig());
    return next.mcpServers['remote-disabled'];
  }).toMatchObject({ url: 'https://example.com/mcp', enabled: false });
});
