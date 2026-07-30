import path from 'node:path';
import { test, expect } from './fixtures.js';

const fixtureServer = path.resolve(
  process.cwd(),
  '../../packages/mcp/dist/__fixtures__/stdio-server.js',
);

test('MCP module completes stdio add, discovery, disable, JSON import, and delete', async ({ window: page }) => {
  const screenshotPath = process.env.MAKA_MCP_E2E_SCREENSHOT;
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  const sidebar = page.getByRole('complementary', { name: '对话列表' });
  const extensions = sidebar.getByRole('button', { name: '扩展', exact: true });
  await expect(sidebar.getByRole('button', { name: '技能', exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: 'MCP', exact: true })).toHaveCount(0);
  await extensions.click();
  await expect(extensions).toHaveAttribute('aria-current', 'page');
  await expect(sidebar.getByRole('button', { name: '会话分组方式' })).toBeVisible();
  await expect(sidebar.locator('.maka-session-list')).toBeVisible();

  const extensionSelector = page.locator('.maka-module-hub-selector-trigger');
  await expect(extensionSelector).toHaveAccessibleName('扩展内容：技能');
  await extensionSelector.click();
  await page.getByRole('menuitemradio', { name: 'MCP' }).click();
  const mcp = page.getByRole('main', { name: '扩展' });
  await expect(mcp.getByRole('heading', { name: '扩展' })).toBeVisible();
  await expect(extensionSelector).toHaveAccessibleName('扩展内容：MCP');

  // Each hub restores its last module when the user returns from another
  // sidebar destination.
  await sidebar.getByRole('button', { name: '定时任务', exact: true }).click();
  await extensions.click();
  await expect(page.getByRole('main', { name: '扩展' })).toBeVisible();
  await expect(extensionSelector).toHaveAccessibleName('扩展内容：MCP');
  if (screenshotPath) {
    await page.screenshot({ path: variantPath(screenshotPath, 'market') });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('main', { name: '设置内容' });
    await settings.getByRole('button', { name: '外观', exact: true }).click();
    await settings.getByRole('radio', { name: '深色 始终使用深色界面。' }).click();
    await settings.getByRole('button', { name: '返回应用' }).click();
    await page.screenshot({ path: variantPath(screenshotPath, 'dark-market') });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await settings.getByRole('button', { name: '外观', exact: true }).click();
    await settings.getByRole('radio', { name: '浅色 始终使用浅色界面。' }).click();
    await settings.getByRole('button', { name: '返回应用' }).click();
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    await page.setViewportSize({ width: 760, height: 700 });
    await page.screenshot({ path: variantPath(screenshotPath, 'narrow-market') });
    await page.setViewportSize(viewport);
  }

  const dingtalkCard = mcp.getByRole('article').filter({ hasText: '钉钉' });
  const installDingtalk = dingtalkCard.getByRole('button', { name: '安装 钉钉' });
  await installDingtalk.click();
  const cancelDingtalk = dingtalkCard.getByRole('button', { name: '取消安装 钉钉' });
  await expect(cancelDingtalk).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(cancelDingtalk.locator('.maka-mcp-install-spinner')).toHaveCSS('opacity', '1');
  if (screenshotPath) await page.screenshot({ path: variantPath(screenshotPath, 'installing') });
  await cancelDingtalk.hover();
  await expect(cancelDingtalk.locator('.maka-mcp-install-cancel')).toHaveCSS('opacity', '1');
  if (screenshotPath) await page.screenshot({ path: variantPath(screenshotPath, 'install-cancel-hover') });
  await cancelDingtalk.click();
  await expect(dingtalkCard.getByRole('button', { name: '安装 钉钉' })).toBeVisible();
  await expect.poll(async () => {
    const next = await page.evaluate(() => window.maka.mcp.getConfig());
    return next.mcpServers.dingtalk;
  }).toBeUndefined();

  await mcp.getByRole('button', { name: '添加 MCP' }).click();
  const editor = page.getByRole('dialog', { name: '添加 MCP' });
  if (screenshotPath) await page.screenshot({ path: variantPath(screenshotPath, 'manual') });
  await editor.getByLabel('Server ID').fill('e2e-fixture');
  await editor.getByLabel('Command').fill(process.execPath);
  await editor.getByLabel('Arguments').fill(fixtureServer);
  await editor.getByRole('button', { name: '保存并连接' }).click();

  await expect(mcp.getByText('e2e-fixture', { exact: true })).toBeVisible();
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

  if (screenshotPath) await page.screenshot({ path: screenshotPath });

  await mcp.getByLabel('e2e-fixture 启用状态').click();
  await expect(mcp.getByText('已停用', { exact: true })).toBeVisible();
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
  if (screenshotPath) await page.screenshot({ path: variantPath(screenshotPath, 'json') });
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

function variantPath(source: string, name: string): string {
  const parsed = path.parse(source);
  return path.join(parsed.dir, `${parsed.name}-${name}${parsed.ext || '.png'}`);
}
