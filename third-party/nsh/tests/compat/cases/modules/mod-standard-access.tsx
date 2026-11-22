// Host-owned standard modules validate grants and URLs before native work.
// The compatibility fixture keeps those boundaries deterministic on every host.
// A function returning a promise never throws: a call the app's
// capabilities do not grant rejects with `ERR_ACCESS_DENIED`, naming the
// capability (`permission`) and what was asked for (`resource`); a wrong
// use rejects with a `TypeError`. (WebSocket denials need a domain that
// declares its capabilities: macos's mod-access-denied.)
import { Text, View, signal } from "nsh";
import fs, { readFile, writeFile, readdir, exists, unlink, rmdir, mkdir, stat, lstat, rename, readlink } from "fs/promises";
import net, { connect, Socket } from "net";
import websocketModule, { connect as connectWebSocket, WebSocketConnection } from "websocket";

function denial(permission: string, resource: string) {
  return (error: any) => {
    // Read before `instanceof` narrows `error` to `Error`, which has no code.
    const { code, permission: of, resource: on } = error ?? {};
    return error instanceof Error && !(error instanceof TypeError)
      && code === "ERR_ACCESS_DENIED" && of === permission && on === resource;
  };
}
function rejects(call: () => Promise<unknown>, check: (error: any) => boolean): Promise<boolean> {
  let promise: Promise<unknown>;
  try { promise = call(); }
  catch { return Promise.resolve(false); }
  return promise.then(() => false, check);
}
function misused(call: () => unknown) {
  try { call(); return false; }
  catch (error) { return error instanceof TypeError; }
}
const paths: [string, () => Promise<unknown>][] = [
  ["/compat-denied/file", () => readFile("/compat-denied/file")],
  ["/compat-denied/file", () => writeFile("/compat-denied/file", "data")],
  ["/compat-denied", () => readdir("/compat-denied")],
  ["/compat-denied/file", () => exists("/compat-denied/file")],
  ["/compat-denied/file", () => unlink("/compat-denied/file")],
  ["/compat-denied", () => rmdir("/compat-denied")],
  ["/compat-denied/new", () => mkdir("/compat-denied/new")],
  ["/compat-denied/file", () => stat("/compat-denied/file")],
  ["/compat-denied/file", () => lstat("/compat-denied/file")],
  ["/compat-denied/file", () => rename("/compat-denied/file", "/compat-denied/new")],
  ["/compat-denied/file", () => readlink("/compat-denied/file")],
];

const shown = signal("");
(async () => {
  const files = fs.readFile === readFile
    && (await Promise.all(paths.map(([path, call]) => rejects(call, denial("fs", path))))).every(Boolean);
  const sockets = net.connect === connect
    && await rejects(() => connect({ host: "compat.invalid", port: 80 }), denial("network", "compat.invalid:80"))
    && misused(() => new (Socket as any)());
  const websocket = websocketModule.connect === connectWebSocket
    && await rejects(() => connectWebSocket("https://compat.invalid/"), (e) => e instanceof TypeError)
    && misused(() => new (WebSocketConnection as any)());
  const syntax = (() => {
    try { new WebSocket("ftp://compat.invalid/"); return false; }
    catch (error) { return error instanceof SyntaxError; }
  })();
  shown.set(`Standard grants files=${files} tcp=${sockets} websocket=${websocket} global=${syntax}`);
})().catch((error) => shown.set(`Failed: ${error}`));

export default () => <View><Text>{shown()}</Text></View>;
