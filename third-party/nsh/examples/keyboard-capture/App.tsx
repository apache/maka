import { mount, signal, Text, View, type KeyEvent } from "nsh";

/**
 * A scenario for the web's raw key events and mounted capture policy.
 *
 * Tab to the count button, then:
 * - hold Space, press Shift, release Space: nothing is counted (the release
 *   matches `captureKeys` even though the press did not);
 * - press Space and release it without Shift: the count goes up once;
 * - Escape and Shift+Space are captured and run no browser default.
 *
 * Every press and release the display hears is listed with the browser's own
 * key and DOM code, the modifiers, the repeat mark and whether the mounted
 * policy took the transition (`defaultPrevented`).
 */
function App() {
  const presses = signal(0);
  const events = signal<string[]>([]);
  const listen = (phase: string) => (e: KeyEvent) => {
    const held = [
      e.modifiers.control && "ctrl",
      e.modifiers.alt && "alt",
      e.modifiers.shift && "shift",
      e.modifiers.platform && "platform",
    ].filter(Boolean).join("+") || "plain";
    const line = `${phase} ${e.key} ${e.code || "—"} ${held}${e.repeat ? " repeat" : ""}${e.defaultPrevented ? " defaultPrevented" : ""}`;
    events.update((list) => [line, ...list].slice(0, 8));
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#f4f5f7", padding: 24, paddingTop: 64, gap: 16 }}>
      <Text style={{ fontSize: 26, fontWeight: "bold", color: "#1f2328" }}>Keyboard capture</Text>
      <Text style={{ fontSize: 15, color: "#57606a" }}>
        Tab to the button. Hold Space, press Shift, release Space: nothing is counted.
        A plain Space counts once. Escape and Shift+Space are taken by the policy.
      </Text>
      <View
        captureKeys={["escape", "shift+space"]}
        onKeyDown={listen("down")}
        onKeyUp={listen("up")}
        style={{ backgroundColor: "#ffffff", borderRadius: 16, padding: 24, gap: 12 }}
      >
        <View
          role="button"
          accessibilityLabel="count"
          onPress={() => presses.update((n) => n + 1)}
          style={{ backgroundColor: "#0969da", borderRadius: 12, paddingVertical: 14, alignItems: "center" }}
        >
          <Text style={{ color: "#ffffff", fontSize: 18, fontWeight: "bold" }}>Count: {presses()}</Text>
        </View>
        <View style={{ gap: 4 }}>
          {events().map((line) => (
            <Text style={{ fontFamily: "monospace", fontSize: 13, color: "#1f2328" }}>{line}</Text>
          ))}
        </View>
      </View>
    </View>
  );
}

mount(App);
