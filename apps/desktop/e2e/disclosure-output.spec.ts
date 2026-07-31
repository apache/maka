import { expect, test } from './fixtures.js';

test('a collapsed live tool mounts output on demand and follows its tail', async ({
  disclosureOutputWindow: page,
}) => {
  const processing = page.locator('[data-processing="block"]');
  const processingTrigger = processing.locator(':scope > button');

  await expect(processingTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(processing.locator('[data-trow="row"]')).toHaveCount(0);

  await processingTrigger.click();
  const row = processing.locator('[data-trow="row"]');
  const rowTrigger = row.locator(':scope > button');
  await expect(rowTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(row.locator('[data-slot="tool-output"]')).toHaveCount(0);

  await rowTrigger.click();
  await expect(rowTrigger).toHaveAttribute('aria-expanded', 'true');
  const output = row.locator('pre[data-live="true"]');
  await expect(output).toContainText('diagnostic line 160');
  await expect
    .poll(() => output.evaluate((element) => (
      element.scrollHeight - element.clientHeight - element.scrollTop
    )))
    .toBeLessThanOrEqual(1);

  await rowTrigger.press(' ');
  await expect(rowTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(row.locator('[data-slot="tool-output"]')).toHaveCount(0);
});
