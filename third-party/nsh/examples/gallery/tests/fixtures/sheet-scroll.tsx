import { mount, platform, Scroll, signal, Text, View } from "nsh";
import { Sheet } from "nsh/base";

// A swipe-to-close sheet holding a list taller than the sheet, and a button
// placed over the list.
function App() {
  const open = signal(true);
  const offset = signal(0);
  return (
    <View style={{ flex: 1, paddingTop: 80, paddingHorizontal: 24 }}>
      <Text>{open() ? "sheet: open" : "sheet: closed"}</Text>
      <Text>{offset() > 0 ? "list: scrolled" : "list: at top"}</Text>
      <Text>{`Platform: ${platform.os}`}</Text>
      <Sheet open={open()} onOpenChange={({ open: o }) => open.set(o)} closeOnSwipe>
        <View style={{ maxHeight: 400 }}>
          <Scroll testID="rows" onScroll={(e) => offset.set(e.offset.y)} style={{ flexShrink: 1 }}>
            {Array.from({ length: 40 }, (_, i) => (
              <View style={{ height: 44, justifyContent: "center", paddingHorizontal: 16 }}>
                <Text>{`Row ${i + 1}`}</Text>
              </View>
            ))}
          </Scroll>
          <View
            onPress={() => {}}
            style={{ position: "absolute", left: 16, right: 16, bottom: 16, height: 48, justifyContent: "center", alignItems: "center", backgroundColor: "#dddddd" }}
          >
            <Text>Button over the list</Text>
          </View>
        </View>
      </Sheet>
    </View>
  );
}

mount(App);
