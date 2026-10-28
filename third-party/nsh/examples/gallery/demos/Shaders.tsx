import { Animated, cleanup, createAnimatedValue, Easing, Image, Shader, signal, Text, View } from "nsh";
import logo from "../logo-dark.svg";
import { Caption, Card, DemoPage, mono, Press } from "../ui";

// Every demo below is a WGSL `shade(uv)` function: the core checks it,
// the platform renders it on the GPU under the view's children, clipped to
// its rounded box. `nsh.time` makes it animate; uniforms take numbers,
// colors and animated values, which drags and springs move natively.

/** Value noise and fractal noise, shared by several demos. */
const NOISE = /* wgsl */ `
// An integer hash of the cell p is in: sin-based hashes differ between
// two computations of one corner once the compiler reorders the arithmetic.
fn hash(p: vec2f) -> f32 {
  let q = bitcast<vec2u>(vec2i(floor(p)));
  var h = (q.x * 1597334677u) ^ (q.y * 3812015801u);
  h = h * 1664525u + 1013904223u;
  h = (h ^ (h >> 16u)) * 2246822519u;
  h = h ^ (h >> 13u);
  return f32(h >> 8u) / 16777216.0;
}
fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1.0, 0.0)), u.x),
             mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fbm(p0: vec2f) -> f32 {
  var p = p0;
  var v = 0.0;
  var a = 0.5;
  for (var i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2f(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}
`;

const GLOW = /* wgsl */ `
// An integer hash of the cell p is in: sin-based hashes differ between
// two computations of one corner once the compiler reorders the arithmetic.
fn hash(p: vec2f) -> f32 {
  let q = bitcast<vec2u>(vec2i(floor(p)));
  var h = (q.x * 1597334677u) ^ (q.y * 3812015801u);
  h = h * 1664525u + 1013904223u;
  h = (h ^ (h >> 16u)) * 2246822519u;
  h = h ^ (h >> 13u);
  return f32(h >> 8u) / 16777216.0;
}
struct Uniforms { a: vec4f, b: vec4f, c: vec4f, pointer: vec2f }
fn orb(p: vec2f, center: vec2f, size: f32) -> f32 {
  let d = p - center;
  return exp(-dot(d, d) / (size * size));
}
fn shade(uv: vec2f) -> vec4f {
  let aspect = vec2f(nsh.size.x / max(nsh.size.y, 1.0), 1.0);
  let p = uv * aspect;
  let t = nsh.time * 0.35;
  // Large soft orbs on slow, different orbits; the pointer leads one more.
  var light = vec3f(0.0);
  light += uniforms.a.rgb * orb(p, vec2f(0.3 + 0.15 * sin(t * 0.8), 0.35 + 0.2 * cos(t * 0.6)) * aspect, 0.38) * 1.1;
  light += uniforms.b.rgb * orb(p, vec2f(0.65 + 0.2 * cos(t * 0.5), 0.55 + 0.25 * sin(t * 0.7 + 1.0)) * aspect, 0.45) * 1.2;
  light += uniforms.c.rgb * orb(p, vec2f(0.85 + 0.1 * sin(t * 0.9 + 2.0), 0.25 + 0.15 * cos(t * 0.4)) * aspect, 0.32);
  light += uniforms.b.rgb * orb(p, vec2f(0.15 + 0.1 * cos(t * 0.6 + 3.0), 0.85) * aspect, 0.3) * 0.6;
  light += uniforms.c.rgb * orb(p, uniforms.pointer * aspect, 0.25) * 0.9;
  // Light adds up, then rolls off softly instead of clipping.
  let base = vec3f(0.03, 0.025, 0.06);
  var color = base + (vec3f(1.0) - exp(-light * 1.4)) * 0.95;
  color += vec3f((hash(uv * nsh.size * nsh.scale) - 0.5) * 0.04);
  return vec4f(color, 1.0);
}`;

const PLASMA = /* wgsl */ `
struct Uniforms { pointer: vec2f }
fn shade(uv: vec2f) -> vec4f {
  let aspect = vec2f(nsh.size.x / max(nsh.size.y, 1.0), 1.0);
  let p = (uv - 0.5) * aspect * 4.0;
  let m = (uniforms.pointer - 0.5) * aspect * 4.0;
  let t = nsh.time * 0.5;
  var v = sin(p.x + t) + sin((p.y + t) * 0.7) + sin((p.x + p.y + t) * 0.6);
  // The pointer is a second source the field bends around.
  v += sin(length(p - m) * 2.5 - t * 2.0) * 1.2;
  // A cool palette: indigo through teal to a warm highlight.
  let c = vec3f(0.45, 0.4, 0.55) + vec3f(0.4, 0.35, 0.4) * cos(6.2831853 * (vec3f(0.0, 0.1, 0.2) + v * 0.18 + vec3f(0.55, 0.6, 0.65)));
  let vignette = 1.0 - 0.5 * dot(uv - 0.5, uv - 0.5) * 2.0;
  return vec4f(c * c * vignette, 1.0);
}`;

const RIPPLE = /* wgsl */ `
// An integer hash of the cell p is in: sin-based hashes differ between
// two computations of one corner once the compiler reorders the arithmetic.
fn hash(p: vec2f) -> f32 {
  let q = bitcast<vec2u>(vec2i(floor(p)));
  var h = (q.x * 1597334677u) ^ (q.y * 3812015801u);
  h = h * 1664525u + 1013904223u;
  h = (h ^ (h >> 16u)) * 2246822519u;
  h = h ^ (h >> 13u);
  return f32(h >> 8u) / 16777216.0;
}
struct Uniforms { center: vec2f, wave: f32, tint: vec4f, speed: f32 }
fn shade(uv: vec2f) -> vec4f {
  // Columns of glyphs 12 × 16 pt, each falling at its own speed; about
  // half the columns are dark, so the streams read one by one.
  let g = uv * nsh.size / vec2f(12.0, 16.0);
  let cell = floor(g);
  let t = nsh.time * uniforms.speed;
  let live = step(0.45, hash(vec2f(cell.x, 3.0)));
  let speed = 3.0 + hash(vec2f(cell.x, 1.0)) * 5.0;
  let head = t * speed + hash(vec2f(cell.x, 2.0)) * 60.0;
  let phase = fract((head - cell.y) / 40.0);
  // A short trail behind the head, then nothing until the next stream.
  let trail = pow(clamp(1.0 - phase * 2.5, 0.0, 1.0), 2.0) * live;
  let lead = step(phase, 0.025) * live;
  // The ripple: a ring from the tapped point that lights and scrambles the glyphs it passes.
  // Measured in cells from the cell centers, so the ring steps glyph by glyph.
  let tap = floor(uniforms.center * nsh.size / vec2f(12.0, 16.0));
  let d = length((cell - tap) * vec2f(1.0, 1.4));
  let front = uniforms.wave * 14.0;
  let fade = 1.0 - uniforms.wave;
  let ring = step(abs(d - front), 0.8) * fade;
  let inside = step(d, front - 0.8) * step(front - 4.0, d) * fade;
  // A glyph: 3 × 5 bits from a hash of the cell, mirrored left to right
  // as many katakana-like shapes are; it changes now and then (often under the ring).
  let rate = 0.8 + hash(cell) * 1.2 + ring * 20.0;
  let id = hash(cell + vec2f(floor(t * rate) * 13.0, 0.0)) * 4096.0;
  let f = (fract(g) - vec2f(0.2, 0.15)) / vec2f(0.6, 0.7);
  let bit = floor(f * vec2f(3.0, 5.0));
  let column = min(bit.x, 2.0 - bit.x);
  let on = step(0.5, hash(vec2f(id + column * 7.0, bit.y * 31.0 + id)))
    * step(0.0, f.x) * step(f.x, 1.0) * step(0.0, f.y) * step(f.y, 1.0);
  let level = max(trail, inside * 0.5) + ring * 1.2;
  var color = uniforms.tint.rgb * on * level;
  color += vec3f(0.8, 1.0, 0.85) * on * (lead + ring * 0.6);
  color += uniforms.tint.rgb * ring * 0.18;
  color += vec3f(0.0, 0.015, 0.005);
  return vec4f(color, 1.0);
}`;

const HOLO = /* wgsl */ `${NOISE}
struct Uniforms { tilt: f32 }
fn glow(p: vec2f, center: vec2f, size: f32) -> f32 {
  let d = p - center;
  return exp(-dot(d, d) / (size * size));
}
fn shade(uv: vec2f) -> vec4f {
  let aspect = vec2f(nsh.size.x / max(nsh.size.y, 1.0), 1.0);
  let p = uv * aspect;
  let px = 1.0 / max(nsh.size.y, 1.0);
  let t = nsh.time * 0.25;
  // The logo's lime with teal and blue, as soft lights on deep ink; tilting slides them.
  let lime = vec3f(0.78, 0.93, 0.42);
  let teal = vec3f(0.08, 0.72, 0.65);
  let blue = vec3f(0.23, 0.51, 0.96);
  let shift = uniforms.tilt * 0.12;
  var light = vec3f(0.0);
  light += lime * glow(p, vec2f(0.82 + shift + 0.04 * sin(t), 0.2 + 0.06 * cos(t * 0.8)) * aspect, 0.34) * 0.9;
  light += teal * glow(p, vec2f(0.62 - shift * 0.5 + 0.05 * cos(t * 0.7), 0.85) * aspect, 0.42) * 0.8;
  light += blue * glow(p, vec2f(1.0 + 0.04 * sin(t * 0.6 + 1.0), 0.75) * aspect, 0.3) * 0.7;
  // Keep the left, where the text is, dark.
  light *= smoothstep(0.0, 0.75, uv.x);
  var color = vec3f(0.02, 0.03, 0.03) + (vec3f(1.0) - exp(-light * 1.3)) * 0.9;
  // A faint dot grid, brighter where the lights are.
  let cell = fract(p / (8.0 * px)) - 0.5;
  let dots = smoothstep(0.14, 0.06, length(cell));
  color += vec3f(1.0) * dots * (0.015 + 0.06 * length(light));
  // The band of light the tilt sweeps across.
  let s = uv.x * 0.7 + uv.y * 0.3 - 0.55 - uniforms.tilt * 0.5;
  color += vec3f(exp(-s * s * 30.0) * 0.05);
  color += vec3f((hash(uv * nsh.size * nsh.scale + 7.0) - 0.5) * 0.03);
  return vec4f(color, 1.0);
}`;

/** Pointer handlers that report where a drag is, as a fraction of the view. */
function drag(onMove: (x: number, y: number) => void) {
  let size = { width: 1, height: 1 };
  const at = (e: { locationX: number; locationY: number }) => onMove(Math.min(Math.max(e.locationX / size.width, 0), 1), Math.min(Math.max(e.locationY / size.height, 0), 1));
  return {
    onLayout: ({ bounds }: { bounds: { size: { width: number; height: number } } }) => (size = bounds.size),
    onStartShouldSetResponder: () => true,
    // Keep the touches: the scroll view around must not take them.
    onResponderTerminationRequest: () => false,
    onResponderGrant: (e: { locationX: number; locationY: number }) => {
      at(e);
      return true;
    },
    onResponderMove: at,
  };
}

const GLOW_COLORS = ["#f43f5e", "#7c3aed", "#2563eb"];

function Glow() {
  const x = createAnimatedValue(0.5);
  const y = createAnimatedValue(0.5);
  const follow = (px: number, py: number) => {
    Animated.spring(x, { toValue: px }).start();
    Animated.spring(y, { toValue: py }).start();
  };
  return (
    <Card icon="spark" title="Glow" subtitle="Soft orbs of light that blend">
      <View style={{ gap: 12 }}>
        <Shader
          source={GLOW}
          uniforms={{ a: GLOW_COLORS[0], b: GLOW_COLORS[1], c: GLOW_COLORS[2], pointer: [x, y] }}
          style={{ height: 200, borderRadius: 14 }}
          {...drag(follow)}
        />
        <Caption label="Drag to lead a blue orb; the light rolls off as it adds up." />
      </View>
    </Card>
  );
}

function Plasma() {
  const x = createAnimatedValue(0.5);
  const y = createAnimatedValue(0.5);
  return (
    <Card icon="canvas" title="Plasma" subtitle="Sums of sines through a cosine palette">
      <View style={{ gap: 10 }}>
        <Shader
          source={PLASMA}
          uniforms={{ pointer: [x, y] }}
          style={{ height: 200, borderRadius: 14 }}
          {...drag((px, py) => {
            x.set(px);
            y.set(py);
          })}
        />
        <Caption label="Drag across it: the pointer is a second wave source." />
      </View>
    </Card>
  );
}

/** A control over the code rain, a word on a terminal: bright when chosen. */
function Chip(props: { label: string; selected?: boolean; onPress: () => void }) {
  return (
    <Press accessibilityLabel={props.label} accessibilityState={{ selected: props.selected }} onPress={props.onPress} style={{ paddingHorizontal: 6, paddingVertical: 2 }}>
      <Text style={{ color: props.selected ? "#d9ffe4" : "#4ade80", fontFamily: mono, fontSize: 12, fontWeight: props.selected ? "700" : "400", opacity: props.selected ? 1 : 0.7 }}>
        {props.label}
      </Text>
    </Press>
  );
}

function Ripple() {
  const speed = signal(1);
  const wave = createAnimatedValue(0);
  const center = { x: createAnimatedValue(0.5), y: createAnimatedValue(0.5) };
  const tint = wave.interpolate({ inputRange: [0, 1], outputRange: ["#4ade80", "#16a34a"] });
  const loop = Animated.loop(Animated.timing(wave, { toValue: 1, duration: 2200, easing: Easing.out(Easing.quad) }));
  loop.start();
  cleanup(() => loop.stop());
  const fire = (x: number, y: number) => {
    loop.stop();
    center.x.set(x);
    center.y.set(y);
    wave.set(0);
    loop.start();
  };
  let size = { width: 1, height: 1 };
  return (
    <Card icon="gestures" title="Code rain" subtitle="Animated values as uniforms">
      <View style={{ gap: 10 }}>
        <Shader
          source={RIPPLE}
          uniforms={{ center: [center.x, center.y], wave, tint, speed: speed() }}
          style={{ height: 200, borderRadius: 14, padding: 16, justifyContent: "flex-end" }}
          onLayout={({ bounds }) => (size = bounds.size)}
          onStartShouldSetResponder={() => true}
          onResponderGrant={(e) => fire(e.locationX / size.width, e.locationY / size.height)}
        >
          {/* Claims the touches over the controls, so the shader under them starts no ripple of its own. */}
          <View
            style={{ flexDirection: "row", alignItems: "center", alignSelf: "flex-start", paddingHorizontal: 6, paddingVertical: 4, borderRadius: 2, borderWidth: 1, borderColor: "rgba(74, 222, 128, 0.5)", backgroundColor: "rgba(2, 12, 5, 0.85)" }}
            onStartShouldSetResponder={() => true}
            onResponderTerminationRequest={() => false}
          >
            <Each of={[1, 2, 4]}>{(n) => <Chip label={`${n()}×`} selected={speed() === n()} onPress={() => speed.set(n())} />}</Each>
          </View>
        </Shader>
        <Caption label="Tap the rain to send a wave; pick how fast it falls." />
      </View>
    </Card>
  );
}

function Holo() {
  const tilt = createAnimatedValue(0);
  const loop = Animated.loop(
    Animated.sequence([
      Animated.timing(tilt, { toValue: 1, duration: 2600, easing: Easing.inOut(Easing.sin) }),
      Animated.timing(tilt, { toValue: -1, duration: 2600, easing: Easing.inOut(Easing.sin) }),
    ]),
  );
  loop.start();
  cleanup(() => loop.stop());
  const sweep = () => {
    loop.stop();
    tilt.set(-1);
    Animated.timing(tilt, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.cubic) }).start();
  };
  return (
    <Card icon="star" title="Hero banner" subtitle="Children drawn over the shader">
      <View style={{ gap: 10 }}>
      <Shader
        source={HOLO}
        uniforms={{ tilt }}
        style={{ height: 200, borderRadius: 14, paddingHorizontal: 20, paddingVertical: 16, justifyContent: "space-between" }}
        {...drag((x) => {
          loop.stop();
          tilt.set(x * 2 - 1);
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Image src={logo} style={{ width: 26, height: 26 }} />
          <Text style={{ flex: 1, color: "#ffffff", fontSize: 15, fontWeight: "700" }}>Native Shell</Text>
          <View
            style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, borderWidth: 0.5, borderColor: "rgba(226, 251, 159, 0.3)", backgroundColor: "rgba(200, 236, 106, 0.1)" }}
          >
            <View style={{ width: 5, height: 5, borderRadius: 999, backgroundColor: "#c8ec6a", boxShadow: "0 0 6px rgba(200, 236, 106, 0.8)" }} />
            <Text style={{ color: "#e2fb9f", fontSize: 10, fontWeight: "600", letterSpacing: 1.2 }}>SHADERS</Text>
          </View>
        </View>
        <View style={{ gap: 12 }}>
          <View style={{ gap: 4 }}>
            <Text style={{ color: "#ffffff", fontSize: 20, fontWeight: "700" }}>Native UI, delivered at run time</Text>
            <Text style={{ color: "#ffffff", fontSize: 13, opacity: 0.65 }}>Light swept by a looping animated uniform</Text>
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Press accessibilityLabel="Sweep light" style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8, backgroundColor: "#c8ec6a" }} onPress={() => sweep()}>
              <Text style={{ color: "#141a06", fontSize: 13, fontWeight: "600" }}>Sweep light</Text>
            </Press>
            <Press accessibilityLabel="Loop" style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8, backgroundColor: "rgba(255, 255, 255, 0.1)" }} onPress={() => loop.start()}>
              <Text style={{ color: "#ffffff", fontSize: 13, fontWeight: "600" }}>Loop</Text>
            </Press>
          </View>
        </View>
      </Shader>
      <Caption label="Drag sideways to move the light; the buttons sit over the shader." />
      </View>
    </Card>
  );
}

export function Shaders() {
  const cards = [Glow, Ripple, Holo, Plasma];
  return <DemoPage cards={cards} columns={2} />;
}
