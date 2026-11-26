// An input the app inserts into (`insertText`).
import { type InputRef, mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

const Button = (props: { id: string; onPress: () => void }) => (
  <View testID={props.id} onPress={props.onPress} style={{ padding: 8, backgroundColor: "#ddd" }}>
    <Text>{props.id}</Text>
  </View>
);

function App() {
  const value = signal("");
  let field: InputRef | undefined;
  return (
    <View style={{ padding: 40, gap: 8 }}>
      <Input testID="field" ref={(r: InputRef) => (field = r)} onChange={(e) => value.set(e.value)} />
      <Text>{`Value: ${value()}`}</Text>
      <Button id="insert" onPress={() => field?.insertText("a\nb")} />
    </View>
  );
}

mount(() => <App />);
