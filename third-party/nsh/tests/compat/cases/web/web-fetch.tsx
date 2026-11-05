// A case of the API's test suite (docs/dev/compatibility.md): `Headers`,
// `Request`, `Response` (Fetch Standard: bodies, cloning, statics) and
// `fetch` of what needs no network: `data:`, `blob:` and `asset:` URLs
// (a file the app ships), aborts and refused URLs. Each check is a line
// `<name>=<result>` its script expects.
//
import { Text, View, signal } from "nsh";
import flag from "./images/flag.png";

const out: string[] = [];
const lines = signal<string[]>([]);

function show(value: unknown): string {
  if (value instanceof Uint8Array) return `[${Array.from(value).join(",")}]`;
  if (Array.isArray(value)) return `[${value.map(show).join(",")}]`;
  return String(value);
}

async function check(name: string, f: () => unknown): Promise<void> {
  try {
    out.push(`${name}=${show(await f())}`);
  } catch (e) {
    out.push(`${name}=threw ${(e as Error)?.name}`);
  }
}

function pairs(h: Headers): string[] {
  return [...h].map(([k, v]) => `${k}:${v}`);
}

async function run() {
  // Headers.
  const h = new Headers({ "Content-Type": "text/plain", "X-B": " two " });
  await check("headers.get", () => [h.get("content-type"), h.get("CONTENT-TYPE"), h.get("x-b"), h.get("none")]);
  h.append("x-a", "1");
  h.append("X-A", "2");
  await check("headers.combined", () => h.get("x-a"));
  await check("headers.sorted", () => pairs(h));
  h.set("x-a", "3");
  h.delete("X-B");
  await check("headers.setDelete", () => [h.get("x-a"), h.has("x-b"), h.has("X-A")]);
  await check("headers.pairsInit", () => pairs(new Headers([["b", "1"], ["a", "2"]])));
  await check("headers.copy", () => pairs(new Headers(h)));
  await check("headers.setCookie", () => {
    const c = new Headers();
    c.append("Set-Cookie", "a=1");
    c.append("Set-Cookie", "b=2");
    return [c.getSetCookie().join("+"), pairs(c).join("+")];
  });
  await check("headers.badName", () => new Headers({ "bad name": "x" }));
  await check("headers.badValue", () => new Headers({ a: "x\ny" }));
  await check("headers.badPair", () => new Headers([["a"]] as any));
  await check("headers.forEach", () => {
    const seen: string[] = [];
    h.forEach((v, k) => seen.push(k + "=" + v));
    return seen;
  });
  await check("headers.keysValues", () => [...h.keys(), ...h.values()]);

  // Request.
  const r = new Request("https://h.test/a?b#frag", { method: "post", headers: { "X-A": "1" }, body: "hi" });
  await check("request.fields", () => [r.method, r.url, r.headers.get("x-a"), r.headers.get("content-type")]);
  await check("request.defaults", () => {
    const g = new Request("https://h.test/");
    return [g.method, g.body, g.bodyUsed, g.redirect, g.signal instanceof AbortSignal, g.headers instanceof Headers];
  });
  await check("request.methodCase", () => [new Request("https://h.test", { method: "patch" }).method, new Request("https://h.test", { method: "get" }).method]);
  await check("request.badMethod", () => new Request("https://h.test", { method: "bad method" }));
  await check("request.forbiddenMethod", () => new Request("https://h.test", { method: "CONNECT" }));
  await check("request.getBody", () => new Request("https://h.test", { body: "x" }));
  await check("request.relative", () => new Request("/a"));
  await check("request.text", async () => {
    const text = await r.clone().text();
    return text;
  });
  await check("request.used", async () => {
    const text = await r.text();
    const again = await r.text().then(
      () => "read again",
      (e) => e.name,
    );
    return `${text}|${r.bodyUsed}|${again}`;
  });
  await check("request.cloneUsed", () => r.clone());
  await check("request.fromRequest", () => {
    const base = new Request("https://h.test/x", { method: "PUT", headers: { a: "1" } });
    const derived = new Request(base, { headers: { b: "2" } });
    return [derived.method, derived.url, derived.headers.has("a"), derived.headers.get("b")];
  });
  await check("request.json", () => new Request("https://h.test", { method: "POST", body: '{"k":[1,2]}' }).json().then((j) => JSON.stringify(j)));
  await check("request.searchParamsBody", () =>
    new Request("https://h.test", { method: "POST", body: new URLSearchParams({ a: "b c" }) }).headers.get("content-type"),
  );
  await check("request.formBody", async () => {
    const fd = new FormData();
    fd.append("k", "v");
    const req = new Request("https://h.test", { method: "POST", body: fd });
    const type = req.headers.get("content-type") ?? "";
    const back = await req.formData();
    return `${type.startsWith("multipart/form-data; boundary=")}|${back.get("k")}`;
  });
  await check("request.signal", () => {
    const ac = new AbortController();
    const req = new Request("https://h.test", { signal: ac.signal });
    ac.abort();
    return req.signal.aborted;
  });

  // Response.
  const res = new Response("hi");
  await check("response.defaults", () => [res.status, res.ok, JSON.stringify(res.statusText), res.type, JSON.stringify(res.url), res.redirected]);
  await check("response.contentType", () => res.headers.get("content-type"));
  await check("response.text", () => res.text());
  await check("response.used", () => `${res.bodyUsed}|${res.body !== null}`);
  await check("response.usedAgain", () => res.text());
  await check("response.status", () => {
    const x = new Response(null, { status: 404, statusText: "Nope", headers: { a: "b" } });
    return [x.status, x.ok, x.statusText, x.headers.get("a"), x.body];
  });
  await check("response.badStatus", () => new Response(null, { status: 99 }));
  await check("response.nullBodyStatus", () => new Response("x", { status: 204 }));
  await check("response.json", async () => {
    const j = Response.json({ a: [1, "b"] }, { status: 201 });
    return `${j.status}|${j.headers.get("content-type")}|${JSON.stringify(await j.json())}`;
  });
  await check("response.badJson", () => new Response("{nope").json());
  await check("response.error", () => {
    const e = Response.error();
    return [e.type, e.status, e.ok, e.body];
  });
  await check("response.redirect", () => {
    const x = Response.redirect("https://h.test/next", 301);
    return [x.status, x.headers.get("location"), x.body];
  });
  await check("response.redirectDefault", () => Response.redirect("https://h.test/").status);
  await check("response.badRedirect", () => Response.redirect("https://h.test/", 200));
  await check("response.bytes", () => new Response(new Uint8Array([1, 2, 3])).bytes());
  await check("response.arrayBuffer", async () => (await new Response("abcd").arrayBuffer()).byteLength);
  await check("response.blob", async () => {
    const blob = await new Response("abc", { headers: { "Content-Type": "text/csv" } }).blob();
    return `${blob.size}|${blob.type}`;
  });
  await check("response.blobBody", async () => {
    const x = new Response(new Blob(["z"], { type: "image/png" }));
    return `${x.headers.get("content-type")}|${await x.text()}`;
  });
  await check("response.urlencodedForm", async () => {
    const x = new Response("a=1&b=x+y", { headers: { "content-type": "application/x-www-form-urlencoded" } });
    const fd = await x.formData();
    return `${fd.get("a")}|${fd.get("b")}`;
  });
  await check("response.stream", async () => {
    const x = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("st"));
          c.enqueue(new TextEncoder().encode("ream"));
          c.close();
        },
      }),
    );
    return x.text();
  });
  await check("response.clone", async () => {
    const a = new Response("twice");
    const b = a.clone();
    return `${await a.text()}|${await b.text()}`;
  });
  await check("response.bodyReader", async () => {
    const reader = new Response("xy").body!.getReader();
    const first = await reader.read();
    return `${first.value instanceof Uint8Array}|${show(first.value)}`;
  });

  // fetch without a network.
  await check("fetch.dataBase64", async () => {
    const x = await fetch("data:text/plain;base64,aGk=");
    return [x.status, x.ok, x.headers.get("content-type"), await x.text()];
  });
  await check("fetch.dataPercent", async () => (await fetch("data:,a%20b")).text());
  await check("fetch.dataJson", async () => JSON.stringify(await (await fetch("data:application/json,%7B%22a%22%3A1%7D")).json()));
  await check("fetch.dataDefaultType", async () => (await fetch("data:,x")).headers.get("content-type"));
  await check("fetch.request", async () => (await fetch(new Request("data:,via%20request"))).text());
  await check("fetch.url", async () => (await fetch(new URL("data:,via%20url"))).text());
  await check("fetch.blob", async () => {
    const url = URL.createObjectURL(new Blob(["from blob"], { type: "text/x-a" }));
    const x = await fetch(url);
    const text = await x.text();
    URL.revokeObjectURL(url);
    const after = await fetch(url).then(
      () => "fetched",
      (e) => e.name,
    );
    return `${url.startsWith("blob:")}|${x.headers.get("content-type")}|${text}|${after}`;
  });
  await check("fetch.asset", async () => {
    const x = await fetch(flag.url);
    const bytes = await x.bytes();
    return [flag.url, x.status, x.ok, x.headers.get("content-length"), bytes.length, bytes.slice(1, 4)];
  });
  await check("fetch.assetHead", async () => {
    const x = await fetch(flag.url);
    return [x.headers.get("content-type"), x.url === flag.url];
  });
  await check("fetch.assetMissing", () => fetch("asset:/images/missing.png"));
  await check("fetch.badScheme", () => fetch("ftp://h.test/x"));
  await check("fetch.badUrl", () => fetch("http://"));
  await check("fetch.badDataUrl", () => fetch("data:no-comma"));
  await check("fetch.aborted", () => fetch("data:,x", { signal: AbortSignal.abort() }));
  await check("fetch.abortReason", () => fetch("data:,x", { signal: AbortSignal.abort("mine") }).catch((e) => "rejected:" + e));
  await check("fetch.rejectsAsync", () => {
    const p = fetch("ftp://h.test/x");
    p.catch(() => {});
    return p instanceof Promise;
  });
  out.push("done");
  lines.set(out.slice());
}

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Each of={lines()}>{(line) => <Text>{line()}</Text>}</Each>
    </View>
  );
}

export default App;
run();
