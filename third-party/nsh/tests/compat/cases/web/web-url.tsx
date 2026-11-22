// A case of the API's test suite (docs/dev/compatibility.md): `URL` and
// `URLSearchParams` (WHATWG URL Standard): parsing, normalizing, relative
// resolution, setters, the live query and form encoding. Each check is a
// line `<name>=<result>` its script expects.
import { Text, View, signal } from "nsh";

const out: string[] = [];
const lines = signal<string[]>([]);

function show(value: unknown): string {
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

async function run() {
  // Parsing: every component, dot segments removed.
  const u = new URL("https://user:pw@EXAMPLE.com:8080/a/b/../c?x=1&y=2#frag");
  await check("url.href", () => u.href);
  await check("url.protocol", () => u.protocol);
  await check("url.username", () => u.username);
  await check("url.password", () => u.password);
  await check("url.host", () => u.host);
  await check("url.hostname", () => u.hostname);
  await check("url.port", () => u.port);
  await check("url.pathname", () => u.pathname);
  await check("url.search", () => u.search);
  await check("url.hash", () => u.hash);
  await check("url.origin", () => u.origin);
  await check("url.toString", () => u.toString() === u.href);
  await check("url.toJSON", () => JSON.stringify({ u }));
  // Normalizing.
  await check("url.defaultPort", () => new URL("https://example.com:443/").href);
  await check("url.emptyPath", () => new URL("http://example.com").pathname);
  await check("url.space", () => new URL("https://h.test/a b?c d").href);
  await check("url.idna", () => new URL("https://bücher.example/").hostname);
  await check("url.ipv4", () => new URL("http://0x7f.1/").hostname);
  await check("url.ipv6", () => new URL("http://[0:0::1]:81/").host);
  await check("url.file", () => new URL("file:///tmp/a.txt").pathname);
  await check("url.fileOrigin", () => new URL("file:///tmp/a.txt").origin);
  await check("url.opaque", () => new URL("mailto:a@b.test").pathname);
  // Relative resolution.
  await check("url.relative", () => new URL("../d?q", "https://h.test/a/b/c").href);
  await check("url.schemeRelative", () => new URL("//other.test/x", "https://h.test/y").href);
  await check("url.queryOnly", () => new URL("?z", "https://h.test/a/b?q#h").href);
  await check("url.baseURL", () => new URL("e", new URL("https://h.test/a/")).href);
  // Failures.
  await check("url.invalid", () => new URL("not a url"));
  await check("url.badBase", () => new URL("a", "not a base"));
  await check("url.canParse", () => [URL.canParse("x"), URL.canParse("x", "https://a.test/"), URL.canParse("https://a.test")]);
  await check("url.parse", () => [URL.parse("::"), URL.parse("b", "https://a.test/c")?.href]);
  // Setters.
  const s = new URL("http://h.test/p");
  s.pathname = "/new path";
  s.search = "a=1";
  s.hash = "h";
  s.port = "81";
  s.protocol = "https:";
  s.hostname = "Other.test";
  await check("url.set", () => s.href);
  s.port = "443";
  await check("url.setDefaultPort", () => s.host);
  s.search = "";
  s.hash = "";
  await check("url.clear", () => s.href);
  s.href = "https://z.test/q";
  await check("url.setHref", () => s.pathname + "|" + s.host);
  await check("url.badHref", () => {
    s.href = "nope";
  });
  // The live query.
  const q = new URL("https://h.test/?a=1");
  q.searchParams.append("b", "x y");
  await check("url.searchParams", () => q.search);
  q.search = "?c=3";
  await check("url.searchParamsLive", () => q.searchParams.get("c") + "|" + q.searchParams.has("a"));

  // URLSearchParams.
  const p = new URLSearchParams("?a=1&b=2&a=3");
  await check("usp.get", () => p.get("a"));
  await check("usp.getMissing", () => p.get("z"));
  await check("usp.getAll", () => p.getAll("a"));
  await check("usp.size", () => p.size);
  await check("usp.toString", () => p.toString());
  await check("usp.has", () => [p.has("b"), p.has("a", "3"), p.has("a", "4")]);
  p.set("a", "9");
  await check("usp.set", () => p.toString());
  p.append("c", "1");
  p.delete("b");
  await check("usp.delete", () => p.toString());
  p.append("c", "2");
  p.delete("c", "1");
  await check("usp.deleteValue", () => p.toString());
  await check("usp.decode", () => new URLSearchParams("q=a+b%20c&e=%E2%82%AC&f").get("q") + "|" + new URLSearchParams("e=%E2%82%AC").get("e") + "|" + new URLSearchParams("f").get("f"));
  await check("usp.encode", () => new URLSearchParams({ q: "a b&c=d", k: "é~*-._!" }).toString());
  await check("usp.record", () => new URLSearchParams({ x: "1", y: "2" }).toString());
  await check("usp.pairs", () => new URLSearchParams([["x", "1"], ["x", "2"]]).toString());
  await check("usp.copy", () => new URLSearchParams(new URLSearchParams("m=1")).toString());
  const sorted = new URLSearchParams("c=1&a=2&b=3&a=1");
  sorted.sort();
  await check("usp.sort", () => sorted.toString());
  await check("usp.entries", () => [...sorted.entries()].map(([k, v]) => k + ":" + v));
  await check("usp.keys", () => [...sorted.keys()]);
  await check("usp.values", () => [...sorted.values()]);
  await check("usp.iterator", () => [...sorted].length);
  await check("usp.forEach", () => {
    const seen: string[] = [];
    sorted.forEach((v, k) => seen.push(k + v));
    return seen;
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
