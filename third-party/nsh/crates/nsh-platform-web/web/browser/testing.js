// A test session's app realm: its time and its connections are the
// engine's. On a manual clock (`open(..., { clock: {} })`) the browser's
// timers, frames, `Date` and `performance.now()` would run on the page's
// time, which the test cannot move, so the engine keeps them (`timers.rs`)
// and runs them as `app.clock` moves it. A `WebSocket` the engine refuses
// (off the network unless `network: "live"`) opens nothing; a test's
// `fetch` is `fetch.js`'. Installed before the entry is imported.

const define = (target, name, value) =>
  Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });

function installClock(target, call, active, wake) {
  const NativeDate = target.Date;
  const now = () => call(1001, []);
  // The intrinsic given the clock's time when given none; its prototype
  // stays, so dates, `instanceof Date` and subclasses behave as before.
  function ClockDate(...args) {
    if (new.target === undefined) return new NativeDate(now()).toString();
    return Reflect.construct(NativeDate, args.length ? args : [now()], new.target);
  }
  Object.defineProperty(ClockDate, "name", { value: "Date", configurable: true });
  Object.defineProperty(ClockDate, "length", { value: 7, configurable: true });
  Object.defineProperty(ClockDate, "prototype", { value: NativeDate.prototype, writable: false });
  define(NativeDate.prototype, "constructor", ClockDate);
  define(ClockDate, "UTC", NativeDate.UTC);
  define(ClockDate, "parse", NativeDate.parse);
  define(ClockDate, "now", function now() { return call(1001, []); });
  define(target, "Date", ClockDate);

  const performance = target.performance;
  if (performance) {
    define(performance, "now", function now() { return call(1002, []); });
    Object.defineProperty(performance, "timeOrigin", { value: call(1001, []) - call(1002, []), configurable: true });
  }

  // Each callback ends with a pump: what its promises do afterwards is
  // committed too.
  const guarded = (callback, args) => (...more) => {
    if (!active()) return;
    try { callback.apply(undefined, args ?? more); } finally { wake(); }
  };
  const handler = (name, callback) => {
    if (typeof callback !== "function") throw new TypeError(`${name}: the handler is not a function`);
    return callback;
  };
  define(target, "setTimeout", function setTimeout(callback, delay, ...args) {
    return call(1003, [guarded(handler("setTimeout", callback), args), Number(delay), false]);
  });
  define(target, "setInterval", function setInterval(callback, delay, ...args) {
    return call(1003, [guarded(handler("setInterval", callback), args), Number(delay), true]);
  });
  const clear = id => { if (typeof id === "number") call(1004, [id]); };
  define(target, "clearTimeout", function clearTimeout(id) { clear(id); });
  define(target, "clearInterval", function clearInterval(id) { clear(id); });
  define(target, "requestAnimationFrame", function requestAnimationFrame(callback) {
    return call(1005, [guarded(handler("requestAnimationFrame", callback))]);
  });
  define(target, "cancelAnimationFrame", function cancelAnimationFrame(id) {
    if (typeof id === "number") call(1006, [id]);
  });
}

const WEBSOCKET_SCHEMES = { "ws:": "ws:", "wss:": "wss:", "http:": "ws:", "https:": "wss:" };

// The realm's `WebSocket`, which asks the engine first (`System::
// refuse_connections`, a test's network): a socket it refuses opens
// nothing and, as nsh-js' global and a browser's refused connection, fires
// `error` (with the engine's `message`) and then `close` (1006, not clean)
// after the constructor returns, so handlers set in the same turn hear
// them. The others are the browser's own.
function installWebSocket(target, call, active, wake) {
  const NativeWebSocket = target.WebSocket;
  if (typeof NativeWebSocket !== "function") return;
  const { Event, CloseEvent, EventTarget, DOMException, URL, TypeError: RealmTypeError } = target;
  const refused = (newTarget, url, message) => {
    const socket = Reflect.construct(EventTarget, [], newTarget);
    let readyState = NativeWebSocket.CONNECTING;
    let binaryType = "blob";
    const handlers = { open: null, message: null, error: null, close: null };
    const own = (name, descriptor) =>
      Object.defineProperty(socket, name, { configurable: true, enumerable: true, ...descriptor });
    own("url", { value: url });
    own("protocol", { value: "" });
    own("extensions", { value: "" });
    own("bufferedAmount", { value: 0 });
    own("readyState", { get: () => readyState });
    own("binaryType", {
      get: () => binaryType,
      set: value => { if (value === "blob" || value === "arraybuffer") binaryType = value; },
    });
    for (const kind of Object.keys(handlers)) {
      own(`on${kind}`, {
        get: () => handlers[kind],
        set: value => { handlers[kind] = typeof value === "function" ? value : null; },
      });
      socket.addEventListener(kind, event => handlers[kind]?.call(socket, event));
    }
    own("send", {
      value: function send() {
        if (readyState === NativeWebSocket.CONNECTING) throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
      },
    });
    own("close", {
      value: function close() {
        if (readyState === NativeWebSocket.CONNECTING) readyState = NativeWebSocket.CLOSING;
      },
    });
    Promise.resolve().then(() => {
      if (!active()) return;
      try {
        readyState = NativeWebSocket.CLOSED;
        const error = new Event("error");
        Object.defineProperty(error, "message", { value: message, enumerable: true });
        socket.dispatchEvent(error);
        socket.dispatchEvent(new CloseEvent("close", { code: 1006, reason: "", wasClean: false }));
      } finally { wake(); }
    });
    return socket;
  };
  function WebSocket(url, protocols) {
    if (new.target === undefined) throw new RealmTypeError("Failed to construct 'WebSocket': Please use the 'new' operator");
    const args = protocols === undefined ? [url] : [url, protocols];
    let parsed = null;
    try { parsed = new URL(String(url), target.location?.href); } catch { /* the browser's error */ }
    const scheme = parsed && !parsed.hash && WEBSOCKET_SCHEMES[parsed.protocol];
    if (scheme) {
      parsed.protocol = scheme;
      const message = call(1010, [parsed.href]);
      if (typeof message === "string") return refused(new.target, parsed.href, message);
    }
    return Reflect.construct(NativeWebSocket, args, new.target);
  }
  Object.setPrototypeOf(WebSocket, NativeWebSocket);
  Object.defineProperty(WebSocket, "prototype", { value: NativeWebSocket.prototype, writable: false });
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
    Object.defineProperty(WebSocket, name, { value: NativeWebSocket[name], enumerable: true });
  }
  define(NativeWebSocket.prototype, "constructor", WebSocket);
  define(target, "WebSocket", WebSocket);
}

/**
 * Puts the engine's clock and sockets in `target`'s place (the app realm's
 * global object) where the session needs them: the clock when the
 * engine's is manual, `WebSocket` when `network` (a test session). `call`
 * is the host's operation call; callbacks end with `wake` (a pump).
 */
export function installTesting(target, call, { active = () => true, wake = () => {}, network = false } = {}) {
  const clock = call(1000, []) === true;
  if (clock) installClock(target, call, active, wake);
  if (network) installWebSocket(target, call, active, wake);
  return { clock, network };
}
