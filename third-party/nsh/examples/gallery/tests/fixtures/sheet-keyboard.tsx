import { cleanup, host, keyboardFrame, mount, platform, safeArea, signal, Text, View, windowSize, type ViewRef } from "nsh";
import { Input, Sheet } from "nsh/base";
import { Window } from "nsh/desktop";

// No scroll view: this isolates the panel's keyboard offset from input
// scrolling and a scroll gesture's hand-off to a swipe-to-close sheet.
function App() {
  const open = signal(true);
  const pressed = signal(false);
  const alignment = signal("footer: unmeasured");
  let footer: ViewRef | undefined;
  cleanup(host.on("test:measure-footer", async () => {
    const measured = await footer?.measure();
    if (!measured) return;
    const bottom = measured.pagePosition.y + measured.bounds.size.height;
    const gap = windowSize().height - keyboardFrame().height - bottom;
    alignment.set(Math.abs(gap) <= 1 ? "footer: aligned" : `footer gap: ${gap.toFixed(1)}`);
  }));
  return (
    <View style={{ flex: 1, paddingTop: 80 }}>
      <Text>{`Platform: ${platform.name}`}</Text>
      <Text>{keyboardFrame().height > 0 ? "keyboard: up" : "keyboard: down"}</Text>
      <Text>{open() ? "sheet: open" : "sheet: closed"}</Text>
      <Text>{alignment()}</Text>
      <Sheet
        open={open()}
        onOpenChange={({ open: next }) => open.set(next)}
        popupClass="bg-white"
        popupStyle={{ height: 400, paddingBottom: safeArea().bottom }}
      >
        <View style={{ height: 56, flexDirection: "row", alignItems: "center", paddingHorizontal: 24 }}>
          <Text testID="sheet-title" style={{ flex: 1 }}>Sheet title</Text>
          <View testID="sheet-close" onPress={() => open.set(false)} style={{ width: 44, height: 44, justifyContent: "center" }}>
            <Text>Close</Text>
          </View>
        </View>
        <View style={{ flex: 1, justifyContent: "center", padding: 24 }}>
          <Input testID="note" placeholder="Add a note" style={{ height: 44 }} />
        </View>
        <View testID="sheet-footer" ref={ref => { footer = ref; }} onPress={() => pressed.set(true)} style={{ height: 56, justifyContent: "center", paddingHorizontal: 24 }}>
          <Text>{pressed() ? "footer: pressed" : "footer: untouched"}</Text>
        </View>
      </Sheet>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
