// A case of the API's test suite (docs/dev/compatibility.md): `Terminal`
// of `nsh/base`: output the app writes (`write`, colors and moves
// interpreted), the text a user types sent back (`onData`), the size in
// cells reported (`onResize`), the title a program sets
// (`onTitleChange`), `reset` and `text` of the ref.
import { Text, View, signal } from "nsh";
import { Terminal, type TerminalRef } from "nsh/base";

function App() {
  let term: TerminalRef | undefined;
  const typed = signal("");
  const title = signal("");
  const size = signal("");
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Terminal
        testID="term"
        ref={(r) => {
          term = r;
          r.write("\x1b]0;Build\x07\x1b[31mred\x1b[0m line\r\nsecond\x1b[1Ad");
        }}
        accessibilityLabel="Shell"
        onData={({ data }) => typed.set(typed() + data)}
        onResize={({ cols, rows }) => size.set(`${cols > 0}x${rows > 0}`)}
        onTitleChange={({ title: t }) => title.set(t)}
        style={{ height: 200 }}
      />
      <Text>{`Typed [${typed()}]`}</Text>
      <Text>{`Title ${title()}`}</Text>
      <Text>{`Size ${size()}`}</Text>
      <View testID="read" onPress={async () => typed.set((await term?.text())?.split("\n")[0] ?? "")} style={{ height: 20 }} />
      <View testID="reset" onPress={() => term?.reset()} style={{ height: 20 }} />
    </View>
  );
}

export default App;
