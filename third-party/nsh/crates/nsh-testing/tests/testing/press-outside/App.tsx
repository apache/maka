import { mount, Overlay, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";

function App() {
  const outside = signal("none");
  return (
    <View style={{ flex: 1 }}>
      <View testID="button" style={{ position: "absolute", left: 256, top: 16, width: 52, height: 28 }} onPress={() => {}}>
        <Text>Button</Text>
      </View>
      <Overlay
        onPressOutside={(e) => outside.set(`${e.pagePosition.x} ${e.pagePosition.y}`)}
        style={{ width: 0, height: 0 }}
      />
      <Text style={{ position: "absolute", left: 10, top: 100 }}>{`Outside: ${outside()}`}</Text>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
