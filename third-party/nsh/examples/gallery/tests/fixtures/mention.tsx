// An @-mention candidate list driven by the keyboard while the message
// input keeps the focus: `up`, `down` and `enter` bound with
// `{ when: "always" }` take the keys before the input does.
import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { keymap } from "nsh";

const people = ["Alice", "Bob", "Carol"];

function Candidates(props: { onPick: (name: string) => void }) {
  const at = signal(0);
  keymap.bind("up", () => at.set((at() + people.length - 1) % people.length), {
    when: "always",
    repeat: true,
  });
  keymap.bind("down", () => at.set((at() + 1) % people.length), { when: "always", repeat: true });
  keymap.bind("enter", () => props.onPick(people[at()]), { when: "always" });
  return <Text>{`candidate: ${people[at()]}`}</Text>;
}

function App() {
  const text = signal("");
  return (
    <View style={{ flex: 1, paddingTop: 80 }}>
      <Input
        testID="msg"
        autoCapitalize="none"
        value={text()}
        onChange={(t) => text.set(t)}
        style={{ height: 40 }}
      />
      <Text>{`text: ${text()}`}</Text>
      <If when={text().endsWith("@")}>
        <Candidates onPick={(name) => text.set(text() + name + " ")} />
      </If>
    </View>
  );
}

mount(App);
