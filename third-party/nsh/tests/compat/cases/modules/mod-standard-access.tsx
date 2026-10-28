// Host-owned standard modules validate grants and URLs before native work.
// The compatibility fixture keeps those boundaries deterministic on every host.
import { Text, View } from "nsh";
import fs, { readFile, writeFile, readdir, exists, unlink, rmdir, mkdir, stat, lstat, rename, readlink } from "fs/promises";
import net, { connect, Socket } from "net";
import { WebSocket as NativeWebSocket, WebSocketConnection } from "websocket";

function denied(call: () => unknown) {
  try { call(); return false; }
  catch (error) { return error instanceof TypeError; }
}
const paths = [
  () => readFile("/compat-denied/file"),
  () => writeFile("/compat-denied/file", "data"),
  () => readdir("/compat-denied"),
  () => exists("/compat-denied/file"),
  () => unlink("/compat-denied/file"),
  () => rmdir("/compat-denied"),
  () => mkdir("/compat-denied/new"),
  () => stat("/compat-denied/file"),
  () => lstat("/compat-denied/file"),
  () => rename("/compat-denied/file", "/compat-denied/new"),
  () => readlink("/compat-denied/file"),
];
const files = fs.readFile === readFile && paths.every(denied);
const sockets = net.connect === connect && denied(() => connect({ host: "compat.invalid", port: 80 }))
  && denied(() => new (Socket as any)());
const websocket = denied(() => NativeWebSocket.connect("https://compat.invalid/"))
  && denied(() => new (WebSocketConnection as any)());
const browserSocket = (() => { try { new WebSocket("ftp://compat.invalid/"); return false; } catch (error) { return error instanceof SyntaxError; } })();
export default () => <View><Text>{`Standard grants files=${files} tcp=${sockets} websocket=${websocket} global=${browserSocket}`}</Text></View>;
