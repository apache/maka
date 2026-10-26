import { mount, signal, Text, View } from "nsh";
import { button, buttonText, desktop, focusRing, Inspector, Panel, Stage, ui, wide } from "./palette";

function App() {
  const presses = signal(0);
  const size = signal("");
  const views = () => (
    <>
      <View
        onPress={() => presses.update((n) => n + 1)}
        {...button("accent", { align: "center" })}
      >
        <Text style={buttonText("accent")}>activeStyle opacity · pressed {presses()}×</Text>
      </View>

      <View
        onPress={() => presses.update((n) => n + 1)}
        activeStyle={{ backgroundColor: ui().border }}
        style={{ ...ui().card, backgroundImage: "none", borderRadius: 16, padding: 16 }}
        hoverStyle={{ opacity: 0.88 }}
        focusStyle={focusRing()}
      >
        <Text style={{ color: ui().text, fontSize: wide() ? 14 : 16 }}>activeStyle background ({desktop ? "click" : "tap"} and hold)</Text>
      </View>

      <View class="flex-row gap-3">
        <View class="flex-1 h-20 rounded-xl bg-[#ff6170] hover:bg-[#ff7d89] active:bg-[#d94d5b] items-center justify-center" focusStyle={focusRing()} onPress={() => {}}>
          <Text class="text-[#13160c] font-semibold">active:</Text>
        </View>
        <View class="flex-1 h-20 rounded-xl bg-[#45d49a] items-center justify-center shadow-lg">
          <Text class="text-[#0c0d0f] font-semibold">shadow-lg</Text>
        </View>
        <View
          class="flex-1 h-20 rounded-xl items-center justify-center"
          style={{ backgroundImage: `linear-gradient(135deg, ${ui().violet}, ${ui().info})` }}
        >
          <Text class="font-semibold" style={{ color: ui().page }}>gradient</Text>
        </View>
      </View>
    </>
  );
  const measured = (height?: number) => (
    <View
      onLayout={(e) => size.set(`${Math.round(e.size.width)} × ${Math.round(e.size.height)} pt`)}
      style={{
        flex: height === undefined ? 1 : undefined,
        height,
        borderRadius: 12,
        borderWidth: 2,
        borderStyle: "dashed",
        borderColor: ui().faint,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: ui().muted }}>onLayout: {size()}</Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: ui().page }}>
      {() =>
        wide() ? (
          <View style={{ flex: 1, padding: 20, paddingTop: 24, gap: 14 }}>
            <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>view</Text>
            <Text style={{ color: ui().muted }}>Click and hold the views; resize the window to see onLayout</Text>
            <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>
              <Stage width={480} gap={16}>
                {views()}
                {measured(120)}
              </Stage>
              <Inspector>
                <Panel title="onPress">
                  <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>pressed {presses()}×</Text>
                </Panel>
                <Panel title="onLayout" grow>
                  <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>{size()}</Text>
                </Panel>
              </Inspector>
            </View>
          </View>
        ) : (
          <View style={{ flex: 1, width: "100%", maxWidth: 640, alignSelf: "center", padding: 20, paddingTop: 24, gap: 16 }}>
            <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>view</Text>
            {views()}
            {measured()}
          </View>
        )
      }
    </View>
  );
}

mount(App);
