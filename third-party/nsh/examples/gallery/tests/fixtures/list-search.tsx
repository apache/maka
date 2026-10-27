import { List, mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

const people = ["Alice", "Bob", "Carol", "Dave", "Erin", "Frank", "Grace", "Heidi", "Ivan", "Judy", "Mallory", "Niaj"];

function App() {
  const query = signal("");
  const picked = signal("none");
  const shown = () => people.filter((p) => p.toLowerCase().includes(query().toLowerCase()));
  return (
    <View style={{ flex: 1, paddingTop: 80 }}>
      <Input testID="search" value={query()} onChange={(t) => query.set(t)} style={{ height: 40 }} />
      <Text>{`picked: ${picked()}`}</Text>
      <List each={shown()} estimatedItemSize={50} keyboardShouldPersistTaps="handled" style={{ flex: 1 }}>
        {(name) => (
          <View role="button" onPress={() => picked.set(name())} style={{ height: 50 }}>
            <Text>{name()}</Text>
          </View>
        )}
      </List>
    </View>
  );
}

mount(App);
