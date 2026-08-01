import { expect, test } from './fixtures.js';

test('a collapsed live tool mounts output on demand and follows its tail', async ({
  disclosureOutputWindow: page,
}) => {
  // #1728: live tools render through Astryx ChatToolCalls. A single running
  // tool is one CallRow (role="button") with its detail collapsed — the
  // same on-demand output contract the old processing-block wrapper enforced.
  const calls = page.locator('.astryx-chat-tool-calls');
  const collapsedRow = calls.locator('[role="button"][aria-expanded="false"]');

  await expect(collapsedRow).toHaveCount(1);
  await expect(calls.locator('[data-slot="tool-output"]')).toHaveCount(0);

  await collapsedRow.click();
  const expandedRow = calls.locator('[role="button"][aria-expanded="true"]');
  await expect(expandedRow).toHaveCount(1);
  const output = calls.locator('pre[data-live="true"]');
  await expect(output).toContainText('diagnostic line 160');
  await expect
    .poll(() => output.evaluate((element) => (
      element.scrollHeight - element.clientHeight - element.scrollTop
    )))
    .toBeLessThanOrEqual(1);

  await expandedRow.press(' ');
  await expect(calls.locator('[role="button"][aria-expanded="false"]')).toHaveCount(1);
  await expect(calls.locator('[data-slot="tool-output"]')).toHaveCount(0);
});
