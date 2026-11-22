// A case of the API's test suite (docs/dev/compatibility.md): the order
// timers, intervals and microtasks run in, cancelling them, animation
// frames, delays as `performance.now()` measures them, and `console`. Each check is a line
// `<name>=<result>` its script expects after waiting.
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function run() {
  // Tasks, microtasks and promise jobs.
  await check("order.tasks", async () => {
    const log: string[] = [];
    setTimeout(() => log.push("timeout"), 0);
    queueMicrotask(() => log.push("microtask"));
    Promise.resolve().then(() => log.push("promise"));
    queueMicrotask(() => log.push("microtask2"));
    log.push("sync");
    await sleep(20);
    return log;
  });
  await check("order.delays", async () => {
    const log: number[] = [];
    setTimeout(() => log.push(30), 30);
    setTimeout(() => log.push(10), 10);
    setTimeout(() => log.push(20), 20);
    setTimeout(() => log.push(0));
    await sleep(80);
    return log;
  });
  await check("order.fifo", async () => {
    const log: string[] = [];
    for (const n of ["a", "b", "c", "d"]) setTimeout(() => log.push(n), 5);
    await sleep(40);
    return log.join("");
  });
  await check("order.nested", async () => {
    const log: string[] = [];
    setTimeout(() => {
      log.push("outer");
      setTimeout(() => log.push("inner"), 0);
      queueMicrotask(() => log.push("outer-micro"));
    }, 0);
    setTimeout(() => log.push("sibling"), 0);
    await sleep(40);
    return log;
  });
  await check("order.microtaskChain", async () => {
    const log: number[] = [];
    queueMicrotask(() => {
      log.push(1);
      queueMicrotask(() => log.push(3));
    });
    queueMicrotask(() => log.push(2));
    await sleep(0);
    return log;
  });
  await check("order.badDelays", async () => {
    const log: string[] = [];
    setTimeout(() => log.push("later"), 15);
    setTimeout(() => log.push("negative"), -5);
    setTimeout(() => log.push("nan"), NaN);
    await sleep(50);
    return log;
  });

  // Ids and cancelling.
  await check("ids", () => {
    const a = setTimeout(() => {}, 1000);
    const b = setTimeout(() => {}, 1000);
    const i = setInterval(() => {}, 1000);
    clearTimeout(a);
    clearTimeout(b);
    clearInterval(i);
    return [typeof a, a > 0, a !== b, b !== i];
  });
  await check("clearTimeout", async () => {
    const log: string[] = [];
    const id = setTimeout(() => log.push("cancelled"), 5);
    setTimeout(() => log.push("kept"), 5);
    clearTimeout(id);
    clearTimeout(123456);
    await sleep(30);
    return log;
  });
  await check("clearFromTimer", async () => {
    const log: string[] = [];
    let second = 0;
    setTimeout(() => {
      log.push("first");
      clearTimeout(second);
    }, 5);
    second = setTimeout(() => log.push("second"), 10);
    await sleep(40);
    return log;
  });
  await check("setInterval", async () => {
    let n = 0;
    await new Promise<void>((resolve) => {
      const id = setInterval(() => {
        n++;
        if (n === 3) {
          clearInterval(id);
          resolve();
        }
      }, 10);
    });
    await sleep(50);
    return n;
  });
  await check("clearInterval", async () => {
    let n = 0;
    let id = 0;
    await new Promise<void>((resolve) => {
      id = setInterval(() => {
        n++;
        if (n === 2) resolve();
      }, 10);
    });
    clearInterval(id);
    const stopped = n;
    await sleep(50);
    return `${stopped}|${n}`;
  });
  await check("clearIntervalUnknown", () => {
    clearInterval(987654);
    return "ok";
  });

  // Animation frames: a callback runs once, at a display frame, with the
  // frame's time; one cancelled never runs.
  await check("requestAnimationFrame", async () => {
    const start = performance.now();
    const times: number[] = [];
    const a = requestAnimationFrame((time) => times.push(time));
    const b = requestAnimationFrame((time) => times.push(time));
    await sleep(200);
    return [typeof a, a !== b, times.length, times.every((t) => typeof t === "number" && t >= start)];
  });
  await check("cancelAnimationFrame", async () => {
    const log: string[] = [];
    const id = requestAnimationFrame(() => log.push("cancelled"));
    requestAnimationFrame(() => log.push("kept"));
    cancelAnimationFrame(id);
    cancelAnimationFrame(123456);
    await sleep(200);
    return log;
  });

  // performance.
  await check("performance.now", () => {
    const a = performance.now();
    const b = performance.now();
    return [typeof a, a >= 0, b >= a];
  });
  await check("performance.delay", async () => {
    const start = performance.now();
    await sleep(50);
    const elapsed = performance.now() - start;
    return elapsed >= 49;
  });
  await check("performance.subMs", () => {
    // Sub-millisecond precision: some reading in a busy loop is fractional.
    for (let i = 0; i < 10000; i++) if (performance.now() % 1 !== 0) return true;
    return false;
  });

  // console: its methods take any values and return nothing.
  await check("console", () => {
    const results = [
      console.log("web-timers", 1, { a: [1, 2] }, null, undefined),
      console.info("info"),
      console.debug("debug"),
      console.warn("warn", new Error("not thrown")),
      console.error("error", Symbol("s"), 10n),
    ];
    return results.map((r) => String(r));
  });
  await check("console.methods", () => ["log", "info", "debug", "warn", "error"].map((m) => typeof (console as any)[m]));
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
