// A multiline input with controls to clear, detach, and reconfigure it.
// Command+Z after those actions must leave the macOS host running.
import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { Menu } from "nsh/desktop";

function App() {
  const value = signal("");
  const shown = signal(true);
  const multiline = signal(true);
  Menu.setApplicationMenu([
    { label: "Fixture", submenu: [{ role: "quit" }] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }] },
  ]);
  const button = (label: string, onPress: () => void) => (
    <View
      role="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{ height: 32, justifyContent: "center" }}
    >
      <Text>{label}</Text>
    </View>
  );
  return (
    <View style={{ flex: 1, padding: 16, gap: 8 }}>
      <Text>{`Text: ${value()}`}</Text>
      {button("clear", () => value.set(""))}
      {button("hide", () => shown.set(false))}
      {button("show", () => shown.set(true))}
      {button("single", () => multiline.set(false))}
      <If when={shown()}>
        <Input
          testID="note"
          multiline={multiline()}
          value={value()}
          onChange={({ value: next }) => value.set(next)}
          style={{ minHeight: 80 }}
        />
      </If>
    </View>
  );
}

mount(App);
