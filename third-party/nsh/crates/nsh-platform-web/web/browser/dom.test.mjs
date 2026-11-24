import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDom } from "./dom.js";

/** The methods of nsh-js's nodes (`NODE_METHODS` in `src/dom.rs`). */
async function nativeNodeMethods() {
  const source = await readFile(new URL("../../../nsh-js/src/dom.rs", import.meta.url), "utf8");
  const start = source.indexOf("pub(crate) const NODE_METHODS: ");
  assert.ok(start >= 0, "dom.rs has no NODE_METHODS");
  const items = source.slice(start, source.indexOf("\n];\n", start));
  return [...items.matchAll(/\(\s*"(\w+)",\s*\d+,/g)].map(m => m[1]);
}

test("a node has every method of the native backends' nodes", async () => {
  const names = await nativeNodeMethods();
  assert.ok(names.includes("focus") && names.includes("animateLayout"), JSON.stringify(names));
  const values = { nodeIds: new WeakMap(), nodes: new Map() };
  createDom(() => { throw new Error("unexpected native operation"); }, values, { getOwner: () => null }, () => false, () => {});
  const node = values.makeNode(2);
  for (const name of names) assert.equal(typeof node[name], "function", `a node's \`${name}\``);
});

test("animateLayout sends the node a layout animation with the transition as its update phase", () => {
  const values = { nodeIds: new WeakMap(), nodes: new Map() };
  const calls = [];
  createDom((op, args) => { calls.push([op, args]); }, values, { getOwner: () => null }, () => true, () => {});
  const view = values.makeNode(2);
  const transition = { type: "bezier", bezier: [0.2, 0, 0, 1], duration: 320 };
  view.animateLayout(transition);
  view.animateLayout();
  view.animateLayout(300);
  assert.deepEqual(calls, [
    [314, [2, "layoutAnimation", { update: transition }]],
    [314, [2, "layoutAnimation", { update: {} }]],
    [314, [2, "layoutAnimation", { update: {} }]],
  ]);
  assert.throws(() => view.animateLayout.call({}, transition), TypeError);
});

test("WebView evaluate returns rejected promises on the browser backend", async () => {
  const values = { nodeIds: new WeakMap(), nodes: new Map() };
  createDom(() => { throw new Error("unexpected native operation"); }, values, { getOwner: () => null }, () => false, () => {});
  const web = values.makeNode(2);
  const unsupported = web.evaluate("document.title");
  assert.ok(unsupported instanceof Promise);
  await assert.rejects(unsupported, { code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" });
  await assert.rejects(web.evaluate(42), TypeError);
  await assert.rejects(web.evaluate.call(null, "1"), TypeError);
  await assert.rejects(web.evaluate("1", 5), TypeError);
});


test("imported assets retain app names and scope raw filenames to the package", () => {
  const values = { nodeIds: new WeakMap(), nodes: new Map() };
  const { rt } = createDom(() => { throw new Error("unexpected native operation"); }, values, { getOwner: () => null }, () => false, () => {});
  assert.equal(rt.assetUrl("asset:/shared/icon #?.svg", undefined), "asset:/shared/icon #?.svg");
  assert.equal(rt.assetUrl("asset:/shared/icon #?.svg", "asset:/plugin/one/ui/"), "asset:/plugin/one/ui/shared/icon%20%23%3F.svg");
  assert.equal(rt.assetUrl("asset:/shared/icon #?.svg", "asset:/plugin/two/ui/"), "asset:/plugin/two/ui/shared/icon%20%23%3F.svg");
  assert.equal(rt.assetUrl("asset:/a%20b.svg", "https://example.com/package/"), "https://example.com/package/a%2520b.svg");
  assert.throws(() => rt.assetUrl("asset:/x", "mailto:someone@example.com"), TypeError);
});
