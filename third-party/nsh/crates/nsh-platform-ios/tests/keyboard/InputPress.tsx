import { Input } from "nsh/base";
import { mount, signal, Text, View } from "nsh";

/** A pressable row around inputs that listen to presses (a field and a
 * text area) and one that does not: what each reports, in order. */
function App() {
  const log = signal<string[]>([]);
  const note = (event: string) => log.set([...log(), event]);
  const input = { width: 240, height: 40, padding: 8, marginTop: 8, backgroundColor: "#eeeeee" };
  return (
    <View style={{ flex: 1, paddingTop: 64, backgroundColor: "#ffffff" }}>
      <Text>{`log:${log().join(",")}`}</Text>
      <View testID="row" onPress={() => note("row")} style={{ padding: 8, backgroundColor: "#dddddd" }}>
        <Input
          testID="field"
          defaultValue="Hello world"
          style={input}
          onFocus={() => note("focus field")}
          onPress={() => note("press field")}
        />
        <Input
          testID="area"
          multiline
          defaultValue="Line 1"
          style={{ ...input, height: 72 }}
          onFocus={() => note("focus area")}
          onPress={() => note("press area")}
        />
        <Input testID="quiet" defaultValue="Quiet" style={input} onFocus={() => note("focus quiet")} />
      </View>
    </View>
  );
}

mount(App);
