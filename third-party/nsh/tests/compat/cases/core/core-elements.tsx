// A case of the API's test suite (docs/dev/compatibility.md): the host
// elements of the primitives (`Scroll`, `Input`, `Image`, `Video`,
// `WebView`) and a native component nothing registered, each laid out where
// its style puts it; `nativeModule` reading a UI set the engine has and one
// it has not; `PanResponder`'s handlers spread on a view. Its script checks
// each.
import { Scroll, Text, View } from "nsh";
import { Input } from "nsh/base";
import { createAnimatedValue } from "nsh";
import { PanResponder } from "nsh";
import { Image } from "nsh";
import { nativeComponent, nativeModule } from "nsh";
import { Video } from "nsh";
import { WebView } from "nsh";

const Map = nativeComponent<{ zoom: number }, { regionChange: { zoom: number } }>("CompatMap", {
  props: ["zoom"],
  events: ["regionChange"],
});

function missingModule(): string {
  try {
    nativeModule<object>("host/compat-missing");
    return "found";
  } catch (e) {
    return e instanceof ReferenceError && String(e.message).includes("host/compat-missing")
      ? "ReferenceError"
      : `other: ${e}`;
  }
}

function App() {
  const base = nativeModule<Record<string, unknown>>("nsh/base");
  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderMove: () => {},
  });
  return (
    <View testID="root" style={{ flex: 1, paddingTop: 64 }}>
      <Scroll testID="scroll" style={{ height: 100 }}>
        <View testID="tall" style={{ height: 300 }}>
          <Text>In scroll</Text>
        </View>
      </Scroll>
      <Input testID="input" value="typed" placeholder="Name" style={{ width: 200, height: 36 }} />
      <Image testID="image" src="https://example.com/compat.png" style={{ width: 64, height: 48 }} />
      <Video testID="video" src="https://example.com/compat.mp4" paused style={{ width: 160, height: 90 }} />
      <WebView testID="web" html="<p>compat</p>" style={{ width: 180, height: 60 }} />
      <Map testID="map" zoom={3} style={{ width: 100, height: 50 }} />
      {/* An own prop bound to an animated value: pushed natively, not sent as JSON. */}
      <Map testID="map-animated" zoom={createAnimatedValue(2).interpolate({ inputRange: [0, 4], outputRange: [1, 5] })} style={{ width: 100, height: 50 }} />
      <View testID="pan" {...pan.panHandlers} style={{ width: 50, height: 50 }} />
      <Text>Missing module: {missingModule()}</Text>
      <Text>Base module: {typeof base === "object" && base !== null ? "object" : typeof base}</Text>
      <Text>Same object: {String(nativeModule("nsh/base") === base)}</Text>
      <Text>Pan handlers: {Object.keys(pan.panHandlers).length > 0 ? "some" : "none"}</Text>
      <Text>Pan start: {String(typeof pan.panHandlers.onStartShouldSetResponder === "function")}</Text>
    </View>
  );
}

export default App;
