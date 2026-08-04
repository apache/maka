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

test('MCP workspace aligns with the shared header without horizontal overflow', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('navigation', { name: '对话列表' }).getByRole('button', { name: '扩展', exact: true }).click();
  await page.locator('.maka-module-hub-selector').getByRole('button', { name: 'MCP' }).click();
  await expect(page.locator('.maka-mcp-workspace')).toBeVisible();

  for (const width of [1440, 1280, 861, 860, 761]) {
    await page.setViewportSize({ width, height: 700 });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);

    const geometry = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>('.maka-module-main');
      const header = document.querySelector<HTMLElement>('.maka-module-main-header');
      const workspace = document.querySelector<HTMLElement>('.maka-mcp-workspace');
      const commandBar = document.querySelector<HTMLElement>('.maka-mcp-command-bar');
      if (!main || !header || !workspace || !commandBar) {
        throw new Error('Expected the MCP module layout');
      }
      const mainRect = main.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      const workspaceRect = workspace.getBoundingClientRect();
      return {
        mainOverflow: main.scrollWidth - main.clientWidth,
        centerDelta: Math.abs(
          workspaceRect.left + workspaceRect.width / 2
            - (mainRect.left + main.clientWidth / 2),
        ),
        headerWidth: headerRect.width,
        workspaceWidth: workspaceRect.width,
        leftEdgeDelta: Math.abs(workspaceRect.left - headerRect.left),
        rightEdgeDelta: Math.abs(workspaceRect.right - headerRect.right),
        headerDisplay: getComputedStyle(header).display,
        commandBarDisplay: getComputedStyle(commandBar).display,
      };
    });

    expect(geometry.mainOverflow, `${width}px: ${JSON.stringify(geometry)}`).toBe(0);
    expect(geometry.centerDelta, `${width}px: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(1);
    if (width >= 1280) {
      expect(geometry.headerWidth, `${width}px: ${JSON.stringify(geometry)}`).toBe(900);
      expect(geometry.workspaceWidth, `${width}px: ${JSON.stringify(geometry)}`).toBe(geometry.headerWidth);
      expect(geometry.leftEdgeDelta, `${width}px: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(1);
      expect(geometry.rightEdgeDelta, `${width}px: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(1);
    }
    expect(geometry.headerDisplay).toBe(width <= 860 ? 'grid' : 'flex');
    expect(geometry.commandBarDisplay).toBe(width <= 860 ? 'grid' : 'flex');
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
  await page.getByRole('button', { name: '刷新' }).click();
  const installedTab = page.locator('[data-tab-value="installed"]');
  await expect(installedTab).toContainText('已安装');
  await expect(installedTab).toContainText('1');
  await installedTab.click();

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
      const summary = content.closest<HTMLElement>('.maka-mcp-server-summary');
      if (!slot || !main || !summary) throw new Error('Expected the MCP server description layout');
      const slotStyle = getComputedStyle(slot);
      const contentStyle = getComputedStyle(content);
      const slotRect = slot.getBoundingClientRect();
      const summaryRect = summary.getBoundingClientRect();
      return {
        mainOverflow: main.scrollWidth - main.clientWidth,
        contentOverflow: content.scrollWidth - content.clientWidth,
        slotRightOverflow: slotRect.right - summaryRect.right,
        slotOverflow: slotStyle.overflow,
        contentOverflowStyle: contentStyle.overflow,
        contentTextOverflow: contentStyle.textOverflow,
        contentWhiteSpace: contentStyle.whiteSpace,
      };
    });

    expect(geometry.mainOverflow, `${width}px: ${JSON.stringify(geometry)}`).toBe(0);
    expect(geometry.contentOverflow, `${width}px: ${JSON.stringify(geometry)}`).toBeGreaterThan(0);
    expect(geometry.slotRightOverflow, `${width}px: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(1);
    expect(geometry.slotOverflow).toBe('hidden');
    expect(geometry.contentOverflowStyle).toBe('hidden');
    expect(geometry.contentTextOverflow).toBe('ellipsis');
    expect(geometry.contentWhiteSpace).toBe('nowrap');
  }
});

test('MCP market cards vertically center their item content', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('navigation', { name: '对话列表' }).getByRole('button', { name: '扩展', exact: true }).click();
  await page.locator('.maka-module-hub-selector').getByRole('button', { name: 'MCP' }).click();

  const alignment = await page.locator('.maka-mcp-market-card').first().evaluate((card) => {
    const item = card.querySelector<HTMLElement>('.maka-mcp-market-item');
    if (!item) throw new Error('Expected the MCP catalog item');
    const cardRect = card.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const itemCenter = itemRect.top + itemRect.height / 2;
    const childCenterDeltas = Array.from(item.children, (child) => {
      const rect = child.getBoundingClientRect();
      return Math.abs(rect.top + rect.height / 2 - itemCenter);
    });
    return {
      cardHeight: cardRect.height,
      insetDelta: Math.abs(
        itemRect.top - cardRect.top
          - (cardRect.bottom - itemRect.bottom),
      ),
      maxChildCenterDelta: Math.max(...childCenterDeltas),
    };
  });

  expect(alignment.cardHeight).toBeGreaterThanOrEqual(104);
  expect(alignment.insetDelta, JSON.stringify(alignment)).toBeLessThanOrEqual(1);
  expect(alignment.maxChildCenterDelta, JSON.stringify(alignment)).toBeLessThanOrEqual(1);
});

test('credentialed MCP editor fits a compact desktop viewport without incidental scrolling', async ({ window: page }) => {
  await page.setViewportSize({ width: 1164, height: 700 });
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('navigation', { name: '对话列表' }).getByRole('button', { name: '扩展', exact: true }).click();
  await page.locator('.maka-module-hub-selector').getByRole('button', { name: 'MCP' }).click();

  const slackCard = page.locator('[data-maka-contract="mcp-market-card"]').filter({ hasText: 'Slack' });
  await slackCard.getByRole('button', { name: '安装 Slack' }).click();
  await slackCard.getByRole('button', { name: '管理' }).click();

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
  await expect(mcp.locator('[data-maka-contract="module-actions"]').getByRole('button')).toHaveCount(1);
  await expect(mcp.getByRole('button', { name: '刷新' })).toBeVisible();

  // Each hub restores its last module when the user returns from another
  // sidebar destination.
  await sidebar.getByRole('button', { name: '定时任务', exact: true }).click();
  await extensions.click();
  await expect(page.getByRole('main', { name: '扩展' })).toBeVisible();
  await expect(extensionSelector).toHaveAccessibleName('扩展内容：MCP');

  const dingtalkCard = mcp.locator('[data-maka-contract="mcp-market-card"]').filter({ hasText: '钉钉' });
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

  await expect(mcp.getByText('e2e-fixture', { exact: true })).toBeVisible();
  await expect(mcp.getByText('把 Maka 连接到你的工作环境')).toHaveCount(0);
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
});
