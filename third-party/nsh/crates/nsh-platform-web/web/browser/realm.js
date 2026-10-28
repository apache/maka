// Loaded as an external ES module in the app's own same-origin realm.
// Native import(), including top-level await and module cycles, remains
// the browser's module loader. No eval or Function compilation is used.
import { createChunkLoader } from "./loader.js";
const host = globalThis.__nsh_browser_realm;
Object.defineProperty(globalThis, "__nsh_import", { value: createChunkLoader(host.entry, host.live, url => import(url), host.prepareChunk) });
if (host.modules.get("process")) Object.defineProperty(globalThis, "process", { value: host.modules.get("process").default, writable: true, configurable: true });
Object.defineProperty(globalThis, "Buffer", { value: host.modules.get("buffer").Buffer, writable: true, configurable: true });
// Keep browser WebCrypto and extend only this app realm with NSH utilities.
for (const name of ["createHash", "createHmac", "randomBytes", "randomInt", "randomFill", "randomFillSync"]) globalThis.crypto[name] = host.modules.get("crypto")[name];
try {
  await import(host.entry);
  host.ready();
} catch (error) {
  host.failed(error);
}
