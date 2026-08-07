import { expect, test } from './fixtures.js';

/**
 * Settings · 偏好 · 项目 — the list, and the default-project control.
 *
 * The seeded catalog deliberately mixes an available project with one whose
 * folder is gone, because the unavailable row is where this page can lie
 * most easily: a "设为默认" that looked live on a folder the app cannot open
 * would set a default that breaks every new conversation.
 */
test('the projects page lists the catalog and moves the default between rows', async ({
  settingsProjectsWindow: page,
}) => {
  await page
    .getByRole('navigation', { name: /设置分组|Settings sections/ })
    .getByRole('button', { name: /项目|Projects/, exact: true })
    .click();

  const main = page.getByRole('main', { name: /设置内容|Settings content/ });
  // Exact match: each project's folder name also appears inside its own path,
  // so a substring lookup matches the name and the mono line both.
  await expect(main.getByText('maka-agent', { exact: true })).toBeVisible();
  await expect(main.getByText('astryx-design-system', { exact: true })).toBeVisible();

  // The row whose folder was never created reports that, instead of showing a
  // path it cannot open.
  await expect(main.getByText('retired-prototype', { exact: true })).toBeVisible();
  await expect(main.getByText('目录不可用').first()).toBeVisible();

  // No default configured yet: every row offers to become one.
  await expect(main.getByText('默认', { exact: true })).toHaveCount(0);

  const setDefaultButtons = main.getByRole('button', { name: '设为默认' });
  const enabled: number[] = [];
  for (let index = 0; index < (await setDefaultButtons.count()); index += 1) {
    if (await setDefaultButtons.nth(index).isEnabled()) enabled.push(index);
  }
  // An unavailable project cannot be made the default, and the disabled
  // control says why rather than leaving the user to guess.
  expect(enabled.length).toBeGreaterThan(0);
  const disabled = setDefaultButtons.nth(
    [...Array(await setDefaultButtons.count()).keys()].find((i) => !enabled.includes(i)) ?? 0,
  );
  await expect(disabled).toBeDisabled();
  // Astryx surfaces a Button tooltip through `aria-describedby`, not `title`,
  // so read the element it points at — asserting on `title` passed vacuously
  // against an empty string.
  const describedText = await disabled.evaluate((el) => {
    const id = el.getAttribute('aria-describedby');
    return id ? (document.getElementById(id)?.textContent ?? '') : '';
  });
  expect(describedText).toContain('目录不可用');

  await setDefaultButtons.nth(enabled[0]).click();

  // The chosen row swaps its button for the Badge, and it persists.
  await expect(main.getByText('默认', { exact: true })).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.maka.settings.get().then((value) => value.projects.defaultProjectId),
      ),
    )
    .not.toBe(undefined);

  // Exactly one default at a time: setting another moves it rather than
  // adding a second.
  const remaining = main.getByRole('button', { name: '设为默认' });
  const stillEnabled: number[] = [];
  for (let index = 0; index < (await remaining.count()); index += 1) {
    if (await remaining.nth(index).isEnabled()) stillEnabled.push(index);
  }
  if (stillEnabled.length > 0) {
    await remaining.nth(stillEnabled[0]).click();
    await expect(main.getByText('默认', { exact: true })).toHaveCount(1);
  }
});

test('a project can be renamed in place from the row menu', async ({
  settingsProjectsWindow: page,
}) => {
  await page
    .getByRole('navigation', { name: /设置分组|Settings sections/ })
    .getByRole('button', { name: /项目|Projects/, exact: true })
    .click();

  const main = page.getByRole('main', { name: /设置内容|Settings content/ });
  await expect(main.getByText('astryx-design-system', { exact: true })).toBeVisible();

  // Address the row by name, not by index: the app self-registers its own
  // workspace as a project, so the seeded order is not the rendered order —
  // an index here renamed the wrong project.
  await main.getByRole('button', { name: '更多操作：astryx-design-system' }).click();
  await page.getByRole('menuitem', { name: '重命名' }).click();

  const field = main.getByRole('textbox');
  await expect(field).toBeFocused();
  await field.fill('astryx-renamed');
  await main.getByRole('button', { name: '保存' }).click();

  await expect(main.getByText('astryx-renamed', { exact: true })).toBeVisible();
  await expect(main.getByText('astryx-design-system', { exact: true })).toHaveCount(0);

  // It is the catalog that changed, not just the row.
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.maka.projects.list().then((all) => all.map((p) => p.name)),
      ),
    )
    .toContain('astryx-renamed');
});

test('reveal is offered only for a project whose folder is still there', async ({
  settingsProjectsWindow: page,
}) => {
  await page
    .getByRole('navigation', { name: /设置分组|Settings sections/ })
    .getByRole('button', { name: /项目|Projects/, exact: true })
    .click();

  const main = page.getByRole('main', { name: /设置内容|Settings content/ });
  await expect(main.getByText('retired-prototype', { exact: true })).toBeVisible();

  // The seeded `retired-prototype` folder was never created, so opening it
  // could only fail; the entry is disabled rather than offered-and-broken.
  await main.getByRole('button', { name: '更多操作：retired-prototype' }).click();
  await expect(page.getByRole('menuitem', { name: '在访达中打开' })).toBeDisabled();
  await page.keyboard.press('Escape');

  // Main resolves the path from the catalog by id, so an available project
  // reports a real directory rather than a renderer-supplied one.
  const result = await page.evaluate(() =>
    window.maka.projects.reveal('proj-fixture-gone'),
  );
  expect(result.ok).toBe(false);
});
