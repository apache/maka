import { expect, test } from './fixtures';

test('artifact preview tab pins on double click and then persists', async ({
  artifactPaneWindow: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const fixtureState = await page.evaluate(() => window.maka.e2eFixture.getState());
  expect(fixtureState).toMatchObject({
    workbarTab: 'files',
    workbarPreview: true,
  });
  const panel = page.locator('[data-maka-contract="session-workbar-right"]');
  const tab = panel.getByRole('tab', { name: /^文件/ });
  const tabRoot = tab.locator('..');

  await expect(tabRoot).toHaveAttribute('data-preview', 'true');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem('maka-session-workbar-panels-v3');
        if (!raw) return [];
        return (
          JSON.parse(raw) as {
            right: { tabs: Array<{ kind: string }> };
          }
        ).right.tabs.map((candidate) => candidate.kind);
      }),
    )
    .toEqual([]);

  await tab.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '固定标签' })).toBeVisible();
  await page.keyboard.press('Escape');
  await tab.dblclick();
  await expect(tabRoot).not.toHaveAttribute('data-preview', 'true');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem('maka-session-workbar-panels-v3');
        if (!raw) return [];
        return (
          JSON.parse(raw) as {
            right: { tabs: Array<{ kind: string }> };
          }
        ).right.tabs.map((candidate) => candidate.kind);
      }),
    )
    .toEqual(['files']);

  await page.reload();
  await expect(panel.getByRole('tab', { name: /^文件/ })).toBeVisible();
  await expect(panel.getByRole('tab', { name: /^文件/ }).locator('..')).not.toHaveAttribute(
    'data-preview',
    'true',
  );
});

test('interacting with artifact preview content pins the tab', async ({
  artifactPaneWindow: page,
}) => {
  const tab = page.getByRole('tab', { name: /^文件/ });
  const tabRoot = tab.locator('..');
  await expect(tabRoot).toHaveAttribute('data-preview', 'true');

  await page.locator('.maka-artifact-preview').click();
  await expect(tabRoot).not.toHaveAttribute('data-preview', 'true');
});
