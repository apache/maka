import { mount, signal, Text, View } from "nsh";
import { Sheet } from "nsh/base";
import { desktop, Inspector, Log, Panel, size, Stage, ui, wide } from "./palette";

type Side = "bottom" | "top" | "left" | "right";

/** The panel's corners and size across, by the edge it is on. */
function panel(side: Side) {
  const r = 20;
  const across = side === "left" || side === "right" ? { width: wide() ? 320 : 280 } : {};
  const corners = {
    bottom: { borderTopLeftRadius: r, borderTopRightRadius: r, paddingBottom: 32 },
    top: { borderBottomLeftRadius: r, borderBottomRightRadius: r, paddingTop: 32 },
    left: { borderTopRightRadius: r, borderBottomRightRadius: r },
    right: { borderTopLeftRadius: r, borderBottomLeftRadius: r },
  }[side];
  return { ...ui().card, padding: 20, gap: 12, ...across, ...corners };
}

function App() {
  const open = signal(false);
  const side = signal<Side>("bottom");
  const events = signal<string[]>([]);
  const log = (e: string) => events.set([e, ...events()].slice(0, 6));
  const show = (s: Side) => {
    side.set(s);
    open.set(true);
    log(`open · side ${s}`);
  };
  /** A button that opens the sheet at side `s`. */
  const opener = (s: Side) => (
    <View
      onPress={() => show(s)}
      activeStyle={{ opacity: 0.7 }}
      style={{
        ...(s === side() ? ui().accentFill : ui().raised),
        height: wide() ? size.control : 42,
        paddingHorizontal: wide() ? 12 : 0,
        borderRadius: wide() ? 8 : 10,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ fontSize: wide() ? 13 : 14, fontWeight: "600", color: s === side() ? ui().onAccent : ui().text }}>side="{s}"</Text>
    </View>
  );
  const changes = () => <Log title="onOpenChange(open, reason) · onCancel" lines={events()} minHeight={130} />;

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>sheet</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Open a side; click the backdrop or press Escape to close it" : "Open a side; tap the backdrop or Android's back to close it"}
      </Text>

      {() =>
        wide() ? (
          <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>
            {/* Each button at the edge its sheet comes from. */}
            <Stage width={360} gap={12}>
              <View style={{ alignItems: "center" }}>{opener("top")}</View>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                {opener("left")}
                {opener("right")}
              </View>
              <View style={{ alignItems: "center" }}>{opener("bottom")}</View>
            </Stage>
            <Inspector>
              <Panel title="open · side">
                <Text style={{ fontSize: 13, color: ui().text }}>
                  {open() ? "open" : "closed"} · {side()}
                </Text>
              </Panel>
              {changes()}
            </Inspector>
          </View>
        ) : (
          <>
            <View style={{ flex: 1, minHeight: 200, alignItems: "center", justifyContent: "center" }}>
              <View style={{ width: 240, gap: 8 }}>
                <Each of={["top", "left", "right", "bottom"] as Side[]}>{(s) => opener(s())}</Each>
              </View>
            </View>
            {changes()}
          </>
        )
      }

      <Sheet
        open={open()}
        closeOnSwipe
        side={side()}
        onOpenChange={(next, reason) => {
          open.set(next);
          log(`onOpenChange · ${next ? "opened" : "closed"} · ${reason}`);
        }}
        onCancel={() => log("onCancel")}
        popupStyle={panel(side())}
        backdropStyle={{ backgroundColor: "rgba(0,0,0,0.45)" }}
      >
        <Text style={{ fontSize: 17, fontWeight: "700", color: ui().text }}>Filters</Text>
        <Text style={{ fontSize: 14, color: ui().muted }}>
          A panel at the {side()} edge. {desktop ? "The backdrop and Escape close it." : "The backdrop and Android's back close it."}
        </Text>
        <View
          onPress={() => {
            open.set(false);
            log("Done pressed");
          }}
          activeStyle={{ opacity: 0.7 }}
          style={
            wide()
              ? { ...ui().primary, alignSelf: "flex-end", height: size.control, paddingHorizontal: 14, borderRadius: 8, justifyContent: "center" }
              : { ...ui().primary, height: 42, borderRadius: 10, alignItems: "center", justifyContent: "center" }
          }
        >
          <Text style={{ fontSize: wide() ? 13 : 14, fontWeight: "600", color: ui().onPrimary }}>Done</Text>
        </View>
      </Sheet>
    </View>
  );
}

mount(App);
