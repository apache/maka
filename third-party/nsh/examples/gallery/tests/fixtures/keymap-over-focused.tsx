import { effect, keymap, mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { Editor, type EditorRef } from "nsh/base";

// A query editor whose app runs the query with mod+enter while the editor
// has the focus (`keymap.bind`'s `overFocused`), and also binds mod+enter
// plainly, for while it does not; for `keymap-over-focused.test.tsx`.

function App() {
  const focused = signal(false);
  const over = signal(true);
  const runs = signal(0);
  const plain = signal(0);
  const text = signal("select 1");
  let editor!: EditorRef;
  keymap.bind("mod+enter", () => plain.set(plain() + 1));
  effect(() => {
    if (focused() && over()) {
      keymap.bind("mod+enter", () => runs.set(runs() + 1), { when: "always", overFocused: true });
    }
  });
  const button = (id: string, onPress: () => void) => (
    <View testID={id} style={{ width: 8, height: 8 }} onPress={onPress} />
  );
  return (
    <View style={{ flex: 1, paddingTop: 20 }}>
      <View style={{ flexDirection: "row" }}>
        {button("no-over", () => over.set(false))}
        {button("blur", () => editor.blur())}
      </View>
      <Text>{() => `runs ${runs()} plain ${plain()} lines ${text().split("\n").length}`}</Text>
      <View style={{ width: 400, height: 200 }}>
        <Editor
          ref={editor}
          testID="sql"
          defaultValue="select 1"
          onFocus={() => focused.set(true)}
          onBlur={() => focused.set(false)}
          onChange={({ value }) => text.set(value)}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
