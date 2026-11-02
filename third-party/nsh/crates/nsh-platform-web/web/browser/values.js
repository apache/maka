// Browser values held across the Wasm boundary. IDs include a generation:
// a delayed callback cannot accidentally address a recycled slot.
const INDEX_BITS = 20;
const INDEX_MASK = (1 << INDEX_BITS) - 1;
const MAX_GENERATION = (1 << (32 - INDEX_BITS)) - 1;
export const EXCEPTION = 0xffffffff;
// The least time between two reference accountings (`collect`): each traces
// every value Rust holds, so one per call into Wasm made every signal read
// cost as much as the app is large.
const COLLECT_MS = 100;
// The accounting runs on the page's own time, taken before a test's manual
// clock replaces the realm's (`testing.js`): it is the runtime's work, not
// the app's, and on the app's clock a collection put off while a call into
// Wasm runs would be due again at once, for good.
const { setTimeout: collectLater, clearTimeout: cancelCollect } = globalThis;
const pageNow = globalThis.performance.now.bind(globalThis.performance);

export class Values {
  constructor() {
    this.slots = [undefined, null, false, true].map(value => ({ value, refs: Infinity, generation: 0 }));
    this.freeSlots = [];
    this.closed = false;
    this.error = null;
    this.hasError = false;
    this.nodes = new Map();
    this.nodeIds = new WeakMap();
    this.instances = new WeakMap();
    this.identities = new WeakMap();
    this.symbols = new Map();
    this.nextIdentity = 1;
    this.wrap = null;
    this.makeFunction = null;
    this.classPeers = new Map();
    this.accessors = new Map();
    this.signals = new WeakSet();
    this.memos = new WeakSet();
    this.mirrors = new WeakMap();
    this.depth = 0;
    // Some slot holds its value weakly since the last accounting.
    this.weakened = false;
    this.collectTimer = 0;
    this.lastCollect = 0;
  }
  put(value) {
    if (this.closed) throw new Error("the app was disposed");
    if (value === undefined) return 0;
    if (value === null) return 1;
    if (value === false) return 2;
    if (value === true) return 3;
    const index = this.freeSlots.pop() ?? this.slots.length;
    if (index >= INDEX_MASK) throw new RangeError("too many retained browser values");
    const generation = this.slots[index]?.generation ?? 0;
    let symbol;
    if (typeof value === "symbol") {
      symbol = this.symbols.get(value);
      if (!symbol) { symbol = { id: this.nextIdentity++, refs: 0 }; this.symbols.set(value, symbol); }
      symbol.refs++;
    }
    this.slots[index] = { value, refs: 1, generation, symbol, node: this.nodeIds.get(value) ?? 0 };
    return ((generation << INDEX_BITS) | index) >>> 0;
  }
  slot(id) {
    if (this.closed) throw new Error("the app was disposed");
    const slot = this.slots[id & INDEX_MASK];
    if (!slot || slot.refs === 0 || slot.generation !== (id >>> INDEX_BITS)) {
      throw new ReferenceError("a browser value was released");
    }
    return slot;
  }
  get(id) {
    const slot = this.slot(id >>> 0);
    const value = slot.weak ? slot.weak.deref() : slot.value;
    if (slot.weak && value === undefined) throw new ReferenceError("a browser value was collected");
    return value;
  }
  // All Wasm entries, including pumps and finalizers, use this boundary.
  // Temporarily promote before Rust can clone a callback into a task;
  // only demote after conservative reference accounting, outside every
  // entry: once for all the calls a task makes, at most every COLLECT_MS.
  // Until then promoted values stay strong, which only keeps them longer.
  boundary(body, trace) {
    if (this.closed) return body();
    const outer = this.depth++ === 0;
    if (outer) this.promote();
    try { return body(); }
    finally {
      try {
        if (outer && !this.closed) {
          this.after?.();
          this.schedule(trace);
        }
      } finally { this.depth--; }
    }
  }
  promote() {
    if (!this.weakened) return;
    this.weakened = false;
    for (const slot of this.slots) {
      if (slot?.refs > 0 && slot.weak) slot.value = slot.weak.deref();
    }
  }
  schedule(trace) {
    this.trace ??= trace;
    if (this.collectTimer) return;
    const wait = Math.max(0, this.lastCollect + COLLECT_MS - pageNow());
    this.collectTimer = collectLater(() => {
      this.collectTimer = 0;
      if (this.closed) return;
      if (this.depth > 0) return this.schedule(trace);
      this.collect(trace);
    }, wait);
  }
  // Conservative reference accounting: a value only Rust's references from
  // collectable peers hold is held weakly, through those peers.
  collect(trace) {
    this.lastCollect = pageNow();
    this.depth++;
    try {
      // Weak values are held through the mirrors this replaces.
      this.promote();
      this.edges = [];
      trace();
      const mirrors = new WeakMap(), counts = new Map();
      for (const [kind, owner, generation, id] of this.edges) {
        const peer = (kind === 0 ? this.classPeers.get(owner) : kind === 2 ? this.nodes.get(owner) : this.accessors.get(`${owner}:${generation}`))?.deref();
        if (!peer) continue;
        const slot = this.slot(id);
        if (slot.refs === Infinity || (slot.weak && slot.value === undefined)) continue;
        const value = slot.value;
        if ((typeof value !== "object" || value === null) && typeof value !== "function") continue;
        let held = mirrors.get(peer);
        if (!held) mirrors.set(peer, held = []);
        held.push(value);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      for (let i = 4; i < this.slots.length; i++) {
        const slot = this.slots[i];
        if (!slot || !slot.refs) continue;
        const id = ((slot.generation << INDEX_BITS) | i) >>> 0;
        if (slot.value !== undefined && counts.get(id) === slot.refs) {
          slot.weak = new WeakRef(slot.value);
          slot.value = undefined;
          this.weakened = true;
        } else if (slot.value !== undefined) {
          // An unreported/shared Rust reference remains a strong root.
          slot.weak = undefined;
        }
      }
      this.mirrors = mirrors;
      this.edges = null;
    } finally { this.depth--; }
  }
  reconcile() { if (this.trace && !this.closed) this.schedule(this.trace); }
  bind(wasm) {
    this.trace = () => wasm.nsh_browser_trace();
    return Object.fromEntries(Object.entries(wasm).map(([name, value]) => [name,
      typeof value === "function" && name !== "nsh_browser_trace"
        ? (...args) => this.boundary(() => value(...args), () => wasm.nsh_browser_trace()) : value,
    ]));
  }
  retain(id) { this.slot(id).refs++; return id; }
  release(id) {
    if (this.closed || id < 4) return;
    const slot = this.slot(id);
    if (--slot.refs !== 0) return;
    if (slot.symbol && --slot.symbol.refs === 0) this.symbols.delete(slot.value);
    slot.symbol = undefined;
    slot.value = undefined;
    slot.weak = undefined;
    // Retire slots at generation exhaustion instead of allowing ABA.
    if (slot.generation < MAX_GENERATION) {
      slot.generation++;
      this.freeSlots.push(id & INDEX_MASK);
    }
  }
  with(values, body) {
    const ids = [];
    try {
      for (const value of values) ids.push(this.put(value));
      return body(ids);
    } finally {
      for (let i = ids.length - 1; i >= 0; i--) this.release(ids[i]);
    }
  }
  result(id) {
    if ((id >>> 0) === EXCEPTION) {
      const error = this.error, pending = this.hasError;
      this.error = null;
      this.hasError = false;
      throw pending ? error : new Error("the browser host failed");
    }
    try { return this.get(id); } finally { this.release(id); }
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    cancelCollect(this.collectTimer);
    this.collectTimer = 0;
    this.slots.length = 0;
    this.freeSlots.length = 0;
    this.nodes.clear();
    this.classPeers.clear();
    this.accessors.clear();
    this.mirrors = new WeakMap();
    this.nodeIds = new WeakMap();
    this.instances = new WeakMap();
    this.wrap = null;
    this.makeFunction = null;
    this.settle = null;
    this.after = null;
    this.identities = new WeakMap();
    this.symbols = new Map();
    this.error = null;
    this.hasError = false;
  }
  get retained() { return this.slots.reduce((n, slot, i) => n + (i >= 4 && slot.refs > 0 ? 1 : 0), 0); }

  imports(memory) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const bytes = (ptr, length) => new Uint8Array(memory().buffer, ptr, length);
    const text = (ptr, length) => decoder.decode(bytes(ptr, length));
    // Op 49 packs an array's items (or an object's fields) into `scratch`
    // for one copy into Rust's buffer (`unpack` in values.rs reads it); a
    // buffer too small gets the size asked for, and the packing is kept for
    // the retry.
    let scratch = new Uint8Array(1024), view = new DataView(scratch.buffer);
    let packed = -1, packedMode = 0, packedLength = 0, packing = false;
    const room = n => {
      if (scratch.length >= n) return;
      const next = new Uint8Array(Math.max(n, scratch.length * 2));
      next.set(scratch);
      scratch = next;
      view = new DataView(next.buffer);
    };
    const pack = (v, entries) => {
      let at = 4, count = 0;
      const str = s => {
        const n = s.length;
        room(at + 4 + n * 3);
        // Cells are short and mostly ASCII: copied by hand they skip a view
        // and a call per string.
        let i = 0;
        for (; i < n; i++) {
          const code = s.charCodeAt(i);
          if (code > 0x7f) break;
          scratch[at + 4 + i] = code;
        }
        const written = i === n ? n : i + encoder.encodeInto(s.slice(i), scratch.subarray(at + 4 + i)).written;
        view.setUint32(at, written, true);
        at += 4 + written;
      };
      const item = x => {
        room(at + 9);
        if (typeof x === "boolean") scratch[at++] = x ? 2 : 1;
        else if (typeof x === "number") { scratch[at] = 3; view.setFloat64(at + 1, x, true); at += 9; }
        else if (typeof x === "string") { scratch[at++] = 4; str(x); }
        else if (x !== null && typeof x === "object" && Object.prototype.toString.call(x) === "[object Date]") {
          scratch[at] = 5; view.setFloat64(at + 1, Date.prototype.getTime.call(x), true); at += 9;
        } else scratch[at++] = 0;
        count++;
      };
      if (!entries) for (let i = 0; i < v.length; i++) item(v[i]);
      else if (v !== null && (typeof v === "object" || typeof v === "function")) for (const key of Object.keys(v)) { str(key); item(v[key]); }
      view.setUint32(0, count, true);
      return at;
    };
    return { value: (op, a, b, c, number) => {
      try {
        switch (op) {
          case 0: {
            const v = this.get(a);
            if (v === undefined) return 0;
            if (v === null) return 1;
            if (typeof v === "boolean") return 2;
            if (typeof v === "number") return 3;
            if (typeof v === "string") return 4;
            if (Array.isArray(v)) return 5;
            if (typeof v === "function") return 6;
            return typeof v === "object" ? 7 : typeof v === "bigint" ? 9 : 8;
          }
          case 1: return typeof this.get(a) === "boolean" ? Number(this.get(a)) : NaN;
          case 2: return typeof this.get(a) === "number" ? this.get(a) : NaN;
          case 3: { const v = this.get(a); return typeof v === "string" ? v.length : NaN; }
          // Encodes straight into Rust's buffer; -1 when it is too small.
          case 4: { const v = this.get(a), { read, written } = encoder.encodeInto(v, bytes(b, c)); return read === v.length ? written : -1; }
          case 5: return ArrayBuffer.isView(this.get(a)) && Object.prototype.toString.call(this.get(a)) === "[object Uint8Array]" ? this.get(a).byteLength : NaN;
          case 6: bytes(b, c).set(this.get(a)); return 0;
          case 7: return Array.isArray(this.get(a)) ? this.get(a).length : NaN;
          case 8: return this.put(this.get(a)[b]);
          case 9: return this.put(this.get(a)?.[text(b, c)]);
          case 10: return this.put(Object.keys(this.get(a)));
          case 11: { try { return Date.prototype.getTime.call(this.get(a)); } catch { return NaN; } }
          case 12: return this.put(JSON.stringify(this.get(a)));
          case 13: {
            const value = this.get(a);
            let description;
            try { description = JSON.stringify(value); } catch { description = String(value); }
            return this.put(description ?? String(value));
          }
          case 14: return this.slot(a).node ?? 0;
          case 15: return this.put(this.nodes.get(a)?.deref() ?? null);
          case 16: return this.retain(a);
          case 17: this.release(a); return 0;
          case 18: return this.put(number);
          case 19: return this.put(text(b, c));
          case 20: return this.put(bytes(b, c).slice());
          case 21: return this.put([]);
          case 22: this.get(a)[b] = this.get(c); return 0;
          case 23: return this.put({});
          case 24: Object.defineProperty(this.get(a), this.get(b), { value: this.get(c), writable: true, enumerable: true, configurable: true }); return 0;
          case 25: return this.put(new Date(number));
          case 26: return this.put(Reflect.apply(this.get(a), this.get(b), this.get(c)));
          case 27: { const error = this.error; this.error = null; this.hasError = false; return this.put(error); }
          case 28: return this.put(this.wrap(a, b));
          case 29: return this.instances.get(this.get(a)) ?? 0;
          case 48: return this.put(this.makeFunction(a));
          case 31: if (!this.hasError) { this.error = new TypeError(text(b, c)); this.hasError = true; } return EXCEPTION;
          case 32: return Number(this.get(a) === this.get(b));
          case 33: {
            const v = this.get(a);
            if (typeof v === "symbol") return this.slot(a).symbol.id;
            if ((typeof v !== "object" || v === null) && typeof v !== "function") return a;
            let identity = this.identities.get(v);
            if (identity === undefined) { identity = this.nextIdentity++; this.identities.set(v, identity); }
            return identity;
          }
          case 34: this.attach(this.get(a), b); return 0;
          case 35: this.settle(b, this.get(a)); return 0;
          case 36: { const ErrorType = { Error, TypeError, RangeError }[this.get(a)] ?? Error; return this.put(new ErrorType(this.get(b))); }
          case 37: this.error = this.get(a); this.hasError = true; return EXCEPTION;
          case 38: {
            let message = "browser value operation failed";
            try {
              const error = this.error;
              if (typeof error === "string") message = error;
              else if (typeof error?.message === "string") message = error.message;
            } catch { /* Preserve the original exception, including hostile getters. */ }
            return this.put(message);
          }
          case 39: return this.put(this.makeNode(a, b !== 0));
          case 42: { const error = this.hasError ? this.error : new Error(text(b, c)); this.error = null; this.hasError = false; this.report(error); return 0; }
          case 41: return this.put(new File([this.get(a)], this.get(b), { type: this.get(c), lastModified: Number.isNaN(number) ? Date.now() : number }));
          case 43: return this.put(String(this.get(a)));
          case 45: return Number(this.hasError);
          case 46: this.edges?.push([a, b, c, number >>> 0]); return 0;
          // An object's keys as one string, apart by NUL (null when a key
          // holds one): a row of many fields crosses once.
          case 50: { const keys = Object.keys(this.get(a)); return this.put(keys.some(k => k.includes("\0")) ? null : keys.join("\0")); }
          case 49: {
            const v = this.get(a);
            if (!number && !Array.isArray(v)) return NaN;
            // A getter that reads a table again while one is packed gets a
            // buffer of its own, and keeps no packing for a retry.
            const outer = packing ? [scratch, view] : null;
            if (outer) { scratch = new Uint8Array(1024); view = new DataView(scratch.buffer); packed = -1; }
            try {
              if (packed !== a || packedMode !== number) {
                packed = -1; packing = true;
                packedLength = pack(v, number);
                packed = a; packedMode = number;
              }
              if (packedLength > c) return -packedLength;
              bytes(b, packedLength).set(scratch.subarray(0, packedLength));
              packed = -1;
              return packedLength;
            } finally {
              packing = !!outer;
              if (outer) { [scratch, view] = outer; packed = -1; }
            }
          }
          case 47: { const slot = this.slot(a); return Number(!slot.weak || slot.weak.deref() !== undefined); }
          default: throw new Error(`unknown browser value operation ${op}`);
        }
      } catch (error) {
        this.error = error;
        this.hasError = true;
        return EXCEPTION;
      }
    }};
  }
}
