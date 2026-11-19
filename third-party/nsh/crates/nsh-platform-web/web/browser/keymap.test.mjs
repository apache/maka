// The browser host's keymap without a browser or nsh.wasm:
// `node --test crates/nsh-platform-web/web/browser/keymap.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { createKeymap } from "./keymap.js";

test("a binding's options reach Rust's table: when, repeat, passThrough and forFocus", () => {
  const tables = [];
  const invoke = (op, args) => { if (op === 451) tables.push(args[0]); };
  const keymap = createKeymap(invoke, { getOwner: () => null }, { rootProp() {} }, {}, () => {});
  keymap.bind("space", () => {}, { forFocus: true });
  keymap.bind("mod+k", () => {}, { when: "always", repeat: true, passThrough: true });
  assert.deepEqual(tables.at(-1).map(([text, , when, repeat, passThrough, forFocus]) => [text, when, repeat, passThrough, forFocus]), [
    ["space", undefined, false, false, true],
    ["mod+k", "always", true, true, false],
  ]);
});
