import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

/** An input that reports pastes and lists the files they carry. */
function App() {
  const pasted = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 64, paddingHorizontal: 16, gap: 8, backgroundColor: "#ffffff" }}>
      <Input
        testID="field"
        placeholder="Paste here"
        pasteBehavior="report"
        onPaste={(e) =>
          pasted.set(e.files.length ? e.files.map((f) => `${f.name} ${f.type} ${f.size}`).join(", ") : "no files")
        }
        style={{ height: 40 }}
      />
      <Text>{`pasted:${pasted()}`}</Text>
    </View>
  );
}

mount(App);
