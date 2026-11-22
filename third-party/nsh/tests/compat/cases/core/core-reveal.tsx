import { Scroll, Text, View, signal } from "nsh";
import type { ViewRef } from "nsh";

// Each form of the options: the call is there and takes them; an
// unknown alignment throws a `TypeError`.
function App() {
  const rows: ViewRef[] = [];
  const called = signal("none");
  const failure = signal("none");
  const button = (id: string, press: () => void) => (
    <View
      testID={id}
      onPress={() => {
        press();
        called.set(id);
      }}
    >
      <Text>{id}</Text>
    </View>
  );
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>Called: {called()}</Text>
      <Text>Unknown alignment: {failure()}</Text>
      {button("default", () => rows[7].reveal())}
      {button("center", () => rows[3].reveal({ vertical: "center", animated: false }))}
      {button("nearest", () => rows[9].reveal({ vertical: "nearest", horizontal: "nearest" }))}
      {button("end", () => rows[0].reveal({ vertical: "end", horizontal: "start", animated: true }))}
      {button("unknown", () => {
        try {
          // @ts-expect-error: not an alignment
          rows[5].reveal({ vertical: "middle" });
          failure.set("returned");
        } catch (e) {
          failure.set(e instanceof TypeError ? "TypeError" : "other");
        }
      })}
      <Scroll style={{ height: 200 }}>
        {Array.from({ length: 10 }, (_, i) => (
          <View ref={(node) => (rows[i] = node)} style={{ height: 100 }} />
        ))}
      </Scroll>
    </View>
  );
}

export default App;
