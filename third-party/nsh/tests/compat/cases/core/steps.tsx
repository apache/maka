// A case of the API's test suite (docs/dev/compatibility.md): what the
// `prop`, `style`, `listens` and `log` steps of the scripts read, on iOS
// (the scripts' default platform): paint styles, the text keys of a nested
// span, a host prop, an `ios={{…}}` prop, an event the platform reports and
// a console line.
import { Text, View } from "nsh";
import { Input } from "nsh/base";

function App() {
  console.log("steps: mounted");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View
        testID="card"
        role="button"
        onLongPress={() => console.log("steps: long press")}
        style={{
          height: 40,
          backgroundColor: "#3366ff",
          borderRadius: 12,
          opacity: 0.5,
          transform: [{ rotate: "45deg" }, { scale: 2 }],
        }}
      />
      <View testID="plain" style={{ height: 40 }} />
      <Text testID="label" style={{ color: "red" }}>
        Plain <Text style={{ fontWeight: "bold" }}>bold</Text>
      </Text>
      <Input testID="field" placeholder="Name" ios={{ keyboardAppearance: "dark" }} />
    </View>
  );
}

export default App;
