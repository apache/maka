import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { stableJsonStringify, stripUndefinedDeep } from '../tool-args-identity.js';

describe('stripUndefinedDeep', () => {
  it('removes a property the provider left undefined, so the value round-trips', () => {
    // Anthropic's `caller` arrives as `{ type: 'direct', toolId: undefined }`
    // when the response carries no tool id. JSON drops that property, so the
    // value no longer reads back as it was written and the canonical encoder
    // refuses the event — which took every tool-calling turn with it.
    const providerOptions = { anthropic: { caller: { type: 'direct', toolId: undefined } } };

    const cleaned = stripUndefinedDeep(providerOptions);

    assert.deepEqual(cleaned, { anthropic: { caller: { type: 'direct' } } });
    assert.deepEqual(JSON.parse(stableJsonStringify(cleaned)), cleaned);
  });

  it('leaves everything else exactly as it was', () => {
    const value = { a: 0, b: '', c: false, d: null, e: [1, undefined, 3], f: { g: undefined } };

    assert.deepEqual(stripUndefinedDeep(value), {
      a: 0,
      b: '',
      c: false,
      d: null,
      // An array hole is a position, not a property: dropping it would shift
      // the rest, so the entry survives as-is.
      e: [1, undefined, 3],
      f: {},
    });
  });
});
