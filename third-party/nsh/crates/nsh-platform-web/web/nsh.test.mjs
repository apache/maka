// nsh.js's host channel without a browser or nsh.wasm:
// `node --test crates/nsh-platform-web/web/nsh.test.mjs`. A fake engine
// records what reaches it through the real `call` / `withStrings` path.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("nsh.js", import.meta.url), "utf8");
// `Player` is not exported; the page only gets it from `createPlayer`.
const { Player, keyCode, elementTag } = await import(
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

test("views are drawn as headings and links by their role, else the element they name", () => {
  // Headings: `role="header"`, by level, `h2` without one, levels clamped.
  assert.equal(elementTag({ role: "header", level: 1 }), "h1");
  assert.equal(elementTag({ role: "header" }), "h2");
  assert.equal(elementTag({ role: "header", level: 9 }), "h6");
  // Links: `role="link"` with the `href` `Link` sets; without one, a view.
  assert.equal(elementTag({ role: "link", href: "/notes/q3" }), "a");
  assert.equal(elementTag({ role: "link" }), "div");
  // `web={{ element }}` names the rest, and wins over the role.
  assert.equal(elementTag({ element: "nav" }), "nav");
  assert.equal(elementTag({ role: "header", element: "p" }), "p");
  assert.equal(elementTag({}), "div");
});

test("links the app shows no menu for keep the browser's context menu", () => {
  const { player } = fakePlayer();
  const link = {
    _id: 4,
    _events: new Set(),
    localName: "a",
    hasAttribute: (name) => name === "href",
    matches: () => false,
  };
  const text = { _id: 6, _events: new Set(), localName: "span", hasAttribute: () => false, matches: () => false };
  player.viewOf = () => text;
  player.ancestors = () => [text, link];
  player.event = failing;
  let prevented = false;
  const e = { target: text, button: 2, pointerType: "mouse", preventDefault() { prevented = true; } };
  // Handled: the listener leaves the event to the browser, which shows its menu.
  assert.equal(player.contextMenu(e), true);
  assert.equal(prevented, false);
  // A link without an href is a view like any other: no menu of the browser's.
  link.hasAttribute = () => false;
  assert.equal(player.contextMenu(e), false);
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

test("an invalid view is aria-invalid, and so is the field of an input", () => {
  const { player } = fakePlayer();
  const element = () => {
    const attrs = new Map();
    return {
      attrs,
      setAttribute: (name, value) => attrs.set(name, value),
      removeAttribute: (name) => attrs.delete(name),
    };
  };
  const el = { ...element(), _props: { invalid: true } };
  const field = element();
  player.updateAria(el);
  assert.equal(el.attrs.get("aria-invalid"), "true");
  // The field made after the props takes them too: it is what screen readers read.
  field.classList = { toggle() {} };
  field.tagName = "INPUT";
  el._field = field;
  player.view = () => el;
  player.op_in(["in", 1, { multiline: false }, null]);
  assert.equal(field.attrs.get("aria-invalid"), "true");
  el._props.invalid = false;
  player.updateAria(el);
  assert.equal(el.attrs.has("aria-invalid"), false);
  assert.equal(field.attrs.has("aria-invalid"), false);
  el._props.invalid = true;
  player.updateAria(el);
  assert.equal(field.attrs.get("aria-invalid"), "true");
});

test("a combo box's field names its highlighted row and its list by DOM id", () => {
  const { player } = fakePlayer();
  player.classPrefix = "nsh-p1-";
  const element = (extra = {}) => {
    const attrs = new Map();
    return {
      attrs,
      id: "",
      setAttribute: (name, value) => attrs.set(name, value),
      removeAttribute: (name) => attrs.delete(name),
      ...extra,
    };
  };
  const views = new Map();
  player.view = (id) => views.get(id);
  const field = element({ classList: { toggle() {} }, tagName: "INPUT" });
  const el = element({ _field: field, _props: { role: "combobox", label: "Tags", expanded: true, hasPopup: true, activeDescendant: 6, controls: 4 } });
  const list = element();
  views.set(2, el);
  views.set(4, list);
  // The row named is made after the field's props: linked after the
  // batch (`apply` ends with `linkRelations`).
  player.updateAria(el);
  player.linkRelations();
  assert.equal(field.attrs.get("aria-controls"), "nsh-p1-v4");
  assert.equal(list.id, "nsh-p1-v4");
  assert.equal(field.attrs.has("aria-activedescendant"), false, "not made yet");
  const row = element();
  views.set(6, row);
  player.linkRelations();
  assert.equal(field.attrs.get("aria-activedescendant"), "nsh-p1-v6");
  assert.equal(row.id, "nsh-p1-v6");
  // The field is the combo box: the wrapper has no role of its own.
  assert.equal(field.attrs.get("role"), "combobox");
  assert.equal(field.attrs.get("aria-label"), "Tags");
  assert.equal(field.attrs.get("aria-expanded"), "true");
  assert.equal(field.attrs.get("aria-haspopup"), "listbox");
  assert.equal(el.attrs.has("role"), false);
  assert.equal(el.attrs.has("aria-activedescendant"), false);
  // The highlight moves, then the list closes.
  el._props = { ...el._props, activeDescendant: 8 };
  views.set(8, element());
  player.updateAria(el);
  player.linkRelations();
  assert.equal(field.attrs.get("aria-activedescendant"), "nsh-p1-v8");
  el._props = { role: "combobox", expanded: false, hasPopup: true };
  player.updateAria(el);
  player.linkRelations();
  assert.equal(field.attrs.has("aria-activedescendant"), false);
  assert.equal(field.attrs.has("aria-controls"), false);
  assert.equal(field.attrs.get("aria-expanded"), "false");
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

test("posts go to the page host's post, else its call, and nothing comes back", async () => {
  const posted = [];
  const { player, sent } = fakePlayer({ host: { call: () => 1, post: (...args) => posted.push(args) } });
  player.begin(390, started);
  player.hostPost("note", { a: 1 });
  assert.deepEqual(posted, [["note", { a: 1 }]]);
  const called = [];
  const fallback = fakePlayer({ host: { call: async (...args) => { called.push(args); throw new Error("boom"); } } });
  fallback.player.begin(390, started);
  fallback.player.hostPost("note", 2);
  const throwing = fakePlayer({ host: { call() {}, post() { throw new Error("boom"); } } });
  throwing.player.hostPost("note", 3);
  fakePlayer().player.hostPost("note", 4);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(called, [["note", 2]]);
  assert.deepEqual([...sent, ...fallback.sent, ...throwing.sent], []);
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

test("a touch whose press focused a field leaves the focus there", () => {
  const { player } = fakePlayer();
  player.editable = (target) => target.field === true;
  const field = { focus() {} };
  const pressable = {};
  player.view = () => ({ _field: field });
  globalThis.window = { focus() {} };
  // Whether the mouse events of a press of `pointer` leave the focus alone.
  const kept = (pointer, target, focused, focuses) => {
    globalThis.document = { activeElement: focused, hasFocus: () => true };
    player.lastPointer = pointer;
    player.pressFocus = null;
    if (focuses) player.op_cmd([0, 1, "focus"]);
    let prevented = false;
    player.mouseDown({ target, preventDefault: () => (prevented = true) });
    return prevented;
  };
  assert.equal(kept("mouse", pressable, field, false), true, "a click moves no focus");
  assert.equal(kept("mouse", { field: true }, null, false), false, "a click in a field is the field's");
  // A tap outside a field leaves it, and the keyboard closes.
  assert.equal(kept("touch", pressable, field, false), false, "a tap elsewhere");
  // The app focused the field for this press (an editor's text): it stays.
  assert.equal(kept("touch", pressable, field, true), true, "a tap that focused the field");
  // The focus moved on since (the app focused something else).
  assert.equal(kept("touch", pressable, {}, true), false, "the field no longer has the focus");
  delete globalThis.document;
  delete globalThis.window;
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

test("Return and Space press the focused control unless the focus binds them", () => {
  const { player } = fakePlayer();
  // The app binds Return, Space and Mod+Return everywhere but text fields
  // (binding 7), as the native match answers: on a control (focus bit 2)
  // plain Return and Space fire only the focus' own bindings (binding 9,
  // while `own`).
  let own = false;
  player.wasm.nsh_key = (code, mods, focus) => {
    const pressing = (code === keyCode({ key: "Enter" }) || code === keyCode({ key: " " })) && !(mods & 11);
    if (focus & 2 && pressing) return own ? 9 : -1;
    return 7;
  };
  const fired = [];
  player.call = (f) => f({ nsh_key_command: (id) => fired.push(id) });
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
  const key = (focus, e) => {
    globalThis.document = { activeElement: focus };
    player.keyDown({ preventDefault() {}, stopPropagation() {}, ...e });
    if (e.key === " ") player.keyUp({ key: " " });
    delete globalThis.document;
  };
  const button = focusView(true, {});
  const chart = focusView(false, { focusable: true });
  // On a button: the button takes them, the app's binding never fires.
  key(button, { key: "Enter" });
  key(button, { key: " " });
  key(button, { key: "Enter", shiftKey: true });
  assert.deepEqual(pressed, [button, button, button]);
  assert.deepEqual(fired, []);
  // With Control or Command held the binding fires, as it does with the
  // focus on no control or on a stop that takes no presses.
  key(button, { key: "Enter", ctrlKey: true });
  key(button, { key: "Enter", metaKey: true });
  key(null, { key: "Enter" });
  key(chart, { key: "Enter" });
  assert.deepEqual(pressed, [button, button, button]);
  assert.deepEqual(fired, [7, 7, 7, 7]);
  // The focus' own binding (a menu button opening its menu) takes them
  // before the press.
  own = true;
  key(button, { key: "Enter" });
  assert.deepEqual(pressed, [button, button, button]);
  assert.deepEqual(fired, [7, 7, 7, 7, 9]);
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

test("UrlScheme.setUrl gives its address to the entry of the page pushed with it, after a traversal lands", () => {
  const calls = [];
  const saved = { history: globalThis.history, location: globalThis.location, document: globalThis.document };
  globalThis.location = { href: "https://a.test/debugger/", origin: "https://a.test" };
  globalThis.document = { baseURI: "https://a.test/debugger/" };
  const warn = console.warn;
  console.warn = (m) => calls.push(["warn", m]);
  globalThis.history = {
    state: null,
    pushState(state, _title, url) { calls.push(["push", state.nsh, url ?? null]); this.state = state; },
    replaceState(state, _title, url) { calls.push(["replace", state?.nsh, url]); },
    go(n) { calls.push(["go", n]); },
  };
  try {
    let depth = 0;
    const player = Object.create(Player.prototype);
    Object.assign(player, {
      history: true, historyDepth: 0, historyIndex: 0, historyDepths: [0], ignoredPops: 0, historySession: "s", pageUrl: null,
      backDepth: () => depth, syncHistorySoon() {}, showError: (m) => calls.push(["error", m]),
    });
    // A page pushed and its address set in one turn: the entry first.
    depth = 1;
    player.setPageUrl("/debugger/logs/3");
    player.syncHistory();
    assert.deepEqual(calls.splice(0), [["push", 1, null], ["replace", 1, "https://a.test/debugger/logs/3"]]);
    // A page popped: the address waits for the traversal's popstate.
    depth = 0;
    player.setPageUrl("/debugger");
    player.syncHistory();
    assert.deepEqual(calls.splice(0), [["go", -1]]);
    player.syncHistorySoon = () => player.syncHistory();
    player.popState({ state: { nsh: 0, nshSession: "s" } });
    assert.deepEqual(calls.splice(0), [["replace", 1, "https://a.test/debugger"]]);
    assert.equal(player.firstUrl, "https://a.test/debugger");
    // Another origin's address (from Rust; TS's `setUrl` throws first) is
    // dropped with a warning.
    player.setPageUrl("https://b.test/x");
    assert.equal(player.pageUrl, null);
    assert.equal(calls.splice(0)[0][0], "warn");
    // Without a history (an iframe) nothing is written.
    const framed = Object.create(Player.prototype);
    Object.assign(framed, { history: false, syncHistorySoon() { calls.push(["sync"]); } });
    framed.setPageUrl("/x");
    assert.deepEqual(calls, []);
  } finally {
    Object.assign(globalThis, saved);
    console.warn = warn;
  }
});

test("the browser's back gives the core the entry's address with no open, and a kept page keeps its own", () => {
  const calls = [];
  const saved = { history: globalThis.history, location: globalThis.location };
  globalThis.location = { href: "https://a.test/inbox" };
  globalThis.history = {
    state: null,
    pushState(state, _title, url) { calls.push(["push", state.nsh, url ?? null]); this.state = state; },
    replaceState(state, _title, url) { calls.push(["replace", state?.nsh, url]); },
    go(n) { calls.push(["go", n]); },
  };
  try {
    let depth = 1;
    let lets = true;
    const player = Object.create(Player.prototype);
    Object.assign(player, {
      history: true, historyDepth: 1, historyIndex: 1, historyDepths: [0, 1], ignoredPops: 0, historySession: "s", pageUrl: null,
      shownUrl: "https://a.test/inbox?message=a",
      backDepth: () => depth, showError: (m) => calls.push(["error", m]),
      back: () => lets && (depth--, true),
      event: (id, name, payload) => calls.push(["event", name, payload]),
    });
    player.syncHistorySoon = () => player.syncHistory();
    // The app keeps its page: its entry again, at the address it showed.
    lets = false;
    player.popState({ state: { nsh: 0, nshSession: "s" } });
    assert.deepEqual(calls.splice(0), [["push", 1, null], ["replace", 1, "https://a.test/inbox?message=a"]]);
    // The app goes back: the entry's address, quietly, as the stack went
    // back already (a page opened at a deep link is not pushed again).
    lets = true;
    player.popState({ state: { nsh: 0, nshSession: "s" } });
    assert.deepEqual(calls.splice(0), [["event", "onUrlScheme", { url: "https://a.test/inbox", page: true, quiet: true }]]);
    assert.equal(player.firstUrl, "https://a.test/inbox");
    // A forward to a page the stack no longer has: handed to the app as a
    // link (`open`); an app that shows nothing for it goes back where it was,
    // and once that lands the core has that entry's address again.
    location.href = "https://a.test/inbox?message=a";
    player.popState({ state: { nsh: 1, nshSession: "s" } });
    assert.deepEqual(calls.splice(0), [
      ["event", "onUrlScheme", { url: "https://a.test/inbox?message=a", page: true }],
      ["go", -1],
    ]);
    location.href = "https://a.test/inbox";
    player.popState({ state: { nsh: 0, nshSession: "s" } });
    assert.deepEqual(calls.splice(0), [["event", "onUrlScheme", { url: "https://a.test/inbox", page: true, quiet: true }]]);
  } finally {
    Object.assign(globalThis, saved);
  }
});

test("a run starts at its first entry's address, which the core has before the app's code runs", () => {
  const calls = [];
  const saved = { history: globalThis.history, location: globalThis.location, window: globalThis.window };
  globalThis.location = { href: "https://a.test/inbox?message=a" };
  globalThis.window = { addEventListener() {} };
  globalThis.history = {
    state: null,
    replaceState(state) { this.state = state; },
    go(n) { calls.push(["go", n]); },
  };
  try {
    const player = Object.create(Player.prototype);
    Object.assign(player, { history: true, pageUrl: null });
    player.installHistory();
    assert.equal(player.firstUrl, "https://a.test/inbox?message=a");
    // A new run goes back to the first entry; its address is known at once,
    // with the traversal still on its way.
    player.historyDepth = player.historyIndex = 2;
    player.resetHistory();
    assert.deepEqual(calls.splice(0), [["go", -2]]);
    assert.equal(player.firstUrl, "https://a.test/inbox?message=a");
    // `begin` hands it to the runtime before it starts the app.
    assert.match(source, /withStrings\(\[this\.firstUrl\], \(p, l\) => this\.wasm\.nsh_set_page_url\?\.\(p, l\)\);\n    try \{\n      this\.call\(\(\) => start\(environment\)\);/);
  } finally {
    Object.assign(globalThis, saved);
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

test("an address the app sets while the browser's back pops its page wins over the entry's", () => {
  const calls = [];
  const saved = { history: globalThis.history, location: globalThis.location, document: globalThis.document };
  // Opened at a deep link: the first entry has its address.
  globalThis.location = { href: "https://a.test/inbox?message=42", origin: "https://a.test" };
  globalThis.document = { baseURI: "https://a.test/inbox?message=42" };
  globalThis.history = {
    state: null,
    pushState(state, _title, url) { calls.push(["push", state.nsh, url ?? null]); this.state = state; },
    replaceState(state, _title, url) { calls.push(["replace", state?.nsh, url]); },
    go(n) { calls.push(["go", n]); },
  };
  try {
    let depth = 1;
    const player = Object.create(Player.prototype);
    Object.assign(player, {
      history: true, historyDepth: 1, historyIndex: 1, historyDepths: [0, 1], ignoredPops: 0, historySession: "s", pageUrl: null,
      backDepth: () => depth, showError: (m) => calls.push(["error", m]),
      event: (id, name, payload) => calls.push(["event", name, payload]),
    });
    player.syncHistorySoon = () => player.syncHistory();
    // A pop with no motion: the app's `onChange` sets the address at once.
    player.back = () => { depth--; player.setPageUrl("."); return true; };
    player.popState({ state: { nsh: 0, nshSession: "s" } });
    assert.deepEqual(calls.splice(0), [["replace", undefined, "https://a.test/"]]);
  } finally {
    Object.assign(globalThis, saved);
  }
});

test("an earlier load's entry is handed to the app as a link and becomes its first", () => {
  const calls = [];
  const saved = { history: globalThis.history, location: globalThis.location };
  globalThis.location = { href: "https://a.test/inbox?message=3" };
  globalThis.history = {
    state: null,
    replaceState(state) { calls.push(["replace", state.nsh, state.nshSession]); this.state = state; },
    back() { calls.push(["back"]); },
  };
  try {
    const player = Object.create(Player.prototype);
    Object.assign(player, {
      history: true, historyDepth: 0, ignoredPops: 0, historySession: "now", pageUrl: null,
      event: (id, name, payload) => calls.push(["event", name, payload]),
    });
    player.popState({ state: { nsh: 2, nshSession: "earlier" } });
    // In a session of its own: this load's entries after it are earlier
    // ones too, so a forward to them is a link as well.
    assert.notEqual(player.historySession, "now");
    assert.deepEqual(calls.splice(0), [
      ["replace", 0, player.historySession],
      ["event", "onUrlScheme", { url: "https://a.test/inbox?message=3", page: true }],
    ]);
    assert.equal(player.firstUrl, "https://a.test/inbox?message=3");
    location.href = "https://a.test/inbox";
    player.popState({ state: { nsh: 0, nshSession: "now" } });
    assert.deepEqual(calls.splice(0), [
      ["replace", 0, player.historySession],
      ["event", "onUrlScheme", { url: "https://a.test/inbox", page: true }],
    ]);
    // An entry from before the app's own: the app stays at its start.
    player.popState({ state: null });
    assert.deepEqual(calls, []);
  } finally {
    Object.assign(globalThis, saved);
  }
});

test("a forward the app shows goes on from the entry the browser is at", () => {
  const calls = [];
  const saved = { history: globalThis.history, location: globalThis.location };
  globalThis.location = { href: "https://a.test/inbox" };
  globalThis.history = {
    state: null,
    pushState(state) { calls.push(["push", state.nsh]); this.state = state; },
    replaceState(state, _title, url) { calls.push(["replace", state?.nsh, url]); },
    go(n) { calls.push(["go", n]); },
  };
  try {
    let depth = 0;
    const player = Object.create(Player.prototype);
    Object.assign(player, {
      history: true, historyDepth: 0, historyIndex: 0, historyDepths: [0], ignoredPops: 0, historySession: "s", pageUrl: null,
      backDepth: () => depth, showError: (m) => calls.push(["error", m]),
      // The app takes the link: its stack shows the page again.
      event: (id, name, payload) => { calls.push(["event", name, payload]); if (!payload.quiet) depth = 1; },
    });
    player.syncHistorySoon = () => player.syncHistory();
    location.href = "https://a.test/inbox?message=a";
    player.popState({ state: { nsh: 1, nshSession: "s" } });
    // No traversal and no new entry: the browser is at the page's already.
    assert.deepEqual(calls.splice(0), [["event", "onUrlScheme", { url: "https://a.test/inbox?message=a", page: true }]]);
    assert.equal(player.historyDepth, 1);
  } finally {
    Object.assign(globalThis, saved);
  }
});

/** A player over a fake browser history whose entries `popState` gets as
 * the browser gives them: `go(n)` lands at once (the player's own pops are
 * ignored), `user(n)` is the browser's back (-1) or forward (1). `depth` is
 * the app's back depth; `calls` what reaches the history and the core. */
/** `before`: the page's own state-less entries before the app's first (a
 * `#fragment` followed while the app loaded, the host page's `pushState`).
 * `navigation`: whether the browser has the Navigation API. */
function historyPlayer(t, { href = "https://a.test/inbox", before = [], navigation = true } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const saved = {
    history: globalThis.history,
    location: globalThis.location,
    window: globalThis.window,
    document: globalThis.document,
    navigation: globalThis.navigation,
  };
  t.after(() => Object.assign(globalThis, saved));
  const entries = [...before.map((url) => ({ state: null, url })), { state: null, url: href }];
  globalThis.document = { baseURI: href };
  let at = entries.length - 1;
  globalThis.navigation = navigation ? { get currentEntry() { return { index: at }; } } : undefined;
  globalThis.location = { href, origin: "https://a.test" };
  globalThis.window = { addEventListener() {} };
  const land = () => {
    location.href = entries[at].url;
    player.popState({ state: entries[at].state });
  };
  globalThis.history = {
    get state() { return entries[at].state; },
    pushState(state, _title, url) {
      entries.length = ++at;
      entries.push({ state, url: url ?? location.href });
      if (url != null) location.href = url;
      calls.push(["push", state.nsh, state.nshIndex, ...(url == null ? [] : [url])]);
    },
    replaceState(state, _title, url) {
      entries[at] = { state, url: url ?? location.href };
      if (url != null) location.href = url;
      calls.push(["replace", state?.nsh, state?.nshIndex, ...(url == null ? [] : [url])]);
    },
    go(n) {
      calls.push(["go", n]);
      at += n;
      land();
    },
  };
  const app = { depth: 0, lets: true };
  const player = Object.create(Player.prototype);
  Object.assign(player, {
    history: true, pageUrl: null,
    backDepth: () => app.depth, showError: (m) => calls.push(["error", m]),
    back: () => app.lets && app.depth > 0 && (app.depth--, true),
    event: (id, name, payload) => calls.push(["event", name, payload]),
  });
  player.syncHistorySoon = () => player.syncHistory();
  player.installHistory();
  calls.length = 0;
  const user = (n) => {
    at += n;
    land();
  };
  // An address the user types: a new entry with no state.
  const type = (url) => {
    entries.length = ++at;
    entries.push({ state: null, url });
    land();
  };
  return { player, calls, app, user, type, entries: () => entries, at: () => at };
}

test("an address the user types is an entry of the app's, and back and forward between such entries move the app (change)", (t) => {
  const { player, calls, user, type } = historyPlayer(t);
  type("https://a.test/inbox#archive");
  assert.deepEqual(calls.splice(0), [
    ["replace", 0, 1],
    ["event", "onUrlScheme", { url: "https://a.test/inbox#archive", page: true, change: "address" }],
  ]);
  user(-1);
  assert.deepEqual(calls.splice(0), [["event", "onUrlScheme", { url: "https://a.test/inbox", page: true, change: "back" }]]);
  assert.equal(player.firstUrl, "https://a.test/inbox");
  user(1);
  assert.deepEqual(calls.splice(0), [["event", "onUrlScheme", { url: "https://a.test/inbox#archive", page: true, change: "forward" }]]);
  // Its pages stayed: the app's back from a page pushed there goes back to it.
  assert.equal(player.historyDepth, 0);
});

test("a back to the page's own entry before the app's first is a back past the first entry, not a typed address", (t) => {
  const { player, calls, app, user } = historyPlayer(t, { before: ["https://a.test/inbox#intro"] });
  app.depth = 1;
  player.syncHistory();
  calls.splice(0);
  // Back twice from the page: past the app's first entry, to the page's own.
  user(-2);
  // The app goes back to its start, and hears no change.
  assert.equal(app.depth, 0);
  assert.deepEqual(calls.splice(0), []);
  assert.equal(player.historyIndex, 0);
});

test("a forward from the page's own entry back to the app's first is no back", (t) => {
  const { calls, user } = historyPlayer(t, { before: ["https://a.test/inbox#intro"] });
  user(-1);
  assert.deepEqual(calls.splice(0), []);
  user(1);
  assert.ok(
    calls.every(([kind, , payload]) => kind !== "event" || payload?.change !== "back"),
    JSON.stringify(calls),
  );
});

test("without the Navigation API a state-less entry is an address the user typed", (t) => {
  const { calls, type } = historyPlayer(t, { navigation: false });
  type("https://a.test/inbox#archive");
  assert.deepEqual(calls.splice(0), [
    ["replace", 0, 1],
    ["event", "onUrlScheme", { url: "https://a.test/inbox#archive", page: true, change: "address" }],
  ]);
});

test("an address typed over a pushed page stays at its depth, and the app's own back goes over it", (t) => {
  const { player, calls, app, type, at } = historyPlayer(t);
  app.depth = 1;
  player.syncHistory();
  type("https://a.test/inbox#reply");
  calls.splice(0);
  // The app pops its page itself: back to the first entry, past the typed one.
  app.depth = 0;
  player.syncHistory();
  assert.deepEqual(calls.splice(0), [["go", -2], ["event", "onUrlScheme", { url: "https://a.test/inbox", page: true, quiet: true }]]);
  assert.equal(at(), 0);
  assert.equal(player.historyIndex, 0);
});

test("an address the app sets on an entry the user typed is not its first entry's", (t) => {
  const { player, type } = historyPlayer(t);
  type("https://a.test/inbox#archive");
  player.setPageUrl("https://a.test/inbox#archive?sort=new");
  assert.equal(player.firstUrl, "https://a.test/inbox");
});

test("a back that pops a page whose address the app does not set moves the app's address once the page is dismissed", (t) => {
  const { player, calls, app, user, type } = historyPlayer(t);
  type("https://a.test/inbox?tab=b");
  app.depth = 1;
  player.syncHistory();
  calls.splice(0);
  // Back twice at once (the back button's menu): the page pops, and the
  // address below it is another tab's.
  player.dismissing = 1;
  user(-2);
  assert.deepEqual(calls.splice(0), [["event", "onUrlScheme", { url: "https://a.test/inbox", page: true, quiet: true }]]);
  t.mock.timers.tick(0);
  assert.deepEqual(calls, [], "the page is still going");
  player.dismissing = 0;
  player.settlePop();
  assert.deepEqual(calls.splice(0), [["event", "onUrlScheme", { url: "https://a.test/inbox", page: true, change: "back" }]]);
});

test("a back that pops a page the app gives an address to is the stack's alone, and an app that never answers is not waited for", (t) => {
  const { player, calls, app, user, type } = historyPlayer(t);
  type("https://a.test/inbox?tab=b");
  app.depth = 1;
  player.syncHistory();
  calls.splice(0);
  player.dismissing = 1;
  user(-2);
  calls.splice(0);
  // `onChange` answers the dismissal with the address.
  player.dismissing = 0;
  player.setPageUrl("https://a.test/inbox?tab=b");
  t.mock.timers.tick(0);
  assert.deepEqual(calls.splice(0), [["replace", 0, 0, "https://a.test/inbox?tab=b"]]);
  // A page whose dismissal never comes: its address is the app's after a while.
  type("https://a.test/inbox?tab=c");
  app.depth = 1;
  player.syncHistory();
  player.dismissing = 1;
  user(-2);
  calls.splice(0);
  t.mock.timers.tick(1499);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  assert.deepEqual(calls.splice(0), [["event", "onUrlScheme", { url: "https://a.test/inbox?tab=b", page: true, change: "back" }]]);
});

test("a forward to a page the stack no longer has is still a link (open), not a change", (t) => {
  const { player, calls, app, user } = historyPlayer(t);
  app.depth = 1;
  player.syncHistory();
  app.depth = 0;
  player.syncHistory();
  calls.splice(0);
  // Its entry is still the browser's forward one.
  app.depth = 0;
  user(1);
  assert.equal(calls[0][2].change, undefined);
  assert.deepEqual(calls[0], ["event", "onUrlScheme", { url: "https://a.test/inbox", page: true }]);
});

/** Runs `turn` as one engine turn of the app's: what it sets is synced
 * once, after it. */
function inOneTurn(player, turn) {
  const soon = player.syncHistorySoon;
  player.syncHistorySoon = () => {};
  try {
    turn();
  } finally {
    player.syncHistorySoon = soon;
  }
  player.syncHistory();
}

test("UrlScheme.setUrl with history push makes an entry of its own at the pages shown, which the browser's back goes back from", (t) => {
  const { player, calls, user } = historyPlayer(t);
  player.setPageUrl("?tab=live", true);
  assert.deepEqual(calls.splice(0), [["push", 0, 1, "https://a.test/inbox?tab=live"]]);
  assert.equal(player.historyDepth, 0);
  assert.equal(player.firstUrl, "https://a.test/inbox", "the first entry keeps its address");
  user(-1);
  assert.deepEqual(calls.splice(0), [["event", "onUrlScheme", { url: "https://a.test/inbox", page: true, change: "back" }]]);
  user(1);
  assert.deepEqual(calls.splice(0), [["event", "onUrlScheme", { url: "https://a.test/inbox?tab=live", page: true, change: "forward" }]]);
});

test("in one turn, pushes make one entry with the last address, and a push wins over a replace", (t) => {
  const { player, calls } = historyPlayer(t);
  inOneTurn(player, () => {
    player.setPageUrl("?tab=live", true);
    player.setPageUrl("?tab=all", true);
    player.setPageUrl("?tab=mine");
  });
  assert.deepEqual(calls.splice(0), [["push", 0, 1, "https://a.test/inbox?tab=mine"]]);
  // A replace in a later turn is the pushed entry's.
  player.setPageUrl("?tab=mine&sort=new");
  assert.deepEqual(calls.splice(0), [["replace", 0, 1, "https://a.test/inbox?tab=mine&sort=new"]]);
});

test("a push in the turn that pushes a page gives the page's entry its address, with no entry of its own", (t) => {
  const { player, calls, app } = historyPlayer(t);
  inOneTurn(player, () => {
    app.depth = 1;
    player.setPageUrl("?message=42", true);
  });
  assert.deepEqual(calls.splice(0), [["push", 1, 1], ["replace", 1, 1, "https://a.test/inbox?message=42"]]);
});

test("a push in the turn that pops a page waits for the back over its entry, then makes its own", (t) => {
  const { player, calls, app, at } = historyPlayer(t);
  app.depth = 1;
  player.syncHistory();
  calls.splice(0);
  inOneTurn(player, () => {
    app.depth = 0;
    player.setPageUrl("?tab=all", true);
  });
  assert.deepEqual(calls.splice(0), [["go", -1], ["push", 0, 1, "https://a.test/inbox?tab=all"]]);
  assert.equal(at(), 1);
  assert.equal(player.historyDepth, 0);
});

test("a push drops the browser's forward entries, and the address shown makes none", (t) => {
  const { player, calls, user, entries } = historyPlayer(t);
  player.setPageUrl("?tab=live", true);
  player.setPageUrl("?tab=all", true);
  user(-2);
  calls.splice(0);
  player.setPageUrl("?tab=mine", true);
  assert.deepEqual(calls.splice(0), [["push", 0, 1, "https://a.test/inbox?tab=mine"]]);
  assert.equal(entries().length, 2);
  assert.deepEqual(player.historyDepths, [0, 0]);
  // The address the entry has already: no entry.
  player.setPageUrl("?tab=mine", true);
  assert.deepEqual(calls.splice(0), [["replace", 0, 1, "https://a.test/inbox?tab=mine"]]);
});

test("a new run drops a push waiting for its turn", (t) => {
  const { player, calls } = historyPlayer(t);
  player.syncHistorySoon = () => {};
  player.setPageUrl("?tab=live", true);
  player.resetHistory();
  player.syncHistory();
  assert.deepEqual(calls, []);
  assert.equal(player.pageUrlPush, false);
});

test("a key event without `key` falls back to its physical key instead of throwing", () => {
  assert.equal(keyCode({ code: "KeyA" }), 97);
  assert.equal(keyCode({ key: null, code: "Digit3" }), 51);
  assert.equal(keyCode({}), -1);
  assert.equal(keyCode({ key: "a", code: "KeyA" }), 97);
});

/** A browser clipboard that keeps what is written and image codecs that
 * record their work; `failWrite` makes `navigator.clipboard.write` reject. */
function fakeClipboard(t, { failWrite } = {}) {
  const log = { items: [], decoded: [], closed: 0, warnings: [] };
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const { ClipboardItem, createImageBitmap, OffscreenCanvas } = globalThis;
  const warn = console.warn;
  t.after(() => {
    Object.defineProperty(globalThis, "navigator", saved);
    Object.assign(globalThis, { ClipboardItem, createImageBitmap, OffscreenCanvas });
    console.warn = warn;
  });
  console.warn = (m) => log.warnings.push(m);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        write(items) {
          log.items.push(...items);
          return failWrite ? Promise.reject(new Error(failWrite)) : Promise.resolve();
        },
      },
    },
  });
  globalThis.ClipboardItem = class {
    constructor(data) {
      this.data = data;
    }
  };
  globalThis.createImageBitmap = async (blob) => {
    log.decoded.push(blob.type);
    return { width: 3, height: 2, close: () => log.closed++ };
  };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      Object.assign(this, { width, height });
    }
    getContext() {
      return { drawImage() {} };
    }
    async convertToBlob({ type }) {
      return new Blob([`${this.width}x${this.height}`], { type });
    }
  };
  return log;
}

test("an image that is not a PNG goes on the clipboard as a PNG", async (t) => {
  const log = fakeClipboard(t);
  const { player } = fakePlayer();
  const done = player.writeClipboardImage("data:image/jpeg;base64,/9j/");
  // Written at once: Safari only writes within the user's gesture.
  assert.equal(log.items.length, 1);
  await done;
  assert.deepEqual(Object.keys(log.items[0].data), ["image/png", "text/html"]);
  const png = await log.items[0].data["image/png"];
  assert.equal(png.type, "image/png");
  assert.equal(await png.text(), "3x2");
  assert.deepEqual(log.decoded, ["image/jpeg"]);
  assert.equal(log.closed, 1);
  assert.deepEqual(log.warnings, []);
});

test("a PNG goes on the clipboard as it is", async (t) => {
  const log = fakeClipboard(t);
  const { player } = fakePlayer();
  await player.writeClipboardImage(`data:image/png;base64,${btoa("png bytes")}`);
  const png = await log.items[0].data["image/png"];
  assert.equal(await png.text(), "png bytes");
  assert.deepEqual(log.decoded, []);
});

test("a data: URI's image is decoded without fetch, which a page's CSP may refuse", async (t) => {
  const log = fakeClipboard(t);
  const { player } = fakePlayer();
  const fetched = await withFetch(() => {
    throw new TypeError("Failed to fetch");
  }, () => player.writeClipboardImage(`data:image/png;base64,${btoa("png bytes")}`));
  assert.deepEqual(fetched, []);
  assert.equal(await (await log.items[0].data["image/png"]).text(), "png bytes");
  assert.deepEqual(log.warnings, []);
});

test("a GIF goes on beside its PNG as it is, as HTML and as Chromium's web format", async (t) => {
  const log = fakeClipboard(t);
  globalThis.ClipboardItem.supports = (type) => type === "web image/gif";
  const { player } = fakePlayer();
  const uri = `data:image/gif;base64,${btoa("GIF89a frames")}`;
  await player.writeClipboardImage(uri);
  const { data } = log.items[0];
  assert.deepEqual(Object.keys(data), ["image/png", "text/html", "web image/gif"]);
  assert.equal(await data["text/html"].text(), `<img src="${uri}">`);
  assert.equal(await (await data["web image/gif"]).text(), "GIF89a frames");
  assert.equal((await data["image/png"]).type, "image/png");
});

test("reading the clipboard's image takes the original kept beside its PNG", async (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const { FileReader, Image } = globalThis;
  t.after(() => {
    Object.defineProperty(globalThis, "navigator", saved);
    Object.assign(globalThis, { FileReader, Image });
  });
  const item = {
    types: ["image/png", "web image/gif"],
    getType: async (type) => new Blob([type === "image/png" ? "png" : "GIF89a"], { type }),
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { read: async () => [item] } } });
  globalThis.FileReader = class {
    async readAsDataURL(blob) {
      this.result = `data:${blob.type};base64,${btoa(await blob.text())}`;
      this.onload();
    }
  };
  globalThis.Image = class {
    naturalWidth = 1;
    naturalHeight = 1;
    set src(_) {
      this.onload();
    }
  };
  const { player, sent } = fakePlayer();
  await player.readClipboardImage(7, false);
  await new Promise((resolve) => setTimeout(resolve));
  assert.deepEqual(sent, [["onClipboard", { id: 7, has: true, uri: `data:image/gif;base64,${btoa("GIF89a")}`, width: 1, height: 1 }]]);
});

test("an image the clipboard does not take is reported with a warning", async (t) => {
  const log = fakeClipboard(t, { failWrite: "Document is not focused." });
  const { player } = fakePlayer();
  await player.writeClipboardImage("data:image/png;base64,");
  assert.deepEqual(log.warnings, ["[nsh] Clipboard.writeImage: Document is not focused."]);
});

test("a page without the async clipboard reports a write with a warning", async (t) => {
  const log = fakeClipboard(t);
  globalThis.navigator.clipboard = undefined;
  const { player } = fakePlayer();
  await player.writeClipboardImage("data:image/png;base64,");
  assert.equal(log.warnings.length, 1);
});
