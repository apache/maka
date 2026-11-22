// A case of the API's test suite (docs/dev/compatibility.md): the Streams
// Standard: `ReadableStream` (default and byte sources, readers, tee,
// async iteration, `from`), `WritableStream`, `TransformStream`, piping,
// the queuing strategies and `TextEncoderStream` / `TextDecoderStream`.
// Each check is a line `<name>=<result>` its script expects.
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

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const chunks: T[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

function source<T>(chunks: T[]): ReadableStream<T> {
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
}

async function run() {
  // ReadableStream with a default source.
  await check("readable.read", async () => {
    const reader = source(["a", "b"]).getReader();
    const r1 = await reader.read();
    const r2 = await reader.read();
    const r3 = await reader.read();
    return [`${r1.value}:${r1.done}`, `${r2.value}:${r2.done}`, `${r3.value}:${r3.done}`];
  });
  await check("readable.controller", () => {
    let info = "";
    new ReadableStream({
      start(c) {
        info = `${c instanceof ReadableStreamDefaultController}|${c.desiredSize}`;
        c.enqueue("x");
        info += `|${c.desiredSize}`;
      },
    });
    return info;
  });
  await check("readable.locked", () => {
    const s = source([1]);
    const before = s.locked;
    const reader = s.getReader();
    const during = s.locked;
    const second = (() => {
      try {
        s.getReader();
        return "second reader";
      } catch (e) {
        return (e as Error).name;
      }
    })();
    reader.releaseLock();
    return [before, during, second, s.locked, reader instanceof ReadableStreamDefaultReader];
  });
  await check("readable.readerConstructor", async () => {
    const reader = new ReadableStreamDefaultReader(source(["c"]));
    return (await reader.read()).value;
  });
  await check("readable.pull", async () => {
    const calls: number[] = [];
    let n = 0;
    const s = new ReadableStream(
      {
        pull(c) {
          calls.push(c.desiredSize ?? -1);
          n++;
          if (n <= 3) c.enqueue(n);
          else c.close();
        },
      },
      new CountQueuingStrategy({ highWaterMark: 2 }),
    );
    const got = await collect(s);
    return `${got.join(",")}|pulls=${calls.length}`;
  });
  await check("readable.cancel", async () => {
    let reason = "";
    const s = new ReadableStream({
      cancel(r) {
        reason = String(r);
      },
    });
    const reader = s.getReader();
    await reader.cancel("enough");
    const after = await reader.read();
    return `${reason}|${after.done}`;
  });
  await check("readable.error", async () => {
    const s = new ReadableStream({
      start(c) {
        c.error(new TypeError("bad source"));
      },
    });
    const reader = s.getReader();
    const read = await reader.read().then(
      () => "read",
      (e) => `${e.name}:${e.message}`,
    );
    const closed = await reader.closed.then(
      () => "closed",
      (e) => e.message,
    );
    return `${read}|${closed}`;
  });
  await check("readable.closed", async () => {
    const reader = source([]).getReader();
    await reader.closed;
    return "resolved";
  });
  await check("readable.tee", async () => {
    const [a, b] = source([1, 2]).tee();
    const [x, y] = await Promise.all([collect(a), collect(b)]);
    return `${x.join(",")}|${y.join(",")}`;
  });
  await check("readable.asyncIterator", async () => {
    const got: string[] = [];
    for await (const chunk of source(["p", "q"])) got.push(chunk);
    return got;
  });
  await check("readable.values", async () => {
    const got: number[] = [];
    for await (const chunk of source([5, 6]).values()) got.push(chunk);
    return got;
  });
  await check("readable.iteratorBreak", async () => {
    let cancelled = false;
    const s = new ReadableStream({
      start(c) {
        c.enqueue(1);
        c.enqueue(2);
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const _ of s) break;
    return `${cancelled}|${s.locked}`;
  });
  await check("readable.from", async () => {
    const fromArray = await collect(ReadableStream.from([1, 2, 3]));
    async function* gen() {
      yield "g1";
      yield "g2";
    }
    const fromGen = await collect(ReadableStream.from(gen()));
    return `${fromArray.join(",")}|${fromGen.join(",")}`;
  });

  // Byte streams.
  await check("bytes.byob", async () => {
    let info = "";
    const s = new ReadableStream({
      type: "bytes",
      pull(c) {
        const req = c.byobRequest!;
        info = `${c instanceof ReadableByteStreamController}|${req instanceof ReadableStreamBYOBRequest}|${req.view!.byteLength}`;
        const view = req.view as Uint8Array;
        view[0] = 7;
        view[1] = 8;
        req.respond(2);
      },
    });
    const reader = s.getReader({ mode: "byob" });
    const r = await reader.read(new Uint8Array(4));
    return `${info}|${reader instanceof ReadableStreamBYOBReader}|${show(r.value)}|${r.done}`;
  });
  await check("bytes.enqueue", async () => {
    const s = new ReadableStream({
      type: "bytes",
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.close();
      },
    });
    const reader = new ReadableStreamBYOBReader(s);
    const r1 = await reader.read(new Uint8Array(2));
    const r2 = await reader.read(new Uint8Array(2));
    const r3 = await reader.read(new Uint8Array(2));
    return [show(r1.value), show(r2.value), `${r3.done}:${r3.value?.byteLength}`];
  });
  await check("bytes.respondWithNewView", async () => {
    const s = new ReadableStream({
      type: "bytes",
      pull(c) {
        const view = c.byobRequest!.view as Uint8Array;
        const filled = new Uint8Array(view.buffer, view.byteOffset, 1);
        filled[0] = 42;
        c.byobRequest!.respondWithNewView(filled);
      },
    });
    const r = await s.getReader({ mode: "byob" }).read(new Uint8Array(3));
    return show(r.value);
  });
  await check("bytes.defaultReader", async () => {
    const s = new ReadableStream({
      type: "bytes",
      start(c) {
        c.enqueue(new Uint8Array([9]));
        c.close();
      },
    });
    const got = await collect(s);
    return got.map(show);
  });
  await check("bytes.autoAllocate", async () => {
    const s = new ReadableStream({
      type: "bytes",
      autoAllocateChunkSize: 16,
      pull(c) {
        const req = c.byobRequest!;
        (req.view as Uint8Array)[0] = 1;
        req.respond(1);
        c.close();
      },
    });
    const first = await s.getReader().read();
    return show(first.value);
  });

  // WritableStream.
  await check("writable.write", async () => {
    const log: string[] = [];
    let ctrl = "";
    const w = new WritableStream({
      start(c) {
        ctrl = `${c instanceof WritableStreamDefaultController}|${c.signal instanceof AbortSignal}`;
      },
      write(chunk) {
        log.push("write:" + chunk);
      },
      close() {
        log.push("close");
      },
    });
    const writer = w.getWriter();
    const info = `${w.locked}|${writer instanceof WritableStreamDefaultWriter}|${writer.desiredSize}`;
    await writer.ready;
    writer.write("a");
    writer.write("b");
    await writer.close();
    await writer.closed;
    return `${ctrl}|${info}|${log.join(",")}`;
  });
  await check("writable.backpressure", async () => {
    let release: () => void = () => {};
    const w = new WritableStream(
      {
        write() {
          return new Promise<void>((r) => (release = r));
        },
      },
      new CountQueuingStrategy({ highWaterMark: 2 }),
    );
    const writer = w.getWriter();
    const sizes = [writer.desiredSize];
    writer.write(1);
    sizes.push(writer.desiredSize);
    writer.write(2);
    writer.write(3);
    sizes.push(writer.desiredSize);
    release();
    return sizes;
  });
  await check("writable.abort", async () => {
    let reason = "";
    let aborted = false;
    const w = new WritableStream({
      start(c) {
        c.signal.addEventListener("abort", () => (aborted = true));
      },
      abort(r) {
        reason = String(r);
      },
    });
    const writer = w.getWriter();
    writer.closed.catch(() => {});
    await writer.abort("stop");
    const write = await writer.write("x").then(
      () => "written",
      (e) => String(e),
    );
    return `${reason}|${aborted}|${write}`;
  });
  await check("writable.sinkError", async () => {
    const w = new WritableStream({
      write() {
        throw new RangeError("full");
      },
    });
    const writer = w.getWriter();
    const write = await writer.write("x").then(
      () => "ok",
      (e) => e.name,
    );
    const closed = await writer.closed.then(
      () => "closed",
      (e) => e.message,
    );
    return `${write}|${closed}`;
  });
  await check("writable.controllerError", async () => {
    let ctrl: WritableStreamDefaultController | undefined;
    const w = new WritableStream({
      start(c) {
        ctrl = c;
      },
    });
    ctrl!.error(new Error("broken"));
    return w.getWriter().closed.then(
      () => "closed",
      (e) => e.message,
    );
  });
  await check("writable.writerConstructor", async () => {
    const got: string[] = [];
    const w = new WritableStream({ write: (c) => void got.push(c) });
    const writer = new WritableStreamDefaultWriter(w);
    await writer.write("z");
    writer.releaseLock();
    return `${got}|${w.locked}`;
  });

  // Piping and TransformStream.
  await check("pipe.to", async () => {
    const got: number[] = [];
    await source([1, 2, 3]).pipeTo(new WritableStream({ write: (c) => void got.push(c) }));
    return got;
  });
  await check("transform.through", async () => {
    let ctrl = "";
    const upper = new TransformStream<string, string>({
      start(c) {
        ctrl = `${c instanceof TransformStreamDefaultController}`;
      },
      transform(chunk, c) {
        c.enqueue(chunk.toUpperCase());
        c.enqueue(chunk.length);
      },
      flush(c) {
        c.enqueue("end");
      },
    });
    const got = await collect(source(["ab", "c"]).pipeThrough(upper));
    return `${ctrl}|${got.join(",")}`;
  });
  await check("transform.identity", async () => {
    const t = new TransformStream();
    const writer = t.writable.getWriter();
    writer.write("i1");
    writer.write("i2");
    writer.close();
    return (await collect(t.readable)).join(",");
  });
  await check("transform.terminate", async () => {
    const t = new TransformStream({
      transform(chunk, c) {
        c.enqueue(chunk);
        c.terminate();
      },
    });
    const writer = t.writable.getWriter();
    writer.closed.catch(() => {});
    writer.write("only").catch(() => {});
    writer.write("dropped").catch(() => {});
    return (await collect(t.readable)).join(",");
  });
  await check("transform.error", async () => {
    const t = new TransformStream({
      transform() {
        throw new TypeError("no");
      },
    });
    const done = source(["x"]).pipeThrough(t);
    return done
      .getReader()
      .read()
      .then(
        () => "read",
        (e) => `${e.name}:${e.message}`,
      );
  });
  await check("transform.desiredSize", () => {
    let size: number | null = null;
    new TransformStream(
      {
        start(c) {
          size = c.desiredSize;
        },
      },
      undefined,
      new CountQueuingStrategy({ highWaterMark: 3 }),
    );
    return size;
  });
  await check("pipe.preventClose", async () => {
    let closed = false;
    const w = new WritableStream({ close: () => void (closed = true) });
    await source([1]).pipeTo(w, { preventClose: true });
    return `${closed}|${w.locked}`;
  });
  await check("pipe.signal", async () => {
    const ac = new AbortController();
    const s = new ReadableStream({ pull() {} });
    const p = s.pipeTo(new WritableStream(), { signal: ac.signal });
    ac.abort();
    return p.then(
      () => "piped",
      (e) => e.name,
    );
  });

  // Queuing strategies.
  await check("strategy.byteLength", () => {
    const s = new ByteLengthQueuingStrategy({ highWaterMark: 16 });
    return [s.highWaterMark, s.size(new Uint8Array(5)), typeof s.size];
  });
  await check("strategy.count", () => {
    const s = new CountQueuingStrategy({ highWaterMark: 4 });
    return [s.highWaterMark, s.size("anything" as any)];
  });
  await check("strategy.inStream", () => {
    let size: number | null = null;
    new ReadableStream(
      {
        start(c) {
          c.enqueue(new Uint8Array(3));
          size = c.desiredSize;
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: 10 }),
    );
    return size;
  });

  // Text streams.
  await check("textStream.encode", async () => {
    const t = new TextEncoderStream();
    const chunks = await collect(source(["h", "é"]).pipeThrough(t));
    return `${t.encoding}|${chunks.map(show).join("")}`;
  });
  await check("textStream.decode", async () => {
    const t = new TextDecoderStream();
    const bytes = new TextEncoder().encode("a€b");
    const chunks = await collect(source([bytes.slice(0, 2), bytes.slice(2, 4), bytes.slice(4)]).pipeThrough(t));
    return `${t.encoding}|${t.fatal}|${t.ignoreBOM}|${chunks.join("")}`;
  });
  await check("textStream.decodeLabel", () => new TextDecoderStream("latin1").encoding);
  await check("textStream.roundTrip", async () => {
    const chunks = await collect(source(["x😀", "y"]).pipeThrough(new TextEncoderStream()).pipeThrough(new TextDecoderStream()));
    return chunks.join("");
  });
  await check("textStream.fatal", async () => {
    const t = new TextDecoderStream("utf-8", { fatal: true });
    return collect(source([new Uint8Array([0xff])]).pipeThrough(t)).then(
      () => "decoded",
      (e) => e.name,
    );
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
