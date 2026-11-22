// A case of the API's test suite (docs/dev/compatibility.md): `Shader`, a
// view whose box a WGSL shader draws. A headless run renders no pixels, so
// the script checks the view's layout and that its children show over it;
// the uniforms take every kind of value apps pass (a number, a color, a
// list, an animated value) and `paused` stops its clock.
import { Text, View, createAnimatedValue } from "nsh";
import { Shader } from "nsh";

const SOURCE = `
struct Uniforms { level: f32, tint: vec4f, center: vec2f, glow: f32 }
fn shade(uv: vec2f) -> vec4f {
  let d = distance(uv, uniforms.center);
  let wave = 0.5 + 0.5 * sin(d * 20.0 - nsh.time * 2.0);
  return vec4f(uniforms.tint.rgb * wave * uniforms.level + uniforms.glow, 1.0);
}`;

function App() {
  const glow = createAnimatedValue(0.1);
  return (
    <View testID="root" style={{ flex: 1, paddingTop: 64 }}>
      <Shader
        testID="shader"
        source={SOURCE}
        uniforms={{ level: 0.8, tint: "#3366ff", center: [0.5, 0.5], glow }}
        paused={false}
        style={{ width: 200, height: 100, borderRadius: 12, padding: 10 }}
      >
        <Text testID="label">Over the shader</Text>
      </Shader>
      <Shader testID="still" source={SOURCE} paused style={{ width: 50, height: 50 }} />
    </View>
  );
}

export default App;
