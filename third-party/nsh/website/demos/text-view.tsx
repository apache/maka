import { cleanup, mount, signal, Scroll, Text, View } from "nsh";
import { TextView } from "nsh/base";
import { button, buttonText, desktop, ui } from "./palette";

const REPLY = `## Moving to offline sync

Sync now runs **in the background**, and conflicts merge *per field*:

1. Export with \`nsh export\`
2. Check the dry run
3. Switch over

| Step   | Time  |
|--------|------:|
| Export | 2 min |
| Check  | 5 min |

\`\`\`sh
nsh export --out backup.json
\`\`\`

> [!TIP]
> ${desktop ? "Drag across the paragraphs to select them, then copy." : "Long-press a paragraph to copy it."}`;

function App() {
  const text = signal(REPLY);
  const streaming = signal(false);
  let timer: number | undefined;
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    streaming.set(false);
  };
  cleanup(stop);
  // Replays the reply a few characters at a time, as a model streams it.
  const play = () => {
    stop();
    const tokens = REPLY.match(/\s*\S{1,4}|\s+/g) ?? [];
    let i = 0;
    text.set("");
    streaming.set(true);
    timer = setInterval(() => (i < tokens.length ? text.set(text() + tokens[i++]) : stop()), 40);
  };
  return (
    <Scroll style={{ flex: 1, backgroundColor: ui().page }}>
      <View style={{ width: "100%", maxWidth: 680, alignSelf: "center", padding: 20, gap: 16 }}>
        <TextView
          markdown={text()}
          options={{ streaming: streaming() }}
          streamingCaret={streaming() ? <View style={{ width: 8, height: 16, marginLeft: 2, borderRadius: 2, backgroundColor: ui().accent }} /> : undefined}
          selectable
        />
        <View
          onPress={play}
          disabled={streaming()}
          {...button()}
        >
          <Text style={buttonText()}>{streaming() ? "Streaming…" : "Stream it again"}</Text>
        </View>
      </View>
    </Scroll>
  );
}

mount(() => <App />);
