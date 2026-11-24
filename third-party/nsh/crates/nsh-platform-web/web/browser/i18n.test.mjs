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

test("addTranslations merges locales, updates keys, and notifies the engine", () => {
  const { t, availableLocales, addTranslations, calls } = i18n();
  addTranslations({});
  assert.equal(calls.length, 1);

  addTranslations({
    en: { hello: "Hi", extra: "Loaded" },
    fr: { hello: "Bonjour" },
  });
  assert.equal(t("hello"), "Hi");
  assert.equal(t("extra"), "Loaded");
  assert.equal(t("only.en"), "English");
  assert.equal(t("greet", { name: "Ada" }), "Hello, Ada!");
  assert.equal(t("hello", { locale: "fr" }), "Bonjour");
  assert.equal(t("hello", { locale: "zh" }), "你好");
  assert.deepEqual(availableLocales(), ["en", "fr", "zh", "zh-Hant"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], 409);
  assert.deepEqual(JSON.parse(calls[1][1]), {
    en: { hello: "Hi", extra: "Loaded" },
    fr: { hello: "Bonjour" },
  });

  for (const bad of [null, undefined, "en", 42, [], { en: null }, { en: [] }, { en: { hello: 123 } }]) {
    assert.throws(() => addTranslations(bad), TypeError);
  }
  assert.equal(calls.length, 2);
});

test("the browser serves every export of nsh-js's nsh/i18n", async () => {
  const source = await readFile(new URL("../../../nsh-js/src/i18n.rs", import.meta.url), "utf8");
  const start = source.indexOf("pub(crate) const EXPORTS: &[Item] = &[");
  const names = [...source.slice(start).matchAll(/\(\s*"(\w+)",\s*Export::/g)].map(m => m[1]);
  assert.deepEqual(Object.keys(i18n()).filter(k => !["calls", "prefer"].includes(k)).sort(), names.sort());
});
