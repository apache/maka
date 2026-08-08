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
  await expect(sidebar.getByRole('radiogroup', { name: '会话分组方式' })).toBeVisible();
  await expect(sidebar.locator('.maka-session-list')).toBeVisible();

  const extensionSelector = page.locator('.maka-module-hub-selector');
  await expect(extensionSelector).toHaveAccessibleName('扩展内容：技能');
  await extensionSelector.getByRole('button', { name: 'MCP' }).click();
  const mcp = page.getByRole('main', { name: '扩展' });
  await expect(mcp.getByRole('heading', { name: '扩展' })).toBeVisible();
  await expect(mcp.getByRole('toolbar', { name: 'MCP 浏览操作' })).toBeVisible();
  await expect(extensionSelector).toHaveAccessibleName('扩展内容：MCP');
  await expect(mcp.getByText('把 Maka 连接到你的工作环境')).toBeVisible();
  await expect(mcp.locator('[data-maka-contract="module-actions"]').getByRole('button')).toHaveCount(2);
  await expect(mcp.getByRole('button', { name: '刷新', exact: true })).toBeVisible();

  // Each hub restores its last module when the user returns from another
  // sidebar destination.
  await sidebar.getByRole('button', { name: '定时任务', exact: true }).click();
  await extensions.click();
  await expect(page.getByRole('main', { name: '扩展' })).toBeVisible();
  await expect(extensionSelector).toHaveAccessibleName('扩展内容：MCP');

  await mcp.getByRole('button', { name: '添加 MCP' }).click();
  const editor = page.getByRole('dialog', { name: '添加 MCP' });
  await expect(editor.getByLabel('服务器 ID')).toBeFocused();
  await expect(editor.locator('label').filter({ hasText: '服务器 ID' })).toBeVisible();
  await expect(editor.locator('label').filter({ hasText: '命令' })).toBeVisible();
  await expect(editor.locator('label').filter({ hasText: '参数' })).toBeVisible();
  await expect(editor.locator('label').filter({ hasText: '工作目录' })).toBeVisible();
  await expect(editor.locator('label').filter({ hasText: '环境变量' })).toBeVisible();
  const environmentBox = await editor.getByLabel('环境变量').boundingBox();
  const workingDirectoryBox = await editor.getByLabel('工作目录').boundingBox();
  expect(environmentBox).not.toBeNull();
  expect(workingDirectoryBox).not.toBeNull();
  expect(environmentBox!.y).toBeLessThan(workingDirectoryBox!.y);
  await expect(editor.getByText('高级设置', { exact: true })).toHaveCount(0);
  await editor.getByRole('button', { name: '保存并连接' }).click();
  await expect(editor.getByLabel('服务器 ID')).toHaveAttribute('aria-invalid', 'true');
  await expect(editor.getByLabel('命令')).toHaveAttribute('aria-invalid', 'true');
  await editor.getByLabel('服务器 ID').fill('e2e-fixture');
  await expect(editor.getByLabel('命令')).toHaveAttribute('aria-invalid', 'true');
  await editor.getByRole('radio', { name: '远程 URL' }).click();
  await expect(editor.locator('label').filter({ hasText: '传输协议' })).toBeVisible();
  await expect(editor.locator('label').filter({ hasText: 'HTTP 请求头' })).toBeVisible();
  await expect(editor.getByText('高级设置', { exact: true })).toHaveCount(0);
  await editor.getByRole('radio', { name: '本地 stdio' }).click();
  await editor.getByLabel('命令').fill(process.execPath);
  await editor.getByLabel('参数').fill(fixtureServer);
  await editor.getByRole('button', { name: '保存并连接' }).click();

  // Saving lands on 已安装; the row shows the server and its live tool count.
  const fixtureRow = mcp.getByRole('button', { name: /e2e-fixture/ });
  await expect(fixtureRow).toBeVisible();
  await expect(mcp.getByText('把 Maka 连接到你的工作环境')).toHaveCount(0);
  await expect(mcp.getByText(/^本地 stdio ·/)).toBeVisible();
  await expect(mcp.getByText(/4 个工具/)).toBeVisible();

  const config = await page.evaluate(() => window.maka.mcp.getConfig());
  expect(config.mcpServers['e2e-fixture']).toMatchObject({
    enabled: true,
    command: process.execPath,
    args: [fixtureServer],
  });

  // Selecting the row opens the inspector: discovered tools, edit, enable
  // switch and delete all live there now.
  await fixtureRow.click();
  const inspector = mcp.getByRole('complementary', { name: '服务器详情' });
  await expect(inspector.getByText('echo', { exact: true })).toBeVisible();
  await expect(inspector.getByText('rich', { exact: true })).toBeVisible();

  const edit = inspector.getByRole('button', { name: '编辑', exact: true });
  await edit.click();
  const editDialog = page.getByRole('dialog', { name: '编辑 e2e-fixture' });
  await expect(editDialog.getByLabel('服务器 ID')).toBeDisabled();
  await expect(editDialog.getByLabel('命令')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(editDialog).toBeHidden();
  await expect(edit).toBeFocused();

  await inspector.getByRole('switch', { name: '启用' }).click();
  await expect.poll(async () => {
    const next = await page.evaluate(() => window.maka.mcp.getConfig());
    return next.mcpServers['e2e-fixture']?.enabled;
  }).toBe(false);
  await expect(inspector.getByRole('switch', { name: '启用' })).not.toBeChecked();

  // Import a second server BEFORE the delete: with one row left behind, the
  // delete below can prove where focus goes — the contract the empty-list
  // path cannot exercise.
  await mcp.getByRole('button', { name: '添加 MCP' }).click();
  await page.getByRole('dialog', { name: '添加 MCP' }).getByRole('radio', { name: '粘贴 JSON' }).click();
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

  // The import's view switch dropped the selection (it belongs to the view
  // it was made in), so reopen the inspector before deleting.
  await mcp.getByRole('button', { name: /e2e-fixture/ }).click();
  await inspector.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect.poll(async () => {
    const next = await page.evaluate(() => window.maka.mcp.getConfig());
    return next.mcpServers['e2e-fixture'];
  }).toBeUndefined();
  // Focus lands on the row that took the deleted one's place — not on body,
  // which would drop a keyboard user at the top of the document.
  await expect(mcp.getByRole('button', { name: /remote-disabled/ })).toBeFocused();
});
