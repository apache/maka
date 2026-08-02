// Provider add-flow E2E — representative journeys only.
//
// This suite deliberately keeps a handful of journeys, NOT one clone per
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
  await catalog.getByRole('combobox', { name: '分类', exact: true }).click();
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
    const detailMark = detail.locator('.providerLogo[data-provider="cerebras"] img');
    await expect(detailMark).toBeVisible();
    expect(await detailMark.evaluate(colorAssetRenderContract)).toEqual(COLOR_ASSET_RENDER_CONTRACT);
  });

  await test.step('the detail replaces a key and manages enabled and default models', async () => {
    // The credentials section must not reflow while a key is typed: the hint is
    // a single persistent line and the 更新密钥 button is always present
    // (disabled until a new key is entered), so nothing is added or removed.
    const credentials = detail.getByRole('region', { name: '凭据' });
    const detailKeyField = credentials.getByRole('textbox', { name: /模型密钥/ });
    await expect(detailKeyField).toHaveAttribute('placeholder', '••••••••');
    const credentialsHeightBefore = (await credentials.boundingBox())?.height;
    await detailKeyField.fill('sk-e2e-replacement-key');
    await expect(credentials.getByRole('button', { name: '更新密钥', exact: true })).toBeEnabled();
    expect((await credentials.boundingBox())?.height).toBe(credentialsHeightBefore);
    await detailKeyField.fill('');

    const modelManagement = detail.getByRole('region', { name: '模型管理' });
    await expect(modelManagement).toBeVisible();

    // Astryx CheckboxList owns the collection label, checkbox semantics,
    // disabled state, and focus. Search/popup behavior is intentionally absent.
    const modelList = modelManagement.getByRole('group', { name: /启用模型/ });
    const defaultModel = modelList.getByRole('checkbox', {
      name: /GPT OSS 120B · 默认/,
    });
    await expect(defaultModel).toBeChecked();
    await expect(defaultModel).toBeDisabled();

    const gemmaModel = detail.getByRole('checkbox', { name: /Gemma/ }).first();
    await expect(gemmaModel).not.toBeChecked();
    await gemmaModel.check();
    await expect(gemmaModel).toBeChecked();

    // Default-model management stays in the connection detail. Selecting an
    // already enabled model persists immediately and locks that row as the new
    // default.
    const defaultModelSelector = modelManagement.getByRole('combobox', {
      name: '此连接的默认模型',
      exact: true,
    });
    await defaultModelSelector.click();
    await page.getByRole('option', { name: /Gemma/ }).first().click();
    await expect(defaultModelSelector).toContainText(/Gemma/);
    await expect(modelList.getByRole('checkbox', { name: /Gemma/ }).first()).toBeDisabled();
    await expect(detail.getByRole('textbox', { name: /模型密钥/ })).toHaveAttribute('placeholder', '••••••••');
  });

  await test.step('deletion stays reachable and reversible in a short viewport', async () => {
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

    const deleteButton = detail.getByRole('button', { name: '删除连接', exact: true });
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

// Distinct form behavior: an account-scoped provider has no fixed base URL —
// the endpoint is derived from an account-id field, so the plain base-URL input
// is absent until the account id is supplied. Kept because this form shape is
// unique, not because Cloudflare's data differs from other providers.
test('derives an account-scoped endpoint from the Cloudflare account-id field', async ({ window: page }) => {
  await openModelsPage(page);
  await openCatalog(page, { category: 'API', search: 'Cloudflare Workers AI' });
  await page.getByRole('button', { name: /添加模型供应商：Cloudflare Workers AI/ }).click();

  const accountId = 'account-123';
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
  await expect(page.getByLabel('连接标识', { exact: true })).toHaveValue('cloudflare-workers-ai');
  // The plain base-URL input is replaced by the account-id field; the endpoint
  // is derived, not typed.
  const setup = providerSetup(page);
  const accountIdInput = setup.getByRole('textbox', {
    name: /Cloudflare Account ID/,
  });
  await expect(accountIdInput).toHaveValue('');
  const cloudflareKey = setup.getByRole('textbox', { name: /API Key/ });
  await expect(cloudflareKey).toBeVisible();
  await expect(setup.getByLabel('服务地址', { exact: true })).toHaveCount(0);
  await accountIdInput.fill(accountId);
  await page.getByRole('button', { name: '保存供应商' }).click();
  await expect(page.getByRole('alert')).toHaveText('请填写 Cloudflare Workers AI API Key');

  await cloudflareKey.fill('e2e-cloudflare-key');
  await page.getByRole('button', { name: '保存供应商' }).click();

  const detail = connectionDetail(page);
  await expect(detail).toBeVisible();
  // The endpoint is a plain section, not something folded away: nothing to
  // expand before reading it.
  await expect(detail.getByRole('textbox', { name: '服务地址', exact: true })).toHaveValue(baseUrl);
  await expect(detail.getByRole('textbox', { name: /模型密钥/ })).toHaveAttribute('placeholder', '••••••••');
});

// Distinct form behavior: a no-auth local runtime shows no API-key field at all
// and offers an empty bootstrap model because it ships no fallback catalog.
// Also the representative currentColor-mask render
// contract (monochrome brand asset), the counterpart to the color-<img> path.
test('adds a no-auth local runtime with no key field and a currentColor mask mark', async ({ window: page }) => {
  await openModelsPage(page);
  const catalog = await openCatalog(page, { category: '本地', search: 'LM Studio' });
  const catalogMark = catalog.locator(
    '.providerCatalogRow[data-provider="lm-studio"] .providerLogo .providerAssetMask',
  );
  await expect(catalogMark).toBeVisible();
  expect(await catalogMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await page.getByRole('button', { name: /添加模型供应商：LM Studio/ }).click();

  const setup = providerSetup(page);
  await expect(setup.getByLabel('连接标识', { exact: true })).toHaveValue('lm-studio');
  await expect(setup.getByLabel('服务地址', { exact: true })).toHaveValue('http://127.0.0.1:1234/v1');
  await expect(setup.getByLabel('默认模型', { exact: true })).toHaveValue('');
  await expect(setup.getByRole('textbox', { name: /API Key/ })).toHaveCount(0);
  await page.getByRole('button', { name: '保存供应商' }).click();

  const detail = connectionDetail(page);
  await expect(detail).toBeVisible();
  const detailMark = detail.locator('.providerLogo[data-provider="lm-studio"] .providerAssetMask');
  await expect(detailMark).toBeVisible();
  expect(await detailMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await expect(detail.getByLabel(/LM Studio 模型密钥/)).toHaveCount(0);
});

test('carries keyboard focus down and back up every level', async ({ window: page }) => {
  await openModelsPage(page);

  const addButton = page.getByRole('button', { name: '添加连接', exact: true });
  const catalog = page.locator('[data-maka-contract="provider-catalog"]');
  const search = catalog.getByPlaceholder('搜索服务商');

  await addButton.click();
  // Every level takes focus to its own first control, so arriving anywhere
  // leaves the ring somewhere usable instead of on document.body.
  await expect(search).toBeFocused();
  await search.fill('SiliconFlow');

  await page.getByRole('button', { name: /添加模型供应商：SiliconFlow/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: /API Key/ })).toBeFocused();

  // Back returns to the catalog with the query intact and the caret back in
  // it: the filter is browsing state held by the panel, so unmounting the
  // catalog does not throw it away.
  await page.getByRole('button', { name: '返回服务商列表', exact: true }).click();
  await expect(search).toHaveValue('SiliconFlow');
  await expect(search).toBeFocused();

  await page.getByRole('button', { name: '返回模型连接', exact: true }).click();
  await expect(catalog).toHaveCount(0);
  await expect(addButton).toBeFocused();

  // A connection row navigates to its detail; leaving it puts focus back on
  // the row the user came from, not on the page's primary action.
  const existingConnection = page.getByRole('button', { name: /模型连接：E2E/ });
  await existingConnection.focus();
  await page.keyboard.press('Enter');
  await expect(connectionDetail(page)).toBeVisible();
  await page.getByRole('button', { name: '返回模型连接', exact: true }).click();
  await expect(connectionDetail(page)).toHaveCount(0);
  await expect(existingConnection).toBeFocused();
});

function maskRenderContract(element: Element): { usesAssetMask: boolean; followsForeground: boolean } {
  const style = getComputedStyle(element);
  return {
    usesAssetMask: style.maskImage.startsWith('url('),
    followsForeground: style.backgroundColor === style.color,
  };
}

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
