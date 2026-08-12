import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { stableJsonStringify, stripUndefinedDeep } from '../tool-args-identity.js';

/**
 * What the canonical encoder demands: the value reads back as it was written.
 *
 * Refusing outright counts as not round-tripping — that is the encoder's own
 * behaviour, and it is the failure this function exists to prevent.
 */
function roundTrips(value: unknown): boolean {
  try {
    const written = stableJsonStringify(value);
    return stableJsonStringify(JSON.parse(written)) === written;
  } catch {
    return false;
  }
}

describe('stripUndefinedDeep', () => {
  it('removes a property the provider left undefined, so the value round-trips', () => {
    // Anthropic's `caller` arrives as `{ type: 'direct', toolId: undefined }`
    // when the response carries no tool id. JSON drops that property, so the
    // value no longer reads back as it was written and the canonical encoder
    // refuses the event — which took every tool-calling turn with it.
    const providerOptions = { anthropic: { caller: { type: 'direct', toolId: undefined } } };

    const cleaned = stripUndefinedDeep(providerOptions);

    assert.deepEqual(cleaned, { anthropic: { caller: { type: 'direct' } } });
    assert.ok(roundTrips(cleaned));
  });

  it('writes an undefined array entry as the null JSON would have written', () => {
    // An entry is a position, not a property, so it cannot be dropped without
    // shifting everything after it. Leaving `undefined` there does not help:
    // JSON writes it as `null` either way, so the value still fails to read
    // back as written and the encoder still refuses it.
    //
    // This case was pinned the wrong way round when the function was written —
    // the test asserted `[1, undefined, 3]` came back unchanged, which is a
    // value that cannot round-trip. The assertion was protecting the bug.
    const value = { items: [1, undefined, 3] };

    const cleaned = stripUndefinedDeep(value);

    assert.deepEqual(cleaned, { items: [1, null, 3] });
    assert.ok(roundTrips(cleaned), 'the whole point is that the result round-trips');
    assert.ok(!roundTrips(value), 'and that the input did not');
  });

  it('writes an array hole as null too, and not only an explicit undefined', () => {
    // A hole reads as `undefined` but is not one: `map` and `some` both skip
    // it, so a version of this written with `map` returns the sparse array
    // untouched and the encoder refuses it exactly as before. The two cases
    // look identical from the outside and have to be handled separately.
    const items: unknown[] = [1, 2, 3];
    Reflect.deleteProperty(items, 1);
    const value = { items };

    const cleaned = stripUndefinedDeep(value);

    assert.ok(!Object.hasOwn(items, 1), 'the input is a hole, not an explicit undefined');
    assert.deepEqual(cleaned, { items: [1, null, 3] });
    assert.ok(Object.hasOwn(cleaned.items, 1), 'the hole was filled, not carried through');
    assert.ok(roundTrips(cleaned), 'the whole point is that the result round-trips');
    assert.ok(!roundTrips(value), 'and that the input did not');
  });

  it('descends into a null-prototype object, which the encoder accepts', () => {
    // Prototype-pollution-safe JSON parsing hands back objects made with
    // `Object.create(null)`. `canonicalizeStrictJson` accepts that prototype
    // and then throws on the nested `undefined`, so skipping these objects
    // leaves the original failure in place for exactly the callers that were
    // careful about how they parsed.
    const caller = Object.assign(Object.create(null), { type: 'direct', toolId: undefined });
    const value = Object.assign(Object.create(null), { anthropic: { caller } });

    const cleaned = stripUndefinedDeep(value);

    assert.ok(!roundTrips(value), 'the input is the shape the encoder refuses');
    assert.ok(roundTrips(cleaned));
    assert.deepEqual({ ...cleaned.anthropic.caller }, { type: 'direct' });
    assert.equal(
      Object.getPrototypeOf(cleaned.anthropic.caller),
      null,
      'a null prototype is what keeps a __proto__ key as data, so it is put back',
    );
  });
});
