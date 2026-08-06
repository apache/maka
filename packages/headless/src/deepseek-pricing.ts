/**
 * DeepSeek per-1M USD pricing shared by the DeepSeek A/B and RSI
 * prompt-optimization run scripts. "input" is the cache-miss rate; cache writes
 * carry no separate charge, so `cacheWriteUsdPer1M` is 0. This is vendor run
 * config, not part of the generic `@maka/headless` public API, so it is imported
 * via a package-local `#deepseek-pricing` subpath and is not re-exported from
 * `index.ts`.
 *
 * Fail loud at import — before any Docker time — if a canonical rate field is
 * missing or is not a finite, non-negative number. The published runner profile
 * and manifest rates are pinned by their boundary tests; the field-name ->
 * MAKA_TRIAL_* forwarding contract is covered in harbor-task-runner.test.ts.
 */

import type { HarborTaskPricing } from './harbor-task-runner.js';

export const DEEPSEEK_V4_FLASH_PRICING: HarborTaskPricing = {
  inputUsdPer1M: 0.14,
  outputUsdPer1M: 0.28,
  cacheReadUsdPer1M: 0.0028,
  cacheWriteUsdPer1M: 0,
  source: 'deepseek-v4-flash',
};

for (const field of [
  'inputUsdPer1M',
  'outputUsdPer1M',
  'cacheReadUsdPer1M',
  'cacheWriteUsdPer1M',
] as const) {
  const rate = DEEPSEEK_V4_FLASH_PRICING[field];
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
    throw new Error(
      `DEEPSEEK_V4_FLASH_PRICING.${field} must be a finite, non-negative number (got ${JSON.stringify(rate)})`,
    );
  }
}
