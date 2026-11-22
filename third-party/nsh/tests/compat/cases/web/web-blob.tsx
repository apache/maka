// A case of the API's test suite (docs/dev/compatibility.md): `Blob`,
// `File` (File API: parts, types, slices, reads) and `FormData` (XHR
// Standard: entries, files). Each check is a line `<name>=<result>` its
// script expects.
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

/** A form entry as text: a string, or `File(<name>,<type>,<size>)`. */
function entry(v: FormDataEntryValue | null): string {
  if (v instanceof File) return `File(${v.name},${v.type},${v.size})`;
  return String(v);
}

async function run() {
  // Blob.
  const b = new Blob(["ab", new Uint8Array([99]), new Blob(["d"]), new Uint8Array([0x65, 0x66]).buffer], { type: "Text/Plain" });
  await check("blob.size", () => b.size);
  await check("blob.type", () => b.type);
  await check("blob.text", () => b.text());
  await check("blob.empty", () => {
    const e = new Blob();
    return `${e.size}|${JSON.stringify(e.type)}`;
  });
  await check("blob.badType", () => JSON.stringify(new Blob([], { type: "a/bé" }).type));
  await check("blob.utf8", () => new Blob(["é€"]).size);
  await check("blob.stringParts", () => new Blob([1 as any, "x", true as any]).text());
  await check("blob.endings", () => new Blob(["a\r\nb"], { endings: "transparent" }).size);
  await check("blob.slice", () => b.slice(1, 3).text());
  await check("blob.sliceNegative", () => b.slice(-2).text());
  await check("blob.sliceClamp", () => b.slice(4, 100).text());
  await check("blob.sliceEmpty", () => b.slice(3, 1).size);
  await check("blob.sliceType", () => `${JSON.stringify(b.slice(0, 1).type)}|${b.slice(0, 1, "X/Y").type}`);
  await check("blob.arrayBuffer", async () => {
    const buf = await b.arrayBuffer();
    return `${buf instanceof ArrayBuffer}|${buf.byteLength}|${new Uint8Array(buf)[2]}`;
  });
  await check("blob.bytes", () => b.slice(0, 3).bytes());
  await check("blob.stream", async () => {
    const reader = b.stream().getReader();
    const parts: number[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(...value);
    }
    return new TextDecoder().decode(new Uint8Array(parts));
  });
  await check("blob.binary", () => new Blob([new Uint8Array([0, 255])]).bytes());

  // File.
  const f = new File(["hello"], "greeting.txt", { type: "text/plain", lastModified: 1700000000000 });
  await check("file.fields", () => [f.name, f.type, f.size, f.lastModified, JSON.stringify(f.webkitRelativePath)]);
  await check("file.isBlob", () => [f instanceof Blob, f instanceof File]);
  await check("file.text", () => f.text());
  await check("file.defaultLastModified", () => {
    const now = Date.now();
    const lm = new File([], "a").lastModified;
    return Math.abs(lm - now) < 60000;
  });
  await check("file.sliceIsBlob", () => {
    const s = f.slice(0, 2);
    return `${s instanceof File}|${s instanceof Blob}`;
  });
  await check("file.nameKept", () => new File([], "a/b.txt").name);

  // FormData.
  const fd = new FormData();
  fd.append("a", "1");
  fd.append("a", "2");
  fd.append("b", new Blob(["xyz"], { type: "text/csv" }));
  fd.append("c", new Blob(["q"]), "q.bin");
  fd.append("d", f);
  await check("form.get", () => [fd.get("a"), fd.get("zz")]);
  await check("form.getAll", () => fd.getAll("a"));
  await check("form.has", () => [fd.has("b"), fd.has("zz")]);
  await check("form.blobEntry", () => entry(fd.get("b")));
  await check("form.blobName", () => entry(fd.get("c")));
  await check("form.file", () => entry(fd.get("d")));
  await check("form.fileContent", () => (fd.get("c") as File).text());
  await check("form.coerce", () => {
    const g = new FormData();
    g.append("n", 5 as any);
    return typeof g.get("n");
  });
  fd.set("a", "9");
  await check("form.set", () => fd.getAll("a"));
  fd.delete("b");
  await check("form.keys", () => [...fd.keys()]);
  await check("form.entries", () => [...fd.entries()].map(([k, v]) => `${k}:${entry(v)}`));
  await check("form.values", () => [...fd.values()].map(entry));
  await check("form.iterator", () => [...fd].length);
  await check("form.forEach", () => {
    const seen: string[] = [];
    fd.forEach((v, k) => seen.push(k));
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
