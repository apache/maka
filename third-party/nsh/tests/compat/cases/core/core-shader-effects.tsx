// A case of the API's test suite (docs/dev/compatibility.md): the views a
// WGSL shader draws through. `ShaderEffect`'s children are its
// `sample_content`, `ShaderTransition`'s change through it when its `value`
// changes, and `ScreenEffect` and `ScreenTransition` do the same for the
// whole surface, taking no space. A headless run renders no pixels, so the
// script checks the views' layout, that the children show and keep their
// presses, and that a transition's children change with its value.
import { ScreenEffect, ScreenTransition, ShaderEffect, ShaderTransition, Text, View } from "nsh";
import { createAnimatedValue, signal } from "nsh";

const RIPPLE = `
struct Uniforms { amount: f32 }
fn shade(uv: vec2f) -> vec4f {
  let offset = vec2f(sin(uv.y * 30.0 + nsh.time) * uniforms.amount, 0.0) / nsh.size;
  return sample_content(uv + offset) * (0.5 + 0.5 * nsh.progress);
}`;

const WIPE = `
fn shade(uv: vec2f) -> vec4f {
  return select(sample_from(uv), sample_to(uv), uv.x < nsh.progress);
}`;

const SEASONS = ["Spring", "Summer", "Autumn"];

function App() {
  const presses = signal(0);
  const season = signal(0);
  const progress = createAnimatedValue(0.5);
  return (
    <View testID="root" style={{ flex: 1, paddingTop: 64 }}>
      <ShaderEffect
        testID="effect"
        source={RIPPLE}
        uniforms={{ amount: 4 }}
        progress={progress}
        maxSampleOffset={8}
        style={{ width: 200, height: 60, padding: 10 }}
      >
        <View testID="inside" onPress={() => presses.set(presses() + 1)}>
          <Text>Pressed {presses()}</Text>
        </View>
      </ShaderEffect>
      <ShaderTransition
        testID="transition"
        source={WIPE}
        value={SEASONS[season()]}
        duration={200}
        maxSampleOffset={0}
        style={{ width: 200, height: 40 }}
      >
        <Text>{SEASONS[season()]}</Text>
      </ShaderTransition>
      <ShaderTransition testID="fade" value={season()} fallback="fade" style={{ width: 100, height: 20 }}>
        <Text>Season {season() + 1}</Text>
      </ShaderTransition>
      <View testID="next" onPress={() => season.set((season() + 1) % SEASONS.length)}>
        <Text>Next season</Text>
      </View>
      <ScreenEffect source={RIPPLE} uniforms={{ amount: 0 }} progress={1} paused />
      <ScreenTransition value={season()} fallback="none" />
    </View>
  );
}

export default App;
