import { mount, signal, Text, View } from "nsh";
import { host } from "nsh";

function App() {
  const result = signal("(none)");
  const ticks = signal<unknown[]>([]);
  host.on("tick", (payload) => ticks.update((t) => [...t, payload]));
  const call = (name: string, options?: { timeout?: number }) => () =>
    host.call(name, { n: 1 }, options).then(
      (value) => result.set(JSON.stringify(value)),
      (e: Error) => result.set(`rejected: ${e.message}`),
    );
  return (
    <View>
      <Text>{`available: ${host.available()}`}</Text>
      <View onPress={call("echo")} accessibilityLabel="echo">
        <Text>echo</Text>
      </View>
      <View onPress={call("fail")} accessibilityLabel="fail">
        <Text>fail</Text>
      </View>
      <View onPress={call("big")} accessibilityLabel="big">
        <Text>big</Text>
      </View>
      <View onPress={call("other")} accessibilityLabel="other">
        <Text>other</Text>
      </View>
      <View onPress={call("slow", { timeout: 1000 })} accessibilityLabel="slow">
        <Text>slow</Text>
      </View>
      <View onPress={call("later")} accessibilityLabel="later">
        <Text>later</Text>
      </View>
      <Text>{`result: ${result()}`}</Text>
      <Text>{`ticks: ${JSON.stringify(ticks())}`}</Text>
    </View>
  );
}

mount(App);
