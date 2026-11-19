import test from "node:test";
import assert from "node:assert/strict";
import { installTesting } from "./testing.js";

// The host's side of the operations (`timers.rs`, the engine's check of a
// socket) on a clock the test moves, as the engine moves a manual one.
function engine({ manual = true } = {}) {
  const state = { now: 0, unix: 1_700_000_000_000, next: 0, frames: [], timers: new Map() };
  const call = (op, args) => {
    switch (op) {
      case 1000: return manual;
      case 1001: return Math.floor(state.unix + state.now);
      case 1002: return state.now;
      case 1003: {
        const id = ++state.next;
        const delay = Number.isFinite(args[1]) && args[1] > 0 ? args[1] : 0;
        state.timers.set(id, { callback: args[0], at: state.now + delay, interval: args[2] ? delay : undefined });
        return id;
      }
      case 1004: state.timers.delete(args[0]); return undefined;
      case 1005: state.frames.push([++state.next, args[0]]); return state.next;
      case 1006: state.frames = state.frames.filter(([id]) => id !== args[0]); return undefined;
      case 1010: return state.refuse ? `${args[0]}: refused` : undefined;
      default: throw new Error(`unknown operation ${op}`);
    }
  };
  return {
    state, call,
    runFor(ms) {
      const to = state.now + ms;
      for (;;) {
        const due = [...state.timers].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [id, timer] = due;
        state.now = timer.at;
        if (timer.interval === undefined) state.timers.delete(id); else timer.at = state.now + Math.max(timer.interval, 1);
        timer.callback();
      }
      state.now = to;
    },
    frame() {
      const frames = state.frames;
      state.frames = [];
      for (const [, callback] of frames) callback(state.now);
    },
  };
}

function realm() {
  // A subclass stands in for the intrinsic, so the process's own `Date`
  // keeps its prototype.
  class RealmDate extends Date {}
  const native = { setTimeout: () => "native", fetch: async () => "native" };
  return { Date: RealmDate, performance: { now: () => -1 }, setTimeout: native.setTimeout, fetch: native.fetch, native };
}

test("the system's clock keeps the browser's timers and Date", () => {
  const target = realm(), host = engine({ manual: false }), { Date: RealmDate, setTimeout } = target;
  const result = installTesting(target, host.call);
  assert.deepEqual(result, { clock: false, network: false });
  assert.equal(target.Date, RealmDate);
  assert.equal(target.setTimeout, setTimeout);
});

test("a test session's fetch is fetch.js': installTesting leaves it alone", () => {
  const target = realm(), { fetch } = target;
  assert.deepEqual(installTesting(target, engine().call, { network: true }), { clock: true, network: true });
  assert.equal(target.fetch, fetch);
});

test("Date and performance.now read the engine's clock", () => {
  const target = realm(), host = engine(), RealmDate = target.Date;
  installTesting(target, host.call);
  const { Date: ClockDate, performance } = target;
  assert.equal(ClockDate.now(), 1_700_000_000_000);
  assert.equal(new ClockDate().getTime(), 1_700_000_000_000);
  assert.equal(ClockDate(), new RealmDate(1_700_000_000_000).toString());
  assert.equal(new ClockDate(0).getTime(), 0);
  assert.equal(new ClockDate(2024, 0, 2).getFullYear(), 2024);
  assert.ok(new ClockDate() instanceof ClockDate);
  assert.ok(new ClockDate() instanceof RealmDate);
  assert.equal(new ClockDate().constructor, ClockDate);
  assert.equal(ClockDate.prototype, RealmDate.prototype);
  assert.equal(ClockDate.UTC(1970, 0, 1), 0);
  assert.equal(ClockDate.name, "Date");
  assert.equal(ClockDate.length, 7);
  class Later extends ClockDate {}
  assert.equal(new Later().getTime(), 1_700_000_000_000);
  assert.ok(new Later() instanceof Later);
  host.runFor(1500);
  assert.equal(ClockDate.now(), 1_700_000_001_500);
  assert.equal(performance.now(), 1500);
  assert.equal(performance.timeOrigin, 1_700_000_000_000);
});

test("timers run as the clock reaches them", () => {
  const target = realm(), host = engine();
  let wakes = 0;
  installTesting(target, host.call, { wake: () => wakes++ });
  const log = [];
  target.setTimeout((a, b) => log.push(`late ${a}${b}`), 20, "x", "y");
  target.setTimeout(() => log.push("soon"), 0);
  const cancelled = target.setTimeout(() => log.push("cancelled"), 10);
  target.clearTimeout(cancelled);
  const ticks = target.setInterval(() => log.push(`tick ${host.state.now}`), 1000);
  host.runFor(10);
  assert.deepEqual(log, ["soon"]);
  host.runFor(3000);
  assert.deepEqual(log, ["soon", "late xy", "tick 1000", "tick 2000", "tick 3000"]);
  target.clearInterval(ticks);
  host.runFor(5000);
  assert.equal(log.length, 5);
  assert.equal(wakes, 5);
  assert.throws(() => target.setTimeout("code", 0), TypeError);
});

test("animation frames come with the engine's frames", () => {
  const target = realm(), host = engine();
  installTesting(target, host.call);
  const times = [];
  const loop = time => { times.push(time); if (times.length < 3) target.requestAnimationFrame(loop); };
  target.requestAnimationFrame(loop);
  const cancelled = target.requestAnimationFrame(() => times.push("cancelled"));
  target.cancelAnimationFrame(cancelled);
  for (let i = 0; i < 4; i++) { host.state.now += 16; host.frame(); }
  assert.deepEqual(times, [16, 32, 48]);
});

test("a stopped app's callbacks do not run", () => {
  const target = realm(), host = engine();
  let live = true;
  installTesting(target, host.call, { active: () => live });
  const log = [];
  target.setTimeout(() => log.push("timer"), 5);
  target.requestAnimationFrame(() => log.push("frame"));
  live = false;
  host.runFor(10);
  host.frame();
  assert.deepEqual(log, []);
});

test("a WebSocket the engine refuses opens nothing: error, then close", async () => {
  class NativeWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(...args) { super(); this.args = args; }
  }
  class CloseEvent extends Event {
    constructor(type, init) { super(type); Object.assign(this, init); }
  }
  const target = { ...realm(), WebSocket: NativeWebSocket, Event, CloseEvent, EventTarget, DOMException, URL };
  const host = engine({ manual: false });
  host.state.refuse = true;
  let wakes = 0;
  installTesting(target, host.call, { network: true, wake: () => wakes++ });
  const socket = new target.WebSocket("https://example.com/live");
  assert.ok(socket instanceof target.WebSocket && socket instanceof NativeWebSocket);
  assert.equal(socket.url, "wss://example.com/live");
  assert.equal(socket.readyState, target.WebSocket.CONNECTING);
  assert.throws(() => socket.send("x"), { name: "InvalidStateError" });
  const heard = [];
  socket.onerror = event => heard.push(["error", event.message]);
  socket.addEventListener("close", event => heard.push(["close", event.code, event.wasClean]));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(heard, [["error", "wss://example.com/live: refused"], ["close", 1006, false]]);
  assert.equal(socket.readyState, target.WebSocket.CLOSED);
  assert.ok(wakes >= 1);
  // Live: the browser's own.
  host.state.refuse = false;
  const live = new target.WebSocket("ws://example.com/", "chat");
  assert.deepEqual(live.args, ["ws://example.com/", "chat"]);
  assert.ok(live instanceof target.WebSocket);
});
