// A case of the API's test suite (docs/dev/compatibility.md):
// `TextEncoder`, `TextDecoder` (Encoding Standard) and `atob` / `btoa`
// (forgiving base64). Each check is a line `<name>=<result>` its script
// expects.
import { Text, View, signal } from "nsh";

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

/** A string's UTF-16 code units, to show what text cannot. */
function units(s: string): string {
  return Array.from({ length: s.length }, (_, i) => s.charCodeAt(i).toString(16)).join(" ");
}

async function run() {
  const enc = new TextEncoder();
  await check("enc.encoding", () => enc.encoding);
  await check("enc.ascii", () => enc.encode("Hi"));
  await check("enc.euro", () => enc.encode("€"));
  await check("enc.astral", () => enc.encode("😀"));
  await check("enc.empty", () => enc.encode().length + "|" + enc.encode("").length);
  await check("enc.loneSurrogate", () => enc.encode("\uD800"));
  await check("enc.type", () => enc.encode("a") instanceof Uint8Array);
  await check("enc.into", () => {
    const dest = new Uint8Array(4);
    const r = enc.encodeInto("héllo", dest);
    return `${r.read},${r.written} ${show(dest)}`;
  });
  await check("enc.intoNoSplit", () => {
    const r = enc.encodeInto("a€", new Uint8Array(3));
    return `${r.read},${r.written}`;
  });

  const dec = new TextDecoder();
  await check("dec.encoding", () => `${dec.encoding}|${dec.fatal}|${dec.ignoreBOM}`);
  await check("dec.euro", () => dec.decode(new Uint8Array([226, 130, 172])));
  await check("dec.empty", () => JSON.stringify(dec.decode()));
  await check("dec.arrayBuffer", () => dec.decode(new Uint8Array([104, 105]).buffer));
  await check("dec.dataView", () => dec.decode(new DataView(new Uint8Array([0, 111, 107]).buffer, 1)));
  await check("dec.bom", () => units(dec.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))));
  await check("dec.ignoreBOM", () =>
    units(new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))),
  );
  await check("dec.invalid", () => units(dec.decode(new Uint8Array([0x61, 0xff, 0x62]))));
  await check("dec.truncated", () => units(dec.decode(new Uint8Array([0xe2, 0x82]))));
  await check("dec.fatal", () => new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xff])));
  await check("dec.fatalFlag", () => new TextDecoder("utf-8", { fatal: true }).fatal);
  await check("dec.stream", () => {
    const d = new TextDecoder();
    const a = d.decode(new Uint8Array([0xe2, 0x82]), { stream: true });
    const b = d.decode(new Uint8Array([0xac, 0x21]), { stream: true });
    const c = d.decode();
    return JSON.stringify([a, b, c]);
  });
  await check("dec.labels", () =>
    ["utf8", " UTF-8 ", "unicode-1-1-utf-8", "utf-16", "UTF-16BE", "latin1", "ascii"].map(
      (l) => new TextDecoder(l).encoding,
    ),
  );
  await check("dec.unknownLabel", () => new TextDecoder("x-nope"));
  await check("dec.utf16le", () => new TextDecoder("utf-16le").decode(new Uint8Array([0x68, 0, 0x69, 0])));
  await check("dec.utf16be", () => new TextDecoder("utf-16be").decode(new Uint8Array([0, 0x68, 0, 0x69])));
  await check("dec.windows1252", () => units(new TextDecoder("latin1").decode(new Uint8Array([0x41, 0x80, 0xe9]))));
  await check("dec.roundTrip", () => dec.decode(enc.encode("héllo wörld 😀")) === "héllo wörld 😀");

  await check("btoa.hello", () => btoa("hello"));
  await check("btoa.padding", () => [btoa(""), btoa("a"), btoa("ab"), btoa("abc")]);
  await check("btoa.latin1", () => btoa("\xff\xfe"));
  await check("btoa.wide", () => btoa("Ā"));
  await check("btoa.wideError", () => {
    try {
      btoa("€");
    } catch (e) {
      return `${e instanceof DOMException}|${(e as DOMException).name}`;
    }
  });
  await check("atob.hello", () => atob("aGVsbG8="));
  await check("atob.noPadding", () => atob("aGVsbG8"));
  await check("atob.whitespace", () => atob(" aGVs\nbG8= "));
  await check("atob.binary", () => units(atob("/w==")));
  await check("atob.badLength", () => atob("a"));
  await check("atob.badChar", () => atob("a*bc"));
  await check("atob.badError", () => {
    try {
      atob("a");
    } catch (e) {
      return `${e instanceof DOMException}|${(e as DOMException).name}|${(e as DOMException).code}`;
    }
  });
  await check("atob.roundTrip", () => atob(btoa("\x00\x01\xfe\xff")) === "\x00\x01\xfe\xff");
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
