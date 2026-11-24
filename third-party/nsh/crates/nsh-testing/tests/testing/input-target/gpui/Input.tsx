import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

function App() {
  const value = signal("");
  const submits = signal(0);
  const resumed = signal(false);
  return <View>
    <Input testID="field" class="h-10" value={value()} onChange={e => {
      value.set(e.value);
      if (e.value === "!") {
        // Hold the first edit past the GPUI agent's 10-second acknowledgment wait.
        const start = Date.now();
        while (Date.now() - start < 11500) {}
        resumed.set(true);
      }
    }} onSubmit={() => submits.set(submits() + 1)} />
    <Text>{resumed() ? "Handler finished" : "Ready"}</Text>
    <Text>{`Submits: ${submits()}`}</Text>
  </View>;
}

mount(App);
