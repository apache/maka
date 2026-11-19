import { mount, platform, signal, Text, View } from "nsh";

// Two one-line texts whose links do not fit. The clamped line holds the rest
// of its paragraph, cut at the box for the ellipsis: in the first the link
// starts early enough that its first characters show; in the second the
// words before it fill the line, so none of the link shows and the ellipsis
// stands for it.
function App() {
  const cut = signal(0);
  const hidden = signal(0);
  return (
    <View style={{ flex: 1, padding: 24, gap: 12, backgroundColor: "white" }}>
      <Text style={{ color: "#111" }}>{`Cut link pressed: ${cut()}`}</Text>
      <Text style={{ color: "#111" }}>{`Hidden link pressed: ${hidden()}`}</Text>
      <Text style={{ color: "#111" }}>{`Platform: ${platform.os}`}</Text>
      <View style={{ width: 200 }}>
        <Text style={{ numberOfLines: 1, fontSize: 20, color: "#111" }}>
          ABCD
          <Text onPress={() => cut.set(cut() + 1)} style={{ color: "blue" }}>
            WWWWWWWWWW
          </Text>
        </Text>
      </View>
      <View style={{ width: 200 }}>
        <Text style={{ numberOfLines: 1, fontSize: 20, color: "#111" }}>
          ABCDEFGHIJKLMNOPQRST
          <Text onPress={() => hidden.set(hidden() + 1)} style={{ color: "blue" }}>
            MMMMMMMM
          </Text>
        </Text>
      </View>
    </View>
  );
}

mount(App);
