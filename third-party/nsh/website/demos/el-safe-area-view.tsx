import { mount, signal, Text, View } from "nsh";
import { type Edge, SafeAreaView, safeArea, safeAreaInsets } from "nsh/base";
import { button, buttonText, desktop, tint, ui } from "./palette";

const EDGES: Edge[] = ["top", "right", "bottom", "left"];

const format = (i: { top: number; right: number; bottom: number; left: number }) =>
  `top ${Math.round(i.top)} · right ${Math.round(i.right)} · bottom ${Math.round(i.bottom)} · left ${Math.round(i.left)}`;

// Called in a component: the insets where it renders (the root here, so the
// surface's safe area; inside a page or a dialog, theirs).
function Insets() {
  const insets = safeAreaInsets();
  return <Text style={{ color: ui().text, fontVariant: ["tabular-nums"] }}>{format(insets())}</Text>;
}

function App() {
  const edges = signal<Edge[]>([...EDGES]);
  const toggle = (edge: Edge) => edges.update((list) => (list.includes(edge) ? list.filter((e) => e !== edge) : EDGES.filter((e) => e === edge || list.includes(e))));
  const label = () => ({ fontSize: 12, color: ui().muted });
  return (
    // The tinted band around the card is SafeAreaView's padding: the insets of
    // the edges chosen, plus its own 16 pt.
    <SafeAreaView edges={edges()} style={{ flex: 1, backgroundColor: tint(ui().accent, 0.16), padding: 16 }}>
      <View
        style={{
          flex: 1,
          width: "100%",
          maxWidth: 560,
          alignSelf: "center",
          backgroundColor: ui().page,
          borderRadius: 16,
          borderWidth: 1,
          borderStyle: "dashed",
          borderColor: ui().faint,
          padding: 20,
          gap: 14,
        }}
      >
        <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>safe area view</Text>
        <Text style={{ color: ui().muted, lineHeight: 20 }}>
          {desktop
            ? "A desktop window or a browser page has no system UI over it: the insets are 0, so SafeAreaView pads only by its own 16 pt (the tinted band)."
            : "On a phone the insets are the status bar or notch on top and the home indicator below; SafeAreaView adds them to its own 16 pt. This browser frame has none, so they are 0 here."}
        </Text>

        <Text style={label()}>edges ({desktop ? "click" : "tap"} to toggle)</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Each of={EDGES}>
            {(edge) => {
              const on = () => edges().includes(edge());
              return (
                <View
                  role="button"
                  onPress={() => toggle(edge())}
                  {...button("secondary", { on })}
                >
                  <Text style={buttonText("secondary", { on })}>{edge()}</Text>
                </View>
              );
            }}
          </Each>
        </View>

        <View style={{ ...ui().inset, borderRadius: 12, padding: 14, gap: 6 }}>
          <Text style={label()}>edges</Text>
          <Text style={{ color: ui().text }}>{edges().length ? `[${edges().map((e) => `"${e}"`).join(", ")}]` : "[] (no inset padded)"}</Text>
          <Text style={label()}>safeArea() · the surface's insets</Text>
          <Text style={{ color: ui().text, fontVariant: ["tabular-nums"] }}>{format(safeArea())}</Text>
          <Text style={label()}>safeAreaInsets() · where it renders</Text>
          <Insets />
        </View>
      </View>
    </SafeAreaView>
  );
}

mount(App);
