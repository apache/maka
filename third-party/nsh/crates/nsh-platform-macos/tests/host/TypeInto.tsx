// `captureKeys="text"` on the macOS host: a selectable transcript holds the
// keyboard, and typing moves into the message `Input` below it, dead keys
// and input methods included. `TypeInto.test.tsx` runs it.
import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { Window } from "nsh/desktop";

function App() {
  const value = signal("");
  const keys = signal("");
  return (
    <View
      captureKeys="text"
      style={{ flex: 1, padding: 16, gap: 8, backgroundColor: "white" }}
      onKeyDown={(e) => keys.set(`${e.key}${e.defaultPrevented ? " moved" : ""}`)}
    >
      <View selectable focusable style={{ width: 300 }}>
        <Text>Select a few words of this sentence</Text>
      </View>
      <Input
        value={value()}
        accessibilityLabel="Message"
        style={{ width: 300 }}
        onChange={(e) => value.set(e.value)}
      />
      <Text>{`Value: ${value()}`}</Text>
      <Text>{`Key: ${keys()}`}</Text>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
