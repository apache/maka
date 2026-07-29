/**
 * Tests for the PR-UI-IPC-3 pricing normalize contract
 * (`@maka/core/usage-stats/pricing`).
 *
 * Locks the gate kenji + xuan signed off on (msgs 9033abdf +
 * 047258dc): typeof object guard, shared modelKey helper for
 * put + reset, required-rate / optional-cache validation,
 * extra-fields-stripped canonical return.
 *
 * Maka doesn't bill users — pricing overrides only feed the
 * Usage dashboard's cost display. But a negative / NaN / Infinity
 * rate would render the dashboard as "you saved $X" or garbage
 * text, so the gate is a UX-correctness boundary, not a
 * financial one.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  PRICING_MODEL_KEY_MAX_CHARS,
  canonicalPricingConfigsEqual,
  comparePricingModelKeys,
  normalizePricingConfig,
  normalizePricingModelKey,
  validateCanonicalPricingConfig,
} from '../pricing.js';

describe('comparePricingModelKeys', () => {
  it('strictly orders exact-distinct canonically equivalent Unicode keys', () => {
    const composed = '\u00e9';
    const decomposed = 'e\u0301';

    assert.notEqual(composed, decomposed);
    assert.equal(comparePricingModelKeys(composed, composed), 0);
    assert.equal(comparePricingModelKeys(decomposed, composed), -1);
    assert.equal(comparePricingModelKeys(composed, decomposed), 1);
    assert.deepEqual([composed, decomposed].sort(comparePricingModelKeys), [decomposed, composed]);
  });
});

describe('canonical PricingConfig contract', () => {
  const canonical = {
    modelKey: 'openai:gpt-5',
    inputUsdPer1M: 1.25,
    outputUsdPer1M: 10,
    cacheReadUsdPer1M: 0.25,
  };

  it('accepts only the exact already-normalized shape', () => {
    assert.deepEqual(validateCanonicalPricingConfig(canonical), {
      ok: true,
      value: canonical,
    });
    for (const value of [
      { ...canonical, modelKey: ' openai:gpt-5 ' },
      { ...canonical, unknown: true },
      { modelKey: canonical.modelKey, outputUsdPer1M: canonical.outputUsdPer1M },
      { ...canonical, cacheWriteUsdPer1M: undefined },
    ]) {
      assert.equal(validateCanonicalPricingConfig(value).ok, false);
    }
  });

  it('compares canonical values including optional-field presence', () => {
    assert.equal(canonicalPricingConfigsEqual(canonical, { ...canonical }), true);
    assert.equal(
      canonicalPricingConfigsEqual(canonical, {
        ...canonical,
        cacheReadUsdPer1M: 0.5,
      }),
      false,
    );
    assert.equal(
      canonicalPricingConfigsEqual(
        {
          modelKey: canonical.modelKey,
          inputUsdPer1M: canonical.inputUsdPer1M,
          outputUsdPer1M: canonical.outputUsdPer1M,
        },
        {
          modelKey: canonical.modelKey,
          inputUsdPer1M: canonical.inputUsdPer1M,
          outputUsdPer1M: canonical.outputUsdPer1M,
          cacheReadUsdPer1M: undefined,
        },
      ),
      false,
    );
  });
});

describe('normalizePricingModelKey (PR-UI-IPC-3)', () => {
  describe('accept', () => {
    it('typical provider:model key passes through trimmed', () => {
      const result = normalizePricingModelKey('anthropic:claude-sonnet-4-5');
      assert.deepEqual(result, { ok: true, value: 'anthropic:claude-sonnet-4-5' });
    });

    it('trims surrounding whitespace', () => {
      const result = normalizePricingModelKey('  openai:gpt-4o  ');
      assert.deepEqual(result, { ok: true, value: 'openai:gpt-4o' });
    });

    it('keeps interior whitespace verbatim (does NOT collapse — keys are exact match keys)', () => {
      // Unlike session names, pricing keys are matched exactly
      // against runtime model identifiers. We trim outer whitespace
      // but never alter interior content (because that would
      // silently fail to match the runtime emitter).
      const result = normalizePricingModelKey('  provider:model with space  ');
      assert.deepEqual(result, { ok: true, value: 'provider:model with space' });
    });

    it('accepts at-cap key (128 chars)', () => {
      const exact = 'a'.repeat(PRICING_MODEL_KEY_MAX_CHARS);
      assert.deepEqual(normalizePricingModelKey(exact), { ok: true, value: exact });
    });
  });

  describe('reject', () => {
    it('non-string types reject with typed error', () => {
      for (const bad of [
        undefined,
        null,
        42,
        0,
        NaN,
        true,
        false,
        {},
        [],
        Symbol('x'),
        () => '',
        BigInt(1),
      ]) {
        const result = normalizePricingModelKey(bad);
        assert.equal(result.ok, false, `bad input ${String(bad)} must reject`);
        if (!result.ok) {
          assert.ok(result.error.includes('must be a string'));
        }
      }
    });

    it('empty string rejects', () => {
      assert.equal(normalizePricingModelKey('').ok, false);
    });

    it('whitespace-only rejects', () => {
      for (const raw of [' ', '   ', '\t\n']) {
        const result = normalizePricingModelKey(raw);
        assert.equal(result.ok, false, `raw=${JSON.stringify(raw)}`);
      }
    });

    it('> 128 chars rejects', () => {
      const oversize = 'a'.repeat(PRICING_MODEL_KEY_MAX_CHARS + 1);
      const result = normalizePricingModelKey(oversize);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.error.includes(String(PRICING_MODEL_KEY_MAX_CHARS)));
      }
    });

    it('never throws on bad runtime types', () => {
      for (const bad of [undefined, null, 42, true, {}, [], Symbol('x'), () => '', BigInt(1)]) {
        assert.doesNotThrow(
          () => normalizePricingModelKey(bad),
          `bad input ${String(bad)} must not throw`,
        );
      }
    });
  });
});

describe('normalizePricingConfig (PR-UI-IPC-3)', () => {
  function valid(overrides: Record<string, unknown> = {}): unknown {
    return {
      modelKey: 'openai:gpt-4o',
      inputUsdPer1M: 2.5,
      outputUsdPer1M: 10,
      ...overrides,
    };
  }

  describe('object-shape guard', () => {
    it('non-object types reject', () => {
      for (const bad of [undefined, null, 'pricing-string', 42, true, false]) {
        const result = normalizePricingConfig(bad);
        assert.equal(result.ok, false, `bad input ${String(bad)} must reject`);
        if (!result.ok) {
          assert.ok(result.error.includes('object'));
        }
      }
    });

    it('array rejects (typeof array is "object" but the gate excludes it)', () => {
      assert.equal(normalizePricingConfig([]).ok, false);
      assert.equal(normalizePricingConfig(['pricing']).ok, false);
    });

    it('null rejects', () => {
      assert.equal(normalizePricingConfig(null).ok, false);
    });

    it('never throws on bad runtime types', () => {
      for (const bad of [undefined, null, 'str', 42, true, [], Symbol('x'), () => '', BigInt(1)]) {
        assert.doesNotThrow(() => normalizePricingConfig(bad));
      }
    });
  });

  describe('modelKey gate', () => {
    it('uses shared normalizePricingModelKey — invalid key rejects', () => {
      // Sanity: missing key → reject (modelKey undefined → not a string)
      assert.equal(normalizePricingConfig({ inputUsdPer1M: 1, outputUsdPer1M: 2 }).ok, false);
      // Empty key
      assert.equal(normalizePricingConfig(valid({ modelKey: '' })).ok, false);
      // Whitespace-only
      assert.equal(normalizePricingConfig(valid({ modelKey: '   ' })).ok, false);
      // Non-string
      assert.equal(normalizePricingConfig(valid({ modelKey: 42 })).ok, false);
    });

    it('trims surrounding whitespace on modelKey', () => {
      const result = normalizePricingConfig(valid({ modelKey: '  openai:gpt-4o  ' }));
      assert.ok(result.ok);
      if (result.ok) {
        assert.equal(result.value.modelKey, 'openai:gpt-4o');
      }
    });
  });

  describe('required rates (inputUsdPer1M / outputUsdPer1M)', () => {
    it('0 is legitimate (free tier / Ollama / self-hosted)', () => {
      // CRITICAL gate per @kenji + @xuan: do NOT reject 0.
      const result = normalizePricingConfig(valid({ inputUsdPer1M: 0, outputUsdPer1M: 0 }));
      assert.ok(result.ok);
      if (result.ok) {
        assert.equal(result.value.inputUsdPer1M, 0);
        assert.equal(result.value.outputUsdPer1M, 0);
      }
    });

    it('positive number accepted', () => {
      const result = normalizePricingConfig(valid({ inputUsdPer1M: 3, outputUsdPer1M: 15 }));
      assert.ok(result.ok);
      if (result.ok) {
        assert.equal(result.value.inputUsdPer1M, 3);
        assert.equal(result.value.outputUsdPer1M, 15);
      }
    });

    it('negative rejected (defeats "you saved money" misread)', () => {
      assert.equal(normalizePricingConfig(valid({ inputUsdPer1M: -1 })).ok, false);
      assert.equal(normalizePricingConfig(valid({ outputUsdPer1M: -0.5 })).ok, false);
    });

    it('NaN rejected (would propagate through cost math)', () => {
      assert.equal(normalizePricingConfig(valid({ inputUsdPer1M: NaN })).ok, false);
      assert.equal(normalizePricingConfig(valid({ outputUsdPer1M: NaN })).ok, false);
    });

    it('+Infinity and -Infinity rejected', () => {
      assert.equal(normalizePricingConfig(valid({ inputUsdPer1M: Infinity })).ok, false);
      assert.equal(normalizePricingConfig(valid({ outputUsdPer1M: -Infinity })).ok, false);
    });

    it('non-number types rejected', () => {
      assert.equal(normalizePricingConfig(valid({ inputUsdPer1M: '2.5' })).ok, false);
      assert.equal(normalizePricingConfig(valid({ outputUsdPer1M: null })).ok, false);
      assert.equal(normalizePricingConfig(valid({ inputUsdPer1M: true })).ok, false);
    });

    it('missing required field rejects', () => {
      assert.equal(normalizePricingConfig({ modelKey: 'k', outputUsdPer1M: 1 }).ok, false);
      assert.equal(normalizePricingConfig({ modelKey: 'k', inputUsdPer1M: 1 }).ok, false);
    });

    it('large positive rate accepted (no upper cap — enterprise/local accounting)', () => {
      // @kenji msg 9033abdf: no hard upper cap. Don't break
      // unusual but legitimate configurations.
      const result = normalizePricingConfig(valid({ inputUsdPer1M: 1000, outputUsdPer1M: 5000 }));
      assert.ok(result.ok);
    });
  });

  describe('optional cache rates', () => {
    it('omitted optionals are absent in canonical return', () => {
      const result = normalizePricingConfig(valid());
      assert.ok(result.ok);
      if (result.ok) {
        assert.equal(result.value.cacheReadUsdPer1M, undefined);
        assert.equal(result.value.cacheWriteUsdPer1M, undefined);
        assert.ok(!('cacheReadUsdPer1M' in result.value));
        assert.ok(!('cacheWriteUsdPer1M' in result.value));
      }
    });

    it('explicit undefined treated as omit (NOT reject)', () => {
      const result = normalizePricingConfig(
        valid({ cacheReadUsdPer1M: undefined, cacheWriteUsdPer1M: undefined }),
      );
      assert.ok(result.ok);
      if (result.ok) {
        assert.ok(!('cacheReadUsdPer1M' in result.value));
        assert.ok(!('cacheWriteUsdPer1M' in result.value));
      }
    });

    it('present-valid optionals carry through', () => {
      const result = normalizePricingConfig(
        valid({ cacheReadUsdPer1M: 0.3, cacheWriteUsdPer1M: 3.75 }),
      );
      assert.ok(result.ok);
      if (result.ok) {
        assert.equal(result.value.cacheReadUsdPer1M, 0.3);
        assert.equal(result.value.cacheWriteUsdPer1M, 3.75);
      }
    });

    it('present-but-zero optional accepted (free cache layer)', () => {
      const result = normalizePricingConfig(valid({ cacheReadUsdPer1M: 0, cacheWriteUsdPer1M: 0 }));
      assert.ok(result.ok);
      if (result.ok) {
        assert.equal(result.value.cacheReadUsdPer1M, 0);
        assert.equal(result.value.cacheWriteUsdPer1M, 0);
      }
    });

    it('present-but-invalid optional rejects', () => {
      assert.equal(normalizePricingConfig(valid({ cacheReadUsdPer1M: -1 })).ok, false);
      assert.equal(normalizePricingConfig(valid({ cacheReadUsdPer1M: NaN })).ok, false);
      assert.equal(normalizePricingConfig(valid({ cacheWriteUsdPer1M: Infinity })).ok, false);
      assert.equal(normalizePricingConfig(valid({ cacheReadUsdPer1M: '0.3' })).ok, false);
    });
  });

  describe('extra fields stripped (canonical return)', () => {
    it('arbitrary extra keys are dropped from the canonical value', () => {
      const result = normalizePricingConfig(
        valid({
          evil: 'payload',
          rate: 999,
          modelId: 'shadow',
          nested: { x: 1 },
        }),
      );
      assert.ok(result.ok);
      if (result.ok) {
        assert.deepEqual(Object.keys(result.value).sort(), [
          'inputUsdPer1M',
          'modelKey',
          'outputUsdPer1M',
        ]);
      }
    });

    it('canonical return contains only valid fields — present optionals retained', () => {
      const result = normalizePricingConfig({
        modelKey: 'openai:gpt-4o',
        inputUsdPer1M: 2.5,
        outputUsdPer1M: 10,
        cacheReadUsdPer1M: 1.25,
        // cacheWriteUsdPer1M omitted
        evilExtra: 'no',
      });
      assert.ok(result.ok);
      if (result.ok) {
        assert.deepEqual(Object.keys(result.value).sort(), [
          'cacheReadUsdPer1M',
          'inputUsdPer1M',
          'modelKey',
          'outputUsdPer1M',
        ]);
        assert.equal(result.value.cacheReadUsdPer1M, 1.25);
        assert.ok(!('cacheWriteUsdPer1M' in result.value));
        assert.ok(!('evilExtra' in result.value));
      }
    });

    it('canonical modelKey reflects trim — not raw input', () => {
      const result = normalizePricingConfig(valid({ modelKey: '  trimmed-key  ' }));
      assert.ok(result.ok);
      if (result.ok) {
        assert.equal(result.value.modelKey, 'trimmed-key');
      }
    });
  });

  describe('IPC store-boundary scenarios (handler simulation)', () => {
    // Simulate the `usage:pricing:put` handler's caller contract.
    // The handler does:
    //   const normalized = normalizePricingConfig(pricing);
    //   if (!normalized.ok) throw new Error(normalized.error);
    //   await telemetryRepo.upsertPricing(normalized.value);
    //
    // These tests verify that the repo never sees a bad shape.

    it('renderer-sent valid pricing → repo sees canonical', () => {
      const result = normalizePricingConfig({
        modelKey: 'anthropic:claude-sonnet-4-5',
        inputUsdPer1M: 3,
        outputUsdPer1M: 15,
        cacheReadUsdPer1M: 0.3,
        cacheWriteUsdPer1M: 3.75,
      });
      assert.ok(result.ok);
      // Handler would call repo.upsertPricing(result.value) with this:
      if (result.ok) {
        assert.equal(result.value.modelKey, 'anthropic:claude-sonnet-4-5');
        assert.equal(result.value.inputUsdPer1M, 3);
      }
    });

    it('renderer-typo negative rate → throw before repo; repo never sees -5', () => {
      const result = normalizePricingConfig({
        modelKey: 'openai:gpt-4o',
        inputUsdPer1M: -5,
        outputUsdPer1M: 10,
      });
      assert.equal(result.ok, false);
      // Handler throws; repo.upsertPricing is never called.
    });

    it('renderer-malformed payload (string instead of object) → throw before repo', () => {
      const result = normalizePricingConfig('not-an-object');
      assert.equal(result.ok, false);
    });

    it('renderer-empty modelKey → throw before repo', () => {
      const result = normalizePricingConfig({
        modelKey: '',
        inputUsdPer1M: 1,
        outputUsdPer1M: 1,
      });
      assert.equal(result.ok, false);
    });
  });
});
