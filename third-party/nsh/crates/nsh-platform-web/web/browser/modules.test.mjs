import test from "node:test";
import assert from "node:assert/strict";
import { createModules } from "./modules.js";
import { Values } from "./values.js";

test("lifecycle disposal takes precedence over a class member named dispose", () => {
  const calls = [];
  const values = new Values();
  const invoke = (op, args) => {
    calls.push([op, args]);
    if (op === 200) return [{
      specifier: "test", modules: [], classes: [{ id: 0, name: "Resource", members: [
        { id: 0, name: "constructor", kind: "constructor" },
        { id: 1, name: "dispose", kind: "method" },
      ] }],
    }];
  };
  const modules = createModules(invoke, values, () => true, () => {});
  const object = new (modules.exports.get("test").Resource)();
  object.dispose();
  assert.equal(calls.at(-1)[0], 205);
  assert.equal(calls.at(-1)[1][0], object);
  if (Symbol.dispose) {
    object[Symbol.dispose]();
    assert.equal(calls.at(-1)[0], 205);
  }
  modules.dispose();
  values.dispose();
});
