import { cleanup, createAnimatedValue, Easing, mount, Shader, signal, Text, View } from "nsh";
import { Animated, type CompositeAnimation } from "nsh";
import { Button, Switch } from "nsh/base";
import { button, buttonText, desktop, focusRing, hoverFill, Log, Panel, Segmented, size, Split, ui } from "./palette";

// A shader's colors come from uniforms; a tap starts a ripple, an animated
// uniform that runs natively; `paused` stops the shader's clock.
const SOURCE = /* wgsl */ `
struct Uniforms { a: vec4f, b: vec4f, c: vec4f, center: vec2f, wave: f32 }

fn shade(uv: vec2f) -> vec4f {
  let t = nsh.time * 0.4;
  let warp = vec2f(sin(uv.y * 4.0 + t * 1.3), cos(uv.x * 3.0 - t)) * 0.08;
  let q = uv + warp;
  let ab = mix(uniforms.a.rgb, uniforms.b.rgb, smoothstep(0.0, 1.0, q.x + 0.2 * sin(t)));
  var color = mix(ab, uniforms.c.rgb, smoothstep(0.2, 1.0, q.y + 0.15 * cos(t * 0.7)));
  let aspect = nsh.size / max(nsh.size.x, nsh.size.y);
  let d = distance(uv * aspect, uniforms.center * aspect);
  let ring = exp(-pow((d - uniforms.wave * 0.9) * 24.0, 2.0)) * (1.0 - uniforms.wave);
  color += vec3f(ring * 0.8);
  return vec4f(color, 1.0);
}`;

const PALETTES = {
  sunset: ["#ff6b6b", "#ffb86b", "#7b5cff"],
  lagoon: ["#00c2a8", "#2f80ed", "#0b3d91"],
  citrus: ["#f9f871", "#9be15d", "#ff9671"],
} as const;
type Palette = keyof typeof PALETTES;

function App() {
  const palette = signal<Palette>("sunset");
  const paused = signal(false);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 5));
  const wave = createAnimatedValue(1);
  const cx = createAnimatedValue(0.5);
  const cy = createAnimatedValue(0.5);
  let box = { width: 1, height: 1 };
  let ripple: CompositeAnimation | undefined;
  cleanup(() => ripple?.stop());
  const tap = (x: number, y: number) => {
    ripple?.stop();
    cx.set(x);
    cy.set(y);
    wave.set(0);
    ripple = Animated.timing(wave, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad) });
    ripple.start();
    log(`Ripple at ${Math.round(x * 100)}%, ${Math.round(y * 100)}%`);
  };
  const colors = () => PALETTES[palette()];
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>shader</Text>
      <Text style={{ color: ui().muted }}>{desktop ? "Click the shader to start a ripple" : "Tap the shader to start a ripple"}</Text>

      <Split
        gap={14}
        width={760}
        inspector={
          <>
            <Segmented
              label="colors"
              options={["sunset", "lagoon", "citrus"] as const}
              value={palette()}
              onChange={(next) => {
                palette.set(next);
                log(`Colors: ${next}`);
              }}
            />
            <Panel title="paused · ripple">
              <Switch
                checked={paused()}
                onChange={({ checked }) => {
                  paused.set(checked);
                  log(checked ? "Paused: the clock stands still" : "Running");
                }}
                class={`-mx-2 flex-row-reverse items-center justify-between gap-3 rounded-lg px-2 ${desktop ? "py-1" : "py-2"} active:opacity-70`}
                hoverStyle={hoverFill()}
                focusStyle={focusRing()}
                trackClass={`${desktop ? "w-9" : "w-12"} rounded-full p-0.5 transition-colors motion-reduce:transition-none`}
                trackStyle={paused() ? ui().accentFill : ui().inset}
                thumbClass={desktop ? "size-4 rounded-full transition-transform motion-reduce:transition-none checked:translate-x-4" : "size-5.5 rounded-full transition-transform motion-reduce:transition-none checked:translate-x-5"}
                thumbStyle={paused() ? { backgroundColor: ui().onAccent } : ui().raised}
              >
                <Text style={{ flex: 1, fontSize: size.label, color: ui().text }}>Paused</Text>
              </Switch>
              <Button onPress={() => tap(0.5, 0.5)} {...button("secondary", { style: desktop ? { alignSelf: "flex-start" } : {} })}>
                <Text style={buttonText()}>Ripple</Text>
              </Button>
            </Panel>
            <Log title="events" lines={events()} minHeight={92} />
          </>
        }
      >
        <Shader
          testID="shader"
          source={SOURCE}
          paused={paused()}
          uniforms={{ a: colors()[0], b: colors()[1], c: colors()[2], center: [cx, cy], wave }}
          style={{ height: desktop ? 420 : 280, borderRadius: 16, padding: 18, justifyContent: "flex-end" }}
          onLayout={({ bounds }) => (box = bounds.size)}
          onStartShouldSetResponder={() => true}
          onResponderGrant={(e) => tap(e.locationX / box.width, e.locationY / box.height)}
        >
          <Text style={{ color: "#ffffff", fontSize: 15, fontWeight: "600" }}>Drawn by a WGSL shader, under its children</Text>
        </Shader>
      </Split>
    </View>
  );
}

mount(App);
