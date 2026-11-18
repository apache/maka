import test from "node:test";
import assert from "node:assert/strict";
import { createChunkLoader } from "./loader.js";

test("chunk names resolve beside the entry and late completion rejects after disposal", async () => {
  let live = true, resolve, requested;
  const load = createChunkLoader("https://example.test/app/main.js", () => live, url => {
    requested = url;
    return new Promise(done => { resolve = done; });
  });
  const pending = load("Screen.js", ["shared.js"]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requested, "https://example.test/app/Screen.js");
  live = false; resolve({});
  await assert.rejects(pending, /disposed/);
  await assert.rejects(load("Another.js"), /disposed/);
});

test("native module loader retains identity and top-level await", async () => {
  const load = createChunkLoader("file:///unused/main.js", () => true);
  const url = "data:text/javascript,export const answer=await Promise.resolve(42)";
  const [a, b] = await Promise.all([load(url), load(url)]);
  assert.equal(a, b);
  assert.equal(a.answer, 42);
});

test("a chunk whose preparation or import failed is prepared and imported again by the next import", async () => {
  const prepared = [], imported = [];
  let failPrepare = true, failImport = true;
  const load = createChunkLoader("https://example.test/app/main.js", () => true, async url => {
    imported.push(url);
    if (failImport) { failImport = false; throw new TypeError("Failed to fetch dynamically imported module"); }
    return { url };
  }, async id => {
    prepared.push(id);
    if (failPrepare && id === "Screen.js") { failPrepare = false; throw new Error("fields.wasm: HTTP 503"); }
  });
  await assert.rejects(load("Screen.js", ["shared.js"]), /HTTP 503/);
  assert.deepEqual(imported, []);
  await assert.rejects(load("Screen.js", ["shared.js"]), /dynamically imported/);
  const module = await load("Screen.js", ["shared.js"]);
  assert.equal(module.url, "https://example.test/app/Screen.js");
  assert.deepEqual(prepared, ["Screen.js", "shared.js", "Screen.js", "shared.js", "Screen.js", "shared.js"]);
  assert.deepEqual(imported, Array(2).fill("https://example.test/app/Screen.js"));
});
