import test from "node:test";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import { Values, EXCEPTION } from "./values.js";

test("owned handles keep identity and reject stale generations", () => {
  const values = new Values();
  const object = { count: 1 };
  const first = values.put(object);
  values.retain(first);
  values.release(first);
  assert.equal(values.get(first), object);
  values.release(first);
  const second = values.put({ count: 2 });
  assert.notEqual(first, second);
  assert.throws(() => values.get(first), ReferenceError);
  assert.equal(values.retained, 1);
  values.release(second);
  assert.equal(values.retained, 0);
});

test("call frames release temporaries even when reentrant calls throw", () => {
  const values = new Values();
  assert.throws(() => values.with([{}, () => {}], outer => {
    values.with([values.get(outer[0])], inner => {
      assert.equal(values.get(inner[0]), values.get(outer[0]));
      throw new Error("callback failed");
    });
  }), /callback failed/);
  assert.equal(values.retained, 0);
});

test("getters preserve thrown errors across the Wasm boundary", () => {
  const values = new Values();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const { value } = values.imports(() => memory);
  const error = new TypeError("getter failure");
  const id = values.put({ get name() { throw error; } });
  new TextEncoder().encodeInto("name", new Uint8Array(memory.buffer));
  const result = value(9, id, 0, 4, 0);
  assert.equal(result, EXCEPTION);
  assert.throws(() => values.result(result), e => e === error);
  assert.equal(values.error, null);
  values.release(id);
  assert.equal(values.retained, 0);
});

test("memory growth refreshes the view and property writes cannot change prototypes", () => {
  const values = new Values();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const { value } = values.imports(() => memory);
  memory.grow(1);
  const text = "long-lived 🦀";
  const bytes = new TextEncoder().encode(text);
  new Uint8Array(memory.buffer, 70000, bytes.length).set(bytes);
  assert.equal(values.result(value(19, 0, 70000, bytes.length, 0)), text);
  values.with([{}, "__proto__", { polluted: true }], ([object, key, proto]) => {
    assert.equal(value(24, object, key, proto, 0), 0);
    assert.equal(Object.getPrototypeOf(values.get(object)), Object.prototype);
    assert.equal(values.get(object).__proto__, values.get(proto));
  });
  assert.equal(values.retained, 0);
});

test("exhausted generations are retired and disposal invalidates delayed work", () => {
  const values = new Values();
  values.slots.push({ value: {}, refs: 1, generation: 4095 });
  const last = ((4095 << 20) | 4) >>> 0;
  values.release(last);
  const next = values.put({});
  assert.equal(next, 5);
  values.dispose();
  values.dispose();
  values.release(next);
  assert.throws(() => values.get(next), /disposed/);
  assert.throws(() => values.put({}), /disposed/);
  assert.equal(values.retained, 0);
});


test("bytes and dates cross app realms without relying on instanceof", () => {
  const values = new Values();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const { value } = values.imports(() => memory);
  const foreign = runInNewContext("({ bytes: new Uint8Array([1, 2, 255]), date: new Date(123456) })");
  values.with([foreign.bytes, foreign.date, new Uint16Array(2), {}], ([bytes, date, wrong, object]) => {
    assert.equal(value(5, bytes, 0, 0, 0), 3);
    value(6, bytes, 0, 3, 0);
    assert.deepEqual([...new Uint8Array(memory.buffer, 0, 3)], [1, 2, 255]);
    assert.equal(value(11, date, 0, 0, 0), 123456);
    assert.ok(Number.isNaN(value(5, wrong, 0, 0, 0)));
    assert.ok(Number.isNaN(value(11, object, 0, 0, 0)));
  });
});

test("every value operation has a code of its own", async () => {
  // Two cases of one code: only the first runs (op 48 made a function
  // where Rust asked for an object's keys).
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./values.js", import.meta.url), "utf8");
  const codes = [...source.matchAll(/^\s*case (\d+):/gm)].map(m => Number(m[1]));
  assert.deepEqual(codes.filter((code, i) => codes.indexOf(code) !== i), []);
  const values = new Values();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const { value } = values.imports(() => memory);
  values.makeFunction = () => { throw new Error("not a function's id"); };
  const keys = value(50, values.put({ a: 1, b: 2 }), 0, 0, 0);
  assert.equal(values.get(keys), "a\0b");
});
