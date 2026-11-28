//! GPU views: a view's box drawn every frame by a renderer the app writes
//! with [`wgpu`], composited by the platform under the view's children.
//!
//! A [`GpuRenderer`] is the app's own Rust code: it builds its pipelines and
//! buffers once ([`GpuRenderer::prepare`]), takes the view's props
//! ([`GpuRenderer::set_prop`], [`GpuRenderer::set_animated_number`]) and
//! encodes a frame whenever the view needs one ([`GpuRenderer::render`]).
//! NSH runs it on a render thread of the surface's, never on the main
//! thread and never in JS: the main thread only asks for frames on the
//! display's clock and shows the ones that are done, so a frame the GPU or
//! the renderer is late with is skipped rather than waited for.
//!
//! An app's crate registers a renderer by name for TSX, from its
//! `#[native_module]` function ([`GpuRegistry::gpu_renderer`]):
//!
//! ```ignore
//! #[native_module("gallery/scenes")]
//! fn scenes(registry: &mut Registry) {
//!     registry.gpu_renderer("gallery/gears", Gears::new);
//! }
//! ```
//!
//! and TSX makes a component of it with `gpuView` of `nsh`:
//!
//! ```tsx
//! const Gears = gpuView<{ exposure: number }>("gallery/gears", { props: ["exposure"] });
//! <Gears exposure={exposure} style={{ height: 320 }} />
//! ```
//!
//! A Rust element gives the view its renderer itself
//! ([`GpuViewExt::renderer`]): `gpu_view().renderer(Gears::new)`.
//!
//! # Frames
//!
//! The renderer draws into [`GpuFrame::target`], `GpuFrame::width` ×
//! `GpuFrame::height` pixels of [`GpuFrame::format`] (8-bit unsigned
//! normalized, RGBA or BGRA by platform; rebuild what depends on it if it
//! changes), clearing it first. Colors are what the view shows: sRGB-encoded
//! with premultiplied alpha, as CSS colors (a renderer lighting in linear
//! space encodes its result to sRGB itself). A frame is rendered when one of
//! the view's props, its size or its scale changed, and on every display
//! frame while [`GpuRenderer::animating`] says so.
//!
//! The device is shared by the views of a surface: a high-performance
//! adapter, with all of its features and limits (read them from
//! [`GpuContext::device`]). Where no GPU answers, GPU views draw nothing of
//! their own.

use std::{sync::Arc, time::Duration};

use nsh_core::{
    JsonValue, Rgba,
    element::{GpuView, Registry},
    geometry::{Points, Size},
    gpu::GpuSource,
};
pub use wgpu;

/// What a GPU view draws: the app's own wgpu code, run on the surface's
/// render thread.
pub trait GpuRenderer: Send + 'static {
    /// Called once the device is open, before the first frame: build the
    /// pipelines, buffers and textures here.
    fn prepare(&mut self, cx: &GpuContext<'_>) {
        let _ = cx;
    }

    /// Prop `name` set to `value` (any JSON value; `None`: removed), before
    /// the next frame. A frame follows.
    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        let _ = (name, value);
    }

    /// Prop `name`, bound to an animated value, moved to `value` (on the
    /// display frames it changes, without JS). By default, [`Self::set_prop`]
    /// with a JSON number. A frame follows.
    fn set_animated_number(&mut self, name: &str, value: f64) {
        let json = serde_json::Number::from_f64(value).map_or(JsonValue::Null, JsonValue::Number);
        self.set_prop(name, Some(&json));
    }

    /// Prop `name`, bound to an animated color, moved to `color`. By
    /// default, [`Self::set_prop`] with the color as `#rrggbbaa`. A frame
    /// follows.
    fn set_animated_color(&mut self, name: &str, color: Rgba) {
        let channel = |c: f32| (c.clamp(0.0, 1.0) * 255.0).round() as u8;
        let hex = format!(
            "#{:02x}{:02x}{:02x}{:02x}",
            channel(color.r),
            channel(color.g),
            channel(color.b),
            channel(color.a)
        );
        self.set_prop(name, Some(&JsonValue::from(hex)));
    }

    /// Whether its frames change with time alone (an animation, a
    /// simulation): it is then rendered on every display frame. By default,
    /// only when something changed.
    fn animating(&self) -> bool {
        false
    }

    /// Encodes a frame into [`GpuFrame::target`].
    fn render(&mut self, frame: &mut GpuFrame<'_>);
}

/// The device a renderer prepares with ([`GpuRenderer::prepare`]).
#[non_exhaustive]
pub struct GpuContext<'a> {
    device: &'a wgpu::Device,
    queue: &'a wgpu::Queue,
}

impl<'a> GpuContext<'a> {
    /// The context of `device` and its `queue` (made by the runtime that
    /// runs renderers: NSH's engine, a test).
    pub fn new(device: &'a wgpu::Device, queue: &'a wgpu::Queue) -> Self {
        Self { device, queue }
    }

    /// The device, shared by the GPU views of the surface.
    pub fn device(&self) -> &wgpu::Device {
        self.device
    }

    /// The device's queue.
    pub fn queue(&self) -> &wgpu::Queue {
        self.queue
    }
}

/// An event a renderer emitted ([`GpuFrame::emit`]): its view's
/// `on<Name>` handler gets `data`.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct GpuEvent {
    /// Its name (`pick` reaches `onPick`).
    pub name: Arc<str>,
    /// What it carries.
    pub data: JsonValue,
}

/// One frame of a GPU view, as its renderer encodes it.
#[non_exhaustive]
pub struct GpuFrame<'a> {
    device: &'a wgpu::Device,
    queue: &'a wgpu::Queue,
    target: &'a wgpu::TextureView,
    format: wgpu::TextureFormat,
    width: u32,
    height: u32,
    scale: f32,
    time: Duration,
    encoder: &'a mut wgpu::CommandEncoder,
    events: &'a mut Vec<GpuEvent>,
}

/// What a frame is made of ([`GpuFrame::new`]).
#[non_exhaustive]
pub struct GpuFrameParts<'a> {
    /// The device.
    pub device: &'a wgpu::Device,
    /// Its queue.
    pub queue: &'a wgpu::Queue,
    /// Where the frame is drawn.
    pub target: &'a wgpu::TextureView,
    /// The target's format.
    pub format: wgpu::TextureFormat,
    /// The target's width in pixels.
    pub width: u32,
    /// The target's height in pixels.
    pub height: u32,
    /// Pixels per point.
    pub scale: f32,
    /// Since the renderer was made.
    pub time: Duration,
    /// What the frame is encoded with.
    pub encoder: &'a mut wgpu::CommandEncoder,
    /// Where its events go.
    pub events: &'a mut Vec<GpuEvent>,
}

impl<'a> GpuFrameParts<'a> {
    /// The parts of a frame of `width` × `height` pixels at `scale`.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        device: &'a wgpu::Device,
        queue: &'a wgpu::Queue,
        target: &'a wgpu::TextureView,
        format: wgpu::TextureFormat,
        (width, height): (u32, u32),
        scale: f32,
        time: Duration,
        encoder: &'a mut wgpu::CommandEncoder,
        events: &'a mut Vec<GpuEvent>,
    ) -> Self {
        Self {
            device,
            queue,
            target,
            format,
            width,
            height,
            scale,
            time,
            encoder,
            events,
        }
    }
}

impl<'a> GpuFrame<'a> {
    /// A frame of `parts` (made by the runtime that runs renderers).
    pub fn new(parts: GpuFrameParts<'a>) -> Self {
        let GpuFrameParts {
            device,
            queue,
            target,
            format,
            width,
            height,
            scale,
            time,
            encoder,
            events,
        } = parts;
        Self {
            device,
            queue,
            target,
            format,
            width,
            height,
            scale,
            time,
            encoder,
            events,
        }
    }

    /// The device.
    pub fn device(&self) -> &wgpu::Device {
        self.device
    }

    /// The device's queue: buffer and texture writes made here land before
    /// the frame's commands.
    pub fn queue(&self) -> &wgpu::Queue {
        self.queue
    }

    /// Where the frame is drawn: clear it first.
    pub fn target(&self) -> &wgpu::TextureView {
        self.target
    }

    /// The target's format: 8-bit unsigned normalized, RGBA or BGRA.
    pub fn format(&self) -> wgpu::TextureFormat {
        self.format
    }

    /// The target's width in pixels.
    pub fn width(&self) -> u32 {
        self.width
    }

    /// The target's height in pixels.
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Pixels per point.
    pub fn scale(&self) -> f32 {
        self.scale
    }

    /// The view's size in points.
    pub fn size(&self) -> Size<Points> {
        let scale = self.scale.max(f32::MIN_POSITIVE);
        Size {
            width: Points(self.width as f32 / scale),
            height: Points(self.height as f32 / scale),
        }
    }

    /// Since the renderer was made: what an animation reads.
    pub fn time(&self) -> Duration {
        self.time
    }

    /// The encoder the frame's commands go to; NSH submits it.
    pub fn encoder(&mut self) -> &mut wgpu::CommandEncoder {
        self.encoder
    }

    /// Emits event `name` with `data`: the view's `on<Name>` handler (Rust:
    /// `on_native_event`) gets it.
    pub fn emit(&mut self, name: &str, data: JsonValue) {
        self.events.push(GpuEvent {
            name: name.into(),
            data,
        });
    }
}

/// A renderer's factory, as [`GpuSource`]s carry it.
type Make = Arc<dyn Fn() -> Box<dyn GpuRenderer> + Send + Sync>;

/// The source of renderers `make` makes: a view mounted with it makes one.
pub fn renderer_source<R: GpuRenderer>(make: impl Fn() -> R + Send + Sync + 'static) -> GpuSource {
    let make: Make = Arc::new(move || Box::new(make()));
    GpuSource::new(make)
}

/// A renderer of `source` ([`renderer_source`]); `None` for a source of
/// something else.
pub fn make_renderer(source: &GpuSource) -> Option<Box<dyn GpuRenderer>> {
    source.downcast_ref::<Make>().map(|make| make())
}

/// GPU renderers on a UI set's registry: what an app's crate calls from
/// its `#[native_module]` function.
pub trait GpuRegistry {
    /// Registers the renderers `make` makes as `name`, which TSX's
    /// `gpuView(name, …)` and Rust's `gpu_view().renderer_named(name)` draw
    /// with.
    fn gpu_renderer<R: GpuRenderer>(
        &mut self,
        name: &'static str,
        make: impl Fn() -> R + Send + Sync + 'static,
    ) -> &mut Self;
}

impl GpuRegistry for Registry {
    fn gpu_renderer<R: GpuRenderer>(
        &mut self,
        name: &'static str,
        make: impl Fn() -> R + Send + Sync + 'static,
    ) -> &mut Self {
        self.gpu_renderer_source(name, renderer_source(make))
    }
}

/// A GPU view's renderer, given by a Rust element.
pub trait GpuViewExt {
    /// Draws the view with the renderers `make` makes (one each time the
    /// view is mounted).
    fn renderer<R: GpuRenderer>(self, make: impl Fn() -> R + Send + Sync + 'static) -> Self;
}

impl GpuViewExt for GpuView {
    fn renderer<R: GpuRenderer>(self, make: impl Fn() -> R + Send + Sync + 'static) -> Self {
        self.source(renderer_source(make))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Clear;

    impl GpuRenderer for Clear {
        fn render(&mut self, _: &mut GpuFrame<'_>) {}
    }

    #[test]
    fn a_source_makes_renderers_and_others_make_none() {
        let source = renderer_source(|| Clear);
        assert!(make_renderer(&source).is_some());
        assert!(make_renderer(&GpuSource::new(7_u32)).is_none());
    }

    #[test]
    fn a_registered_renderer_is_found_by_name() {
        let mut registry = Registry::new();
        registry.gpu_renderer("test/clear", || Clear);
        let source = registry
            .registered_gpu_renderer("test/clear")
            .expect("registered");
        assert!(make_renderer(source).is_some());
        assert!(registry.registered_gpu_renderer("test/other").is_none());
    }
}
