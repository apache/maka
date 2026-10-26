//! The graphics devices of the main thread and each window's swap chain.
//!
//! One Direct3D 11 device (hardware, else WARP) and the Direct2D device and
//! device context on it serve every surface of the thread ([`with`]); each
//! window has a flip-model swap chain ([`SwapChain`]) the context draws
//! into in turn. The swap chain is sequential: a back buffer keeps the
//! frame it showed two presents ago, so a frame draws only what changed
//! since then and presents its changed rectangles (`Present1`). When the device is lost (a driver update, a GPU reset),
//! [`lost`] drops it and bumps [`generation`]: caches of device resources
//! (bitmaps, brushes, command lists) compare the generation they were made
//! in and make them again.
//!
//! DirectWrite's shared factory is free-threaded and also used by the
//! engine thread ([`dwrite`]).

use std::cell::{Cell, RefCell};

use windows::{
    Win32::{
        Foundation::{HWND, RECT},
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
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                D3D11_SDK_VERSION, D3D11CreateDevice, ID3D11Device,
            },
            DirectWrite::{DWRITE_FACTORY_TYPE_SHARED, DWriteCreateFactory, IDWriteFactory2},
            Dxgi::{
                Common::{
                    DXGI_ALPHA_MODE_IGNORE, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_UNKNOWN,
                    DXGI_SAMPLE_DESC,
                },
                CreateDXGIFactory2, DXGI_CREATE_FACTORY_FLAGS, DXGI_PRESENT,
                DXGI_PRESENT_PARAMETERS, DXGI_SCALING_STRETCH, DXGI_SWAP_CHAIN_DESC1,
                DXGI_SWAP_CHAIN_FLAG, DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
                DXGI_USAGE_RENDER_TARGET_OUTPUT, IDXGIDevice, IDXGIDevice1, IDXGIFactory2,
                IDXGISurface, IDXGISwapChain1,
            },
        },
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
    let flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
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
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
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
    thread_local! {
        static DWRITE: IDWriteFactory2 = {
            // SAFETY: plain factory creation; the shared factory exists for
            // the life of the process.
            unsafe { DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED) }
                .expect("DirectWrite is part of every supported Windows")
        };
    }
    DWRITE.with(Clone::clone)
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
}

impl SwapChain {
    /// A swap chain for `hwnd` of `size` pixels.
    pub(crate) fn new(gfx: &Gfx, hwnd: HWND, size: (u32, u32)) -> Result<SwapChain> {
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
            Scaling: DXGI_SCALING_STRETCH,
            // Back buffers keep their pixels: frames draw only what changed.
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
            AlphaMode: DXGI_ALPHA_MODE_IGNORE,
            Flags: 0,
        };
        // SAFETY: `hwnd` is a live window of this thread; `desc` is valid.
        let swap = unsafe { factory.CreateSwapChainForHwnd(&gfx.d3d, hwnd, &desc, None, None)? };
        // One frame queued at most: input is drawn by the next vblank.
        if let Ok(device) = gfx.d3d.cast::<IDXGIDevice1>() {
            // SAFETY: a COM call on a live device.
            let _ = unsafe { device.SetMaximumFrameLatency(1) };
        }
        Ok(SwapChain {
            swap,
            target: None,
            size: (size.0.max(1), size.1.max(1)),
            generation: generation(),
            last: None,
        })
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
            self.swap.ResizeBuffers(
                0,
                size.0,
                size.1,
                DXGI_FORMAT_UNKNOWN,
                DXGI_SWAP_CHAIN_FLAG(0),
            )?;
        }
        self.size = size;
        self.last = None;
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
            gfx.dc
                .CreateBitmapFromDxgiSurface(&surface, Some(&target_properties(scale, false)))?
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

    /// Shows the frame drawn, waiting for the vertical blank; `changed`:
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
        self.last = if result.is_ok() { changed } else { None };
        result
    }
}
