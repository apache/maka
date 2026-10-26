import { mount, signal, Text, View } from "nsh";
import { safeArea, safeAreaInsets } from "nsh";
import { button, buttonText, desktop, tint, ui } from "./palette";

type Edge = "top" | "right" | "bottom" | "left";

const EDGES: Edge[] = ["top", "right", "bottom", "left"];

// `calc(env(safe-area-inset-<edge>) + 16px)` on the edges chosen, 16 px on the others.
const side = (edges: Edge[], e: Edge) => (edges.includes(e) ? (`calc(env(safe-area-inset-${e}) + 16px)` as const) : 16);
const padding = (edges: Edge[]) => ({
  paddingTop: side(edges, "top"),
  paddingRight: side(edges, "right"),
  paddingBottom: side(edges, "bottom"),
  paddingLeft: side(edges, "left"),
});

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
    // The tinted band around the card is the view's padding: the insets of
    // the edges chosen, plus 16 pt.
    <View style={{ flex: 1, backgroundColor: tint(ui().accent, 0.16), ...padding(edges()) }}>
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
        <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>safe area insets</Text>
        <Text style={{ color: ui().muted, lineHeight: 20 }}>
          {desktop
            ? "A desktop window or a browser page has no system UI over it: the insets are 0, so the view pads only by its 16 pt (the tinted band)."
            : "On a phone the insets are the status bar or notch on top and the home indicator below; env(safe-area-inset-*) adds them to its 16 pt. This browser frame has none, so they are 0 here."}
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
    </View>
  );
}

mount(App);
