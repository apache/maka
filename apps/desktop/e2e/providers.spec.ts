// Provider add-flow E2E — representative journeys only.
//
// This suite deliberately keeps two journeys, NOT one clone per
// provider. The add flow (open settings → catalog → category → search → open →
// assert form defaults → save → assert detail + brand-mark render contract) is
// identical across every catalog provider, so exercising it once proves the
// mechanism. The per-provider *facts* it used to re-assert (label, base URL,
// default model, catalog group, and that a real brand mark is registered) are
// covered by registry-driven contract tests that auto-cover new providers with
// zero manual updates:
//   - packages/core/src/__tests__/provider-catalog-contract.test.ts
//     (structural invariants over CATALOG_PROVIDER_TYPES)
//   - apps/desktop/src/main/__tests__/icon-governance-contract.test.ts
//     ("renders a registered brand mark for every catalog provider")
//
// Adding a provider: do NOT copy an add-flow test here. The contract tests
// above cover its facts. Add an E2E only for a genuinely new *behavior* (a new
// credential field, a derived endpoint, a gating rule), not a new data point.

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/** 设置 → 模型. */
async function openModelsPage(page: Page) {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
}

/**
 * Walk to the catalog level and narrow it to one provider.
 *
 * The catalog is a page one level below the list, and its category is a
 * Selector rather than a row of tabs — so reaching a provider is three named
 * moves instead of a tab click plus a search.
 */
async function openCatalog(page: Page, options: { category: string; search: string }) {
  await page.getByRole('button', { name: '添加连接', exact: true }).click();
  const catalog = page.locator('[data-maka-contract="provider-catalog"]');
  await expect(catalog).toBeVisible();
  // The catalog level lands on its search field before anything else is
  // touched: it is what a user arrives here to do, and the shared route-focus
  // hook is what puts them there.
  const search = catalog.getByPlaceholder('搜索服务商');
  const category = catalog.getByRole('combobox', { name: '分类', exact: true });
  await expect(search).toBeFocused();
  const searchIcon = search.locator('xpath=..').locator('svg').first();
  await expect(searchIcon).toHaveCSS('width', '16px');
  await expect(searchIcon).toHaveCSS('height', '16px');
  // These are independent filters, not one composite toolbar: ordinary Tab
  // order must move between them in both directions.
  await page.keyboard.press('Tab');
  await expect(category).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(search).toBeFocused();
  await expect(catalog.getByRole('toolbar')).toHaveCount(0);
  await category.click();
  await page.getByRole('option', { name: options.category, exact: true }).click();
  await catalog.getByPlaceholder('搜索服务商').fill(options.search);
  return catalog;
}

/** The provider setup level — one provider's form, or its account login. */
function providerSetup(page: Page) {
  return page.locator('[data-maka-contract="provider-setup"]');
}

/** The connection detail level. */
function connectionDetail(page: Page) {
  return page.locator('[data-maka-contract="connection-detail"]');
}

/** No level on this page is a modal; the delete confirm is the only one left. */
async function expectNoDialog(page: Page) {
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('Models collection header matches its collection', async ({ window: page }) => {
  await openModelsPage(page);
  const panel = page.locator('[data-maka-contract="providers-panel"]');
  await expect(panel.locator('ul')).toBeVisible();

  const geometry = await panel.evaluate((element) => {
    const heading = element.querySelector('h3')?.getBoundingClientRect();
    const add = element.querySelector('[data-maka-contract="add-connection"]')?.getBoundingClientRect();
    const list = element.querySelector('ul')?.getBoundingClientRect();
    if (!heading || !add || !list) return null;
    return {
      headingLeft: heading.left,
      addRight: add.right,
      listLeft: list.left,
      listRight: list.right,
      headerBottom: Math.max(heading.bottom, add.bottom),
      listTop: list.top,
    };
  });

  expect(geometry).not.toBeNull();
  if (!geometry) return;
  expect(Math.abs(geometry.headingLeft - geometry.listLeft)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(geometry.addRight - geometry.listRight)).toBeLessThanOrEqual(0.5);
  expect(geometry.listTop - geometry.headerBottom).toBeGreaterThanOrEqual(7.5);
  expect(geometry.listTop - geometry.headerBottom).toBeLessThanOrEqual(8.5);

  await expect(panel.getByRole('heading', { name: '模型连接', exact: true })).toBeVisible();
  await expect(panel.getByText('· 1', { exact: true })).toBeVisible();

  await page.evaluate(async () => {
    await window.maka.connections.delete('e2e');
  });
  await page.reload();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await expect(panel.getByText(/^· \d+$/)).toHaveCount(0);
});

// Canonical API-key add journey. Cerebras is the concrete stand-in only because
// it is the strongest exercise of the color-asset render contract (a real
// upstream <img> mark that must stay untouched in BOTH light and dark themes);
// the assertions below validate the *flow and the colorAssetRenderContract
// mechanism*, not Cerebras's data — that lives in the registry contract tests.
test('adds a catalog provider through the canonical API-key setup page', async ({ window: page }) => {
  // One window, five named steps. Splitting these into separate tests would buy
  // per-behavior isolation at the price of four more Electron cold starts; the
  // steps give a failing run the same "which behavior broke" answer in the
  // trace without that cost.
  const setup = providerSetup(page);
  const keyInput = setup.getByRole('textbox', { name: /API Key/ });
  const detail = connectionDetail(page);
  const connection = page.getByRole('button', { name: /模型连接：Cerebras/ });

  await test.step('the catalog reaches Cerebras and renders its color brand asset untouched', async () => {
    await openModelsPage(page);
    await expect(page.getByLabel('设置内容')).toBeVisible();
    const catalog = await openCatalog(page, { category: 'API', search: 'Cerebras' });

    // A color brand asset renders as an untouched <img>: no currentColor mask,
    // no CSS paint, no color filter — and stays invariant across the theme flip.
    const catalogMark = catalog.locator('.providerCatalogRow[data-provider="cerebras"] .providerLogo img');
    await expect(catalogMark).toBeVisible();
    expect(await catalogMark.evaluate(colorAssetRenderContract)).toEqual(COLOR_ASSET_RENDER_CONTRACT);
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    expect(await catalogMark.evaluate(colorAssetRenderContract)).toEqual(COLOR_ASSET_RENDER_CONTRACT);
  });

  await test.step('picking a provider navigates to its setup level', async () => {
    await page.getByRole('button', { name: /添加模型供应商：Cerebras/ }).click();
    await expect(setup).toBeVisible();
    // One container throughout: the catalog is replaced, not stacked behind a
    // modal, and the way back to it is the level's own back control.
    await expectNoDialog(page);
    await expect(page.locator('[data-maka-contract="provider-catalog"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '返回服务商列表', exact: true })).toBeVisible();
    await expect(keyInput).toBeFocused();
    await expect(keyInput).toHaveAttribute('type', 'password');
    await expect(page.getByText('完成必要配置后，连接会出现在模型页上方。')).toBeVisible();
    await expect(keyInput).toHaveAttribute('placeholder', '输入或粘贴 API Key');
    await expect(setup.getByLabel('连接标识', { exact: true })).toHaveCount(0);
    await expect(setup.getByLabel('服务地址', { exact: true })).toHaveCount(0);
    await expect(setup.getByLabel('默认模型', { exact: true })).toHaveCount(0);

    // A 300-character key scrolls inside the field instead of growing it. The
    // before/after values are the oracle; the field's width is a design token,
    // not this contract.
    const inputBox = await keyInput.boundingBox();
    await keyInput.fill(`sk-${'a'.repeat(300)}`);
    const longKeyLayout = await keyInput.evaluate((input) => ({
      clientWidth: input.clientWidth,
      scrollWidth: input.scrollWidth,
      clientHeight: input.clientHeight,
      scrollHeight: input.scrollHeight,
    }));
    expect(longKeyLayout.scrollWidth).toBeGreaterThan(longKeyLayout.clientWidth);
    expect(longKeyLayout.scrollHeight).toBe(longKeyLayout.clientHeight);
    expect((await keyInput.boundingBox())?.height).toBe(inputBox?.height);
  });

  await test.step('saving creates the connection and lands on its detail level', async () => {
    await keyInput.fill('e2e-cerebras-key');
    await page.getByRole('button', { name: '保存供应商', exact: true }).click();

    // Creating a connection is the start of setting it up, so the save lands on
    // the page that owns every next move — no hunting for the new row.
    await expect(setup).toHaveCount(0);
    await expect(detail).toBeVisible();
    // The level itself takes focus, not its back button, and it is a region
    // named by its own heading so the landing is announced.
    await expect(detail).toBeFocused();
    await expect(detail).toHaveAttribute('role', 'region');
    await expect(page.getByRole('region', { name: 'Cerebras' })).toBeVisible();
    const detailMark = detail.locator('.providerLogo[data-provider="cerebras"] img');
    await expect(detailMark).toBeVisible();
    expect(await detailMark.evaluate(colorAssetRenderContract)).toEqual(COLOR_ASSET_RENDER_CONTRACT);
  });

  await test.step('going back lands where the user came from', async () => {
    await page.getByRole('button', { name: '返回模型连接', exact: true }).click();
    await expect(detail).toHaveCount(0);
    // This detail was reached by saving a new provider, not by opening a row,
    // so there is no row to go back to and the primary action takes the ring.
    await expect(page.getByRole('button', { name: '添加连接', exact: true })).toBeFocused();

    // Opened from a row, the way back is that row — the ring returns to where
    // the user left, not to the top of the list.
    await connection.click();
    await expect(detail).toBeVisible();
    await page.getByRole('button', { name: '返回模型连接', exact: true }).click();
    await expect(connection).toBeFocused();
    await connection.click();
    await expect(detail).toBeVisible();
  });

  await test.step('the detail replaces a key and manages enabled and default models', async () => {
    // A settled credential is a row, not a form: it reports its state and
    // carries one control. The input only exists while the user is changing it.
    const connectionSection = detail.getByRole('region', { name: '连接' });
    await expect(connectionSection.getByText('已设置', { exact: true })).toBeVisible();
    await expect(connectionSection.getByRole('textbox', { name: /模型密钥/ })).toHaveCount(0);

    await connectionSection.getByRole('button', { name: '更换', exact: true }).click();
    const detailKeyField = connectionSection.getByRole('textbox', { name: /模型密钥/ });
    await expect(detailKeyField).toBeVisible();
    const saveKey = connectionSection.getByRole('button', { name: '保存', exact: true });
    await expect(saveKey).toBeDisabled();
    await detailKeyField.fill('sk-e2e-replacement-key');
    await expect(saveKey).toBeEnabled();
    // Cancel restores the row, discarding the draft.
    await connectionSection.getByRole('button', { name: '取消', exact: true }).click();
    await expect(connectionSection.getByRole('textbox', { name: /模型密钥/ })).toHaveCount(0);

    const modelSection = detail.getByRole('region', { name: '模型' });
    await expect(modelSection).toBeVisible();

    // Enabled models are a MultiSelector, not a wall of checkboxes: Astryx
    // scopes CheckboxList to 3–7 options and a provider lists far more.
    // The MultiSelector trigger is a listbox-popup button; role=combobox belongs
    // to the search input inside the popup.
    const enabledModels = modelSection.getByRole('button', { name: '启用的模型', exact: true });
    await enabledModels.click();
    // No option is locked, and unchecking one is not silently undone: the
    // detail page no longer owns a "default model" that has to stay enabled.
    // Which model a new chat starts on lives on 设置 · 通用, which is the one
    // control for that pair.
    await expect(page.getByRole('option', { name: /GPT OSS 120B/ })).not.toHaveAttribute('aria-disabled', 'true');
    await expect(modelSection.getByText('默认模型', { exact: true })).toHaveCount(0);
    await page.getByRole('option', { name: /Gemma/ }).first().click();
    await page.keyboard.press('Escape');
    await expect(enabledModels).toContainText(/Gemma/);

    // Unchecking the connection's own default model is not silently undone.
    // The store used to merge the default back into every write, so this click
    // computed an identical list, short-circuited, and the box re-checked
    // itself. A default that is no longer enabled is simply no longer a
    // default.
    await enabledModels.click();
    await page.getByRole('option', { name: /GPT OSS 120B/ }).first().click();
    await page.keyboard.press('Escape');
    await expect
      .poll(async () => page.evaluate(async () => {
        const list = await window.maka.connections.list();
        const entry = list.find((candidate) => candidate.slug === 'cerebras');
        return { enabled: entry?.enabledModelIds ?? null, model: entry?.defaultModel ?? null };
      }))
      .toEqual({ enabled: ['gemma-4-31b'], model: '' });
  });

  await test.step('deletion stays reachable and reversible in a short viewport', async () => {
    // The fixture intentionally cannot discover models with its placeholder
    // credential. Dismiss that independently tested transient before changing
    // the viewport so it cannot pause its own auto-hide timer over the control
    // this step is meant to exercise.
    const discoveryError = page
      .getByRole('alert')
      .filter({ has: page.locator('[data-type="supporting"]') });
    await expect(discoveryError).toBeVisible();
    await discoveryError.getByRole('button').click();
    await expect(discoveryError).toBeHidden();

    // Short-viewport invariant: the detail is a page, so the settings content
    // area owns the scrolling and the trailing action stays reachable. The test
    // asserts reachability, not which node scrolls.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1000,
      height: 500,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const deleteButton = detail.getByRole('button', { name: '删除', exact: true });
    await deleteButton.scrollIntoViewIfNeeded();
    await expect(deleteButton).toBeInViewport();
    await deleteButton.click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: '取消', exact: true }).click();
    await expect(confirm).toBeHidden();

    // Confirming deletion refreshes the backing list before the route changes,
    // then returns to the list with focus on its primary action — the row the
    // user came from no longer exists.
    await deleteButton.click();
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: '删除', exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(detail).toHaveCount(0);
    await expect(page.getByRole('button', { name: '添加连接', exact: true })).toBeFocused();
    await expect(connection).toHaveCount(0);
    await expectNoDialog(page);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  });
});

// Distinct detail behavior: the only providers with BOTH settled rows are the
// ones whose address is genuinely the user's. One row is a form at a time, so
// these two are also the only place the cross-row rules can be observed — a
// single-row provider (Cerebras, Cloudflare) cannot show them at all.
test('keeps each settled row to its own field on a provider that has two', async ({ window: page }) => {
  await openModelsPage(page);
  await openCatalog(page, { category: '聚合服务', search: '自定义中转站' });
  await page.getByRole('button', { name: /添加模型供应商：自定义中转站（OpenAI Chat）/ }).click();

  const setup = providerSetup(page);
  await setup.getByRole('textbox', { name: /服务地址/ }).fill('https://relay.example.com/v1');
  await setup.getByRole('textbox', { name: /API Key/ }).fill('e2e-relay-key');
  await setup.getByRole('textbox', { name: /默认模型/ }).fill('relay-model');
  await page.getByRole('button', { name: '保存供应商', exact: true }).click();

  const detail = connectionDetail(page);
  await expect(detail).toBeVisible();
  const connectionSection = detail.getByRole('region', { name: '连接' });
  // A relay publishes no endpoint, so the address is the user's to type and the
  // row exists. `gemini-cli` used to reach this branch too — it is OAuth with an
  // empty baseUrl, and keying the row off "OAuth with a fixed URL" let it past.
  await expect(connectionSection.getByText('服务地址', { exact: true })).toBeVisible();
  await expect(connectionSection.getByText('https://relay.example.com/v1')).toBeVisible();

  // Abandon a key draft by opening the OTHER row rather than cancelling it.
  await connectionSection.getByRole('button', { name: '更换', exact: true }).click();
  await connectionSection.getByRole('textbox', { name: /模型密钥/ }).fill('sk-never-confirmed');
  await connectionSection.getByRole('button', { name: '编辑', exact: true }).click();

  // The endpoint row opens on the saved address, and saving it writes only the
  // address: the patch used to carry both fields whichever row asked for it, so
  // the key the user never confirmed rode along with it.
  const endpointInput = connectionSection.getByRole('textbox', { name: '服务地址', exact: true });
  await expect(endpointInput).toHaveValue('https://relay.example.com/v1');
  await endpointInput.fill('https://relay.example.com/v2');
  await connectionSection.getByRole('button', { name: '保存', exact: true }).click();
  await expect(connectionSection.getByText('https://relay.example.com/v2')).toBeVisible();
  // The credential is untouched by the endpoint's save. A both-fields patch
  // would have sent the blanked key, which the IPC boundary reads as "delete
  // this secret" — so the row would report 尚未设置 instead.
  await expect(connectionSection.getByText('已设置', { exact: true })).toBeVisible();

  // And the abandoned key is gone rather than waiting in state for the next
  // time the user opens its row.
  await connectionSection.getByRole('button', { name: '更换', exact: true }).click();
  await expect(connectionSection.getByRole('textbox', { name: /模型密钥/ })).toHaveValue('');

  // The same rule in the other direction, and the one the store can answer:
  // abandon an ENDPOINT draft, then save the key row. The address the user
  // never confirmed must not ride along with it.
  await connectionSection.getByRole('button', { name: '编辑', exact: true }).click();
  await endpointInput.fill('https://relay.example.com/never-confirmed');
  await connectionSection.getByRole('button', { name: '更换', exact: true }).click();
  await connectionSection.getByRole('textbox', { name: /模型密钥/ }).fill('sk-e2e-relay-replacement');
  await connectionSection.getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(async () => page.evaluate(async () => {
      const list = await window.maka.connections.list();
      return list.find((entry) => entry.providerType === 'openai-compatible')?.baseUrl ?? null;
    }))
    .toBe('https://relay.example.com/v2');
});

const COLOR_ASSET_RENDER_CONTRACT = {
  usesAssetMask: false,
  hasCssPaint: false,
  hasColorFilter: false,
};

function colorAssetRenderContract(element: Element): {
  usesAssetMask: boolean;
  hasCssPaint: boolean;
  hasColorFilter: boolean;
} {
  const style = getComputedStyle(element);
  return {
    usesAssetMask: style.maskImage !== 'none',
    hasCssPaint: style.backgroundColor !== 'rgba(0, 0, 0, 0)',
    hasColorFilter: style.filter !== 'none' || style.opacity !== '1',
  };
}
