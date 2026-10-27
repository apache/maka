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
