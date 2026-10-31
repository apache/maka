---
title: Shader
description: "The Shader element: a view whose box a GPU program written in WGSL draws, under its children."
order: 70
group: primitives
demo: el-shader
---

# Shader

A shader is a view whose box a GPU program draws: gradients that flow, noise and grain, plasma, aurora, holographic
foil, ripples that follow a tap. You write one WGSL function, `shade`, that gives the color of each point of the box;
the platform runs it on the GPU at the screen's resolution, over the view's background and under its children.
Animated values move it natively, frame by frame, with no work in the app's code. TSX makes one with `<Shader>` from
`nsh`, Rust with `shader().source(program)`.

```rust tabs
use nsh_core::{prelude::*, shader::Shader};

const GLOW: &str = r#"
struct Uniforms { tint: vec4f }

fn shade(uv: vec2f) -> vec4f {
  let d = distance(uv, vec2f(0.5));
  let pulse = 0.5 + 0.5 * sin(nsh.time * 2.0);
  let glow = smoothstep(0.5, 0.0, d) * (0.6 + 0.4 * pulse);
  return vec4f(uniforms.tint.rgb * glow, 1.0);
}
"#;

fn glow() -> impl IntoElement {
    let program = Shader::compile(GLOW).expect("a valid shader");
    shader()
        .source(program)
        .uniform("tint", Hsla::from(rgb(0x38bdf8)))
        .h(px(200.0))
        .rounded(px(14.0))
}
```

```tsx tabs
import { mount, Shader } from "nsh";

const GLOW = /* wgsl */ `
struct Uniforms { tint: vec4f }

fn shade(uv: vec2f) -> vec4f {
  let d = distance(uv, vec2f(0.5));
  let pulse = 0.5 + 0.5 * sin(nsh.time * 2.0);
  let glow = smoothstep(0.5, 0.0, d) * (0.6 + 0.4 * pulse);
  return vec4f(uniforms.tint.rgb * glow, 1.0);
}`;

function Glow() {
  return <Shader source={GLOW} uniforms={{ tint: "#38bdf8" }} style={{ height: 200, borderRadius: 14 }} />;
}

mount(() => <Glow />);
```

## The shader

A shader's source is WGSL, the shading language of WebGPU. It defines one function:

```wgsl
fn shade(uv: vec2f) -> vec4f
```

- `uv` is the point of the view's box, from `(0, 0)` at its top left corner to `(1, 1)` at its bottom right, y
  growing downwards as in CSS.
- The result is the point's color: red, green, blue and alpha in 0..1, in sRGB with straight alpha, as CSS colors
  are. Values outside 0..1 are clamped.

Next to `shade` the source holds whatever helper functions, constants and `var<private>` variables it needs. NSH
supplies the entry points and reads the shader's inputs from two places.

### Built-ins

| Built-in | Type | Value |
|---|---|---|
| `nsh.size` | `vec2f` | The view's size in points. |
| `nsh.time` | `f32` | Seconds since the shader appeared. A shader that reads it animates: it draws every frame while it is on screen. |
| `nsh.scale` | `f32` | Pixels per point of the frame being drawn. |

`uv * nsh.size` is the point in points; `nsh.size.x / nsh.size.y` is the aspect ratio, which keeps circles round in
a box that is not square.

### Uniforms

Values the app sets go in a struct named `Uniforms`, which the shader reads as `uniforms`:

```wgsl
struct Uniforms {
  colors: array<vec4f, 4>,
  speed: f32,
  center: vec2f,
}

fn shade(uv: vec2f) -> vec4f {
  let t = nsh.time * uniforms.speed;
  // …
}
```

The `uniforms` prop sets its members by name. Each type takes these values:

| WGSL type | Values |
|---|---|
| `f32`, `i32`, `u32` | A number (rounded toward zero for `i32` and `u32`), or an animated value |
| `vec2f` | `[x, y]`: two numbers or animated values |
| `vec3f` | A color (its red, green and blue), an animated color, or three numbers |
| `vec4f` | A color with its alpha, an animated color, or four numbers |
| `array<vec4f, N>` | A list of up to `N` colors (or of four numbers each): a palette, the stops of a gradient |

Colors are any CSS color (`"#38bdf8"`, `"rgb(56 189 248)"`, `"hsl(199 93% 60%)"`) and reach the shader as sRGB
components in 0..1. Members the app leaves out are zero. Setting `uniforms` again draws the shader again with the new
values.

```tsx
const palettes = { Sunset: ["#ff6b6b", "#ffb86b", "#7b5cff", "#ff4fa3"], Lagoon: ["#00c2a8", "#2f80ed", "#a0f0ff", "#0b3d91"] };
const palette = signal<keyof typeof palettes>("Sunset");

<Shader source={MESH} uniforms={{ colors: palettes[palette()], speed: 0.5 }} style={{ height: 200 }} />;
```

## Animated uniforms

A uniform may be a [native animated value](../modules/nsh.md#animation), or a node derived from one
(`interpolate`, arithmetic). The platform writes its value into the shader on every frame it changes and draws again,
on the UI thread: the animation runs at full frame rate however busy the app's code is. Numbers animate `f32`, `i32`
and `u32` members and the components of a `vec2f`; an interpolation to colors animates a `vec3f` or `vec4f`.

```rust tabs
use nsh_core::{prelude::*, shader::Shader};

fn ripple(program: Shader) -> impl IntoElement {
    let wave = animated_value(0.0);
    wave.timing(1.0, 2200.0, Easing::Linear);
    shader()
        .source(program)
        .uniform("wave", &wave)
        .uniform("center", [0.5_f32, 0.5])
        .h(px(200.0))
}
```

```tsx tabs
import { Animated, cleanup, createAnimatedValue, Easing, Shader } from "nsh";

const RIPPLE = /* wgsl */ `
struct Uniforms { center: vec2f, wave: f32, tint: vec4f }
fn shade(uv: vec2f) -> vec4f {
  let d = distance(uv * nsh.size, uniforms.center * nsh.size) / max(nsh.size.x, nsh.size.y);
  let ring = exp(-pow((d - uniforms.wave * 0.75) * 28.0, 2.0)) * (1.0 - uniforms.wave);
  return vec4f(vec3f(0.03, 0.03, 0.06) + uniforms.tint.rgb * ring * 1.6, 1.0);
}`;

function Ripple() {
  const wave = createAnimatedValue(0);
  const tint = wave.interpolate({ inputRange: [0, 1], outputRange: ["#38bdf8", "#c084fc"] });
  const loop = Animated.loop(Animated.timing(wave, { toValue: 1, duration: 2200, easing: Easing.out(Easing.quad) }));
  loop.start();
  cleanup(() => loop.stop());
  return <Shader source={RIPPLE} uniforms={{ center: [0.5, 0.5], wave, tint }} style={{ height: 200, borderRadius: 14 }} />;
}
```

## Pausing

`paused` stops the shader's clock: `nsh.time` keeps its value and the shader holds its picture. Setting it back to
`false` starts the clock from where it stopped. Uniforms and size changes still draw a paused shader.

```tsx
const paused = signal(false);

<Shader source={AURORA} paused={paused()} style={{ height: 200 }} onPress={() => paused.set(!paused())} />;
```

A shader that does not read `nsh.time` draws when its size or its uniforms change, and holds its picture in between.

## Children and clipping

A shader is a container: it takes every prop of a [view](./view.md) (styles, padding and layout of its children,
press and gesture props, `onLayout`, accessibility, `ref`), and its children draw over the shader. The shader fills
the view's box the way a background does, inside its rounded corners (`borderRadius`), over its `backgroundColor`.

```tsx
<Shader source={HOLO} uniforms={{ tilt }} style={{ height: 200, borderRadius: 18, padding: 20, justifyContent: "space-between" }}>
  <Text style={{ color: "#ffffff", fontSize: 13, fontWeight: "600" }}>NATIVE SHELL</Text>
  <Text style={{ color: "#ffffff", fontSize: 26, fontWeight: "700" }}>4242 0000 1717</Text>
</Shader>
```

Give the shader a size through its styles (width / height, `flex`, an aspect ratio) or let its children size it.

## Props

A shader takes the props of a [view](./view.md) plus:

| Prop | Rust | Type | Description |
|---|---|---|---|
| `source` | `.source(program)` | `string` | The WGSL source defining `fn shade(uv: vec2f) -> vec4f`. Rust compiles it with `Shader::compile(source)`. |
| `uniforms` | `.uniform(name, value)` | `Record<string, ShaderUniform>` | The values of the members of `struct Uniforms`, by name: numbers, colors, animated values and lists of them. |
| `paused` | `.paused(bool)` | `boolean` | Stops the clock of `nsh.time`. Default `false`. |

## Errors

NSH checks every shader when its source is set, before it reaches the GPU. A shader that does not compile logs a
warning with the line and column in its source and what is wrong, for example:

```text
the shader of node 12: 2:1: `shade` takes the point's `uv: vec2f` and returns its color, a `vec4f`
```

The view then shows its background and children. A uniform the struct lacks, or a value its type does not take,
logs a warning naming the uniform, and the other uniforms apply.

Each source compiles once: views that share a source, and a source set again, use the compiled shader.

## Rules and limits

- `shade` has exactly the signature `fn shade(uv: vec2f) -> vec4f`. The source declares its own functions,
  constants, structs and `var<private>` variables; NSH supplies the entry points and the bindings.
- The source is at most 64 KiB.
- `struct Uniforms` takes at most 4096 bytes, with members of the types in the table above.
- A frame is at most 4096 pixels a side: a larger view draws its shader at a lower scale.

For noise, hash the integer cell a point is in (`bitcast<vec2u>(vec2i(floor(p)))` mixed with multiplies and
xor-shifts) rather than `fract(sin(…) * 43758.5)`: integer hashes give the same value for a cell everywhere it is
computed, so value noise stays seamless on every GPU. The gallery's shaders show one.

## Platforms

On iOS, Android, macOS, Windows and Linux, and in GPUI apps, NSH renders shaders on the GPU with wgpu (Metal on Apple
platforms, Vulkan, Direct3D 12 or OpenGL elsewhere) at the screen's scale, and shows each frame under the view's
children. Rendering runs alongside the UI: a frame appears one or two display frames after it is drawn, and the UI
stays responsive while the GPU works. On the web, NSH translates the shader to GLSL and draws it with WebGL 2.

Shaders draw at most once per display frame, and only when what they show changes: a shader with fixed uniforms draws
once, one that reads `nsh.time` every frame, and one with animated uniforms while they move.

## Rust

`shader()` (from `nsh_core::element`) makes a shader view; `.source(program)` gives it a compiled `Shader`
(`nsh_core::shader::Shader::compile(source)`, which returns the same errors as above). Compile a program once and
share it: it is cheap to clone. The program may be bound, `.source(move || …)`, to switch programs.

| Method | Description |
|---|---|
| `.uniform(name, value)` | Sets a member of `struct Uniforms`: a number, a `Color` or `Hsla`, `[f32; 2]` / `[f32; 3]` / `[f32; 4]`, or a `Vec<UniformValue>`. A bound value (`move \|\| …`) sets it again when it changes; an animated value (`&wave`: a number, or colors for a `vec3f` / `vec4f`) moves it on every frame, natively. |
| `.paused(bool)` | Stops the clock of `nsh.time`; bindable. |

Children are added with `.child(..)`, styles with the usual typed methods.
