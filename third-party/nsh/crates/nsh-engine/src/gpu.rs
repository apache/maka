//! GPU views' runtime (feature `shader`): the renderers apps write with
//! wgpu (`nsh_gpu::GpuRenderer`) run on a render thread of the surface's,
//! and the platform shows their frames under the views' children as it
//! shows a shader's.
//!
//! A backend keeps one [`GpuViews`] per surface and feeds it what the core
//! mounts: a view's renderer ([`GpuViews::set`], from
//! `MountItem::GpuView`), its props ([`GpuViews::set_props`]), its animated
//! props ([`GpuViews::set_animated`], from the animator's
//! `write_components`) and its size ([`GpuViews::set_size`]). The first view starts the render thread,
//! which opens the device (a high-performance adapter with all of its
//! features and limits), so a surface without GPU views opens none and the
//! main thread never waits for one.
//!
//! On its frame clock, while [`GpuViews::wants_frame`], the backend calls
//! [`GpuViews::tick`]: it asks the render thread for the frames due (a view
//! whose renderer animates, or that changed) and collects the frames done,
//! naming the views whose frame is new. The render thread draws each due
//! view into its [`FrameTarget`] (a surface on Apple platforms and Windows
//! where the backend shows them, else a texture read back), its lock held
//! only to pick the destination and to submit, never while the renderer
//! encodes; a view with no destination free (the GPU is behind) waits for
//! the next tick. The renderer's events come back with
//! [`GpuViews::take_events`].

use std::{
    sync::{
        Arc, Mutex, MutexGuard, OnceLock, PoisonError,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Instant,
};

use nsh_core::{
    JsonValue, NodeId, Rgba,
    animation::AnimatedPropValue,
    geometry::{Points, Size},
    gpu::GpuSource,
};
use nsh_gpu::{GpuContext, GpuEvent, GpuFrame, GpuFrameParts, GpuRenderer};
use rustc_hash::FxHashMap;

#[cfg(windows)]
use crate::shader_frame::SharedTexture;
use crate::{
    frames::FrameTarget,
    shader_frame::{Frame, MAX_SIDE, PixelFormat},
};

/// The device GPU views render with.
struct Device {
    device: wgpu::Device,
    queue: wgpu::Queue,
}

/// Opens the device views render with: a high-performance adapter, the
/// first backend whose device opens (the shaders' order), with all of the
/// adapter's features and limits; `None` where no GPU answers.
fn open_device() -> Option<Device> {
    let order = crate::shader::backend_order();
    let mut last = None;
    for (i, &backends) in order.iter().enumerate() {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let adapter =
            match pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                ..Default::default()
            })) {
                Ok(adapter) => adapter,
                Err(e) => {
                    last = Some(format!("no GPU adapter ({e})"));
                    continue;
                }
            };
        if !crate::shader::takes(adapter.get_info().device_type, i + 1 == order.len()) {
            continue;
        }
        // Every stable feature: experimental ones need an opt-in wgpu
        // refuses a device without.
        let descriptor = wgpu::DeviceDescriptor {
            label: Some("nsh GPU views"),
            required_features: adapter.features() - wgpu::Features::all_experimental_mask(),
            required_limits: adapter.limits(),
            ..Default::default()
        };
        match pollster::block_on(adapter.request_device(&descriptor)) {
            Ok((device, queue)) => {
                device.on_uncaptured_error(Arc::new(|e: wgpu::Error| {
                    log::warn!("GPU views: {e}");
                }));
                log::debug!("GPU views: {:?}", adapter.get_info());
                return Some(Device { device, queue });
            }
            Err(e) => {
                let backend = adapter.get_info().backend;
                last = Some(format!("no GPU device on {backend} ({e})"));
            }
        }
    }
    log::warn!("GPU views: {}; they draw nothing", last.unwrap_or_default());
    None
}

/// What the main thread and the render thread share of a view.
#[derive(Default)]
struct Shared {
    frames: Mutex<SharedFrames>,
    /// A frame is due: something changed, or its renderer animates.
    due: AtomicBool,
    /// Out of sight ([`GpuViews::set_hidden`]): rendered once it shows.
    hidden: AtomicBool,
}

impl Shared {
    fn frames(&self) -> MutexGuard<'_, SharedFrames> {
        self.frames.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[derive(Default)]
struct SharedFrames {
    target: FrameTarget,
    presentation: Presentation,
}

/// What the platform last received, independent of the render target's
/// current surface pool, which can change before a new frame is collected.
#[derive(Default, PartialEq, Eq)]
enum Presentation {
    #[default]
    Empty,
    Frame,
    /// A displayed frame was retired and the platform has yet to be told.
    ClearPending,
}

/// What the main thread asks of the render thread.
enum Command {
    Set(NodeId, Arc<Shared>, Option<GpuSource>),
    Props(NodeId, Vec<(Arc<str>, Option<JsonValue>)>),
    Number(NodeId, Arc<str>, f64),
    Color(NodeId, Arc<str>, Rgba),
    Size(NodeId, (u32, u32), f32),
    #[cfg(any(target_vendor = "apple", windows))]
    Surfaces(NodeId, bool),
    Remove(NodeId),
    Frame,
}

/// What the render thread gives back.
#[derive(Default)]
struct Outbox {
    events: Vec<(NodeId, Arc<str>, JsonValue)>,
}

/// A wake-up of the main thread ([`GpuViews::on_ready`]).
type Wake = Arc<dyn Fn() + Send + Sync>;

/// The render thread's handle.
struct Worker {
    tx: mpsc::Sender<Command>,
    /// Joined when the views go, so the device is gone with them.
    thread: Option<std::thread::JoinHandle<()>>,
    /// Set once the thread opened the device (`None`: no GPU).
    device: Arc<OnceLock<Option<Device>>>,
}

/// The main thread's side of a view.
#[derive(Default)]
struct View {
    shared: Arc<Shared>,
    /// Its size in pixels and its scale, as last sent.
    pixels: (u32, u32),
    scale: f32,
}

impl View {
    fn needs_render(&self) -> bool {
        self.shared.due.load(Ordering::Acquire)
            && !self.shared.hidden.load(Ordering::Acquire)
            && has_area(self.pixels)
    }
}

/// The GPU views of a surface: their renderers on a render thread, their
/// frames for the backend to show.
pub struct GpuViews {
    format: PixelFormat,
    views: FxHashMap<NodeId, View>,
    worker: Option<Worker>,
    outbox: Arc<Mutex<Outbox>>,
    wake: Arc<Mutex<Option<Wake>>>,
}

impl GpuViews {
    /// No views yet; read-back frames in `format`.
    pub fn new(format: PixelFormat) -> Self {
        Self {
            format,
            views: FxHashMap::default(),
            worker: None,
            outbox: Default::default(),
            wake: Default::default(),
        }
    }

    /// Calls `f`, on the render thread, when it has something for the main
    /// thread: frames submitted or cleared (reported by a later [`Self::tick`]) or
    /// events ([`Self::take_events`]). A backend that ticks only while
    /// [`Self::wants_frame`] needs none; one that sleeps wakes on it.
    /// Replaces the last `f`.
    pub fn on_ready(&self, f: impl Fn() + Send + Sync + 'static) {
        *self.wake.lock().unwrap_or_else(PoisonError::into_inner) = Some(Arc::new(f));
    }

    fn send(&mut self, command: Command) {
        let worker = self
            .worker
            .get_or_insert_with(|| start(self.format, self.outbox.clone(), self.wake.clone()));
        // The thread ends only when `tx` drops: it is there.
        let _ = worker.tx.send(command);
    }

    /// View `id`'s renderer (`MountItem::GpuView`): a new one from
    /// `source`, which renders a frame; `None` lets the old one go and the
    /// view draws nothing.
    pub fn set(&mut self, id: NodeId, source: Option<GpuSource>) {
        let shared = self.views.entry(id).or_default().shared.clone();
        shared.due.store(source.is_some(), Ordering::Release);
        self.send(Command::Set(id, shared, source));
    }

    /// Props of view `id` changed (`MountItem::ComponentProps`; `None`
    /// removes one).
    pub fn set_props(&mut self, id: NodeId, props: &[(Arc<str>, Option<JsonValue>)]) {
        if !self.views.contains_key(&id) || props.is_empty() {
            return;
        }
        self.mark_due(id);
        self.send(Command::Props(id, props.to_vec()));
    }

    /// View `id`'s prop `name`, bound to an animated value, moved to
    /// `value` (the animator's `write_components`: on the display frames it
    /// changes, without JS).
    pub fn set_animated(&mut self, id: NodeId, name: &str, value: AnimatedPropValue) {
        if !self.views.contains_key(&id) {
            return;
        }
        let command = match value {
            AnimatedPropValue::Number(n) => Command::Number(id, name.into(), n),
            AnimatedPropValue::Color(argb) => Command::Color(id, name.into(), argb_color(argb)),
            _ => return,
        };
        self.mark_due(id);
        self.send(command);
    }

    /// Whether view `id` is a GPU view ([`Self::set`] made it).
    pub fn has(&self, id: NodeId) -> bool {
        self.views.contains_key(&id)
    }

    /// View `id`'s size in points and the pixels per point it shows at: a
    /// frame of the new size follows. Frames are at most [`MAX_SIDE`]
    /// pixels a side (larger views render at a lower scale).
    pub fn set_size(&mut self, id: NodeId, size: Size<Points>, scale: f32) {
        let Some(view) = self.views.get_mut(&id) else {
            return;
        };
        let (pixels, scale) = pixels(size, scale);
        if view.pixels == pixels && view.scale == scale {
            return;
        }
        view.pixels = pixels;
        view.scale = scale;
        self.mark_due(id);
        self.send(Command::Size(id, pixels, scale));
    }

    /// Renders view `id`'s frames into surfaces the backend shows as they
    /// are (`true`) rather than reading them back, as
    /// [`crate::shader::ShaderView::show_on_surfaces`] does.
    #[cfg(any(target_vendor = "apple", windows))]
    pub fn show_on_surfaces(&mut self, id: NodeId, on: bool) {
        if !self.views.contains_key(&id) {
            return;
        }
        self.mark_due(id);
        self.send(Command::Surfaces(id, on));
    }

    /// View `id` is deleted: its renderer goes.
    pub fn remove(&mut self, id: NodeId) {
        if self.views.remove(&id).is_some() {
            self.send(Command::Remove(id));
        }
    }

    /// View `id` went out of sight (`true`: scrolled away, under another
    /// page, in a hidden window) or came back: out of sight it renders no
    /// frame, and its frames due wait for it.
    pub fn set_hidden(&mut self, id: NodeId, hidden: bool) {
        if let Some(view) = self.views.get(&id) {
            view.shared.hidden.store(hidden, Ordering::Release);
        }
    }

    fn mark_due(&self, id: NodeId) {
        if let Some(view) = self.views.get(&id) {
            view.shared.due.store(true, Ordering::Release);
        }
    }

    /// Whether a call to [`Self::tick`] has something to do: a frame due,
    /// one on its way back, or a displayed frame being cleared.
    pub fn wants_frame(&self) -> bool {
        self.views.values().any(|v| {
            v.needs_render() || {
                let frames = v.shared.frames();
                frames.presentation == Presentation::ClearPending
                    || frames.target.pending()
                    || (!has_area(v.pixels) && frames.presentation == Presentation::Frame)
            }
        })
    }

    /// Asks the render thread for the frames due, and collects the frames
    /// done: the views whose displayed frame changed, which the backend
    /// draws again (`f(id)`).
    pub fn tick(&mut self, mut f: impl FnMut(NodeId)) {
        // Collect first: a collected frame frees its read-back buffer, so the
        // frame asked for below has one to render into instead of being
        // skipped while the GPU is only one frame ahead.
        if let Some(Some(device)) = self.worker.as_ref().and_then(|w| w.device.get()) {
            let _ = device.device.poll(wgpu::PollType::Poll);
            for (&id, view) in &self.views {
                let changed = {
                    let mut frames = view.shared.frames();
                    if has_area(view.pixels) && frames.target.collect() {
                        frames.presentation = Presentation::Frame;
                        true
                    } else if frames.presentation == Presentation::ClearPending {
                        frames.presentation = Presentation::Empty;
                        true
                    } else {
                        false
                    }
                };
                if changed {
                    f(id);
                }
            }
        }
        if self.views.values().any(View::needs_render) {
            self.send(Command::Frame);
        }
    }

    /// The events the renderers emitted since the last call: the view,
    /// the event's name and its data, which the backend reports as the
    /// view's `NativeEvent`.
    pub fn take_events(&mut self) -> Vec<(NodeId, Arc<str>, JsonValue)> {
        std::mem::take(
            &mut self
                .outbox
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .events,
        )
    }

    /// Calls `f` with view `id`'s last frame read back (empty until one
    /// is, and while its frames go to surfaces).
    pub fn with_frame<T>(&self, id: NodeId, f: impl FnOnce(&Frame) -> T) -> Option<T> {
        let view = self.views.get(&id)?;
        Some(f(view.shared.frames().target.frame()))
    }

    /// Windows: the texture of view `id`'s last frame, while its frames go
    /// to textures. Each call is a draw: the backend signals the value
    /// returned once its frame is submitted.
    #[cfg(windows)]
    pub fn surface(&self, id: NodeId) -> Option<SharedTexture> {
        self.views.get(&id)?.shared.frames().target.surface()
    }

    /// Apple: calls `f` with the surface of view `id`'s last frame, while
    /// its frames go to surfaces.
    #[cfg(target_vendor = "apple")]
    pub fn with_surface<T>(
        &self,
        id: NodeId,
        f: impl FnOnce(&objc2_io_surface::IOSurfaceRef) -> T,
    ) -> Option<T> {
        let view = self.views.get(&id)?;
        let frames = view.shared.frames();
        frames.target.surface().map(f)
    }
}

/// A color of the animator's (`0xAARRGGBB`).
fn argb_color(argb: u32) -> Rgba {
    nsh_core::color::rgba(argb.rotate_left(8))
}

/// A frame's size in pixels for a view of `size` points at `scale`, and the
/// scale it renders at: at most [`MAX_SIDE`] pixels a side.
fn pixels(size: Size<Points>, scale: f32) -> ((u32, u32), f32) {
    let (w, h) = (size.width.0, size.height.0);
    if w <= 0.0 || h <= 0.0 {
        return ((0, 0), scale);
    }
    let mut scale = scale.max(0.0);
    let side = w.max(h) * scale;
    if side > MAX_SIDE as f32 {
        scale *= MAX_SIDE as f32 / side;
    }
    (
        ((w * scale).round() as u32, (h * scale).round() as u32),
        scale,
    )
}

fn has_area((width, height): (u32, u32)) -> bool {
    width != 0 && height != 0
}

/// A view on the render thread.
struct RenderView {
    shared: Arc<Shared>,
    renderer: Option<Box<dyn GpuRenderer>>,
    prepared: bool,
    made: Instant,
    pixels: (u32, u32),
    scale: f32,
    /// Something changed since its last frame.
    dirty: bool,
}

impl RenderView {
    fn update_due(&self) {
        let due = self.renderer.is_some()
            && (self.dirty || self.renderer.as_ref().is_some_and(|r| r.animating()));
        self.shared.due.store(due, Ordering::Release);
    }
}

/// Starts the render thread of a surface's views.
fn start(
    format: PixelFormat,
    outbox: Arc<Mutex<Outbox>>,
    wake: Arc<Mutex<Option<Wake>>>,
) -> Worker {
    let (tx, rx) = mpsc::channel();
    let device: Arc<OnceLock<Option<Device>>> = Arc::default();
    let opened = device.clone();
    let spawned = std::thread::Builder::new()
        .name("nsh-gpu-views".into())
        .spawn(move || {
            let device = opened.get_or_init(open_device).as_ref();
            run(device, format, &rx, &outbox, &wake);
        });
    let thread = match spawned {
        Ok(thread) => Some(thread),
        Err(e) => {
            log::warn!("GPU views: no render thread ({e}); they draw nothing");
            let _ = device.set(None);
            None
        }
    };
    Worker { tx, thread, device }
}

impl Drop for Worker {
    /// Ends the render thread: its renderers and the device go before the
    /// surface does (at most a frame's encoding is waited for).
    fn drop(&mut self) {
        let (tx, _) = mpsc::channel();
        drop(std::mem::replace(&mut self.tx, tx));
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The render thread: takes the main thread's commands, renders the views
/// due when asked, until the [`GpuViews`] goes.
fn run(
    device: Option<&Device>,
    format: PixelFormat,
    rx: &mpsc::Receiver<Command>,
    outbox: &Mutex<Outbox>,
    wake: &Mutex<Option<Wake>>,
) {
    let mut views: FxHashMap<NodeId, RenderView> = FxHashMap::default();
    while let Ok(first) = rx.recv() {
        // Everything queued meanwhile, then one round of frames.
        let mut frame = false;
        for command in std::iter::once(first).chain(rx.try_iter()) {
            frame |= apply(&mut views, device, command);
        }
        let Some(device) = device else {
            for view in views.values() {
                view.shared.due.store(false, Ordering::Release);
            }
            continue;
        };
        if !frame {
            continue;
        }
        let mut events = Vec::new();
        let mut ready = false;
        for (&id, view) in &mut views {
            ready |= render(device, format, view, |e| events.push((id, e.name, e.data)));
        }
        if ready {
            let _ = device.device.poll(wgpu::PollType::Poll);
        }
        if !events.is_empty() {
            outbox
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .events
                .extend(events);
            ready = true;
        }
        if ready && let Some(wake) = wake.lock().unwrap_or_else(PoisonError::into_inner).clone() {
            wake();
        }
    }
}

/// Applies `command`; `true` when it asks for frames.
fn apply(
    views: &mut FxHashMap<NodeId, RenderView>,
    device: Option<&Device>,
    command: Command,
) -> bool {
    match command {
        Command::Set(id, shared, source) => {
            let renderer = source.as_ref().and_then(|s| {
                let made = nsh_gpu::make_renderer(s);
                if made.is_none() {
                    log::warn!("GPU views: view {id}'s renderer is no GPU renderer");
                }
                made
            });
            let view = views.entry(id).or_insert_with(|| RenderView {
                shared,
                renderer: None,
                prepared: false,
                made: Instant::now(),
                pixels: (0, 0),
                scale: 1.0,
                dirty: true,
            });
            view.renderer = renderer;
            view.prepared = false;
            view.made = Instant::now();
            view.dirty = true;
            if let (Some(device), Some(renderer)) = (device, view.renderer.as_mut()) {
                renderer.prepare(&GpuContext::new(&device.device, &device.queue));
                view.prepared = true;
            }
            view.update_due();
        }
        Command::Props(id, props) => {
            if let Some(view) = views.get_mut(&id) {
                if let Some(renderer) = view.renderer.as_mut() {
                    for (name, value) in &props {
                        renderer.set_prop(name, value.as_ref());
                    }
                }
                view.dirty = true;
                view.update_due();
            }
        }
        Command::Number(id, name, value) => {
            if let Some(view) = views.get_mut(&id) {
                if let Some(renderer) = view.renderer.as_mut() {
                    renderer.set_animated_number(&name, value);
                }
                view.dirty = true;
                view.update_due();
            }
        }
        Command::Color(id, name, value) => {
            if let Some(view) = views.get_mut(&id) {
                if let Some(renderer) = view.renderer.as_mut() {
                    renderer.set_animated_color(&name, value);
                }
                view.dirty = true;
                view.update_due();
            }
        }
        Command::Size(id, pixels, scale) => {
            if let Some(view) = views.get_mut(&id) {
                view.pixels = pixels;
                view.scale = scale;
                view.dirty = true;
                view.update_due();
                // Retire collapsed frames even if no visible view requests a render.
                return !has_area(pixels);
            }
        }
        #[cfg(any(target_vendor = "apple", windows))]
        Command::Surfaces(id, on) => {
            if let Some(view) = views.get_mut(&id) {
                view.shared.frames().target.show_on_surfaces(on);
                view.dirty = true;
                view.update_due();
            }
        }
        Command::Remove(id) => {
            views.remove(&id);
        }
        Command::Frame => return true,
    }
    false
}

/// Renders `view`'s frame if one is due and a destination is free, or
/// clears it when collapsed. Returns whether there is a change to report.
fn render(
    device: &Device,
    format: PixelFormat,
    view: &mut RenderView,
    mut emit: impl FnMut(GpuEvent),
) -> bool {
    if !has_area(view.pixels) {
        if !view.dirty {
            return false;
        }
        let mut frames = view.shared.frames();
        frames.target.clear_frame();
        let cleared = frames.presentation == Presentation::Frame;
        if cleared {
            frames.presentation = Presentation::ClearPending;
        }
        view.dirty = false;
        return cleared;
    }
    let Some(renderer) = view.renderer.as_mut() else {
        return false;
    };
    if !view.prepared {
        renderer.prepare(&GpuContext::new(&device.device, &device.queue));
        view.prepared = true;
    }
    if (!view.dirty && !renderer.animating()) || view.shared.hidden.load(Ordering::Acquire) {
        return false;
    }
    let (width, height) = view.pixels;
    // A destination, the lock let go while the renderer encodes: the main
    // thread only collects frames done and shows them meanwhile.
    let (destination, target, target_format) = {
        let mut shared = view.shared.frames();
        let frames = &mut shared.target;
        let Some(target_format) = frames.surface_format(&device.device, format, width, height)
        else {
            return false;
        };
        let Some(destination) = frames.destination(&device.device, format, width, height) else {
            return false;
        };
        (destination, frames.view(destination).clone(), target_format)
    };
    let mut encoder = device
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("nsh GPU view"),
        });
    let mut events = Vec::new();
    renderer.render(&mut GpuFrame::new(GpuFrameParts::new(
        &device.device,
        &device.queue,
        &target,
        target_format,
        (width, height),
        view.scale,
        view.made.elapsed(),
        &mut encoder,
        &mut events,
    )));
    view.shared
        .frames()
        .target
        .submit(&device.queue, destination, encoder);
    for e in events {
        emit(e);
    }
    view.dirty = false;
    view.update_due();
    true
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use nsh_core::geometry::{px, size};

    use super::*;

    /// Clears its frame to a color its prop `red` sets; counts its frames.
    struct Fill {
        red: f64,
        frames: Arc<std::sync::atomic::AtomicU32>,
    }

    impl GpuRenderer for Fill {
        fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
            if name == "red" {
                self.red = value.and_then(JsonValue::as_f64).unwrap_or(0.0);
            }
        }

        fn set_animated_number(&mut self, name: &str, value: f64) {
            if name == "red" {
                self.red = value;
            }
        }

        fn render(&mut self, frame: &mut GpuFrame<'_>) {
            self.frames.fetch_add(1, Ordering::Relaxed);
            let target = frame.target().clone();
            let red = self.red;
            {
                let _pass = frame
                    .encoder()
                    .begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: None,
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &target,
                            depth_slice: None,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Clear(wgpu::Color {
                                    r: red,
                                    g: 0.0,
                                    b: 0.0,
                                    a: 1.0,
                                }),
                                store: wgpu::StoreOp::Store,
                            },
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                        multiview_mask: None,
                    });
            }
            frame.emit("drawn", JsonValue::from(red));
        }
    }

    fn fill() -> (GpuSource, Arc<std::sync::atomic::AtomicU32>) {
        let frames = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let counted = frames.clone();
        let source = nsh_gpu::renderer_source(move || Fill {
            red: 0.0,
            frames: counted.clone(),
        });
        (source, frames)
    }

    /// Ticks until a frame of view 1 comes back, or `false` when there is no GPU.
    fn wait_for_frame(views: &mut GpuViews) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            let mut new = false;
            views.tick(|id| new |= id == 1);
            if new {
                return true;
            }
            if views
                .worker
                .as_ref()
                .and_then(|w| w.device.get())
                .is_some_and(Option::is_none)
            {
                return false;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        panic!("no GPU view frame within five seconds");
    }

    #[test]
    fn a_view_renders_its_props_on_the_render_thread() {
        let mut views = GpuViews::new(PixelFormat::Rgba);
        let (source, frames) = fill();
        views.set(1, Some(source));
        views.set_props(1, &[("red".into(), Some(JsonValue::from(1.0)))]);
        views.set_size(1, size(px(2.0), px(2.0)), 1.0);
        if !wait_for_frame(&mut views) {
            return; // No GPU here.
        }
        let pixels = |views: &GpuViews| {
            views
                .with_frame(1, |f| f.rows().flatten().copied().collect::<Vec<_>>())
                .unwrap()
        };
        let first = pixels(&views);
        assert_eq!(&first[..4], &[255, 0, 0, 255]);
        assert_eq!(first.len(), 2 * 2 * 4);
        let events = views.take_events();
        assert!(
            events
                .iter()
                .any(|(id, name, _)| *id == 1 && &**name == "drawn")
        );
        // Nothing changed: no frame is due, and none is rendered.
        while views.wants_frame() {
            views.tick(|_| {});
            std::thread::sleep(Duration::from_millis(2));
        }
        let drawn = frames.load(Ordering::Relaxed);
        views.tick(|_| {});
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(frames.load(Ordering::Relaxed), drawn);
        // An animated prop renders again.
        views.set_animated(1, "red", AnimatedPropValue::Number(0.0));
        assert!(views.wants_frame());
        assert!(wait_for_frame(&mut views), "a frame");
        assert_eq!(&pixels(&views)[..4], &[0, 0, 0, 255]);
    }

    #[cfg(target_vendor = "apple")]
    #[test]
    fn a_zero_sized_gpu_view_retires_its_surface() {
        let mut views = GpuViews::new(PixelFormat::Rgba);
        let (source, _) = fill();
        views.set(1, Some(source));
        views.show_on_surfaces(1, true);
        for hidden in [false, true] {
            views.set_size(1, size(px(2.0), px(2.0)), 1.0);
            if !wait_for_frame(&mut views) {
                eprintln!("no GPU: skipped");
                return;
            }
            assert_eq!(
                views.with_surface(1, |s| (s.width(), s.height())),
                Some((2, 2))
            );

            views.set_hidden(1, hidden);
            views.set_size(1, size(px(0.0), px(0.0)), 1.0);
            assert!(views.wants_frame(), "the platform must tick to clear");
            assert!(wait_for_frame(&mut views), "the platform must be notified");
            assert!(views.with_surface(1, |_| ()).is_none());
            assert!(!views.wants_frame(), "the clear was delivered");
        }
    }

    #[cfg(target_vendor = "apple")]
    #[test]
    fn a_gpu_view_collapsing_during_resize_clears_the_displayed_frame() {
        let mut views = GpuViews::new(PixelFormat::Rgba);
        let (source, _) = fill();
        views.set(1, Some(source));
        views.show_on_surfaces(1, true);
        views.set_size(1, size(px(2.0), px(2.0)), 1.0);
        if !wait_for_frame(&mut views) {
            eprintln!("no GPU: skipped");
            return;
        }
        assert_eq!(views.with_surface(1, |s| s.width()), Some(2));

        views.set_size(1, size(px(4.0), px(4.0)), 1.0);
        views.tick(|_| {});
        let start = Instant::now();
        while !views.views[&1].shared.frames().target.pending() {
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "a resized frame was not submitted"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(
            views.with_surface(1, |_| ()).is_none(),
            "the new pool has no collected frame"
        );

        views.set_size(1, size(px(0.0), px(0.0)), 1.0);
        assert!(
            views.wants_frame(),
            "the platform must tick to clear the old frame"
        );
        assert!(wait_for_frame(&mut views), "the platform must be notified");
        assert!(views.with_surface(1, |_| ()).is_none());
        assert!(!views.wants_frame(), "the clear was delivered");
    }

    #[test]
    fn animated_colors_are_argb() {
        let c = argb_color(0x80ff0000);
        assert_eq!((c.r, c.g, c.b), (1.0, 0.0, 0.0));
        assert!((c.a - 128.0 / 255.0).abs() < 1e-6);
    }

    #[test]
    fn frames_are_at_most_max_side_pixels() {
        let ((w, h), scale) = pixels(size(px(8192.0), px(100.0)), 2.0);
        assert_eq!((w, h), (MAX_SIDE, 50));
        assert!((scale - 0.5).abs() < 1e-6);
        assert_eq!(pixels(size(px(0.0), px(10.0)), 2.0).0, (0, 0));
    }
}
