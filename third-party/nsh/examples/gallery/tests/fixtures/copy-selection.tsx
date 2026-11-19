import { Clipboard, mount, platform, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

// A chat's shape: selectable messages above a composer (single-line or
// multiline) that keeps the keyboard focus while the messages are selected.
// Shows the clipboard's text, read every 100 ms, and puts back what it held
// before on "Restore" (nothing if it was never read).
function App() {
  const area = signal("");
  const focused = signal("none");
  const board = signal("");
  const restored = signal(false);
  let before: string | undefined;
  void (async () => {
    if (platform.os !== "macos") return;
    try {
      const held = await Clipboard.readText();
      await Clipboard.writeText("copy-selection sentinel");
      before = held;
    } catch {}
  })();
  setInterval(() => {
    Clipboard.readText().then(
      (text) => board.set(text),
      () => {},
    );
  }, 100);
  const restore = async () => {
    if (before !== undefined) await Clipboard.writeText(before);
    restored.set(true);
  };
  const field = { width: 320, color: "#111", borderWidth: 1, borderColor: "#999" } as const;
  return (
    <View style={{ flex: 1, padding: 24, gap: 12, backgroundColor: "white" }}>
      <Text style={{ color: "#111" }}>{`Platform: ${platform.os}`}</Text>
      <Text style={{ color: "#111" }}>{`Area [${area()}]`}</Text>
      <Text style={{ color: "#111" }}>{`Clipboard [${board()}]`}</Text>
      <Text style={{ color: "#111" }}>{`Focus [${focused()}]`}</Text>
      <Text>{restored() ? "Clipboard restored" : ""}</Text>
      <View selectable onSelectionChange={(e) => area.set(e.text)} style={{ gap: 8, width: 320 }}>
        <Text style={{ color: "#111", fontSize: 18 }}>Alpha beta gamma</Text>
        <Text style={{ color: "#111", fontSize: 18 }}>Delta epsilon</Text>
      </View>
      <Text style={{ userSelect: "text", color: "#111", fontSize: 18, width: 320 }}>
        Zeta eta theta iota
      </Text>
      <Input
        testID="composer"
        placeholder="Message"
        onFocus={() => focused.set("composer")}
        onBlur={() => focused.set("none")}
        style={{ ...field, height: 32 }}
      />
      <Input
        testID="notes"
        multiline
        placeholder="Notes"
        onFocus={() => focused.set("notes")}
        onBlur={() => focused.set("none")}
        style={{ ...field, height: 64 }}
      />
      <View role="button" onPress={restore} style={{ padding: 8, width: 120 }}>
        <Text style={{ color: "#111" }}>Restore</Text>
      </View>
    </View>
  );
}

mount(App);
