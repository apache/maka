import { mount, signal, Text, View } from "nsh";
import { reduceMotion } from "nsh";
import { colorScheme, locale, platform, windowSize } from "nsh";

function App() {
  const result = signal("none");
  const send = (path: string) =>
    fetch(`https://api.test/${path}`, {
      method: "POST",
      headers: { "x-item": "7" },
      body: "hello",
    })
      .then((r) => r.text().then((text) => result.set(`${r.status} ${text}`)))
      .catch((e) => result.set(`failed: ${e.message}`));
  const button = (label: string, path: string) => (
    <View onPress={() => send(path)}>
      <Text>{label}</Text>
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      <Text>{`Scheme: ${colorScheme()}`}</Text>
      <Text>{`Locale: ${locale()}`}</Text>
      <Text>{`Motion: ${reduceMotion() ? "reduced" : "full"}`}</Text>
      <Text>{`OS: ${platform.os}`}</Text>
      <Text>{`Size: ${windowSize().width}x${windowSize().height}`}</Text>
      {button("Echo", "echo")}
      {button("Item", "items/7")}
      {button("Down", "down")}
      {button("Slow", "slow")}
      {button("Broken", "broken")}
      <Text>{`Result: ${result()}`}</Text>
    </View>
  );
}

mount(App);
