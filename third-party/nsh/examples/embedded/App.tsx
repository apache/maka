// The nsh app the embedding samples (examples/embed-ios, examples/embed-android,
// crates/gpui/nsh-platform-gpui/examples/embed.rs) run. The badge is a native
// view of the host app, registered as `embed.badge` (`NshAppView.register(component:)`,
// `NshView.registerComponent`); the rest talks to the host app through its
// channel (`nsh/host`): the host's launch parameters, its messages, a call it
// answers and posts it hears. The documentation link opens through the host
// (`openUrl`): a host app may route it itself (`onOpenURL`,
// `setOpenUrlHandler`), else the system opens it. `App.test.tsx` plays the
// host app's part.
// The theme pill takes the host's brand through setThemeOverrides.

import { mount, signal, Text, View, type YNode } from "nsh";
import { nativeComponent } from "nsh/native";
import { host } from "nsh/host";
import { openUrl } from "nsh/device";
import { SafeAreaView } from "nsh/base";

/** The host app's badge: a label it draws, sized to its text. */
const Badge = nativeComponent<{ text: string; color?: string }, { tap: { count: number } }>("embed.badge", {
  props: ["text", "color"],
  events: ["tap"],
});

const colors = ["#8250df", "#0969da", "#1a7f37", "#cf222e"];

/** Who the host app says uses it (`NshAppView.params`, `NshView.setParams`). */
const user = typeof host.params.user === "string" ? host.params.user : "guest";

function App() {
  const taps = signal(0);
  const message = signal("No message from the host yet");
  const answer = signal("");
  let badge: YNode | undefined;
  // The host app's `send("message", { text })`.
  host.on<{ text: string }>("message", ({ text }) => message.set(text));
  const ask = async () => {
    try {
      const { time } = await host.call<{ time: string }>("time");
      answer.set(`The host says it is ${time}`);
    } catch (e) {
      answer.set(`The host did not answer: ${(e as Error).message}`);
    }
  };
  return (
    <SafeAreaView style={{ flex: 1, padding: 20, gap: 16, backgroundColor: "#f6f8fa" }}>
      <Text style={{ fontSize: 22, fontWeight: "700" }}>{`Hello, ${user}`}</Text>
      <Text style={{ color: "#57606a" }}>
        The badge below is a native view of the host app: nsh lays it out, sends it props and gets its events.
      </Text>
      <View class="self-start rounded-(--radius) bg-primary px-3 py-2">
        <Text class="text-primary-foreground">Styled by the host app's theme</Text>
      </View>
      <Badge
        ref={(node) => (badge = node)}
        text={taps() === 0 ? "Tap the native badge" : `Tapped ${taps()}×`}
        color={colors[taps() % colors.length]}
        onTap={(e) => {
          taps.set(e.count);
          badge?.command("pulse");
          host.post("tapped", { count: e.count });
        }}
        style={{ alignSelf: "flex-start", borderRadius: 8, overflow: "hidden" }}
      />
      <Text>{`JS saw ${taps()} taps`}</Text>
      <Text style={{ color: "#57606a" }}>{message()}</Text>
      <View
        onPress={ask}
        role="button"
        style={{ alignSelf: "flex-start", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: "#0969da" }}
        activeStyle={{ opacity: 0.7 }}
      >
        <Text style={{ color: "#ffffff", fontWeight: "600" }}>Ask the host for the time</Text>
      </View>
      <Text>{answer()}</Text>
      <Text
        role="link"
        onPress={() => openUrl("https://github.com/longbridge/nsh")}
        style={{ color: "#0969da", textDecorationLine: "underline" }}
      >
        Read the documentation
      </Text>
    </SafeAreaView>
  );
}

mount(App);
