import { horizontalSizeClass, mount, platform, Text, View, windowSize } from "nsh";
import { Window } from "nsh/desktop";

// What the app's window reports of its size as the user resizes it.
function App() {
  return (
    <View style={{ flex: 1, padding: 24, gap: 8, backgroundColor: "white" }}>
      <Text style={{ color: "#111" }}>{`OS: ${platform.os}`}</Text>
      <Text style={{ color: "#111" }}>{`size=${Math.round(windowSize().width)}x${Math.round(windowSize().height)}`}</Text>
      <Text style={{ color: "#111" }}>{`class=${horizontalSizeClass()}`}</Text>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
