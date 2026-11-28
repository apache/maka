import { mount, platform, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { Input } from "nsh/base";

// A chat's composer at the bottom of the window: a multiline input in the
// font's own line height that grows upwards with its text, the messages
// above it giving way. Where its caret is (`onCaretMove`, in the input) and
// how tall the input is show above it.
function App() {
  const text = signal("");
  const height = signal(0);
  const caret = signal("none");
  return (
    <View class="flex-1 bg-background" style={{ padding: 12 }}>
      <View style={{ flex: 1 }}>
        <Text class="text-foreground">{`Platform: ${platform.os}`}</Text>
        <Text class="text-foreground">{`Height ${height()}`}</Text>
        <Text class="text-foreground">{`Caret ${caret()}`}</Text>
      </View>
      <View class="border-border" style={{ width: 300, borderWidth: 1, borderRadius: 12, padding: 8 }}>
        <Input
          testID="composer"
          class="text-foreground"
          multiline
          value={text()}
          onChange={({ value }) => text.set(value)}
          onLayout={(e) => height.set(Math.round(e.bounds.size.height))}
          onCaretMove={(e) =>
            caret.set(
              [e.bounds.origin.x, e.bounds.origin.y, e.bounds.size.height].map((v) => Math.round(v)).join(" "),
            )
          }
          style={{ fontSize: 15, maxHeight: 200 }}
        />
      </View>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
