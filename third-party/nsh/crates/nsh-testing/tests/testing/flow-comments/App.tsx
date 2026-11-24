import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";

// `<If>` and `<Each>` function children with JSX comments beside them: the
// accessors they are handed are read only when a button is pressed.
function App() {
  const user = signal<{ name: string } | null>({ name: "ada" });
  const items = signal([{ name: "one" }]);
  const said = signal("nothing");
  return (
    <View style={{ flex: 1 }}>
      <If when={user()}>
        {/* the user's name, before */}
        {(u) => <View onPress={() => said.set(`before ${u().name}`)}><Text>Before</Text></View>}
      </If>
      <If when={user()}>
        {(u) => <View onPress={() => said.set(`after ${u().name}`)}><Text>After</Text></View>}
        {/* the user's name, after */}
      </If>
      <Each of={items()}>
        {/* each item */}
        {(item) => <View onPress={() => said.set(`item ${item().name}`)}><Text>Item</Text></View>}
        {/* done */}
      </Each>
      <Text>{`Said: ${said()}`}</Text>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
