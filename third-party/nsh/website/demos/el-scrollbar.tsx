import { mount, Scroll, signal, Text, View, type YNode } from "nsh";
import { Scrollbar, type ScrollbarMode } from "nsh/base";
import { desktop, Panel, Segmented, size, Split, ui } from "./palette";

// A list of messages in a card whose own indicator is off, with the app's
// bar over its right edge, timed as gpui-component's: a 6-point pill in the
// palette's muted tone that widens to 8 under the pointer (`hover:`) and
// while dragged (`active:`), fading in over 300 ms and out over 500 ms, 2 s
// after the last scroll (`motion`); pointing at its hidden thumb in the
// `hover` mode slides it in. The inspector switches when it shows and
// follows the offset the list reports.
const MESSAGES = Array.from({ length: 60 }, (_, i) => ({
  from: ["Ada", "Grace", "Linus", "Ken", "Barbara"][i % 5],
  text: ["Shipped the build", "Review when you can", "Tests are green", "Moved the meeting", "Draft is ready"][i % 5],
  at: `${9 + Math.floor(i / 6)}:${String((i * 7) % 60).padStart(2, "0")}`,
}));

function App() {
  const mode = signal<ScrollbarMode>("scrolling");
  const offset = signal(0);
  let inbox: YNode | undefined;
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>scrollbar</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Scroll the list, drag the thumb or click the track" : "Scroll the list, or drag the thumb"}
      </Text>
      <Split
        gap={14}
        grow
        inspector={
          <Panel title="scrollbar">
            <Segmented
              label="mode"
              options={["scrolling", "hover", "always"] as const}
              value={mode()}
              onChange={(v) => mode.set(v)}
            />
            <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>
              {`offset ${Math.round(offset())}`}
            </Text>
          </Panel>
        }
      >
        <View style={{ ...ui().card, flex: 1, minHeight: 320, borderRadius: 16, overflow: "hidden" }}>
          <Scroll
            ref={inbox}
            scrollbar={false}
            style={{ flex: 1 }}
            onScroll={(e) => offset.set(e.offset.y)}
          >
            {MESSAGES.map((m) => (
              <View
                class={desktop ? "flex-row gap-3 px-3 py-2.5" : "flex-row gap-3 px-4 py-3"}
                style={{ borderBottomWidth: 1, borderColor: ui().line }}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ fontSize: size.label, fontWeight: "500", color: ui().text }}>{m.from}</Text>
                  <Text style={{ fontSize: size.detail, color: ui().muted }}>{m.text}</Text>
                </View>
                <Text style={{ fontSize: size.detail, color: ui().muted, fontVariant: ["tabular-nums"] }}>{m.at}</Text>
              </View>
            ))}
          </Scroll>
          <Scrollbar
            scroll={inbox}
            mode={mode()}
            motion={{ idle: 2000, enter: 300, exit: 500, entrance: "fade", thumbHoverEntrance: "slideAndFade" }}
            accessibilityLabel="Messages"
            class="absolute inset-y-0 right-0 w-4 items-end p-1"
            thumbClass="w-1.5 rounded-full opacity-60 transition-all duration-300 hover:w-2 hover:opacity-90 active:w-2 active:opacity-100"
            thumbStyle={{ backgroundColor: ui().muted }}
          />
        </View>
      </Split>
    </View>
  );
}

mount(App);
