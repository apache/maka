# Shaders

A shader view (`Shader` from `nsh`, the `shader` host element; Rust `nsh_core::element::shader()` with `.source(..)`) is a view whose
box a GPU program the app writes in WGSL draws, over the view's background and under its children. The program is
checked and wrapped in Rust (`nsh_core::shader`), rendered by wgpu on the native backends (`nsh_engine::shader`, feature `shader`) and by
WebGL 2 on the web, from GLSL ES the core translates it into. The module docs of `crates/nsh-core/src/shader.rs` and
`crates/nsh-engine/src/shader.rs` are the reference; this page is the overview.

## The contract

An app writes one function and whatever helpers and constants it needs:

```wgsl
struct Uniforms { tint: vec4f, speed: f32 }   // optional

fn shade(uv: vec2f) -> vec4f {
  let wave = 0.5 + 0.5 * sin(uv.x * 12.0 + nsh.time * uniforms.speed);
  return vec4f(uniforms.tint.rgb * wave, 1.0);
}
```

- `uv` is the point of the view's box, 0..1 from its top left corner (CSS's direction, y down).
- The result is straight (not premultiplied) sRGB with alpha, as CSS colors are: no linearization. The core's
  fragment entry point clamps it to 0..1 and premultiplies.
- Built-ins, read through `nsh` (`struct Nsh` at `@group(0) @binding(0)`): `nsh.size` (the box in points),
  `nsh.time` (seconds since the shader appeared, stopped while `paused`), `nsh.scale` (pixels per point of the frame
  being rendered). `nsh_core::shader::builtins` gives the four words the renderers upload.
- `struct Uniforms { … }`, when the source declares one (outside comments: `declares_uniforms`), is bound at
  `@binding(1)` as `uniforms`. Its members are set by name from the `uniforms` prop.

`Shader::compile` builds the module as the app's source first (so its line numbers stay the app's), then
`BUILTINS`, the uniforms' binding and `ENTRY_POINTS`: `nsh_vertex` (one triangle covering the target, no vertex
buffers) and `nsh_fragment`. Renderers draw `0..3` vertices with these two entry points.

## Validation and limits

Everything is checked in Rust before any platform sees the program (`Shader::compile`), with naga, the WGSL front end
wgpu and browsers' WebGPU share:

- the source is at most `MAX_SOURCE_BYTES` (64 KiB);
- it defines `fn shade(uv: vec2f) -> vec4f` with exactly that signature;
- it declares no entry points and no resources: its globals are `var<private>`, its inputs `nsh` and `uniforms`;
- `struct Uniforms` takes at most `MAX_UNIFORM_BYTES` (4096) and its members are `f32`, `i32`, `u32`, `vec2f`,
  `vec3f`, `vec4f` or `array<vec4f, N>` (`UniformType`; reflected with their offsets into `UniformField`s, the size
  rounded up to 16);
- the whole module validates (`ValidationFlags::all()`, no capabilities).

The module is parsed twice: without the entry points first, so an error is reported in the app's source rather than
in what calls `shade`, then with them. Errors (`ShaderError`) carry the 1-based line and column in the app's source
(0 when the error has no place in it); the validator's innermost span inside the source is the one reported.
`Shader::animated` is whether any function reads `nsh.time` (an `AccessIndex` of member 1 on the `nsh` global): only
those draw every frame.

Each frame is at most `nsh_engine::shader::MAX_SIDE` (4096) pixels a side; larger views render at a lower scale. A GPU
program that never ends is stopped by the operating system's GPU watchdog (the browser's on the web).

## The core: props, the compile cache and the mount item

`Tag::Shader` is a `Kind::Shader` node whose native view is a plain view (`ViewKind::View`), so it takes every view
prop and has children. Its own props (`ops.rs`): `ShaderSource` (`source`), `Shader` (a compiled program, Rust's),
`Uniforms` (`uniforms`, `ShaderUniforms`: names and `UniformValue`s) and `ShaderPaused` (`paused`, shared with
videos' `paused`). `Core::set_shader_prop` keeps them in the node's `ShaderNode`.

- **Compile cache.** `Core::shaders` maps `source_hash` to the compiled program or its error, so an app setting the
  same source again (another view, a list row, a hot reload) compiles once. It is bounded: at 64 entries it is
  cleared. A source that fails logs a warning (target `js`, `the shader of node N: line:column: message`) and the
  node shows no layer.
- **The layer.** Each prop change makes a new `ShaderLayer` (`ShaderLayer::new`): the program, the uniform words as
  the app set them, the animated slots and their animation nodes, `paused`. A uniform name the struct lacks, or a
  value that does not fit its type, is left out with a warning. When the layer equals the previous one nothing is
  sent; otherwise the node is marked `dirty::SHADER`, and `dirty::ANIMATION` too when the slots' nodes changed.
- **Mount item.** `MountItem::Shader { id, layer }` (`None`: nothing to draw) carries an `Arc<ShaderLayer>`; the
  platforms keep the `Arc`, nothing is copied per frame.

### Uniform packing and animated slots

`ShaderLayer::new` packs values into `shader.uniform_size() / 4` words (bit patterns of `f32`, `i32`, `u32`) at each
member's offset (`Packer::pack`):

| WGSL | Values |
|---|---|
| `f32`, `i32`, `u32` | a number (`i32` / `u32` rounded toward zero, `u32` at least 0) or an animated value |
| `vec2f` | a list of 2 numbers or animated values |
| `vec3f` / `vec4f` | a color (red, green, blue, and alpha for `vec4f`, 0..1 sRGB), an animated color, or a list of 3 / 4 numbers or animated values |
| `array<vec4f, N>` | a list of at most `N` colors or 4-number lists; the rest stay zero |

An animated value (`UniformValue::Animated`) becomes a value slot: a `UniformSlot { word, kind }` (`SlotKind::F32`,
`I32`, `U32`, `Rgb`, `Rgba`) and its node in `ShaderLayer::nodes`. Slot `n` is bound to the view as
`AnimationProp::CanvasArg(n)` in the node's animation bindings, next to a canvas drawing's slots (a view is one or
the other). The platform's animator hands each slot's value to the shader view, which writes it into its copy of the
words with `ShaderLayer::write_slot` and renders again: an animated uniform moves with no JS and no engine work per
frame. A new layer with the same program and slots keeps the values written into the animated slots
(`nsh_engine::shader::ShaderView::set_layer`, `op_sh` on the web), so a re-render of the app's component does not snap them
back.

In JS, `uniforms` is decoded natively (`host_values.rs`, `impl HostValue for ShaderUniforms`): numbers, CSS color
strings, animated nodes and lists of them, two levels deep. `dom.rs` keeps the animation nodes a view's `uniforms`
holds alive with the view. In Rust, `ShaderView::uniform(name, value)` takes any `IntoUniform`: anything
`IntoReactive<UniformValue>` (numbers, `Color`, `Hsla`, `[f32; 2..4]`, lists; a bound value sets it again when it
changes) or an animated value (`&AnimatedValue`, `&AnimatedNode`), whose node it keeps alive with the element.

## The renderer (`nsh_engine::shader`)

`nsh_engine::shader::Renderer` holds a wgpu device and queue, two bind group layouts (built-ins alone; built-ins and
uniforms) and the render pipelines by source hash (`None` for one the device refused, reported once with a `js`
warning). A backend opens it the first time a shader is mounted on a surface (Android: on the `NshView`, kept across
app loads), so an app without shaders opens no device. `Renderer::new` requests a low-power adapter on the primary
backends and GL (`WGPU_BACKEND` overrides) with WebGL 2's downlevel limits; where no adapter or device is found it is
`None` and shader views show their background and children. Uncaptured device errors are warnings, never panics.

`nsh_engine::shader::ShaderView` is one view's state on the main thread: the layer, its words with the animated slots
written in, size and scale, the clock of `nsh.time` (`Clock`: kept while paused), and its frames.

- **Rendering never waits for the GPU.** `render` draws into a texture and copies it into one of two read-back
  buffers mapped asynchronously; a later call finds a mapped buffer, copies the newest frame into `frame()` and
  returns `true`. A frame shows one or two display frames after it is rendered. With both buffers in flight the
  frame is skipped, so a slow GPU drops frames instead of stalling the main thread.
- **Frame pacing.** `wants_frame` is true while something it reads changed (`dirty`: layer, uniforms, an animated
  slot, size or scale), while it is animated and not paused, or while a frame is on its way back. Backends call
  `render` on their frame clock only while it is true, at most once per display frame.
- **Pixels.** Frames are 8-bit premultiplied, in the `PixelFormat` the backend asked for (`Rgba`: GDK, Core Graphics,
  Android; `Bgra`: Direct2D, GPUI), rows `stride` bytes apart (`Frame::rows`, `Frame::tight`).

## The platforms

Each backend has a `shader.rs` that takes `MountItem::Shader`, keeps a `ShaderView` per view, ticks it on the
platform's frame clock and shows the frames under the view's children, clipped to its rounded box as a background
is. Views out of sight stop rendering until they show again.

| Platform | Ticks on | Shows a frame as | Out of sight |
|---|---|---|---|
| Linux (GTK 4) | each view's tick callback | a `GdkMemoryTexture` appended in the view's snapshot, after the background, under text, images and children | `reveal` on the frame clock's layout, for views outside a clipping ancestor or the window |
| macOS (AppKit) | one frame callback of the surface's display link, at the window's backing scale | a `CGImage`, the contents of a sublayer under the children (`decor.rs` shapes it) | `shown`, from `Mounter::revisit` (rows scrolled away, screens under another) |
| iOS | a `CADisplayLink` of its own, at the screen's scale | a `CGImage` in a sublayer under the children | views outside any window render once back in one |
| Android | the UI-thread animator's `Choreographer`, kept ticking by `UiAnimation::outputs` while a view wants a frame | a bitmap of `Box.java`, filled by `NshView.shaderFrame` | — |
| Windows | the surface's frame ticker (`Surface::on_frame`), at the window's scale | a Direct2D bitmap drawn under the children (made again after a device loss) | `reveal`: hidden, concealed or detached views |
| GPUI | a frame client of its surface | a GPUI image (BGRA, straight, the view's opacity multiplied in, as canvases' pixmaps), whose replaced image leaves GPUI's atlases | views not drawn in the last frame |
| Web | `requestAnimationFrame` | a `<canvas>` under the children | `IntersectionObserver` |

On Android the layer stays in `libnsh`: the encoder sends Java only whether a view shows a shader (opcode `SHADER`,
35, in `encode.rs` ↔ `Mounter.java`), Java reports the size in pixels (`Native.shaderSize`), and the layer goes to
the UI-thread renderer with the animation items. On Windows animated uniforms are written while the animation graph
is borrowed, so the views they start are queued and started after (`set_args`, `start_pending`).

## The web

The web backend uses WebGL 2. `Shader::glsl_es` (feature `glsl` of `nsh-core`, which `nsh-platform-web` turns on)
translates the validated module with naga's GLSL back end to GLSL ES 3.00 once per program and keeps it: the vertex
and fragment shaders and the names of the built-ins' and uniforms' uniform blocks (bound to 0 and 1). Bounds checks
are `Restrict`, so out-of-range indices read in range as they do under wgpu. `nsh-platform-web/src/shader.rs`
encodes the layer for `nsh.js`'s `op_sh` as JSON: the program's key (its hash), both shaders, the block names, the
words, the slots as `[word, kind]`, `animated` and `paused`.

`nsh.js` draws every shader view with one shared WebGL 2 context (`shaderGl`, on an `OffscreenCanvas` where there is
one), since a page gets few contexts: programs are cached by key (`shaderProgram`), each view renders into the shared
canvas at its size times the device pixel ratio and zoom (at most 4096 a side), and the picture moves to the view's
own `<canvas class="nsh-shader">` (`transferToImageBitmap` into a `bitmaprenderer`, or `drawImage`), which is
inserted first among the view's children and inherits its `border-radius`. `shaderFrame` runs on
`requestAnimationFrame` for views that are connected, in sight (an `IntersectionObserver`) and dirty or running;
animated values arrive as `op_a`'s `canvas:N` props and are written by `shaderSlot`.

## Pitfalls

- **The y direction on the web.** The GLSL is written without `WriterFlags::ADJUST_COORDINATE_SPACE`: the shared
  canvas is shown as it is drawn (its picture moved to the view's canvas, top row first), and WGSL's clip space
  (+y up) is GL's too. wgpu's GL backend sets the flag because it renders into textures read top-down; here it would
  turn every shader upside down.
- **Hashes in app shaders.** The classic `fract(sin(dot(p, k)) * 43758.5453)` hash gives discontinuous value noise:
  the large multiplier amplifies rounding differences, and two evaluations of one lattice corner (from neighbouring
  cells) differ once a GPU compiler reorders the arithmetic, so seams show along cell edges and differ between GPUs.
  Use an integer hash of the cell (`bitcast<vec2u>(vec2i(floor(p)))` mixed with multiplies and xor-shifts), as the
  gallery's `examples/gallery/demos/Shaders.tsx` does.
- **Premultiplied alpha.** `shade` returns straight alpha; the core premultiplies and the renderers draw with blending
  off, so frames are premultiplied (GPUI's images are straight: its backend converts). Do not premultiply again on a
  platform.
- **Readback latency.** Native frames arrive one or two display frames after `render`; a backend must keep ticking
  while `ShaderView::pending()` is true, or the last frame of a change never shows.
