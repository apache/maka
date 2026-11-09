// nsh.js's host channel without a browser or nsh.wasm:
// `node --test crates/nsh-platform-web/web/nsh.test.mjs`. A fake engine
// records what reaches it through the real `call` / `withStrings` path.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("nsh.js", import.meta.url), "utf8");
// `Player` is not exported; the page only gets it from `createPlayer`.
const { Player, keyCode } = await import(
  `data:text/javascript,${encodeURIComponent(`${source}\nexport { Player, keyCode };`)}`
);

/** A player on a fake engine; `sent` holds `[name, payload]` of the events it got. */
function fakePlayer(options = {}) {
  const sent = [];
  const memory = { buffer: new ArrayBuffer(1 << 16) };
  let next = 8;
  const text = (ptr, len) => new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
  const player = Object.create(Player.prototype);
  Object.assign(player, {
    // What the constructor sets that these paths read.
    options: { idiom: "phone", ...options },
    baseURL: "https://example.test/app/",
    assetBase: "https://example.test/app/",
    assets: options.assets,
    data: options.data,
    inlineImages: new Map(),
    hostEvents: [],
    fileOperations: new Map(),
    requests: new Map(),
    websockets: new Map(),
    environment: () => ({}),
    updateRootClasses() {},
    wasm: {
      memory,
      nsh_alloc(len) {
        const ptr = next;
        next += len;
        return ptr;
      },
      nsh_dealloc() {},
      nsh_stop() {},
      nsh_event(_id, np, nl, pp, pl) {
        sent.push([text(np, nl), JSON.parse(text(pp, pl))]);
        return -1;
      },
    },
  });
  return { player, sent };
}

const started = () => -1;
const failing = () => {
  throw new Error("unreachable");
};
const events = (sent) =>
  sent.filter(([name, p]) => name === "onHost" && p.type === "event").map(([, p]) => p.event);

test("keyboard context menus have no pointer even when Chromium names a mouse", () => {
  const { player } = fakePlayer();
  const el = {
    _id: 2,
    _events: new Set(["onContextMenu"]),
    getBoundingClientRect: () => ({ left: 10, right: 90, top: 20, bottom: 60 }),
  };
  player.viewOf = () => el;
  player.ancestors = () => [el];
  player.point = (at) => [at.clientX, at.clientY];
  let payload;
  player.event = (_, name, value) => { assert.equal(name, "onContextMenu"); payload = value; };
  const saved = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ direction: "ltr" });
  try {
    for (const [pointerType, button, keyboard] of [
      ["mouse", -1, true],
      ["", -1, true],
      ["", 0, true],
      ["mouse", 2, false],
      [undefined, 2, false],
      ["mouse", 0, false],
    ]) {
      let prevented = false;
      assert.equal(player.contextMenu({
        target: el, pointerType, button, clientX: 40, clientY: 30,
        preventDefault() { prevented = true; },
      }), true);
      assert.equal(prevented, true);
      assert.equal(payload.pointerType, keyboard ? null : "mouse");
      assert.deepEqual(payload.pagePosition, keyboard ? { x: 10, y: 60 } : { x: 40, y: 30 });
    }
  } finally {
    globalThis.getComputedStyle = saved;
  }
});

test("input autofill hints are set, changed and cleared on both field kinds", () => {
  const { player } = fakePlayer();
  const attrs = new Map();
  const field = {
    classList: { toggle() {} },
    setAttribute: (name, value) => attrs.set(name, value),
    removeAttribute: (name) => attrs.delete(name),
  };
  const el = { _field: field };
  player.view = () => el;
  for (const multiline of [false, true]) {
    field.tagName = multiline ? "TEXTAREA" : "INPUT";
    const config = { multiline };
    const update = () => player.op_in(["in", 1, config, null]);
    update();
    assert.equal(attrs.has("autocomplete"), false, "the browser decides by default");
    for (const token of ["username", "current-password", "new-password", "one-time-code", "off"]) {
      config.autoComplete = token;
      update();
      assert.equal(attrs.get("autocomplete"), token);
    }
    delete config.autoComplete;
    update();
    assert.equal(attrs.has("autocomplete"), false, "returning to default clears the hint");
  }
});

test("events sent before the app runs reach it in order once it starts, later ones at once", () => {
  const { player, sent } = fakePlayer();
  player.hostEvent("a", 1);
  player.hostEvent("b", 2);
  assert.deepEqual(sent, []);
  player.begin(390, started);
  assert.deepEqual(sent, [
    ["onHost", { type: "event", event: "a", payload: 1 }],
    ["onHost", { type: "event", event: "b", payload: 2 }],
  ]);
  player.hostEvent("c");
  assert.deepEqual(events(sent), ["a", "b", "c"]);
});

test("events for an app that failed to start reach neither it nor the next app", () => {
  const { player, sent } = fakePlayer();
  player.hostEvent("before");
  assert.throws(() => player.begin(390, failing));
  player.hostEvent("after");
  player.begin(390, started);
  player.hostEvent("next");
  assert.deepEqual(events(sent), ["next"]);
});

test("a replacing app that fails to start gets no events", () => {
  const { player, sent } = fakePlayer();
  player.begin(390, started);
  assert.throws(() => player.begin(390, failing));
  player.hostEvent("lost");
  assert.deepEqual(events(sent), []);
});

test("events sent while a replacing app starts reach it once it has started", () => {
  const { player, sent } = fakePlayer();
  player.begin(390, started);
  let during;
  player.begin(390, () => {
    player.hostEvent("early");
    during = events(sent).length;
    return -1;
  });
  assert.equal(during, 0);
  assert.deepEqual(events(sent), ["early"]);
});

test("events sent after the app stopped wait for the next app", () => {
  // `stop` cancels the frame it asked for; node has no frames.
  globalThis.cancelAnimationFrame ??= () => {};
  const { player, sent } = fakePlayer();
  player.begin(390, started);
  player.hostEvent("running");
  player.stop();
  player.hostEvent("stopped");
  assert.deepEqual(events(sent), ["running"]);
  player.begin(390, started);
  assert.deepEqual(events(sent), ["running", "stopped"]);
});

const trap = () => {
  throw new WebAssembly.RuntimeError("unreachable");
};

test("an engine that trapped takes no more calls, nor the ones it deferred", () => {
  const { player } = fakePlayer();
  const reached = [];
  assert.throws(
    () =>
      player.call(() => {
        player.call(() => reached.push("deferred"));
        trap();
      }),
    WebAssembly.RuntimeError,
  );
  player.call(() => reached.push("later"));
  assert.deepEqual(reached, []);
});

test("an error that is not a trap leaves the engine taking calls", () => {
  const { player } = fakePlayer();
  const reached = [];
  assert.throws(() => player.call(failing));
  player.call(() => {
    reached.push("later");
    return -1;
  });
  assert.deepEqual(reached, ["later"]);
});

test("the overlay keeps the first panic, whichever entry the next one comes from", () => {
  const { player } = fakePlayer();
  const shown = [];
  const box = { replaceChildren: (_copy, message) => shown.push(message) };
  player.root = { querySelector: () => box, append() {} };
  const document = globalThis.document;
  globalThis.document = { createElement: () => ({ addEventListener() {} }) };
  const error = console.error;
  console.error = () => {};
  try {
    player.reportPanic("nsh panicked: the real one");
    // The engine is left borrowed: an app's own timer calling into it in
    // the browser runtime panics again, and the engine reports an error.
    player.reportPanic("nsh panicked: RefCell already borrowed");
    player.showError("a later error");
  } finally {
    globalThis.document = document;
    console.error = error;
  }
  assert.deepEqual(shown, ["nsh panicked: the real one"]);
  const reached = [];
  player.call(() => reached.push("later"));
  assert.deepEqual(reached, []);
});

async function reply(host) {
  const { player, sent } = fakePlayer(host === undefined ? {} : { host });
  player.app = 1;
  await player.hostCall(7, "echo", ["x"]);
  return sent;
}

test("a host call that returns answers ok with its value", async () => {
  assert.deepEqual(await reply({ call: async (name, args) => ({ name, args }) }), [
    ["onHost", { type: "reply", id: 7, ok: true, value: { name: "echo", args: ["x"] } }],
  ]);
});

test("a host call that throws answers not ok with its message", async () => {
  const host = {
    call() {
      throw new Error("boom");
    },
  };
  assert.deepEqual(await reply(host), [["onHost", { type: "reply", id: 7, ok: false, error: "boom" }]]);
});

test("a host call that rejects answers not ok with its message", async () => {
  const host = { call: () => Promise.reject(new Error("denied")) };
  assert.deepEqual(await reply(host), [["onHost", { type: "reply", id: 7, ok: false, error: "denied" }]]);
});

test("a host call that rejects with a non-Error answers its string", async () => {
  const host = { call: () => Promise.reject("nope") };
  assert.deepEqual(await reply(host), [["onHost", { type: "reply", id: 7, ok: false, error: "nope" }]]);
});

test("a host call whose result is not JSON answers not ok", async () => {
  const [[name, payload]] = await reply({ call: () => 1n });
  assert.equal(name, "onHost");
  assert.equal(payload.type, "reply");
  assert.equal(payload.ok, false);
  assert.match(payload.error, /BigInt/);
});

test("a page without a host answers not ok", async () => {
  assert.deepEqual(await reply(undefined), [
    ["onHost", { type: "reply", id: 7, ok: false, error: "this page has no host (createPlayer's `host`)" }],
  ]);
});

test("a host reply for an app that was replaced is dropped", async () => {
  const { player, sent } = fakePlayer({ host: { call: () => Promise.reject(new Error("late")) } });
  player.app = 1;
  const pending = player.hostCall(7, "echo", []);
  player.app = 2;
  await pending;
  assert.deepEqual(sent, []);
});

test("a browser-cancelled pan reports cancellation rather than a release", () => {
  for (const [cancelled, phase] of [[true, 3], [false, 2]]) {
    const { player } = fakePlayer();
    const sent = [];
    player.pointers = new Map([[7, {
      mode: "pan", pan: { _id: 12 }, touchPath: [], states: [],
      startX: 10, startY: 20, x: 10, y: 120,
    }]]);
    player.track = () => {};
    player.velocity = () => [0, 400];
    player.call = (f) => f({ nsh_pan: (...args) => sent.push(args) });
    player.pointerUp({ pointerId: 7 }, cancelled);
    assert.deepEqual(sent, [[12, phase, 0, 100, 0, 400]]);
    assert.equal(player.pointers.size, 0);
  }
});

test("a face registered while another loads keeps the app hidden until both have loaded", async () => {
  const { player } = fakePlayer();
  const classes = new Set();
  player.root = {
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
  };
  player.starting = true;
  player.metricsCache = new Map();
  let loaded = 0;
  player.call = (f) => f({ nsh_fonts_loaded: () => loaded++ });
  const face = () => {
    let resolve;
    const loading = new Promise((r) => (resolve = r));
    return { loading, resolve };
  };
  const first = face();
  const second = face();
  player.fontLoading(first.loading);
  player.fontLoading(second.loading);
  first.resolve();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(loaded, 0);
  assert.ok(classes.has("nsh-hidden"));
  second.resolve();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(loaded, 1);
  assert.ok(!classes.has("nsh-hidden"));
  clearTimeout(player.fontTimer);
});

test("compileAndRun hands the compiled module to runSource, or returns the compile error", async () => {
  const { player } = fakePlayer();
  const ran = [];
  player.compile = (source) => (source === "bad" ? { error: "1 | bad" } : { code: `compiled ${source}` });
  player.browserHost = { runSource: async (code, options) => { ran.push([code, options]); } };
  assert.equal(await player.compileAndRun("bad"), "1 | bad");
  assert.equal(await player.compileAndRun("good", "Demo.tsx", { appId: "demo" }), null);
  assert.deepEqual(ran, [["compiled good", { appId: "demo", capabilities: "", sourceMap: "", name: "Demo.tsx" }]]);
});

test("hotUpdate goes to the browser host, and is not applied without one", async () => {
  const { player } = fakePlayer();
  assert.equal(await player.hotUpdate("__nsh_hot.update({});"), false);
  const updates = [];
  player.browserHost = { hotUpdate: async (...args) => { updates.push(args); return true; } };
  assert.equal(await player.hotUpdate("code", "hot-2.js", null), true);
  assert.deepEqual(updates, [["code", "hot-2.js", ""]]);
});

/** A view element as `updateFocusable` and `keyDown` see it. */
function focusView(pressable, props) {
  const attrs = new Map();
  return {
    _pressable: pressable,
    _props: props,
    _events: new Set(pressable ? ["onPress"] : []),
    _tracked: 0,
    listeners: [],
    set tabIndex(v) {
      attrs.set("tabindex", String(v));
    },
    get tabIndex() {
      return Number(attrs.get("tabindex") ?? -1);
    },
    hasAttribute: (name) => attrs.has(name),
    removeAttribute: (name) => attrs.delete(name),
    addEventListener(type) {
      this.listeners.push(type);
    },
    closest: () => null,
    blur() {
      this.blurred = true;
    },
  };
}

test("Tab stops are the pressables and the focusable views, pressable or not", () => {
  const { player } = fakePlayer();
  player.updateAria = () => {};
  globalThis.document = { activeElement: null };
  const stop = (pressable, props) => {
    const el = focusView(pressable, props);
    player.updateFocusable(el);
    return el.hasAttribute("tabindex") ? el.tabIndex : null;
  };
  assert.equal(stop(true, {}), 0, "a pressable");
  assert.equal(stop(false, { focusable: true }), 0, "focusable without presses");
  assert.equal(stop(false, {}), null, "neither");
  assert.equal(stop(false, undefined), null, "no props yet");
  assert.equal(stop(true, { focusable: false }), null, "kept out");
  assert.equal(stop(false, { focusable: true, disabled: true }), null, "disabled");
  assert.equal(stop(false, { focusable: true, hidden: true }), null, "hidden");
  // Its focus and blur follow the keyboard focus, as a pressable's do.
  const chart = focusView(false, { focusable: true });
  player.updateFocusable(chart);
  assert.deepEqual(chart.listeners, ["focus", "blur"]);
  // No longer a stop with the focus on it: it gives the focus up.
  document.activeElement = chart;
  chart._props = {};
  player.updateFocusable(chart);
  assert.equal(chart.hasAttribute("tabindex"), false);
  assert.equal(chart.blurred, true);
  delete globalThis.document;
});

test("Return presses a focused pressable, not a focused stop that takes no presses", () => {
  const { player } = fakePlayer();
  player.wasm.nsh_key = () => -1;
  player.modifiersChanged = () => {};
  player.takesKeys = () => true;
  player.selectionKey = () => false;
  player.scrollKey = () => false;
  player.back = () => false;
  player.ancestors = () => [];
  const pressed = [];
  player.pressIn = (p) => pressed.push(p.press);
  player.pressOut = () => {};
  player.root = { contains: () => true };
  const key = (focus) => {
    globalThis.document = { activeElement: focus };
    let prevented = false;
    player.keyDown({ key: "Enter", preventDefault: () => (prevented = true), stopPropagation() {} });
    delete globalThis.document;
    return prevented;
  };
  const button = focusView(true, {});
  const chart = focusView(false, { focusable: true });
  assert.equal(key(button), true);
  assert.deepEqual(pressed, [button]);
  assert.equal(key(chart), false);
  assert.deepEqual(pressed, [button]);
});

/**
 * Runs `f` in a page with a window of 1280 × 720 whose system UI covers 44
 * points at the top and 34 at the bottom; `f` gets the `ResizeObserver`s
 * made meanwhile.
 */
function inPage(f) {
  const observers = [];
  const page = {
    innerWidth: 1280,
    innerHeight: 720,
    getComputedStyle: () => ({ paddingTop: "44px", paddingRight: "0px", paddingBottom: "34px", paddingLeft: "0px" }),
    getSelection: () => null,
    document: { activeElement: null, body: {} },
    requestAnimationFrame: () => 0,
    ResizeObserver: class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
      unobserve() {}
    },
  };
  Object.assign(globalThis, page);
  try {
    f(observers);
  } finally {
    for (const name of Object.keys(page)) delete globalThis[name];
  }
}

/**
 * A player presenting dialogs over the window (`viewportDialogs`) or over
 * its container: 320 × 240 at (100, 400) in the window. `reported` holds
 * what `nsh_root_size` got.
 */
function dialogPlayer(viewportDialogs) {
  const { player, sent } = fakePlayer();
  const reported = [];
  player.wasm.nsh_root_size = (...args) => {
    reported.push(args);
    return -1;
  };
  Object.assign(player, {
    viewportDialogs,
    size: [320, 240],
    safeProbe: {},
    pointers: new Map(),
    root: {
      getBoundingClientRect: () => ({ left: 100, top: 400, right: 420, bottom: 640 }),
      // Moving a popover in the DOM takes it out of the top layer.
      append: (el) => el.hidePopover(),
      contains: () => false,
    },
    scopeFocus() {},
    syncHistorySoon() {},
    dropLeftWith() {},
  });
  return { player, sent, reported };
}

/**
 * A modal's (or an alert's) element, `width` × `height` while it is in the
 * top layer, where the CSS sizes it; `shown` logs each time it goes there.
 */
function dialogView(id, width, height, shown = []) {
  const classes = new Set();
  let open = false;
  return {
    _id: id,
    _kind: "modal",
    style: {},
    isConnected: true,
    listeners: [],
    classList: { add: (name) => classes.add(name), contains: (name) => classes.has(name) },
    setAttribute() {},
    addEventListener(type, _listener, options) {
      this.listeners.push([type, options]);
    },
    get clientWidth() {
      return open ? width : 0;
    },
    get clientHeight() {
      return open ? height : 0;
    },
    matches: (selector) => selector === ":popover-open" && open,
    showPopover() {
      open = true;
      shown.push(id);
    },
    hidePopover() {
      open = false;
    },
    resize(w, h) {
      [width, height] = [w, h];
    },
  };
}

test("a dialog over the window lays out at the window's size and safe area, wherever the container is", () => {
  inPage(() => {
    const { player, reported } = dialogPlayer(true);
    const dialog = dialogView(7, 1280, 720);
    player.present(dialog);
    assert.deepEqual(reported, [[7, 1280, 720, 44, 0, 34, 0]]);
    assert.equal(dialog.popover, "manual");
    assert.ok(dialog.classList.contains("nsh-viewport"));
    // The browser waits for blocking wheel listeners only over the boxes of
    // the elements that have them: the layer needs one of its own.
    assert.deepEqual(dialog.listeners, [["wheel", { passive: false }]]);
    // The CSS places it: no frame of the container's.
    assert.equal(dialog.style.width, undefined);
    assert.equal(dialog.style.transform, "translateY(720px)", "it slides in from the window's bottom edge");
  });
});

test("a dialog over the container keeps the container's size, place and safe area", () => {
  inPage(() => {
    const { player, reported } = dialogPlayer(false);
    const dialog = dialogView(7, 1280, 720);
    player.present(dialog);
    assert.deepEqual(reported, [[7, 320, 240, 0, 0, 0, 0]]);
    assert.equal(dialog.popover, undefined);
    const s = dialog.style;
    assert.deepEqual([s.left, s.top, s.width, s.height], ["0px", "0px", "320px", "240px"]);
    assert.equal(s.transform, "translateY(240px)");
  });
});

test("a dialog over the window follows the window's size, scroll bars included", () => {
  inPage((observers) => {
    const { player, reported } = dialogPlayer(true);
    const dialog = dialogView(7, 1280, 720);
    player.present(dialog);
    const [observer] = observers;
    // The page grew a scroll bar: no `resize`, a narrower top layer.
    dialog.resize(1265, 720);
    observer.callback([{ target: dialog }]);
    assert.deepEqual(reported.at(-1), [7, 1265, 720, 44, 0, 34, 0]);
    observer.callback([{ target: dialog }]);
    assert.equal(reported.length, 2, "an unchanged size is not reported again");
    dialog._leaving = true;
    dialog.resize(800, 600);
    observer.callback([{ target: dialog }]);
    assert.equal(reported.length, 2, "nor is a leaving dialog's");
  });
});

test("alerts stay above a dialog presented over the window after them", () => {
  inPage(() => {
    const shown = [];
    const { player } = dialogPlayer(true);
    const alert = dialogView(2, 1280, 720, shown);
    player.raise(alert);
    player.dialogs = [alert];
    player.present(dialogView(7, 1280, 720, shown));
    assert.deepEqual(shown, [2, 7, 2]);
  });
});

test("a press in a dialog over the window reports its place in the window", () => {
  inPage(() => {
    for (const [viewport, pagePosition] of [[true, { x: 642, y: 321 }], [false, { x: 542, y: -79 }]]) {
      const { player, sent } = dialogPlayer(viewport);
      const dialog = dialogView(7, 1280, 720);
      const button = {
        _id: 9,
        _events: new Set(["onPress"]),
        _props: {},
        _tracked: 0,
        getBoundingClientRect: () => ({ left: 600, top: 300, right: 700, bottom: 340 }),
        closest: (selector) => (selector === ".nsh-modal.nsh-viewport" ? dialog : null),
      };
      player.editable = () => false;
      player.viewOf = () => button;
      player.ancestors = () => [button];
      player.pointerDown({ pointerId: 1, pointerType: "touch", button: 0, clientX: 640, clientY: 320, target: button });
      // Released elsewhere on the page: still in the dialog's coordinates.
      player.pointerUp({ pointerId: 1, clientX: 642, clientY: 321, target: {} }, false);
      const [, payload] = sent.find(([name]) => name === "onPress");
      assert.deepEqual(payload.position, { x: 42, y: 21 });
      assert.deepEqual(payload.pagePosition, pagePosition);
    }
  });
});

test("the page does not scroll under a dialog or an alert over the window", () => {
  const cases = [
    [true, true, true],
    [true, false, false],
    [false, true, false],
  ];
  for (const [viewport, onDialog, prevented] of cases) {
    const { player } = dialogPlayer(viewport);
    player.scrollChain = () => [];
    const target = { closest: (selector) => (onDialog && selector === ".nsh-viewport" ? {} : null) };
    let wasPrevented = false;
    const e = { deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: false, shiftKey: false, target };
    player.wheel({ ...e, preventDefault: () => (wasPrevented = true) });
    assert.equal(wasPrevented, prevented, `viewport ${viewport}, on a dialog ${onDialog}`);
  }
});

/** A fake engine's `nsh_data`: what was handed over, as `[name, bytes, ok]`. */
function dataSink(player) {
  const handed = [];
  player.wasm.nsh_data = (np, nl, dp, dl, ok) => {
    handed.push([player.str(np, nl), [...player.bytes(dp, dl)], ok]);
    return -1;
  };
  return handed;
}

/** Runs `f` with `fetch` answering `respond(url)`; the URLs it was asked for. */
async function withFetch(respond, f) {
  const fetched = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return respond(url);
  };
  try {
    await f();
  } finally {
    globalThis.fetch = saved;
  }
  return fetched;
}

test("the runtime's data comes from the URL the page names and reaches the engine", async () => {
  const { player } = fakePlayer({ data: { syntaxes: "https://example.test/nsh-syntaxes.0123456789.bin" } });
  const handed = dataSink(player);
  const fetched = await withFetch(
    () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
    () => player.loadData("syntaxes"),
  );
  assert.deepEqual(fetched, ["https://example.test/nsh-syntaxes.0123456789.bin"]);
  assert.deepEqual(handed, [["syntaxes", [1, 2, 3], 1]]);
});

test("relative URLs are the page's as the player started", () => {
  const { player } = fakePlayer({ assets: { "logo.png": "https://cdn.test/logo.0123456789.png" } });
  // The address has moved to another directory since (`history.pushState`).
  assert.equal(player.asset("photos/a.jpg"), "https://example.test/app/photos/a.jpg");
  assert.equal(player.asset("/photos/a.jpg"), "https://example.test/photos/a.jpg");
  assert.equal(player.asset("https://photos.test/a.jpg"), "https://photos.test/a.jpg");
  assert.equal(player.asset("blob:https://example.test/1"), "blob:https://example.test/1");
  assert.equal(player.asset("asset:/logo.png"), "https://cdn.test/logo.0123456789.png");
  assert.equal(player.asset("asset:/icons/x.png"), "https://example.test/app/icons/x.png");
});

test("data that does not load reaches the engine as none", async () => {
  const { player } = fakePlayer({ data: { syntaxes: "https://example.test/missing.bin" } });
  const handed = dataSink(player);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await withFetch(() => ({ ok: false, status: 404, statusText: "Not Found" }), () => player.loadData("syntaxes"));
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(handed, [["syntaxes", [], 0]]);
});

test("a paused WebSocket holds its events, in order, until the engine resumes it", async () => {
  const { player } = fakePlayer();
  const sockets = [];
  const saved = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor(url) {
      this.url = url;
      this.protocol = "";
      sockets.push(this);
    }
    close() {}
  };
  const got = [];
  // As the engine does: it pauses the socket from inside the event that
  // fills its queue (after "a", and again after "b").
  player.wasm.nsh_websocket_event = (id, kind, p, l) => {
    got.push(`${kind}:${new TextDecoder().decode(new Uint8Array(player.wasm.memory.buffer, p, l))}`);
    if (got.length === 2 || got.length === 3) player.websocketPause(id, true);
    return -1;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    player.websocketStart(1, { url: "ws://example.test/", protocols: [] });
    const [socket] = sockets;
    socket.onopen();
    for (const data of ["a", "b", "c"]) socket.onmessage({ data });
    socket.onclose({ reason: "done", code: 4000, wasClean: true });
    assert.deepEqual(got, ["0:", "1:a"]);
    player.websocketPause(1, false);
    assert.deepEqual(got, ["0:", "1:a"], "held events enter the engine in a task of their own");
    await settle();
    assert.deepEqual(got, ["0:", "1:a", "1:b"]);
    player.websocketPause(1, false);
    await settle();
    assert.deepEqual(got, ["0:", "1:a", "1:b", "1:c", "4:done"]);
  } finally {
    clearTimeout(player.timer);
    globalThis.WebSocket = saved;
  }
});

test("a plain Shader uploads the whole built-ins block, progress and overflow at 0", () => {
  const { player } = fakePlayer();
  const uploads = [];
  const gl = new Proxy(
    {
      UNIFORM_BUFFER: "uniform",
      canvas: { width: 0, height: 0 },
      bufferData: (target, data) => uploads.push([target, Array.from(data)]),
    },
    { get: (gl, name) => (name in gl ? gl[name] : () => {}) },
  );
  Object.assign(player, {
    shaderGl: () => gl,
    shaderProgram: () => ({ program: {}, builtins: {}, uniforms: null, vao: {}, samplers: [] }),
    zoomOf: () => 1,
  });
  const el = {
    _frame: [0, 0, 100, 50],
    _shader: { layer: { role: 0, overflow: 0 }, words: new Uint32Array(0), kept: 1500, since: null, progress: 0 },
    _shaderCanvas: { width: 0, height: 0, getContext: () => ({ drawImage() {} }) },
  };
  const saved = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 2;
  try {
    player.renderShader(el, 0);
  } finally {
    globalThis.devicePixelRatio = saved;
  }
  // `struct Nsh`, 32 bytes as core's `shader::builtins` lays it out: size,
  // time, scale, progress, overflow and padding.
  assert.deepEqual(uploads, [["uniform", [100, 50, 1.5, 2, 0, 0, 0, 0]]]);
});

/** A player whose shaders draw with `gl` and `program(layer)` (`null`: none), and the view they go on. */
function shaderPlayer({ gl = { isContextLost: () => false }, program = () => ({}) } = {}) {
  const { player } = fakePlayer();
  const classes = () => {
    const names = new Set();
    return {
      add: (name) => names.add(name),
      remove: (name) => names.delete(name),
      contains: (name) => names.has(name),
      toggle: (name, on) => (on ? names.add(name) : names.delete(name)),
    };
  };
  const el = { _frame: [0, 0, 100, 50], classList: classes(), append() {}, insertBefore() {}, getBoundingClientRect() {} };
  Object.assign(player, {
    root: { classList: classes(), append() {} },
    shaderViews: new Set(),
    view: () => el,
    watchInputs() {},
    shaderDirty() {},
    pictureCanvas: () => ({ canvas: {}, cx: {} }),
    paintHost() {},
    zoomOf: () => 1,
    shaderGl: () => gl,
    shaderProgram: (_gl, layer) => program(layer),
  });
  return { player, el };
}

const shaderLayer = (role, key = 1) => ({ role, key, words: [], slots: [], pictures: [["content", 0]], progress: 0 });

/** Runs `f` with a `document` whose canvases have been drawn on. */
function withCanvases(f) {
  const document = globalThis.document;
  globalThis.document = { createElement: () => ({ width: 300, height: 150 }) };
  try {
    return f();
  } finally {
    globalThis.document = document;
  }
}

test("an effect hides its children under its canvas once its shader draws", () => {
  const { player, el } = shaderPlayer();
  withCanvases(() => player.op_sh(["sh", 2, shaderLayer(1)]));
  assert.ok(el.classList.contains("nsh-fx"));
});

test("an effect without WebGL 2 shows its children as they are", () => {
  const { player, el } = shaderPlayer({ gl: null });
  withCanvases(() => player.op_sh(["sh", 2, shaderLayer(1)]));
  assert.ok(!el.classList.contains("nsh-fx"));
});

test("an effect whose program the driver refuses shows its children, without the last picture", () => {
  const { player, el } = shaderPlayer({ program: (layer) => (layer.key === 1 ? {} : null) });
  withCanvases(() => player.op_sh(["sh", 2, shaderLayer(1)]));
  assert.ok(el.classList.contains("nsh-fx"));
  withCanvases(() => player.op_sh(["sh", 2, shaderLayer(1, 2)]));
  assert.ok(!el.classList.contains("nsh-fx"));
  assert.equal(el._shaderCanvas.width, 0);
});

test("a screen effect that cannot draw leaves the surface showing", () => {
  const { player } = shaderPlayer({ program: () => null });
  withCanvases(() => player.op_sh(["sh", 2, shaderLayer(3)]));
  assert.ok(!player.root.classList.contains("nsh-fx"));
  assert.equal(player.screenShader ?? null, null);
});

test("a transition that cannot draw starts no run and hides nothing", () => {
  const { player, el } = shaderPlayer({ program: () => null });
  withCanvases(() => player.op_sh(["sh", 2, shaderLayer(2)]));
  player.op_sht(["sht", 2, 300]);
  assert.equal(el._shader.running, null);
  assert.ok(!el.classList.contains("nsh-fx"));
});

test("a page shader that cannot draw leaves the change to the page's own transition", () => {
  const { player } = shaderPlayer({ program: () => null });
  const stack = { getBoundingClientRect: () => ({ width: 390, height: 844 }) };
  assert.equal(player.shaderNav(stack, {}, { layer: shaderLayer(2), ms: 350 }, false, () => {}), false);
});

/**
 * Runs `f` with the player's real `shaderGl` on a context `f` can lose
 * (`context.lost`) and the listeners its canvas got, warnings kept apart.
 */
function withLosableContext(player, f) {
  const context = { lost: false, listeners: {} };
  const gl = new Proxy({ isContextLost: () => context.lost }, { get: (gl, name) => (name in gl ? gl[name] : () => {}) });
  const saved = [globalThis.OffscreenCanvas, console.warn];
  globalThis.OffscreenCanvas = class {
    getContext = () => gl;
    addEventListener = (type, listener) => (context.listeners[type] = listener);
  };
  console.warn = () => {};
  delete player.shaderGl;
  try {
    f(context);
  } finally {
    [globalThis.OffscreenCanvas, console.warn] = saved;
  }
}

test("a lost WebGL context shows the views' children until it is back", () => {
  const { player, el } = shaderPlayer();
  el.isConnected = true;
  withLosableContext(player, (context) => {
    withCanvases(() => player.op_sh(["sh", 2, shaderLayer(1)]));
    assert.ok(el.classList.contains("nsh-fx"));
    const ended = [];
    const overlay = { _shader: { nav: true, running: { done: () => ended.push("page") }, textures: [null, null, null, null] } };
    player.shaderViews.add(overlay);
    context.lost = true;
    let asked = false;
    context.listeners.webglcontextlost({ preventDefault: () => (asked = true) });
    assert.ok(asked, "asked back");
    assert.ok(!el.classList.contains("nsh-fx"), "children shown");
    assert.equal(el._shaderCanvas.width, 0, "without the last frame over them");
    assert.deepEqual(ended, ["page"], "a running change ends, reported");
    assert.equal(player.shaderDraws(shaderLayer(1)), false);
    context.lost = false;
    context.listeners.webglcontextrestored();
    assert.ok(el.classList.contains("nsh-fx"), "drawn through its shader again");
    assert.equal(player.shaderDraws(shaderLayer(1)), true);
  });
});

test("a lost WebGL context is noticed on the next shader frame without its event", () => {
  const { player, el } = shaderPlayer();
  withLosableContext(player, (context) => {
    withCanvases(() => player.op_sh(["sh", 2, shaderLayer(1)]));
    context.lost = true;
    player.shaderFrame(0);
    assert.ok(!el.classList.contains("nsh-fx"));
  });
});

/** A screen of a stack, with a page's `animation` and maybe a shader. */
function screenOf(stack, id, animation, navShader = null) {
  const screen = { _id: id, _kind: "screen", _screen: { animation }, _navShader: navShader, style: {}, classList: { remove() {}, add() {} }, parentNode: stack };
  stack.children.push(screen);
  return screen;
}

/** A stack and a player whose page shaders are recorded (`calls`), running or not (`runs`). */
function stackPlayer(runs) {
  const { player, sent } = fakePlayer();
  const calls = [];
  const stack = { children: [] };
  Object.assign(player, {
    shaderNav: (host, upper, nav, reverse, done) => {
      calls.push({ host, upper, reverse, done });
      return runs;
    },
    syncHistorySoon() {},
  });
  return { player, sent, stack, calls };
}

test("going back with animation \"none\" goes through the page's shader", () => {
  const { player, stack, calls } = stackPlayer(true);
  const below = screenOf(stack, 2, "default");
  const top = screenOf(stack, 4, "none", { layer: shaderLayer(2), ms: 350 });
  player.goBack(top);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].upper, top);
  assert.equal(calls[0].reverse, true, "a pop runs backwards");
  assert.notEqual(top.style.visibility, "hidden", "it shows under the shader until it ends");
  assert.equal(below.style.transform, "");
});

test("going back with animation \"none\" and no shader that runs leaves at once", () => {
  const { player, sent, stack } = stackPlayer(false);
  screenOf(stack, 2, "default");
  const top = screenOf(stack, 4, "none", { layer: shaderLayer(2), ms: 350 });
  player.goBack(top);
  assert.equal(top.style.visibility, "hidden");
  assert.ok(sent.some(([name]) => name === "onDismiss"), "dismissed at once");
});

test("pages and dialogs take their own motion when the user asks for less motion", () => {
  const { player } = shaderPlayer();
  player.reducedMotion = { matches: true };
  let asked = false;
  player.shaderDraws = () => (asked = true);
  const stack = { getBoundingClientRect: () => ({ width: 390, height: 844 }) };
  assert.equal(player.shaderNav(stack, {}, { layer: shaderLayer(2), ms: 350 }, false, () => {}), false);
  assert.equal(asked, false, "not even tried");
});

test("a change of a stack whose page shader still runs ends that one first", () => {
  const { player, stack } = stackPlayer(false);
  const order = [];
  const overlay = { _shader: { nav: true, running: { done: () => order.push("ended") }, textures: [null, null, null, null] } };
  stack._navOverlay = overlay;
  player.shaderViews = new Set([overlay]);
  const old = screenOf(stack, 2, "none");
  const top = screenOf(stack, 4, "none");
  player.moveScreens(old, top, true, () => order.push("pushed"));
  assert.deepEqual(order, ["ended", "pushed"]);
  assert.equal(overlay._shader.running, null);
  assert.ok(!player.shaderViews.has(overlay));
});

test("a dialog shown or closed while another's shader runs ends that one first", () => {
  const { player } = fakePlayer();
  const order = [];
  const overlay = { _shader: { nav: true, running: { done: () => order.push("ended") }, textures: [null, null, null, null] } };
  player.root = { _navOverlay: overlay };
  player.shaderViews = new Set([overlay]);
  player.endNavShader(player.root);
  assert.deepEqual(order, ["ended"]);
  // Ended already: nothing more.
  player.endNavShader(player.root);
  assert.deepEqual(order, ["ended"]);
});

test("a page's or a dialog's shader deletes its pictures' textures when its change ends", () => {
  const { player } = fakePlayer();
  const deleted = [];
  player._shaderGl = { deleteTexture: (t) => deleted.push(t) };
  player.shaderViews = new Set();
  const overlay = { _shader: { nav: true, running: { done() {} }, textures: [null, null, "from", "to"] } };
  player.shaderViews.add(overlay);
  player.endTransition(overlay);
  assert.deepEqual(deleted, ["from", "to"]);
  assert.deepEqual(overlay._shader.textures, [null, null, null, null]);
});

test("a transition deletes its from and to textures when it ends, and keeps its others", () => {
  const { player, el } = shaderPlayer();
  const deleted = [];
  player._shaderGl = { deleteTexture: (t) => deleted.push(t) };
  withCanvases(() => player.op_sh(["sh", 2, shaderLayer(2)]));
  el._shader.textures = ["content", null, "from", "to"];
  player.endTransition(el);
  assert.deepEqual(deleted, ["from", "to"]);
  assert.deepEqual(el._shader.textures, ["content", null, null, null]);
});

test("a dialog closed through its shader stops being watched for the window's size", () => {
  const { player } = fakePlayer();
  const unobserved = [];
  let finish;
  const el = { _id: 6, _navShader: { layer: shaderLayer(2), ms: 350 }, style: {}, remove() {} };
  Object.assign(player, {
    root: {},
    viewportObserver: { unobserve: (target) => unobserved.push(target) },
    shaderNav: (_host, _upper, _nav, _reverse, done) => {
      finish = done;
      return true;
    },
    scopeFocus() {},
    syncHistorySoon() {},
    releaseFrame() {},
    dropLeftWith() {},
    topModal: () => null,
  });
  player.dismiss(el, true);
  assert.deepEqual(unobserved, [], "it shows under the shader until it ends");
  finish();
  assert.deepEqual(unobserved, [el]);
});

/**
 * Runs `f` with a page whose animation frames and timers run when `f`
 * says (`frame()`, `timers()`), and a player presenting dialogs over its
 * container; `names()` are the events it sent.
 */
function presenting(f) {
  const { player, sent } = fakePlayer();
  Object.assign(player, {
    root: { append() {}, contains: () => false },
    size: [320, 240],
    scopeFocus() {},
    syncHistorySoon() {},
    releaseFrame() {},
    dropLeftWith() {},
    placeModal() {},
    topModal: () => null,
  });
  let frames = [];
  const pending = new Map();
  let next = 1;
  const saved = [globalThis.document, globalThis.requestAnimationFrame, globalThis.setTimeout, globalThis.clearTimeout];
  Object.assign(globalThis, {
    document: { activeElement: null, body: {} },
    requestAnimationFrame: (callback) => frames.push(callback),
    setTimeout: (callback) => (pending.set(next, callback), next++),
    clearTimeout: (id) => pending.delete(id),
  });
  const frame = () => {
    const now = frames;
    frames = [];
    for (const callback of now) callback();
  };
  const timers = () => {
    for (const [id, callback] of [...pending]) {
      pending.delete(id);
      callback();
    }
  };
  const dialog = { _id: 6, _modal: { animation: "slide" }, style: {}, setAttribute() {}, remove() {} };
  try {
    f({ player, dialog, frame, timers, names: () => sent.map(([name]) => name) });
  } finally {
    [globalThis.document, globalThis.requestAnimationFrame, globalThis.setTimeout, globalThis.clearTimeout] = saved;
  }
}

test("a dialog dismissed before it came in reports it shown, then dismissed", () => {
  presenting(({ player, dialog, frame, timers, names }) => {
    player.present(dialog);
    player.dismiss(dialog);
    frame();
    frame();
    timers();
    assert.deepEqual(names(), ["onShow", "onDismiss"]);
    assert.notEqual(dialog.style.transform, "", "it stays out of sight as it leaves");
  });
});

test("a dialog dismissed while it slides in reports it shown at once, then dismissed", () => {
  presenting(({ player, dialog, frame, timers, names }) => {
    player.present(dialog);
    frame();
    frame();
    assert.deepEqual(names(), [], "shown once its slide ends");
    player.dismiss(dialog);
    assert.deepEqual(names(), ["onShow"]);
    timers();
    assert.deepEqual(names(), ["onShow", "onDismiss"]);
  });
});

test("a picture of an unchanged size draws into its canvas again without reallocating it", () => {
  const { player } = fakePlayer();
  const sizes = [];
  const drawn = [];
  const canvas = {
    _w: 0,
    _h: 0,
    get width() { return this._w; },
    set width(v) { sizes.push(["width", v]); this._w = v; },
    get height() { return this._h; },
    set height(v) { sizes.push(["height", v]); this._h = v; },
    getContext: () => ({ setTransform: () => {}, clearRect: (...r) => drawn.push(r) }),
  };
  const el = { _shader: { pictures: [canvas, null, null, null], fresh: [false, false, false, false] } };
  const saved = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 2;
  try {
    player.pictureCanvas(el, 0, [100, 50, 0]);
    assert.deepEqual(sizes, [["width", 200], ["height", 100]]);
    assert.deepEqual(drawn, []);
    player.pictureCanvas(el, 0, [100, 50, 0]);
    assert.equal(sizes.length, 2, "kept");
    assert.deepEqual(drawn, [[0, 0, 200, 100]], "cleared instead");
    player.pictureCanvas(el, 0, [120, 50, 0]);
    assert.deepEqual(sizes.slice(2), [["width", 240], ["height", 100]]);
  } finally {
    globalThis.devicePixelRatio = saved;
  }
});

test("a shader's frames upload the built-ins from one buffer", () => {
  const { player } = fakePlayer();
  const uploads = [];
  const gl = new Proxy(
    {
      UNIFORM_BUFFER: "uniform",
      canvas: { width: 0, height: 0 },
      bufferData: (_target, data) => uploads.push(data),
    },
    { get: (gl, name) => (name in gl ? gl[name] : () => {}) },
  );
  Object.assign(player, {
    shaderGl: () => gl,
    shaderProgram: () => ({ program: {}, builtins: {}, uniforms: null, vao: {}, samplers: [] }),
    zoomOf: () => 1,
  });
  const el = {
    _frame: [0, 0, 100, 50],
    _shader: { layer: { role: 0, overflow: 0 }, words: new Uint32Array(0), kept: 0, since: null, progress: 0 },
    _shaderCanvas: { width: 0, height: 0, getContext: () => ({ drawImage() {} }) },
  };
  player.renderShader(el, 0);
  player.renderShader(el, 16);
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0], uploads[1]);
});

/** A context whose canvas records the sizes it is given (`resized`) and whose viewports go to `viewports`. */
function sizedGl() {
  const resized = [];
  const viewports = [];
  const size = { width: 0, height: 0 };
  const canvas = {};
  for (const side of ["width", "height"]) {
    Object.defineProperty(canvas, side, {
      get: () => size[side],
      set: (v) => {
        resized.push([side, v]);
        size[side] = v;
      },
    });
  }
  const gl = new Proxy(
    { isContextLost: () => false, canvas, viewport: (...rect) => viewports.push(rect) },
    { get: (gl, name) => (name in gl ? gl[name] : () => {}) },
  );
  return { gl, resized, viewports };
}

/** An animated shader view `w` × `h` points of `role`; what its frames copy from the shared canvas goes to `copies`. */
function sizedView(w, h, role, copies = []) {
  return {
    isConnected: true,
    _frame: [0, 0, w, h],
    _shaderVisible: true,
    _shader: { layer: { ...shaderLayer(role), animated: true }, words: new Uint32Array(0), kept: 0, since: 0, progress: 0, dirty: true, stale: 0, pictures: [], textures: [] },
    _shaderCanvas: { width: 0, height: 0, style: {}, getContext: () => ({ clearRect() {}, drawImage: (_canvas, ...rects) => copies.push(rects) }) },
  };
}

const drawingProgram = () => ({ program: {}, vao: {}, samplers: [] });

test("shader views of different sizes draw into one canvas without resizing it on every frame", () => {
  const { gl, resized, viewports } = sizedGl();
  const { player } = shaderPlayer({ gl, program: drawingProgram });
  const copies = [];
  const small = sizedView(100, 50, 0, copies);
  const large = sizedView(300, 200, 0);
  const saved = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 1;
  try {
    for (const t of [0, 16, 32]) {
      player.renderShader(small, t);
      player.renderShader(large, t);
      player.fitSharedCanvas(t);
    }
    assert.deepEqual(resized, [["width", 100], ["height", 50], ["width", 300], ["height", 200]], "grown to the largest, once");
    // Each in its top-left corner (GL's y goes up), copied from there.
    assert.deepEqual(viewports.slice(2, 4), [[0, 150, 100, 50], [0, 0, 300, 200]]);
    assert.deepEqual(copies.at(-1), [0, 0, 100, 50, 0, 0, 100, 50]);
    // Only the small one draws now: the canvas keeps its size a second.
    resized.length = 0;
    for (const t of [100, 600]) {
      player.renderShader(small, t);
      player.fitSharedCanvas(t);
    }
    assert.deepEqual(resized, []);
    player.renderShader(small, 1200);
    player.fitSharedCanvas(1200);
    assert.deepEqual(resized, [["width", 100], ["height", 50]], "then fits it");
  } finally {
    globalThis.devicePixelRatio = saved;
  }
});

test("a screen effect over an animated shader asks for one shader frame at a time", () => {
  const { gl } = sizedGl();
  const { player } = shaderPlayer({ gl, program: drawingProgram });
  // The real one, which the screen effect's marks go through.
  delete player.shaderDirty;
  let pictures = 0;
  player.paintInputs = (el) => {
    el._shader.stale = 0;
    pictures++;
  };
  player.size = [200, 100];
  const fill = sizedView(100, 50, 0);
  const screen = sizedView(0, 0, 3);
  screen._shader.layer.animated = false;
  player.shaderViews = new Set([fill, screen]);
  const frames = [];
  const saved = [globalThis.requestAnimationFrame, globalThis.devicePixelRatio];
  globalThis.requestAnimationFrame = (f) => frames.push(f);
  globalThis.devicePixelRatio = 1;
  try {
    player.shaderFrame(0);
    for (let n = 1; n <= 5; n++) {
      assert.equal(frames.length, 1, `one callback queued after frame ${n}`);
      frames.shift()(n * 16);
    }
    // Each frame after the first, the screen effect pictures what the fill
    // drew.
    assert.equal(pictures, 5);
    assert.equal(frames.length, 1);
  } finally {
    [globalThis.requestAnimationFrame, globalThis.devicePixelRatio] = saved;
  }
});

test("a picture taken again reads the styles of what changed only", () => {
  const { player } = fakePlayer();
  const read = [];
  const node = (name, children = []) => ({
    name,
    children,
    classList: { contains: () => false },
    contains: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
  });
  const leaf = node("leaf");
  const inner = node("inner", [leaf]);
  const other = node("other");
  const host = node("host", [inner, other]);
  const cx = new Proxy({}, { get: () => () => {} });
  const saved = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (el) => {
    read.push(el.name);
    return { display: "block", opacity: "1", visibility: "visible", backgroundColor: "transparent", borderTopWidth: "0px" };
  };
  player.paintGen = 0;
  player.paintReset = 0;
  try {
    player.paintTree(cx, host, { left: 0, top: 0 }, 1, null, null, 0);
    assert.deepEqual(read, ["inner", "leaf", "other"]);
    read.length = 0;
    player.paintTree(cx, host, { left: 0, top: 0 }, 1, null, null, 0);
    assert.deepEqual(read, [], "kept");
    player.touchAll([{ type: "attributes", target: inner }]);
    player.paintTree(cx, host, { left: 0, top: 0 }, 1, null, null, 0);
    assert.deepEqual(read, ["inner", "leaf"], "it and what it holds");
    read.length = 0;
    player.paintReset = ++player.paintGen;
    player.paintTree(cx, host, { left: 0, top: 0 }, 1, null, null, 0);
    assert.deepEqual(read, ["inner", "leaf", "other"], "a new color scheme: all");
  } finally {
    globalThis.getComputedStyle = saved;
  }
});

test("a canvas that drew a cross-origin image is left out of shaders' pictures", () => {
  const { player } = fakePlayer();
  const image = (src, crossOrigin = null) => [src, { img: { src, currentSrc: src, crossOrigin }, ready: true, waiting: new Set() }];
  const cx = new Proxy({}, { get: () => () => {} });
  const canvasOf = (src) => ({
    _frame: [0, 0, 10, 10],
    _slots: [],
    _ops: [["drawImage", src, null, 0, 0, 10, 10]],
    _canvas: { width: 0, height: 0, getContext: () => cx },
  });
  Object.assign(player, {
    asset: (uri) => uri,
    zoomOf: () => 1,
    images: new Map([
      image("https://cdn.example/a.png"),
      image("https://cdn.example/cors.png", "anonymous"),
      image("https://app.example/b.png"),
      image("data:image/png;base64,AAAA"),
    ]),
  });
  const saved = [globalThis.location, globalThis.devicePixelRatio];
  globalThis.location = { href: "https://app.example/", origin: "https://app.example" };
  globalThis.devicePixelRatio = 1;
  try {
    const foreign = canvasOf("https://cdn.example/a.png");
    const cors = canvasOf("https://cdn.example/cors.png");
    const own = canvasOf("https://app.example/b.png");
    const inline = canvasOf("data:image/png;base64,AAAA");
    for (const el of [foreign, cors, own, inline]) player.draw(el);
    assert.equal(foreign._canvas._tainted, true);
    assert.ok(!cors._canvas._tainted);
    assert.ok(!own._canvas._tainted);
    assert.ok(!inline._canvas._tainted);
  } finally {
    [globalThis.location, globalThis.devicePixelRatio] = saved;
  }
  const drawn = [];
  const picture = new Proxy({}, { get: (_, name) => (name === "drawImage" ? (c) => drawn.push(c.name) : () => {}) });
  const canvas = (name, tainted) => ({
    name,
    tagName: "CANVAS",
    width: 10,
    height: 10,
    _tainted: tainted,
    children: [],
    classList: { contains: () => false },
    contains: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
  });
  const host = { children: [canvas("tainted", true), canvas("clean", false)] };
  const savedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ display: "block", opacity: "1", visibility: "visible", backgroundColor: "transparent", borderTopWidth: "0px" });
  player.paintGen = player.paintReset = 0;
  try {
    player.paintTree(picture, host, { left: 0, top: 0 }, 1, null, null, 0);
  } finally {
    globalThis.getComputedStyle = savedStyle;
  }
  assert.deepEqual(drawn, ["clean"]);
});

test("a frame the browser refuses shows the view's children, and the frame goes on with the others", () => {
  const refuse = () => {
    throw new Error("SecurityError: the canvas has been tainted by cross-origin data");
  };
  const gl = new Proxy(
    { isContextLost: () => false, canvas: { width: 0, height: 0 }, texImage2D: refuse },
    { get: (gl, name) => (name in gl ? gl[name] : () => {}) },
  );
  const { player, el } = shaderPlayer({ gl, program: (layer) => ({ samplers: layer.key === 1 ? [["content", 0]] : [] }) });
  withCanvases(() => player.op_sh(["sh", 2, shaderLayer(1)]));
  assert.ok(el.classList.contains("nsh-fx"));
  el.isConnected = true;
  el._shader.pictures[0] = {};
  const other = {
    isConnected: true,
    _frame: [0, 0, 10, 10],
    _shaderVisible: true,
    _shader: { layer: shaderLayer(0, 2), words: new Uint32Array(0), kept: 0, since: null, progress: 0, dirty: true, stale: 0, pictures: [], textures: [] },
    _shaderCanvas: { width: 0, height: 0, getContext: () => ({ clearRect() {}, drawImage() {} }) },
  };
  player.shaderViews.add(other);
  const drawn = [];
  const render = player.renderShader;
  player.renderShader = (view, t) => {
    const ok = render.call(player, view, t);
    drawn.push([view === el ? "effect" : "other", ok]);
    return ok;
  };
  const saved = [console.warn, globalThis.devicePixelRatio];
  console.warn = () => {};
  globalThis.devicePixelRatio = 1;
  try {
    player.shaderFrame(0);
    assert.deepEqual(drawn, [["effect", false], ["other", true]]);
    assert.ok(!el.classList.contains("nsh-fx"), "children shown");
    assert.equal(el._shaderCanvas.width, 0, "without a frame over them");
    drawn.length = 0;
    el._shader.dirty = other._shader.dirty = true;
    player.shaderFrame(0);
    assert.deepEqual(drawn, [["other", true]], "not tried again for this layer");
  } finally {
    [console.warn, globalThis.devicePixelRatio] = saved;
  }
});

test("a page's shader whose first frame the browser refuses leaves the change to its own motion", () => {
  const gl = new Proxy(
    { isContextLost: () => false, canvas: { width: 0, height: 0 }, texImage2D: () => { throw new Error("SecurityError"); } },
    { get: (gl, name) => (name in gl ? gl[name] : () => {}) },
  );
  const { player } = shaderPlayer({ gl, program: () => ({ samplers: [["from", 2], ["to", 3]] }) });
  player.pictureCanvas = (view, input) => {
    view._shader.pictures[input] = {};
    return { canvas: {}, cx: {} };
  };
  const stack = { getBoundingClientRect: () => ({ width: 390, height: 844 }), append(o) { o.removed = false; } };
  const saved = [globalThis.document, console.warn, globalThis.devicePixelRatio];
  globalThis.document = { createElement: () => ({ style: {}, append() {}, remove() { this.removed = true; } }) };
  console.warn = () => {};
  globalThis.devicePixelRatio = 1;
  let ended = false;
  try {
    assert.equal(player.shaderNav(stack, {}, { layer: shaderLayer(2), ms: 350 }, false, () => (ended = true)), false);
  } finally {
    [globalThis.document, console.warn, globalThis.devicePixelRatio] = saved;
  }
  assert.equal(stack._navOverlay ?? null, null);
  assert.equal(player.shaderViews.size, 0);
  assert.equal(ended, false, "the caller's own motion calls it");
});

/**
 * A player on an engine with one native animation of 300 ms, started by
 * the first frame after `requestFrame` (as a batch that starts one asks
 * for frames); `ticks` are the times of the frames it got. The page's
 * animation frames run only when the test says (`frame()`); its clock is
 * `clock.now`.
 */
function animating(t) {
  const { player } = fakePlayer();
  const clock = { now: 0 };
  t.mock.method(performance, "now", () => clock.now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let frames = [];
  const saved = [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame];
  globalThis.requestAnimationFrame = (f) => frames.push(f);
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => ([globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = saved));
  const ticks = [];
  let start = null;
  let ended = false;
  // The graph's: the animation's end, or `now` until a frame starts it.
  player.wasm.nsh_deadline = (now) => (ended ? -1 : (start ?? now) + (start == null ? 0 : 300));
  player.wasm.nsh_frame = (now) => {
    ticks.push(now);
    start ??= now;
    if (now - start >= 300) ended = true;
    else player.requestFrame();
    return -1;
  };
  const frame = () => {
    const due = frames;
    frames = [];
    for (const f of due) f(clock.now);
  };
  // Time passes by `ms`: the timers due run, and what the calls into the
  // engine left for after them (`deadlineSoon`).
  const pass = async (ms) => {
    await null;
    clock.now += ms;
    t.mock.timers.tick(ms);
    await null;
  };
  return { player, ticks, frame, pass, ended: () => ended };
}

test("a native animation ends on time while no animation frames come", async (t) => {
  const { player, ticks, pass, ended } = animating(t);
  player.requestFrame();
  // A frame starts it, and one at its end ends it.
  await pass(50);
  assert.deepEqual(ticks, [50]);
  await pass(300);
  assert.deepEqual(ticks, [50], "not before its end and a little more");
  await pass(50);
  assert.deepEqual(ticks, [50, 400]);
  assert.ok(ended());
  await pass(1000);
  assert.deepEqual(ticks, [50, 400], "nothing more once it ended");
});

test("while animation frames come the page runs no frames of its own", async (t) => {
  const { player, ticks, frame, pass, ended } = animating(t);
  player.requestFrame();
  let frames = 0;
  for (let i = 0; i < 30 && !ended(); i++) {
    await pass(16);
    frame();
    frames++;
  }
  assert.ok(ended());
  assert.equal(ticks.length, frames, "every frame the browser's");
  await pass(1000);
  assert.equal(ticks.length, frames);
});

test("a dialog comes in and reports it shown without animation frames", () => {
  presenting(({ player, dialog, timers, names }) => {
    player.present(dialog);
    timers();
    assert.equal(dialog.style.transform, "", "in its place");
    timers();
    assert.deepEqual(names(), ["onShow"]);
  });
});

test("a page's slide ends on time without animation frames, and once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { player } = fakePlayer();
  const animations = [];
  const screen = (id) => ({
    _id: id,
    _screen: { animation: "default" },
    style: {},
    animate() {
      const a = {};
      animations.push(a);
      return a;
    },
  });
  const stack = {};
  const [below, top] = [screen(2), screen(4)];
  below.parentNode = top.parentNode = stack;
  let done = 0;
  player.moveScreens(top, below, false, () => done++);
  t.mock.timers.tick(300);
  assert.equal(done, 0, "not before its end");
  t.mock.timers.tick(100);
  assert.equal(done, 1);
  animations[0].onfinish();
  assert.equal(done, 1, "its animation's end, later, is the same end");
});

test("a page's shader ends on time without animation frames", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { player } = shaderPlayer();
  Object.assign(player, { renderShader: () => true, shaderDraws: () => true, freeTextures() {} });
  const stack = { getBoundingClientRect: () => ({ width: 390, height: 844 }), append() {} };
  const saved = globalThis.document;
  globalThis.document = { createElement: () => ({ style: {}, append() {}, remove() {} }) };
  let ended = 0;
  try {
    assert.equal(player.shaderNav(stack, {}, { layer: shaderLayer(2), ms: 350 }, false, () => ended++), true);
  } finally {
    globalThis.document = saved;
  }
  t.mock.timers.tick(350);
  assert.equal(ended, 0, "not before its end");
  t.mock.timers.tick(100);
  assert.equal(ended, 1);
  assert.equal(stack._navOverlay, null);
  t.mock.timers.tick(1000);
  assert.equal(ended, 1);
});

test("a mouse makes a desktop at any width, a touch screen a tablet or a phone (#1004)", () => {
  const saved = { matchMedia: globalThis.matchMedia, screen: globalThis.screen };
  const measure = (mouse, width, height) => {
    globalThis.matchMedia = () => ({ matches: mouse });
    globalThis.screen = { width, height };
    return Player.prototype.measureIdiom.call({});
  };
  try {
    // A narrow browser window on a desktop still drags to select with the mouse.
    assert.equal(measure(true, 390, 844), "desktop");
    assert.equal(measure(true, 1280, 800), "desktop");
    assert.equal(measure(false, 390, 844), "phone");
    assert.equal(measure(false, 820, 1180), "pad");
  } finally {
    globalThis.matchMedia = saved.matchMedia;
    globalThis.screen = saved.screen;
  }
});

test("a view laid out at no size draws nothing of its own, its border overlay included", () => {
  const { player } = fakePlayer();
  const classes = new Set();
  const el = {
    _kind: "view",
    _animation: {},
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
  };
  Object.assign(player, { view: () => el, placeFrame() {}, readingChanged() {} });
  // `display: none`: the core lays the view out at no size.
  player.op_f(["f", 2, 0, 0, 0, 0]);
  assert.ok(classes.has("nsh-empty"));
  player.op_f(["f", 2, 8, 8, 40, 32]);
  assert.ok(!classes.has("nsh-empty"));
  // One side of no size is no size too.
  player.op_f(["f", 2, 8, 8, 40, 0]);
  assert.ok(classes.has("nsh-empty"));
  // What the class takes away: the border overlay, the outline and the shadow.
  assert.match(source, /\.nsh-empty > \.nsh-border \{ display: none; \}/);
  assert.match(source, /\.nsh-v\.nsh-empty \{ outline: none; box-shadow: none; \}/);
});

test("a key event without `key` falls back to its physical key instead of throwing", () => {
  assert.equal(keyCode({ code: "KeyA" }), 97);
  assert.equal(keyCode({ key: null, code: "Digit3" }), 51);
  assert.equal(keyCode({}), -1);
  assert.equal(keyCode({ key: "a", code: "KeyA" }), 97);
});
