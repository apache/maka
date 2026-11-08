// The browser runtime's `nsh/i18n` without nsh.wasm:
// `node --test crates/nsh-platform-web/web/browser/i18n.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createI18n } from "./i18n.js";

/** `nsh/i18n` on a stand-in graph and environment; `calls` records what
 * reaches the engine. */
function i18n() {
  const calls = [];
  let locale = "en-US", languages = ["en-US"];
  const reactive = {
    signal(value) {
      const read = () => value;
      read.set = next => { value = next; };
      read.update = update => read.set(update(value));
      return read;
    },
  };
  const env = { api: { locale: () => locale, localeSettings: () => ({ languages }) },
    showLocale(tag) { locale = tag; languages = [tag, ...languages]; } };
  const created = createI18n(reactive, (op, args) => { calls.push([op, ...args]); }, env);
  created.setup(JSON.stringify({ translations: {
    en: { hello: "Hello", greet: "Hello, %{name}!", "only.en": "English" },
    zh: { hello: "你好" },
    "zh-Hant": { hello: "妳好" },
  }, languages: {} }));
  return { ...created.api, calls, prefer(list) { languages = list; } };
}

test("keys fall back as rust-i18n does", () => {
  const { t, setLocale, availableLocales } = i18n();
  assert.equal(t("hello"), "Hello");
  assert.equal(t("hello", { locale: "zh-Hant-TW" }), "妳好");
  assert.equal(t("only.en", { locale: "zh-CN" }), "English");
  assert.equal(t("missing", { locale: "fr" }), "fr.missing");
  assert.equal(t("greet", { name: "Jason" }), "Hello, Jason!");
  setLocale("zh-CN");
  assert.equal(t("hello"), "你好");
  assert.deepEqual(availableLocales(), ["en", "zh", "zh-Hant"]);
});

test("text shows in the first preferred language the app has", () => {
  const { t, prefer } = i18n();
  prefer(["de-CH", "zh-Hant-TW", "en"]);
  assert.equal(t("hello"), "妳好");
  prefer(["fr"]);
  assert.equal(t("hello"), "Hello");
});

test("setLocale checks its tag and tells the engine", () => {
  const { setLocale, calls } = i18n();
  assert.throws(() => setLocale("not a tag"), RangeError);
  setLocale("de-at");
  setLocale(null);
  assert.deepEqual(calls.slice(1), [[408, "de-AT"], [408, null]]);
  assert.equal(calls[0][0], 407);
});

test("the browser serves every export of nsh-js's nsh/i18n", async () => {
  const source = await readFile(new URL("../../../nsh-js/src/i18n.rs", import.meta.url), "utf8");
  const start = source.indexOf("pub(crate) const EXPORTS: &[Item] = &[");
  const names = [...source.slice(start).matchAll(/\(\s*"(\w+)",\s*Export::/g)].map(m => m[1]);
  assert.deepEqual(Object.keys(i18n()).filter(k => !["calls", "prefer"].includes(k)).sort(), names.sort());
});
