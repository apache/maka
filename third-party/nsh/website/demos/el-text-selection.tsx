import { mount, Scroll, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { TextView } from "nsh/base";
import { platform } from "nsh";
import { field, ui } from "./palette";

const NOTES = "- Sync runs **in the background**\n- Conflicts merge *per field*";

function App() {
  const pasted = signal("");
  return (
    <Scroll style={{ flex: 1, backgroundColor: ui().page }}>
      <View style={{ width: "100%", maxWidth: 560, alignSelf: "center", padding: 20, paddingTop: 24, gap: 14 }}>
        <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>selectable view</Text>
        <Text style={{ color: ui().muted, lineHeight: 20 }}>
          {platform.idiom === "desktop"
            ? "Drag with the mouse from the title into the list: one selection runs across them. Double click a word, triple click a paragraph, Ctrl / Cmd+C copies."
            : "Long press a word, then drag the handles across the texts: one selection runs across them. Copy is in the menu."}
        </Text>

        <View selectable style={{ ...ui().card, borderRadius: 16, padding: 16, gap: 10 }}>
          <Text style={{ fontSize: 17, fontWeight: "600", color: ui().text }}>Release notes</Text>
          <Text style={{ color: ui().text, lineHeight: 22 }}>Version 2.4 moves the app to offline sync.</Text>
          <TextView markdown={NOTES} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Text selectable={false} style={{ color: ui().faint }}>
              Updated (selectable=false)
            </Text>
            <Text style={{ color: ui().text }}>October 21</Text>
          </View>
        </View>

        <Text style={{ fontSize: 12, color: ui().muted }}>Paste what you copied: the label marked selectable=false stays out of it.</Text>
        <Input
          multiline
          value={pasted()}
          onChange={(text) => pasted.set(text)}
          placeholder="Paste here"
          {...field({ style: { height: 110 } })}
        />
        <Text style={{ fontSize: 12, color: ui().muted, fontVariant: ["tabular-nums"] }}>
          {pasted().length} characters, {pasted() ? pasted().split("\n").length : 0} lines
        </Text>
      </View>
    </Scroll>
  );
}

mount(App);
