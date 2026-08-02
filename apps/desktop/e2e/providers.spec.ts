// Provider add-flow E2E — representative journeys only.
//
// This suite deliberately keeps a handful of journeys, NOT one clone per
// provider. The add flow (open settings → catalog → tab → search → open →
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
 * Raise the add-connection dialog and narrow it to one provider.
 *
 * The catalog is a dialog rather than a second half of the page, and its
 * category is a Selector rather than a row of tabs — so reaching a provider is
 * three named moves instead of a tab click plus a search.
 */
async function openCatalog(page: Page, options: { category: string; search: string }) {
  await page.getByRole('button', { name: '添加连接', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加连接' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: '分类', exact: true }).click();
  await page.getByRole('option', { name: options.category, exact: true }).click();
  await dialog.getByPlaceholder('搜索服务商').fill(options.search);
  return dialog;
}

/** The connection detail route — a page region now, not a dialog. */
function connectionDetail(page: Page) {
  return page.locator('[data-maka-contract="connection-detail"]');
}

// Canonical API-key add journey. Cerebras is the concrete stand-in only because
// it is the strongest exercise of the color-asset render contract (a real
// upstream <img> mark that must stay untouched in BOTH light and dark themes);
// the assertions below validate the *flow and the colorAssetRenderContract
// mechanism*, not Cerebras's data — that lives in the registry contract tests.
test('adds a catalog provider through the canonical API-key dialog', async ({ window: page }) => {
  // One window, five named steps. Splitting these into separate tests would buy
  // per-behavior isolation at the price of four more Electron cold starts; the
  // steps give a failing run the same "which behavior broke" answer in the
  // trace without that cost.
  const dialog = page.getByRole('dialog', { name: '连接 Cerebras' });
  const keyInput = dialog.getByRole('textbox', { name: /API Key/ });
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

  await test.step('picking a provider steps the same dialog onto its form', async () => {
    await page.getByRole('button', { name: /添加模型供应商：Cerebras/ }).click();
    await expect(dialog).toBeVisible();
    // One dialog throughout: the catalog is gone, not stacked behind a second
    // dialog, and the way back to it is in this dialog's header.
    await expect(page.getByRole('dialog', { name: '添加连接' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '返回', exact: true })).toBeVisible();
    await expect(keyInput).toBeFocused();
    await expect(keyInput).toHaveAttribute('type', 'password');
    await expect(dialog.getByText('完成必要配置后，连接会出现在模型页上方。')).toBeVisible();
    await expect(keyInput).toHaveAttribute('placeholder', '输入或粘贴 API Key');
    await expect(dialog.getByLabel('连接标识', { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel('服务地址', { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel('默认模型', { exact: true })).toHaveCount(0);

    await dialog.evaluate((element) =>
      Promise.all(element.getAnimations().map((animation) => animation.finished)),
    );
    // A 300-character key scrolls inside the field instead of growing it or the
    // dialog around it. The before/after values are the oracle; the dialog's
    // own width and the brand plate's size are design tokens, not this contract.
    const dialogBox = await dialog.boundingBox();
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
    expect((await dialog.boundingBox())?.width).toBe(dialogBox?.width);
    expect((await dialog.boundingBox())?.height).toBe(dialogBox?.height);
  });

  await test.step('saving creates the connection and its row routes to the detail page', async () => {
    await keyInput.fill('e2e-cerebras-key');
    await dialog.getByRole('button', { name: '保存供应商', exact: true }).click();

    await expect(dialog).toBeHidden();
    await connection.click();
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
    await detail.getByText('高级设置', { exact: true }).click();
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
  const dialog = page.getByRole('dialog', { name: '连接 Cloudflare Workers AI' });
  const accountIdInput = dialog.getByRole('textbox', {
    name: /Cloudflare Account ID/,
  });
  await expect(accountIdInput).toHaveValue('');
  const cloudflareKey = dialog.getByRole('textbox', { name: /API Key/ });
  await expect(cloudflareKey).toBeVisible();
  await expect(dialog.getByLabel('服务地址', { exact: true })).toHaveCount(0);
  await accountIdInput.fill(accountId);
  await page.getByRole('button', { name: '保存供应商' }).click();
  await expect(page.getByRole('alert')).toHaveText('请填写 Cloudflare Workers AI API Key');

  await cloudflareKey.fill('e2e-cloudflare-key');
  await page.getByRole('button', { name: '保存供应商' }).click();

  const connection = page.getByRole('button', { name: /模型连接：Cloudflare Workers AI/ });
  await connection.click();
  const detail = connectionDetail(page);
  await detail.getByText('高级设置', { exact: true }).click();
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

  const addDialog = page.getByRole('dialog', { name: '连接 LM Studio' });
  await expect(addDialog.getByLabel('连接标识', { exact: true })).toHaveValue('lm-studio');
  await expect(addDialog.getByLabel('服务地址', { exact: true })).toHaveValue('http://127.0.0.1:1234/v1');
  await expect(addDialog.getByLabel('默认模型', { exact: true })).toHaveValue('');
  await expect(addDialog.getByRole('textbox', { name: /API Key/ })).toHaveCount(0);
  await page.getByRole('button', { name: '保存供应商' }).click();

  const connection = page.getByRole('button', { name: /模型连接：LM Studio/ });
  await connection.click();
  const detail = connectionDetail(page);
  const detailMark = detail.locator('.providerLogo[data-provider="lm-studio"] .providerAssetMask');
  await expect(detailMark).toBeVisible();
  expect(await detailMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await expect(detail.getByLabel(/LM Studio 模型密钥/)).toHaveCount(0);
});

test('restores keyboard focus across provider dialogs', async ({ window: page }) => {
  await openModelsPage(page);

  const addButton = page.getByRole('button', { name: '添加连接', exact: true });
  await addButton.click();
  const catalog = page.getByRole('dialog', { name: '添加连接' });
  // Step one focuses search, so the dialog opens ready to type rather than
  // parking the focus ring on its container.
  await expect(catalog.getByPlaceholder('搜索服务商')).toBeFocused();
  await catalog.getByPlaceholder('搜索服务商').fill('SiliconFlow');

  const siliconFlow = page.getByRole('button', { name: /添加模型供应商：SiliconFlow/ });
  await siliconFlow.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: /API Key/ })).toBeFocused();

  // Back returns to step one with the query intact and the caret back in it —
  // stepping in place is what buys this over two stacked dialogs.
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(catalog.getByPlaceholder('搜索服务商')).toHaveValue('SiliconFlow');
  await expect(catalog.getByPlaceholder('搜索服务商')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(catalog).toBeHidden();
  await expect(addButton).toBeFocused();

  // A connection row navigates rather than opening a dialog; the back control
  // returns to the list and re-focuses the page's primary action.
  const existingConnection = page.getByRole('button', { name: /模型连接：E2E/ });
  await existingConnection.focus();
  await page.keyboard.press('Enter');
  await expect(connectionDetail(page)).toBeVisible();
  await page.getByRole('button', { name: '返回模型连接', exact: true }).click();
  await expect(connectionDetail(page)).toHaveCount(0);
  await expect(addButton).toBeFocused();
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
