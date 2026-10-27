// nsh.js's host channel without a browser or nsh.wasm:
// `node --test crates/nsh-platform-web/web/nsh.test.mjs`. A fake engine
// records what reaches it through the real `call` / `withStrings` path.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("nsh.js", import.meta.url), "utf8");
// `Player` is not exported; the page only gets it from `createPlayer`.
const { Player } = await import(
  `data:text/javascript,${encodeURIComponent(`${source}\nexport { Player };`)}`
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

test("run stages static source and bytecode chunks before starting the entry", () => {
  const { player } = fakePlayer();
  const calls = [];
  const text = (ptr, len) => new TextDecoder().decode(new Uint8Array(player.wasm.memory.buffer, ptr, len));
  player.reset = () => [800, 600];
  player.begin = () => calls.push(["start"]);
  player.wasm.nsh_bundle_options = () => calls.push(["options"]);
  player.wasm.nsh_bundle_chunk = (np, nl, cp, cl, bytecode) => {
    calls.push([text(np, nl), bytecode, [...new Uint8Array(player.wasm.memory.buffer, cp, cl)]]);
  };
  player.run("entry", {
    chunkBase: "https://example.test/",
    preloadedChunks: {
      "source.js": "export {}",
      "bytecode.js": new Uint8Array([1, 2, 3]).buffer,
    },
  });
  assert.deepEqual(calls, [
    ["options"],
    ["source.js", 0, [...new TextEncoder().encode("export {}")]],
    ["bytecode.js", 1, [1, 2, 3]],
    ["start"],
  ]);
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
