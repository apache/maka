import { mount, platform, signal, Text, View } from "nsh";

// A one-line text whose link does not fit beside the words before it: the
// link wraps onto the line the truncation hides, and the line ends with an
// ellipsis right where the link starts.
function App() {
  const pressed = signal(0);
  return (
    <View style={{ flex: 1, padding: 24, gap: 12, backgroundColor: "white" }}>
      <Text style={{ color: "#111" }}>{`Hidden link pressed: ${pressed()}`}</Text>
      <Text style={{ color: "#111" }}>{`Platform: ${platform.os}`}</Text>
      <View style={{ width: 200 }}>
        <Text style={{ numberOfLines: 1, fontSize: 20, color: "#111" }}>
          ABCDEFGH
          <Text onPress={() => pressed.set(pressed() + 1)} style={{ color: "blue" }}>
            WWWWWWWW
          </Text>
        </Text>
      </View>
    </View>
  );
}

mount(App);
