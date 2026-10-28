// A case of the API's test suite (docs/dev/compatibility.md): what a scroll
// view reports as the user scrolls it: each offset with its content's and
// its own size and zoom, a drag beginning and ending, a fling's momentum
// beginning and ending, and the scroll coming to rest. Each handler shows
// what it gets as text. Its script checks
// each.
import { Scroll, Text, View, signal } from "nsh";

type At = { offset: { x: number; y: number } };

function App() {
  const scroll = signal("none");
  const steps = signal<string[]>([]);
  const step = (name: string) => ({ offset }: At) => steps.update((s) => [...s, `${name} ${offset.x},${offset.y}`]);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>Scroll: {scroll()}</Text>
      <Text>Steps: {steps().join(" | ")}</Text>
      <Scroll
        testID="scroll"
        style={{ width: 300, height: 200 }}
        onScroll={(e) =>
          scroll.set(
            `${e.offset.x},${e.offset.y} content ${e.contentSize.width}x${e.contentSize.height} ` +
              `size ${e.size.width}x${e.size.height} zoom ${e.zoomScale}`,
          )
        }
        onScrollDragStart={step("begin")}
        onScrollDragEnd={step("end")}
        onMomentumStart={step("glide")}
        onMomentumEnd={step("stop")}
        onScrollEnd={step("rest")}
      >
        <View style={{ height: 1000 }} />
      </Scroll>
    </View>
  );
}

export default App;
