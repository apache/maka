import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { Input } from "nsh/base";

// A field that does not ask for the focus: nothing has it.
function App() {
  const focus = signal("none");
  return (
    <View style={{ flex: 1 }}>
      <Input
        testID="plain"
        autoFocus={false}
        onFocus={() => focus.set("plain")}
        style={{ height: 40 }}
      />
      <Text>{`Focus: ${focus()}`}</Text>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
