import test from "node:test";
import assert from "node:assert/strict";
import { createDom } from "./dom.js";

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
