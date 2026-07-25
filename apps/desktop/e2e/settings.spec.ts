import { test, expect } from './fixtures';

test('settings switches keep the compact shared control geometry', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('main', { name: '设置内容' }).getByRole('button', { name: '通用', exact: true }).click();

  const privacySwitch = page.getByRole('switch', { name: '启用隐身模式' });
  await expect(privacySwitch).toBeVisible();
  const box = await privacySwitch.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBe(32);
  expect(box!.height).toBe(18);
  await expect.poll(
    () => privacySwitch.evaluate((element) => getComputedStyle(element).boxShadow),
  ).toBe('none');
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

  await page.locator('[aria-label="设置分组"]').getByText('外观').click();
  await page.getByRole('radio', { name: '深色 始终使用深色界面。' }).click();

  await expect.poll(
    async () => page.evaluate(() => document.documentElement.classList.contains('dark')),
  ).toBe(true);
});

test('settings textarea grows with content and scrolls only at its shared cap', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('main', { name: '设置内容' }).getByRole('button', { name: '通用', exact: true }).click();

  const textarea = page.getByRole('textbox', { name: '助手语气偏好' });
  await expect(textarea).toBeVisible();
  await expect(textarea).toHaveCSS('resize', 'none');
  await expect(textarea).toHaveCSS('field-sizing', 'content');

  const initialHeight = await textarea.evaluate((element) => element.getBoundingClientRect().height);
  await textarea.fill(Array.from({ length: 7 }, (_, index) => `偏好 ${index + 1}`).join('\n'));
  const grownHeight = await textarea.evaluate((element) => element.getBoundingClientRect().height);
  expect(grownHeight).toBeGreaterThan(initialHeight);

  await textarea.fill(Array.from({ length: 30 }, (_, index) => `偏好 ${index + 1}`).join('\n'));
  const capped = await textarea.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(capped.height).toBeLessThanOrEqual(320);
  expect(capped.scrollHeight).toBeGreaterThan(capped.clientHeight);

  await page.getByRole('main', { name: '设置内容' }).getByRole('button', { name: '记忆', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '记忆内容' })).toHaveCSS('resize', 'none');
  await expect(page.getByRole('textbox', { name: 'MEMORY.md 内容' })).toHaveCSS('resize', 'none');
});

test('shared settings input owns its desktop focus chrome', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('main', { name: '设置内容' }).getByRole('button', { name: '通用', exact: true }).click();

  const displayName = page.getByRole('textbox', { name: '显示名称' });
  await expect(displayName).toHaveCSS('box-shadow', 'none');
  await displayName.focus();
  const focusShadow = await displayName.evaluate((element) => getComputedStyle(element).boxShadow);
  expect(focusShadow).not.toBe('none');
  expect(focusShadow).not.toContain('inset');
});

test('open gateway metric values stay contained for long addresses', async ({ window: page }) => {
  await page.setViewportSize({ width: 900, height: 820 });
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();

  const settings = page.getByRole('main', { name: '设置内容' });
  await settings.getByRole('button', { name: '开放网关' }).click();
  await expect(settings.getByRole('heading', { name: '开放网关' })).toBeVisible();

  const addressValue = settings
    .locator('[data-slot="stat-tile-value"]')
    .filter({ hasText: 'http://127.0.0.1:3939' });
  await expect(addressValue).toBeVisible();
  await expect(addressValue).toHaveCSS('overflow-wrap', 'anywhere');
  await expect.poll(
    () =>
      addressValue.evaluate((element) => ({
        contained: element.scrollWidth <= element.clientWidth,
        value: element.textContent,
      })),
  ).toEqual({ contained: true, value: 'http://127.0.0.1:3939' });
});

/**
 * #1361 — the Permissions and Health summary strips were fixed 4- and 5-track
 * grids. At the sanitized window floor (`SAFE_MIN_WIDTH` = 480) that divided the
 * narrow content column into ~30-40px slivers: the Health tiles ended up with a
 * 4px content box, so even a single digit overflowed. Same family as the #1304
 * Open Gateway overflow — #1335 taught StatTile to wrap, but a tile squeezed
 * below one character wide has nothing left to wrap into.
 *
 * Locks the outcome rather than the pixels: tiles fold to fewer, readable
 * tracks and nothing overflows horizontally.
 */
async function openSettings(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  return page.getByRole('main', { name: '设置内容' });
}

/** Real track widths, with `auto-fit`'s collapsed 0px tracks filtered out. */
function summaryGeometry(summary: ReturnType<import('@playwright/test').Page['locator']>) {
  return summary.evaluate((element) => {
    const tracks = getComputedStyle(element)
      .gridTemplateColumns.trim()
      .split(/\s+/)
      .map((track) => Number.parseFloat(track))
      .filter((track) => track > 0);
    return {
      trackCount: tracks.length,
      narrowestTrack: Math.round(Math.min(...tracks)),
      tileCount: element.querySelectorAll('[data-slot="stat-tile"]').length,
      valuesContained: Array.from(
        element.querySelectorAll('[data-slot="stat-tile-value"]'),
      ).every((value) => value.scrollWidth <= value.clientWidth),
    };
  });
}

test('permission rows keep their text at the window floor', async ({ permissionSettingsWindow: page }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  const settings = page.getByRole('main', { name: '设置内容' });
  await expect(settings.getByRole('heading', { name: '系统权限' })).toBeVisible();

  // Prove the fixture renders the shape this contract is about before measuring
  // it: only a requestable + openable permission draws BOTH grant buttons, and
  // that is the row whose body the `auto` actions track used to squeeze to 0px.
  // Reading the host's real TCC state would silently skip this — see
  // `main/permission-snapshot-e2e-fixture.ts`.
  const rows = settings.locator('.settingsOsPermissionRow');
  await expect(rows).toHaveCount(5);
  const twoButtonRows = await rows.evaluateAll((elements) =>
    elements
      .map((element, index) => ({
        index,
        buttons: element.querySelectorAll('.settingsOsPermissionActions button').length,
      }))
      .filter((row) => row.buttons === 2)
      .map((row) => row.index),
  );
  expect(twoButtonRows.length).toBeGreaterThan(0);

  await expect.poll(
    () =>
      rows.evaluateAll((elements) =>
        elements.every((element) => {
          const body = element.querySelector('.settingsOsPermissionBody');
          if (!body) return false;
          // Wide enough for the widest status Badge (~101px intrinsic and
          // `whitespace-nowrap` by primitive contract), and not clipping.
          return (
            body.getBoundingClientRect().width >= 101 && body.scrollWidth <= body.clientWidth
          );
        }),
      ),
  ).toBe(true);

  const permissionSummary = settings.locator('.settingsPermissionSummary');
  await expect.poll(async () => {
    const { trackCount, narrowestTrack, valuesContained } = await summaryGeometry(permissionSummary);
    return {
      foldedToFewTracks: trackCount <= 2,
      tracksStayLegible: narrowestTrack >= 96,
      valuesContained,
    };
  }).toEqual({ foldedToFewTracks: true, tracksStayLegible: true, valuesContained: true });

  await expect.poll(
    () => settings.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});

test('health summary tiles stay readable at the window floor', async ({ window: page }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: '健康', exact: true }).click();

  const healthSummary = settings.locator('.settingsHealthSummary');
  await expect(healthSummary).toBeVisible();
  await expect.poll(async () => {
    const { trackCount, narrowestTrack, valuesContained } = await summaryGeometry(healthSummary);
    return {
      foldedToFewTracks: trackCount <= 2,
      tracksStayLegible: narrowestTrack >= 80,
      valuesContained,
    };
  }).toEqual({ foldedToFewTracks: true, tracksStayLegible: true, valuesContained: true });

  await expect.poll(
    () => settings.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});

test('permission and health summaries keep one track per metric when wide', async ({ window: page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const settings = await openSettings(page);

  // `auto-fit` must not cost the full-width layout: one track per metric.
  await settings.getByRole('button', { name: '权限与能力', exact: true }).click();
  await expect(settings.locator('.settingsPermissionSummary')).toBeVisible();
  await expect.poll(async () => {
    const { trackCount, tileCount } = await summaryGeometry(
      settings.locator('.settingsPermissionSummary'),
    );
    return { trackCount, tileCount };
  }).toEqual({ trackCount: 4, tileCount: 4 });

  await settings.getByRole('button', { name: '健康', exact: true }).click();
  await expect(settings.locator('.settingsHealthSummary')).toBeVisible();
  await expect.poll(async () => {
    const { trackCount, tileCount } = await summaryGeometry(
      settings.locator('.settingsHealthSummary'),
    );
    return { trackCount, tileCount };
  }).toEqual({ trackCount: 5, tileCount: 5 });
});

test('capability diagnostics stay contained when expanded at the window floor', async ({ permissionSettingsWindow: page }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  const settings = page.getByRole('main', { name: '设置内容' });

  await settings.getByRole('button', { name: '展开详情' }).click();
  const capabilityList = settings.locator('.settingsCapabilityList');
  await expect(capabilityList).toHaveAttribute('data-diagnostics-open', 'true');

  // The layers grid used to hold a hard `minmax(150px, …)` floor, wider than the
  // whole content column; the OfficeCLI guidance buttons then pushed the
  // overflow up through the row. The install command keeps its own scroller.
  await expect(settings.locator('.settingsCapabilityLayers').first()).toBeVisible();
  await expect.poll(
    () =>
      capabilityList.evaluate((element) => ({
        listContained: element.scrollWidth <= element.clientWidth,
        rowsContained: Array.from(element.querySelectorAll('.settingsCapabilityRow')).every(
          (row) => row.scrollWidth <= row.clientWidth,
        ),
        layersContained: Array.from(element.querySelectorAll('.settingsCapabilityLayers')).every(
          (layers) => layers.scrollWidth <= layers.clientWidth,
        ),
      })),
  ).toEqual({ listContained: true, rowsContained: true, layersContained: true });

  await expect.poll(
    () => settings.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});

test('remote access opens a channel detail from the overview and returns', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();

  const settings = page.getByRole('main', { name: '设置内容' });
  await settings.getByRole('button', { name: '远程接入' }).click();

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
  const tokenInput = settings.getByLabel('Telegram Bot Token');
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
  await settings.getByRole('button', { name: '远程接入' }).click();

  const activeChannels = page.getByRole('region', { name: '正在使用' }).getByRole('button');
  await expect(activeChannels).toHaveCount(2);
  await expect(activeChannels.nth(0)).toHaveAccessibleName(/管理 Discord/);
  await expect(activeChannels.nth(0)).toHaveAccessibleDescription(runtimeError);
  await expect(activeChannels.nth(1)).toHaveAccessibleName(/管理 Telegram/);

  const overview = settings.locator('.settingsRemoteAccessOverview');
  const attentionRow = activeChannels.nth(0);
  const catalogRows = settings.locator('.settingsRemoteAccessCatalogRow');
  await expect(attentionRow.locator('[data-slot="item-title"]')).toHaveCSS('flex-wrap', 'wrap');
  await expect(attentionRow.locator('[data-slot="item-description"]')).toHaveCSS('overflow-wrap', 'anywhere');
  await expect(attentionRow.locator('[data-slot="item-actions"]')).toHaveCSS('display', 'none');
  await expect(catalogRows.first()).toBeVisible();
  await expect(catalogRows.first().locator('[data-slot="item-actions"]')).toHaveCSS('display', 'none');
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
          const toggle = element.querySelector<HTMLElement>('[data-slot="switch"]');
          const docs = element.querySelector<HTMLElement>('.settingsBotConfigDocLink');
          return toggle && docs
            ? Boolean(toggle.compareDocumentPosition(docs) & Node.DOCUMENT_POSITION_FOLLOWING)
            : false;
        })(),
        headingPrecedesSwitch: (() => {
          const heading = element.querySelector<HTMLElement>('h3');
          const toggle = element.querySelector<HTMLElement>('[data-slot="switch"]');
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
