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

/**
 * #1361 — the Permissions and Health summary strips were fixed 4- and 5-track
 * grids. At the sanitized window floor (`SAFE_MIN_WIDTH` = 480) that divided the
 * narrow content column into ~30-40px slivers: the Health tiles ended up with a
 * 4px content box, so even a single digit overflowed. Same family as the #1304
 * settings tile overflow — #1335 taught StatTile to wrap, but a tile squeezed
 * below one character wide has nothing left to wrap into.
 *
 * Locks the outcome rather than a fixed column count: every rendered track
 * remains readable and nothing overflows horizontally. The responsive
 * SideNav may leave enough room for more tracks even at the window floor.
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
  // it: the requestable + openable screen-recording row also draws the guided
  // drag action, and that three-button row is the one whose body the `auto`
  // actions track could otherwise squeeze to 0px.
  // Reading the host's real TCC state would silently skip this — see
  // `main/permission-snapshot-e2e-fixture.ts`.
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
      hasSummaryTracks: trackCount > 0,
      tracksStayLegible: narrowestTrack >= 96,
      valuesContained,
    };
  }).toEqual({ hasSummaryTracks: true, tracksStayLegible: true, valuesContained: true });

  await expect.poll(
    () => settings.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});

test('summary grids keep one track per metric when wide', async ({ window: page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const settings = await openSettings(page);

  // `auto-fit` must not cost the full-width layout: one track per metric, on
  // every summary grid that uses it.
  const expectOneTrackPerTile = async (selector: string, metrics: number) => {
    await expect(settings.locator(selector)).toBeVisible();
    await expect.poll(async () => {
      const { trackCount, tileCount } = await summaryGeometry(settings.locator(selector));
      return { trackCount, tileCount };
    }).toEqual({ trackCount: metrics, tileCount: metrics });
  };

  await settingsNavigation(page).getByRole('button', { name: '权限与能力', exact: true }).click();
  await expectOneTrackPerTile('.settingsPermissionSummary', 4);

  await settingsNavigation(page).getByRole('button', { name: '健康', exact: true }).click();
  await expectOneTrackPerTile('.settingsHealthSummary', 5);

  await settingsNavigation(page).getByRole('button', { name: '使用统计', exact: true }).click();
  await expectOneTrackPerTile('.settingsUsageSummary', 4);
});

test('capability diagnostics stay contained when expanded at the window floor', async ({ permissionSettingsWindow: page }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  const settings = page.getByRole('main', { name: '设置内容' });

  await settings.getByRole('button', { name: '展开详情' }).click();
  const capabilityList = settings.locator('.settingsCapabilityList');
  await expect(capabilityList).toHaveAttribute('data-diagnostics-open', 'true');

  // The layers grid used to hold a hard `minmax(150px, …)` floor, wider than the
  // whole content column and pushed overflow up through the row.
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

/**
 * #1364 — list-page geometry at the window floor.
 *
 * Usage: the requests Astryx Table's explicit column widths give it an intrinsic
 * width wider than the settings column even at full window width; it must
 * scroll inside its own container (#1360 fix) instead of dragging the page
 * into horizontal scroll, and the five-tab bar scrolls within itself the same
 * way. Web search: unbreakable tokens (env-var hint, result hostnames/URLs)
 * must wrap instead of widening the page.
 */
/**
 * #1364 review follow-up: the containment test above never reaches the two
 * long-content branches — the default fixture has no request logs (so the
 * requests Table never renders) and no Tavily key (so the page stops at
 * the no-key message). These two lock the actual fixes against the states
 * that broke: the request table scrolls inside its own container while the
 * page stays put, and the hostile-width results (bare-URL title, long
 * snippet) wrap inside their cards.
 */
test('usage request log scrolls inside its own container at the window floor', async ({
  usageSettingsWindow: page,
}) => {
  await page.setViewportSize({ width: 480, height: 900 });
  const settings = page.getByRole('main', { name: '设置内容' });
  const scroller = settings.locator('.settingsUsageTable .astryx-table-scroll-wrapper');
  // The renderer's first stats fetch can race the fixture seeding on boot;
  // refresh until the seeded request log lands.
  await expect(async () => {
    await settings.getByRole('button', { name: '刷新使用统计' }).click();
    await expect(scroller).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await expect(scroller).toHaveCSS('overflow-x', 'auto');
  // The seeded log's nowrap columns are intrinsically wider than the floor
  // column, so the scroller must actually be scrolling its table…
  await expect.poll(
    () => scroller.evaluate((element) => element.scrollWidth > element.clientWidth + 1),
  ).toBe(true);
  // …while the page around it stays contained.
  await expect.poll(
    () => settings.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});

test('web search results wrap inside their cards at the window floor', async ({
  searchSettingsWindow: page,
}) => {
  await page.setViewportSize({ width: 480, height: 900 });
  const settings = page.getByRole('main', { name: '设置内容' });
  await settings.getByLabel('联网搜索真实查询').fill('electron vibrancy 排查');
  await settings.getByRole('button', { name: '搜索', exact: true }).click();

  const results = settings.locator('.settingsWebSearchResult');
  await expect(results).toHaveCount(3);
  await expect.poll(
    () =>
      results.evaluateAll((elements) =>
        elements.every((element) => element.scrollWidth <= element.clientWidth),
      ),
  ).toBe(true);
  await expect.poll(
    () => settings.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
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

/**
 * Direct Astryx FormLayout and Item consumers remain contained at both the
 * wide layout and the 480px window floor. This intentionally avoids locking
 * the deleted generic row classes or reasserting their custom geometry.
 */
test('general forms and Astryx Item controls stay contained across widths', async ({ window: page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const settings = await openSettings(page);
  await settingsNavigation(page).getByRole('button', { name: '通用', exact: true }).click();

  const formLayout = settings.locator('.settingsFormLayout').first();
  const incognitoRow = settings.locator('.astryx-item').filter({ hasText: '隐身模式' });
  const modelRow = settings.locator('.astryx-item').filter({ hasText: '默认模型' });

  await expect(formLayout).toHaveCSS('display', 'flex');
  await expect(incognitoRow).toHaveCSS('display', 'flex');
  await expect(modelRow).toHaveCSS('display', 'flex');

  await page.setViewportSize({ width: 480, height: 900 });
  for (const control of [page.getByLabel('显示名称'), page.getByLabel('助手语气偏好')]) {
    await expect.poll(() => control.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await expect.poll(() => incognitoRow.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(() => modelRow.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  // The proxy sub-form only renders behind the switches. Astryx owns both
  // horizontal layouts; Maka only provides their inset within the Settings
  // card, so the product must remain scroll-free at the window floor.
  await settings.getByRole('switch', { name: '启用代理服务器' }).click();
  await settings.getByRole('switch', { name: '启用代理认证' }).click();
  const formLayouts = settings.locator('.settingsFormLayout');
  await expect(formLayouts).toHaveCount(3);
  await expect(formLayouts.nth(1)).toHaveCSS('display', 'grid');
  await expect(formLayouts.nth(2)).toHaveCSS('display', 'grid');

  await expect.poll(
    () => settings.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});

/**
 * #1362 review follow-up: the user-facing result of the palette-label wrap —
 * at the window floor the full name stays readable (the old nowrap+ellipsis
 * cut "Catppuccin Mocha" to "Catppucc…" with no way to recover it).
 */
/**
 * Three smaller pages at the window floor. The Data page adds two page-owned
 * surfaces: the Astryx conflict-strategy field and the workspace path's
 * wrapping mono value.
 */
/**
 * #1363 review: the full English field label is wider than the 480px floor's
 * content column, so the field and label must remain contained without a
 * product-owned wrapper.
 */
test('data config strategy stays contained at the window floor in English', async ({
  enLocaleWindow: page,
}) => {
  await page.setViewportSize({ width: 480, height: 900 });
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('main', { name: 'Settings content' });
  await settingsNavigation(page).getByRole('button', { name: 'Data', exact: true }).click();

  const strategy = settings.getByRole('combobox', {
    name: 'How to handle connections with the same name during import',
  });
  await expect(strategy).toBeVisible();
  const strategyBox = await strategy.boundingBox();
  const settingsBox = await settings.boundingBox();
  expect(strategyBox).not.toBeNull();
  expect(settingsBox).not.toBeNull();
  expect(strategyBox!.x).toBeGreaterThanOrEqual(settingsBox!.x);
  expect(strategyBox!.x + strategyBox!.width).toBeLessThanOrEqual(
    settingsBox!.x + settingsBox!.width,
  );
});

/**
 * Window-floor sweep over the settings pages that share the default `window`
 * fixture (#1304 / #1361 / #1364).
 *
 * These were five separate tests paying five Electron cold starts to do the
 * same thing: shrink to the 480px `SAFE_MIN_WIDTH` floor and walk pages. Every
 * page-specific assertion below is carried over unchanged — the sweep only
 * stops re-launching the app between them. Pages that need their own seeded
 * fixture (permissions, usage logs, web-search results) stay separate above,
 * because their state is what makes their contract reachable at all.
 */
test('settings pages stay contained at the window floor', async ({ window: page }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  const settings = await openSettings(page);
  const pageContained = () =>
    expect
      .poll(() => settings.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);

  await test.step('health summary tiles stay readable', async () => {
    await settingsNavigation(page).getByRole('button', { name: '健康', exact: true }).click();
    const healthSummary = settings.locator('.settingsHealthSummary');
    await expect(healthSummary).toBeVisible();
    await expect.poll(async () => {
      const { trackCount, narrowestTrack, valuesContained } = await summaryGeometry(healthSummary);
      return {
        hasSummaryTracks: trackCount > 0,
        tracksStayLegible: narrowestTrack >= 80,
        valuesContained,
      };
    }).toEqual({ hasSummaryTracks: true, tracksStayLegible: true, valuesContained: true });
    await pageContained();
  });

  await test.step('usage tabs scroll within themselves', async () => {
    await settingsNavigation(page).getByRole('button', { name: '使用统计', exact: true }).click();
    const tabsBar = settings.locator('.settingsUsageTabsBar');
    await expect(tabsBar).toBeVisible();
    await expect(tabsBar).toHaveCSS('overflow-x', 'auto');
    await expect.poll(async () => {
      const { trackCount, valuesContained } = await summaryGeometry(
        settings.locator('.settingsUsageSummary'),
      );
      return { hasSummaryTracks: trackCount > 0, valuesContained };
    }).toEqual({ hasSummaryTracks: true, valuesContained: true });
    await pageContained();
  });

  await test.step('the web-search hint wraps its unbreakable tokens', async () => {
    // Not `exact`: the nav entry's accessible name carries its Beta badge.
    await settingsNavigation(page).getByRole('button', { name: '联网搜索' }).click();
    const disabledReason = settings.locator('.settingsWebSearchDisabledReason');
    await expect(disabledReason).toBeVisible();
    await expect(disabledReason).toHaveCSS('overflow-wrap', 'anywhere');
    await pageContained();
  });

  await test.step('memory keeps its preview header and status Item contained', async () => {
    await settingsNavigation(page).getByRole('button', { name: '记忆', exact: true }).click();
    const previewHeader = settings.locator('.settingsMemoryPromptPreviewHeader');
    await expect(previewHeader).toBeVisible();
    await expect(previewHeader).toHaveCSS('flex-wrap', 'wrap');
    await expect.poll(
      () => previewHeader.evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);

    // Memory's label + status Badge + switch travel as one Astryx Item. At the
    // floor, the cluster and the row must remain contained without
    // reintroducing the retired form-row geometry.
    const statusRow = settings.locator('.astryx-item').filter({ hasText: '本地 MEMORY.md' });
    await expect(statusRow).toBeVisible();
    await expect.poll(
      () =>
        statusRow.evaluate((element) => {
          const cluster = element.querySelector('.settingsFormRowControlCluster');
          return {
            clusterContained: !!cluster && cluster.scrollWidth <= cluster.clientWidth,
            rowContained: element.scrollWidth <= element.clientWidth,
          };
        }),
    ).toEqual({ clusterContained: true, rowContained: true });
    await pageContained();
  });

  await test.step('palette names wrap instead of clipping', async () => {
    await settingsNavigation(page).getByRole('button', { name: '外观', exact: true }).click();
    const label = settings.getByText('Catppuccin Mocha', { exact: true });
    await expect(label).toBeVisible();
    // Wrapping, not clipping: nothing hides past the box in either axis.
    await expect.poll(
      () =>
        label.evaluate((element) => ({
          horizontallyContained: element.scrollWidth <= element.clientWidth,
          verticallyContained: element.scrollHeight <= element.clientHeight,
        })),
    ).toEqual({ horizontallyContained: true, verticallyContained: true });
    await pageContained();
  });

  await test.step('data keeps its strategy field and workspace path inside the column', async () => {
    await settingsNavigation(page).getByRole('button', { name: '数据', exact: true }).click();
    const strategy = settings.getByRole('combobox', { name: '导入时同名连接的处理方式' });
    await expect(strategy).toBeVisible();
    const strategyBox = await strategy.boundingBox();
    const settingsBox = await settings.boundingBox();
    expect(strategyBox).not.toBeNull();
    expect(settingsBox).not.toBeNull();
    expect(strategyBox!.x).toBeGreaterThanOrEqual(settingsBox!.x);
    expect(strategyBox!.x + strategyBox!.width).toBeLessThanOrEqual(
      settingsBox!.x + settingsBox!.width,
    );
    const workspaceValue = settings.locator('span[data-mono="true"]').first();
    await expect(workspaceValue).toBeVisible();
    await expect.poll(
      () => workspaceValue.evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await pageContained();
  });

  await test.step('about and daily review stay contained', async () => {
    await settingsNavigation(page).getByRole('button', { name: '关于', exact: true }).click();
    await expect(settings.locator('.settingsAboutPage')).toBeVisible();
    await pageContained();

    await settingsNavigation(page).getByRole('button', { name: '每日回顾', exact: true }).click();
    await expect(settings.locator('.settingsFeatureStatusPage')).toBeVisible();
    await pageContained();
  });
});
