import { mount, signal, Text, View } from "nsh";
import { reduceMotion } from "nsh";
import { colorScheme, lifecycle, locale, localeSettings, platform, windowSize } from "nsh";

// Whether `Intl`'s local time is in the zone it names, read again when the
// device's zone changes (a test's, which moves no local time): formatting in
// that zone writes what local time does, in 1970, a summer and a winter.
const intlAgrees = () => {
  localeSettings().timeZone;
  const options = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
  const local = new Intl.DateTimeFormat("en-US", options);
  const named = new Intl.DateTimeFormat("en-US", { ...options, timeZone: local.resolvedOptions().timeZone });
  return [0, 1720000000000, 1736000000000].every((t) => named.format(t) === local.format(t));
};

// The regional preferences, as the test reads them.
const regional = () => {
  const { hourCycle, firstDayOfWeek, measurementSystem, temperatureUnit } = localeSettings();
  return `Regional: ${hourCycle} ${firstDayOfWeek} ${measurementSystem} ${temperatureUnit}`;
};

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
      <Text>{`App: ${lifecycle()}`}</Text>
      <Text>{`Zone: ${localeSettings().timeZone}`}</Text>
      <Text>{`Intl agrees: ${intlAgrees()}`}</Text>
      <Text>{`Languages: ${localeSettings().languages.join(",")}`}</Text>
      <Text>{regional()}</Text>
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
