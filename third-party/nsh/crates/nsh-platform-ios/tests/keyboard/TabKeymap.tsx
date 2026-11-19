import { keymap, mount, signal, Text, View } from "nsh";

/** A focusable pad and an app shortcut on Tab: the shortcut runs before
 * UIKit's focus traversal and keeps the key, as the app's other shortcuts
 * do on a press. */
function App() {
  const tab = signal(0);
  const focus = signal("none");
  keymap.bind("tab", () => tab.update((n) => n + 1));
  return (
    <View style={{ flex: 1, paddingTop: 64, backgroundColor: "#ffffff" }}>
      <Text>{`tab:${tab()}`}</Text>
      <Text>{`focus:${focus()}`}</Text>
      <View
        testID="pad"
        focusable
        onPress={() => {}}
        onFocus={() => focus.set("pad")}
        onBlur={() => focus.set("none")}
        style={{ height: 40, backgroundColor: "#eeeeee", margin: 4 }}
      >
        <Text>pad</Text>
      </View>
    </View>
  );
}

mount(App);
