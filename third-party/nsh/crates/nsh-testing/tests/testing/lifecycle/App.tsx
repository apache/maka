// The app host's lifecycle events as a headless run sees them: closing the
// last window reaches `Application.on("lastWindowClosed")`, and the quit
// policy decides whether the app stays (macOS's default leaves it running).
import { mount, signal, Storage, Text, View } from "nsh";
import { Application, Window } from "nsh/desktop";

const open = signal(true);
const log = signal("waiting");

Application.on("lastWindowClosed", () => {
  log.set("last closed");
  void Storage.setItem("flow.lastWindowClosed", "yes");
});

Application.on("reopen", () => {
  log.set("reopened");
  void Storage.setItem("flow.reopen", "yes");
});

function Main() {
  return (
    <View style={{ flex: 1 }}>
      <View onPress={() => open.set(false)} style={{ width: 120, height: 24 }}>
        <Text>Close</Text>
      </View>
      <Text>{`Log: ${log()}`}</Text>
    </View>
  );
}

function App() {
  return (
    <Window id="main" open={open()} onOpenChange={({ open: now }) => open.set(now)}>
      <Main />
    </Window>
  );
}

mount(App);
