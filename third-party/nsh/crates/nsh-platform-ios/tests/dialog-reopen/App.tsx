import { mount, PanResponder, signal, Text, View } from "nsh";
import { Button, Dialog } from "nsh/base";

// Manual reproduction of the financial chart popup defect. The dialog is
// mounted deep in the page content, unmounted on close and mounted again on
// reopen. Inside it:
//   - a PanResponder strip (the chart's swipe-to-flip gesture: positions go
//     through JS via the modal's TouchTracker),
//   - a raw onTouch surface (the chart's onDown / onTouch path),
//   - a plain onPress button (a separate PressRecognizer per view — the
//     control that keeps working).
// First open: the strip drags, the touch surface counts, the button counts.
// After a full close and reopen on a real device: the strip and the touch
// surface stop responding while the button still works.
function App() {
  const open = signal(false);
  const panX = signal(0);
  const touches = signal(0);
  const taps = signal(0);
  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderMove: (_: unknown, g: { dx: number }) => panX.set(Math.round(g.dx)),
  });
  return (
    <View style={{ flex: 1, paddingTop: 80, paddingHorizontal: 24, gap: 10, backgroundColor: "#ffffff" }}>
      <Text>{`open: ${open()}`}</Text>
      <Text>{`panX(gesture): ${panX()}`}</Text>
      <Text>{`touches(gesture): ${touches()}`}</Text>
      <Text>{`taps(button): ${taps()}`}</Text>
      <Button onPress={() => open.set(true)}>
        <View style={{ height: 48, justifyContent: "center", backgroundColor: "#1976d2", borderRadius: 8, paddingHorizontal: 16 }}>
          <Text style={{ color: "#ffffff" }}>Open chart popup</Text>
        </View>
      </Button>

      {open() && (
        <Dialog
          open
          presentation="pageSheet"
          onOpenChange={({ open: next }) => open.set(next)}
          style={{ flex: 1 }}
        >
          <View style={{ flex: 1, padding: 20, gap: 14, backgroundColor: "#ffffff" }}>
            <Text style={{ fontSize: 18 }}>Chart popup</Text>
            <Text>{`chartDx:${panX()}`}</Text>
            <Text>{`touchN:${touches()}`}</Text>
            <Text>{`tapN:${taps()}`}</Text>

            {/* Chart swipe gesture (PanResponder → JS). Drag left/right. */}
            <View
              testID="chart"
              {...pan.panHandlers}
              style={{ height: 150, backgroundColor: "#e3f2fd", borderRadius: 8, alignItems: "center", justifyContent: "center" }}
            >
              <Text style={{ fontSize: 16 }}>{`◀  swipe the chart  ▶   (dx ${panX()})`}</Text>
            </View>

            {/* Raw touch path (onDown / onTouch → JS). */}
            <View
              testID="touchpad"
              onTouchStart={() => touches.update((n) => n + 1)}
              onTouchMove={() => touches.update((n) => n + 1)}
              style={{ height: 90, backgroundColor: "#fff3e0", borderRadius: 8, alignItems: "center", justifyContent: "center" }}
            >
              <Text>{`touch here (onTouch count ${touches()})`}</Text>
            </View>

            {/* Plain button (PressRecognizer) — the control that keeps working. */}
            <Button onPress={() => taps.update((n) => n + 1)}>
              <View style={{ height: 44, justifyContent: "center", backgroundColor: "#43a047", borderRadius: 8, paddingHorizontal: 16 }}>
                <Text style={{ color: "#ffffff" }}>Button (onPress) — should still work</Text>
              </View>
            </Button>
            <Button onPress={() => open.set(false)}>
              <View style={{ height: 44, justifyContent: "center", backgroundColor: "#9e9e9e", borderRadius: 8, paddingHorizontal: 16 }}>
                <Text style={{ color: "#ffffff" }}>Close</Text>
              </View>
            </Button>
          </View>
        </Dialog>
      )}
    </View>
  );
}

mount(App);
