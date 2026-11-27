//! Where a view's GPU frames go and how the backend gets them: rendered into
//! a texture and read back into a [`Frame`] the backend draws, or, on Apple
//! platforms and Windows, rendered into surfaces the backend shows as they
//! are (`shader_surfaces`). A view keeps one [`FrameTarget`]; whoever renders
//! its frames asks it where the next one goes ([`FrameTarget::surface_format`],
//! [`FrameTarget::destination`]), encodes into [`FrameTarget::view`] and hands
//! the work back ([`FrameTarget::submit`]). Nothing here waits for the GPU:
//! with every destination busy the frame is skipped, and a frame is collected
//! by a later call once it is done ([`FrameTarget::collect`]).

use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};

#[cfg(windows)]
use crate::shader_frame::SharedTexture;
use crate::shader_frame::{Frame, PixelFormat};

/// Bytes to write into buffers just before a frame's commands run: its
/// uniforms. They go with the frame, so they are written in the order the
/// frames are submitted, on whichever thread submits them.
pub(crate) type Writes = Vec<(wgpu::Buffer, Vec<u8>)>;

/// Writes `writes` into their buffers.
fn write(queue: &wgpu::Queue, writes: Writes) {
    for (buffer, bytes) in writes {
        queue.write_buffer(&buffer, 0, &bytes);
    }
}

/// A draw or texture transfer, to finish and submit in order.
pub(crate) struct Submission {
    writes: Writes,
    encoder: wgpu::CommandEncoder,
    completion: Completion,
}

enum Completion {
    #[cfg(any(target_vendor = "apple", windows))]
    Transfer,
    Readback(wgpu::Buffer, Arc<AtomicU8>),
    #[cfg(target_vendor = "apple")]
    Surface(crate::shader_surfaces::Submitted),
}

impl Submission {
    #[cfg(any(target_vendor = "apple", windows))]
    pub(crate) fn transfer(encoder: wgpu::CommandEncoder) -> Self {
        Self {
            writes: Writes::new(),
            encoder,
            completion: Completion::Transfer,
        }
    }

    /// Writes its bytes, finishes and submits its commands.
    pub(crate) fn run(self, queue: &wgpu::Queue) {
        write(queue, self.writes);
        queue.submit([self.encoder.finish()]);
        match self.completion {
            #[cfg(any(target_vendor = "apple", windows))]
            Completion::Transfer => {}
            Completion::Readback(buffer, flag) => {
                buffer
                    .slice(..)
                    .map_async(wgpu::MapMode::Read, move |result| {
                        let state = if result.is_ok() {
                            state::MAPPED
                        } else {
                            state::FAILED
                        };
                        flag.store(state, Ordering::Release);
                    });
            }
            #[cfg(target_vendor = "apple")]
            Completion::Surface(submitted) => submitted.after_submit(queue),
        }
    }
}

/// The texture format of read-back frames in `format`.
pub(crate) fn texture_format(format: PixelFormat) -> wgpu::TextureFormat {
    match format {
        PixelFormat::Rgba => wgpu::TextureFormat::Rgba8Unorm,
        PixelFormat::Bgra => wgpu::TextureFormat::Bgra8Unorm,
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

/// The texture read-back frames render into, for one size, and its two
/// buffers.
struct Target {
    width: u32,
    height: u32,
    stride: u32,
    view: wgpu::TextureView,
    texture: wgpu::Texture,
    readbacks: [Readback; 2],
}

impl Target {
    fn newest_mapped(&self) -> Option<usize> {
        let mut newest: Option<usize> = None;
        for (i, r) in self.readbacks.iter().enumerate() {
            match r.state.load(Ordering::Acquire) {
                state::MAPPED if newest.is_none_or(|n| self.readbacks[n].serial < r.serial) => {
                    newest = Some(i)
                }
                state::FAILED => r.state.store(state::IDLE, Ordering::Release),
                _ => {}
            }
        }
        newest
    }

    fn collect_mapped(&self, newest: usize, frame: &mut Frame) -> bool {
        let selected = &self.readbacks[newest];
        let chosen_serial = selected.serial;
        let changed = chosen_serial > frame.serial;
        if changed {
            let data = selected.buffer.slice(..).get_mapped_range();
            frame.pixels.clear();
            frame.pixels.extend_from_slice(&data);
            frame.width = self.width;
            frame.height = self.height;
            frame.stride = self.stride;
            frame.serial = chosen_serial;
        }
        // A newer readback can finish while the chosen pixels are copied.
        for r in &self.readbacks {
            if r.serial <= chosen_serial && r.state.load(Ordering::Acquire) == state::MAPPED {
                r.buffer.unmap();
                r.state.store(state::IDLE, Ordering::Release);
            }
        }
        changed
    }
}

/// Where a frame is drawn ([`FrameTarget::destination`]).
#[derive(Clone, Copy)]
pub(crate) enum Destination {
    /// The target's texture, then read-back buffer `.0`.
    Readback(usize),
    /// Surface `.0`.
    #[cfg(any(target_vendor = "apple", windows))]
    Surface(usize),
}

/// A view's frames: where they are rendered and the last one collected.
#[derive(Default)]
pub(crate) struct FrameTarget {
    target: Option<Target>,
    serial: u64,
    frame: Frame,
    /// Its frames go to surfaces ([`Self::show_on_surfaces`]).
    #[cfg(any(target_vendor = "apple", windows))]
    on_surfaces: bool,
    /// The surfaces, once a frame was rendered into one.
    #[cfg(any(target_vendor = "apple", windows))]
    surfaces: Option<crate::shader_surfaces::Surfaces>,
    /// Windows: the textures of the size before the last resize, while the
    /// new size has no frame to show: their frame shows until one does, as
    /// a read-back frame stays shown until the next comes back.
    #[cfg(windows)]
    previous: Option<crate::shader_surfaces::Surfaces>,
}

impl FrameTarget {
    /// Renders frames into surfaces (`on`) or reads them back; `true` when
    /// it stopped using surfaces, which drops them (the next frame is read
    /// back, so the caller renders one).
    #[cfg(any(target_vendor = "apple", windows))]
    pub(crate) fn show_on_surfaces(&mut self, on: bool) -> bool {
        if self.on_surfaces == on {
            return false;
        }
        self.on_surfaces = on;
        if on {
            return false;
        }
        self.surfaces = None;
        #[cfg(windows)]
        {
            self.previous = None;
        }
        true
    }

    /// The format the next frame of `width` × `height` pixels is rendered
    /// in: a surface's where its frames go to surfaces, else `format`'s;
    /// `None` when every surface is busy (the frame is skipped). A device
    /// that cannot share surfaces sends the view back to reading frames
    /// back.
    pub(crate) fn surface_format(
        &mut self,
        device: &wgpu::Device,
        format: PixelFormat,
        width: u32,
        height: u32,
    ) -> Option<wgpu::TextureFormat> {
        #[cfg(any(target_vendor = "apple", windows))]
        if self.on_surfaces {
            if self
                .surfaces
                .as_ref()
                .is_none_or(|s| (s.width, s.height) != (width, height))
            {
                // The old size's frame shows until the new size has one.
                #[cfg(windows)]
                if let Some(old) = (self.surfaces.take()).filter(|s| s.shown_texture().is_some()) {
                    self.previous = Some(old);
                }
                self.surfaces = Some(crate::shader_surfaces::Surfaces::new(width, height));
            }
            match self.surfaces.as_mut().expect("surfaces").free(device) {
                Ok(Some(_)) => return Some(crate::shader_surfaces::FORMAT),
                Ok(None) => return None,
                Err(_) => {
                    log::debug!("shaders: no shared frames on this device; reading frames back");
                    self.on_surfaces = false;
                    self.surfaces = None;
                    #[cfg(windows)]
                    {
                        self.previous = None;
                    }
                }
            }
        }
        #[cfg(not(any(target_vendor = "apple", windows)))]
        let _ = (device, width, height);
        Some(texture_format(format))
    }

    /// Where the next frame of `width` × `height` pixels goes, after
    /// [`Self::surface_format`] gave its format: a free surface, or the
    /// read-back texture and a free buffer; `None` when all are busy (the
    /// GPU is behind: the frame is skipped).
    pub(crate) fn destination(
        &mut self,
        device: &wgpu::Device,
        format: PixelFormat,
        width: u32,
        height: u32,
    ) -> Option<Destination> {
        #[cfg(any(target_vendor = "apple", windows))]
        if self.on_surfaces {
            let surfaces = self.surfaces.as_mut()?;
            return surfaces
                .free(device)
                .ok()
                .flatten()
                .map(Destination::Surface);
        }
        if self
            .target
            .as_ref()
            .is_none_or(|t| (t.width, t.height) != (width, height))
        {
            self.target = Some(target(device, format, width, height));
        }
        let target = self.target.as_ref().expect("target");
        target
            .readbacks
            .iter()
            .position(|r| r.state.load(Ordering::Acquire) == state::IDLE)
            .map(Destination::Readback)
    }

    /// The texture view a frame for `destination` renders into.
    pub(crate) fn view(&self, destination: Destination) -> &wgpu::TextureView {
        match destination {
            Destination::Readback(_) => &self.target.as_ref().expect("target").view,
            #[cfg(any(target_vendor = "apple", windows))]
            Destination::Surface(i) => self.surfaces.as_ref().expect("surfaces").view(i),
        }
    }

    /// Submits `encoder`, which rendered a frame into `destination`'s view:
    /// a surface's frame is ready once the GPU did the work, a read-back
    /// frame is copied into the buffer and mapped. The frame shows from the
    /// [`Self::collect`] after it is done.
    pub(crate) fn submit(
        &mut self,
        queue: &wgpu::Queue,
        destination: Destination,
        encoder: wgpu::CommandEncoder,
    ) {
        self.submit_on(queue, None, destination, encoder, Writes::new());
    }

    /// As [`Self::submit`], after writing `writes`. When using `send`, the
    /// destination is busy as soon as the frame is queued, before the
    /// submitting thread finishes the encoder and sends it to the GPU.
    pub(crate) fn submit_on(
        &mut self,
        queue: &wgpu::Queue,
        send: Option<&dyn Fn(Submission)>,
        destination: Destination,
        mut encoder: wgpu::CommandEncoder,
        writes: Writes,
    ) {
        self.serial += 1;
        let completion = match destination {
            #[cfg(target_vendor = "apple")]
            Destination::Surface(i) => Completion::Surface(
                self.surfaces
                    .as_mut()
                    .expect("surfaces")
                    .submitting(i, self.serial),
            ),
            #[cfg(windows)]
            Destination::Surface(i) => {
                write(queue, writes);
                queue.submit([encoder.finish()]);
                self.surfaces
                    .as_mut()
                    .expect("surfaces")
                    .submitted(i, self.serial, queue);
                return;
            }
            Destination::Readback(i) => {
                let target = self.target.as_mut().expect("target");
                let (width, height, stride) = (target.width, target.height, target.stride);
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
                            bytes_per_row: Some(stride),
                            rows_per_image: Some(height),
                        },
                    },
                    wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                );
                readback.serial = self.serial;
                readback.state.store(state::MAPPING, Ordering::Release);
                Completion::Readback(readback.buffer.clone(), readback.state.clone())
            }
        };
        let submission = Submission {
            writes,
            encoder,
            completion,
        };
        match send {
            Some(send) => send(submission),
            None => submission.run(queue),
        }
    }

    /// Whether a frame is on its way back from the GPU.
    pub(crate) fn pending(&self) -> bool {
        #[cfg(any(target_vendor = "apple", windows))]
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
    /// go to surfaces; on Windows its serial still counts the frames shown
    /// on shared textures).
    pub(crate) fn frame(&self) -> &Frame {
        &self.frame
    }

    /// Takes the last frame collected, leaving an empty one; give it back
    /// with [`Self::restore_frame`].
    pub(crate) fn take_frame(&mut self) -> Frame {
        std::mem::take(&mut self.frame)
    }

    /// Puts back a frame [`Self::take_frame`] took.
    pub(crate) fn restore_frame(&mut self, frame: Frame) {
        self.frame = frame;
    }

    /// Retires the displayed and in-flight frames; `true` when one was shown.
    pub(crate) fn clear_frame(&mut self) -> bool {
        let had = self.frame.width != 0;
        #[cfg(any(target_vendor = "apple", windows))]
        let had = had || self.shown_texture().is_some();
        self.frame = Frame::default();
        self.target = None;
        #[cfg(any(target_vendor = "apple", windows))]
        {
            self.surfaces = None;
        }
        #[cfg(windows)]
        {
            self.previous = None;
        }
        had
    }

    /// Windows: the texture of the last frame collected, while its frames go
    /// to textures ([`Self::show_on_surfaces`]). Each call is a draw: the
    /// backend signals the value returned once its frame is submitted.
    #[cfg(windows)]
    pub(crate) fn surface(&self) -> Option<SharedTexture> {
        (self.surfaces.as_ref().and_then(|s| s.shown()))
            .or_else(|| self.previous.as_ref().and_then(|s| s.shown()))
    }

    /// The surface of the last frame collected, while its frames go to
    /// surfaces ([`Self::show_on_surfaces`]).
    #[cfg(target_vendor = "apple")]
    pub(crate) fn surface(&self) -> Option<&objc2_io_surface::IOSurfaceRef> {
        self.surfaces.as_ref().and_then(|s| s.shown())
    }

    /// The texture of the frame shown on a surface (Windows: or the one of
    /// the size before, while the new size has none).
    #[cfg(any(target_vendor = "apple", windows))]
    pub(crate) fn shown_texture(&self) -> Option<&wgpu::Texture> {
        let shown = self.surfaces.as_ref().and_then(|s| s.shown_texture());
        #[cfg(windows)]
        let shown = shown.or_else(|| self.previous.as_ref().and_then(|s| s.shown_texture()));
        shown
    }

    /// Shows the newest frame done: on its surface, or copied into
    /// [`Self::frame`] from the newest mapped buffer; `true` when the frame
    /// shown is new. The caller polls the device first.
    pub(crate) fn collect(&mut self) -> bool {
        #[cfg(any(target_vendor = "apple", windows))]
        if let Some(surfaces) = &mut self.surfaces
            && surfaces.collect()
        {
            #[cfg(windows)]
            {
                self.frame.serial = surfaces.shown_serial();
                self.previous = None;
            }
            return true;
        }
        self.target.as_ref().is_some_and(|target| {
            target
                .newest_mapped()
                .is_some_and(|newest| target.collect_mapped(newest, &mut self.frame))
        })
    }

    /// Signals the surfaces' fence from the CPU, as the backend's device
    /// does once a frame is submitted.
    #[cfg(all(windows, test))]
    pub(crate) fn signal_surfaces(&self, value: u64) {
        if let Some(surfaces) = &self.surfaces {
            surfaces.signal(value);
        }
    }

    /// Remaps the first read-back buffer without polling, so tests can
    /// verify clearing retires an in-flight read-back before it collects.
    #[cfg(test)]
    pub(crate) fn remap_readback_for_test(&mut self) -> Arc<AtomicU8> {
        self.serial += 1;
        let readback = &mut self.target.as_mut().expect("target").readbacks[0];
        readback.serial = self.serial;
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
        completion
    }

    #[cfg(test)]
    pub(crate) fn is_readback_mapping(flag: &AtomicU8) -> bool {
        flag.load(Ordering::Acquire) == state::MAPPING
    }
}

fn target(device: &wgpu::Device, format: PixelFormat, width: u32, height: u32) -> Target {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("nsh frame"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: texture_format(format),
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let stride = (width * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
    let readback = || Readback {
        buffer: device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("nsh frame read-back"),
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

#[cfg(all(test, target_vendor = "apple"))]
pub(crate) mod tests {
    use std::cell::Cell;

    use crate::shader::Renderer;

    use super::*;

    pub(crate) fn clear(
        device: &wgpu::Device,
        view: &wgpu::TextureView,
        color: wgpu::Color,
    ) -> wgpu::CommandEncoder {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(color),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        encoder
    }

    #[test]
    fn a_readback_completed_after_selection_stays_pending() {
        let Some((device, queue)) = Renderer::metal_device_for_test() else {
            eprintln!("no Metal GPU: skipped");
            return;
        };
        let mut frames = FrameTarget::default();
        let mut draw = |color| {
            let destination = frames
                .destination(&device, PixelFormat::Bgra, 1, 1)
                .unwrap();
            let encoder = clear(&device, frames.view(destination), color);
            let queued = Cell::new(None);
            frames.submit_on(
                &queue,
                Some(&|submission| queued.set(Some(submission))),
                destination,
                encoder,
                Writes::new(),
            );
            queued.into_inner().unwrap()
        };
        let first = draw(wgpu::Color::RED);
        let second = draw(wgpu::Color::GREEN);
        first.run(&queue);
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        let target = frames.target.as_ref().unwrap();
        let chosen = target.newest_mapped().unwrap();

        second.run(&queue);
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        assert!(target.collect_mapped(chosen, &mut frames.frame));
        assert_eq!(frames.frame().pixels[..4], [0, 0, 255, 255]);
        assert!(
            frames.pending(),
            "newer readback must keep the view scheduled"
        );
        assert!(frames.collect());
        assert_eq!(frames.frame().pixels[..4], [0, 255, 0, 255]);
        assert!(!frames.pending());
    }
}
