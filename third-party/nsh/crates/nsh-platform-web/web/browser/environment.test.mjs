// The browser runtime's environment without nsh.wasm:
// `node --test crates/nsh-platform-web/web/browser/environment.test.mjs`.
// A stand-in reactive graph records what the environment writes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createEnvironment } from "./environment.js";

/** The environment on signals that count their writes (`writes`); `invoke`
 * stands in for the engine's calls. */
function environment(invoke = () => undefined) {
  const writes = [];
  const reactive = {
    signal(value) {
      const read = () => value;
      read.set = next => { writes.push(next); value = next; };
      read.update = update => read.set(update(value));
      return read;
    },
    untracked: fn => fn(),
    batch: fn => fn(),
    context: fn => fn,
  };
  const env = createEnvironment(reactive, invoke, { rootProp() {} });
  return { env, writes };
}

/** The locale settings the engine sends, `changes` over Vienna's. */
const settings = (changes = {}) => ({
  languages: ["de-AT", "en-US"], timeZone: "Europe/Vienna", hourCycle: "h23", firstDayOfWeek: 1,
  measurementSystem: "metric", temperatureUnit: "celsius", ...changes,
});

/** What the engine sends (`set_environment` in `src/browser/engine.rs`). */
const engine = (changes = {}) => ({
  window: { width: 390, height: 844 }, safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
  titleBar: { height: 0, left: 0, right: 0 }, keyboard: { height: 0, duration: 250 },
  colorScheme: "light", fontScale: 1, rtl: false, reduceMotion: false, pixelRatio: 2, screenReader: false,
  locale: "de-AT", host: false, lifecycle: "active", shaders: true, localeSettings: settings(),
  platform: { os: "web", version: "0.0", idiom: "desktop", desktop: true, appleKeyboard: false },
  ...changes,
});

/** The names a native module of nsh-js exports (`const <list>: &[Item]` in `src/env.rs`). */
function declared(source, list) {
  const start = source.indexOf(`pub(crate) const ${list}: &[Item] = &[`);
  assert.ok(start >= 0, `env.rs has no ${list}`);
  const items = source.slice(start, source.indexOf("\n];\n", start));
  return [...items.matchAll(/\(\s*"(\w+)",\s*Export::/g)].map(m => m[1]);
}

test("the environment serves every export of nsh/device and nsh/accessibility", async () => {
  const source = await readFile(new URL("../../../nsh-js/src/env.rs", import.meta.url), "utf8");
  const { env } = environment();
  const modules = { "nsh/device": declared(source, "DEVICE_EXPORTS"), "nsh/accessibility": declared(source, "ACCESSIBILITY_EXPORTS") };
  assert.ok(modules["nsh/device"].includes("lifecycle") && modules["nsh/accessibility"].includes("reduceMotion"), JSON.stringify(modules));
  // `runtime.js` serves `env.api` as `nsh`'s and `env.modules` as the
  // namespaces of those names: each has exactly what `env.rs` declares,
  // the same values as `nsh`'s.
  assert.deepEqual(Object.keys(env.modules ?? {}).sort(), Object.keys(modules).sort());
  for (const [specifier, names] of Object.entries(modules)) {
    const namespace = env.modules[specifier];
    assert.deepEqual(Object.keys(namespace).sort(), [...names].sort(), `the browser runtime's \`${specifier}\``);
    for (const name of names) {
      assert.ok(name in env.api, `the browser runtime's \`nsh\` has no \`${name}\``);
      assert.notEqual(namespace[name], undefined, `${specifier}'s \`${name}\``);
      assert.equal(namespace[name], env.api[name], `${specifier}'s \`${name}\` is nsh's`);
    }
  }
});

test("setTheme hands the theme to the engine and reads the tokens again once it took", () => {
  const calls = [];
  const theme = { cssVars: { light: { brand: "#e11d48" } } };
  const { env, writes } = environment((op, args) => {
    calls.push([op, args]);
    if (op === 406 && args[0]?.cssVars?.light?.brand === "#zz") throw new TypeError("setTheme: `brand`: #zz is no color");
  });
  env.api.setTheme(theme);
  env.api.setTheme(null);
  assert.deepEqual(calls, [[406, [theme]], [406, [null]]]);
  // One write of the tokens' version per theme taken.
  assert.deepEqual(writes, [1, 2]);
  // The engine's refusal reaches the app, and what read a token stays.
  assert.throws(() => env.api.setTheme({ cssVars: { light: { brand: "#zz" } } }), TypeError);
  assert.deepEqual(writes, [1, 2]);
});

test("the lifecycle is the engine's", () => {
  const { env } = environment();
  // Before the engine reports, the native environment's default.
  assert.equal(env.api.lifecycle(), "active");
  env.update(engine({ lifecycle: "background" }));
  assert.equal(env.api.lifecycle(), "background");
  env.update(engine({ lifecycle: "inactive" }));
  assert.equal(env.api.lifecycle(), "inactive");
});

test("whether shaders draw is the engine's", () => {
  const { env } = environment();
  // Before the engine reports, the native environment's default.
  assert.equal(env.api.shadersAvailable(), true);
  env.update(engine());
  assert.equal(env.api.shadersAvailable(), true);
  env.update(engine({ shaders: false }));
  assert.equal(env.api.shadersAvailable(), false);
});

test("the locale settings are the engine's", () => {
  const { env } = environment();
  // Before the engine reports, the native environment's defaults: en-US's
  // in UTC.
  assert.deepEqual(env.api.localeSettings(), {
    languages: ["en-US"], timeZone: "UTC", hourCycle: "h12", firstDayOfWeek: 7,
    measurementSystem: "us", temperatureUnit: "fahrenheit",
  });
  env.update(engine());
  assert.deepEqual(env.api.localeSettings(), settings());
});

test("a part is written only when it changed", () => {
  const { env, writes } = environment();
  env.update(engine());
  writes.length = 0;
  // The same values, in new objects and arrays, as each report has them.
  env.update(engine());
  assert.deepEqual(writes, []);
  env.update(engine({ lifecycle: "background" }));
  assert.deepEqual(writes, ["background"]);
  writes.length = 0;
  env.update(engine({ lifecycle: "inactive", locale: "fr-FR" }));
  assert.deepEqual(writes, ["fr-FR", "inactive"]);
  writes.length = 0;
  const tokyo = settings({ timeZone: "Asia/Tokyo" });
  env.update(engine({ lifecycle: "inactive", locale: "fr-FR", localeSettings: tokyo }));
  assert.deepEqual(writes, [tokyo]);
  // The same settings, in a new object with a new array of languages.
  writes.length = 0;
  env.update(engine({ lifecycle: "inactive", locale: "fr-FR", localeSettings: settings({ timeZone: "Asia/Tokyo" }) }));
  assert.deepEqual(writes, []);
  // A language fewer is a change, though the ones left are the same.
  const fewer = settings({ timeZone: "Asia/Tokyo", languages: ["de-AT"] });
  env.update(engine({ lifecycle: "inactive", locale: "fr-FR", localeSettings: fewer }));
  assert.deepEqual(writes, [fewer]);
});

test("setup hands over what appInfo reports, as the build wrote it", () => {
  const { env } = environment();
  assert.deepEqual(env.api.appInfo(), { id: null, name: null, version: null, build: null, development: false });
  env.setup(null, null, null, null, JSON.stringify({ id: "com.example.notes", name: "Notes", version: "1.2.0", build: 4, development: true }));
  assert.deepEqual(env.api.appInfo(), { id: "com.example.notes", name: "Notes", version: "1.2.0", build: 4, development: true });
  // The entry's own setup, without the fifth argument, keeps it.
  env.setup(null, null, null, null);
  assert.equal(env.api.appInfo().version, "1.2.0");
});
