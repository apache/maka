import { mount, signal, Scroll, Text, View } from "nsh";

// A row in a scroll view far taller than the window. The row hears what
// touches it (`onTouchStart`, `pointerType`); the lines above the list say
// what it heard and whether the list scrolled. A drag
// up the row scrolls the list with a finger (a phone) and not with the
// mouse (a desktop, the web), as the platforms' own input does.
function App() {
  const pointer = signal("none");
  const offset = signal(0);
  return (
    <View style={{ flex: 1 }}>
      <Text>{`Pointer: ${pointer()}`}</Text>
      <Text>{`Scrolled: ${offset() > 0 ? "yes" : "no"}`}</Text>
      <Scroll style={{ flex: 1 }} onScroll={(e) => offset.set(e.offset.y)}>
        <View style={{ paddingTop: 400, height: 3000 }}>
          <View
            testID="row"
            onTouchStart={(e) => pointer.set(e.pointerType)}
            style={{ height: 60, padding: 16 }}
          >
            <Text>Row</Text>
          </View>
        </View>
      </Scroll>
    </View>
  );
}

mount(App);
