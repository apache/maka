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

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  draftFromPricing,
  validatePricingDraft,
  type PricingDraft,
} from "../../renderer/features/usage/testing.js";

const EMPTY: PricingDraft = {
  modelKey: "",
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
};

test("prefilled drafts round-trip precision, omitted cache and explicit zero", () => {
  const pricing = {
    modelKey: "acme:coder-v2",
    inputUsdPer1M: 0.000000123456789,
    outputUsdPer1M: 2.123456789012345,
    cacheReadUsdPer1M: 0,
  };
  const { draft, cacheOpen } = draftFromPricing(pricing);
  assert.equal(cacheOpen, true);
  assert.equal(draft.cacheRead, 0);
  assert.equal(draft.cacheWrite, null);
  assert.deepEqual(validatePricingDraft(draft, { mode: "add", existingKeys: [] }).config, pricing);
  assert.equal(draftFromPricing({ ...pricing, cacheReadUsdPer1M: undefined }).cacheOpen, false);
});

test("validatePricingDraft add flags an empty model key", () => {
  const result = validatePricingDraft(EMPTY, { mode: "add", existingKeys: [] });
  assert.equal(result.errors.modelKey, "required");
  assert.equal(result.errors.input, "required");
  assert.equal(result.errors.output, "required");
  assert.equal(result.hasErrors, true);
  assert.equal(result.config, null);
});

test("validatePricingDraft add flags a duplicate key against existing rows", () => {
  const draft: PricingDraft = { ...EMPTY, modelKey: "openai:gpt-4o", input: 1, output: 2 };
  const result = validatePricingDraft(draft, {
    mode: "add",
    existingKeys: ["openai:gpt-4o"],
  });
  assert.equal(result.errors.modelKey, "duplicate");
  assert.equal(result.config, null);
});

test("validatePricingDraft add builds a canonical config; blank cache is omitted", () => {
  const draft: PricingDraft = {
    modelKey: "  DeepInfra:org/Model:Preview  ",
    input: 0.8,
    output: 2.4,
    cacheRead: null,
    cacheWrite: null,
  };
  const result = validatePricingDraft(draft, { mode: "add", existingKeys: [] });
  assert.equal(result.hasErrors, false);
  assert.deepEqual(result.config, {
    modelKey: "DeepInfra:org/Model:Preview",
    inputUsdPer1M: 0.8,
    outputUsdPer1M: 2.4,
  });
  assert.equal(Object.hasOwn(result.config!, "cacheReadUsdPer1M"), false);
});

test("validatePricingDraft keeps an explicit 0 cache rate distinct from blank", () => {
  const draft: PricingDraft = {
    modelKey: "acme:coder-v2",
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: null,
  };
  const result = validatePricingDraft(draft, { mode: "add", existingKeys: [] });
  assert.equal(result.config?.cacheReadUsdPer1M, 0);
  assert.equal(Object.hasOwn(result.config!, "cacheWriteUsdPer1M"), false);
});

test("validatePricingDraft rejects a negative rate", () => {
  const draft: PricingDraft = { ...EMPTY, modelKey: "a:b", input: -1, output: 2 };
  const result = validatePricingDraft(draft, { mode: "add", existingKeys: [] });
  assert.equal(result.errors.input, "invalid_rate");
  assert.equal(result.config, null);
});

test("validatePricingDraft edit locks the key and ignores the draft key", () => {
  const draft: PricingDraft = {
    modelKey: "ignored",
    input: 3,
    output: 4,
    cacheRead: null,
    cacheWrite: null,
  };
  const result = validatePricingDraft(draft, {
    mode: "edit",
    existingKeys: ["openai:gpt-4o"],
    lockedModelKey: "openai:gpt-4o",
  });
  assert.equal(result.hasErrors, false);
  assert.equal(result.config?.modelKey, "openai:gpt-4o");
});
