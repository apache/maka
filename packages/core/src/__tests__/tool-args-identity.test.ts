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

  it('writes an array hole as the null JSON would have written', () => {
    // A hole is a position, not a property, so it cannot be dropped without
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

  it('reaches an undefined nested inside an array', () => {
    const value = { calls: [{ id: 'a', toolId: undefined }] };

    assert.deepEqual(stripUndefinedDeep(value), { calls: [{ id: 'a' }] });
  });

  it('leaves everything else exactly as it was', () => {
    const value = { a: 0, b: '', c: false, d: null, e: [1, 2], f: { g: 1 } };

    assert.deepEqual(stripUndefinedDeep(value), value);
  });

  it('returns the value itself when nothing needed removing', () => {
    // Rebuilding a value that needed nothing would drop symbol keys and re-run
    // getters for no gain, and by far the common case is that nothing needs
    // removing. Identity is the observable form of "did not rebuild".
    const nested = { b: 1 };
    const value = { a: nested, list: [1, 2] };

    const cleaned = stripUndefinedDeep(value);

    assert.equal(cleaned, value);
    assert.equal(cleaned.a, nested);
  });

  it('keeps a symbol key on a value it did have to rebuild', () => {
    // JSON never sees a symbol key, so dropping one changes nothing about what
    // is persisted — but it changes the object a caller still holds.
    const tag = Symbol('tag');
    const value = { keep: 1, drop: undefined, [tag]: 'kept' } as Record<string | symbol, unknown>;

    const cleaned = stripUndefinedDeep(value);

    assert.deepEqual({ ...cleaned }, { keep: 1, [tag]: 'kept' });
    assert.equal(cleaned[tag], 'kept');
    assert.ok(!('drop' in cleaned));
  });

  it('does not descend into a class instance', () => {
    // Only plain objects are rebuilt. Anything with its own prototype is
    // returned untouched rather than flattened into a plain object.
    class Holder {
      constructor(readonly value: number) {}
    }
    const holder = new Holder(1);

    assert.equal(stripUndefinedDeep({ holder }).holder, holder);
  });
});
