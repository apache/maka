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
//! instead of stalling the main thread.
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
    geometry::{Points, Size},
    shader::{ShaderLayer, builtins},
};
use rustc_hash::FxHashMap;

/// The largest side of a frame, in pixels.
pub const MAX_SIDE: u32 = 4096;

/// The pixels a backend shows: 8 bits per channel, premultiplied alpha.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PixelFormat {
    /// Red, green, blue, alpha (GDK's `R8G8B8A8_PREMULTIPLIED`, Core
    /// Graphics' premultiplied last, Android's `ARGB_8888`).
    #[default]
    Rgba,
    /// Blue, green, red, alpha (Direct2D's, GPUI's).
    Bgra,
}

impl PixelFormat {
    fn texture(self) -> wgpu::TextureFormat {
        match self {
            PixelFormat::Rgba => wgpu::TextureFormat::Rgba8Unorm,
            PixelFormat::Bgra => wgpu::TextureFormat::Bgra8Unorm,
        }
    }
}

/// A rendered frame: `height` rows of `width` pixels, `stride` bytes apart.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct Frame {
    /// The pixels, row by row.
    pub pixels: Vec<u8>,
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// Bytes from one row to the next (at least `width * 4`).
    pub stride: u32,
    /// Counts the frames shown: a new value is a new picture.
    pub serial: u64,
}

impl Frame {
    /// The rows, without their padding.
    pub fn rows(&self) -> impl Iterator<Item = &[u8]> {
        let row = self.width as usize * 4;
        self.pixels
            .chunks(self.stride.max(1) as usize)
            .take(self.height as usize)
            .map(move |r| &r[..row.min(r.len())])
    }

    /// The pixels with no padding between rows (`width * 4` bytes apart).
    pub fn tight(&self) -> Cow<'_, [u8]> {
        if self.stride == self.width * 4 {
            Cow::Borrowed(&self.pixels)
        } else {
            Cow::Owned(self.rows().flatten().copied().collect())
        }
    }
}

/// The GPU device shader views render with, and the pipelines of the
/// shaders it has drawn.
pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    format: PixelFormat,
    /// The bind group layouts: the built-ins alone, and with the uniforms.
    layouts: [wgpu::BindGroupLayout; 2],
    pipeline_layouts: [wgpu::PipelineLayout; 2],
    /// Pipelines by the hash of their shader's source; `None` for one the
    /// device refused (reported once).
    pipelines: std::cell::RefCell<FxHashMap<u64, Option<Arc<wgpu::RenderPipeline>>>>,
}

impl Renderer {
    /// Opens a GPU device (blocking, once: adapters answer in milliseconds);
    /// `None` when there is none, which the log says.
    pub fn new(format: PixelFormat) -> Option<Renderer> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::from_env()
                .unwrap_or(wgpu::Backends::PRIMARY | wgpu::Backends::GL),
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let adapter =
            match pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::LowPower,
                ..Default::default()
            })) {
                Ok(adapter) => adapter,
                Err(e) => {
                    log::warn!("shaders: no GPU adapter ({e}); shader views draw nothing");
                    return None;
                }
            };
        let (device, queue) =
            match pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                label: Some("nsh shaders"),
                required_limits:
                    wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()),
                ..Default::default()
            })) {
                Ok(device) => device,
                Err(e) => {
                    log::warn!("shaders: no GPU device ({e}); shader views draw nothing");
                    return None;
                }
            };
        // What validation missed is a warning, never a panic of the app.
        device.on_uncaptured_error(Arc::new(|e: wgpu::Error| {
            log::warn!("shaders: {e}");
        }));
        log::debug!("shaders: {:?}", adapter.get_info());
        let entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let layouts = [
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("nsh built-ins"),
                entries: &[entry(0)],
            }),
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("nsh built-ins and uniforms"),
                entries: &[entry(0), entry(1)],
            }),
        ];
        let pipeline_layouts = [0, 1].map(|i| {
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
            pipelines: Default::default(),
        })
    }

    /// The format of its frames.
    pub fn format(&self) -> PixelFormat {
        self.format
    }

    fn pipeline(&self, layer: &ShaderLayer) -> Option<Arc<wgpu::RenderPipeline>> {
        let shader = &layer.shader;
        if let Some(p) = self.pipelines.borrow().get(&shader.hash()) {
            return p.clone();
        }
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = self
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("nsh shader"),
                source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(shader.wgsl())),
            });
        let uniforms = usize::from(shader.uniform_size() > 0);
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
                        format: self.format.texture(),
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
            .insert(shader.hash(), pipeline.clone());
        pipeline
    }
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
        }
        self.layer = layer;
        self.dirty = true;
    }

    /// The layer it shows.
    pub fn layer(&self) -> Option<&Arc<ShaderLayer>> {
        self.layer.as_ref()
    }

    /// Writes animated slot `slot`'s value ([`ShaderLayer::write_slot`]).
    pub fn set_slot(&mut self, slot: u16, value: AnimationValue) {
        let Some(layer) = &self.layer else { return };
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
        let Some(layer) = &self.layer else {
            return false;
        };
        self.dirty || (layer.shader.animated() && !layer.paused) || self.pending()
    }

    /// Whether a frame is on its way back from the GPU.
    pub fn pending(&self) -> bool {
        self.target.as_ref().is_some_and(|t| {
            t.readbacks
                .iter()
                .any(|r| r.state.load(Ordering::Acquire) != state::IDLE)
        })
    }

    /// The last frame collected (empty until one is).
    pub fn frame(&self) -> &Frame {
        &self.frame
    }

    /// Renders a frame if one is due and collects one that came back;
    /// `true` when [`Self::frame`] is new. `now` is the frame clock's time.
    pub fn render(&mut self, renderer: &Renderer, now: Instant) -> bool {
        let _ = renderer.device.poll(wgpu::PollType::Poll);
        let mut collected = self.collect();
        let Some(layer) = self.layer.clone() else {
            return collected;
        };
        let due = self.dirty || (layer.shader.animated() && !layer.paused);
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
        let Some(pipeline) = renderer.pipeline(&layer) else {
            self.dirty = false;
            return collected;
        };
        if self
            .target
            .as_ref()
            .is_none_or(|t| (t.width, t.height) != (width, height))
        {
            self.target = Some(target(renderer, width, height));
        }
        let target = self.target.as_mut().expect("target");
        // Both buffers on their way: the GPU is behind, skip this frame.
        let Some(readback) = target
            .readbacks
            .iter_mut()
            .find(|r| r.state.load(Ordering::Acquire) == state::IDLE)
        else {
            return collected;
        };
        let size = layer.shader.uniform_size();
        if self.bindings.as_ref().is_none_or(|b| b.size != size) {
            self.bindings = Some(bindings(renderer, size));
        }
        let bindings = self.bindings.as_ref().expect("bindings");
        let scale = width as f32 / self.size.width.0.max(f32::MIN_POSITIVE);
        let time = self.clock.time(now);
        renderer.queue.write_buffer(
            &bindings.builtins,
            0,
            &words_bytes(&builtins(self.size, time, scale)),
        );
        if let Some(buffer) = &bindings.uniforms {
            renderer
                .queue
                .write_buffer(buffer, 0, &words_bytes(&self.words));
        }
        let mut encoder = renderer
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("nsh shader"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target.view,
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
        self.serial += 1;
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
        self.dirty = false;
        let _ = renderer.device.poll(wgpu::PollType::Poll);
        self.collect() || collected
    }

    /// The frame's size in pixels.
    fn pixels(&self) -> (u32, u32) {
        let (w, h) = (self.size.width.0.max(0.0), self.size.height.0.max(0.0));
        let mut scale = self.scale.max(0.0);
        let side = w.max(h) * scale;
        if side > MAX_SIDE as f32 {
            scale *= MAX_SIDE as f32 / side;
        }
        ((w * scale).round() as u32, (h * scale).round() as u32)
    }

    /// Copies the newest mapped frame into [`Self::frame`].
    fn collect(&mut self) -> bool {
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
            // wgpu 30 reports a range it cannot map; the frame then keeps
            // the pixels it has.
            if i == newest
                && r.serial > self.frame.serial
                && let Ok(data) = r.buffer.slice(..).get_mapped_range()
            {
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
        format: renderer.format.texture(),
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

fn bindings(renderer: &Renderer, size: u32) -> Bindings {
    let buffer = |size: u32| {
        renderer.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("nsh shader uniforms"),
            size: u64::from(size),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    };
    let builtins = buffer(16);
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
    let group = renderer
        .device
        .create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &renderer.layouts[usize::from(uniforms.is_some())],
            entries: &entries,
        });
    Bindings {
        builtins,
        uniforms,
        group,
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
}
