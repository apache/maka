import { mount, signal, Text, View } from "nsh";
import { desktop, EmojiPanel, Log, Panel, sectionSurface, Split, ui, wide } from "./palette";

// An emoji picker as a chat app has it: the groups' tabs, search with the
// skin tone hand, the recent emoji first, the one under the pointer named
// below (the tabs at the foot on a phone). The picker owns the emoji, the
// filtering, the keys and the semantics; every pixel is the gallery's
// `EmojiPanel`.
const message = signal("Lunch at the new ramen place? ");
const recent = signal<string[]>(["👍", "😂", "❤️", "🎉", "🙏", "🔥"]);
const events = signal<string[]>([]);
const log = (line: string) => events.set([line, ...events()].slice(0, 4));

function App() {
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>emoji picker</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Type to search, the arrows to move, Return to choose; a tab scrolls to its group" : "Search, or tap a tab to scroll to its group; tap an emoji to choose it"}
      </Text>
      <Split
        gap={14}
        inspector={
          <>
            <Panel title="message">
              <Text style={{ fontSize: 14, color: ui().text }}>{message()}</Text>
            </Panel>
            <Log title="events" lines={events()} minHeight={92} />
          </>
        }
      >
        <View
          style={{
            ...sectionSurface(),
            width: wide() ? 342 : undefined,
            height: desktop ? 400 : 440,
            alignSelf: wide() ? "center" : "stretch",
            overflow: "hidden",
          }}
        >
          <EmojiPanel
            class="flex-1"
            fill={!desktop}
            recent={recent()}
            onSelect={({ emoji, base }) => {
              message.set(message() + emoji);
              recent.set([base, ...recent().filter((e) => e !== base)].slice(0, 18));
              log(`onSelect({ emoji: "${emoji}", base: "${base}" })`);
            }}
            onCancel={() => log("onCancel()")}
          />
        </View>
      </Split>
    </View>
  );
}

mount(App);
