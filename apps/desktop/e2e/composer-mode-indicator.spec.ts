import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

async function hoverBackground(locator: Locator): Promise<string> {
  await locator.hover();
  const background = await locator.evaluate(async (element) => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    await Promise.allSettled(
      element.getAnimations().map((animation) => animation.finished),
    );

    const color = getComputedStyle(element).backgroundColor;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D canvas context is unavailable');
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return { color, alpha: context.getImageData(0, 0, 1, 1).data[3] };
  });
  expect(background.alpha).toBeGreaterThan(0);
  return background.color;
}

async function enableMode(
  page: Page,
  mode: 'plan' | 'swarm',
  label: 'Plan' | 'Swarm',
): Promise<Locator> {
  await page.getByRole('button', { name: '添加' }).click();
  await page.getByRole('menuitemcheckbox', { name: label }).click();
  await page.keyboard.press('Escape');
  const indicator = page.locator(
    `.maka-composer-mode-indicator[data-mode="${mode}"]`,
  );
  await expect(indicator).toBeVisible();
  await expect(indicator.locator('svg.lucide-x')).toBeVisible();
  return indicator;
}

test('Plan and Swarm indicators match composer controls and close directly', async ({
  window: page,
}) => {
  const firstSend = page.locator('.maka-composer-textarea');
  await firstSend.fill('open composer');
  await firstSend.press('Enter');
  await expect(page.getByText(/Fake backend received: open composer/)).toBeVisible();

  const permissionTrigger = page.locator(
    '.maka-composer-left-controls .permissionModeSelector',
  );
  await expect(permissionTrigger).toBeVisible();

  for (const [mode, label] of [
    ['plan', 'Plan'],
    ['swarm', 'Swarm'],
  ] as const) {
    const indicator = await enableMode(page, mode, label);
    const [indicatorGeometry, permissionGeometry] = await Promise.all(
      [indicator, permissionTrigger].map((locator) =>
        locator.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            height: style.height,
            padding: style.padding,
            borderRadius: style.borderRadius,
            gap: style.gap,
          };
        }),
      ),
    );
    expect(indicatorGeometry).toEqual(permissionGeometry);
    expect(await hoverBackground(indicator)).toBe(
      await hoverBackground(permissionTrigger),
    );

    await indicator.click();
    await expect(indicator).toHaveCount(0);
  }
});
