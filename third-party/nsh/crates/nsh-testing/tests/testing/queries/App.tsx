// Views to find and act on: rows with the same buttons, a disabled
// button, a long press, an input to clear, a note that goes away.
import { mount, signal, Text, View } from "nsh";
import { Button, Input } from "nsh/base";

function App() {
  const items = signal(["Milk", "Eggs"]);
  const log = signal("none");
  const draft = signal("Old text");
  const loading = signal(true);
  setTimeout(() => loading.set(false), 300);
  return (
    <View style={{ flex: 1 }}>
      <If when={loading()}>
        <Text>Loading…</Text>
      </If>
      <Text>{`Log: ${log()}`}</Text>
      <Each of={items()}>
        {(item) => (
          <View testID={`row-${item()}`}>
            <Text>{item()}</Text>
            <Button onPress={() => items.set(items().filter((i) => i !== item()))}>
              <Text>Delete</Text>
            </Button>
          </View>
        )}
      </Each>
      <Button disabled onPress={() => log.set("paid")}>
        <Text>Pay</Text>
      </Button>
      <View onPress={() => log.set("tap")} onLongPress={() => log.set("held")} delayLongPress={200}>
        <Text>Hold me</Text>
      </View>
      <Input testID="draft" value={draft()} onChange={(t) => draft.set(t)} />
      <Text>{`Draft: ${draft()}`}</Text>
    </View>
  );
}

mount(App);
