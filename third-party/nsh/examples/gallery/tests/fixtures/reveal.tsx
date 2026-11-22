import { mount, Scroll, signal, Text, View } from "nsh";
import type { ViewRef } from "nsh";

// Rows of 100 pt in a 200 pt scroll view; row 6 scrolls sideways through
// five 200 pt cells in 300 pt.
function App() {
  let cell: ViewRef | undefined;
  const outer = signal(0);
  const inner = signal(0);
  return (
    <View style={{ flex: 1, paddingTop: 80 }}>
      <Text>{`outer ${outer()} inner ${inner()}`}</Text>
      <View role="button" onPress={() => cell?.reveal({ animated: false })} style={{ height: 44 }}>
        <Text>Show cell</Text>
      </View>
      <Scroll style={{ height: 200 }} onScroll={(e) => outer.set(e.offset.y)}>
        {Array.from({ length: 10 }, (_, row) =>
          row === 6 ? (
            <Scroll horizontal style={{ width: 300, height: 100 }} onScroll={(e) => inner.set(e.offset.x)}>
              {Array.from({ length: 5 }, (_, i) => (
                <View ref={i === 4 ? (node) => (cell = node) : undefined} style={{ width: 200, height: 100 }} />
              ))}
            </Scroll>
          ) : (
            <View style={{ height: 100 }} />
          ),
        )}
      </Scroll>
    </View>
  );
}

mount(App);
