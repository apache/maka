// SDK channel and the existing capability-gated platform call transport.
export function createHost(invoke, reactive, dom, environment, live, platform = {}) {
  const listeners = new Map(), inbox = [], pending = new Map();
  let next = 1;
  const initial = invoke(430, []);
  const nameOf = name => {
    if (typeof name !== "string" || !name.length || new TextEncoder().encode(name).length > 256) throw new TypeError("host: expected a nonempty message name of at most 256 bytes");
    return name;
  };
  const event = (name, data, keep = true) => {
    const entries = listeners.get(name);
    if (!entries?.size) { if (keep) { if (inbox.length >= 256) inbox.shift(); inbox.push([name, data]); } return; }
    let failure;
    for (const entry of [...entries]) {
      if (!entries.has(entry)) continue;
      try { reactive.runWithOwner(entry.owner, () => reactive.untracked(() => reactive.protect(() => entry.fn(data)))); }
      catch (error) { failure ??= { error }; }
    }
    if (failure) throw failure.error;
  };
  // `nsh_core::host_channel`'s errors, as the native channel rejects with.
  const failure = (message, code) => Object.assign(new Error(message), { code });
  // A string is the embedding app's own error message.
  const settle = (id, ok, value) => {
    const item = pending.get(id); if (!item) return;
    pending.delete(id); clearTimeout(item.timer);
    if (ok) item.resolve(value); else item.reject(value instanceof Error ? value : failure(String(value), "ERR_NSH_HOST_ERROR"));
  };
  const host = { ...platform,
    params: initial[1],
    available: () => Boolean(initial[0] || environment.host()),
    on(name, fn) {
      nameOf(name); if (typeof fn !== "function") throw new TypeError("host.on: a function is required");
      const entries = listeners.get(name) ?? new Set(); listeners.set(name, entries);
      const entry = { fn, owner: reactive.getOwner() }; entries.add(entry);
      // Its owner runs it again after a call: the name may have new listeners by then.
      const off = () => { entries.delete(entry); if (!entries.size && listeners.get(name) === entries) listeners.delete(name); };
      if (entry.owner) reactive.cleanup(off);
      queueMicrotask(() => {
        if (!live()) return;
        for (let i = 0; i < inbox.length && listeners.get(name)?.size;) {
          if (inbox[i][0] !== name) { i++; continue; }
          const [, data] = inbox.splice(i, 1)[0]; event(name, data);
        }
      });
      return off;
    },
    call(name, data, options) {
      if (!initial[0]) return platform.call(name, data, options);
      return new Promise((resolve, reject) => {
        nameOf(name);
        const timeout = options?.timeout === undefined ? 30000 : Number(options.timeout);
        if (!Number.isFinite(timeout) || timeout < 0) throw new RangeError(`nsh/host: invalid timeout ${timeout}`);
        if (pending.size >= 1024) throw failure(`host.call("${name}"): 1024 calls already wait for the embedding app's answers`, "ERR_NSH_QUOTA_EXCEEDED");
        const id = next++, timer = timeout ? setTimeout(() => settle(id, false, failure(`nsh/host: ${name} timed out after ${timeout} ms`, "ETIMEDOUT")), timeout) : null;
        pending.set(id, { resolve, reject, timer });
        try { invoke(431, [name, data, id]); } catch (error) { settle(id, false, error); }
      });
    },
    post(name, data) { nameOf(name); if (initial[0]) invoke(432, [name, data]); },
  };
  dom.rootProp("onHost", value => { if (value.type === "event") event(value.event, value.payload, false); });
  return { host, event, reply: settle, dispose() { listeners.clear(); inbox.length = 0; for (const id of pending.keys()) settle(id, false, new Error("the app was disposed")); } };
}
