// First sets and non-prefix replacements of Markdown with definitions.
import { mount, signal, Text, View } from "nsh";
import { Button, TextView } from "nsh/base";

const section = "## Part\n\nSome **bold** text with `code`, [docs] and a note[^a].\n\n";
const body = section.repeat(Math.ceil(40_000 / section.length));
const definitions = "[docs]: https://example.com/guide\n\n[^a]: A note with [docs].";
const source = body + definitions;
const replacement = source.replace("Some", "More");

function App() {
  const edited = signal(false);
  return (
    <View style={{ flex: 1 }}>
      <Button testID="replace" onPress={() => edited.set(!edited())}>
        <Text>Replace</Text>
      </Button>
      <TextView
        markdown={edited() ? replacement : source}
        options={{ streaming: true }}
      />
    </View>
  );
}

mount(App);
