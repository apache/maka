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
        mut encoder: wgpu::CommandEncoder,
    ) {
        self.serial += 1;
        match destination {
            #[cfg(any(target_vendor = "apple", windows))]
            Destination::Surface(i) => {
                queue.submit([encoder.finish()]);
                self.surfaces
                    .as_mut()
                    .expect("surfaces")
                    .submitted(i, self.serial, queue);
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
                queue.submit([encoder.finish()]);
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

    /// Drops the cleared layer's frames, including those still queued on the GPU.
    pub(crate) fn clear_layer(&mut self) {
        self.clear_frame();
        self.target = None;
        #[cfg(any(target_vendor = "apple", windows))]
        {
            self.surfaces = None;
        }
        #[cfg(windows)]
        {
            self.previous = None;
        }
    }

    /// Forgets the frame read back; `true` when there was one.
    pub(crate) fn clear_frame(&mut self) -> bool {
        let had = self.frame.width != 0;
        self.frame = Frame::default();
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

    /// Signals the surfaces' fence from the CPU, as the backend's device
    /// does once a frame is submitted.
    #[cfg(all(windows, test))]
    pub(crate) fn signal_surfaces(&self, value: u64) {
        if let Some(surfaces) = &self.surfaces {
            surfaces.signal(value);
        }
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
