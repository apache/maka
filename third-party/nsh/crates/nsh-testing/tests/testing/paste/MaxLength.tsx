import { mount, View } from "nsh";
import { Input } from "nsh/base";

// A field and a text area that take ten characters each, and a text area
// that takes 1500.
function App() {
  return (
    <View style={{ flex: 1, padding: 16, gap: 8 }}>
      <Input testID="field" maxLength={10} style={{ height: 36 }} />
      <Input testID="area" multiline maxLength={10} style={{ height: 72 }} />
      <Input testID="long" multiline maxLength={1500} style={{ height: 72 }} />
    </View>
  );
}

mount(App);
