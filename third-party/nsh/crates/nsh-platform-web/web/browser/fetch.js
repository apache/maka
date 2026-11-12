// The app realm's `fetch`, through the engine's network (`fetch.rs`)
// where the browser's own cannot answer as the app means: in every session
// for the app's files (`asset:/`), a scheme the browser does not know,
// which the engine reads as it does on every platform; in a test session
// for HTTP too, where the test's routes answer it and `app.requests()`
// records it. `data:` and `blob:` URLs, and HTTP outside tests, stay the
// browser's. Installed before the entry is imported.

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * Puts the engine's network in the place of `target`'s `fetch` (the app
 * realm's global object) for the requests that need it: the app's files
 * always, HTTP when `network` (a test session). `call` is the host's
 * operation call; callbacks end with `wake` (a pump).
 */
export function installFetch(target, call, { active = () => true, wake = () => {}, network = false } = {}) {
  const { Request, Response, ReadableStream, TypeError: RealmTypeError } = target;
  const nativeFetch = target.fetch;
  const failure = message => new RealmTypeError(`Network request failed: ${message}`);
  const inflight = new Map();
  const finish = id => {
    const entry = inflight.get(id);
    if (!entry) return undefined;
    inflight.delete(id);
    entry.signal.removeEventListener("abort", entry.abort);
    return entry;
  };
  const head = (id, entry, [status, statusText, url, redirected, headers]) => {
    if (entry.redirectError && REDIRECTS.has(status)) {
      finish(id);
      call(1009, [id]);
      entry.reject(failure('the response was a redirect and redirect is "error"'));
      return;
    }
    let body = null;
    if (!entry.nullBody && !NULL_BODY.has(status)) {
      body = new ReadableStream({
        start(controller) { entry.controller = controller; },
        cancel() { if (finish(id)) call(1009, [id]); },
      });
    }
    let response;
    try {
      response = new Response(body, { status, statusText, headers });
    } catch (error) {
      finish(id);
      call(1009, [id]);
      entry.reject(error);
      return;
    }
    // What a network response reports, which a constructed one cannot.
    Object.defineProperties(response, {
      url: { value: url, configurable: true },
      redirected: { value: redirected, configurable: true },
      type: { value: "basic", configurable: true },
    });
    entry.resolve(response);
    entry.resolve = entry.reject = null;
  };
  call(1007, [(id, kind, ...data) => {
    const entry = inflight.get(id);
    if (!entry || !active()) return;
    try {
      switch (kind) {
        case 0: if (entry.resolve) head(id, entry, data); break;
        case 1: entry.controller?.enqueue(data[0]); break;
        case 2:
          finish(id);
          if (entry.reject) entry.reject(failure("the response ended before its head"));
          else entry.controller?.close();
          break;
        case 3: {
          finish(id);
          const error = failure(data[0]);
          if (entry.reject) entry.reject(error); else entry.controller?.error(error);
          break;
        }
        case 4: {
          // Refused by the capabilities: a TypeError as fetch's, with the
          // code, the capability and the URL refused.
          finish(id);
          const error = Object.assign(failure(data[0]), { code: "ERR_ACCESS_DENIED", permission: "network", resource: data[1] });
          if (entry.reject) entry.reject(error); else entry.controller?.error(error);
          break;
        }
      }
    } finally { wake(); }
  }]);

  // The scheme `input` names, read without making a `Request` of it: one
  // made of a stream or of another request takes its body, which the
  // browser's own fetch then could not send.
  const schemeOf = input => {
    try {
      return new URL(input instanceof Request ? input.url : String(input), target.location?.href).protocol;
    } catch {
      return "";
    }
  };
  async function fetch(input, init) {
    // The app's files are the engine's to read (the browser knows no
    // `asset:`), HTTP only a test's; `data:` and `blob:` URLs, and what does
    // not parse, stay the browser's.
    const protocol = schemeOf(input);
    const http = protocol === "http:" || protocol === "https:";
    if (protocol !== "asset:" && !(network && http)) return nativeFetch.call(target, input, init);
    const request = new Request(input, init);
    const { signal } = request;
    if (signal.aborted) throw signal.reason;
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    if (signal.aborted) throw signal.reason;
    const headers = [...request.headers];
    if (!request.headers.has("accept")) headers.push(["accept", "*/*"]);
    const url = request.url.split("#")[0];
    return new Promise((resolve, reject) => {
      const id = call(1008, [request.method, url, headers, body, request.redirect === "follow"]);
      const entry = {
        resolve, reject, signal, controller: null,
        nullBody: request.method === "HEAD", redirectError: request.redirect === "error",
        abort() {
          if (!finish(id)) return;
          call(1009, [id]);
          const reason = signal.reason;
          if (entry.reject) entry.reject(reason); else entry.controller?.error(reason);
          wake();
        },
      };
      inflight.set(id, entry);
      signal.addEventListener("abort", entry.abort);
      wake();
    });
  }
  Object.defineProperty(target, "fetch", { value: fetch, writable: true, configurable: true, enumerable: false });
}
