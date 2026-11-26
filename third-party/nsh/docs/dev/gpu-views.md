# GPU views

A GPU view (`gpuView(name, spec)` from `nsh`, the `gpuview` host element; Rust `nsh_core::element::gpu_view()`) is a
view whose box a renderer of the app's own draws with wgpu, every frame it needs one, over the view's background and
under its children. It is for what neither `Canvas` (recorded by JS, replayed by the platform's 2D API) nor `Shader`
(one fragment function, no buffers of its own) can draw at the display's rate: drawings of many primitives, 3D scenes,
simulations. The module docs of `crates/nsh-gpu/src/lib.rs` (the app's API), `crates/nsh-core/src/gpu.rs` (the core's
handle) and `crates/nsh-engine/src/gpu.rs` (the runtime) are the reference; this page is the overview.

## The pieces

- **`nsh-gpu`** is what an app's crate depends on: the `GpuRenderer` trait (`prepare`, `set_prop`,
  `set_animated_number` / `set_animated_color`, `animating`, `render`), `GpuFrame` (device, queue, target view, format,
  pixel size, scale, time, encoder, `emit`), and the registration: `GpuRegistry::gpu_renderer(name, make)` on a UI
  set's `Registry` (from its `#[native_module]` function), `GpuViewExt::renderer(make)` on a Rust `gpu_view()`. It
  re-exports `wgpu` so the app's code and NSH's runtime use one version.
- **The core** never names wgpu. A renderer's factory is a `GpuSource` (`Arc<dyn Any + Send + Sync>`, equal by
  identity). `Tag::GpuView` / `Kind::GpuView` is a container view (background, border, children) with native
  component state: `Prop::Component(name)` resolves the name in the engine's merged registry
  (`Registry::registered_gpu_renderer`), `Prop::GpuRenderer` takes a Rust element's source. The platform gets
  `MountItem::GpuView { id, source }` after the view's `Create`, then its own props as a native component's
  (`ComponentProps`, `ComponentPropSlots` for animated values); a new source resends all props. A name nothing
  registered logs a warning and the view draws nothing of its own.
- **JS**: `gpuView(name, spec)` (`platform_modules.rs`, beside `nativeComponent`) returns a component taking the view
  props, children, the renderer's props (`spec.props`, plain or animated values) and its events (`spec.events` as
  `on<Name>`). Its declaration is generated with the module's.
- **The runtime** (`nsh_engine::gpu::GpuViews`, feature `shader`; `gpu_off.rs` without it) is one per surface. The first
  view starts a render thread that opens the device (high-performance adapter, the shaders' backend order, all of the
  adapter's features except the experimental ones, its limits) and owns the renderers. The main thread sends it
  commands (source, props, animated values, size, visibility) and, on its frame clock, asks for the frames due
  (`tick`): a view whose renderer animates, or that changed. Each view renders into a `FrameTarget` (`frames.rs`, the
  shaders' frame targets), whose lock is held only to pick a destination and to submit, never while the renderer
  encodes. A view with no destination free (the GPU is behind) waits for the next tick: the main thread never waits
  for the GPU or a renderer. Events the renderer emits come back with `take_events` and reach the view's
  `NativeEvent` listeners.

## Platforms

| Platform | Shows frames | Status |
|---|---|---|
| Linux (GTK) | read back into a `GdkMemoryTexture` drawn under the children, clipped to the rounded box; tick callback on the root (`crates/nsh-platform-linux/src/gpu.rs`) | done |
| macOS, iOS (and Mac Catalyst) | each frame's IOSurface set as the contents of a sublayer under the children, shaped as a shader's fill (rounded, continuous corners), no copy; a frame without a surface is read back as a CGImage. macOS ticks on the surface's display link draw callback (`crates/nsh-platform-macos/src/gpu_view.rs`), iOS on a `CADisplayLink` up to 120 Hz (`crates/nsh-platform-ios/src/gpu.rs`) | done |
| Windows | D3D12 shared texture as a D2D bitmap | not yet: draws nothing |
| Android, web, GPUI | readback / a canvas of its own | not yet: draws nothing |

A view out of sight (unmapped, or outside a clipping ancestor or the window) renders nothing until it comes into sight.

## Tests

`crates/nsh-gpu` tests the registration, `crates/nsh-engine/src/gpu.rs` renders offscreen and reads pixels back (skipped
where no GPU answers), `core/tests.rs` the mount items (`a_gpu_view_…`), `crates/nsh-platform-linux/src/gpu.rs` a frame
shown by GTK, `crates/nsh-platform-macos/tests/native/gpu_view.rs` a frame shown as a layer's IOSurface (`NSH_GPU_VIEW_CHECK_ONLY=1 cargo test -p nsh-platform-macos --test native -- --ignored`). The compat case `tests/compat/cases/core/core-gpu-view.tsx` covers the export.
