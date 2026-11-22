// A case of the API's test suite (docs/dev/compatibility.md): `Event`,
// `CustomEvent`, `EventTarget` (DOM Standard: listeners, options,
// dispatch), `AbortController` / `AbortSignal` and `DOMException`. Each
// check is a line `<name>=<result>` its script expects.
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

/** What `f` throws, as `<name>|<message>`. */
function thrown(f: () => unknown): string {
  try {
    f();
    return "nothing";
  } catch (e) {
    return e instanceof Error ? `${e.name}|${e.message}` : `value ${String(e)}`;
  }
}

async function run() {
  // Event.
  const e = new Event("ping");
  await check("event.init", () => [e.type, e.bubbles, e.cancelable, e.composed, e.defaultPrevented, e.isTrusted]);
  await check("event.idle", () => [e.eventPhase, e.target, e.currentTarget]);
  await check("event.timeStamp", () => typeof e.timeStamp === "number" && e.timeStamp >= 0);
  await check("event.constants", () => [Event.NONE, Event.CAPTURING_PHASE, Event.AT_TARGET, Event.BUBBLING_PHASE, e.AT_TARGET]);
  e.preventDefault();
  await check("event.notCancelable", () => e.defaultPrevented);
  const c = new Event("go", { bubbles: true, cancelable: true });
  c.preventDefault();
  await check("event.cancelable", () => [c.bubbles, c.defaultPrevented, c.returnValue]);
  await check("event.noType", () => thrown(() => new (Event as any)()).split("|")[0]);
  await check("event.instance", () => e instanceof Event);

  // CustomEvent.
  await check("custom.detail", () => JSON.stringify(new CustomEvent("x", { detail: { n: 1 } }).detail));
  await check("custom.defaultDetail", () => new CustomEvent("x").detail);
  await check("custom.isEvent", () => new CustomEvent("x") instanceof Event);

  // EventTarget.
  const t = new EventTarget();
  const order: string[] = [];
  const first = () => order.push("first");
  t.addEventListener("ping", first);
  t.addEventListener("ping", first); // a duplicate is ignored
  t.addEventListener("ping", { handleEvent: (ev: Event) => order.push("object:" + ev.type) });
  t.addEventListener("ping", () => order.push("once"), { once: true });
  t.addEventListener("other", () => order.push("other"));
  t.dispatchEvent(new Event("ping"));
  t.dispatchEvent(new Event("ping"));
  await check("target.order", () => order);
  t.removeEventListener("ping", first);
  order.length = 0;
  t.dispatchEvent(new Event("ping"));
  await check("target.removed", () => order);
  await check("target.during", () => {
    const target = new EventTarget();
    let seen = "";
    target.addEventListener("x", function (this: unknown, ev) {
      seen = [ev.target === target, ev.currentTarget === target, ev.eventPhase, this === target].join(",");
    });
    const ev = new Event("x");
    target.dispatchEvent(ev);
    return seen + "|" + [ev.eventPhase, ev.currentTarget, ev.target === target].join(",");
  });
  await check("target.canceled", () => {
    const target = new EventTarget();
    target.addEventListener("x", (ev) => ev.preventDefault());
    return [target.dispatchEvent(new Event("x", { cancelable: true })), target.dispatchEvent(new Event("x"))];
  });
  await check("target.stopImmediate", () => {
    const target = new EventTarget();
    const seen: number[] = [];
    target.addEventListener("x", () => seen.push(1));
    target.addEventListener("x", (ev) => {
      seen.push(2);
      ev.stopImmediatePropagation();
    });
    target.addEventListener("x", () => seen.push(3));
    target.dispatchEvent(new Event("x"));
    return seen;
  });
  await check("target.signal", () => {
    const target = new EventTarget();
    const ac = new AbortController();
    let n = 0;
    target.addEventListener("x", () => n++, { signal: ac.signal });
    target.dispatchEvent(new Event("x"));
    ac.abort();
    target.dispatchEvent(new Event("x"));
    return n;
  });
  await check("target.redispatch", () => {
    const target = new EventTarget();
    let inner = "";
    const ev = new Event("x");
    target.addEventListener("x", () => {
      inner = thrown(() => target.dispatchEvent(ev)).split("|")[0];
    });
    target.dispatchEvent(ev);
    return inner;
  });
  await check("target.subclass", () => {
    class Emitter extends EventTarget {
      fire() {
        return this.dispatchEvent(new CustomEvent("fired", { detail: 7 }));
      }
    }
    const em = new Emitter();
    let got = 0;
    em.addEventListener("fired", (ev) => (got = (ev as CustomEvent).detail));
    return `${em.fire()}|${got}|${em instanceof EventTarget}`;
  });
  await check("target.addedDuring", () => {
    const target = new EventTarget();
    const seen: string[] = [];
    target.addEventListener("x", () => {
      seen.push("a");
      target.addEventListener("x", () => seen.push("late"));
    });
    target.dispatchEvent(new Event("x"));
    return seen;
  });

  // AbortController and AbortSignal.
  const ac = new AbortController();
  const fired: string[] = [];
  ac.signal.addEventListener("abort", (ev) => fired.push("listener:" + ev.type));
  ac.signal.onabort = () => fired.push("onabort");
  await check("abort.before", () => [ac.signal.aborted, ac.signal.reason, ac.signal instanceof AbortSignal, ac.signal instanceof EventTarget]);
  ac.abort();
  ac.abort();
  await check("abort.after", () => [ac.signal.aborted, fired.join("+")]);
  await check("abort.reason", () => {
    const r = ac.signal.reason;
    return `${r instanceof DOMException}|${r.name}|${r.code}`;
  });
  await check("abort.throwIfAborted", () => thrown(() => ac.signal.throwIfAborted()).split("|")[0]);
  await check("abort.notAborted", () => thrown(() => new AbortController().signal.throwIfAborted()));
  await check("abort.customReason", () => {
    const c2 = new AbortController();
    c2.abort("why");
    return `${c2.signal.reason}|${thrown(() => c2.signal.throwIfAborted())}`;
  });
  await check("abort.static", () => {
    const s = AbortSignal.abort("r");
    return `${s.aborted}|${s.reason}|${AbortSignal.abort().reason.name}`;
  });
  await check("abort.any", () => {
    const a = new AbortController();
    const b = new AbortController();
    const any = AbortSignal.any([a.signal, b.signal]);
    const before = any.aborted;
    b.abort("b");
    a.abort("a");
    return `${before}|${any.aborted}|${any.reason}`;
  });
  await check("abort.anyAborted", () => AbortSignal.any([new AbortController().signal, AbortSignal.abort("x")]).reason);
  const timeout = AbortSignal.timeout(20);
  await check("abort.timeoutBefore", () => timeout.aborted);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await check("abort.timeoutAfter", () => `${timeout.aborted}|${timeout.reason?.name}|${timeout.reason?.code}`);

  // DOMException.
  const d = new DOMException("missing", "NotFoundError");
  await check("domex.fields", () => [d.name, d.message, d.code]);
  await check("domex.defaults", () => {
    const x = new DOMException();
    return [x.name, JSON.stringify(x.message), x.code];
  });
  await check("domex.codes", () =>
    ["IndexSizeError", "InvalidCharacterError", "InvalidStateError", "SyntaxError", "AbortError", "TimeoutError", "DataCloneError", "Custom"].map(
      (n) => new DOMException("", n).code,
    ),
  );
  await check("domex.isError", () => [d instanceof Error, d instanceof DOMException, Object.prototype.toString.call(d)]);
  await check("domex.toString", () => String(d));
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
