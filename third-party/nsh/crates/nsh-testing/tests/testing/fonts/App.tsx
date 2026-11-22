import { mount, registerFont, signal, Text, View } from "nsh";

function App() {
  const family = signal("none");
  const register = (source: string | Uint8Array) =>
    registerFont(source).then(
      (font) => family.set(font.family),
      (e) => family.set(`refused (${e instanceof Error})`),
    );
  const button = (id: string, source: string | Uint8Array) => (
    <View testID={id} onPress={() => register(source)}>
      <Text>{id}</Text>
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ fontFamily: family() }}>{`Family: ${family()}`}</Text>
      {button("url", "asset:/Pacifico-Regular.woff2")}
      {button("bytes", new Uint8Array([0, 1, 0, 0, 7]))}
      {button("missing", "asset:/Missing.woff2")}
    </View>
  );
}

mount(App);
