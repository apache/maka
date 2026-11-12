//! The native backends' shader renderer (feature `shader`): what a shader view
//! ([`nsh_core::shader`]) draws, rendered with wgpu into pixels the backend
//! shows the way it shows a canvas' raster.
//!
//! A backend keeps one [`Renderer`] (the GPU device, the pipelines of the
//! shaders it drew), made the first time a shader is mounted, so an app
//! without shaders opens no device; [`Renderer::new`] is `None` where no
//! adapter is found, and shader views then show nothing of their own.
//! Each shader view has a [`ShaderView`]: the mounted layer, its uniforms
//! with the animated slots written in, its size and its clock. The backend
//! calls [`ShaderView::render`] on its frame clock while
//! [`ShaderView::wants_frame`]: rendering never waits for the GPU. A frame
//! is drawn into a texture and copied into one of two read-back buffers;
//! a later call finds it mapped, copies it into [`ShaderView::frame`] and
//! says so, and the backend draws those pixels (premultiplied, in the
//! [`PixelFormat`] it asked for). So a frame shows one or two display
//! frames after it is rendered, and a GPU that falls behind skips frames
//! instead of stalling the main thread. On Apple platforms a backend can
//! have a view render into IOSurfaces it shows as they are instead
//! ([`ShaderView::show_on_surfaces`], `shader_surfaces`): no pixels come
//! back to the CPU.
//!
//! Effects, transitions and shaders that read what is behind them get the
//! platform's pictures ([`ShaderView::set_input`], premultiplied, in the
//! renderer's [`PixelFormat`], covering the box and `overflow` points
//! beyond it), bound as the program's `sample_*` inputs; a transition's
//! `nsh.progress` runs on the view's clock ([`ShaderView::start_transition`]).
//! Frames cover the box and `overflow` points beyond each side
//! ([`ShaderView::overflow`]): the backend places them that far outside the
//! view.
//!
//! Limits: a frame is at most [`MAX_SIDE`] pixels a side (the scale drops
//! for larger views); a shader is rendered only when something it reads
//! changed (its size, its uniforms, `nsh.time` for animated ones), never
//! more than once per call. A shader that loops forever is stopped by the
//! operating system's GPU watchdog, as a web page's is.

use std::{
    borrow::Cow,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::{Duration, Instant},
};

use nsh_core::{
    animation::AnimationValue,
    geometry::{Percentage, Points, Size},
    shader::{PROGRESS_WORD, ShaderInput, ShaderLayer, ShaderRole, builtins},
};
use rustc_hash::FxHashMap;

pub use crate::shader_frame::{Frame, MAX_SIDE, PixelFormat};

/// This build links the renderer: a platform reports
/// `Environment::shaders` from it as it starts (`false` without the
/// feature), and [`Renderer::new`] says whether a GPU answers.
pub const LINKED: bool = true;

/// [`Renderer::new`] found no GPU adapter or device in this process: the
/// machine's answer, the same for every surface, so engines started after
/// it report `Environment::shaders` `false` without asking again.
static NO_GPU: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether [`Renderer::new`] found no GPU in this process.
pub(crate) fn no_gpu() -> bool {
    NO_GPU.load(Ordering::Relaxed)
}

fn texture_format(format: PixelFormat) -> wgpu::TextureFormat {
    match format {
        PixelFormat::Rgba => wgpu::TextureFormat::Rgba8Unorm,
        PixelFormat::Bgra => wgpu::TextureFormat::Bgra8Unorm,
    }
}

/// Render pipelines by their shader's hash and the format they render in.
type Pipelines = FxHashMap<(u64, wgpu::TextureFormat), Option<Arc<wgpu::RenderPipeline>>>;

/// The GPU device shader views render with, and the pipelines of the
/// shaders it has drawn.
pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    format: PixelFormat,
    /// The bind group layouts: the built-ins alone, with the uniforms,
    /// with the pictures, with both (index: uniforms + 2 × pictures).
    layouts: [wgpu::BindGroupLayout; 4],
    pipeline_layouts: [wgpu::PipelineLayout; 4],
    /// What a picture the platform has not given reads: transparent.
    empty: wgpu::TextureView,
    sampler: wgpu::Sampler,
    /// Pipelines by the hash of their shader's source and the format they
    /// render in; `None` for one the device refused (reported once).
    pipelines: std::cell::RefCell<Pipelines>,
}

/// The backends to open a device on, in order: the renderer takes the
/// first whose device opens, so no setting chooses one.
///
/// Linux tries OpenGL first: frames come back to the CPU every display
/// frame, and Vulkan drivers there (Mesa's ANV on Intel, among others) offer
/// no host-visible memory both coherent and cached, so wgpu maps its
/// read-back buffers write-combined and reading a frame out costs several
/// milliseconds of the main thread (a 2000×300 frame: 8–17 ms against
/// 0.2 ms through OpenGL). Elsewhere the platform's own API first.
fn backend_order() -> Vec<wgpu::Backends> {
    if cfg!(all(target_os = "linux", not(target_os = "android"))) {
        vec![wgpu::Backends::GL, wgpu::Backends::PRIMARY]
    } else {
        vec![wgpu::Backends::PRIMARY | wgpu::Backends::GL]
    }
}

impl Renderer {
    /// Opens a GPU device (blocking, once: adapters answer in milliseconds);
    /// `None` when there is none, which the log says. The platform then
    /// tells its engine ([`crate::EngineControl::shaders_unavailable`]).
    pub fn new(format: PixelFormat) -> Option<Renderer> {
        // The first backend that gives a device: an adapter found may still
        // refuse its device, and the next backend then gets its turn. On
        // NVIDIA's driver OpenGL does (wgpu's validation of indirect calls
        // needs compute shaders its GL context lacks), and Vulkan opens.
        let mut opened = None;
        let mut last = None;
        for backends in backend_order() {
            let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
                backends,
                ..wgpu::InstanceDescriptor::new_without_display_handle()
            });
            let adapter =
                match pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::LowPower,
                    ..Default::default()
                })) {
                    Ok(adapter) => adapter,
                    Err(e) => {
                        last = Some(format!("no GPU adapter ({e})"));
                        continue;
                    }
                };
            match pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                label: Some("nsh shaders"),
                required_limits:
                    wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()),
                ..Default::default()
            })) {
                Ok((device, queue)) => {
                    opened = Some((adapter, device, queue));
                    break;
                }
                Err(e) => {
                    let backend = adapter.get_info().backend;
                    log::debug!(
                        "shaders: no GPU device on {backend} ({e}); trying the next backend"
                    );
                    last = Some(format!("no GPU device on {backend} ({e})"));
                }
            }
        }
        let Some((adapter, device, queue)) = opened else {
            let e = last.unwrap_or_default();
            log::warn!("shaders: {e}; shader views draw nothing");
            NO_GPU.store(true, Ordering::Relaxed);
            return None;
        };
        // What validation missed is a warning, never a panic of the app.
        device.on_uncaptured_error(Arc::new(|e: wgpu::Error| {
            log::warn!("shaders: {e}");
        }));
        log::debug!("shaders: {:?}", adapter.get_info());
        let entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            // The vertex stage reads `nsh.size` and `nsh.overflow`.
            visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let pictures = || {
            std::iter::once(wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            })
            .chain(ShaderInput::ALL.into_iter().map(|input| {
                wgpu::BindGroupLayoutEntry {
                    binding: 3 + input.index() as u32,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                }
            }))
        };
        let layouts = [
            vec![entry(0)],
            vec![entry(0), entry(1)],
            std::iter::once(entry(0)).chain(pictures()).collect(),
            [entry(0), entry(1)].into_iter().chain(pictures()).collect(),
        ]
        .map(|entries: Vec<_>| {
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("nsh shader"),
                entries: &entries,
            })
        });
        let empty = device
            .create_texture(&picture_descriptor(texture_format(format), 1, 1))
            .create_view(&Default::default());
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("nsh pictures"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let pipeline_layouts = [0, 1, 2, 3].map(|i| {
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: None,
                bind_group_layouts: &[Some(&layouts[i])],
                immediate_size: 0,
            })
        });
        Some(Renderer {
            device,
            queue,
            format,
            layouts,
            pipeline_layouts,
            empty,
            sampler,
            pipelines: Default::default(),
        })
    }

    /// The format of its frames.
    pub fn format(&self) -> PixelFormat {
        self.format
    }

    /// Calls `f`, on a thread of the GPU driver's, once the GPU finished
    /// the frames rendered so far ([`ShaderView::render`]): a backend
    /// collects them then instead of polling on every display frame while
    /// they are [`ShaderView::pending`]. `false` (and `f` dropped) where the
    /// device cannot tell: the backend polls.
    pub fn when_done(&self, f: impl FnOnce() + Send + 'static) -> bool {
        #[cfg(target_vendor = "apple")]
        return crate::shader_surfaces::when_done(&self.queue, f);
        #[cfg(not(target_vendor = "apple"))]
        {
            drop(f);
            false
        }
    }

    fn pipeline(
        &self,
        layer: &ShaderLayer,
        format: wgpu::TextureFormat,
    ) -> Option<Arc<wgpu::RenderPipeline>> {
        let shader = &layer.shader;
        if let Some(p) = self.pipelines.borrow().get(&(shader.hash(), format)) {
            return p.clone();
        }
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = self
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("nsh shader"),
                source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(shader.wgsl())),
            });
        let uniforms = layout_index(layer);
        let pipeline = self
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("nsh shader"),
                layout: Some(&self.pipeline_layouts[uniforms]),
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some("nsh_vertex"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some("nsh_fragment"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                multiview_mask: None,
                cache: None,
            });
        let error = pollster::block_on(scope.pop());
        let pipeline = match error {
            Some(e) => {
                log::warn!(target: "js", "a shader the GPU refused: {e}");
                None
            }
            None => Some(Arc::new(pipeline)),
        };
        self.pipelines
            .borrow_mut()
            .insert((shader.hash(), format), pipeline.clone());
        pipeline
    }
}

/// Which bind group layout a layer's program takes.
fn layout_index(layer: &ShaderLayer) -> usize {
    usize::from(layer.shader.uniform_size() > 0)
        + 2 * usize::from(!layer.shader.inputs().is_empty())
}

fn picture_descriptor(
    format: wgpu::TextureFormat,
    width: u32,
    height: u32,
) -> wgpu::TextureDescriptor<'static> {
    wgpu::TextureDescriptor {
        label: Some("nsh shader picture"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    }
}

/// Why a picture of `len` bytes cannot be uploaded as `height` rows of
/// `width` pixels `stride` bytes apart: a wrong size would be a GPU
/// validation error outside any error scope.
fn picture_fits(
    renderer: &Renderer,
    len: usize,
    width: u32,
    height: u32,
    stride: u32,
) -> Result<(), String> {
    let max = renderer.device.limits().max_texture_dimension_2d;
    if width > max || height > max {
        return Err(format!("larger than the device's {max} pixels a side"));
    }
    let row = u64::from(width) * 4;
    if u64::from(stride) < row {
        return Err(format!("{stride} bytes a row hold no {width} pixels"));
    }
    let needed = u64::from(stride) * u64::from(height - 1) + row;
    if (len as u64) < needed {
        return Err(format!("{len} bytes hold no {needed}"));
    }
    Ok(())
}

/// A picture the platform gave, on the GPU.
struct Picture {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
}

/// Where a read-back buffer is.
mod state {
    pub(super) const IDLE: u8 = 0;
    pub(super) const MAPPING: u8 = 1;
    pub(super) const MAPPED: u8 = 2;
    pub(super) const FAILED: u8 = 3;
}

struct Readback {
    buffer: wgpu::Buffer,
    state: Arc<AtomicU8>,
    /// The frame's number.
    serial: u64,
}

/// What a view renders into, for one size.
struct Target {
    width: u32,
    height: u32,
    stride: u32,
    view: wgpu::TextureView,
    texture: wgpu::Texture,
    readbacks: [Readback; 2],
}

/// The buffers of a view's uniforms and the bind group naming them.
struct Bindings {
    builtins: wgpu::Buffer,
    uniforms: Option<wgpu::Buffer>,
    group: wgpu::BindGroup,
    /// The layout it was made for.
    layout: usize,
    /// The uniforms' size it was made for.
    size: u32,
}

/// The clock of `nsh.time`: seconds while it runs, kept while it is paused.
#[derive(Debug, Default, Clone, Copy)]
struct Clock {
    /// Since when it runs (`None`: paused or not started).
    since: Option<Instant>,
    /// The time it showed when it last stopped.
    kept: Duration,
}

impl Clock {
    fn time(&self, now: Instant) -> f32 {
        let running = self
            .since
            .map_or(Duration::ZERO, |s| now.saturating_duration_since(s));
        (self.kept + running).as_secs_f32()
    }
}

/// A shader view's state on the main thread: what it shows, at what size,
/// and its frames.
#[derive(Default)]
pub struct ShaderView {
    layer: Option<Arc<ShaderLayer>>,
    /// The uniforms with the animated slots written in.
    words: Vec<u32>,
    size: Size<Points>,
    scale: f32,
    clock: Clock,
    /// Something it reads changed since the last frame rendered.
    dirty: bool,
    target: Option<Target>,
    bindings: Option<Bindings>,
    serial: u64,
    frame: Frame,
    /// The pictures the platform gave, by [`ShaderInput::index`].
    pictures: [Option<Picture>; 4],
    /// The pictures changed since the bind group was made.
    pictures_changed: bool,
    /// `nsh.progress` as an animated value moved it.
    progress: Option<f32>,
    /// The transition running: since when and for how long.
    transition: Option<(Instant, Duration)>,
    /// It runs backwards: `nsh.progress` goes from 1 to 0.
    backwards: bool,
    /// Its frames go to IOSurfaces ([`Self::show_on_surfaces`]).
    #[cfg(target_vendor = "apple")]
    on_surfaces: bool,
    /// The surfaces, once a frame was rendered into one.
    #[cfg(target_vendor = "apple")]
    surfaces: Option<crate::shader_surfaces::Surfaces>,
}

impl ShaderView {
    /// Shows `layer` (`None`: nothing). The animated slots keep the values
    /// written into them while the program stays.
    pub fn set_layer(&mut self, layer: Option<Arc<ShaderLayer>>) {
        let same_program = match (&self.layer, &layer) {
            (Some(a), Some(b)) => a.shader == b.shader && a.slots == b.slots,
            _ => false,
        };
        match &layer {
            Some(l) if same_program => {
                // Constant words from the new layer, animated ones kept.
                let mut words = l.uniforms.to_vec();
                for slot in &l.slots {
                    let n = match slot.kind {
                        nsh_core::shader::SlotKind::Rgb => 3,
                        nsh_core::shader::SlotKind::Rgba => 4,
                        _ => 1,
                    };
                    let at = slot.word as usize;
                    if let (Some(dst), Some(src)) =
                        (words.get_mut(at..at + n), self.words.get(at..at + n))
                    {
                        dst.copy_from_slice(src);
                    }
                }
                self.words = words;
            }
            Some(l) => self.words = l.uniforms.to_vec(),
            None => {
                self.words.clear();
                self.frame = Frame::default();
                // A queued frame must not restore a layer that was cleared.
                self.target = None;
            }
        }
        let paused = layer.as_ref().is_none_or(|l| l.paused);
        let now = Instant::now();
        match (paused, self.clock.since) {
            (true, Some(since)) => {
                self.clock.kept += now.saturating_duration_since(since);
                self.clock.since = None;
            }
            (false, None) => self.clock.since = Some(now),
            _ => {}
        }
        if !same_program {
            self.bindings = None;
            self.progress = None;
        }
        if layer.is_none() {
            self.pictures = Default::default();
            self.transition = None;
        }
        self.layer = layer;
        self.dirty = true;
    }

    /// Takes the picture of `input` the platform made: `height` rows of
    /// `width` premultiplied pixels in the renderer's format, `stride`
    /// bytes apart, covering the box and [`Self::overflow`] points beyond
    /// each side. `None` lets it go (it reads transparent), and so does a
    /// picture whose bytes do not hold its rows or that is larger than the
    /// device's textures (with a warning).
    pub fn set_input(
        &mut self,
        renderer: &Renderer,
        input: ShaderInput,
        picture: Option<(&[u8], u32, u32, u32)>,
    ) {
        let picture =
            picture
                .filter(|p| p.1 > 0 && p.2 > 0)
                .filter(|&(pixels, width, height, stride)| {
                    match picture_fits(renderer, pixels.len(), width, height, stride) {
                        Ok(()) => true,
                        Err(why) => {
                            log::warn!(
                                "a shader's {} picture, {width} × {height}: {why}",
                                input.function()
                            );
                            false
                        }
                    }
                });
        let slot = &mut self.pictures[input.index()];
        let Some((pixels, width, height, stride)) = picture else {
            if slot.take().is_some() {
                self.pictures_changed = true;
                self.dirty = true;
            }
            return;
        };
        let format = texture_format(renderer.format);
        if picture_slot(renderer, slot, width, height, format) {
            self.pictures_changed = true;
        }
        let picture = slot.as_ref().expect("a picture");
        renderer.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &picture.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(stride),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.dirty = true;
    }

    /// Takes the frame it shows as the picture of `input` (a transition
    /// that starts over a running one starts from where it is); `false`
    /// when it shows none. On the GPU when the frame is on a surface.
    pub fn set_input_from_frame(&mut self, renderer: &Renderer, input: ShaderInput) -> bool {
        #[cfg(target_vendor = "apple")]
        if let Some(texture) = self.surfaces.as_ref().and_then(|s| s.shown_texture()) {
            let (width, height) = (texture.width(), texture.height());
            let slot = &mut self.pictures[input.index()];
            if picture_slot(renderer, slot, width, height, texture.format()) {
                self.pictures_changed = true;
            }
            let picture = slot.as_ref().expect("a picture");
            let mut encoder = renderer
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
            encoder.copy_texture_to_texture(
                texture.as_image_copy(),
                picture.texture.as_image_copy(),
                texture.size(),
            );
            renderer.queue.submit([encoder.finish()]);
            self.dirty = true;
            return true;
        }
        if self.frame.width == 0 {
            return false;
        }
        let frame = std::mem::take(&mut self.frame);
        let (width, height) = (frame.width, frame.height);
        self.set_input(
            renderer,
            input,
            Some((&frame.tight(), width, height, width * 4)),
        );
        self.frame = frame;
        true
    }

    /// Whether it has the picture of `input`.
    pub fn has_input(&self, input: ShaderInput) -> bool {
        self.pictures[input.index()].is_some()
    }

    /// Starts a transition: `nsh.progress` goes from 0 to 1 over
    /// `duration` from `now` (the platform gives the `from` picture first).
    pub fn start_transition(&mut self, duration: Duration, now: Instant) {
        self.transition = Some((now, duration));
        self.backwards = false;
        self.dirty = true;
    }

    /// Starts a transition that runs backwards, `nsh.progress` from 1 to 0
    /// (a page that leaves, a dialog that closes: the same shader as their
    /// coming, the other way).
    pub fn start_transition_backwards(&mut self, duration: Duration, now: Instant) {
        self.start_transition(duration, now);
        self.backwards = true;
    }

    /// Whether a transition runs at `now`; one that ended lets its `from`
    /// picture go (the children then show as they are).
    pub fn transitioning(&mut self, now: Instant) -> bool {
        match self.transition {
            Some((since, duration)) if now.saturating_duration_since(since) < duration => true,
            Some(_) => {
                self.transition = None;
                self.pictures[ShaderInput::From.index()] = None;
                self.pictures_changed = true;
                false
            }
            None => false,
        }
    }

    /// Whether the platform shows the frames instead of the children: an
    /// effect and a screen effect always, a transition while one runs.
    pub fn replaces_children(&mut self, now: Instant) -> bool {
        match self.layer.as_ref().map(|l| l.role) {
            Some(ShaderRole::Effect | ShaderRole::Screen) => true,
            Some(ShaderRole::Transition | ShaderRole::ScreenTransition) => self.transitioning(now),
            _ => false,
        }
    }

    /// How far beyond the box its frames reach, in points.
    pub fn overflow(&self) -> Points {
        self.layer.as_ref().map_or(Points::ZERO, |l| l.overflow)
    }

    fn progress_at(&self, now: Instant) -> f32 {
        if let Some((since, duration)) = self.transition {
            let t = now.saturating_duration_since(since).as_secs_f32();
            let p = (t / duration.as_secs_f32().max(f32::MIN_POSITIVE)).clamp(0.0, 1.0);
            return if self.backwards { 1.0 - p } else { p };
        }
        self.progress
            .or_else(|| self.layer.as_ref().map(|l| l.progress.0))
            .unwrap_or(0.0)
    }

    /// The layer it shows.
    pub fn layer(&self) -> Option<&Arc<ShaderLayer>> {
        self.layer.as_ref()
    }

    /// Writes animated slot `slot`'s value ([`ShaderLayer::write_slot`]).
    pub fn set_slot(&mut self, slot: u16, value: AnimationValue) {
        let Some(layer) = &self.layer else { return };
        if layer
            .slots
            .get(slot as usize)
            .is_some_and(|s| s.word == PROGRESS_WORD)
        {
            let progress = value.number();
            if self.progress != Some(progress) {
                self.progress = Some(progress);
                self.dirty = true;
            }
            return;
        }
        let before = self.words.clone();
        layer.write_slot(&mut self.words, slot, value);
        if before != self.words {
            self.dirty = true;
        }
    }

    /// The view's size in points and the pixels per point it shows at.
    pub fn set_size(&mut self, size: Size<Points>, scale: f32) {
        if self.size != size || self.scale != scale {
            self.size = size;
            self.scale = scale;
            self.dirty = true;
        }
    }

    /// Whether a call to [`Self::render`] has something to do: a frame to
    /// render (something changed, or its time runs) or one to collect.
    pub fn wants_frame(&self) -> bool {
        self.due() || (self.layer.is_some() && self.pending())
    }

    /// Whether [`Self::render`] renders a new frame: something changed, or
    /// its time runs ([`Self::animates`]). One that is only
    /// [`Self::pending`] waits for the GPU ([`Renderer::when_done`]).
    pub fn due(&self) -> bool {
        self.layer.is_some() && (self.dirty || self.animates())
    }

    /// Whether its frames change with time alone: it reads `nsh.time` and
    /// is not paused, or a transition runs. Such a view renders on every
    /// display frame; one that does not, only when something changed.
    pub fn animates(&self) -> bool {
        let Some(layer) = &self.layer else {
            return false;
        };
        (layer.shader.animated() && !layer.paused) || self.transition.is_some()
    }

    /// Whether a frame is on its way back from the GPU.
    pub fn pending(&self) -> bool {
        #[cfg(target_vendor = "apple")]
        if self.surfaces.as_ref().is_some_and(|s| s.pending()) {
            return true;
        }
        self.target.as_ref().is_some_and(|t| {
            t.readbacks
                .iter()
                .any(|r| r.state.load(Ordering::Acquire) != state::IDLE)
        })
    }

    /// The last frame collected (empty until one is, and while its frames
    /// go to surfaces).
    pub fn frame(&self) -> &Frame {
        &self.frame
    }

    /// Renders its frames into IOSurfaces the backend shows as they are
    /// ([`Self::surface`]) rather than reading them back into
    /// [`Self::frame`]: the window server matches their colours on the
    /// GPU, and no pixels come back to the CPU. Where the device is not
    /// Metal's, frames are read back as before.
    #[cfg(target_vendor = "apple")]
    pub fn show_on_surfaces(&mut self) {
        self.on_surfaces = true;
    }

    /// The surface of the last frame collected, while its frames go to
    /// surfaces ([`Self::show_on_surfaces`]): premultiplied `'BGRA'`
    /// pixels in sRGB, the size of the box and its overflow. A new one
    /// each time [`Self::render`] says the frame is new.
    #[cfg(target_vendor = "apple")]
    pub fn surface(&self) -> Option<&objc2_io_surface::IOSurfaceRef> {
        self.surfaces.as_ref().and_then(|s| s.shown())
    }

    /// Collects a frame that came back without rendering another; `true`
    /// when [`Self::frame`] is new. A page's or a dialog's overlay whose
    /// transition ended shows the frames still on their way this way.
    pub fn collect_frame(&mut self, renderer: &Renderer) -> bool {
        let _ = renderer.device.poll(wgpu::PollType::Poll);
        self.collect()
    }

    /// Renders a frame if one is due and collects one that came back;
    /// `true` when [`Self::frame`] is new. `now` is the frame clock's time.
    pub fn render(&mut self, renderer: &Renderer, now: Instant) -> bool {
        let mut collected = self.collect_frame(renderer);
        let Some(layer) = self.layer.clone() else {
            return collected;
        };
        let running = self.transitioning(now);
        let due = self.dirty || (layer.shader.animated() && !layer.paused) || running;
        let progress = self.progress_at(now);
        if !due {
            return collected;
        }
        let (width, height) = self.pixels();
        if width == 0 || height == 0 {
            if self.frame.width != 0 {
                self.frame = Frame::default();
                collected = true;
            }
            self.dirty = false;
            return collected;
        }
        // On surfaces where asked and possible (else read back): a free one,
        // or none (all busy: the frame is skipped).
        #[cfg(target_vendor = "apple")]
        let mut surface = None;
        #[cfg(target_vendor = "apple")]
        if self.on_surfaces {
            if self
                .surfaces
                .as_ref()
                .is_none_or(|s| (s.width, s.height) != (width, height))
            {
                self.surfaces = Some(crate::shader_surfaces::Surfaces::new(width, height));
            }
            match self
                .surfaces
                .as_mut()
                .expect("surfaces")
                .free(&renderer.device)
            {
                Ok(Some(i)) => surface = Some(i),
                Ok(None) => return collected,
                Err(_) => {
                    log::debug!("shaders: no IOSurface frames on this device; reading frames back");
                    self.on_surfaces = false;
                    self.surfaces = None;
                }
            }
        }
        #[cfg(target_vendor = "apple")]
        let on_surfaces = self.on_surfaces;
        #[cfg(not(target_vendor = "apple"))]
        let on_surfaces = false;
        let format = if on_surfaces {
            #[cfg(target_vendor = "apple")]
            {
                crate::shader_surfaces::FORMAT
            }
            #[cfg(not(target_vendor = "apple"))]
            unreachable!()
        } else {
            texture_format(renderer.format)
        };
        let Some(pipeline) = renderer.pipeline(&layer, format) else {
            self.dirty = false;
            return collected;
        };
        // Where the frame goes: a free surface, or the texture and a free
        // read-back buffer. None free: the GPU is behind, skip this frame.
        let destination = if on_surfaces {
            #[cfg(target_vendor = "apple")]
            {
                Destination::Surface(surface.expect("a free surface"))
            }
            #[cfg(not(target_vendor = "apple"))]
            unreachable!()
        } else {
            if self
                .target
                .as_ref()
                .is_none_or(|t| (t.width, t.height) != (width, height))
            {
                self.target = Some(target(renderer, width, height));
            }
            let target = self.target.as_ref().expect("target");
            match target
                .readbacks
                .iter()
                .position(|r| r.state.load(Ordering::Acquire) == state::IDLE)
            {
                Some(i) => Destination::Readback(i),
                None => return collected,
            }
        };
        let size = layer.shader.uniform_size();
        let layout = layout_index(&layer);
        if std::mem::take(&mut self.pictures_changed)
            || self
                .bindings
                .as_ref()
                .is_none_or(|b| b.size != size || b.layout != layout)
        {
            self.bindings = Some(bindings(renderer, size, layout, &self.pictures));
        }
        let bindings = self.bindings.as_ref().expect("bindings");
        let overflow = layer.overflow;
        let scale = width as f32 / (self.size.width.0 + 2.0 * overflow.0).max(f32::MIN_POSITIVE);
        let time = self.clock.time(now);
        renderer.queue.write_buffer(
            &bindings.builtins,
            0,
            &words_bytes(&builtins(
                self.size,
                time,
                scale,
                Percentage(progress),
                overflow,
            )),
        );
        if let Some(buffer) = &bindings.uniforms {
            renderer
                .queue
                .write_buffer(buffer, 0, &words_bytes(&self.words));
        }
        let view = match destination {
            Destination::Readback(_) => &self.target.as_ref().expect("target").view,
            #[cfg(target_vendor = "apple")]
            Destination::Surface(i) => self.surfaces.as_ref().expect("surfaces").view(i),
        };
        let mut encoder = renderer
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("nsh shader"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bindings.group, &[]);
            pass.draw(0..3, 0..1);
        }
        self.serial += 1;
        match destination {
            #[cfg(target_vendor = "apple")]
            Destination::Surface(i) => {
                renderer.queue.submit([encoder.finish()]);
                self.surfaces.as_mut().expect("surfaces").submitted(
                    i,
                    self.serial,
                    &renderer.queue,
                );
            }
            Destination::Readback(i) => {
                let target = self.target.as_mut().expect("target");
                let readback = &mut target.readbacks[i];
                encoder.copy_texture_to_buffer(
                    wgpu::TexelCopyTextureInfo {
                        texture: &target.texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::TexelCopyBufferInfo {
                        buffer: &readback.buffer,
                        layout: wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: Some(target.stride),
                            rows_per_image: Some(height),
                        },
                    },
                    wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                );
                renderer.queue.submit([encoder.finish()]);
                readback.serial = self.serial;
                readback.state.store(state::MAPPING, Ordering::Release);
                let flag = readback.state.clone();
                readback
                    .buffer
                    .slice(..)
                    .map_async(wgpu::MapMode::Read, move |result| {
                        let s = if result.is_ok() {
                            state::MAPPED
                        } else {
                            state::FAILED
                        };
                        flag.store(s, Ordering::Release);
                    });
            }
        }
        self.dirty = false;
        let _ = renderer.device.poll(wgpu::PollType::Poll);
        self.collect() || collected
    }

    /// The frame's size in pixels: the box and the overflow around it.
    fn pixels(&self) -> (u32, u32) {
        if self.size.width.0 <= 0.0 || self.size.height.0 <= 0.0 {
            return (0, 0);
        }
        let grow = 2.0 * self.overflow().0;
        let (w, h) = (self.size.width.0 + grow, self.size.height.0 + grow);
        let mut scale = self.scale.max(0.0);
        let side = w.max(h) * scale;
        if side > MAX_SIDE as f32 {
            scale *= MAX_SIDE as f32 / side;
        }
        ((w * scale).round() as u32, (h * scale).round() as u32)
    }

    /// Shows the newest frame done: on its surface, or copied into
    /// [`Self::frame`] from the newest mapped buffer.
    fn collect(&mut self) -> bool {
        #[cfg(target_vendor = "apple")]
        if let Some(surfaces) = &mut self.surfaces
            && surfaces.collect()
        {
            return true;
        }
        let Some(target) = &mut self.target else {
            return false;
        };
        let mut newest: Option<usize> = None;
        for (i, r) in target.readbacks.iter().enumerate() {
            match r.state.load(Ordering::Acquire) {
                state::MAPPED if newest.is_none_or(|n| target.readbacks[n].serial < r.serial) => {
                    newest = Some(i)
                }
                state::FAILED => r.state.store(state::IDLE, Ordering::Release),
                _ => {}
            }
        }
        let Some(newest) = newest else {
            return false;
        };
        let mut changed = false;
        for (i, r) in target.readbacks.iter().enumerate() {
            if r.state.load(Ordering::Acquire) != state::MAPPED {
                continue;
            }
            if i == newest && r.serial > self.frame.serial {
                let data = r.buffer.slice(..).get_mapped_range();
                self.frame.pixels.clear();
                self.frame.pixels.extend_from_slice(&data);
                drop(data);
                self.frame.width = target.width;
                self.frame.height = target.height;
                self.frame.stride = target.stride;
                self.frame.serial = r.serial;
                changed = true;
            }
            r.buffer.unmap();
            r.state.store(state::IDLE, Ordering::Release);
        }
        changed
    }
}

/// Where [`ShaderView::render`] draws a frame.
#[derive(Clone, Copy)]
enum Destination {
    /// The target's texture, then read-back buffer `.0`.
    Readback(usize),
    /// Surface `.0`.
    #[cfg(target_vendor = "apple")]
    Surface(usize),
}

/// Makes `slot` a picture of `width` × `height` pixels in `format` unless
/// it is one; `true` when it made one (the bind group is stale).
fn picture_slot(
    renderer: &Renderer,
    slot: &mut Option<Picture>,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
) -> bool {
    if slot
        .as_ref()
        .is_some_and(|p| (p.width, p.height, p.format) == (width, height, format))
    {
        return false;
    }
    let texture = renderer
        .device
        .create_texture(&picture_descriptor(format, width, height));
    let view = texture.create_view(&Default::default());
    *slot = Some(Picture {
        texture,
        view,
        width,
        height,
        format,
    });
    true
}

fn target(renderer: &Renderer, width: u32, height: u32) -> Target {
    let texture = renderer.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("nsh shader"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: texture_format(renderer.format),
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let stride = (width * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
    let readback = || Readback {
        buffer: renderer.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("nsh shader frame"),
            size: u64::from(stride) * u64::from(height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        }),
        state: Arc::new(AtomicU8::new(state::IDLE)),
        serial: 0,
    };
    Target {
        width,
        height,
        stride,
        view: texture.create_view(&Default::default()),
        texture,
        readbacks: [readback(), readback()],
    }
}

fn bindings(
    renderer: &Renderer,
    size: u32,
    layout: usize,
    pictures: &[Option<Picture>; 4],
) -> Bindings {
    let buffer = |size: u32| {
        renderer.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("nsh shader uniforms"),
            size: u64::from(size),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    };
    let builtins = buffer(32);
    let uniforms = (size > 0).then(|| buffer(size));
    let mut entries = vec![wgpu::BindGroupEntry {
        binding: 0,
        resource: builtins.as_entire_binding(),
    }];
    if let Some(u) = &uniforms {
        entries.push(wgpu::BindGroupEntry {
            binding: 1,
            resource: u.as_entire_binding(),
        });
    }
    if layout >= 2 {
        entries.push(wgpu::BindGroupEntry {
            binding: 2,
            resource: wgpu::BindingResource::Sampler(&renderer.sampler),
        });
        for input in ShaderInput::ALL {
            let view = pictures[input.index()]
                .as_ref()
                .map_or(&renderer.empty, |p| &p.view);
            entries.push(wgpu::BindGroupEntry {
                binding: 3 + input.index() as u32,
                resource: wgpu::BindingResource::TextureView(view),
            });
        }
    }
    let group = renderer
        .device
        .create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &renderer.layouts[layout],
            entries: &entries,
        });
    Bindings {
        builtins,
        uniforms,
        group,
        layout,
        size,
    }
}

fn words_bytes(words: &[u32]) -> Vec<u8> {
    words.iter().flat_map(|w| w.to_ne_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use nsh_core::{
        Color,
        geometry::{px, size},
        shader::{Shader, UniformValue},
    };

    use super::*;

    fn layer(source: &str, uniforms: &[(&str, UniformValue)]) -> Arc<ShaderLayer> {
        let values: Vec<_> = uniforms
            .iter()
            .map(|(n, v)| ((*n).into(), v.clone()))
            .collect();
        let mut warnings = Vec::new();
        let layer = ShaderLayer::new(Shader::compile(source).unwrap(), &values, &mut warnings);
        assert!(warnings.is_empty(), "{warnings:?}");
        Arc::new(layer)
    }

    /// Renders until a frame comes back (the GPU answers within a second).
    fn frame(view: &mut ShaderView, renderer: &Renderer) -> Frame {
        frame_at(view, renderer, Instant::now())
    }

    fn frame_at(view: &mut ShaderView, renderer: &Renderer, now: Instant) -> Frame {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            if view.render(renderer, now) {
                return view.frame().clone();
            }
            let _ = renderer.device.poll(wgpu::PollType::wait_indefinitely());
        }
        panic!("no frame");
    }

    fn pixel(frame: &Frame, x: u32, y: u32) -> [u8; 4] {
        let at = (y * frame.stride + x * 4) as usize;
        frame.pixels[at..at + 4].try_into().unwrap()
    }

    #[test]
    fn renders_uniforms_and_premultiplies() {
        let Some(renderer) = Renderer::new(PixelFormat::Rgba) else {
            eprintln!("no GPU: skipped");
            return;
        };
        let mut view = ShaderView::default();
        view.set_size(size(px(4.0), px(2.0)), 2.0);
        view.set_layer(Some(layer(
            "struct Uniforms { color: vec4f, split: f32 }\n\
             fn shade(uv: vec2f) -> vec4f {\n\
               if (uv.x < uniforms.split) { return uniforms.color; }\n\
               return vec4f(0.0, 0.0, 1.0, 0.5);\n\
             }",
            &[
                ("color", UniformValue::Color(Color(0xff0000ff))),
                ("split", UniformValue::Number(0.5)),
            ],
        )));
        let f = frame(&mut view, &renderer);
        assert_eq!((f.width, f.height), (8, 4));
        assert_eq!(pixel(&f, 0, 0), [255, 0, 0, 255]);
        // Straight blue at half alpha, premultiplied.
        let right = pixel(&f, 7, 3);
        assert_eq!([right[0], right[1]], [0, 0], "{right:?}");
        assert!((127..=128).contains(&right[2]) && (127..=128).contains(&right[3]));
        assert!(!view.wants_frame(), "a still shader renders once");
        // An animated slot draws again with its new value.
        let animated = layer(
            "struct Uniforms { color: vec4f }\nfn shade(uv: vec2f) -> vec4f { return uniforms.color; }",
            &[("color", UniformValue::Animated(3))],
        );
        view.set_layer(Some(animated));
        view.set_slot(0, AnimationValue::Color(0x00ff00ff));
        let f = frame(&mut view, &renderer);
        assert_eq!(pixel(&f, 3, 1), [0, 255, 0, 255]);
    }

    #[test]
    fn clearing_retires_pending_readback_before_rebinding() {
        let Some(renderer) = Renderer::new(PixelFormat::Rgba) else {
            eprintln!("no GPU: skipped");
            return;
        };
        let mut view = ShaderView::default();
        view.set_size(size(px(2.0), px(2.0)), 1.0);
        let source = "struct Uniforms { color: vec4f }\nfn shade(uv: vec2f) -> vec4f { return uniforms.color; }";
        view.set_layer(Some(layer(
            source,
            &[("color", UniformValue::Color(Color(0xff0000ff)))],
        )));
        let first = frame(&mut view, &renderer);
        assert_eq!(pixel(&first, 0, 0), [255, 0, 0, 255]);

        // Remap the real rendered pixels without polling, so clearing always
        // precedes collection regardless of how quickly the GPU renders.
        view.serial += 1;
        let readback = &mut view.target.as_mut().unwrap().readbacks[0];
        readback.serial = view.serial;
        readback.state.store(state::MAPPING, Ordering::Release);
        let completion = readback.state.clone();
        let flag = completion.clone();
        readback
            .buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                flag.store(
                    if result.is_ok() {
                        state::MAPPED
                    } else {
                        state::FAILED
                    },
                    Ordering::Release,
                );
            });
        assert!(view.pending());
        view.set_layer(None);
        let _ = renderer.device.poll(wgpu::PollType::wait_indefinitely());
        assert_ne!(completion.load(Ordering::Acquire), state::MAPPING);
        assert!(!view.render(&renderer, Instant::now()));
        assert!(view.frame().pixels.is_empty());
        assert_eq!((view.frame().width, view.frame().height), (0, 0));
        assert!(!view.wants_frame());

        view.set_layer(Some(layer(
            source,
            &[("color", UniformValue::Color(Color(0x00ff00ff)))],
        )));
        let rebound = frame(&mut view, &renderer);
        assert_eq!(pixel(&rebound, 0, 0), [0, 255, 0, 255]);
        assert!(rebound.serial > first.serial);
        assert!(!view.wants_frame());
    }

    #[test]
    fn time_runs_and_pauses() {
        let Some(renderer) = Renderer::new(PixelFormat::Bgra) else {
            eprintln!("no GPU: skipped");
            return;
        };
        let mut view = ShaderView::default();
        view.set_size(size(px(1.0), px(1.0)), 1.0);
        let source = "fn shade(uv: vec2f) -> vec4f { return vec4f(min(nsh.time / 1000.0, 1.0), 0.0, 0.0, 1.0); }";
        view.set_layer(Some(layer(source, &[])));
        assert!(view.wants_frame());
        let late = Instant::now() + Duration::from_secs(500);
        let f = frame_at(&mut view, &renderer, late);
        // Bgra: red is the third byte; about half a second in a thousand.
        let red = pixel(&f, 0, 0)[2];
        assert!((120..=135).contains(&red), "{red}");
        let mut paused = (*layer(source, &[])).clone();
        paused.paused = true;
        view.set_layer(Some(Arc::new(paused)));
        frame(&mut view, &renderer);
        // What was still on its way comes back; then nothing is due.
        for _ in 0..10 {
            let _ = renderer.device.poll(wgpu::PollType::wait_indefinitely());
            view.render(&renderer, Instant::now());
        }
        assert!(!view.wants_frame());
    }

    /// Renders until a frame shows on a surface; its pixels as RGBA rows.
    #[cfg(target_vendor = "apple")]
    fn surface_frame(view: &mut ShaderView, renderer: &Renderer) -> Vec<Vec<[u8; 4]>> {
        use objc2_io_surface::IOSurfaceLockOptions;
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            if view.render(renderer, Instant::now()) {
                let surface = view.surface().expect("a surface");
                assert_eq!(view.frame().width, 0, "nothing is read back");
                // SAFETY: the surface is locked while its rows are read.
                unsafe {
                    surface.lock(IOSurfaceLockOptions::ReadOnly, std::ptr::null_mut());
                    let base = surface.base_address().as_ptr().cast::<u8>();
                    let stride = surface.bytes_per_row();
                    let rows = (0..surface.height())
                        .map(|y| {
                            (0..surface.width())
                                .map(|x| {
                                    let p = base.add(y * stride + x * 4);
                                    // 'BGRA' in memory.
                                    [*p.add(2), *p.add(1), *p, *p.add(3)]
                                })
                                .collect()
                        })
                        .collect();
                    surface.unlock(IOSurfaceLockOptions::ReadOnly, std::ptr::null_mut());
                    return rows;
                }
            }
            let _ = renderer.device.poll(wgpu::PollType::wait_indefinitely());
        }
        panic!("no frame");
    }

    #[cfg(target_vendor = "apple")]
    #[test]
    fn frames_on_surfaces_have_the_pixels_read_back_ones_have() {
        let Some(renderer) = Renderer::new(PixelFormat::Rgba) else {
            eprintln!("no GPU: skipped");
            return;
        };
        let mut view = ShaderView::default();
        view.show_on_surfaces();
        view.set_size(size(px(4.0), px(2.0)), 2.0);
        let split = |color: u32| {
            layer(
                "struct Uniforms { color: vec4f }\n\
                 fn shade(uv: vec2f) -> vec4f {\n\
                   if (uv.x < 0.5) { return uniforms.color; }\n\
                   return vec4f(0.0, 0.0, 1.0, 0.5);\n\
                 }",
                &[("color", UniformValue::Color(Color(color)))],
            )
        };
        view.set_layer(Some(split(0xff0000ff)));
        let rows = surface_frame(&mut view, &renderer);
        assert_eq!((rows[0].len(), rows.len()), (8, 4));
        assert_eq!(rows[0][0], [255, 0, 0, 255]);
        // Straight blue at half alpha, premultiplied.
        let right = rows[3][7];
        assert_eq!([right[0], right[1]], [0, 0], "{right:?}");
        assert!((127..=128).contains(&right[2]) && (127..=128).contains(&right[3]));
        assert!(!view.wants_frame(), "a still shader renders once");
        // The next frame is on another surface: the one shown stays as it is
        // while the window server may read it.
        let first = view.surface().map(|s| s as *const _);
        view.set_layer(Some(split(0x00ff00ff)));
        let rows = surface_frame(&mut view, &renderer);
        assert_eq!(rows[1][0], [0, 255, 0, 255]);
        assert_ne!(view.surface().map(|s| s as *const _), first);
    }

    #[cfg(target_vendor = "apple")]
    #[test]
    fn a_frame_on_a_surface_becomes_a_picture_on_the_gpu() {
        let Some(renderer) = Renderer::new(PixelFormat::Rgba) else {
            eprintln!("no GPU: skipped");
            return;
        };
        let mut view = ShaderView::default();
        view.show_on_surfaces();
        view.set_size(size(px(2.0), px(1.0)), 1.0);
        assert!(
            !view.set_input_from_frame(&renderer, ShaderInput::Content),
            "no frame yet"
        );
        view.set_layer(Some(layer(
            "fn shade(uv: vec2f) -> vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }",
            &[],
        )));
        surface_frame(&mut view, &renderer);
        assert!(view.set_input_from_frame(&renderer, ShaderInput::Content));
        // The shader swaps red and blue of what it was given: the red frame.
        let effect = (*layer(
            "fn shade(uv: vec2f) -> vec4f { let c = sample_content(uv); return vec4f(c.b, c.g, c.r, c.a); }",
            &[],
        ))
        .clone()
        .with_role(ShaderRole::Effect);
        view.set_layer(Some(Arc::new(effect)));
        let rows = surface_frame(&mut view, &renderer);
        assert_eq!(rows[0][0], [0, 0, 255, 255]);
        assert_eq!(rows[0][1], [0, 0, 255, 255]);
    }

    #[test]
    fn a_read_back_frame_becomes_a_picture() {
        let Some(renderer) = Renderer::new(PixelFormat::Rgba) else {
            eprintln!("no GPU: skipped");
            return;
        };
        let mut view = ShaderView::default();
        view.set_size(size(px(2.0), px(1.0)), 1.0);
        view.set_layer(Some(layer(
            "fn shade(uv: vec2f) -> vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }",
            &[],
        )));
        frame(&mut view, &renderer);
        assert!(view.set_input_from_frame(&renderer, ShaderInput::Content));
        let effect = (*layer(
            "fn shade(uv: vec2f) -> vec4f { let c = sample_content(uv); return vec4f(c.b, c.g, c.r, c.a); }",
            &[],
        ))
        .clone()
        .with_role(ShaderRole::Effect);
        view.set_layer(Some(Arc::new(effect)));
        let f = frame(&mut view, &renderer);
        assert_eq!(pixel(&f, 0, 0), [0, 0, 255, 255]);
    }

    #[test]
    fn effects_read_their_pictures() {
        let Some(renderer) = Renderer::new(PixelFormat::Rgba) else {
            eprintln!("no GPU: skipped");
            return;
        };
        let mut view = ShaderView::default();
        view.set_size(size(px(2.0), px(1.0)), 1.0);
        let effect = (*layer(
            "fn shade(uv: vec2f) -> vec4f { let c = sample_content(uv); return vec4f(c.b, c.g, c.r, c.a); }",
            &[],
        ))
        .clone()
        .with_role(ShaderRole::Effect);
        assert!(effect.shader.inputs().contains(ShaderInput::Content));
        view.set_layer(Some(Arc::new(effect)));
        assert!(view.replaces_children(Instant::now()));
        // Without a picture, the content is transparent.
        let f = frame(&mut view, &renderer);
        assert_eq!(pixel(&f, 0, 0), [0, 0, 0, 0]);
        // Red, then green: the shader swaps red and blue.
        let picture = [255, 0, 0, 255, 0, 255, 0, 255];
        view.set_input(&renderer, ShaderInput::Content, Some((&picture, 2, 1, 8)));
        let f = frame(&mut view, &renderer);
        assert_eq!(pixel(&f, 0, 0), [0, 0, 255, 255]);
        assert_eq!(pixel(&f, 1, 0), [0, 255, 0, 255]);
    }

    #[test]
    fn a_picture_its_bytes_do_not_hold_is_let_go() {
        let Some(renderer) = Renderer::new(PixelFormat::Rgba) else {
            eprintln!("no GPU: skipped");
            return;
        };
        let mut view = ShaderView::default();
        view.set_input(&renderer, ShaderInput::Content, Some((&[0; 8], 2, 1, 8)));
        assert!(view.has_input(ShaderInput::Content));
        // Two rows of two pixels in one row's bytes, a row narrower than its
        // pixels, a picture wider than the device's textures.
        view.set_input(&renderer, ShaderInput::Content, Some((&[0; 8], 2, 2, 8)));
        assert!(!view.has_input(ShaderInput::Content));
        view.set_input(&renderer, ShaderInput::From, Some((&[0; 16], 2, 2, 4)));
        assert!(!view.has_input(ShaderInput::From));
        let max = renderer.device.limits().max_texture_dimension_2d;
        view.set_input(
            &renderer,
            ShaderInput::To,
            Some((&[0; 4], max + 1, 1, 4 * (max + 1))),
        );
        assert!(!view.has_input(ShaderInput::To));
    }

    #[test]
    fn transitions_run_their_progress() {
        let Some(renderer) = Renderer::new(PixelFormat::Rgba) else {
            eprintln!("no GPU: skipped");
            return;
        };
        let mut view = ShaderView::default();
        view.set_size(size(px(1.0), px(1.0)), 1.0);
        let Some(crossfade) = nsh_core::shader::crossfade() else {
            eprintln!("no cross-fade: skipped");
            return;
        };
        let fade =
            ShaderLayer::new(crossfade, &[], &mut Vec::new()).with_role(ShaderRole::Transition);
        view.set_layer(Some(Arc::new(fade)));
        let start = Instant::now();
        assert!(!view.replaces_children(start), "no transition runs yet");
        view.set_input(
            &renderer,
            ShaderInput::From,
            Some((&[255, 0, 0, 255], 1, 1, 4)),
        );
        view.set_input(
            &renderer,
            ShaderInput::To,
            Some((&[0, 0, 255, 255], 1, 1, 4)),
        );
        view.start_transition(Duration::from_millis(1000), start);
        assert!(view.replaces_children(start));
        let f = frame_at(&mut view, &renderer, start + Duration::from_millis(500));
        let p = pixel(&f, 0, 0);
        assert!(
            (120..=135).contains(&p[0]) && (120..=135).contains(&p[2]),
            "{p:?}"
        );
        let end = start + Duration::from_millis(1500);
        assert!(!view.replaces_children(end), "it ended");
        assert!(!view.has_input(ShaderInput::From));
    }

    #[test]
    fn overflow_grows_the_frame_and_animated_progress_moves() {
        let Some(renderer) = Renderer::new(PixelFormat::Rgba) else {
            eprintln!("no GPU: skipped");
            return;
        };
        let mut view = ShaderView::default();
        view.set_size(size(px(2.0), px(2.0)), 1.0);
        let glow = ShaderLayer::new(
            Shader::compile(
                "fn shade(uv: vec2f) -> vec4f { if (uv.x < 0.0) { return vec4f(nsh.progress, 0.0, 0.0, 1.0); } return vec4f(0.0, 0.0, 1.0, 1.0); }",
            )
            .unwrap(),
            &[],
            &mut Vec::new(),
        )
        .with_role(ShaderRole::Effect)
        .with_overflow(px(1.0))
        .with_progress(Percentage(0.0), Some(9));
        view.set_layer(Some(Arc::new(glow)));
        view.set_slot(0, AnimationValue::Number(1.0));
        let f = frame(&mut view, &renderer);
        assert_eq!((f.width, f.height), (4, 4), "the box and a point around it");
        assert_eq!(
            pixel(&f, 0, 1),
            [255, 0, 0, 255],
            "left of the box: progress 1"
        );
        assert_eq!(pixel(&f, 2, 2), [0, 0, 255, 255]);
    }

    #[test]
    fn a_changed_view_renders_once_and_the_gpu_says_when_it_is_done() {
        let Some(renderer) = Renderer::new(PixelFormat::Rgba) else {
            eprintln!("no GPU: skipped");
            return;
        };
        let mut view = ShaderView::default();
        view.set_size(size(px(2.0), px(2.0)), 1.0);
        view.set_layer(Some(layer(
            "struct Uniforms { a: f32 }\n\
             fn shade(uv: vec2f) -> vec4f { return vec4f(uniforms.a, 0.0, 0.0, 1.0); }",
            &[("a", UniformValue::Number(1.0))],
        )));
        assert!(view.due() && !view.animates(), "a new layer: one frame");
        let _ = view.render(&renderer, Instant::now());
        assert!(!view.due(), "rendered: nothing new until something changes");
        let (tx, rx) = std::sync::mpsc::channel();
        if !renderer.when_done(move || {
            let _ = tx.send(());
        }) {
            eprintln!("the device does not say when it is done: skipped");
            return;
        }
        rx.recv_timeout(Duration::from_secs(5))
            .expect("told without polling");
        assert!(view.collect_frame(&renderer), "the frame is back");
        assert!(!view.wants_frame(), "nothing left to render or collect");
        assert_eq!(pixel(view.frame(), 0, 0), [255, 0, 0, 255]);
    }

    #[test]
    fn collecting_a_frame_renders_none() {
        let Some(renderer) = Renderer::new(PixelFormat::Rgba) else {
            eprintln!("no GPU: skipped");
            return;
        };
        let mut view = ShaderView::default();
        view.set_size(size(px(2.0), px(2.0)), 1.0);
        // Reads `nsh.time`: `render` draws again on every call.
        view.set_layer(Some(layer(
            "fn shade(uv: vec2f) -> vec4f { return vec4f(fract(nsh.time), 0.0, 0.0, 1.0); }",
            &[],
        )));
        assert!(!view.render(&renderer, Instant::now()), "on its way");
        let start = Instant::now();
        while !view.collect_frame(&renderer) {
            assert!(start.elapsed() < Duration::from_secs(5), "no frame");
            let _ = renderer.device.poll(wgpu::PollType::wait_indefinitely());
        }
        assert_eq!((view.frame().width, view.frame().height), (2, 2));
        assert!(!view.pending(), "no other frame was rendered");
        assert!(!view.collect_frame(&renderer));
        assert!(view.wants_frame(), "its time still runs");
    }
}
