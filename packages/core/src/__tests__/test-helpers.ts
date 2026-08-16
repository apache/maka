import assert from 'node:assert/strict';

export function expect(actual: unknown) {
  return {
    not: {
      toBeNull() {
        assert.notStrictEqual(actual, null);
      },
    },
    toBe(expected: unknown) {
      assert.strictEqual(actual, expected);
    },
    toEqual(expected: unknown) {
      assert.deepStrictEqual(actual, expected);
    },
    toBeCloseTo(expected: number, precision = 2) {
      assert.ok(Math.abs(Number(actual) - expected) < 10 ** -precision);
    },
    toBeDefined() {
      assert.notStrictEqual(actual, undefined);
    },
    toBeNull() {
      assert.strictEqual(actual, null);
    },
    toBeUndefined() {
      assert.strictEqual(actual, undefined);
    },
    toContain(expected: string) {
      assert.ok(String(actual).includes(expected));
    },
    toHaveLength(expected: number) {
      assert.strictEqual((actual as { length: number }).length, expected);
    },
    toMatch(expected: RegExp) {
      assert.match(String(actual), expected);
    },
    toMatchObject(expected: Record<string, unknown>) {
      assert.deepStrictEqual(
        Object.fromEntries(
          Object.keys(expected).map((key) => [key, (actual as Record<string, unknown>)[key]]),
        ),
        expected,
      );
    },
  };
}
