// A case of the API's test suite (docs/dev/compatibility.md): what an input
// reports as the user edits it: focus and blur, each key, the text after
// each edit and the selection; the size of a multiline input's text as it
// wraps onto more lines; a controlled input whose app changes what was
// typed, which typing then continues from; what return submits; a masked,
// a read-only input and one with a selection set by the app, and the colors
// of placeholders and selections; where the caret is, in the input and in
// the root view (`onCaretMove`); what was pasted (`onPaste`) into an input
// that inserts nothing itself (`pasteBehavior`). Each handler shows what it gets as
// text. Its
// script checks each.
import { Input, Text, View, signal } from "nsh";

function App() {
  const focus = signal("none");
  const keys = signal<string[]>([]);
  const text = signal("");
  const selection = signal("none");
  const caret = signal("none");
  const pasted = signal("none");
  const size = signal("none");
  let first = -1;
  const upper = signal("");
  const submitted = signal("nothing");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Input
        testID="field"
        style={{ width: 300, height: 40 }}
        onFocus={() => focus.set("focused")}
        onBlur={() => focus.set(focus() + " blurred")}
        onKeyPress={(e) => keys.update((k) => [...k, e.key])}
        onChange={(t) => text.set(t)}
        onSubmit={(e) => submitted.set(e.text)}
        onSelectionChange={(e) => selection.set(`${e.start}-${e.end}`)}
        onCaretMove={(e) => {
          const { origin, size } = e.pageBounds;
          caret.set(
            `${Object.keys(e).sort().join(",")} ` +
              `${typeof e.bounds.size.height === "number" ? "bounds" : "no bounds"} ` +
              `page ${origin.x - e.bounds.origin.x},${origin.y - e.bounds.origin.y} ${size.width}x${size.height}`,
          );
        }}
      />
      <Text>Focus: {focus()}</Text>
      <Text>Keys: {keys().join(" ")}</Text>
      <Text>Text: {text()}</Text>
      <Text>Selection: {selection()}</Text>
      <Text>Caret: {caret()}</Text>
      <Input
        testID="paste"
        pasteBehavior="report"
        style={{ width: 300, height: 40 }}
        onPaste={(e) => pasted.set(`${e.text} files ${e.files.length} uris ${e.uris.length}`)}
      />
      <Text>Pasted: {pasted()}</Text>
      <Text>Submitted: {submitted()}</Text>
      <Input
        testID="notes"
        multiline
        style={{ width: 100 }}
        onContentSizeChange={(e) => {
          if (first < 0) first = e.height;
          const typed = typeof e.width === "number" && typeof e.height === "number";
          size.set(
            `${Object.keys(e).sort().join(",")} ${typed ? "numbers" : "not numbers"} ` +
              `${e.height > first ? "taller" : "as tall"}`,
          );
        }}
      />
      <Text>Size: {size()}</Text>
      <Input
        testID="upper"
        value={upper()}
        style={{ width: 300, height: 40 }}
        onChange={(t) => upper.set(t.toUpperCase())}
      />
      <Text>Upper: {upper()}</Text>
      <Input
        testID="secret"
        masked
        placeholder="Password"
        selectedRange={{ start: 0, end: 2 }}
        style={{ width: 300, height: 40, placeholderColor: "#888888", selectionColor: "#ff6600" }}
      />
      <Input testID="fixed" readonly defaultValue="Fixed" style={{ width: 300, height: 40 }} />
      <Text testID="pick" selectable style={{ selectionColor: "#00aa00" }}>
        Selectable
      </Text>
    </View>
  );
}

export default App;
