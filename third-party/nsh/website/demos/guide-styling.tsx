import { mount, Scroll, signal, Text, View } from "nsh";
import { reduceMotion } from "nsh";
import { desktop, focusRing, size, tint, ui, wide } from "./palette";

// A function, so the styles follow the page's theme.
const styles = () =>
  ({
    tile: {
      width: 96,
      height: 96,
      borderRadius: 16,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: ui().card.backgroundColor,
    },
    label: { fontSize: 12, fontWeight: "600", color: ui().text, textAlign: "center" },
    selected: { borderWidth: 3, borderColor: ui().accent },
  }) as const;

/** `ink`: the label's colour on a filled tile. */
function Tile(props: { label: string; style?: object; ink?: string }) {
  return (
    <View style={[styles().tile, props.style]}>
      <Text style={[styles().label, props.ink !== undefined && { color: props.ink }]}>{props.label}</Text>
    </View>
  );
}

function App() {
  const on = signal(false);
  const picked = signal(1);

  const tiles = (justify: "center" | "flex-start") => (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16, justifyContent: justify }}>
      <Tile
        label="boxShadow"
        style={{ backgroundImage: ui().card.backgroundImage, boxShadow: ui().card.boxShadow }}
      />
      <Tile label="dashed border" style={{ borderWidth: 2, borderStyle: "dashed", borderColor: ui().violet }} />
      <Tile label="gradient" ink="#0c0d0f" style={{ backgroundImage: "linear-gradient(135deg, #dbf893, #7ea8ff)" }} />
      <Tile label="radial" ink="#0c0d0f" style={{ backgroundImage: "radial-gradient(circle, #ffd99a, #ff8a7a)" }} />
      <Tile label="corners" style={{ borderTopLeftRadius: 40, borderBottomRightRadius: 40, backgroundColor: tint(ui().up, 0.3) }} />
      <Tile label="continuous" ink={ui().page} style={{ borderRadius: 28, borderCurve: "continuous", backgroundColor: ui().up }} />
      <Tile label="rotate + scale" style={{ backgroundColor: tint(ui().info, 0.3), transform: [{ rotate: "-8deg" }, { scale: 0.9 }] }} />
      <Tile label="outline" style={{ outlineWidth: 2, outlineColor: ui().accent, outlineOffset: 3 }} />
      <Tile label="opacity 0.5" ink={ui().page} style={{ backgroundColor: ui().text, opacity: 0.5 }} />
    </View>
  );
  const arrays = () => (
    <View style={{ gap: 10 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: ui().muted }}>STYLE ARRAYS: {desktop ? "CLICK" : "TAP"} TO SELECT</Text>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Each of={["Small", "Medium", "Large"]}>
          {(label, i) => (
            <View
              onPress={() => picked.set(picked() === i() ? -1 : i())}
              style={[
                desktop
                  ? { height: size.control + 6, justifyContent: "center", paddingHorizontal: 14, borderRadius: 8, backgroundColor: ui().raised.backgroundColor, alignItems: "center", borderWidth: 3, borderColor: "transparent" }
                  : { flex: 1, padding: 12, borderRadius: 10, backgroundColor: ui().raised.backgroundColor, alignItems: "center", borderWidth: 3, borderColor: "transparent" },
                picked() === i() && styles().selected,
              ]}
              hoverStyle={{ opacity: 0.88 }}
              focusStyle={focusRing()}
              activeStyle={{ opacity: 0.7 }}
            >
              <Text style={{ color: ui().text, fontSize: desktop ? 13 : undefined }}>{label()}</Text>
            </View>
          )}
        </Each>
      </View>
    </View>
  );
  const transitions = () => (
    <View style={{ gap: 10 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: ui().muted }}>TRANSITIONS: {desktop ? "CLICK" : "TAP"} THE BOX</Text>
      <View
        onPress={() => on.set(!on())}
        style={{
          height: 72,
          borderRadius: on() ? 36 : 12,
          backgroundColor: on() ? ui().accent : ui().info,
          transform: [{ translateX: on() ? 120 : 0 }],
          width: 150,
          alignItems: "center",
          justifyContent: "center",
          transitionProperty: "all",
          transitionDuration: reduceMotion() ? 0 : 400,
          transitionTimingFunction: "ease-in-out",
        }}
        hoverStyle={{ opacity: 0.88 }}
        focusStyle={focusRing()}
        activeStyle={{ opacity: 0.7 }}
      >
        <Text style={{ color: ui().page, fontWeight: "600" }}>{on() ? "On" : "Off"}</Text>
      </View>
    </View>
  );

  return (
    <Scroll style={{ flex: 1, backgroundColor: ui().page }}>
      {() =>
        wide() ? (
          <View style={{ padding: 20, paddingTop: 24, flexDirection: "row", gap: 32 }}>
            <View style={{ width: 5 * 96 + 4 * 16 }}>{tiles("flex-start")}</View>
            <View style={{ flex: 1, minWidth: 0, gap: 24 }}>
              {arrays()}
              {transitions()}
            </View>
          </View>
        ) : (
          <View style={{ padding: 20, paddingTop: 24, gap: 20 }}>
            {tiles("center")}
            {arrays()}
            {transitions()}
          </View>
        )
      }
    </Scroll>
  );
}

mount(App);
