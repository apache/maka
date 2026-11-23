// A case of the API's test suite (docs/dev/compatibility.md): how a scroll
// view scrolls, as the platform receives it: paging, snapping, the fling's
// deceleration, bounces, the content inset, the scroll indicator's inset,
// where it starts, the keyboard on taps and drags, the scroll indicator,
// sideways scrolling, scrolling turned off and the pull-to-refresh spinner,
// how often `onScroll` fires and a mouse wheel's glide and line height. Its script checks each.
import { Scroll, Text, View, signal } from "nsh";

function App() {
  const refreshing = signal(true);
  const scrolled = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View testID="done" onPress={() => refreshing.set(false)}>
        <Text>Done</Text>
      </View>
      <Scroll
        testID="paged"
        style={{ height: 120 }}
        pagingEnabled
        snapToInterval={80}
        snapToOffsets={[0, 150, 300]}
        snapToAlignment="center"
        decelerationRate="fast"
        bounces={false}
        contentInset={{ top: 8, bottom: 16 }}
        scrollbarInset={{ top: 4, bottom: 40 }}
        contentOffset={{ x: 0, y: 40 }}
        keyboardShouldPersistTaps="handled"
        disableIntervalMomentum
        scrollbar={false}
        keyboardDismissMode="on-drag"
        refreshing={refreshing()}
      >
        <View style={{ height: 600 }} />
      </Scroll>
      <Scroll testID="sideways" style={{ height: 60 }} horizontal scrollable={false} decelerationRate={0.5}>
        <View style={{ width: 900, height: 60 }} />
      </Scroll>
      <Scroll
        testID="throttled"
        style={{ height: 100 }}
        scrollEventThrottle={3000}
        smoothWheel
        wheelLineHeight={40}
        onScroll={(e) => scrolled.set(`${e.offset.y}`)}
      >
        <View style={{ height: 800 }} />
      </Scroll>
      <Text>Scrolled: {scrolled()}</Text>
    </View>
  );
}

export default App;
