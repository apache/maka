import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

// A one-line multiline input that grows with its text up to 120 points,
// then scrolls: where its caret is (`onCaretMove`, the input's scrolling
// applied) and how tall the input is, shown below.
function App() {
  const text = signal("");
  const height = signal(0);
  const caret = signal("none");
  return (
    <View class="flex-1 bg-background" style={{ padding: 12 }}>
      <View class="border-border" style={{ width: 240, borderWidth: 1, borderRadius: 12, padding: 8 }}>
        <Input
          testID="composer"
          class="text-foreground"
          multiline
          value={text()}
          onChange={({ value }) => text.set(value)}
          onLayout={(e) => height.set(Math.round(e.bounds.size.height))}
          onCaretMove={(e) => caret.set(`${Math.round(e.bounds.origin.y)} ${Math.round(e.bounds.size.height)}`)}
          style={{ fontSize: 15, lineHeight: 22, maxHeight: 120 }}
        />
      </View>
      <Text class="text-foreground">{`Height ${height()}`}</Text>
      <Text class="text-foreground">{`Caret ${caret()}`}</Text>
    </View>
  );
}

mount(App);
