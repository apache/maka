// A case of the API's test suite (docs/dev/compatibility.md): a scroll
// view that zooms, as the platform receives it: the zoom limits, the zoom
// it is told to show (and a new one when it changes), bouncing past the
// limits, pinching, centering content smaller than the viewport, and the
// animated value fed with its offset. Its script
// checks each.
import { Scroll, Text, View, signal } from "nsh";
import { createAnimatedValue } from "nsh";

function App() {
  const zoom = signal(2);
  const offset = createAnimatedValue(7);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View testID="zoom" onPress={() => zoom.set(1.5)}>
        <Text>Zoom</Text>
      </View>
      <Scroll
        testID="photo"
        style={{ height: 300 }}
        minimumZoomScale={0.5}
        maximumZoomScale={4}
        zoomScale={zoom()}
        bouncesZoom={false}
        zoomable={false}
        centerContent
        scrollValue={offset}
      >
        <View style={{ width: 300, height: 300 }} />
      </Scroll>
    </View>
  );
}

export default App;
