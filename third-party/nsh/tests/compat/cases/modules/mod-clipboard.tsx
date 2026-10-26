// A case of the API's test suite (docs/dev/compatibility.md):
// `nsh` on the headless runtime, where no system clipboard
// answers: writes and reads return promises (reads stay pending
// there). Its script checks each.
import { Text, View, signal } from "nsh";
import { Clipboard } from "nsh";

function App() {
  const calls = signal("not called");
  const failed = signal("none");
  const writes = signal("not called");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Calls: ${calls()}`}</Text>
      <Text>{`Failed: ${failed()}`}</Text>
      <Text>{`Writes: ${writes()}`}</Text>
      <View
        testID="copy"
        onPress={() => {
          const written = [Clipboard.writeText("Copied text"), Clipboard.writeImage(
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          )];
          for (const write of written) write.catch((e) => failed.set(String(e)));
          writes.set(`${written.filter((r) => typeof r.then === "function").length} promises`);
          const reads = [Clipboard.readText(), Clipboard.hasText(), Clipboard.readImage(), Clipboard.hasImage(), Clipboard.readFiles()];
          for (const read of reads) read.catch((e) => failed.set(String(e)));
          calls.set(`${reads.filter((r) => typeof r.then === "function").length} promises`);
        }}
      >
        <Text>Copy</Text>
      </View>
    </View>
  );
}

export default App;
