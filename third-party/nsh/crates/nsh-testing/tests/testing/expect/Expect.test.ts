// `expect` compares values as Jest does, as JS made them: one test per
// matcher's semantics, each failure's message checked too.
import { expect, test } from "nsh/test";

/** What `f` throws (its message); fails when it throws nothing. */
function thrown(f: () => void): string {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`${f} threw nothing`);
}

/** What the promise `check` returns rejects with (its message). */
async function rejected(check: () => Promise<void>): Promise<string> {
  try {
    await check();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`${check} did not reject`);
}

test("toBe is Object.is", () => {
  const o = { a: 1 };
  expect(o).toBe(o);
  expect(NaN).toBe(NaN);
  expect(0).not.toBe(-0);
  expect({}).not.toBe({});
  expect(thrown(() => expect({ a: 1 }).toBe({ a: 1 }))).toBe(
    'expected {"a":1} to be {"a":1} (an equal value, not the same one: `toEqual` compares members)',
  );
  expect(thrown(() => expect(undefined).toBe(null))).toBe("expected undefined to be null");
});

test("toEqual compares dates, maps, sets, typed arrays and regular expressions as what they are", () => {
  expect(new Date(1000)).toEqual(new Date(1000));
  expect(new Date(1000)).not.toEqual(new Date(2000));
  expect(new Date(0)).not.toEqual("1970-01-01T00:00:00.000Z");
  expect(new Map([["a", 1]])).toEqual(new Map([["a", 1]]));
  expect(new Map([["a", 1]])).not.toEqual(new Map([["a", 2]]));
  expect(new Set([1, 2])).toEqual(new Set([2, 1]));
  expect(new Set([1, 2])).not.toEqual(new Set([1, 3]));
  expect(new Uint8Array([1, 2])).toEqual(new Uint8Array([1, 2]));
  expect(new Uint8Array([1, 2])).not.toEqual(new Uint8Array([2, 1]));
  expect(new Uint8Array([1, 2])).not.toEqual({ 0: 1, 1: 2 });
  expect(new Uint8Array([1, 2]).buffer).toEqual(new Uint8Array([1, 2]).buffer);
  expect(/a/g).toEqual(/a/g);
  expect(/a/g).not.toEqual(/a/i);
  class Point {
    x: number;
    constructor(x: number) {
      this.x = x;
    }
  }
  expect(new Point(1)).toEqual({ x: 1 });
  expect(new Point(1)).not.toEqual(new Point(2));
  expect({ a: 1, b: undefined }).toEqual({ a: 1 });
  expect(NaN).toEqual(NaN);
  expect(thrown(() => expect(new Date(1000)).toEqual(new Date(2000)))).toBe(
    "expected Date(1970-01-01T00:00:01.000Z) to equal Date(1970-01-01T00:00:02.000Z)",
  );
  expect(thrown(() => expect(new Set([1])).toEqual(new Set([2])))).toBe("expected Set {1} to equal Set {2}");
});

test("toBeNull, toBeUndefined, toBeDefined and toBeNaN tell null, undefined and NaN apart", () => {
  expect(null).toBeNull();
  expect(undefined).not.toBeNull();
  expect(NaN).not.toBeNull();
  expect(undefined).toBeUndefined();
  expect(null).not.toBeUndefined();
  expect(null).toBeDefined();
  expect(undefined).not.toBeDefined();
  expect(NaN).toBeNaN();
  expect(0).not.toBeNaN();
  expect(thrown(() => expect(undefined).toBeNull())).toBe("expected undefined to be null");
});

test("regular expressions run on the JS engine", () => {
  expect("price: $5").toMatch(/(?<=\$)\d/);
  expect("abab").toMatch(/(ab)\1/);
  expect("2024-01-02").toMatch(/(?<year>\d{4})-\d\d/);
  expect("ba").not.toMatch(/a/y);
  expect(() => {
    throw new Error("price: $5");
  }).toThrow(/(?<=\$)\d/);
  expect(thrown(() => expect("abc").toMatch(/^b/))).toBe('expected "abc" to match /^b/');
});

test("toHaveLength reads strings, arrays and typed arrays", () => {
  expect("😀").toHaveLength(2);
  expect([1, 2]).toHaveLength(2);
  expect(new Uint8Array(3)).toHaveLength(3);
  expect(new Float32Array(4)).toHaveLength(4);
  expect(thrown(() => expect(new Uint8Array(2)).toHaveLength(3))).toBe(
    "expected Uint8Array [0,0] to have length 3",
  );
});

test("toMatchObject compares its leaves as toEqual does", () => {
  const value = { at: new Date(5), tags: new Set(["x"]), bytes: new Uint8Array([1]), n: NaN, extra: 1 };
  expect(value).toMatchObject({ at: new Date(5), tags: new Set(["x"]), bytes: new Uint8Array([1]), n: NaN });
  expect(value).not.toMatchObject({ at: new Date(6) });
  expect(value).toMatchObject({ bytes: { 0: 1 } });
  expect(value).not.toMatchObject({ missing: undefined });
});

test("toContain is ===, toContainEqual compares as toEqual does", () => {
  expect([{ id: 1 }]).not.toContain({ id: 1 });
  expect([{ id: 1 }]).toContainEqual({ id: 1 });
  expect(new Set(["a"])).toContain("a");
  expect(new Uint8Array([7])).toContain(7);
});

test("resolves and rejects compare what the promise settles to as JS made it", async () => {
  await expect(Promise.resolve(new Date(1))).resolves.toEqual(new Date(1));
  await expect(Promise.resolve(new Map([["a", 1]]))).resolves.not.toEqual(new Map([["a", 2]]));
  const o = {};
  await expect(Promise.resolve(o)).resolves.toBe(o);
  await expect(Promise.resolve({})).resolves.not.toBe({});
  await expect(Promise.resolve({ at: new Date(1), more: 1 })).resolves.toMatchObject({ at: new Date(1) });
  await expect(Promise.reject(new TypeError("price: $5"))).rejects.toThrow(/(?<=\$)\d/);
  await expect(Promise.reject(Object.assign(new Error("x"), { code: "E" }))).rejects.toMatchObject({ code: "E" });
  expect(await rejected(() => expect(Promise.resolve(new Date(1000))).resolves.toEqual(new Date(2000)))).toBe(
    "expected Date(1970-01-01T00:00:01.000Z) to equal Date(1970-01-01T00:00:02.000Z)",
  );
  expect(await rejected(() => expect(Promise.resolve(undefined)).resolves.toBe(null))).toBe(
    "expected undefined to be null",
  );
});
