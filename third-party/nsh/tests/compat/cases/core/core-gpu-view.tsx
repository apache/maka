// A case of the API's test suite (docs/dev/compatibility.md): `gpuView`, a
// view whose box a renderer of the app's own Rust crate draws with the GPU.
// This app has no crate, so nothing is registered under the name: the view
// draws nothing of its own, and the script checks its layout, that its
// children show over it and that its own props (a number, a string, an
// animated value) and event handlers are accepted.
import { Text, View, createAnimatedValue, gpuView } from "nsh";

const Scene = gpuView<{ exposure: number; model: string }, { pick: { part: number } }>(
  "compat/scene",
  { props: ["exposure", "model"], events: ["pick"] },
);

function App() {
  const exposure = createAnimatedValue(1);
  return (
    <View testID="root" style={{ flex: 1, paddingTop: 64 }}>
      <Scene
        testID="scene"
        exposure={exposure}
        model="gear"
        onPick={() => {}}
        style={{ width: 200, height: 100, borderRadius: 12, padding: 10 }}
      >
        <Text testID="label">Over the scene</Text>
      </Scene>
    </View>
  );
}

export default App;
