//! The graphics devices of the main thread and each window's swap chain.
//!
//! One Direct3D 11 device (hardware, else WARP) and the Direct2D device and
//! device context on it serve every surface of the thread ([`with`]); each
//! window has a flip-model swap chain ([`SwapChain`]) the context draws
//! into in turn. The swap chain is sequential: a back buffer keeps the
//! frame it showed two presents ago, so a frame draws only what changed
//! since then and presents its changed rectangles (`Present1`). A window
//! draws only when its swap chain has room for a frame
//! ([`SwapChain::ready`]): one frame in flight, so no present waits for
//! the vertical blank and several windows share a thread (docs/dev/windows.md
//! "Frame pacing"). When the device is lost (a driver update, a GPU reset),
//! [`lost`] drops it and bumps [`generation`]: caches of device resources
//! (bitmaps, brushes, command lists) compare the generation they were made
//! in and make them again.
//!
//! DirectWrite's shared factory is free-threaded and also used by the
//! engine thread ([`dwrite`]).

use std::{
    cell::{Cell, RefCell},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use windows::{
    Win32::{
        Foundation::{CloseHandle, HANDLE, HWND, LPARAM, RECT, WAIT_OBJECT_0, WPARAM},
        Graphics::{
            Direct2D::{
                Common::{
                    D2D1_ALPHA_MODE_IGNORE, D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_PIXEL_FORMAT,
                },
                D2D1_BITMAP_OPTIONS_CANNOT_DRAW, D2D1_BITMAP_OPTIONS_TARGET,
                D2D1_BITMAP_PROPERTIES1, D2D1_DEBUG_LEVEL_NONE, D2D1_DEVICE_CONTEXT_OPTIONS_NONE,
                D2D1_FACTORY_OPTIONS, D2D1_FACTORY_TYPE_SINGLE_THREADED, D2D1CreateFactory,
                ID2D1Bitmap1, ID2D1Device, ID2D1DeviceContext, ID2D1Factory1,
            },
            Direct3D::{D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP},
            Direct3D11::{
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                D3D11_CREATE_DEVICE_PREVENT_INTERNAL_THREADING_OPTIMIZATIONS,
                D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION, D3D11CreateDevice,
                ID3D11Device,
            },
            DirectWrite::{DWRITE_FACTORY_TYPE_SHARED, DWriteCreateFactory, IDWriteFactory2},
            Dxgi::{
                Common::{
                    DXGI_ALPHA_MODE_IGNORE, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_UNKNOWN,
                    DXGI_SAMPLE_DESC,
                },
                CreateDXGIFactory2, DXGI_CREATE_FACTORY_FLAGS, DXGI_PRESENT,
                DXGI_PRESENT_PARAMETERS, DXGI_RGBA, DXGI_SCALING_NONE, DXGI_SWAP_CHAIN_DESC1,
                DXGI_SWAP_CHAIN_FLAG, DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT,
                DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL, DXGI_USAGE_RENDER_TARGET_OUTPUT, IDXGIDevice,
                IDXGIDevice1, IDXGIFactory2, IDXGISurface, IDXGISwapChain1, IDXGISwapChain2,
            },
        },
        System::Threading::{
            RegisterWaitForSingleObject, UnregisterWait, UnregisterWaitEx, WT_EXECUTEINWAITTHREAD,
            WT_EXECUTEONLYONCE, WaitForSingleObject,
        },
        UI::WindowsAndMessaging::PostMessageW,
    },
    core::{Interface, Result},
};

/// The devices of the main thread.
pub(crate) struct Gfx {
    /// The Direct3D device (swap chains, video frames).
    pub(crate) d3d: ID3D11Device,
    /// The Direct2D factory (geometries, stroke styles).
    pub(crate) factory: ID2D1Factory1,
    /// The Direct2D device.
    pub(crate) device: ID2D1Device,
    /// The one device context every surface draws with.
    pub(crate) dc: ID2D1DeviceContext,
}

thread_local! {
    static GFX: RefCell<Option<std::rc::Rc<Gfx>>> = const { RefCell::new(None) };
    static GENERATION: Cell<u64> = const { Cell::new(1) };
}

/// The thread's devices, made on first use.
pub(crate) fn get() -> Result<std::rc::Rc<Gfx>> {
    if let Some(g) = GFX.with(|g| g.borrow().clone()) {
        return Ok(g);
    }
    let g = std::rc::Rc::new(Gfx::new()?);
    GFX.with(|cell| *cell.borrow_mut() = Some(g.clone()));
    Ok(g)
}

/// The device was lost: drops it (the next [`get`] makes a new one) and
/// invalidates device resources made so far.
pub(crate) fn lost() {
    log::warn!("the graphics device was lost; recreating it");
    GFX.with(|g| g.borrow_mut().take());
    GENERATION.with(|g| g.set(g.get() + 1));
}

/// Bumped whenever the device is replaced: device resources made in an
/// older generation must be made again.
pub(crate) fn generation() -> u64 {
    GENERATION.with(Cell::get)
}

/// Drops this UI thread's cached Direct2D / Direct3D resources once its last
/// surface closes, so main-thread callers never release COM devices inside
/// `ExitProcess` TLS destructors or after `OleUninitialize`.
pub(crate) fn release_thread_resources() {
    crate::canvas::clear_thread_cache();
    crate::decor::clear_thread_cache();
    crate::text::clear_thread_cache();
    crate::image::clear_thread_cache();
    let _ = GFX.try_with(|g| g.borrow_mut().take());
    let _ = GENERATION.try_with(|g| g.set(g.get() + 1));
}

impl Gfx {
    fn new() -> Result<Gfx> {
        let d3d = create_d3d(D3D_DRIVER_TYPE_HARDWARE).or_else(|err| {
            log::warn!("no hardware Direct3D device ({err}); drawing with WARP");
            create_d3d(D3D_DRIVER_TYPE_WARP)
        })?;
        let options = D2D1_FACTORY_OPTIONS {
            debugLevel: D2D1_DEBUG_LEVEL_NONE,
        };
        // SAFETY: plain factory creation with valid options.
        let factory: ID2D1Factory1 =
            unsafe { D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, Some(&options))? };
        let dxgi: IDXGIDevice = d3d.cast()?;
        // The device queues three frames in all by default, whatever the
        // swap chains allow each: with several windows a present would wait
        // for the vertical blank of another window's frames. Every swap
        // chain is gated on its own latency waitable object (one frame in
        // flight, `SwapChain::ready`), so the frames queued at once are about
        // the number of windows: this is only a ceiling for that.
        if let Ok(dxgi1) = d3d.cast::<IDXGIDevice1>() {
            // SAFETY: a COM call on a live device.
            let _ = unsafe { dxgi1.SetMaximumFrameLatency(MAX_DEVICE_LATENCY) };
        }
        // SAFETY: COM calls on live objects.
        let device = unsafe { factory.CreateDevice(&dxgi)? };
        // SAFETY: as above.
        let dc = unsafe { device.CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE)? };
        Ok(Gfx {
            d3d,
            factory,
            device,
            dc,
        })
    }
}

fn create_d3d(driver: D3D_DRIVER_TYPE) -> Result<ID3D11Device> {
    let mut device = None;
    // NSH draws with a device from the thread that made it (video decoding,
    // which also uses it, takes Direct3D's multithread lock). The worker
    // threads drivers otherwise start for each device (about 28 on NVIDIA,
    // 15 on AMD) take that submission off the drawing thread, but here they
    // only contend with the UI threads, costing CPU and, with a device per
    // thread, frames (docs/dev/windows.md "Devices"). The flag changes no
    // thread safety: calls stay valid from any thread, the driver just does
    // its work on the calling one.
    let base = D3D11_CREATE_DEVICE_BGRA_SUPPORT
        | D3D11_CREATE_DEVICE_PREVENT_INTERNAL_THREADING_OPTIMIZATIONS;
    let flags = base | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
    // SAFETY: out pointer to a local; default feature levels.
    let video = unsafe {
        D3D11CreateDevice(
            None,
            driver,
            Default::default(),
            flags,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )
    };
    if video.is_err() {
        // Some drivers (and WARP on old systems) lack video support.
        // SAFETY: as above.
        unsafe {
            D3D11CreateDevice(
                None,
                driver,
                Default::default(),
                base,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )?
        };
    }
    device.ok_or_else(|| windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL))
}

/// DirectWrite's shared factory (free-threaded: any thread may use it).
pub(crate) fn dwrite() -> IDWriteFactory2 {
    static DWRITE: std::sync::OnceLock<crate::text::Shared<IDWriteFactory2>> =
        std::sync::OnceLock::new();
    DWRITE
        .get_or_init(|| {
            // SAFETY: plain factory creation; the shared factory exists for
            // the life of the process.
            crate::text::Shared(
                unsafe { DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED) }
                    .expect("DirectWrite is part of every supported Windows"),
            )
        })
        .0
        .clone()
}

/// Bitmap properties of a target of the device context at `scale`.
pub(crate) fn target_properties(scale: f32, premultiplied: bool) -> D2D1_BITMAP_PROPERTIES1 {
    D2D1_BITMAP_PROPERTIES1 {
        pixelFormat: D2D1_PIXEL_FORMAT {
            format: DXGI_FORMAT_B8G8R8A8_UNORM,
            alphaMode: if premultiplied {
                D2D1_ALPHA_MODE_PREMULTIPLIED
            } else {
                D2D1_ALPHA_MODE_IGNORE
            },
        },
        dpiX: 96.0 * scale,
        dpiY: 96.0 * scale,
        bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
        colorContext: std::mem::ManuallyDrop::new(None),
    }
}

/// The most frames the device queues (the maximum DXGI takes).
const MAX_DEVICE_LATENCY: u32 = 16;

/// The flags every swap chain is made (and resized) with: frames are paced
/// on its latency waitable object ([`SwapChain::ready`]).
pub(crate) const SWAP_CHAIN_FLAGS: DXGI_SWAP_CHAIN_FLAG =
    DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT;

/// A window's swap chain and the bitmap of its back buffer.
pub(crate) struct SwapChain {
    swap: IDXGISwapChain1,
    target: Option<ID2D1Bitmap1>,
    /// Size in pixels.
    pub(crate) size: (u32, u32),
    /// The generation of the device it was made on.
    generation: u64,
    /// What the last frame presented changed (pixels); `None`: all of it
    /// (or the buffers' content is unknown: new, resized).
    last: Option<Vec<RECT>>,
    /// A frame was presented since the buffers were made or resized.
    shown: bool,
    /// What fills the window past the buffers (`0xRRGGBBAA`) while it grows.
    background: Option<u32>,
    /// A transparent window's: composed, premultiplied alpha.
    premultiplied: bool,
    /// Frame pacing: one frame in flight per swap chain.
    latency: Latency,
}

/// What a callback of the thread pool shares with the window's thread.
struct Wake {
    /// A frame latency token is held: the next present has room in the
    /// queue and does not wait for the vertical blank.
    holding: AtomicBool,
    /// A wait is registered and has not fired.
    armed: AtomicBool,
    /// The window to post `WM_NSH_PAINT` to.
    hwnd: isize,
}

/// The frame latency waitable object of one swap chain. A window whose
/// queue is full does not draw (and does not block its thread in
/// `Present`): it is asked to paint again when the compositor frees a
/// frame, so every window of a thread gets its own vblank.
struct Latency {
    handle: HANDLE,
    wake: Arc<Wake>,
    /// The registered wait, if any (`armed`).
    wait: Cell<HANDLE>,
}

/// The thread pool's callback once a swap chain has room for a frame.
unsafe extern "system" fn latency_signaled(context: *mut std::ffi::c_void, _timeout: bool) {
    // SAFETY: `context` is an `Arc<Wake>` leaked by `Latency::defer`, taken
    // back here exactly once (the wait fires once).
    let wake = unsafe { Arc::from_raw(context as *const Wake) };
    wake.holding.store(true, Ordering::Release);
    wake.armed.store(false, Ordering::Release);
    // SAFETY: posting to a window of another thread is allowed; a destroyed
    // window just fails. A posted message comes before `WM_PAINT`, which waits
    // for every other message of the thread (and, with several windows
    // drawing, for their paints in turn).
    let _ = unsafe {
        PostMessageW(
            Some(HWND(wake.hwnd as *mut _)),
            crate::window::WM_NSH_PAINT,
            WPARAM(0),
            LPARAM(0),
        )
    };
}

impl Latency {
    /// The latency waitable object of `swap`, one frame in flight, waking
    /// `hwnd`.
    fn new(swap: &IDXGISwapChain1, hwnd: HWND) -> Result<Latency> {
        let swap: IDXGISwapChain2 = swap.cast()?;
        // SAFETY: COM calls on a live swap chain made with the waitable flag.
        let handle = unsafe {
            swap.SetMaximumFrameLatency(1)?;
            swap.GetFrameLatencyWaitableObject()
        };
        Ok(Latency {
            handle,
            wake: Arc::new(Wake {
                holding: AtomicBool::new(false),
                armed: AtomicBool::new(false),
                hwnd: hwnd.0 as isize,
            }),
            wait: Cell::new(HANDLE::default()),
        })
    }

    /// Whether a frame may be drawn and presented now (takes a token).
    fn ready(&self) -> bool {
        if self.wake.holding.load(Ordering::Acquire) {
            return true;
        }
        // SAFETY: a poll of a live semaphore.
        if unsafe { WaitForSingleObject(self.handle, 0) } == WAIT_OBJECT_0 {
            self.wake.holding.store(true, Ordering::Release);
            return true;
        }
        false
    }

    /// Asks for `WM_NSH_PAINT` when a token is free (once).
    fn defer(&self) {
        if self.wake.armed.swap(true, Ordering::AcqRel) {
            return;
        }
        let prev = self.wait.replace(HANDLE::default());
        if !prev.is_invalid() {
            // SAFETY: a wait that fired; non-blocking release.
            let _ = unsafe { UnregisterWait(prev) };
        }
        let context = Arc::into_raw(self.wake.clone());
        let mut wait = HANDLE::default();
        // SAFETY: the callback only touches the `Arc<Wake>` leaked here; the
        // handle lives until `Drop`, which unregisters first.
        let registered = unsafe {
            RegisterWaitForSingleObject(
                &mut wait,
                self.handle,
                Some(latency_signaled),
                Some(context as *const _),
                u32::MAX,
                WT_EXECUTEONLYONCE | WT_EXECUTEINWAITTHREAD,
            )
        };
        if registered.is_ok() {
            self.wait.set(wait);
        } else {
            // SAFETY: not registered: the leaked clone is ours again.
            drop(unsafe { Arc::from_raw(context) });
            self.wake.armed.store(false, Ordering::Release);
            // Fall back to drawing: the queue is then bounded by the device.
            self.wake.holding.store(true, Ordering::Release);
        }
    }
}

impl Drop for Latency {
    fn drop(&mut self) {
        let wait = self.wait.get();
        if !wait.is_invalid() {
            // SAFETY: waits for a running callback to end.
            let _ = unsafe { UnregisterWaitEx(wait, Some(HANDLE(-1isize as *mut _))) };
            if self.wake.armed.swap(false, Ordering::AcqRel) {
                // The callback never ran: take its leaked clone back.
                // SAFETY: `defer` leaked exactly one clone, still unclaimed.
                drop(unsafe { Arc::from_raw(Arc::as_ptr(&self.wake)) });
            }
        }
        // SAFETY: the handle was obtained from the swap chain and is ours.
        let _ = unsafe { CloseHandle(self.handle) };
    }
}

impl SwapChain {
    /// A swap chain for `hwnd` of `size` pixels; for a transparent window,
    /// a premultiplied one shown by its `composition` instead.
    pub(crate) fn new(
        gfx: &Gfx,
        hwnd: HWND,
        size: (u32, u32),
        composition: Option<&crate::compose::Composition>,
    ) -> Result<SwapChain> {
        if let Some(composition) = composition {
            let size = (size.0.max(1), size.1.max(1));
            let swap = crate::compose::composition_swap_chain(gfx, size, SWAP_CHAIN_FLAGS)?;
            composition.set_base(&swap)?;
            return SwapChain::made(swap, hwnd, size, true);
        }
        // SAFETY: plain factory creation.
        let factory: IDXGIFactory2 = unsafe { CreateDXGIFactory2(DXGI_CREATE_FACTORY_FLAGS(0))? };
        let desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: size.0.max(1),
            Height: size.1.max(1),
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            Stereo: false.into(),
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 2,
            // While a resize is drawn DWM already shows the window at its new
            // size: the last frame stays as it was, where stretching it would
            // move everything in the window by part of a pixel, every frame.
            Scaling: DXGI_SCALING_NONE,
            // Back buffers keep their pixels: frames draw only what changed.
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
            AlphaMode: DXGI_ALPHA_MODE_IGNORE,
            Flags: SWAP_CHAIN_FLAGS.0 as u32,
        };
        // SAFETY: `hwnd` is a live window of this thread; `desc` is valid.
        let swap = unsafe { factory.CreateSwapChainForHwnd(&gfx.d3d, hwnd, &desc, None, None)? };
        SwapChain::made(swap, hwnd, size, false)
    }

    fn made(
        swap: IDXGISwapChain1,
        hwnd: HWND,
        size: (u32, u32),
        premultiplied: bool,
    ) -> Result<SwapChain> {
        // One frame in flight, as a window always had, so input is drawn by
        // the next vblank. Set on this swap chain, not the device, and waited
        // for without blocking ([`SwapChain::ready`]): with the waitable
        // flag `Present` no longer waits for the queue to drain, so a chain
        // not gated would queue frames up to the device's limit.
        let latency = Latency::new(&swap, hwnd)?;
        Ok(SwapChain {
            swap,
            target: None,
            size: (size.0.max(1), size.1.max(1)),
            generation: generation(),
            last: None,
            shown: false,
            background: None,
            premultiplied,
            latency,
        })
    }

    /// A transparent window's (composed, premultiplied alpha).
    #[cfg(test)]
    pub(crate) fn premultiplied(&self) -> bool {
        self.premultiplied
    }

    /// Fills the window past the buffers with `color` from the next present
    /// on, while a resize's frame is being drawn. A composed swap chain
    /// stretches instead (DirectComposition takes no other scaling).
    pub(crate) fn set_background(&mut self, color: nsh_core::Color) {
        if self.premultiplied || self.background.replace(color.0) == Some(color.0) {
            return;
        }
        let channel = |shift: u32| ((color.0 >> shift) & 0xff) as f32 / 255.0;
        let rgba = DXGI_RGBA {
            r: channel(24),
            g: channel(16),
            b: channel(8),
            a: 1.0,
        };
        // SAFETY: a COM call on a live swap chain; the color outlives it.
        if let Err(err) = unsafe { self.swap.SetBackgroundColor(&rgba) } {
            log::warn!("cannot set the swap chain's background: {err}");
        }
    }

    /// The window shows a frame of these buffers, which stays until the next.
    pub(crate) fn shows_a_frame(&self) -> bool {
        self.shown
    }

    /// True when it was made on a device that is gone.
    pub(crate) fn stale(&self) -> bool {
        self.generation != generation()
    }

    /// Resizes the buffers to `size` pixels.
    pub(crate) fn resize(&mut self, gfx: &Gfx, size: (u32, u32)) -> Result<()> {
        let size = (size.0.max(1), size.1.max(1));
        if size == self.size {
            return Ok(());
        }
        self.target = None;
        // SAFETY: the back buffer is not referenced anymore (the target
        // bitmap is dropped and unset).
        unsafe {
            gfx.dc.SetTarget(None);
            self.swap
                .ResizeBuffers(0, size.0, size.1, DXGI_FORMAT_UNKNOWN, SWAP_CHAIN_FLAGS)?;
        }
        self.size = size;
        self.last = None;
        self.shown = false;
        Ok(())
    }

    /// The bitmap of the back buffer, for the device context to draw into.
    pub(crate) fn target(&mut self, gfx: &Gfx, scale: f32) -> Result<ID2D1Bitmap1> {
        if let Some(t) = &self.target {
            return Ok(t.clone());
        }
        // SAFETY: COM calls on live objects; buffer 0 exists.
        let bitmap = unsafe {
            let surface: IDXGISurface = self.swap.GetBuffer(0)?;
            gfx.dc.CreateBitmapFromDxgiSurface(
                &surface,
                Some(&target_properties(scale, self.premultiplied)),
            )?
        };
        self.target = Some(bitmap.clone());
        Ok(bitmap)
    }

    /// Drops the target (a new scale: the bitmap carries its DPI).
    pub(crate) fn drop_target(&mut self) {
        self.target = None;
    }

    /// What a frame that changes `changed` (pixels; `None`: everything)
    /// draws: the back buffer holds the frame of two presents ago, so the
    /// last frame's changes too. `None`: the whole buffer.
    pub(crate) fn to_draw(&self, changed: Option<&[RECT]>) -> Option<Vec<RECT>> {
        let (changed, last) = (changed?, self.last.as_deref()?);
        Some(changed.iter().chain(last).copied().collect())
    }

    /// Whether a frame can be presented without waiting for the vertical
    /// blank. When not, `WM_NSH_PAINT` comes as soon as it can.
    pub(crate) fn ready(&self) -> bool {
        if self.latency.ready() {
            true
        } else {
            self.latency.defer();
            false
        }
    }

    /// Queues the frame drawn for the next vertical blank; `changed`:
    /// the rectangles that differ from the last frame (`None`: all).
    pub(crate) fn present(&mut self, changed: Option<Vec<RECT>>) -> Result<()> {
        let result = match &changed {
            Some(rects) if !rects.is_empty() => {
                let mut rects = rects.clone();
                let params = DXGI_PRESENT_PARAMETERS {
                    DirtyRectsCount: rects.len() as u32,
                    pDirtyRects: rects.as_mut_ptr(),
                    pScrollRect: std::ptr::null_mut(),
                    pScrollOffset: std::ptr::null_mut(),
                };
                // SAFETY: a COM call on a live swap chain; the rectangles
                // outlive it and lie in the buffer.
                unsafe { self.swap.Present1(1, DXGI_PRESENT(0), &params).ok() }
            }
            // SAFETY: a COM call on a live swap chain.
            _ => unsafe { self.swap.Present(1, DXGI_PRESENT(0)).ok() },
        };
        // The token went with the frame.
        self.latency.wake.holding.store(false, Ordering::Release);
        self.shown = result.is_ok();
        self.last = if result.is_ok() { changed } else { None };
        result
    }
}
