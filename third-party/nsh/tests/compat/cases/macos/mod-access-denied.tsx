// A case of the API's test suite (docs/dev/compatibility.md): what the
// macos domain's capabilities (files in the data directory, nothing else)
// do not grant of `nsh`'s modules. Each call returns a promise that rejects
// with `ERR_ACCESS_DENIED`, naming the capability (`permission`) and what
// was asked for (`resource`, `""` when the capability has none); a refused
// `fetch` rejects as every failed fetch does, with a `TypeError`. Nothing
// throws. A WebSocket refused: `websocket`'s `connect` rejects the same way,
// and the global `WebSocket` reports it as a browser's does a connection that
// fails: `error`, then `close` (1006, not clean). Its script checks each.
import { Text, View, signal } from "nsh";
import { Clipboard, Image, Picker, openUrl } from "nsh";
import { connect } from "websocket";

const described = (e: any) => [e.name, e.code, e.permission, JSON.stringify(e.resource)].join(" ");

function settle(call: () => Promise<unknown>): Promise<string> {
  try {
    return call().then(() => "resolved", described);
  } catch (e) {
    return Promise.resolve(`threw ${described(e)}`);
  }
}

/** The events the global `WebSocket` fires for `url`, until it closes. */
function refused(url: string): Promise<string> {
  return new Promise((resolve) => {
    const events: string[] = [];
    const socket = new WebSocket(url);
    socket.onerror = (e) => events.push(e.type);
    socket.onclose = (e) => {
      events.push(String(e.code), String(e.wasClean));
      resolve(events.join(","));
    };
  });
}

function App() {
  const shown = signal<string[]>([]);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      {() => shown().map((line) => <Text>{line}</Text>)}
      <View
        testID="run"
        onPress={async () => {
          const clipboard = await Promise.all([
            settle(() => Clipboard.writeText("copied")),
            settle(() => Clipboard.readText()),
            settle(() => Clipboard.hasText()),
            settle(() => Clipboard.writeImage("data:image/png;base64,aGk=")),
            settle(() => Clipboard.readImage()),
            settle(() => Clipboard.hasImage()),
            settle(() => Clipboard.readFiles()),
          ]);
          shown.set([
            `Clipboard: ${clipboard[1]}`,
            `Clipboard denied: ${clipboard.filter((r) => r === clipboard[1]).length} of ${clipboard.length}`,
            `Picker: ${await settle(() => Picker.pickImages())}`,
            `Open: ${await settle(() => openUrl("https://example.com/docs"))}`,
            `Image size: ${await settle(() => Image.getSize("https://example.com/a.png"))}`,
            `Image prefetch: ${await settle(() => Image.prefetch("https://example.com/b.png"))}`,
            `Fetch: ${await settle(() => fetch("https://example.com/data"))}`,
            `WebSocket: ${await settle(() => connect("ws://example.com/feed"))}`,
            `Global WebSocket: ${await refused("ws://example.com/feed")}`,
          ]);
        }}
      >
        <Text>Run</Text>
      </View>
    </View>
  );
}

export default App;
