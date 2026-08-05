import path from 'node:path';
import { test, expect } from './fixtures.js';

const fixtureServer = path.resolve(
  process.cwd(),
  '../../packages/mcp/dist/__fixtures__/stdio-server.js',
);

test('module navigation removes the hidden chat surface from layout and hit testing', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('navigation', { name: '对话列表' }).getByRole('button', { name: '扩展', exact: true }).click();
  await expect(page.getByRole('main', { name: '扩展' })).toBeVisible();

  const hiddenChat = page.locator('.maka-chat-layout[hidden]');
  await expect(hiddenChat).toHaveCount(1);
  await expect(hiddenChat).toHaveCSS('display', 'none');
  expect(await hiddenChat.boundingBox()).toBeNull();
  expect(
    await page.evaluate(() => {
      const target = document.elementFromPoint(window.innerWidth * 0.75, window.innerHeight - 100);
      return Boolean(target?.closest('.maka-chat-layout'));
    }),
  ).toBe(false);
});

test('MCP module page keeps one centred column without horizontal overflow', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('navigation', { name: '对话列表' }).getByRole('button', { name: '扩展', exact: true }).click();
  await page.locator('.maka-module-hub-selector').getByRole('button', { name: 'MCP' }).click();
  await expect(page.getByRole('toolbar', { name: 'MCP 浏览操作' })).toBeVisible();

  for (const width of [1440, 1280, 861, 860, 761]) {
    await page.setViewportSize({ width, height: 700 });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);

    const geometry = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>('.maka-module-main');
      const content = main?.querySelector<HTMLElement>('.astryx-layout-content');
      if (!main || !content) throw new Error('Expected the MCP module layout');
      const rows = content.querySelector<HTMLElement>('.maka-module-page-rows')
        ?? content.querySelector<HTMLElement>('.maka-module-page-panel');
      if (!rows) throw new Error('Expected the MCP module content');
      const rowsRect = rows.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      return {
        mainOverflow: main.scrollWidth - main.clientWidth,
        contentOverflow: content.scrollWidth - content.clientWidth,
        // Centring is measured against the content scroller's inner box, not
        // the page: a classic (non-overlay) vertical scrollbar takes width
        // out of the scroller, and the column centres in what remains.
        centerDelta: Math.abs(
          rowsRect.left + rowsRect.width / 2
            - (contentRect.left + content.clientWidth / 2),
        ),
        rowsWidth: rowsRect.width,
      };
    });

    expect(geometry.mainOverflow, `${width}px: ${JSON.stringify(geometry)}`).toBe(0);
    expect(geometry.contentOverflow, `${width}px: ${JSON.stringify(geometry)}`).toBe(0);
    // Centred and capped at every width, not just wide ones: below the clamp
    // the column fills the plate, which is centring too.
    expect(geometry.rowsWidth, `${width}px: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(900);
    expect(geometry.centerDelta, `${width}px: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(1);
  }
});

test('MCP server descriptions truncate with an ellipsis at 700px and 500px', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('navigation', { name: '对话列表' }).getByRole('button', { name: '扩展', exact: true }).click();
  await page.locator('.maka-module-hub-selector').getByRole('button', { name: 'MCP' }).click();

  const endpoint = `https://example.com/${'narrow-description-segment/'.repeat(12)}mcp`;
  await page.evaluate(async (url) => {
    await window.maka.mcp.upsert('long-endpoint', {
      enabled: false,
      url,
      transport: 'streamable-http',
    });
  }, endpoint);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('radio', { name: '已安装' }).click();

  const row = page.getByRole('listitem').filter({ hasText: 'long-endpoint' });
  const description = row.locator('[data-maka-contract="mcp-server-description"]');
  await expect(description).toBeVisible();
  await expect(description.getByTitle(endpoint)).toHaveText(endpoint);

  for (const width of [700, 500]) {
    await page.setViewportSize({ width, height: 700 });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);

    const geometry = await description.evaluate((content) => {
      const slot = content.parentElement;
      const main = content.closest<HTMLElement>('.maka-module-main');
      const item = content.closest<HTMLElement>('li');
      if (!slot || !main || !item) throw new Error('Expected the MCP server description layout');
      const contentStyle = getComputedStyle(content);
      const slotRect = slot.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      return {
        mainOverflow: main.scrollWidth - main.clientWidth,
        contentOverflow: content.scrollWidth - content.clientWidth,
        slotRightOverflow: slotRect.right - itemRect.right,
        contentOverflowStyle: contentStyle.overflow,
        contentTextOverflow: contentStyle.textOverflow,
        contentWhiteSpace: contentStyle.whiteSpace,
      };
    });

    expect(geometry.mainOverflow, `${width}px: ${JSON.stringify(geometry)}`).toBe(0);
    expect(geometry.contentOverflow, `${width}px: ${JSON.stringify(geometry)}`).toBeGreaterThan(0);
    expect(geometry.slotRightOverflow, `${width}px: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(1);
    expect(geometry.contentOverflowStyle).toBe('hidden');
    expect(geometry.contentTextOverflow).toBe('ellipsis');
    expect(geometry.contentWhiteSpace).toBe('nowrap');
  }
});

test('credentialed MCP editor fits a compact desktop viewport without incidental scrolling', async ({ window: page }) => {
  await page.setViewportSize({ width: 1164, height: 700 });
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('navigation', { name: '对话列表' }).getByRole('button', { name: '扩展', exact: true }).click();
  await page.locator('.maka-module-hub-selector').getByRole('button', { name: 'MCP' }).click();

  const slackRow = page.locator('[data-maka-contract="mcp-market-row"]').filter({ hasText: 'Slack' });
  await slackRow.getByRole('button', { name: '安装 Slack' }).click();
  await slackRow.getByRole('button', { name: '管理' }).click();

  const editor = page.getByRole('dialog', { name: '编辑 slack' });
  await expect(editor).toBeVisible();
  await expect.poll(() => editor.evaluate((element) => (
    element.getAnimations().every((animation) => animation.playState === 'finished')
  ))).toBe(true);
  const overflow = await editor.evaluate((dialog) => {
    const fields = dialog.querySelector<HTMLElement>('.maka-mcp-form-fields');
    if (!fields) throw new Error('Expected MCP editor fields');
    return {
      dialog: dialog.scrollHeight - dialog.clientHeight,
      fields: fields.scrollHeight - fields.clientHeight,
    };
  });

  expect(overflow.dialog, JSON.stringify(overflow)).toBeLessThanOrEqual(1);
  expect(overflow.fields, JSON.stringify(overflow)).toBeLessThanOrEqual(1);

  const selectedTransportSpacing = await editor.getByRole('radio', { name: '本地 stdio' }).evaluate((radio) => {
    const radioWrapper = radio.parentElement;
    const icon = radioWrapper?.nextElementSibling;
    if (!(radioWrapper instanceof HTMLElement) || !(icon instanceof SVGElement)) {
      throw new Error('Expected selected transport radio and icon');
    }
    return icon.getBoundingClientRect().left - radioWrapper.getBoundingClientRect().right;
  });
  expect(selectedTransportSpacing).toBeGreaterThanOrEqual(4);
});

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

  const dingtalkRow = mcp.locator('[data-maka-contract="mcp-market-row"]').filter({ hasText: '钉钉' });
  const installDingtalk = dingtalkRow.getByRole('button', { name: '安装 钉钉' });
  await installDingtalk.click();
  const cancelDingtalk = dingtalkRow.getByRole('button', { name: '取消安装 钉钉' });
  await expect(cancelDingtalk).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(cancelDingtalk.locator('.maka-mcp-install-spinner')).toHaveCSS('opacity', '1');
  await cancelDingtalk.hover();
  await expect(cancelDingtalk.locator('.maka-mcp-install-cancel')).toHaveCSS('opacity', '1');
  await cancelDingtalk.click();
  await expect(dingtalkRow.getByRole('button', { name: '安装 钉钉' })).toBeVisible();
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
