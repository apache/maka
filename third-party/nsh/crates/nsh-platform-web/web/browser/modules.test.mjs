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

test("refresh adds what a gate registered after the start to the same namespace", () => {
  const values = new Values();
  const describes = [
    [{ specifier: "nsh/base", modules: [{ name: "a", flat: true, default: false, constants: {}, functions: [{ id: 0, name: "first", getter: false, promise: false }] }], classes: [] }],
    [{ specifier: "nsh/base", modules: [{ name: "b", flat: true, default: false, constants: {}, functions: [{ id: 1, name: "second", getter: false, promise: false }] }], classes: [] },
      { specifier: "app/native", modules: [{ name: "c", flat: true, default: false, constants: { answer: 42 }, functions: [] }], classes: [] }],
  ];
  const calls = [];
  const invoke = (op, args) => {
    if (op === 200) return describes.shift();
    calls.push([op, args[0]]);
    return op;
  };
  const modules = createModules(invoke, values, () => true, () => {});
  const base = modules.exports.get("nsh/base");
  assert.equal(typeof base.first, "function");
  assert.equal(base.second, undefined);
  modules.refresh();
  assert.equal(modules.exports.get("nsh/base"), base);
  assert.equal(typeof base.first, "function");
  base.second();
  assert.deepEqual(calls.at(-1), [201, 1]);
  assert.equal(modules.exports.get("app/native").answer, 42);
  modules.dispose();
  values.dispose();
});
