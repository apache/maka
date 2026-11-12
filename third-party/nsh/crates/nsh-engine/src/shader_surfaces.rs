//! Apple: a shader view's frames on IOSurfaces ([`ShaderView::show_on_surfaces`]).
//!
//! Read back, a frame costs the main thread twice: the pixels copied out of
//! the GPU's buffer, then Core Animation converting the CGImage they become
//! from sRGB to the display's colour space, on the CPU, every frame, for a
//! view as large as a window. Here the GPU renders straight into an
//! IOSurface tagged sRGB, the platform sets it as its layer's `contents`,
//! and the window server matches its colours on the GPU: the main thread
//! only encodes the pass.
//!
//! A view keeps up to [`SLOTS`] surfaces of its frame's size, made as they
//! are needed (a resize makes one or two, not three). A frame is rendered
//! into one the window server no longer uses ([`IOSurfaceRef::is_in_use`]),
//! is ready once the GPU finished the work submitted with it, and shows
//! from the next [`Surfaces::collect`]; the one it replaces goes back to
//! the pool. With all of them busy the frame is skipped, as a read-back one
//! is when both buffers are on their way.
//!
//! [`ShaderView::show_on_surfaces`]: crate::shader::ShaderView::show_on_surfaces

use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};

use objc2_core_foundation::{CFDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_io_surface::{
    IOSurfaceRef, kIOSurfaceBytesPerElement, kIOSurfaceBytesPerRow, kIOSurfaceColorSpace,
    kIOSurfaceHeight, kIOSurfacePixelFormat, kIOSurfaceWidth,
};
use objc2_metal::{
    MTLDevice, MTLPixelFormat, MTLTextureDescriptor, MTLTextureType, MTLTextureUsage,
};

/// The format of the surfaces' textures: the IOSurface's `'BGRA'`.
pub(crate) const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Bgra8Unorm;

/// The surfaces of a view: the one shown, one being rendered, and one the
/// window server may still hold.
const SLOTS: usize = 3;

/// `'BGRA'`: 8 bits a channel, premultiplied, blue first in memory.
const BGRA: i32 = 0x4247_5241;

/// Where a surface is.
mod state {
    /// Free (once the window server lets it go).
    pub(super) const IDLE: u8 = 0;
    /// The GPU renders a frame into it.
    pub(super) const RENDERING: u8 = 1;
    /// Its frame is done, not shown yet.
    pub(super) const DONE: u8 = 2;
    /// Its frame shows.
    pub(super) const SHOWN: u8 = 3;
}

struct Slot {
    surface: CFRetained<IOSurfaceRef>,
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    state: Arc<AtomicU8>,
    /// The frame's number.
    serial: u64,
}

/// A view's surfaces, for one size.
pub(crate) struct Surfaces {
    pub(crate) width: u32,
    pub(crate) height: u32,
    slots: Vec<Slot>,
    /// The slot whose frame shows.
    shown: Option<usize>,
}

/// No surface can be made: the device is not Metal's, or IOSurface refused
/// (the view reads its frames back then).
#[derive(Debug)]
pub(crate) struct Unavailable;

impl Surfaces {
    /// Surfaces of `width` × `height` pixels (none made yet).
    pub(crate) fn new(width: u32, height: u32) -> Surfaces {
        Surfaces {
            width,
            height,
            slots: Vec::with_capacity(SLOTS),
            shown: None,
        }
    }

    /// A free surface to render into, one the window server let go, made
    /// on `device` while there are fewer than [`SLOTS`]; `Ok(None)` when
    /// all are busy.
    pub(crate) fn free(&mut self, device: &wgpu::Device) -> Result<Option<usize>, Unavailable> {
        let free = self
            .slots
            .iter()
            .position(|s| s.state.load(Ordering::Acquire) == state::IDLE && !s.surface.is_in_use());
        if free.is_some() || self.slots.len() == SLOTS {
            return Ok(free);
        }
        self.slots
            .push(slot(device, self.width, self.height).ok_or(Unavailable)?);
        Ok(Some(self.slots.len() - 1))
    }

    /// The view of slot `i`'s texture.
    pub(crate) fn view(&self, i: usize) -> &wgpu::TextureView {
        &self.slots[i].view
    }

    /// The frame `serial` was submitted into slot `i`: ready once the GPU
    /// did the work submitted so far (heard at a later device poll).
    pub(crate) fn submitted(&mut self, i: usize, serial: u64, queue: &wgpu::Queue) {
        let slot = &mut self.slots[i];
        slot.serial = serial;
        slot.state.store(state::RENDERING, Ordering::Release);
        let flag = slot.state.clone();
        queue.on_submitted_work_done(move || flag.store(state::DONE, Ordering::Release));
    }

    /// Shows the newest frame done, if newer than the one shown; `true`
    /// when [`Self::shown`] changed. Older frames done go back to the pool
    /// unseen, and so does the one replaced.
    pub(crate) fn collect(&mut self) -> bool {
        let shown_serial = self.shown.map_or(0, |i| self.slots[i].serial);
        let newest = self
            .slots
            .iter()
            .enumerate()
            .filter(|(_, s)| s.state.load(Ordering::Acquire) == state::DONE)
            .max_by_key(|(_, s)| s.serial)
            .map(|(i, _)| i);
        let Some(newest) = newest else {
            return false;
        };
        for (i, s) in self.slots.iter().enumerate() {
            if i != newest && s.state.load(Ordering::Acquire) == state::DONE {
                s.state.store(state::IDLE, Ordering::Release);
            }
        }
        if self.slots[newest].serial <= shown_serial {
            self.slots[newest]
                .state
                .store(state::IDLE, Ordering::Release);
            return false;
        }
        if let Some(old) = self.shown.replace(newest) {
            self.slots[old].state.store(state::IDLE, Ordering::Release);
        }
        self.slots[newest]
            .state
            .store(state::SHOWN, Ordering::Release);
        true
    }

    /// Whether a frame is on its way: rendering, or done and not shown.
    pub(crate) fn pending(&self) -> bool {
        self.slots.iter().any(|s| {
            matches!(
                s.state.load(Ordering::Acquire),
                state::RENDERING | state::DONE
            )
        })
    }

    /// The surface of the frame shown.
    pub(crate) fn shown(&self) -> Option<&IOSurfaceRef> {
        self.shown.map(|i| &*self.slots[i].surface)
    }

    /// The texture of the frame shown.
    pub(crate) fn shown_texture(&self) -> Option<&wgpu::Texture> {
        self.shown.map(|i| &self.slots[i].texture)
    }
}

/// Calls `f` on a thread of Metal's once the GPU finished the work
/// submitted to `queue` so far: an empty command buffer committed after it,
/// which completes after the buffers before it on the queue. `false` (and
/// `f` dropped) when the queue is not Metal's.
pub(crate) fn when_done(queue: &wgpu::Queue, f: impl FnOnce() + Send + 'static) -> bool {
    use std::sync::Mutex;

    use objc2_metal::{MTLCommandBuffer, MTLCommandQueue};

    // SAFETY: the raw queue is only used to commit a command buffer of its
    // own, which wgpu does not track and which holds no resources.
    let Some(hal) = (unsafe { queue.as_hal::<wgpu::hal::api::Metal>() }) else {
        return false;
    };
    let Some(buffer) = hal.as_raw().commandBuffer() else {
        return false;
    };
    // Metal copies the block, which it calls once.
    let f = Mutex::new(Some(f));
    let block = block2::RcBlock::new(move |_| {
        if let Some(f) = f.lock().ok().and_then(|mut f| f.take()) {
            f();
        }
    });
    // SAFETY: a handler taking the command buffer, added before the buffer
    // is committed.
    unsafe { buffer.addCompletedHandler(block2::RcBlock::as_ptr(&block)) };
    buffer.commit();
    true
}

/// One surface and its texture on `device`.
fn slot(device: &wgpu::Device, width: u32, height: u32) -> Option<Slot> {
    let surface = surface(width, height)?;
    // SAFETY: the raw device is only read, to make a texture of it.
    let hal = unsafe { device.as_hal::<wgpu::hal::api::Metal>() }?;
    // SAFETY: a descriptor of a 2D texture the size of the surface, in its
    // format, which the GPU renders into and the shaders may sample.
    let raw = unsafe {
        let descriptor =
            MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
                MTLPixelFormat::BGRA8Unorm,
                width as usize,
                height as usize,
                false,
            );
        descriptor.setUsage(MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead);
        hal.raw_device()
            .newTextureWithDescriptor_iosurface_plane(&descriptor, &surface, 0)?
    };
    drop(hal);
    // SAFETY: `raw` is a 2D texture of `device`'s Metal device, one level
    // and one layer, in `FORMAT`, of the size given.
    let hal_texture = unsafe {
        wgpu::hal::metal::Device::texture_from_raw(
            raw,
            FORMAT,
            MTLTextureType::Type2D,
            1,
            1,
            wgpu::hal::CopyExtent {
                width,
                height,
                depth: 1,
            },
        )
    };
    // SAFETY: the descriptor says what `hal_texture` is.
    let texture = unsafe {
        device.create_texture_from_hal::<wgpu::hal::api::Metal>(
            hal_texture,
            &wgpu::TextureDescriptor {
                label: Some("nsh shader surface"),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: FORMAT,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            },
        )
    };
    Some(Slot {
        surface,
        view: texture.create_view(&Default::default()),
        texture,
        state: Arc::new(AtomicU8::new(state::IDLE)),
        serial: 0,
    })
}

/// An IOSurface of `width` × `height` premultiplied `'BGRA'` pixels in
/// sRGB, the colour space the shaders write in.
fn surface(width: u32, height: u32) -> Option<CFRetained<IOSurfaceRef>> {
    // SAFETY: constants of IOSurface.
    let (keys, row): ([&CFString; 5], usize) = unsafe {
        (
            [
                kIOSurfaceWidth,
                kIOSurfaceHeight,
                kIOSurfaceBytesPerElement,
                kIOSurfaceBytesPerRow,
                kIOSurfacePixelFormat,
            ],
            IOSurfaceRef::align_property(kIOSurfaceBytesPerRow, width as usize * 4),
        )
    };
    let numbers = [
        CFNumber::new_i64(i64::from(width)),
        CFNumber::new_i64(i64::from(height)),
        CFNumber::new_i32(4),
        CFNumber::new_i64(row as i64),
        CFNumber::new_i32(BGRA),
    ];
    let values: Vec<&CFType> = numbers.iter().map(|n| n.as_ref()).collect();
    let properties = CFDictionary::<CFString, CFType>::from_slices(&keys, &values);
    // SAFETY: the dictionary holds IOSurface's properties, numbers each.
    let surface = unsafe { IOSurfaceRef::new(properties.as_opaque()) }?;
    // The window server matches the colours from sRGB to the display's
    // (`kCGColorSpaceSRGB`'s value is its name).
    let srgb = CFString::from_static_str("kCGColorSpaceSRGB");
    // SAFETY: a colour space name is a valid `IOSurfaceColorSpace`.
    unsafe { surface.set_value(kIOSurfaceColorSpace, srgb.as_ref()) };
    Some(surface)
}
