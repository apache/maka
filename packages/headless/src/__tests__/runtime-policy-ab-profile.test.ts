import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseRuntimePolicyAbExecutionProfile } from '../runtime-policy-ab-profile.js';

test('checked-in runtime A/B profile pins DeepSeek Flash identity, pricing, and safety limits', async () => {
  const path = new URL(
    '../../harbor/runtime-policy-ab-profiles/deepseek-v4-flash.json',
    import.meta.url,
  );
  const profile = parseRuntimePolicyAbExecutionProfile(JSON.parse(await readFile(path, 'utf8')));

  assert.equal(profile.model, 'deepseek/deepseek-v4-flash');
  assert.deepEqual(profile.pricing, {
    inputUsdPer1M: 0.14,
    outputUsdPer1M: 0.28,
    cacheReadUsdPer1M: 0.0028,
    cacheWriteUsdPer1M: 0,
    source: 'deepseek-v4-flash',
  });
  assert.equal(profile.observedCostStopUsd, 20);
  assert.equal(profile.maxConcurrentAttempts, 2);
});

test('checked-in attention A/B profile pins GLM 5.2 identity and public pricing', async () => {
  const path = new URL('../../harbor/runtime-policy-ab-profiles/glm-5.2.json', import.meta.url);
  const profile = parseRuntimePolicyAbExecutionProfile(JSON.parse(await readFile(path, 'utf8')));

  assert.equal(profile.provider, 'zai-coding-plan');
  assert.equal(profile.model, 'zai-coding-plan/glm-5.2');
  assert.equal(profile.pricing.source, 'glm-5.2-public-2026-07-13');
  assert.equal(profile.maxConcurrentAttempts, 2);
});

test('profile parser rejects the old ambiguous attempt concurrency', () => {
  assert.throws(
    () =>
      parseRuntimePolicyAbExecutionProfile({
        schemaVersion: 1,
        id: 'bad',
        llmConnectionSlug: 'deepseek',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek/deepseek-v4-flash',
        pricing: {
          inputUsdPer1M: 1,
          outputUsdPer1M: 1,
          cacheReadUsdPer1M: 0,
          cacheWriteUsdPer1M: 0,
          source: 'bad',
        },
        taskBudgetSec: 1800,
        harborTimeoutMs: 2_100_000,
        observedCostStopUsd: 20,
        maxConcurrentAttempts: 3,
      }),
    /maxConcurrentAttempts must be an even integer of at least 2/,
  );
});
