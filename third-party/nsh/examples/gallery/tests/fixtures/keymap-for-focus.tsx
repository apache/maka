import { keymap, mount, signal, Text, View } from "nsh";

// Two tiles that open on a press (a click, or Return and Space with the
// focus on them) and bind Space as their own keys while they have the
// focus (`forFocus`): Space flips the focused tile's switch and Return
// still opens it. A page-wide Space binding without `forFocus` gives way.
function Tile(props: { name: string; on: () => boolean; onFlip: () => void; onOpen: () => void }) {
  let unbind: (() => void) | undefined;
  return (
    <View
      testID={props.name}
      onPress={props.onOpen}
      onFocus={() => (unbind = keymap.bind("space", props.onFlip, { forFocus: true }))}
      onBlur={() => unbind?.()}
      class="border-border"
      style={{ height: 48, borderWidth: 1, padding: 8 }}
    >
      <Text class="text-foreground">{`${props.name} ${props.on() ? "on" : "off"}`}</Text>
    </View>
  );
}

function App() {
  const a = signal(false);
  const b = signal(false);
  const opened = signal("");
  const page = signal(0);
  keymap.bind("space", () => page.set(page() + 1), { when: "notEditing" });
  return (
    <View class="flex-1 bg-background" style={{ padding: 12, gap: 8 }}>
      <Tile name="A" on={a} onFlip={() => a.set(!a())} onOpen={() => opened.set("A")} />
      <Tile name="B" on={b} onFlip={() => b.set(!b())} onOpen={() => opened.set("B")} />
      <Text class="text-foreground">{`Opened [${opened()}] Page ${page()}`}</Text>
    </View>
  );
}

mount(App);
