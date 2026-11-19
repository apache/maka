import { Input } from "nsh/base";
import { mount, signal, Text, View } from "nsh";

/** A `focusable` row that takes no presses, around a pressable view (a
 * stop of its own), a pressable that is no stop and a native input: the
 * tap that focuses the row leaves the touches inside it to them. */
function App() {
  const focus = signal("none");
  const pressed = signal("none");
  const text = signal("");
  const button = { width: 64, height: 36, backgroundColor: "#dddddd", marginLeft: 4 };
  return (
    <View style={{ flex: 1, paddingTop: 64, backgroundColor: "#ffffff" }}>
      <Text>{`focus:${focus()}`}</Text>
      <Text>{`pressed:${pressed()}`}</Text>
      <Text>{`input:${text()}`}</Text>
      <View
        testID="row"
        focusable
        onFocus={() => focus.set("row")}
        onBlur={() => focus.set("none")}
        style={{ flexDirection: "row", alignItems: "center", height: 44, margin: 4, backgroundColor: "#eeeeee" }}
      >
        <Text style={{ flex: 1 }}>row</Text>
        <View
          testID="more"
          onPress={() => pressed.set("more")}
          onFocus={() => focus.set("more")}
          onBlur={() => focus.set("none")}
          style={button}
        >
          <Text>more</Text>
        </View>
        <View testID="plain" focusable={false} onPress={() => pressed.set("plain")} style={button}>
          <Text>plain</Text>
        </View>
        <Input
          testID="field"
          style={{ width: 96, height: 36, marginLeft: 4 }}
          onFocus={() => focus.set("field")}
          onBlur={() => focus.set("none")}
          onChange={({ value }) => text.set(value)}
        />
      </View>
    </View>
  );
}

mount(App);
