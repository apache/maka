// A case of the API's test suite (docs/dev/compatibility.md): `setTheme`
// makes another theme the app's while it runs, in place of nsh.json's
// `"theme"` (which sets `up` and `radius-card` here) and over shadcn's
// `neutral`, as nsh.json's is. `token()` reads it at once and classes naming
// its tokens follow, in each appearance; a theme with a value NSH cannot
// read throws a `TypeError` and the theme in force stays; `null` gives
// nsh.json's back. Its script checks each.
import { Text, View, cleanup, setColorScheme, setTheme, signal, token } from "nsh";

const brand = { cssVars: { light: { up: "#2563eb" }, dark: { up: "#93c5fd" } } };

function BaseSetTheme() {
  const result = signal("none");
  // The next cases see nsh.json's theme in the system's appearance.
  cleanup(() => {
    setTheme(null);
    setColorScheme("system");
  });
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`theme up ${token("up")}`}</Text>
      <Text>{`theme primary ${token("primary")}`}</Text>
      <Text>{`theme radius-card ${token("radius-card")}`}</Text>
      <Text>{`theme result ${result()}`}</Text>
      <View testID="themed" class="h-4 bg-up" />
      <View
        testID="set"
        onPress={() => {
          setTheme(brand);
          result.set(`set ${token("up")}`);
        }}
      >
        <Text>Set a theme</Text>
      </View>
      <View testID="dark" onPress={() => setColorScheme("dark")}>
        <Text>Go dark</Text>
      </View>
      <View testID="system" onPress={() => setColorScheme("system")}>
        <Text>Follow the system</Text>
      </View>
      <View
        testID="bad"
        onPress={() => {
          try {
            setTheme({ cssVars: { light: { up: "#16a34a" }, dark: { up: "#zz" } } });
            result.set("taken");
          } catch (e) {
            result.set(`refused ${(e as Error).name}`);
          }
        }}
      >
        <Text>Set a theme with a bad value</Text>
      </View>
      <View
        testID="built"
        onPress={() => {
          setTheme(null);
          result.set("built");
        }}
      >
        <Text>The theme it was built with</Text>
      </View>
    </View>
  );
}

export default BaseSetTheme;
