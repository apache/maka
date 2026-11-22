// A case of the API's test suite (docs/dev/compatibility.md): whether the
// platform draws shader views (`shadersAvailable()`), which the headless
// backend reports as `true`, choosing between a shader and the app's own
// drawing as an app does.
import { Shader, Text, View, shadersAvailable } from "nsh";

const GRADIENT = `fn shade(uv: vec2f) -> vec4f {
  return vec4f(uv.x, uv.y, 0.5, 1.0);
}`;

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Shaders available: ${shadersAvailable()}`}</Text>
      {shadersAvailable() ? (
        <Shader source={GRADIENT} style={{ width: 200, height: 120 }} />
      ) : (
        <View style={{ width: 200, height: 120, backgroundColor: "#336699" }} />
      )}
    </View>
  );
}

export default App;
