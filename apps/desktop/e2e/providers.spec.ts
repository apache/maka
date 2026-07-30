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

import { test, expect } from './fixtures';

// Canonical API-key add journey. Cerebras is the concrete stand-in only because
// it is the strongest exercise of the color-asset render contract (a real
// upstream <img> mark that must stay untouched in BOTH light and dark themes);
// the assertions below validate the *flow and the colorAssetRenderContract
// mechanism*, not Cerebras's data — that lives in the registry contract tests.
test('adds a catalog provider through the canonical API-key dialog', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByLabel('设置内容')).toBeVisible();

  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();

  await expect(page.getByPlaceholder('搜索服务商')).toBeVisible();
  await page.getByRole('tab', { name: 'API', exact: true }).click();
  await page.getByPlaceholder('搜索服务商').fill('Cerebras');

  // A color brand asset renders as an untouched <img>: no currentColor mask, no
  // CSS paint, no color filter — and stays invariant across the theme flip.
  const catalogMark = page.locator('.providerCatalogRow[data-provider="cerebras"] .providerLogo img');
  await expect(catalogMark).toBeVisible();
  expect(await catalogMark.evaluate(colorAssetRenderContract)).toEqual(COLOR_ASSET_RENDER_CONTRACT);
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  expect(await catalogMark.evaluate(colorAssetRenderContract)).toEqual(COLOR_ASSET_RENDER_CONTRACT);

  await page.getByRole('button', { name: /添加模型供应商：Cerebras/ }).click();
  const dialog = page.getByRole('dialog', { name: '连接 Cerebras' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('API Key')).toBeFocused();
  await expect(dialog.getByLabel('API Key')).toHaveAttribute('type', 'password');
  await expect(dialog.getByText('完成必要配置后，连接会出现在模型页上方。')).toBeVisible();
  await expect(dialog.locator('[data-slot="dialog-header"]')).toHaveCSS('border-bottom-width', '0px');
  await expect(dialog.getByLabel('API Key')).toHaveAttribute('placeholder', '输入或粘贴 API Key');
  await expect(dialog.getByLabel('模型供应商连接标识')).toHaveCount(0);
  await expect(dialog.getByLabel('模型供应商服务地址')).toHaveCount(0);
  await expect(dialog.getByLabel('模型供应商默认模型')).toHaveCount(0);
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox?.width).toBeLessThanOrEqual(520);
  await expect(dialog.locator('.providerLogo')).toHaveCSS('width', '24px');
  await expect(dialog.locator('.providerLogo')).toHaveCSS('height', '24px');
  const keyInput = dialog.getByLabel('API Key');
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
  await keyInput.fill('e2e-cerebras-key');
  await dialog.getByRole('button', { name: '连接并使用', exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: /添加模型供应商：Cerebras/ })).toBeFocused();
  const connection = page.getByRole('button', { name: /模型连接：Cerebras/ });
  await connection.click();
  const detailDialog = page.getByRole('dialog', { name: 'Cerebras' });
  await expect(detailDialog).toBeVisible();
  const detailMark = detailDialog.locator('.providerLogo[data-provider="cerebras"] img');
  await expect(detailMark).toBeVisible();
  expect(await detailMark.evaluate(colorAssetRenderContract)).toEqual(COLOR_ASSET_RENDER_CONTRACT);

  // Dialog height must stay fixed while an API key is typed: the credential
  // hint is a single persistent line and the 更新密钥 button is always present
  // (disabled until a new key is entered), so nothing is added or removed.
  const detailKeyField = detailDialog.getByRole('textbox', { name: /模型密钥/ });
  await expect(detailKeyField).toHaveAttribute('placeholder', '••••••••');
  const detailHeightBefore = (await detailDialog.boundingBox())?.height;
  await detailKeyField.fill('sk-e2e-replacement-key');
  await expect(detailDialog.getByRole('button', { name: '更新密钥', exact: true })).toBeEnabled();
  expect((await detailDialog.boundingBox())?.height).toBe(detailHeightBefore);
  await detailKeyField.fill('');

  await expect(detailDialog.getByText('GPT OSS 120B', { exact: true })).toBeHidden();
  await detailDialog.getByText('高级设置', { exact: true }).click();

  // The full candidate catalog is shown persistently as one checkbox list; the
  // default model is checked and locked, and toggling a candidate flows through
  // the shared enabledModelIds path (no search-only "add" surface).
  const modelList = detailDialog.getByRole('list', { name: '模型列表' });
  await expect(modelList).toBeVisible();
  const defaultRow = modelList.getByRole('checkbox', { name: /GPT OSS 120B/ });
  await expect(defaultRow).toBeChecked();
  await expect(defaultRow).toBeDisabled();

  const gemmaRow = modelList.getByRole('checkbox', { name: /Gemma/ }).first();
  await expect(gemmaRow).not.toBeChecked();
  // Dialog height stays fixed as the list is filtered to a subset.
  const advancedHeightBefore = (await detailDialog.boundingBox())?.height;
  await detailDialog.getByLabel('搜索模型').fill('gemma');
  expect((await detailDialog.boundingBox())?.height).toBe(advancedHeightBefore);
  await gemmaRow.click();
  await expect(gemmaRow).toBeChecked();

  // Roving tabindex: the whole model list is ONE Tab stop. Tab from the search
  // field lands on the active row, a second Tab leaves the list entirely (no
  // per-row Tab stops even with hundreds of rows), and ArrowDown + Space move
  // activity and toggle the focused row.
  await detailDialog.getByLabel('搜索模型').fill('');
  await detailDialog.getByLabel('搜索模型').click();
  await page.keyboard.press('Tab');
  const firstStop = await page.evaluate(() => ({
    role: document.activeElement?.getAttribute('role') ?? null,
    inList: Boolean(document.activeElement?.closest('.providerModelChoiceList')),
  }));
  expect(firstStop).toEqual({ role: 'checkbox', inList: true });
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.providerModelChoiceList')))).toBe(false);
  await page.keyboard.press('Shift+Tab');
  const beforeArrow = await page.evaluate(() => document.activeElement?.getAttribute('data-model-id') ?? null);
  await page.keyboard.press('ArrowDown');
  const afterArrow = await page.evaluate(() => ({
    id: document.activeElement?.getAttribute('data-model-id') ?? null,
    checked: document.activeElement?.getAttribute('aria-checked') ?? null,
  }));
  expect(afterArrow.id).not.toBeNull();
  expect(afterArrow.id).not.toBe(beforeArrow);
  await page.keyboard.press('Space');
  const toggledRow = detailDialog.locator(`[data-model-id="${afterArrow.id}"]`);
  await expect(toggledRow).toHaveAttribute('aria-checked', afterArrow.checked === 'true' ? 'false' : 'true');
  // Restore the row's original state (rows freeze while the save is in
  // flight — the existing busy-freeze contract — so wait until re-enabled).
  await expect(toggledRow).toBeEnabled();
  await toggledRow.click();
  await expect(toggledRow).toHaveAttribute('aria-checked', afterArrow.checked!);

  await expect(detailDialog.getByRole('textbox', { name: /模型密钥/ })).toHaveAttribute('placeholder', '••••••••');

  // Short-viewport invariant: when the expanded detail content outgrows the
  // popup's 85dvh cap, the dialog must stay within the viewport and the BODY
  // must take over scrolling (grid-template-rows: auto minmax(0, 1fr)),
  // keeping the bottom actions reachable. Without the row constraint the body
  // row sizes to content, overflows the popup box under overflow-hidden, and
  // its own overflow-y:auto never engages — 删除连接 sits unreachable below
  // the viewport.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 500,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const shortViewportBox = await detailDialog.boundingBox();
  expect(shortViewportBox!.height).toBeLessThanOrEqual(500 * 0.85);
  expect(shortViewportBox!.y + shortViewportBox!.height).toBeLessThanOrEqual(500);
  const dialogBody = detailDialog.locator('.providerConnectionDialogBody');
  const scrollable = await dialogBody.evaluate((body) => body.scrollHeight > body.clientHeight);
  expect(scrollable).toBe(true);
  const deleteButton = detailDialog.getByRole('button', { name: '删除连接', exact: true });
  // Scrolling the body must bring the bottom action into the viewport, and the
  // click's actionability check (visible, stable, hit-testable) must pass —
  // a clipped/unreachable button fails both.
  await deleteButton.scrollIntoViewIfNeeded();
  await expect(deleteButton).toBeInViewport();
  await deleteButton.click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirm).toBeHidden();
  await cdp.send('Emulation.clearDeviceMetricsOverride');
});

// Distinct form behavior: an account-scoped provider has no fixed base URL —
// the endpoint is derived from an account-id field, so the plain base-URL input
// is absent until the account id is supplied. Kept because this form shape is
// unique, not because Cloudflare's data differs from other providers.
test('derives an account-scoped endpoint from the Cloudflare account-id field', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();

  await page.getByRole('tab', { name: 'API', exact: true }).click();
  await page.getByPlaceholder('搜索服务商').fill('Cloudflare Workers AI');
  await page.getByRole('button', { name: /添加模型供应商：Cloudflare Workers AI/ }).click();

  const accountId = 'account-123';
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
  await expect(page.getByLabel('模型供应商连接标识')).toHaveValue('cloudflare-workers-ai');
  // The plain base-URL input is replaced by the account-id field; the endpoint
  // is derived, not typed.
  await expect(page.getByLabel('Cloudflare 账户 ID')).toHaveValue('');
  await expect(page.getByLabel('Cloudflare Workers AI API Key')).toBeVisible();
  await expect(page.getByLabel('模型供应商服务地址')).toHaveCount(0);
  await page.getByLabel('Cloudflare 账户 ID').fill(accountId);
  await page.getByRole('button', { name: '保存供应商' }).click();
  await expect(page.getByRole('alert')).toHaveText('请填写 Cloudflare Workers AI API Key');

  await page.getByLabel('Cloudflare Workers AI API Key').fill('e2e-cloudflare-key');
  await page.getByRole('button', { name: '保存供应商' }).click();

  const connection = page.getByRole('button', { name: /模型连接：Cloudflare Workers AI/ });
  await connection.click();
  const dialog = page.getByRole('dialog', { name: 'Cloudflare Workers AI' });
  await dialog.getByText('高级设置', { exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '服务地址', exact: true })).toHaveValue(baseUrl);
  await expect(dialog.getByRole('textbox', { name: /模型密钥/ })).toHaveAttribute('placeholder', '••••••••');
});

// Distinct form behavior: a no-auth local runtime shows no API-key field at all
// and ships no default model. Also the representative currentColor-mask render
// contract (monochrome brand asset), the counterpart to the color-<img> path.
test('adds a no-auth local runtime with no key field and a currentColor mask mark', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();

  await page.getByRole('tab', { name: '本地' }).click();
  await page.getByPlaceholder('搜索服务商').fill('LM Studio');
  const catalogMark = page.locator(
    '.providerCatalogRow[data-provider="lm-studio"] .providerLogo .providerAssetMask',
  );
  await expect(catalogMark).toBeVisible();
  expect(await catalogMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await page.getByRole('button', { name: /添加模型供应商：LM Studio/ }).click();

  await expect(page.getByLabel('模型供应商连接标识')).toHaveValue('lm-studio');
  await expect(page.getByLabel('模型供应商服务地址')).toHaveValue('http://127.0.0.1:1234/v1');
  await expect(page.getByLabel('模型供应商默认模型')).toHaveCount(0);
  await expect(page.getByLabel(/LM Studio 模型密钥/)).toHaveCount(0);
  await page.getByRole('button', { name: '保存供应商' }).click();

  const connection = page.getByRole('button', { name: /模型连接：LM Studio/ });
  await connection.click();
  const dialog = page.getByRole('dialog', { name: 'LM Studio' });
  const detailMark = dialog.locator('.providerLogo[data-provider="lm-studio"] .providerAssetMask');
  await expect(detailMark).toBeVisible();
  expect(await detailMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await expect(dialog.getByLabel(/LM Studio 模型密钥/)).toHaveCount(0);
});

test('restores keyboard focus across provider dialogs', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();

  await page.getByPlaceholder('搜索服务商').fill('SiliconFlow');
  const siliconFlow = page.getByRole('button', { name: /添加模型供应商：SiliconFlow/ });
  await siliconFlow.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('API Key')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(siliconFlow).toBeFocused();

  const existingConnection = page.getByRole('button', { name: /模型连接：E2E/ });
  await existingConnection.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'E2E' })).toBeVisible();
  await page.keyboard.press('Escape');
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
