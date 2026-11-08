import { mount, Scroll, signal, Text, View } from "nsh";

function App() {
  const focused = signal("none"), pressed = signal("none");
  const rows = Array.from({ length: 20 }, (_, index) => String(index));
  // The status names rows by number: it is text on screen too, so it must not match the test's query.
  return <View style={{ flex: 1 }}>
    <Text style={{ height: 16 }}>focus:{focused()} pressed:{pressed()}</Text>
    <Scroll style={{ width: 160, height: 64 }}>
      {rows.map((row) => <View style={{ height: 16, flexShrink: 0 }}
        onFocus={() => focused.set(row)} onPress={() => pressed.set(row)}><Text>{`row${row}`}</Text></View>)}
    </Scroll>
    <Text style={{ position: "absolute", top: 144 }}>footer</Text>
  </View>;
}
mount(App);
