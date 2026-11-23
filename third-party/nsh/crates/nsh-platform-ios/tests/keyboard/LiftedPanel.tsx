import { Input } from "nsh/base";
import { mount, Scroll, signal, Text, View } from "nsh";

/** A panel at the bottom of the page that the app lifts above the software
 * keyboard (the page is padded by the keyboard's height), with a short
 * scroll view of rows and an input after them, as a chat's question panel
 * with an "other answer" field is. */
function App() {
  const offset = signal(0);
  const typed = signal("");
  return (
    <View style={{ flex: 1, paddingBottom: "env(keyboard-inset-height)", backgroundColor: "#ffffff" }}>
      <View style={{ flex: 1, paddingTop: 64 }}>
        <Text>{`offset:${offset()}`}</Text>
        <Text>{`value:${typed()}`}</Text>
      </View>
      <Scroll testID="panel" style={{ flexGrow: 0, maxHeight: 320 }} onScroll={(e) => offset.set(Math.round(e.offset.y))}>
        {["One", "Two", "Three"].map((row) => (
          <View key={row} style={{ height: 64, justifyContent: "center", paddingHorizontal: 16 }}>
            <Text>{`row:${row}`}</Text>
          </View>
        ))}
        <Input
          testID="other"
          placeholder="Other answer"
          value={typed()}
          onChange={({ value }) => typed.set(value)}
          style={{ height: 48, marginHorizontal: 16 }}
        />
      </Scroll>
    </View>
  );
}

mount(App);
