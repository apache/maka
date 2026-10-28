import path from "./path.js";
import * as buffer from "./buffer.js";
const { Buffer } = buffer;
const bytes = (value, encoding) => typeof value === "string" ? Buffer.from(value, encoding) : Buffer.from(value);
export function createStandard(invoke, live) {
  const nativeCrypto = globalThis.crypto;
  const finalizers = new FinalizationRegistry(id => { if (live()) invoke(905, [id]); });
  const hash = (algorithm, key, crc = false) => {
    const id = invoke(crc ? 906 : 900, [algorithm, key]);
    let done = false;
    const result = {
      update(value, encoding) { if (!done) invoke(903, [id, bytes(value, encoding)]); return this; },
      digest(encoding) {
        if (done) throw new Error("Digest already called");
        done = true;
        const output = Buffer.from(invoke(904, [id]));
        finalizers.unregister(result);
        return encoding === undefined ? output : output.toString(encoding);
      },
    };
    finalizers.register(result, id, result);
    return result;
  };
  const size = n => { if (!Number.isInteger(n) || n < 0 || n > 1024 ** 3) throw new RangeError("size is out of range"); return n; };
  const randomFillSync = (target, offset = 0, count = target.byteLength - offset) => {
    size(offset); size(count);
    if (offset + count > target.byteLength) throw new RangeError("random fill exceeds buffer");
    const view = new Uint8Array(target.buffer, target.byteOffset + offset, count);
    for (let at = 0; at < view.length; at += 65536) nativeCrypto.getRandomValues(view.subarray(at, at + 65536));
    return target;
  };
  const callback = (fn, cb) => { if (typeof cb !== "function") throw new TypeError("callback is not a function"); queueMicrotask(() => { if (!live()) return; let result; try { result = fn(); } catch (error) { cb(error); return; } cb(null, result); }); };
  const crypto = {
    createHash: name => hash(name), createHmac: (name, key) => hash(name, bytes(key)),
    randomUUID: () => nativeCrypto.randomUUID(),
    getRandomValues: target => nativeCrypto.getRandomValues(target),
    randomBytes(n, cb) { const result = () => randomFillSync(Buffer.alloc(size(n))); if (cb !== undefined) return callback(result, cb); return result(); },
    randomFillSync,
    randomFill(target, offset, count, cb) {
      if (typeof offset === "function") { cb = offset; offset = undefined; count = undefined; }
      else if (typeof count === "function") { cb = count; count = undefined; }
      return callback(() => randomFillSync(target, offset, count), cb);
    },
    randomInt(min, max, cb) {
      if (typeof max === "function") { cb = max; max = undefined; }
      if (max === undefined) { max = min; min = 0; }
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max <= min || max - min >= 2 ** 48) throw new RangeError("randomInt bounds are out of range");
      const generate = () => {
        const range = max - min, ceiling = Math.floor(2 ** 48 / range) * range, data = new Uint8Array(6);
        let n; do { nativeCrypto.getRandomValues(data); n = data.reduce((n, b) => n * 256 + b, 0); } while (n >= ceiling);
        return min + n % range;
      };
      if (cb !== undefined) return callback(generate, cb); return generate();
    },
    subtle: nativeCrypto.subtle, webcrypto: nativeCrypto,
  };
  for (const [name, algorithm] of Object.entries({ Md5: "md5", Sha1: "sha1", Sha256: "sha256", Sha384: "sha384", Sha512: "sha512", Crc32: "crc32", Crc32c: "crc32c" })) {
    crypto[name] = class { constructor() { this.hash = hash(algorithm, undefined, name.startsWith("Crc")); } update(value, encoding) { this.hash.update(value, encoding); return this; } digest(encoding) { return this.hash.digest(encoding); } };
  }
  crypto.crypto = crypto;
  const zlib = {};
  for (const name of ["gzip", "gunzip", "deflate", "inflate", "deflateRaw", "inflateRaw", "brotliCompress", "brotliDecompress", "zstdCompress", "zstdDecompress"]) {
    const sync = (input, options = {}) => {
      const level = options.level ?? (name === "zstdCompress" ? 3 : 6), max = options.maxOutputLength ?? 64 * 1024 ** 2;
      if (!Number.isInteger(level) || (!name.startsWith("zstd") && (level < -1 || level > 9))) throw new RangeError("compression level is out of range");
      if (!Number.isInteger(max) || max < 0) throw new RangeError("maxOutputLength is out of range");
      return Buffer.from(invoke(901, [name, bytes(input), level === -1 ? 6 : level, max]));
    };
    zlib[name + "Sync"] = sync;
    zlib[name] = (input, options, cb) => { if (typeof options === "function") { cb = options; options = undefined; } return callback(() => sync(input, options), cb); };
  }
  const url = {
    URL, URLSearchParams,
    domainToASCII: value => invoke(902, ["domainToASCII", String(value)]),
    domainToUnicode: value => invoke(902, ["domainToUnicode", String(value)]),
    // Preserve NSH's existing native projection (including escaped characters).
    fileURLToPath: value => String(value).replace(/^(?:file:\/\/)+/, ""),
    pathToFileURL(value) { if (typeof value !== "string") throw new TypeError("path must be a string"); const result = new URL("file:///"); result.pathname = value.replaceAll("%", "%25").replaceAll("\\", "%5C"); return result; },
    format(value, options = {}) {
      const parsed = new URL(String(value));
      const auth = options.auth !== false && parsed.username ? `${parsed.username}${parsed.password ? ":" + parsed.password : ""}@` : "";
      const host = options.unicode ? url.domainToUnicode(parsed.host) : parsed.host;
      return `${parsed.protocol}//${auth}${host}${parsed.pathname}${options.search === false ? "" : parsed.search}${options.fragment === false ? "" : parsed.hash}`;
    },
    urlToHttpOptions(value) {
      const parsed = new URL(String(value)), result = { protocol: parsed.protocol, hostname: parsed.hostname, pathname: parsed.pathname, path: parsed.pathname + parsed.search, href: parsed.href };
      if (parsed.hash) result.hash = parsed.hash.slice(1);
      if (parsed.search) result.search = parsed.search;
      if (parsed.username) result.auth = parsed.username + ":" + parsed.password;
      if (parsed.port) result.port = parsed.port;
      return result;
    },
  };
  return new Map([["path", { ...path, default: path }], ["buffer", { ...buffer, Blob, File }], ["crypto", { ...crypto, default: crypto }], ["zlib", { ...zlib, default: zlib }], ["url", { ...url, default: url }], ["console", { ...console, default: console }]]);
}
