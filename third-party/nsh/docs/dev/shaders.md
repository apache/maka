# Shaders

A shader view (`Shader` from `nsh`, the `shader` host element; Rust `nsh_core::element::shader()` with `.source(..)`) is a view whose
box a GPU program the app writes in WGSL draws, over the view's background and under its children. The program is
checked and wrapped in Rust (`nsh_core::shader`), rendered by wgpu on the native backends (`nsh_engine::shader`, feature `shader`) and by
WebGL 2 on the web, from GLSL ES the core translates it into. The module docs of `crates/nsh-core/src/shader.rs` and
`crates/nsh-engine/src/shader.rs` are the reference; this page is the overview.

## Feature `shader`

The platform crates' feature `shader` (`nsh-platform-*`, `nsh-*-app`; on by default, and always with `dev`) is what links
naga and wgpu. Off, `Shader::compile` refuses every source (`nsh-core`), `nsh_engine::shader::Renderer::new` is `None`
(`shader_off.rs`), shader views draw nothing and shader transitions end at once. The rest of the API stays. It is for
Rust apps and embedders; the prebuilt runners an app without Rust crates ships have it on. The web links its compiler
by what the app imports (`docs/dev/browser-js-size.md`), and GPUI always has it. A crate with `default-features = false`
names the feature to keep shaders: `features = ["shader"]`. The other optional parts are in [features.md](features.md).

Apps learn whether shaders draw from `Environment::shaders` (TS `shadersAvailable()`, Rust `shaders_available()`),
which `Shader::compile` cannot tell: it only says a source is valid. Each platform starts it at
`nsh_engine::shader::LINKED` (`true` on the web, whose page reports `shaders: false` once its WebGL 2 context fails);
when its `Renderer::new` finds no GPU it calls
`EngineControl::shaders_unavailable`, and the engine keeps it `false` from then on, for later environments and for
engines started after it in the same process. The engine also reports `false` on a grid surface. Headless runs keep the
default, `true`.

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

An animated value (`UniformValue::Animated`) is bound to the view through the animation graph, so an animated
uniform moves with no JS and no engine work per frame, and a re-render of the app's component keeps its current
value (`ShaderLayer::write_slot`, `nsh_engine::shader::ShaderView::set_layer`).

In JS, `uniforms` is decoded natively (`host_values.rs`, `impl HostValue for ShaderUniforms`): numbers, CSS color
strings, animated nodes and lists of them, two levels deep. `dom.rs` keeps the animation nodes a view's `uniforms`
holds alive with the view. In Rust, `ShaderView::uniform(name, value)` takes any `IntoUniform`: anything
`IntoReactive<UniformValue>` (numbers, `Color`, `Hsla`, `[f32; 2..4]`, lists; a bound value sets it again when it
changes) or an animated value (`&AnimatedValue`, `&AnimatedNode`), whose node it keeps alive with the element.

## The renderer (`nsh_engine::shader`)

`nsh_engine::shader::Renderer` holds a wgpu device and queue, two bind group layouts (built-ins alone; built-ins and
uniforms) and the render pipelines by source hash (`None` for one the device refused, reported once with a `js`
warning). A backend opens it the first time a shader is mounted on a surface (Android: on the `NshView`, kept across
app loads), so an app without shaders opens no device. `Renderer::new` requests a low-power adapter with WebGL 2's
downlevel limits backend by backend (Linux: GL, then the primary ones; elsewhere the primary ones and GL at once;
no setting chooses one) and keeps the first whose device opens, so an adapter that refuses its device gives the
next backend its turn; where none opens it is `None` and shader views show their background and children. Uncaptured device errors are warnings, never panics.

`nsh_engine::shader::ShaderView` is one view's state on the main thread: the layer, its uniforms, size and scale, the
clock of `nsh.time` (kept while paused), and its frames.

- **Rendering never waits for the GPU.** Frames are read back asynchronously; a slow GPU drops frames instead of
  stalling the main thread.
- **Frames on IOSurfaces (Apple).** After `show_on_surfaces`, a view renders into one of three IOSurfaces of its frame's
  size (`shader_surfaces.rs`), tagged sRGB, instead of reading pixels back: `surface()` is the frame to show, which the
  backend sets as its layer's `contents`, and the window server matches its colours to the display on the GPU. A
  surface the window server still uses is not rendered into again (`IOSurfaceIsInUse`); with none free the frame is
  skipped. `frame()` stays empty; `set_input_from_frame` copies the frame shown on the GPU (a transition that starts
  over a running one). Where the device is not Metal's, frames are read back.
- **Frame pacing.** `wants_frame` is true while something it reads changed, while it is animated and not paused, or
  while a frame is on its way back. Backends call `render` on their frame clock only while it is true, at most once
  per display frame.
- **Pixels.** Frames are 8-bit premultiplied, in the `PixelFormat` the backend asked for (`Rgba`: GDK, Core Graphics,
  Android; `Bgra`: Direct2D, GPUI), rows `stride` bytes apart (`Frame::rows`, `Frame::tight`).

## The platforms

Each backend has a `shader.rs` that takes `MountItem::Shader`, keeps a `ShaderView` per view, ticks it on the
platform's frame clock and shows the frames under the view's children, clipped to its rounded box as a background
is. Views out of sight stop rendering until they show again.

| Platform | Ticks on | Shows a frame as | Out of sight |
|---|---|---|---|
| Linux (GTK 4) | each view's tick callback | a `GdkMemoryTexture` appended in the view's snapshot, after the background, under text, images and children | `reveal` on the frame clock's layout, for views outside a clipping ancestor or the window |
| macOS (AppKit) | one frame callback of the surface's display link while frames change with time, pictures are due or anything else wants frames; a view that only changed renders after the batch and shows its frame when the GPU says it is done (`Renderer::when_done`), without the display link; at the window's backing scale | an IOSurface (`show_on_surfaces`), the contents of a sublayer under the children (`decor.rs` shapes it); a `CGImage` without Metal | `shown`, from `Mounter::revisit` (rows scrolled away, screens under another) |
| iOS | a `CADisplayLink` of its own, at the screen's scale | an IOSurface (`show_on_surfaces`), the contents of a sublayer under the children; a `CGImage` without Metal | views outside any window render once back in one |
| Android | the UI-thread animator's `Choreographer`, kept ticking by `UiAnimation::outputs` while a view wants a frame | a bitmap of `Box.java`, filled by `NshView.shaderFrame` | — |
| Windows | the surface's frame ticker (`Surface::on_frame`), at the window's scale | a Direct2D bitmap drawn under the children (made again after a device loss) | `reveal`: hidden, concealed or detached views |
| GPUI | a frame client of its surface | a GPUI image (BGRA, straight, the view's opacity multiplied in, as canvases' pixmaps), whose replaced image leaves GPUI's atlases | views not drawn in the last frame |
| Web | `requestAnimationFrame` | a `<canvas>` under the children (an effect's and a running transition's over them) | `IntersectionObserver` |

### Effects and transitions

Effects (`ShaderEffect`, `ScreenEffect`), transitions (`ShaderTransition`, `ScreenTransition`) and pages' and
dialogs' `transitionShader` read pictures the platform takes of views (`ShaderView::set_input`). The table says how
each platform that draws them does it; the others ignore `MountItem::ShaderTransition`, `ShaderInput` and `NavShader`
(the children show as they are, pages and dialogs come with their `animation`).

| Platform | Pictures | Hides the children, keeps their input | Over them | Pages and dialogs |
|---|---|---|---|---|
| macOS (AppKit) | `renderInContext:` of the children's container (`NshView::ensure_container`) without its mask, at the window's backing scale (a screen's: all the root shows but the frames over it); the backdrop: the root without the view's layer and the layers that draw over it (after it and after each ancestor by `zPosition`, then order: later views, effects' frames, borders in front) and the trees that draw nothing in the box and `overflow` (`shader::cull`: a list's rows away from it), hidden while it draws (`renderInContext:` rasterizes every layer it is given), only the box and `overflow` drawn | an empty `mask` on the container's layer (AppKit hit-tests views), which the decoration's clipping leaves in place until they show again (`decor::hide_children`); the root's while any screen shader hides it | the frames' sublayer at `zPosition` 1e6, `overflow` points beyond the box; a screen's on the root, which it leaves when its view is deleted or the app stops | the motion drawn through a layer over the stack (the root for a dialog) from pictures of it without and with the upper side (a page or dialog that left: its last image), taken on the first display frame, the live side again on the next three and after a view under it changed; the views at rest under it until it ends (`navigation::Motion::Shader`); popping and dismissing run backwards |
| iOS | `renderInContext:` of a view holding the children (`Decor::set_effect`, the view children are added to) without its mask, at the screen's scale; the backdrop: the window with the view's layer at opacity 0 | an empty `mask` on that view's layer (UIKit hit-tests views); the root view's while any screen shader hides it | the frames' sublayer at `zPosition` 1e6, `overflow` points beyond the box; a screen's on the root view (dialogs, presented by UIKit above it, are outside) | the screens change and the dialog is presented or dismissed at once, under a layer over the window's part where the surface (the stack) is, from pictures before the change (taken when the app removes the page or the dialog, before its views go: `Shaders::hold`) and after it (the first tick, the window laid out first), every other overlay left out of both; it stays until the frames on their way when the run ends have shown; a change of the same stack (of the surface, for a dialog) that starts while one runs ends that one first; popping and dismissing run backwards |

macOS retakes an effect's pictures on the display frame after the core says they changed (`MountItem::ShaderInput`) or
the platform changed a view in them (`NshView::changed`, `moved`, `redraw_rect`, a scroll view's offset), at most once
per frame, and only those its program reads (`ShaderState::reads_children`: a screen effect that never calls
`sample_content` does not picture the surface again when a view in it moves); a transition pictures its children (or its
running frame) as its `from` when it starts and takes `to` again as its children change. Each picture draws into a
bitmap context it keeps (`Canvas`), made again only when its size changes. A page's or a dialog's overlay (`NavOverlay`)
pictures both sides on its first display frame; its live side (the upper one coming, the lower going) again on the next
three, while AppKit lays out and draws what navigation just showed, and after that only when a view under its host
changed (`Mark`, set by `ui_changed`, which looks only at the surface the changed view is in). Its run is the shader's
own clock; the motion under it ends `LINGER` (50 ms) later, so the frames still on their way back from the GPU show
before it goes. A backdrop reader's picture is taken again when the core marks it or a view that draws under
it changed where it reads (`shader::behind`: an ancestor or a layer before it, not one in it or over it, whose tree,
clipped by its ancestors that clip, with its shadow, meets the box and `overflow`; looked at before a move or restyle
and after it), or a shader's frame showed there; one with the pixels of the last is not given to the shader again
(`picture_hash`). A view that comes back into sight takes the pictures that fell due while it was out of it (`shown`).
What pictures cost on the main thread is in [macos.md](macos.md) "Shader pictures". `renderInContext:` draws no video or
web page, nor backdrop blur or glass. The pictures of views AppKit has just shown again (navigation hides the screens
under the top one) wait for the next display frame: until AppKit displays the window their layers are out of the tree,
where they draw y up.

Where there is no GPU device (`Renderer::new` is `None`) macOS masks no children: an effect or a screen effect
shows them as they are, a transition starts no run, and a page's or a dialog's `transitionShader` leaves the change
to its own `animation`.

iOS retakes an effect's pictures on the display frame after the core says they changed (`MountItem::ShaderInput`) or
the platform changed a view in them (animated values, scrolling, image loads), at most once per frame, and only those
its program reads (`reads_children`: a screen effect that never calls `sample_content` does not picture the root again
when a view in it changes); a transition pictures its children (or its running frame) as its `from` when it starts
and takes `to` again as its children change. Each picture draws into a bitmap context it keeps (`Canvas`), made again
only when its size changes. `renderInContext:` draws no video or web page, nor backdrop blur or glass. A shader view
outside any window keeps its pictures due and takes them once a page shows again or the surface moves to a window
(`Shaders::revisit`). The app usually releases a page or a dialog it removes in the same batch: the mounter keeps the
page's shader and animation and the picture of what showed from the removal on (`Mounter::remove_hosted`), and a
dialog released while it shows closes through its shader too. The overlays leave the window when the app stops or
reloads (`Shaders` drops them), and the root's children leave the view screen shaders draw them from
(`Decor::set_effect`) when the last screen shader goes.

Where there is no GPU device (`Renderer::new` is `None`) iOS masks no children: an effect or a screen effect shows
them as they are, a transition starts no run, and a page's or a dialog's `transitionShader` leaves the change to
its own `animation`, as it does when Reduce Motion is on.

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
one), since a page gets few contexts: programs are cached by key (`shaderProgram`), each view renders into the top-left
corner of the shared canvas at its size times the device pixel ratio and zoom (at most 4096 a side), and the picture
is copied on the GPU into the view's own `<canvas class="nsh-shader">` (`drawImage` of that corner), which is inserted
first among the view's children and inherits its `border-radius`. The shared canvas fits the largest view that draws
(`sharedCanvas`): setting a canvas's size reallocates its drawing buffer, and a canvas resized to each view in turn
(a screen effect drawn among small shaders: twice a frame) costs more than the frames. It shrinks to the views that
drew once they have needed less for a second (`fitSharedCanvas`). `shaderFrame` runs on `requestAnimationFrame` for
views that are connected, in sight (an `IntersectionObserver`) and dirty or running, one callback at a time
(`shaderFrameQueued`); animated values arrive as `op_a`'s `canvas:N` props and are written by `shaderSlot`.

## Effects, transitions and pictures

Effects, transitions and page shaders sit on the same program, layer and renderer (`ShaderRole` on the layer):

- **Pictures.** `BUILTINS` declares a sampler at `@binding(2)` and four `texture_2d<f32>` at `@binding(3)` to
  `@binding(6)` with `sample_content`, `sample_backdrop`, `sample_from` and `sample_to`, which map the box's `uv` into
  the picture (it covers the box and `nsh.overflow` points beyond each side), unpremultiply, and read transparent
  outside it. `Shader::inputs` reflects which of their textures `nsh_fragment` uses (naga's `FunctionInfo`, which
  follows calls, so a helper of any name counts and one `shade` never calls does not); a program that reads none
  takes upstream's two bind group layouts, one that reads any the two with the pictures
  (`nsh_engine::shader::layout_index`). The web reads the pictures' sampler uniforms from `GlslProgram::pictures`.
- **Built-ins.** `struct Nsh` is 32 bytes: `size`, `time`, `scale`, `progress`, `overflow`, which `@size(12)` pads
  (wgpu refuses a uniform struct whose size is no multiple of 16 where the device lacks
  `BUFFER_BINDINGS_NOT_16_BYTE_ALIGNED`, as GLES on an arm64 Android emulator does). The vertex stage maps the target
  to `uv` from `-overflow / size` to `1 + overflow / size`, so binding 0 is visible to both stages.
- **Elements.** `ShaderEffect`, `ShaderTransition`, `ScreenEffect` and `ScreenTransition` are `Kind::Shader` nodes
  whose `ShaderNode::role` comes from their tag; the screen ones are absolutely positioned and 0 × 0. `progress` is a
  number or an animated value (one more slot whose word is `PROGRESS_WORD`, written into the built-in by
  `ShaderView::set_slot`), `maxSampleOffset` the layer's `overflow`. A transition without `source` takes
  `crossfade()` unless `fallback` is `"none"`.
- **Starts.** When a transition's `value` changes (not its first), `set_shader_prop` queues
  `MountItem::ShaderTransition { id, duration }` and `commit` puts the queue first in the batch, so the platform takes
  the `from` picture before applying the batch. `ShaderView::start_transition` runs `nsh.progress` from 0 to 1; once
  it ends (`transitioning`) the `from` picture goes and the children show as they are (`replaces_children`).
- **Marks.** `Core::pictured` holds the views whose layers read pictures or cover the screen. After a commit,
  `mark_shader_inputs` sends `MountItem::ShaderInput` for every effect or transition with a view of the batch in its
  subtree (`MountItem::view`) or a parent a view left (`Core::unlinked_from`, as a removed view has no parent left to
  walk up from); for every backdrop reader once a view that draws before it changed (`Core::draws_before`: an
  ancestor, or a view earlier in the order views draw in, siblings by `zIndex` then in order; never the reader, what
  it holds or what draws over it, which are not in its backdrop), or an item that shows everywhere (`shown_by`: the
  appearance, the tree's order, any item it does not know); and for every screen layer once anything changed. The
  platforms take those pictures again, and notice what changes on their UI thread themselves.
- **Pages and dialogs.** `transitionShader` (`NavShaderSpec`) compiles into a `Transition` layer sent as
  `MountItem::NavShader { id, shader }` (350 ms by default); the platform draws a push, pop, presentation or dismissal
  through it, the lower side `from` and the upper `to`.
  In Rust, `screen()` / `modal()` take `.transition_shader(TransitionShader::new(shader).uniform(..).duration(..))`
  (`nsh_core::shader::TransitionShader`, a compiled `Shader`), which sets the same prop. Sources compile once in
  `Core::compile`, the cache `Shader`'s `source` uses too ("Pages and dialogs" below says what the platforms do).
- **Android** (API 29 and later; Android 9 shows the children as they are). `Pictures.java` records the children
  into a `RenderNode`, renders it with a `HardwareRenderer` into an `ImageReader` and hands the rows to
  `Native.shaderInput` (rows `stride` apart, the last one without its padding, as the engine takes them). `Box.java`
  takes the role, overflow and inputs from the `SHADER` opcode: an effect pictures its children only after they drew
  anew (`onDescendantInvalidated`) or the core marks them (`SHADER_INPUT`), and draws its frame in `dispatchDraw`
  instead of them (touches and accessibility still reach them); a screen layer pictures the surface only after a view
  in it drew anew (`NshView.onDescendantInvalidated`) or the core marks it; a backdrop is pictured before every draw
  (`Backdrop.behind`), and `libnsh` drops one equal to the last; a transition pictures `from` before the batch
  (`SHADER_TRANSITION`) and shows it until the first frame. Screen layers draw over the app's view (`NshView`);
  dialogs, their own windows, are outside. Pages and dialogs (`NAV_SHADER`): `StackBox` and `ModalHost` run a
  `NavTransition.java` overlay over pictures of the two sides taken once; `nsh.progress` runs on the view's
  transition clock (`start_transition`, backwards on pop and dismiss); the overlay gets only the frames that came back
  and, once its clock ends, one that replaces nothing, which settles the change, or, when no frame came back by then,
  starts the page's or the dialog's own animation (until the first frame, what it covers shows as it is). A change
  that starts while one runs ends it first (`NavTransition.finish`: its `done` runs, `Native.navTransitionEnd` stops
  its run); with "Remove animations" on (`ValueAnimator.areAnimatorsEnabled`, `Environment::reduce_motion`) none runs,
  and the page's own animation is at once, as the system's animator scale makes it. An app that stops takes its
  overlays and screen layer with it (`NshView.endShaders`). A screen layer draws over the surface while its view is in
  the window: detached, deleted or turned off, it gives the surface back and redraws it, unless another screen layer
  took its place. A view leaving the window lets its `Pictures` go (a `HardwareRenderer` and an `ImageReader` each)
  and takes its pictures again once it is back. Without a GPU device `Native.shaderTransition` starts no run (the children show as they are) and
  `Native.navTransition` declines, so a page moves with its own animation (`StackBox`) and a dialog with its
  `animation` (`ModalHost`).

- **Windows.** Effects and running transitions (screen ones on the root) draw their last frame instead of their
  children, which are drawn into a target bitmap by a context of their own as the window draws them (their hosted
  items take their places; web views in them are hidden, their pages not in the picture: `DrawCx::uncomposed`) and
  read back (`render::Readback`) only once a view in them changed since the last picture (`NshView::changed` stamps
  the view and every view it is in, `NshView::changes`, and a `ShaderInput` item stamps the shader's view; a shader's
  own frame only `redraw`s, which stamps the views it is in) or the whole window was asked to draw again
  (`Surface::whole_change`: a video's frame, a native component, the theme), and given to the shader when their pixels
  changed. A shader reading `nsh.time` over still children reads them once
  (`shader.rs`'s `an_effect_reads_its_children_back_only_after_a_change`). The target and the CPU-readable bitmap
  they are read through, and the pixels, are kept while the size, the scale and the device stay; Direct2D maps the
  readable bitmap once the GPU has copied into it. A transition's `from` is drawn offscreen when it starts
  (`render::draw_offscreen`). A backdrop is read back from the window's target before the view draws, into kept
  bitmaps and pixels; a partial frame whose areas meet a view that reads it draws all of the view's box and overflow
  (`shader::backdrop_areas`, `render::with_backdrops`), so it reads this frame's pixels, never its own output of an
  earlier frame that the rest of the back buffer holds. Pages and dialogs: recordings (`ID2D1CommandList`) of the
  host without and with the upper side, drawn into bitmaps and read back once by a hosted `NavItem` over the stack
  or the root, its shader on its own transition clock (`start_transition`, backwards when it goes); a lost device
  ends them at once in the window that finds it lost, and one of another window draws no recording of the lost
  device (`NavItem`'s generation), only its shader's frames. Without a GPU device an effect draws its children as
  they are, a transition starts no run and a page or a dialog comes with its own motion, as it does when the user
  asks for less motion. A screen layer leaves the root when the view that mounted it is deleted (unless another
  screen effect's took its place) or the app stops.
- **Linux.** Effects and running transitions draw their last frame instead of their children; when GTK draws one
  again, its children's render nodes are taken (GTK's own for the widgets it did not draw again) and, when they are
  not the nodes the last picture came from (`same_nodes`: the same nodes, in wrappers of the same kind), rendered by
  the window's renderer into a texture of the box and overflow and downloaded, and given to the shader when its
  pixels changed: an effect that reads `nsh.time` draws itself every frame without picturing its children again. A
  transition's `from` is that picture taken when it starts (or its last frame, if one runs), shown until the first
  frame. Screen layers are the root's. A backdrop is the surface's views drawn anew up to the view (`skipped`,
  `past`; the widgets views host, as GTK last drew them, up to it too) after the frame clock paints, again when the
  core marks it or a view that draws behind it changes on the UI thread (`NshView::changed`, `moved`; `behind`: an
  ancestor or a view before it, not one in it or after it; a shader's own frame only `redraw`s), and given to the
  shader when its pixels changed. Pages and dialogs: pictures of the host drawn anew without and with the upper side
  (the same way), through a `NavPainter` on the shader's own transition clock (`start_transition`, backwards when it
  goes) in a layer over the stack or the root; the starting side shows until the first frame. Without a GPU device an
  effect draws its children as they are, a transition starts no run and a page or a dialog comes with its own motion,
  as it does when the user asks for less motion. A screen layer leaves the root when the view that mounted it is
  deleted (unless another screen effect's took its place) or the app stops; a page's or a dialog's shader goes with
  it at the end of the batch that deletes it, so its leave in that batch still goes through it.
- **GPUI.** Fills only: an effect's or a transition's children show as they are, a screen layer draws nothing, pages
  and dialogs come and go without their shader.

## Pages and dialogs

What every platform does with a page's or a dialog's `MountItem::NavShader`, so an app sees the same thing
everywhere:

- **The sides.** The lower side, `sample_from`, is the page under the one that comes or goes (the surface without the
  dialog); the upper, `sample_to`, the page that comes or goes (the surface with the dialog). `nsh.progress` runs from 0
  to 1 as the page is pushed or the dialog presented, and from 1 to 0 as it is popped or dismissed
  (`ShaderView::start_transition_backwards`): one program draws both ways. Under the frames the views are where the
  change ends; the frames show over them until the last one.
- **It replaces `animation`.** A page or dialog with a shader comes and goes through it whatever its `animation`
  says, `"none"` included. `animation` is what runs where the shader does not: without a GPU device, with a source
  that did not compile (the core sends `shader: None`), or where the platform cannot take the pictures or put the
  frames over the change. Such a change takes the page's or the dialog's own motion, at once for `"none"`, never
  another motion for the shader's duration. So does a change none of whose frames came back by the time it was to
  end (a slow GPU, a program compiled at its first frame): it takes its own motion from there instead of cutting to
  its end.
- **Less motion.** When the user asks for less motion (`Environment::reduce_motion`), the shader does not run: the
  change takes the page's or the dialog's own `animation` as reduced motion makes it
  (`nsh_core::navigation::screen_motion` and `modal_motion` with `reduce_motion`: a slide becomes a 200 ms fade,
  `"none"` stays at once).
- **Interruptions.** A push, pop, presentation or dismissal that starts while a shader's change of the same stack (a
  page's) or of the surface (a dialog's) still runs ends that one first, at once: its views settle where it ends, its
  events go out (`onShow`, `onDismiss`; a page that left is removed), its frames go. The new change starts from there,
  so its pictures never hold the frames of the one before. The desktops' own motion does the same (`finish` before
  `reconcile`).
- **No fallback prop.** `ShaderTransition`'s `fallback` says what runs without a `source`; a `transitionShader`
  always has one, and where it cannot run the page's `animation` is that fallback.

### On the web

Effects and transitions (`ShaderEffect`, `ShaderTransition`, `ScreenEffect`, `ScreenTransition`, a page's or a
dialog's `transitionShader`) take their pictures from the DOM. `shader.rs` also encodes the layer's `role` (0 fill,
1 effect, 2 transition, 3 screen, 4 screen transition), `overflow`, `progress` and `progressSlot`, and `pictures`:
`[sampler uniform name, input]` pairs (0 content, 1 backdrop, 2 from, 3 to); `MountItem::ShaderTransition`,
`ShaderInput` and `NavShader` are `["sht", id, ms]`, `["shi", id]` and `["shn", id, layer, ms]`.

- **Pictures.** `paintTree` paints a view's children into a 2D canvas in points (backgrounds, rounded corners,
  uniform borders, images fitted by `object-fit`, canvases, other shaders' pictures among them, text runs, clipping
  and opacity; no rotations, gradients or shadows; cross-origin images without CORS are left out so the canvas stays
  readable, and so are the app's canvases that drew one, which `draw` marks `_tainted` for good, as the browser never
  clears its own flag). Pictures cover the box plus `overflow` on each side and are uploaded premultiplied
  (`UNPACK_PREMULTIPLY_ALPHA_WEBGL`), linear and clamped, to the program's sampler uniforms; an input without a
  picture reads a transparent texture. What each element paints with from its computed style is kept
  (`paintStyle`) until a change reaches it: one `MutationObserver` on the root (`watchPaint`) stamps each element a
  mutation changes (`_touched`), and a kept style is read again when it or an ancestor carries a newer stamp, or the
  color scheme changed; the boxes come from `getBoundingClientRect`, after the one layout the first read makes
  (painting writes nothing). A picture's canvas is resized only when its size changes (setting a canvas's size
  reallocates it), else cleared and drawn again; the built-ins and the slots' float view are one buffer per view.
- **Effects.** The output canvas (`nsh-fx-out`) is appended over the children and grows by the overflow; the view
  has `nsh-fx`, which puts its children at opacity 0 (they keep their pointer events and hit testing under the
  canvas) and isolates its stacking. While `paintHost` paints them it lifts `nsh-fx` (`nsh-painting` turns CSS
  transitions off for that moment). A `MutationObserver` with capture `scroll` and `load` listeners marks the
  content stale, as `["shi"]` does; stale pictures are painted again in `shaderFrame`, at most once per animation
  frame. `shownChange` ignores the shaders' own canvases and painting's class toggles.
- **Backdrops.** `sample_backdrop` is the root painted up to the view (`paintTree` stops at it), watched by one
  observer on the root for every backdrop shader.
- **Transitions.** `["sht"]` comes first in its batch: the children as they show (or, when one is running, what it
  draws) become `sample_from` and the shader draws over them at once; the children painted after the batch are
  `sample_to`, and `nsh.progress` runs from 0 to 1 over the duration on animation frames. At the end the canvas is
  cleared, the `from` and `to` pictures go with their textures (`freeTextures`), and the children show as they are.
  An animated `progress` (an effect's) is written by `shaderSlot`.
- **Screens.** A `ScreenEffect` or `ScreenTransition` does the same with the root as its host; its canvas is
  appended to the root. A screen effect pictures the surface again whenever another shader in it draws, at most once
  per frame: the mark (`shaderDirty`) queues the next frame, and the frame's own request for its running views
  leaves it at that.
- **Pages and dialogs.** `["shn"]` keeps the page's or the dialog's `transitionShader`. `shaderNav` runs it on an
  overlay over the stack (push, pop) or the root (present, dismiss): `sample_from` is the host painted up to the
  page or dialog, `sample_to` the whole host, and progress goes from 0 to 1, or 1 to 0 when it leaves; the views
  are where they end under it at once. When it ends the overlay goes, and its pictures' textures are deleted
  (`endTransition`): GPU memory the garbage collector does not see. Dialogs shown in the top layer
  (`dialogs: "viewport"`) keep their own motion, and so does every page and dialog when the user asks for less
  motion (`reduceMotion()`). A push, a pop (`moveScreens`, which `goBack` goes through whatever the page's
  `animation`), a presentation or a dismissal ends a shader's change still running over the same host first
  (`endNavShader`: its `done` settles and reports it). A dismissal also ends the dialog's presentation still under
  way, before its frames or during its own motion (`endPresentation`), so `onShow` always comes before the
  dismissal.
- **Shaders that cannot draw.** A view whose shader cannot draw (`shaderDraws`: no WebGL 2, a lost context, or a
  program the driver refuses) shows its background and children as they are, as the native backends show them
  without a device: an effect or a screen effect takes no `nsh-fx` (and its canvas is cleared when its new program is
  refused), a transition starts no run, a page's or a dialog's `transitionShader` leaves the change to its own
  motion, and `shaderFrame` paints no pictures and takes no frames for it.
- **A refused frame.** `renderShader` catches what drawing a frame throws (`drawShader`; WebGL refuses to upload a
  tainted picture, from a canvas `paintTree` could not tell was tainted), so the frame, or the batch that started a
  transition, goes on with the other views. The view shows its children as one that cannot draw (`shaderFailed`)
  until its next layer (`op_sh`) tries again; a page's or a dialog's change whose first frame is refused takes its own
  motion, and one refused later ends at once, settled and reported.
- **A lost context.** When the browser takes the context away (a GPU reset, a tab it evicts: `webglcontextlost`, or
  `isContextLost()` at the next `shaderFrame` where the event has not come), the programs and textures go with it
  and every view shows its children (`shaderLost`): effects and screen effects lose `nsh-fx` and their last frame, a
  running transition ends, and a page's or a dialog's change ends, settled and reported. The handler's
  `preventDefault` asks for the context back; once it is restored (`webglcontextrestored`) the programs and textures
  are made again as the views draw, and effects hide their children under their canvas again (`shaderRestored`).

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
- **A first frame is not an end.** A run's first frame comes back one or two display frames after it starts, and
  `ShaderView::frame()` is empty until then: a page's or a dialog's run ends on its clock, never on an empty frame.
- **Readback latency.** Native frames arrive one or two display frames after `render`; a backend must keep ticking
  while `ShaderView::pending()` is true, or be told when they are back (`Renderer::when_done`, on Apple's GPUs), or
  the last frame of a change never shows.
- **A display frame for one shader frame on macOS.** Resuming the surface's display link for a frame or two wakes
  the process about as often as keeping it running at the screen's rate. A view that only changed
  (`ShaderView::animates` false, no pictures) renders after the batch and is collected when the GPU tells, so the
  display link stays paused.
- **A CGImage per frame on macOS and iOS.** Read back, a frame became a `CGImage` in sRGB; Core Animation converted each one to
  the display's colour space (Display P3) on the main thread at commit (`CA::Render::copy_image`, vImage), and with
  the copy out of the read-back buffer a window-sized animated shader took 70 % of a core at 120 Hz. macOS and iOS
  show frames on IOSurfaces instead. `renderInContext:` draws an IOSurface `contents`, so pictures of what is under a
  backdrop or a transition still have the frames.
- **One frame callback on the web.** `shaderFrame` clears `shaderFrameQueued` before it draws, so a view marked while
  it draws (a screen effect another shader drew under) queues the next frame then; a second request at its end would
  run the next frame twice, each of those twice again, and so on: the Shaders page stalled within a second of turning
  its screen effect on. Every request goes through the flag.
- **Resizing a WebGL canvas.** Setting `width` or `height` reallocates the drawing buffer, each of them; the shared
  canvas is resized only to grow, and to shrink a second after the views needed less.
