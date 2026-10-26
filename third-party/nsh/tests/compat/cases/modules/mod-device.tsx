// A case of the API's test suite (docs/dev/compatibility.md): `nsh/device`
// as the headless runtime reports it (iOS, a phone, 1 pixel per point, the
// script's viewport), the color scheme an app sets and `openUrl`: a promise
// for a URL it opens (the headless runtime answers none), a `TypeError` for
// one it never opens. Its script checks each.
import { Text, View, signal } from "nsh";
import { colorScheme, fontScale, openUrl, pixelRatio, platform, setColorScheme, windowSize } from "nsh/device";

function App() {
  const opened = signal("not opened");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`OS: ${platform.os}`}</Text>
      <Text>{`Idiom: ${platform.idiom}`}</Text>
      <Text>{`Catalyst: ${platform.catalyst}`}</Text>
      <Text>{`Version: ${platform.version}`}</Text>
      <Text>{`Select: ${platform.select({ ios: "ios", android: "android", default: "other" })}`}</Text>
      <Text>{`Select mobile: ${platform.select({ mobile: "mobile", desktop: "desktop" })}`}</Text>
      <Text>{`Ratio: ${pixelRatio()}`}</Text>
      <Text>{`Font scale: ${fontScale()}`}</Text>
      <Text>{`Window: ${windowSize().width}x${windowSize().height}`}</Text>
      <Text>{`Scheme: ${colorScheme()}`}</Text>
      <View testID="dark" onPress={() => setColorScheme("dark")}>
        <Text>Go dark</Text>
      </View>
      <View testID="system" onPress={() => setColorScheme("system")}>
        <Text>Follow the system</Text>
      </View>
      <Text>{`Open: ${opened()}`}</Text>
      <View
        testID="open"
        onPress={() => {
          const pending = openUrl("https://example.com/docs?page=1");
          let refused = "none";
          try {
            openUrl("javascript:alert(1)");
          } catch (e) {
            refused = (e as Error).name;
          }
          opened.set(`${typeof pending.then}, refused ${refused}`);
        }}
      >
        <Text>Open a link</Text>
      </View>
    </View>
  );
}

export default App;
