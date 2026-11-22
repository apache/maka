// The browser host's hot module replacement runtime without a browser or
// nsh.wasm: `node --test crates/nsh-platform-web/web/browser/hot.test.mjs`.
// A small reactive graph stands in for the engine's.
import test from "node:test";
import assert from "node:assert/strict";
import { createHot } from "./hot.js";
import { createReactive } from "./reactive.js";
import { createKeymap } from "./keymap.js";

// Signals and lazily computed memos: enough to see a proxy render again
// when its version changes.
function fakeReactive() {
  let tracking = null;
  const signal = value => {
    const read = () => { tracking?.add(read); return value; };
    read.version = 0;
    read.set = next => { value = next; read.version++; };
    read.update = fn => read.set(fn(untracked(read)));
    return read;
  };
  const untracked = fn => { const outer = tracking; tracking = null; try { return fn(); } finally { tracking = outer; } };
  const computed = fn => {
    let deps = null, value;
    return () => {
      if (!deps || [...deps].some(([dep, version]) => dep.version !== version)) {
        const outer = tracking;
        const seen = tracking = new Set();
        try { value = fn(); } finally { tracking = outer; }
        deps = new Map([...seen].map(dep => [dep, dep.version]));
      }
      return value;
    };
  };
  return { signal, computed, untracked, batch: fn => fn() };
}

function setup() {
  const errors = [];
  const runtime = createHot(fakeReactive(), error => errors.push(error));
  return { runtime, hot: runtime.hot, errors };
}

// What `browser/dom.js` `mount` does with the hot runtime; `mounted` lists
// what is on screen.
function fakeMount(runtime) {
  const mounted = [];
  const mount = (App, props) => {
    const kept = runtime.reuse(App, props);
    if (kept) return kept;
    const entry = { App, out: App(props ?? {}) };
    mounted.push(entry);
    const dispose = () => { const at = mounted.indexOf(entry); if (at >= 0) mounted.splice(at, 1); };
    runtime.rendered(App, dispose);
    return dispose;
  };
  return { mount, mounted };
}

test("start runs dependencies first; an update reruns the changed module and its importers, dependencies first", () => {
  const { hot } = setup();
  const log = [];
  const natives = { nsh: { name: "native" } };
  let native, lib;
  hot.define("util.js", (module, exports) => { log.push("util 1"); exports.value = 1; });
  hot.define("lib.js", (module, exports, require) => {
    log.push("lib");
    const util = require("./util.js");
    exports.double = () => util.value * 2;
  });
  hot.define("App.js", (module, exports, require) => {
    log.push("App");
    native = require("nsh").name;
    lib = require("./lib.js");
  });
  hot.start("App.js", natives);
  assert.deepEqual(log, ["App", "lib", "util 1"]);
  log.length = 0;
  assert.equal(hot.update({ "util.js": (module, exports) => { log.push("util 2"); exports.value = 5; } }), true);
  // The changed module first, then those that cannot take it on their own.
  assert.deepEqual(log, ["util 2", "lib", "App"]);
  assert.equal(native, "native");
  assert.equal(lib.double(), 10);
});

test("an importer keeps the exports object: it forwards to the latest run's exports", () => {
  const { hot } = setup();
  let held;
  hot.define("data.js", (module, exports) => {
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.a = 1; exports.b = 2;
  });
  hot.define("App.js", (module, exports, require) => { held ??= require("./data.js"); });
  hot.start("App.js", {});
  assert.equal(held.a, 1);
  hot.update({ "data.js": (module, exports) => { exports.a = 10; exports.c = 3; } });
  assert.equal(held.a, 10);
  assert.equal(held.c, 3);
  assert.equal("b" in held, false);
  assert.deepEqual(Object.keys(held), ["a", "c"]);
});

test("a component module takes its own updates; its proxy stays and renders the new code", () => {
  const { hot, errors } = setup();
  let appRuns = 0, Button;
  const define = (label, sig) => (module, exports) => {
    exports.Button = hot.component("Button.js", "Button", props => `${label} ${props.n}`, sig);
  };
  hot.define("Button.js", define("one", "s1"));
  hot.define("App.js", (module, exports, require) => { appRuns++; Button = require("./Button.js").Button; });
  hot.start("App.js", {});
  const proxy = Button;
  const view = proxy({ n: 1 });
  assert.equal(proxy.name, "Button");
  assert.equal(view(), "one 1");
  assert.equal(hot.update({ "Button.js": define("two", "s2") }), true);
  // The importer did not run again: the module accepts its own update.
  assert.equal(appRuns, 1);
  assert.equal(Button, proxy);
  assert.equal(view(), "two 1");
  // The same signature: nothing renders again.
  hot.update({ "Button.js": define("three", "s2") });
  assert.equal(view(), "two 1");
  // A component that throws reports the error and renders nothing.
  hot.update({ "Button.js": (module, exports) => {
    exports.Button = hot.component("Button.js", "Button", () => { throw new Error("broken"); }, "s3");
  } });
  assert.equal(view(), undefined);
  assert.equal(errors[0].message, "broken");
  hot.update({ "Button.js": define("fixed", "s4") });
  assert.equal(view(), "fixed 1");
});

test("components of a module run again for a dependency render again with the same code", () => {
  const { hot } = setup();
  let View;
  hot.define("theme.js", (module, exports) => { exports.color = "red"; });
  hot.define("App.js", (module, exports, require) => {
    const theme = require("./theme.js");
    View = exports.View = hot.component("App.js", "View", () => theme.color, "same");
  });
  hot.start("App.js", {});
  const view = View({});
  assert.equal(view(), "red");
  hot.update({ "theme.js": (module, exports) => { exports.color = "blue"; } });
  assert.equal(view(), "blue");
});

test("keep returns the first value while the initializer's signature stays", () => {
  const { hot } = setup();
  const values = [];
  const make = sig => (module, exports) => { values.push(hot.keep("App.js", "count", sig, { made: values.length })); };
  hot.define("App.js", make("a"));
  hot.start("App.js", {});
  hot.update({ "App.js": make("a") });
  hot.update({ "App.js": make("b") });
  assert.equal(values[1], values[0]);
  assert.notEqual(values[2], values[0]);
  assert.equal(values[2].made, 2);
});

test("a context keeps its identity across runs and takes the new default", () => {
  const { hot } = setup();
  // `context()` reads its value with op 112; without a provider, the default.
  const reactive = createReactive((op, args) => (op === 112 ? args[1] : undefined), () => true);
  const contexts = [];
  const make = theme => (module, exports) => { contexts.push(hot.context("App.js", "Theme", reactive.context(theme))); };
  hot.define("App.js", make("light"));
  hot.start("App.js", {});
  assert.equal(contexts[0](), "light");
  hot.update({ "App.js": make("dark") });
  assert.equal(contexts[1], contexts[0]);
  assert.equal(contexts[0](), "dark");
});

test("a run keeps a mount of the same component and undoes the mounts it does not make again", () => {
  const { runtime, hot } = setup();
  const { mount, mounted } = fakeMount(runtime);
  const app = sig => (module, exports) => {
    const Root = hot.component("App.js", "mount#0", () => "root", sig);
    mount(Root);
  };
  hot.define("App.js", app("a"));
  hot.start("App.js", {});
  assert.equal(mounted.length, 1);
  const first = mounted[0];
  hot.update({ "App.js": app("b") });
  // The same proxy, no props: what it mounted stays.
  assert.deepEqual(mounted, [first]);
  // A run that mounts nothing undoes the mount.
  hot.update({ "App.js": () => {} });
  assert.deepEqual(mounted, []);
  // A run mounting another component replaces it; props mount anew.
  hot.update({ "App.js": app("c") });
  hot.update({ "App.js": (module, exports) => { mount(() => "other"); } });
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0].out, "other");
  hot.update({ "App.js": (module, exports) => { const Root = hot.component("App.js", "mount#0", () => "root", "c"); mount(Root, { a: 1 }); } });
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0].out(), "root");
});

test("top-level keyboard shortcuts are unbound before their module runs again", () => {
  const { runtime, hot } = setup();
  const tables = [];
  const invoke = (op, args) => { if (op === 451) tables.push(args[0].map(([text]) => text)); };
  const keymap = createKeymap(invoke, { getOwner: () => null }, { rootProp() {} }, {}, () => {}, runtime);
  const app = key => () => { keymap.bind(key, () => {}); };
  hot.define("App.js", app("mod+k"));
  hot.start("App.js", {});
  hot.update({ "App.js": app("mod+j") });
  assert.deepEqual(tables, [["mod+k"], [], ["mod+j"]]);
  // A binding undone by the app is forgotten.
  hot.update({ "App.js": () => { keymap.bind("mod+l", () => {})(); } });
  const sent = tables.length;
  hot.update({ "App.js": () => {} });
  assert.equal(tables.length, sent);
  // Outside a module's run, nothing is registered.
  assert.equal(runtime.undoOnRerun(() => {}), false);
});

test("apply reports an update that throws, and reports whether update applied", async () => {
  const { runtime, hot, errors } = setup();
  hot.define("App.js", (module, exports, require) => { require("./a.js"); });
  hot.define("a.js", () => {});
  hot.start("App.js", {});
  assert.equal(runtime.started, true);
  assert.equal(await runtime.apply(async () => { hot.update({ "a.js": () => { throw new Error("oops"); } }); }), true);
  assert.equal(errors[0].message, "oops");
  // Nothing calls update (the dev server's "nothing changed"): applied.
  assert.equal(await runtime.apply(async () => {}), true);
});
