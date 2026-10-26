import { mount, signal, Text, View } from "nsh";
import { Badge, Counter, Format } from "__SPECIFIER__";

// Its count lives in Rust (`src/lib.rs`).
const counter = new Counter();

function App() {
  const count = signal(counter.count);
  return (
    <View
      style={{
        flex: 1,
        paddingTop: "env(safe-area-inset-top)",
        paddingRight: "env(safe-area-inset-right)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        alignItems: "center", justifyContent: "center", gap: 16,
      }}
    >
      <Text style={{ fontSize: 22 }}>{count() ? `Pressed ${Format.times(count())}` : "Not pressed yet"}</Text>
      <Badge label="Press me" onPress={() => count.set(counter.increment())} />
    </View>
  );
}

mount(App);
