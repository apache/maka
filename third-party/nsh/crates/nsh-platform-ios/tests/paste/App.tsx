import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

/** Inputs that report pastes and list the files they carry; the second
 * reads files of at most 50 bytes. */
function App() {
  const pasted = signal("none");
  const limited = signal("none");
  const list = (files: { name: string; type: string; size: number }[]) =>
    files.length ? files.map((f) => `${f.name} ${f.type} ${f.size}`).join(", ") : "no files";
  return (
    <View style={{ flex: 1, paddingTop: 64, paddingHorizontal: 16, gap: 8, backgroundColor: "#ffffff" }}>
      <Input
        testID="field"
        placeholder="Paste here"
        pasteBehavior="report"
        onPaste={(e) => pasted.set(list(e.files))}
        style={{ height: 40 }}
      />
      <Text>{`pasted:${pasted()}`}</Text>
      <Input
        testID="limited"
        placeholder="Paste a small file here"
        pasteBehavior="report"
        pasteMaxSize={50}
        onPaste={(e) => limited.set(`read ${list(e.files)} unread ${list(e.tooLarge)}`)}
        style={{ height: 40 }}
      />
      <Text>{`limited:${limited()}`}</Text>
    </View>
  );
}

mount(App);
