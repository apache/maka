// A streamed reply in a TextView: 600 short blocks shown, then 24 bytes
// more of the reply with each press (the last block grows, or one comes).
import { mount, signal, Text, View } from "nsh";
import { Button, TextView } from "nsh/base";
import { Window } from "nsh/desktop";

const block = (i: number) =>
  `Paragraph ${i} of the reply, with **bold** text and \`code\`.\n\n`;
const blocks = Array.from({ length: 640 }, (_, i) => block(i));
const reply = blocks.join("");
const start = blocks.slice(0, 600).join("").length;

function App() {
  const shown = signal(start);
  return (
    <View style={{ flex: 1 }}>
      <Button testID="more" onPress={() => shown.set(shown() + 24)}>
        <Text>More</Text>
      </Button>
      <TextView
        markdown={reply.slice(0, shown())}
        options={{ streaming: true }}
      />
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
