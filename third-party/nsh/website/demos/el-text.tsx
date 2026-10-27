import { mount, signal, Text, View } from "nsh";
import { button, buttonText, focusRing, ui } from "./palette";

const LONG =
  "Text is typeset natively (CoreText on iOS, StaticLayout on Android) and measured on the engine thread, so the main thread only draws it.";

function App() {
  const tapped = signal("nothing yet");
  const lines = signal(2);
  const link = () => ({ color: ui().accent, textDecorationLine: "underline" }) as const;
  return (
    <View style={{ flex: 1, backgroundColor: ui().page }}>
      <View style={{ flex: 1, width: "100%", maxWidth: 560, alignSelf: "center", padding: 20, paddingTop: 24, gap: 14 }}>
        <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>text</Text>

        <Text style={{ fontSize: 16, lineHeight: 24, color: ui().text }}>
          {"Nested text elements are spans: "}
          <Text style={{ fontWeight: "700" }}>bold</Text>
          {", "}
          <Text style={{ fontStyle: "italic", color: ui().violet }}>italic</Text>
          {", and "}
          <Text style={link()} onPress={() => tapped.set("the first link")} hoverStyle={{ opacity: 0.88 }} focusStyle={focusRing()} activeStyle={{ opacity: 0.7 }}>
            links
          </Text>
          {" that take presses of "}
          <Text style={link()} onPress={() => tapped.set("the second link")} hoverStyle={{ opacity: 0.88 }} focusStyle={focusRing()} activeStyle={{ opacity: 0.7 }}>
            their own
          </Text>
          .
        </Text>
        <Text style={{ fontSize: 13, color: ui().muted }}>Pressed: {tapped()}</Text>

        <View style={{ height: 1, backgroundColor: ui().line }} />

        <Text numberOfLines={lines()} style={{ fontSize: 15, color: ui().text }}>
          {LONG}
        </Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View
            onPress={() => lines.set(lines() === 2 ? 0 : 2)}
            {...button()}
          >
            <Text style={buttonText()}>{lines() === 2 ? "Show all" : "numberOfLines 2"}</Text>
          </View>
        </View>

        <Text numberOfLines={1} ellipsizeMode="middle" style={{ fontSize: 15, color: ui().muted }}>
          {LONG}
        </Text>

        <Text style={{ fontSize: 17, color: ui().text }}>
          <Text style={{ textDecorationLine: "line-through", textDecorationColor: ui().down }}>struck</Text>{" "}
          <Text style={{ textTransform: "uppercase", letterSpacing: 2 }}>spaced</Text>{" "}
          <Text style={{ fontVariant: ["tabular-nums"] }}>0123456789</Text>
        </Text>

        <Text
          style={{
            fontSize: 28,
            fontWeight: "800",
            color: ui().onAccent,
            backgroundColor: "#c8f26d",
            paddingHorizontal: 10,
            borderRadius: 8,
            textShadowColor: "rgba(255,255,255,0.55)",
            textShadowOffset: { width: 2, height: 2 },
            textShadowRadius: 4,
          }}
        >
          Text shadow
        </Text>
      </View>
    </View>
  );
}

mount(App);
