(() => {
  const key = __NSH_KEY__;
  const source = __NSH_SOURCE__;
  const failure = (code, message) => JSON.stringify({ status: "error", code, message });
  const message = error => {
    try { return String(error && error.message !== undefined ? error.message : error).slice(0, 512); }
    catch (_) { return "JavaScript evaluation failed"; }
  };
  const encode = value => {
    const ancestors = new Set();
    let budget = 1048576;
    const quota = {};
    const copy = (value, depth) => {
      if (--budget < 0) throw quota;
      if (depth > 64) throw new Error("result exceeds depth 64");
      if (value === null || typeof value === "boolean") return value;
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string") {
        budget -= value.length;
        if (budget < 0) throw quota;
        return value;
      }
      if (typeof value !== "object" || value === null) throw new Error("result contains a non-JSON value");
      if (ancestors.has(value)) throw new Error("result contains a circular value");
      const array = Array.isArray(value);
      if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
        throw new Error("result contains a non-plain object");
      ancestors.add(value);
      const out = array ? [] : Object.create(null);
      const keys = array ? null : Object.keys(value);
      const length = array ? value.length : keys.length;
      if (length > budget) throw quota;
      for (let i = 0; i < length; i++) {
        const name = array ? i : keys[i];
        if (!array) budget -= name.length;
        out[name] = copy(value[name], depth + 1);
      }
      ancestors.delete(value);
      return out;
    };
    try {
      const result = JSON.stringify({ status: "ok", value: copy(value, 0) });
      let bytes = 0;
      for (let i = 0; i < result.length; i++) {
        const c = result.charCodeAt(i);
        bytes += c < 128 ? 1 : c < 2048 ? 2 : c >= 0xd800 && c <= 0xdbff && i + 1 < result.length && result.charCodeAt(i + 1) >= 0xdc00 && result.charCodeAt(i + 1) <= 0xdfff ? (++i, 4) : 3;
        if (bytes > 1048576) return failure("ERR_NSH_QUOTA_EXCEEDED", "result exceeds 1 MiB");
      }
      return result;
    } catch (error) {
      return error === quota
        ? failure("ERR_NSH_QUOTA_EXCEEDED", "result exceeds 1 MiB")
        : failure("ERR_NSH_WEBVIEW_SCRIPT", message(error));
    }
  };
  try {
    const value = (0, eval)(source);
    const then = value !== null && (typeof value === "object" || typeof value === "function") ? value.then : undefined;
    if (typeof then === "function") {
      if (Object.prototype.hasOwnProperty.call(globalThis, key)) return failure("ERR_NSH_WEBVIEW_SCRIPT", "evaluation key is occupied");
      const cell = { result: null };
      Object.defineProperty(globalThis, key, { value: cell, configurable: true });
      Promise.resolve({ then: (resolve, reject) => then.call(value, resolve, reject) }).then(
        result => { if (globalThis[key] === cell) cell.result = encode(result); },
        error => { if (globalThis[key] === cell) cell.result = failure("ERR_NSH_WEBVIEW_SCRIPT", message(error)); }
      );
      return '{"status":"pending"}';
    }
    return encode(value);
  } catch (error) { return failure("ERR_NSH_WEBVIEW_SCRIPT", message(error)); }
})()
