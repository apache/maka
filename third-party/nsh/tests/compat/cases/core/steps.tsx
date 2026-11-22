// A case of the API's test suite (docs/dev/compatibility.md): what the
// `prop`, `style`, `listens` and `log` steps of the scripts read, on iOS
// (the scripts' default platform): paint styles, the transform CSS's
// `translate`, `rotate`, `scale` and `transform` compose (in CSS's order,
// whatever the order of the keys; `transform` a string or a list), the text
// keys of a nested span, a host prop, an `ios={{…}}` prop, an event the
// platform reports and a console line.
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
          transform: "rotate(45deg) scale(2)",
        }}
      />
      <View testID="plain" style={{ height: 40 }} />
      <View testID="moved" style={{ height: 40, translate: "10px 20px", rotate: 30, scale: 1.5 }} />
      <View
        testID="composed"
        style={{
          width: 40,
          height: 40,
          transform: "translateX(4px) rotate(10deg)",
          scale: [2, 3],
          rotate: "x 40deg",
          translate: [5, "50%"],
        }}
      />
      <View
        testID="stepped"
        style={{ height: 40, transform: [{ perspective: 800 }, { rotateY: "30deg" }, { translateX: 4 }] }}
      />
      <Text testID="label" style={{ color: "red" }}>
        Plain <Text style={{ fontWeight: "bold" }}>bold</Text>
      </Text>
      <Input testID="field" placeholder="Name" ios={{ keyboardAppearance: "dark" }} />
    </View>
  );
}

export default App;
