import { cleanup, signal, Text } from "nsh";
import { connect } from "websocket";
import { Button, Card, colors, mono } from "../ui";

/** Both WebSocket interfaces use the host's real transport. */
export function StandardWebSockets() {
  const result = signal("Ready");
  const busy = signal(false);
  const release = new Set<() => void>();
  let disposed = false;
  cleanup(() => { disposed = true; for (const close of release) close(); });

  const run = async () => {
    if (busy() || disposed) return;
    busy.set(true);
    try {
      const url = "ws://127.0.0.1:9877/";
      const socket = await connect(url);
      const close = () => { void socket.close().catch(() => {}); };
      if (disposed) { close(); return; }
      release.add(close);
      const timer = setTimeout(close, 5000);
      let moduleText: string;
      let moduleBytes: string;
      try {
        await socket.write("Hello module");
        moduleText = String(await socket.read());
        await socket.write(new Uint8Array([0, 127, 255]));
        moduleBytes = String(await socket.read());
      } finally { clearTimeout(timer); release.delete(close); await socket.close(); }
      if (disposed) return;

      const global = await new Promise<{ text: string; bytes: string }>((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
        let text: string | undefined;
        let settled = false;
        const stop = () => ws.close();
        release.add(stop);
        const finish = (error?: Error, bytes?: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          release.delete(stop);
          ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
          ws.close(1000, "Demo complete");
          error ? reject(error) : resolve({ text: text ?? "", bytes: bytes ?? "" });
        };
        const timer = setTimeout(() => finish(new Error("WebSocket echo timed out")), 5000);
        ws.onopen = () => ws.send("Hello global");
        ws.onmessage = (event) => {
          if (text === undefined) { text = String(event.data); ws.send(new Uint8Array([0, 127, 255])); }
          else finish(undefined, new Uint8Array(event.data as ArrayBuffer).join(","));
        };
        ws.onerror = () => finish(new Error("WebSocket connection failed"));
        ws.onclose = () => finish(new Error("Peer closed before echo"));
      });
      if (!disposed) result.set(`Module: ${moduleText}\nModule bytes: ${moduleBytes}\nGlobal: ${global.text}\nGlobal bytes: ${global.bytes}`);
    } catch (error) { if (!disposed) result.set(String(error)); }
    finally { if (!disposed) busy.set(false); }
  };

  return <Card icon="system" title="WebSockets" subtitle="websocket module and global WebSocket · local echo on 127.0.0.1:9877">
    <Button label="Run WebSockets" disabled={busy()} onPress={() => { void run(); }} />
    <Text style={{ userSelect: "text", color: colors.text, fontSize: 13, fontFamily: mono }}>{result()}</Text>
  </Card>;
}
