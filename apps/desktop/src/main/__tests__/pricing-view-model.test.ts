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
import type { EffectivePricingEntry } from "@maka/runtime-host/protocol";
import {
  derivePricingRows,
  validatePricingDraft,
  type PricingDraft,
} from "../../renderer/features/usage/testing.js";

const EMPTY: PricingDraft = {
  provider: "",
  model: "",
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
};

test("derivePricingRows maps source, split, and cache presence", () => {
  const entries: EffectivePricingEntry[] = [
    {
      source: "custom",
      resetEffect: "become_unpriced",
      pricing: { modelKey: "acme:coder-v2", inputUsdPer1M: 0.8, outputUsdPer1M: 2.4 },
    },
    {
      source: "builtin",
      pricing: {
        modelKey: "openai:gpt-4o",
        inputUsdPer1M: 2.5,
        outputUsdPer1M: 10,
        cacheReadUsdPer1M: 0,
      },
    },
    {
      source: "custom",
      resetEffect: "restore_builtin",
      pricing: { modelKey: "anthropic:claude", inputUsdPer1M: 2, outputUsdPer1M: 12 },
    },
  ];

  const rows = derivePricingRows(entries);

  // Canonical key order, not input order.
  assert.deepEqual(
    rows.map((row) => row.modelKey),
    ["acme:coder-v2", "anthropic:claude", "openai:gpt-4o"],
  );
  const acme = rows[0]!;
  assert.equal(acme.provider, "acme");
  assert.equal(acme.model, "coder-v2");
  assert.equal(acme.source, "custom");
  assert.equal(acme.resetEffect, "become_unpriced");

  const anthropic = rows[1]!;
  assert.equal(anthropic.resetEffect, "restore_builtin");

  const openai = rows[2]!;
  assert.equal(openai.source, "builtin");
  assert.equal(openai.resetEffect, null);
  // Explicit 0 is preserved and stays distinct from "not set" (undefined).
  assert.equal(openai.cacheReadUsdPer1M, 0);
  assert.equal(openai.cacheWriteUsdPer1M, undefined);
});

test("validatePricingDraft add flags empty provider/model", () => {
  const result = validatePricingDraft(EMPTY, { mode: "add", existingKeys: [] });
  assert.equal(result.errors.provider, "required");
  assert.equal(result.errors.model, "required");
  assert.equal(result.errors.input, "required");
  assert.equal(result.errors.output, "required");
  assert.equal(result.hasErrors, true);
  assert.equal(result.config, null);
});

test("validatePricingDraft add flags a duplicate key against existing rows", () => {
  const draft: PricingDraft = { ...EMPTY, provider: "openai", model: "gpt-4o", input: 1, output: 2 };
  const result = validatePricingDraft(draft, {
    mode: "add",
    existingKeys: ["openai:gpt-4o"],
  });
  assert.equal(result.errors.model, "duplicate");
  assert.equal(result.config, null);
});

test("validatePricingDraft add builds a canonical config; blank cache is omitted", () => {
  const draft: PricingDraft = {
    provider: "acme",
    model: "coder-v2",
    input: 0.8,
    output: 2.4,
    cacheRead: null,
    cacheWrite: null,
  };
  const result = validatePricingDraft(draft, { mode: "add", existingKeys: [] });
  assert.equal(result.hasErrors, false);
  assert.deepEqual(result.config, {
    modelKey: "acme:coder-v2",
    inputUsdPer1M: 0.8,
    outputUsdPer1M: 2.4,
  });
  assert.equal(Object.hasOwn(result.config!, "cacheReadUsdPer1M"), false);
});

test("validatePricingDraft keeps an explicit 0 cache rate distinct from blank", () => {
  const draft: PricingDraft = {
    provider: "acme",
    model: "coder-v2",
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
  const draft: PricingDraft = { ...EMPTY, provider: "a", model: "b", input: -1, output: 2 };
  const result = validatePricingDraft(draft, { mode: "add", existingKeys: [] });
  assert.equal(result.errors.input, "invalid_rate");
  assert.equal(result.config, null);
});

test("validatePricingDraft edit locks the key and ignores provider/model", () => {
  const draft: PricingDraft = {
    provider: "ignored",
    model: "ignored",
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
