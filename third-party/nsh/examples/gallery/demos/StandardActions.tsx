import { cleanup, signal, Text } from "nsh";
import { platform } from "nsh";
import { Buffer } from "buffer";
import console from "console";
import { createHash, randomUUID } from "crypto";
import fs from "fs/promises";
import net from "net";
import os from "os";
import path from "path";
import process from "process";
import { fileURLToPath, pathToFileURL } from "url";
import { gzipSync, gunzipSync } from "zlib";
import { Button, Card, colors, DemoPage, mono } from "../ui";
import { StandardWebSockets } from "./StandardWebSockets";

/** Each action calls the host's standard APIs and displays its result or error. */
export function StandardActions() {
  const results = signal<Record<string, string>>({});
  const busy = signal<Record<string, boolean>>({});
  let disposed = false;
  const release = new Set<() => void>();
  cleanup(() => { disposed = true; for (const close of release) close(); });
  const show = (key: string, text: string) => {
    if (!disposed) results.set({ ...results(), [key]: text });
  };
  const run = async (key: string, action: () => Promise<string>) => {
    if (disposed || busy()[key]) return;
    busy.set({ ...busy(), [key]: true });
    try { show(key, await action()); }
    catch (error) { show(key, String(error)); }
    finally { if (!disposed) busy.set({ ...busy(), [key]: false }); }
  };
  function Action(props: { name: string; detail: string; action: () => Promise<string> }) {
    return <Card icon="system" title={props.name} subtitle={props.detail}>
      <Button label={`Run ${props.name}`} disabled={busy()[props.name] ?? false} onPress={() => { void run(props.name, props.action); }} />
      <Text selectable style={{ color: colors.text, fontSize: 13, fontFamily: mono }}>{results()[props.name] ?? "Ready"}</Text>
    </Card>;
  }
  const dataDirectory = () => {
    if (!process.dataDir) throw new Error("The host has no data directory configured");
    return process.dataDir;
  };
  function Utilities() {
    return <Action name="Utilities" detail="buffer · crypto · path · url · zlib" action={async () => {
      const bytes = Buffer.from("Native Shell", "utf8");
      const packed = gzipSync(bytes);
      const filename = path.join(dataDirectory(), "gallery.txt");
      const url = pathToFileURL(filename);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const roundTrip = fileURLToPath(url);
      const roundTripStatus = roundTrip === filename ? "matches original path" : "MISMATCH (upstream URL module)";
      console.info("Gallery utilities", hash);
      return `${bytes.toString("base64")}\nSHA-256: ${hash}\nUUID: ${randomUUID()}\nGlobal UUID: ${crypto.randomUUID()}\nGlobal Buffer: ${globalThis.Buffer.from("NSH").toString("hex")}\nGzip: ${packed.length} bytes → ${gunzipSync(packed).toString()}\n${url.href}\nFile URL round trip: ${roundTripStatus}\n${roundTrip}\n${path.basename(filename)}`;
    }} />;
  }
  function Environment() {
    return <Action name="Environment" detail="os · process.nextTick · console · import.meta.url" action={async () => {
      await new Promise<void>((resolve) => process.nextTick(resolve));
      return `${os.platform() || platform.os} / ${os.arch()}\nProcess: ${process.platform || platform.os} / ${process.arch}\nHome: ${platform.os === "web" ? "Browser context" : os.homedir()}\nData: ${process.dataDir}\nEOL: ${JSON.stringify(os.EOL)}\nEnv: ${JSON.stringify(process.env)}\nModule: ${import.meta.url}`;
    }} />;
  }
  function Files() {
    return <Action name="Files" detail="fs/promises: create, write, read, list, inspect, rename, remove" action={async () => {
      const dir = path.join(dataDirectory(), `gallery-${randomUUID()}`);
      const file = path.join(dir, "note.txt");
      const moved = path.join(dir, "renamed.txt");
      await fs.mkdir(dir, { recursive: true });
      try {
        await fs.writeFile(file, "Hello from NSH");
        const text = await fs.readFile(file, "utf8");
        const bytes = await fs.readFile(file);
        const stats = await fs.stat(file);
        const link = await fs.lstat(file);
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const names = await fs.readdir(dir);
        let linkResult: string;
        try { linkResult = `Unexpected symlink target: ${await fs.readlink(file)}`; }
        catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "EINVAL") throw error;
          linkResult = "Expected EINVAL: note.txt is a regular file, not a symbolic link";
        }
        await fs.rename(file, moved);
        const exists = await fs.exists(moved);
        await fs.unlink(moved);
        return `${text}\n${bytes.length} bytes, stat: ${stats.size}, file: ${link.isFile()}\nMode: ${stats.mode.toString(8)}, directory: ${stats.isDirectory()}, symlink: ${link.isSymbolicLink()}\nModified: ${stats.mtime.toISOString()} (${stats.mtimeMs})\nAccessed: ${stats.atime.toISOString()} (${stats.atimeMs})\nCreated: ${stats.birthtime.toISOString()} (${stats.birthtimeMs})\n${names.join(", ")}\n${entries.map((entry) => `${entry.name}: directory=${entry.isDirectory()}`).join("\n")}\nRenamed: ${exists}; removed: ${!(await fs.exists(moved))}\nreadlink validation: ${linkResult}`;
      } finally {
        for (const name of await fs.readdir(dir)) await fs.unlink(path.join(dir, name));
        await fs.rmdir(dir);
      }
    }} />;
  }
  function Processes() {
    return <Action name="Processes" detail={platform.os === "web" ? "process.run · spawn · browser hosts return an unsupported-operation error" : "process.run · spawn · stdout/stderr/exit · stdin · kill"} action={async () => {
      const windows = os.platform() === "windows";
      const command = windows ? "cmd.exe" : "cat";
      const args = windows ? ["/d", "/c", "more"] : [];
      const output = await process.run(windows ? "cmd.exe" : "echo", windows ? ["/d", "/c", "echo", "Native Shell"] : ["Native Shell"], { timeoutMs: 3000 });
      if (disposed) return "Closed";
      const streamed = await new Promise<string>((resolve, reject) => {
        const child = process.spawn(command, args, { stdin: "pipe", lines: true, timeoutMs: 3000 });
        const stop = () => child.kill();
        release.add(stop);
        let text = `pid: ${child.pid}\n`;
        child.on("stdout", (line) => { text += line; });
        child.on("stderr", (line) => { text += line; });
        child.on("exit", (exit) => { release.delete(stop); exit.code === 0 ? resolve(text) : reject(new Error(JSON.stringify(exit))); });
        child.write("Hello through stdin\n");
        child.end();
      });
      return `run: ${output.code} ${output.stdout}${output.stderr}\nspawn: ${streamed}`;
    }} />;
  }
  function Exit() {
    return <Action name="Request host exit" detail="process.exit(0) · Gallery keeps this demo open by denying exit requests" action={async () => {
      try { process.exit(0); }
      catch (error) {
        if (!(error instanceof TypeError) || !error.message.includes("process.exit() is not granted")) throw error;
        return "Exit request blocked by Gallery policy. You can continue exploring.";
      }
      return "Exit requested from the host";
    }} />;
  }
  function Tcp() {
    return <Action name="TCP" detail={platform.os === "web" ? "net.connect · browser hosts return an unsupported-operation error" : "net.connect · Socket.write/read/close · local echo on 127.0.0.1:9876"} action={async () => {
      const socket = await net.connect("127.0.0.1", 9876);
      const close = () => socket.close();
      if (disposed) { close(); return "Closed"; }
      release.add(close);
      const timer = setTimeout(close, 5000);
      try { await socket.write("Hello TCP\n"); const bytes = await socket.read(1024); return bytes ? Buffer.from(bytes).toString() : "Peer closed"; }
      finally { clearTimeout(timer); close(); release.delete(close); }
    }} />;
  }
  return <DemoPage cards={[Utilities, Environment, Files, Processes, Tcp, StandardWebSockets, Exit]} />;
}
