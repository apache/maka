import { mount, platform, Scroll, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";

// A schedule: a vertical list of rows inside a view that pans its timeline
// sideways (`panActivation` around the scroll view); each row presses.
function App() {
  const offset = signal(0);
  const panned = signal(false);
  const pressed = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 80 }}>
      <Text>{offset() > 0 ? "list: scrolled" : "list: at top"}</Text>
      <Text>{`timeline: ${panned() ? "panned" : "still"}`}</Text>
      <Text>{`pressed: ${pressed()}`}</Text>
      <Text>{`Platform: ${platform.os}`}</Text>
      <View
        testID="timeline"
        panActivation={{ activeOffsetX: 10, failOffsetY: 10 }}
        onResponderMove={() => panned.set(true)}
        style={{ flex: 1 }}
      >
        <Scroll testID="rows" onScroll={(e) => offset.set(e.offset.y)} style={{ flex: 1 }}>
          {Array.from({ length: 60 }, (_, i) => (
            <View
              testID={`row-${i + 1}`}
              onPress={() => pressed.set(`row ${i + 1}`)}
              style={{ height: 60, justifyContent: "center", paddingHorizontal: 16 }}
            >
              <Text>{`Row ${i + 1}`}</Text>
            </View>
          ))}
        </Scroll>
      </View>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
