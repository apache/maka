import { mount, signal, Text, View } from "nsh";
import { TabBar } from "nsh/mobile";
import { Window } from "nsh/desktop";

// A control the app draws in the strip a tab bar leaves at the bottom, and
// the bar over it, out of sight. The bar's own view takes the presses it
// shows; an out-of-sight one must leave the strip to the control.
function App() {
  const pressed = signal("none");
  return (
    <View style={{ flex: 1 }}>
      <Text>{`Pressed: ${pressed()}`}</Text>
      <View
        style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 49 }}
        onPress={() => pressed.set("bottom")}
      >
        <Text>Bottom</Text>
      </View>
      <View
        style={{ position: "absolute", left: 0, right: 0, bottom: 0, pointerEvents: "box-none" }}
      >
        <TabBar
          items={[{ title: "Records" }, { title: "Stats" }]}
          selectedIndex={0}
          hidden
          style={{ height: 49 }}
        />
      </View>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
