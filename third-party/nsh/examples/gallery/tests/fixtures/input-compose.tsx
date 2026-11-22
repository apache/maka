import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

// A composer that grows with its text: its height, what an input method
// composes in it and the value the app has, shown below.
function App() {
  const text = signal("");
  const height = signal(0);
  const composing = signal("");
  return (
    <View class="flex-1 bg-background" style={{ padding: 12 }}>
      <View style={{ width: 240 }} onLayout={(e) => height.set(Math.round(e.bounds.size.height))}>
        <Input
          testID="composer"
          class="text-foreground border-border"
          multiline
          value={text()}
          onChange={({ value }) => text.set(value)}
          onCompositionChange={(e) => composing.set(e.text)}
          style={{ paddingHorizontal: 8, paddingVertical: 10, fontSize: 15, lineHeight: 22, borderWidth: 1, borderRadius: 12 }}
        />
      </View>
      <Text class="text-foreground">{`Height ${height()}`}</Text>
      <Text class="text-foreground">{`Composing [${composing()}]`}</Text>
      <Text class="text-foreground">{`Value [${text()}]`}</Text>
    </View>
  );
}

mount(App);
