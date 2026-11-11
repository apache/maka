// A case of the API's test suite (docs/dev/compatibility.md): `nsh/device`
// as the headless runtime reports it (iOS, a phone, 1 pixel per point, the
// script's viewport; mobile, so `platform.desktop` is false; the app in use; the locale settings of en-US in UTC; `Intl` formats local time in the zone it names), the color scheme an app sets and
// `openUrl`: a promise for a URL it opens (the headless runtime answers none), one rejected with a `TypeError` for
// a URL it never opens (it never throws). Its script checks each.
import { Text, View, signal } from "nsh";
import { colorScheme, fontScale, lifecycle, localeSettings, openUrl, pixelRatio, platform, setColorScheme, windowSize } from "nsh";

// Whether `Intl`'s local time is in the zone it names: formatting in that zone
// writes what local time does (in 1970, a summer and a winter), on a machine in
// any zone.
function intlLocalTime() {
  const options = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
  const local = new Intl.DateTimeFormat("en-US", options);
  const named = new Intl.DateTimeFormat("en-US", { ...options, timeZone: local.resolvedOptions().timeZone });
  return [0, 1720000000000, 1736000000000].every((t) => named.format(t) === local.format(t)) ? "its zone" : "another zone";
}

function App() {
  const opened = signal("not opened");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Platform: ${platform.name}`}</Text>
      <Text>{`OS: ${platform.os}`}</Text>
      <Text>{`Idiom: ${platform.idiom}`}</Text>
      <Text>{`Desktop: ${platform.desktop}`}</Text>
      <Text>{`Catalyst: ${platform.catalyst}`}</Text>
      <Text>{`Version: ${platform.version}`}</Text>
      <Text>{`Select: ${platform.select({ ios: "ios", android: "android", default: "other" })}`}</Text>
      <Text>{`Select mobile: ${platform.select({ mobile: "mobile", desktop: "desktop" })}`}</Text>
      <Text>{`Ratio: ${pixelRatio()}`}</Text>
      <Text>{`Font scale: ${fontScale()}`}</Text>
      <Text>{`Window: ${windowSize().width}x${windowSize().height}`}</Text>
      <Text>{`Scheme: ${colorScheme()}`}</Text>
      <Text>{`Lifecycle: ${lifecycle()}`}</Text>
      <Text>{`Time zone: ${localeSettings().timeZone}`}</Text>
      <Text>{`Intl local time: ${intlLocalTime()}`}</Text>
      <Text>{`Languages: ${localeSettings().languages.join(", ")}`}</Text>
      <Text>{`Regional: ${localeSettings().hourCycle}, week from ${localeSettings().firstDayOfWeek}, ${localeSettings().measurementSystem}, ${localeSettings().temperatureUnit}`}</Text>
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
          opened.set(`${typeof pending.then}, refused pending`);
          try {
            openUrl("javascript:alert(1)").catch((e: Error) => opened.set(`${typeof pending.then}, refused ${e.name}`));
          } catch (e) {
            opened.set(`${typeof pending.then}, threw ${(e as Error).name}`);
          }
        }}
      >
        <Text>Open a link</Text>
      </View>
    </View>
  );
}

export default App;
