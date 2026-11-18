import { mount, Scroll, signal, Text, View } from "nsh";

const chips = Array.from({ length: 12 }, (_, i) => `Chip ${i + 1}`);
const rows = Array.from({ length: 40 }, (_, i) => `Row ${i + 1}`);

/** How a scroll view moved: its offset now, and how many times it turned
 * back (a drag that flings past its target and is dragged back turns;
 * scrolling straight to it does not). */
function tracker() {
  const offset = signal(0);
  const turns = signal(0);
  let last = 0;
  let direction = 0;
  const onScroll = (at: number) => {
    offset.set(Math.round(at));
    // A finger at rest trembles a fraction of a point.
    if (Math.abs(at - last) < 1) return;
    const d = Math.sign(at - last);
    if (d !== 0 && direction !== 0 && d !== direction) turns.update((n) => n + 1);
    if (d !== 0) direction = d;
    last = at;
  };
  return { offset, turns, onScroll };
}

/** A row of chips wider than the screen, each reporting its press, and
 * a long column of rows below it. */
function App() {
  const pressed = signal("none");
  const x = tracker();
  const y = tracker();
  return (
    <View style={{ flex: 1, paddingTop: 80 }}>
      <Text testID="pressed">{`pressed:${pressed()}`}</Text>
      <Text>{`x:${x.offset()} turns:${x.turns()}`}</Text>
      <Text>{`y:${y.offset()} turns:${y.turns()}`}</Text>
      <Scroll horizontal testID="chips" style={{ height: 56, flexGrow: 0 }} onScroll={(e) => x.onScroll(e.offset.x)}>
        <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, alignItems: "center" }}>
          <Each of={chips}>
            {(chip) => (
              <View
                role="button"
                testID={chip().replace(" ", "-").toLowerCase()}
                onPress={() => pressed.set(chip())}
                style={{ height: 40, width: 96, borderRadius: 20, justifyContent: "center", alignItems: "center", backgroundColor: "#e5e5e5" }}
              >
                <Text>{chip()}</Text>
              </View>
            )}
          </Each>
        </View>
      </Scroll>
      <Scroll testID="rows" style={{ flex: 1 }} onScroll={(e) => y.onScroll(e.offset.y)}>
        <Each of={rows}>
          {(row) => (
            <View role="button" onPress={() => pressed.set(row())} style={{ height: 56, justifyContent: "center", paddingHorizontal: 16 }}>
              <Text>{row()}</Text>
            </View>
          )}
        </Each>
      </Scroll>
    </View>
  );
}

mount(App);
