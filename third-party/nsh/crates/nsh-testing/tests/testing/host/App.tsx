import { mount, signal, Text, View } from "nsh";
import { host } from "nsh";

function App() {
  const result = signal("(none)");
  const ticks = signal<unknown[]>([]);
  const noted = signal<unknown[]>([]);
  host.on("tick", (payload) => ticks.update((t) => [...t, payload]));
  host.on("noted", (payload) => noted.update((n) => [...n, payload]));
  const call = (name: string, options?: { timeout?: number }) => () =>
    host.call(name, { n: 1 }, options).then(
      (value) => result.set(JSON.stringify(value)),
      (e: Error & { code?: string }) => result.set(`rejected: ${e.code ?? "-"} ${e.message}`),
    );
  const post = (name: string, data: unknown) => () => {
    try {
      host.post(name, data);
      result.set("posted");
    } catch (e) {
      result.set(`threw: ${(e as Error & { code?: string }).code ?? "-"}`);
    }
  };
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
      <View onPress={post("note", { n: 2 })} accessibilityLabel="post note">
        <Text>post note</Text>
      </View>
      <View onPress={post("fail", null)} accessibilityLabel="post fail">
        <Text>post fail</Text>
      </View>
      <View onPress={post("other", null)} accessibilityLabel="post other">
        <Text>post other</Text>
      </View>
      <Text>{`result: ${result()}`}</Text>
      <Text>{`noted: ${JSON.stringify(noted())}`}</Text>
      <Text>{`ticks: ${JSON.stringify(ticks())}`}</Text>
    </View>
  );
}

mount(App);
