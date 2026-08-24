/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  PRICING_MODEL_KEY_MAX_CHARS,
  canonicalPricingConfigsEqual,
  comparePricingModelKeys,
  normalizePricingConfig,
  normalizePricingModelKey,
  pricingModelKey,
  validateCanonicalPricingConfig,
} from '../pricing.js';

test('pricing model key preserves the exact provider and model identifiers', () => {
  assert.equal(pricingModelKey('DeepInfra', 'org/Model:Preview'), 'DeepInfra:org/Model:Preview');
});

test('pricing model keys use strict exact ordering', () => {
  const composed = '\u00e9';
  const decomposed = 'e\u0301';
  assert.notEqual(composed, decomposed);
  assert.deepEqual([composed, decomposed].sort(comparePricingModelKeys), [decomposed, composed]);
});

test('canonical pricing accepts only an already-normalized exact shape', () => {
  const canonical = {
    modelKey: 'openai:gpt-5',
    inputUsdPer1M: 1.25,
    outputUsdPer1M: 10,
    cacheReadUsdPer1M: 0.25,
  };
  assert.deepEqual(validateCanonicalPricingConfig(canonical), { ok: true, value: canonical });
  for (const value of [
    { ...canonical, modelKey: ' openai:gpt-5 ' },
    { ...canonical, unknown: true },
    { modelKey: canonical.modelKey, outputUsdPer1M: canonical.outputUsdPer1M },
    { ...canonical, cacheWriteUsdPer1M: undefined },
  ]) {
    assert.equal(validateCanonicalPricingConfig(value).ok, false);
  }
  assert.equal(canonicalPricingConfigsEqual(canonical, { ...canonical }), true);
  assert.equal(canonicalPricingConfigsEqual(canonical, { ...canonical, inputUsdPer1M: 2 }), false);
});

test('pricing model-key normalization trims, bounds, and rejects runtime garbage', () => {
  assert.deepEqual(normalizePricingModelKey('  provider:model with space  '), {
    ok: true,
    value: 'provider:model with space',
  });
  const exact = 'a'.repeat(PRICING_MODEL_KEY_MAX_CHARS);
  assert.deepEqual(normalizePricingModelKey(exact), { ok: true, value: exact });

  for (const value of [
    '',
    '  ',
    'a'.repeat(PRICING_MODEL_KEY_MAX_CHARS + 1),
    undefined,
    null,
    42,
    true,
    {},
    [],
    Symbol('value'),
    () => '',
    BigInt(1),
  ]) {
    assert.doesNotThrow(() => normalizePricingModelKey(value));
    assert.equal(normalizePricingModelKey(value).ok, false, String(value));
  }
});

test('pricing normalization returns a minimal canonical value', () => {
  const result = normalizePricingConfig({
    modelKey: '  openai:gpt-4o  ',
    inputUsdPer1M: 0,
    outputUsdPer1M: 10,
    cacheReadUsdPer1M: 0,
    cacheWriteUsdPer1M: undefined,
    arbitrary: 'drop-me',
  });
  assert.deepEqual(result, {
    ok: true,
    value: {
      modelKey: 'openai:gpt-4o',
      inputUsdPer1M: 0,
      outputUsdPer1M: 10,
      cacheReadUsdPer1M: 0,
    },
  });
});

test('pricing normalization rejects malformed shapes and invalid rates without throwing', () => {
  const valid = {
    modelKey: 'openai:gpt-4o',
    inputUsdPer1M: 2.5,
    outputUsdPer1M: 10,
  };
  const invalid = [
    undefined,
    null,
    'pricing',
    [],
    { ...valid, modelKey: '' },
    { ...valid, modelKey: 42 },
    { modelKey: 'model', outputUsdPer1M: 1 },
    { modelKey: 'model', inputUsdPer1M: 1 },
    { ...valid, inputUsdPer1M: -1 },
    { ...valid, outputUsdPer1M: Number.NaN },
    { ...valid, inputUsdPer1M: Number.POSITIVE_INFINITY },
    { ...valid, outputUsdPer1M: '10' },
    { ...valid, cacheReadUsdPer1M: -1 },
    { ...valid, cacheWriteUsdPer1M: Number.NEGATIVE_INFINITY },
  ];

  for (const value of invalid) {
    assert.doesNotThrow(() => normalizePricingConfig(value));
    assert.equal(normalizePricingConfig(value).ok, false, JSON.stringify(value));
  }
});
