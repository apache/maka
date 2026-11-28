//! Windows: a shader view's frames on textures Direct2D draws as they are
//! ([`ShaderView::show_on_surfaces`]), the sibling of Apple's IOSurfaces
//! (`shader_surfaces.rs`).
//!
//! Read back, a frame crosses the bus twice: copied out of the GPU into a
//! mapped buffer, then on the main thread into a Direct2D bitmap, which
//! uploads it again. Here the GPU renders into a Direct3D 12 texture shared
//! with the backend's Direct3D 11 device, which Direct2D draws as a bitmap
//! of its own (`CreateBitmapFromDxgiSurface`): no pixel leaves the GPU. The
//! renderer must be on Direct3D 12, on the backend's adapter.
//!
//! A view keeps up to [`SLOTS`] textures of its frame's size, made as they
//! are needed. A frame is rendered into one that is neither shown nor read
//! by a frame of the backend's device still on its way: each time the
//! backend draws the texture shown ([`Surfaces::shown`]) it gets a value to
//! signal on the view's shared fence once that frame is submitted, and a
//! texture is free once the fence passed the value of the last frame that
//! drew it. A frame is ready once the GPU finished the work submitted with
//! it, and shows from the next [`Surfaces::collect`]; the one it replaces
//! goes back to the pool. With all of them busy the frame is skipped, as a
//! read-back one is when both buffers are on their way.
//!
//! The textures allow simultaneous access: the two devices never use one
//! at the same time (the fence and the frames' states keep them apart), so
//! neither waits for the other. wgpu moves a texture between states on its
//! own device (render target, copy source); the window's device does not.
//!
//! [`ShaderView::show_on_surfaces`]: crate::shader::ShaderView::show_on_surfaces

use std::sync::{
    Arc,
    atomic::{AtomicU8, AtomicU64, Ordering},
};

use windows::Win32::{
    Foundation::{CloseHandle, GENERIC_ALL, HANDLE},
    Graphics::{
        Direct3D12::{
            D3D12_FENCE_FLAG_SHARED, D3D12_HEAP_FLAG_SHARED, D3D12_HEAP_PROPERTIES,
            D3D12_HEAP_TYPE_DEFAULT, D3D12_RESOURCE_DESC, D3D12_RESOURCE_DIMENSION_TEXTURE2D,
            D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET, D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS,
            D3D12_RESOURCE_STATE_COMMON, D3D12_TEXTURE_LAYOUT_UNKNOWN, ID3D12Device, ID3D12Fence,
            ID3D12Resource,
        },
        Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC},
    },
};

use crate::shader_frame::SharedTexture;

/// The format of the textures: Direct2D's premultiplied BGRA.
pub(crate) const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Bgra8Unorm;

/// The textures of a view: the one shown, one being rendered, and one the
/// backend's device may still read.
const SLOTS: usize = 3;

/// Where a texture is.
mod state {
    /// Free (once the backend's device is done with it).
    pub(super) const IDLE: u8 = 0;
    /// The GPU renders a frame into it.
    pub(super) const RENDERING: u8 = 1;
    /// Its frame is done, not shown yet.
    pub(super) const DONE: u8 = 2;
    /// Its frame shows.
    pub(super) const SHOWN: u8 = 3;
}

/// A view's fence, shared with the backend's device by a handle: the
/// backend signals it after each frame that drew one of the view's
/// textures.
struct Fence {
    fence: ID3D12Fence,
    handle: HANDLE,
    /// The value the backend signals after the next frame that draws.
    next: AtomicU64,
}

impl Fence {
    fn new(raw: &ID3D12Device) -> Option<Fence> {
        // SAFETY: a fence of the live device, starting at zero.
        let fence: ID3D12Fence = unsafe { raw.CreateFence(0, D3D12_FENCE_FLAG_SHARED) }
            .inspect_err(|e| log::debug!("shaders: no shared fence ({e})"))
            .ok()?;
        // SAFETY: a handle to the live fence, which `Drop` closes.
        let handle = unsafe { raw.CreateSharedHandle(&fence, None, GENERIC_ALL.0, None) }
            .inspect_err(|e| log::debug!("shaders: the fence cannot be shared ({e})"))
            .ok()?;
        Some(Fence {
            fence,
            handle,
            next: AtomicU64::new(1),
        })
    }
}

impl Drop for Fence {
    fn drop(&mut self) {
        // SAFETY: the handle this fence made, closed once.
        let _ = unsafe { CloseHandle(self.handle) };
    }
}

/// The adapter of `device`'s Direct3D 12 device; `None` on another API.
#[cfg(test)]
pub(crate) fn adapter_luid(device: &wgpu::Device) -> Option<windows_sys::Win32::Foundation::LUID> {
    let raw = raw_device(device)?;
    // SAFETY: a plain query on the live device.
    let luid = unsafe { raw.GetAdapterLuid() };
    Some(windows_sys::Win32::Foundation::LUID {
        LowPart: luid.LowPart,
        HighPart: luid.HighPart,
    })
}

fn raw_device(device: &wgpu::Device) -> Option<ID3D12Device> {
    // SAFETY: the raw device is only used to make objects of its own, which
    // wgpu does not track, and textures handed to wgpu.
    let hal = unsafe { device.as_hal::<wgpu::hal::api::Dx12>() }?;
    Some(hal.raw_device().clone())
}

struct Slot {
    handle: HANDLE,
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    state: Arc<AtomicU8>,
    /// The frame's number.
    serial: u64,
    /// The fence value of the last frame of the backend that drew it.
    released: AtomicU64,
}

impl Drop for Slot {
    fn drop(&mut self) {
        // SAFETY: the handle this slot made, closed once.
        let _ = unsafe { CloseHandle(self.handle) };
    }
}

/// The last [`Surfaces::set`] given out.
static SETS: AtomicU64 = AtomicU64::new(0);

/// A view's textures, for one size.
pub(crate) struct Surfaces {
    pub(crate) width: u32,
    pub(crate) height: u32,
    /// Tells these textures and fence from those of another size or view.
    set: u64,
    slots: Vec<Slot>,
    /// The slot whose frame shows.
    shown: Option<usize>,
    /// Made with the first texture.
    fence: Option<Fence>,
}

// SAFETY: the handles are NT handles, valid in the whole process and usable
// from any thread, and Direct3D 12's objects (the fence) are free-threaded;
// a view's textures move to the render thread of its GPU views
// (`crate::gpu`) whole, behind a mutex, and are used by one thread at a
// time.
unsafe impl Send for Surfaces {}

/// No shared texture can be made: the device is not Direct3D 12's, or it
/// refused one (the view reads its frames back then).
#[derive(Debug)]
pub(crate) struct Unavailable;

impl Surfaces {
    /// Textures of `width` × `height` pixels (none made yet).
    pub(crate) fn new(width: u32, height: u32) -> Surfaces {
        Surfaces {
            width,
            height,
            set: SETS.fetch_add(1, Ordering::Relaxed) + 1,
            slots: Vec::with_capacity(SLOTS),
            shown: None,
            fence: None,
        }
    }

    /// A free texture to render into, one the backend's device is done
    /// with, made on `device` while there are fewer than [`SLOTS`];
    /// `Ok(None)` when all are busy.
    pub(crate) fn free(&mut self, device: &wgpu::Device) -> Result<Option<usize>, Unavailable> {
        // SAFETY: a plain query on the live fence.
        let completed = self
            .fence
            .as_ref()
            .map_or(0, |f| unsafe { f.fence.GetCompletedValue() });
        let free = self.slots.iter().position(|s| {
            s.state.load(Ordering::Acquire) == state::IDLE
                && s.released.load(Ordering::Acquire) <= completed
        });
        if free.is_some() || self.slots.len() == SLOTS {
            return Ok(free);
        }
        let raw = raw_device(device).ok_or(Unavailable)?;
        if self.fence.is_none() {
            self.fence = Some(Fence::new(&raw).ok_or(Unavailable)?);
        }
        self.slots
            .push(slot(device, &raw, self.width, self.height).ok_or(Unavailable)?);
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
        let chosen_serial = self.slots[newest].serial;
        for (i, s) in self.slots.iter().enumerate() {
            if i != newest
                && s.serial <= chosen_serial
                && s.state.load(Ordering::Acquire) == state::DONE
            {
                s.state.store(state::IDLE, Ordering::Release);
            }
        }
        if chosen_serial <= shown_serial {
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

    /// The texture of the frame shown, for the backend to draw in its next
    /// frame: it stays out of the pool until the fence passed the value
    /// returned with it, which the backend signals once that frame is
    /// submitted.
    pub(crate) fn shown(&self) -> Option<SharedTexture> {
        let slot = &self.slots[self.shown?];
        let fence = self.fence.as_ref()?;
        let value = fence.next.fetch_add(1, Ordering::AcqRel);
        slot.released.store(value, Ordering::Release);
        Some(SharedTexture {
            set: self.set,
            texture: slot.handle.0,
            fence: fence.handle.0,
            value,
            width: self.width,
            height: self.height,
        })
    }

    /// The number of the frame shown (0: none yet).
    pub(crate) fn shown_serial(&self) -> u64 {
        self.shown.map_or(0, |i| self.slots[i].serial)
    }

    /// The texture of the frame shown.
    pub(crate) fn shown_texture(&self) -> Option<&wgpu::Texture> {
        self.shown.map(|i| &self.slots[i].texture)
    }

    /// Signals the fence from the CPU, as the backend's device does once a
    /// frame is submitted.
    #[cfg(test)]
    pub(crate) fn signal(&self, value: u64) {
        let Some(fence) = &self.fence else {
            return;
        };
        // SAFETY: a plain signal on the live fence.
        let _ = unsafe { fence.fence.Signal(value) };
    }
}

/// Holds `queue` at a fence of its own until dropped: work submitted
/// meanwhile finishes only after that, however fast the GPU is.
#[cfg(test)]
pub(crate) struct Stall(ID3D12Fence);

#[cfg(test)]
impl Stall {
    pub(crate) fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Option<Stall> {
        use windows::Win32::Graphics::Direct3D12::D3D12_FENCE_FLAG_NONE;
        let raw = raw_device(device)?;
        // SAFETY: a fence of the live device, starting at zero.
        let fence: ID3D12Fence = unsafe { raw.CreateFence(0, D3D12_FENCE_FLAG_NONE) }.ok()?;
        // SAFETY: only the raw queue's `Wait` is used, which `Drop` ends.
        let hal = unsafe { queue.as_hal::<wgpu::hal::api::Dx12>() }?;
        // SAFETY: the queue waits on the live fence for value 1.
        unsafe { hal.as_raw().Wait(&fence, 1) }.ok()?;
        Some(Stall(fence))
    }
}

#[cfg(test)]
impl Drop for Stall {
    fn drop(&mut self) {
        // SAFETY: a plain signal on the live fence, which releases the queue.
        let _ = unsafe { self.0.Signal(1) };
    }
}

/// One shared texture of `width` × `height` pixels on `device`, whose
/// Direct3D 12 device is `raw`.
fn slot(device: &wgpu::Device, raw: &ID3D12Device, width: u32, height: u32) -> Option<Slot> {
    let desc = D3D12_RESOURCE_DESC {
        Dimension: D3D12_RESOURCE_DIMENSION_TEXTURE2D,
        Alignment: 0,
        Width: u64::from(width),
        Height: height,
        DepthOrArraySize: 1,
        MipLevels: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Layout: D3D12_TEXTURE_LAYOUT_UNKNOWN,
        Flags: D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET
            | D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS,
    };
    let heap = D3D12_HEAP_PROPERTIES {
        Type: D3D12_HEAP_TYPE_DEFAULT,
        ..Default::default()
    };
    let mut resource: Option<ID3D12Resource> = None;
    // SAFETY: a committed 2D texture of the live device, as described above,
    // in a shared heap, written to a local.
    let made = unsafe {
        raw.CreateCommittedResource(
            &heap,
            D3D12_HEAP_FLAG_SHARED,
            &desc,
            D3D12_RESOURCE_STATE_COMMON,
            None,
            &mut resource,
        )
    };
    let resource = made
        .inspect_err(|e| log::debug!("shaders: no shared {width}x{height} texture ({e})"))
        .ok()
        .and(resource)?;
    // SAFETY: a handle to the live texture, which the slot closes on drop.
    let handle = unsafe { raw.CreateSharedHandle(&resource, None, GENERIC_ALL.0, None) }
        .inspect_err(|e| log::debug!("shaders: the texture cannot be shared ({e})"))
        .ok()?;
    let size = wgpu::Extent3d {
        width,
        height,
        depth_or_array_layers: 1,
    };
    // SAFETY: `resource` is a 2D texture of `device`'s Direct3D 12 device,
    // one level and one sample, in `FORMAT`, of the size given.
    let hal_texture = unsafe {
        wgpu::hal::dx12::Device::texture_from_raw(
            resource,
            FORMAT,
            wgpu::TextureDimension::D2,
            size,
            1,
            1,
        )
    };
    // SAFETY: the descriptor says what `hal_texture` is. wgpu takes it as
    // initialized and never clears it: its only first use is a render pass
    // that clears it (`ShaderView::render`).
    let texture = unsafe {
        device.create_texture_from_hal::<wgpu::hal::api::Dx12>(
            hal_texture,
            &wgpu::TextureDescriptor {
                label: Some("nsh shader surface"),
                size,
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
        handle,
        view: texture.create_view(&Default::default()),
        texture,
        state: Arc::new(AtomicU8::new(state::IDLE)),
        serial: 0,
        released: AtomicU64::new(0),
    })
}
