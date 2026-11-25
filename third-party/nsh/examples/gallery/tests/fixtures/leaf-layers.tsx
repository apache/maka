import { mount, platform, Scroll, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";

// Plain texts are drawn as layers with no view of their own (#2066): a
// button's label, a list's rows, a selectable area's lines. What must still
// work through them: picking (a press on a label reaches its button), the
// name read from a button's content, scrolling, and a text turning into a
// view when it gets a listener.
function App() {
  const saves = signal(0);
  const taps = signal(0);
  const live = signal(false);
  const offset = signal(0);
  const rows = Array.from({ length: 60 }, (_, i) => `Leaf row ${i}`);
  return (
    <View style={{ flex: 1, padding: 24, gap: 12, backgroundColor: "white" }}>
      <Text style={{ color: "#111" }}>{`Platform: ${platform.os}`}</Text>
      <Text style={{ color: "#111" }}>{`Saves [${saves()}]`}</Text>
      <Text style={{ color: "#111" }}>{`Taps [${taps()}]`}</Text>
      <Text style={{ color: "#111" }}>{`Offset [${Math.round(offset())}]`}</Text>
      <View role="button" onPress={() => saves.set(saves() + 1)} style={{ padding: 8, width: 160 }}>
        <Text style={{ color: "#111" }}>Save draft</Text>
      </View>
      <View role="button" onPress={() => live.set(true)} style={{ padding: 8, width: 160 }}>
        <Text style={{ color: "#111" }}>Make live</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Text style={{ color: "#111" }}>Quiet before</Text>
        {/* The same text node gets a listener once live. */}
        <Text style={{ color: "#111" }} onPress={live() ? () => taps.set(taps() + 1) : undefined}>
          Tap target
        </Text>
        <Text style={{ color: "#111" }}>Quiet after</Text>
      </View>
      <Scroll testID="rows" onScroll={(e) => offset.set(e.offset.y)} style={{ height: 160, width: 320 }}>
        {rows.map((row) => (
          <Text style={{ color: "#111", height: 24 }}>{row}</Text>
        ))}
      </Scroll>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
