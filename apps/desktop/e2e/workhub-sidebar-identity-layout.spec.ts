import { expect, test } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const e2eDir = dirname(fileURLToPath(import.meta.url));

test('Session rail uses a vertical Work identity line distinct from status in both themes', async ({ page }) => {
  await page.setContent(`
    <aside class="maka-session-panel">
      <span class="maka-session-row-signals">
        <span
          class="maka-session-row-work-identity"
          style="--maka-session-work-identity: var(--workhub-identity-3)"
          aria-hidden="true"
        ></span>
        <span class="runtime-status"></span>
      </span>
    </aside>
  `);
  await page.addStyleTag({ path: resolve(e2eDir, '../src/renderer/maka-tokens.css') });
  await page.addStyleTag({ path: resolve(e2eDir, '../src/renderer/styles/workhub.css') });
  await page.addStyleTag({ path: resolve(e2eDir, '../src/renderer/styles/sidebar.css') });
  await page.addStyleTag({ content: `
    .runtime-status { width: 8px; height: 8px; border-radius: 50%; background: black; }
  ` });

  const marker = page.locator('.maka-session-row-work-identity');
  const signals = page.locator('.maka-session-row-signals');
  await expect(marker).toHaveCSS('width', '2px');
  await expect(marker).toHaveCSS('height', '14px');
  await expect(marker).toHaveCSS('background-color', 'rgb(124, 58, 237)');
  await expect(marker).toHaveCSS('opacity', '0.82');
  await expect(signals.locator(':scope > *')).toHaveCount(2);

  await page.locator('html').evaluate((element) => element.setAttribute('data-theme', 'dark'));
  await expect(marker).toHaveCSS('background-color', 'rgb(167, 139, 250)');
});

test('Session composer dock exposes an equal-width WorkHub return bar', async ({ page }) => {
  await page.setContent(`
    <main style="width: 100vw">
      <button class="maka-workhub-composer-return" aria-label="Return to WorkHub">
        <span class="maka-workhub-composer-return__destination">
          <svg class="maka-workhub-composer-return__arrow" viewBox="0 0 16 16" aria-hidden="true"></svg>
          <span>Return to WorkHub</span>
        </span>
        <span class="maka-workhub-composer-return__context" aria-hidden="true">
          <span class="maka-workhub-composer-return__identity"></span>
          <span>maka-workhub-mainline / Review routing</span>
        </span>
      </button>
      <div class="composer">
        <div class="maka-composer-astryx">Composer</div>
      </div>
    </main>
  `);
  await page.addStyleTag({ path: resolve(e2eDir, '../src/renderer/maka-tokens.css') });
  await page.addStyleTag({ path: resolve(e2eDir, '../src/renderer/styles/composer.css') });

  const destination = page.getByRole('button', { name: 'Return to WorkHub' });
  const composer = page.locator('.maka-composer-astryx');
  await expect(destination).toHaveCSS('min-height', '32px');
  await expect(destination).toHaveCSS('width', '680px');
  await expect(composer).toHaveCSS('width', '680px');

  await destination.hover();
  await expect(destination.locator('.maka-workhub-composer-return__arrow'))
    .toHaveCSS('transform', 'matrix(1, 0, 0, 1, -2, 0)');

  await page.setViewportSize({ width: 480, height: 720 });
  await expect(destination).toHaveCSS('width', '432px');
  await expect(composer).toHaveCSS('width', '432px');
});
