// A case of the API's test suite (docs/dev/compatibility.md):
// `nsh/i18n` with this app's `locales/app.yml`: `t` in the language shown,
// its arguments and fallback, `setLocale` and its reset, and the number data
// of the languages nsh.json `locales` lists (German, not French). Its script
// checks each.
import { Text, View, locale } from "nsh";
import { availableLocales, setLocale, t } from "nsh/i18n";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Shown: ${locale()}`}</Text>
      <Text>{`Hello: ${t("hello")}`}</Text>
      <Text>{`Greet: ${t("greet", { name: "Ada" })}`}</Text>
      <Text>{`Missing: ${t("missing")}`}</Text>
      <Text>{`Asked: ${t("hello", { locale: "zh-CN" })}`}</Text>
      <Text>{`Locales: ${availableLocales().join(" ")}`}</Text>
      <Text>{`German: ${(1234.5).toLocaleString("de")}`}</Text>
      <Text>{`French: ${(1234.5).toLocaleString("fr")}`}</Text>
      <View testID="chinese" onPress={() => setLocale("zh-CN")}>
        <Text>Chinese</Text>
      </View>
      <View testID="device" onPress={() => setLocale(null)}>
        <Text>Device</Text>
      </View>
    </View>
  );
}

export default App;
