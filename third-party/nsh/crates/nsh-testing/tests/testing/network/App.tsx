import { mount, signal, Text, View } from "nsh";
import { connect } from "net";
import { connect as connectWebSocket } from "websocket";

// Port 9 of this machine: granted, and nothing listens there, so a
// connection that reaches the network fails with the OS's code.
const HOST = "127.0.0.1";
const PORT = 9;

/** What a connection came to: connected, or the code it failed with. */
function outcome(connecting: () => Promise<unknown>) {
  const shown = signal("waiting");
  connecting().then(
    () => shown.set("connected"),
    (e: Error & { code?: string }) => shown.set(`failed ${e.code}`),
  );
  return shown;
}

/** How the global `WebSocket` closed, and who refused it. */
function closed(url: string) {
  const shown = signal("waiting");
  const socket = new WebSocket(url);
  let message = "";
  socket.onerror = (e) => {
    message = (e as Event & { message?: string }).message ?? "";
  };
  socket.onclose = (e) => {
    const by = message.includes('network: "live"') ? "the test" : "the network";
    shown.set(`closed ${e.code} by ${by}`);
  };
  return shown;
}

function App() {
  const socket = outcome(() => connect({ host: HOST, port: PORT }));
  const client = outcome(() => connectWebSocket(`ws://${HOST}:${PORT}/feed`));
  const global = closed(`ws://${HOST}:${PORT}/feed`);
  return (
    <View>
      <Text>{`Socket: ${socket()}`}</Text>
      <Text>{`WebSocket: ${client()}`}</Text>
      <Text>{`Global WebSocket: ${global()}`}</Text>
    </View>
  );
}

mount(App);
