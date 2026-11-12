import { mount, View } from "nsh";
import { Input } from "nsh/base";

// A field and a text area that take ten UTF-16 units each.
function App() {
  return (
    <View style={{ flex: 1, padding: 16, gap: 8 }}>
      <Input testID="field" maxLength={10} style={{ height: 36 }} />
      <Input testID="area" multiline maxLength={10} style={{ height: 72 }} />
    </View>
  );
}

mount(App);
