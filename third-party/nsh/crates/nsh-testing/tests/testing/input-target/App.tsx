import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { Editor, Input } from "nsh/base";

function App() {
  const doc = signal("Hallo\nworld");
  const under = signal("U");
  const over = signal("O");
  return <View class="p-4 gap-2">
    <Editor testID="ed" value={doc()} onChange={e => doc.set(e.value)} class="h-40" />
    <View onPress={() => doc.set("external\nupdate")}><Text>Update document</Text></View>
    <View class="h-12">
      <View class="absolute inset-0 bg-gray-300"><Input testID="under" value={under()} onChange={e => under.set(e.value)} class="h-8" /></View>
      <View class="absolute inset-0 bg-red-300"><Input testID="over" value={over()} onChange={e => over.set(e.value)} class="h-8" /></View>
    </View>
    <Text>{`under=${under()} over=${over()}`}</Text>
  </View>;
}
mount(() => <Window id="main">{App}</Window>);
