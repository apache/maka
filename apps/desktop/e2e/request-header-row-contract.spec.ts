import { expect, test } from './fixtures';
import { getProviderSettingsCopy } from '../src/renderer/locales/settings-provider-copy';

/**
 * The custom request header row's remove button centres on the FIELD, not on
 * whatever box its own cell happens to declare.
 *
 * `.requestHeaderRow` is `align-items: start` on purpose: the value input can
 * grow an inline error underneath itself and the trash icon must not ride down
 * with it. That makes `.requestHeaderRemove` responsible for stating the height
 * it centres its button inside, and a wrong height there is invisible in a
 * diff — the rule looks deliberate either way. It regressed exactly once, as a
 * bare `min-height: 2.5rem` against 32px inputs, which parked the icon 4px low.
 *
 * `scripts/audit-alignment.mjs` cannot cover this. It clusters controls by
 * `parentElement`, and this row wraps every cell in its own div, so the inputs
 * and the button are never in the same cluster to compare. It also only sees
 * surfaces as they first render, and this editor is three clicks deep.
 */

const copy = getProviderSettingsCopy('zh').detail;

test('the request header remove button centres on its field', async ({
  requestHeaderRowWindow: page,
}) => {
  // `no-models` is the seeded openai-compatible relay — the custom relay whose
  // detail page carries the advanced request editor.
  await page.locator('[data-connection-slug="no-models"] button').first().click();
  await page.locator(`button[aria-label="${copy.edit}: ${copy.requestHeaders}"]`).click();
  await page.getByRole('button', { name: copy.addHeader }).click();
  await expect(page.locator('.requestHeaderRow')).toHaveCount(1);

  const geometry = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('.requestHeaderRow')!;
    // The input's own bordered wrapper is the box the eye reads as "the
    // field"; the bare <input> inside it is shorter than the control.
    const field = row.querySelector<HTMLInputElement>('.requestHeaderName input')!.parentElement!;
    const cell = row.querySelector<HTMLElement>('.requestHeaderRemove')!;
    const button = cell.querySelector<HTMLButtonElement>('button')!;
    const centre = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.top + box.height / 2;
    };
    return {
      drift: centre(button) - centre(field),
      fieldHeight: field.getBoundingClientRect().height,
      cellHeight: cell.getBoundingClientRect().height,
    };
  });

  // Sub-pixel, not zero: a fractional device pixel ratio can land a centre on
  // .5. Four pixels — the regression this pins — is not that.
  expect(Math.abs(geometry.drift)).toBeLessThanOrEqual(0.5);
  // The mechanism, named separately so a failure says which half broke: the
  // cell must not declare a taller box than the field it centres against.
  expect(geometry.cellHeight).toBeLessThanOrEqual(geometry.fieldHeight);
});
