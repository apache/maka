import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

// A composer card around a multiline input that grows with its text up to
// 120 points, then scrolls: the input's and the card's heights shown below.
function App() {
  const text = signal("");
  const input = signal(0);
  const card = signal(0);
  return (
    <View class="flex-1 bg-background" style={{ padding: 12 }}>
      <View class="border-border" style={{ width: 240, borderWidth: 1, borderRadius: 12, padding: 8 }} onLayout={(e) => card.set(Math.round(e.bounds.size.height))}>
        <Input
          testID="composer"
          class="text-foreground"
          multiline
          value={text()}
          onChange={({ value }) => text.set(value)}
          onLayout={(e) => input.set(Math.round(e.bounds.size.height))}
          style={{ fontSize: 15, lineHeight: 22, maxHeight: 120 }}
        />
      </View>
      <Text class="text-foreground">{`Input ${input()}`}</Text>
      <Text class="text-foreground">{`Card ${card()}`}</Text>
    </View>
  );
}

mount(App);
