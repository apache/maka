import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BUILTIN_PRICING, getBuiltinPricing } from '../telemetry/builtin-pricing.js';
import { buildPricingLookup } from '../telemetry/pricing.js';

describe('builtin pricing over the models.dev sync', () => {
  test('every legacy hand-snapshot key still resolves through the new lookup', () => {
    // The pre-sync builtin-pricing.ts entries ("snapshot as of 2026-05-20").
    // Values may legitimately differ — models.dev is fresher — but a key that
    // priced before the sync must never silently become unpriced.
    for (const modelKey of [
      'anthropic:claude-opus-4-1',
      'anthropic:claude-sonnet-4-5',
      'anthropic:claude-haiku-4',
      'openai:gpt-4o',
      'openai:gpt-4o-mini',
      'openai:o1',
      'google:gemini-2.5-pro',
      'google:gemini-2.5-flash',
      'deepseek:deepseek-chat',
      'deepseek:deepseek-reasoner',
      'moonshot:kimi-k2',
      'zai-coding-plan:glm-4.7',
      'zai-coding-plan:glm-4.6',
      'zai-coding-plan:glm-4.5-air',
      'MiniMax:MiniMax-M3',
      'MiniMax-cn:MiniMax-M3',
    ]) {
      assert.notEqual(getBuiltinPricing(modelKey), null, modelKey);
    }
  });

  test('synced base rates flow through for models the hand snapshot never covered', () => {
    assert.deepEqual(getBuiltinPricing('anthropic:claude-sonnet-4-5'), {
      modelKey: 'anthropic:claude-sonnet-4-5',
      inputUsdPer1M: 3,
      outputUsdPer1M: 15,
      cacheReadUsdPer1M: 0.3,
      cacheWriteUsdPer1M: 3.75,
    });
    // Never in the hand snapshot; only the sync can price it.
    assert.ok((getBuiltinPricing('openai:gpt-5.2')?.inputUsdPer1M ?? 0) > 0);
  });

  test('a supplement wins over a synced row that misprices its plan tier', () => {
    // models.dev prices zai-coding-plan usage at zero (subscription); the
    // supplement keeps the vendor's plan-equivalent rate.
    assert.deepEqual(getBuiltinPricing('zai-coding-plan:glm-4.7'), {
      modelKey: 'zai-coding-plan:glm-4.7',
      inputUsdPer1M: 0.6,
      outputUsdPer1M: 2.2,
    });
  });

  test('the sync replaces stale hand rates instead of preserving them', () => {
    // The hand snapshot carried pre-cut DeepSeek rates (0.27/1.1); models.dev
    // tracks the current price sheet. This is the rot the sync exists to end.
    const pricing = getBuiltinPricing('deepseek:deepseek-chat');
    assert.ok(pricing);
    assert.ok(pricing.inputUsdPer1M < 0.27, `stale input rate: ${pricing.inputUsdPer1M}`);
  });

  test('builtin pricing carries no duplicate model keys', () => {
    const keys = BUILTIN_PRICING.map((pricing) => pricing.modelKey);
    assert.equal(new Set(keys).size, keys.length);
  });

  test('user overrides outrank builtins; unknown keys stay unpriced', () => {
    const lookup = buildPricingLookup([
      { modelKey: 'anthropic:claude-sonnet-4-5', inputUsdPer1M: 0, outputUsdPer1M: 0 },
    ]);
    assert.equal(lookup('anthropic:claude-sonnet-4-5')?.inputUsdPer1M, 0);
    assert.deepEqual(lookup('openai:gpt-4o'), getBuiltinPricing('openai:gpt-4o'));
    assert.equal(lookup('provider:unknown'), null);
  });
});
