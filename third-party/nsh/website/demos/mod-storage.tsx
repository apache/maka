// Storage: a launch counter kept across reloads and followed across tabs,
// the stored keys and a reset.
import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { Storage } from "nsh";
import { button, buttonText, sectionSurface, ui, wide } from "./palette";

function App() {
  const opened = signal<number | null>(null);
  const keys = signal<string[]>([]);
  const saved = signal(true);

  const start = async () => {
    const count = Number((await Storage.getItem("opened")) ?? "0") + 1;
    try {
      await Storage.setItem("opened", String(count));
      await Storage.setItem("lastOpened", new Date().toISOString());
    } catch {
      // The browser keeps nothing for this page (site data blocked, some
      // private modes): `setItem` rejects and the value is not kept.
      saved.set(false);
    }
    opened.set(count);
    keys.set(await Storage.keys());
  };
  const reset = async () => {
    await Storage.clear();
    opened.set(0);
    keys.set(await Storage.keys());
  };
  start();
  // Another tab of the page counted an opening, or reset: follow it.
  Storage.on("change", async (e) => {
    if (e.key === null || e.key === "opened") opened.set(Number(e.value ?? "0"));
    keys.set(await Storage.keys());
  });

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: wide() ? 20 : 16, paddingTop: 24, gap: 12, alignItems: wide() ? "flex-start" : "stretch" }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>Storage</Text>
      <View style={{ ...sectionSurface(), padding: 16, gap: 6, width: wide() ? 440 : undefined }}>
        <Text style={{ fontSize: 28, fontWeight: "700", color: ui().text }}>
          {opened() === null ? "Reading…" : `Opened ${opened()} ${opened() === 1 ? "time" : "times"}`}
        </Text>
        <Text style={{ color: ui().muted }}>
          {saved() ? "Reload the page: the count is still there. Open it in another tab: this one follows." : "Not saved: this browser keeps no storage for the page."}
        </Text>
      </View>
      <Text style={{ color: ui().muted }}>{`Keys: ${keys().length ? keys().join(", ") : "none"}`}</Text>
      <Button onPress={reset} {...button()}>
        <Text style={buttonText()}>Reset</Text>
      </Button>
    </View>
  );
}

mount(App);
