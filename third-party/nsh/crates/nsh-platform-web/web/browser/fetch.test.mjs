import test from "node:test";
import assert from "node:assert/strict";
import { installFetch } from "./fetch.js";

// The host's side of the requests (`fetch.rs`): what the realm asks, and
// the engine's events the test sends back.
function engine() {
  const state = { next: 0, ops: [], listener: null };
  const call = (op, args) => {
    switch (op) {
      case 1007: state.listener = args[0]; return undefined;
      case 1008: state.ops.push(["start", ...args]); return ++state.next;
      case 1009: state.ops.push(["cancel", args[0]]); return undefined;
      default: throw new Error(`unknown operation ${op}`);
    }
  };
  return { state, call, event(...args) { state.listener(...args); } };
}

function realm() {
  return { fetch: async () => "native", Request, Response, ReadableStream, TypeError };
}

test("outside tests HTTP stays the browser's, handed over as it came", async () => {
  const target = realm(), host = engine();
  installFetch(target, host.call);
  assert.equal(await target.fetch("https://example.com/posts"), "native");
  // A request's body is still there for the browser's fetch to send.
  const post = new Request("https://example.com/posts", { method: "POST", body: "hi" });
  assert.equal(await target.fetch(post), "native");
  assert.equal(post.bodyUsed, false);
  assert.deepEqual(host.state.ops, []);
});

test("fetch reads the app's files through the engine in every session", async () => {
  const target = realm(), host = engine();
  installFetch(target, host.call);
  const pending = target.fetch("asset:/@app/data/en.json");
  await new Promise(resolve => setImmediate(resolve));
  const [start] = host.state.ops;
  assert.deepEqual(start.slice(0, 3), ["start", "GET", "asset:/@app/data/en.json"]);
  const id = host.state.next;
  host.event(id, 0, 200, "OK", "asset:/@app/data/en.json", false, [["content-type", "application/json"]]);
  const response = await pending;
  assert.equal(response.url, "asset:/@app/data/en.json");
  assert.equal(response.headers.get("content-type"), "application/json");
  host.event(id, 1, new TextEncoder().encode('{"hello":"Hi"}'));
  host.event(id, 2);
  assert.deepEqual(await response.json(), { hello: "Hi" });
  // A file the engine does not find rejects as fetch's network errors do.
  const missing = target.fetch(new Request("asset:/@app/missing.json"));
  await new Promise(resolve => setImmediate(resolve));
  host.event(host.state.next, 3, "asset:/@app/missing.json is not bundled");
  await assert.rejects(missing, TypeError);
});


test("fetch goes through the engine's network", async () => {
  const target = realm(), host = engine();
  let wakes = 0;
  installFetch(target, host.call, { network: true, wake: () => wakes++ });
  const pending = target.fetch("https://example.com/posts#top", { method: "POST", body: "hi", headers: { "x-a": "1" } });
  await new Promise(resolve => setImmediate(resolve));
  const [start] = host.state.ops;
  assert.equal(start[0], "start");
  assert.equal(start[1], "POST");
  assert.equal(start[2], "https://example.com/posts");
  assert.deepEqual(Object.fromEntries(start[3]), { accept: "*/*", "content-type": "text/plain;charset=UTF-8", "x-a": "1" });
  assert.deepEqual([...start[4]], [...new TextEncoder().encode("hi")]);
  assert.ok(start[4] instanceof Uint8Array);
  assert.equal(start[5], true);
  const id = host.state.next;
  host.event(id, 0, 201, "Created", "https://example.com/posts/1", true, [["content-type", "application/json"]]);
  const response = await pending;
  assert.ok(response instanceof Response);
  assert.equal(response.status, 201);
  assert.equal(response.statusText, "Created");
  assert.equal(response.url, "https://example.com/posts/1");
  assert.equal(response.redirected, true);
  assert.equal(response.headers.get("content-type"), "application/json");
  host.event(id, 1, new TextEncoder().encode('{"id":'));
  host.event(id, 1, new TextEncoder().encode("1}"));
  host.event(id, 2);
  assert.deepEqual(await response.json(), { id: 1 });
  assert.ok(wakes >= 4);
});


test("a failed request rejects with a TypeError", async () => {
  const target = realm(), host = engine();
  installFetch(target, host.call, { network: true });
  const pending = target.fetch("https://example.com/");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.state.ops[0][4], undefined);
  host.event(host.state.next, 3, "offline");
  await assert.rejects(pending, error => error instanceof TypeError && /offline/.test(error.message));
});

test("an aborted request is cancelled", async () => {
  const target = realm(), host = engine();
  installFetch(target, host.call, { network: true });
  const controller = new AbortController();
  const pending = target.fetch("https://example.com/", { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  const id = host.state.next;
  controller.abort(new Error("stop"));
  await assert.rejects(pending, /stop/);
  assert.deepEqual(host.state.ops.at(-1), ["cancel", id]);
  // What comes after the abort is the engine's late news: ignored.
  host.event(id, 0, 200, "OK", "https://example.com/", false, []);
  const aborted = new AbortController();
  aborted.abort(new Error("before"));
  await assert.rejects(target.fetch("https://example.com/", { signal: aborted.signal }), /before/);
});

test("an aborted body errors its stream", async () => {
  const target = realm(), host = engine();
  installFetch(target, host.call, { network: true });
  const controller = new AbortController();
  const pending = target.fetch("https://example.com/", { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  const id = host.state.next;
  host.event(id, 0, 200, "OK", "https://example.com/", false, []);
  const response = await pending;
  controller.abort(new Error("gone"));
  await assert.rejects(response.text(), /gone/);
  assert.deepEqual(host.state.ops.at(-1), ["cancel", id]);
});

test("responses without a body, redirects refused, and local URLs", async () => {
  const target = realm(), host = engine();
  installFetch(target, host.call, { network: true });
  const empty = target.fetch("https://example.com/");
  await new Promise(resolve => setImmediate(resolve));
  host.event(host.state.next, 0, 204, "", "https://example.com/", false, []);
  host.event(host.state.next, 2);
  assert.equal((await empty).body, null);

  const refused = target.fetch("https://example.com/", { redirect: "error" });
  await new Promise(resolve => setImmediate(resolve));
  const id = host.state.next;
  assert.equal(host.state.ops.at(-1)[5], false);
  host.event(id, 0, 302, "Found", "https://example.com/", false, [["location", "/elsewhere"]]);
  await assert.rejects(refused, TypeError);
  assert.deepEqual(host.state.ops.at(-1), ["cancel", id]);

  const before = host.state.ops.length;
  assert.equal(await target.fetch("data:text/plain,hi"), "native");
  assert.equal(host.state.ops.length, before);
});
