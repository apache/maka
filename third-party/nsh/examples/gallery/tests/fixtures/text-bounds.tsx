import { mount, signal, Text, View } from "nsh";
import { Button, Input } from "nsh/base";

// Short labels laid out after an Input whose hint is wider than its field:
// the input's EditText lays that hint out with a StaticLayout first. Each
// label shows how many lines it laid out in.
const WORDS = ["Work", "Week", "Today", "Toda"];

function Label(props: { word: string }) {
  const lines = signal(0);
  return (
    <View style={{ gap: 4 }}>
      <Text class="text-[13px] font-semibold" onTextLayout={(e) => lines.set(e.lines.length)}>
        {props.word}
      </Text>
      <Text style={{ fontSize: 11 }}>{() => `${props.word}: ${lines()} line${lines() === 1 ? "" : "s"}`}</Text>
    </View>
  );
}

function App() {
  const shown = signal(false);
  return (
    <View style={{ flex: 1, paddingTop: 80, paddingHorizontal: 24, gap: 16 }}>
      <Input
        multiline
        placeholder="Tell me what to do next, in as many words as you need"
        style={{ minHeight: 40, borderWidth: 1, borderColor: "#999999" }}
      />
      <Button onPress={() => shown.set(true)}>
        <Text>Show labels</Text>
      </Button>
      {() =>
        shown() && (
          <View style={{ flexDirection: "row", gap: 16 }}>
            {WORDS.map((word) => <Label word={word} />)}
          </View>
        )
      }
    </View>
  );
}

mount(() => <App />);
