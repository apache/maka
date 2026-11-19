//! `Command::RenderCanvas` (`OffscreenCanvas`'s `convertToBlob`): a drawing
//! replayed as a canvas view's is ([`record`] into a command list), drawn
//! into a Direct2D bitmap of its own and encoded as PNG with WIC.
//!
//! The images the drawing names load first through the shared loader
//! ([`crate::image::load_bitmap`]). The replay and the drawing run on the
//! UI thread: recording uses the thread's devices ([`gfx::get`], a
//! single-threaded factory), its pool of recording contexts and the
//! images' bitmaps, which are all kept per UI thread, so the image is the
//! very replay a canvas view plays on screen.
//!
//! The UI thread never waits for the GPU: after the drawing and its copy
//! into a CPU-readable bitmap are submitted (the copy once `EndDraw` has
//! submitted the drawing), a Direct3D event query marks
//! their end ([`Pending`]), and a thread timer polls it without flushing
//! ([`Pending::when_done`]); only once the GPU has passed it is the bitmap
//! mapped, which then returns at once, and its rows copied out (one copy
//! when they are packed). Turning the pixels into straight alpha and
//! encoding them, the part that grows with the image, runs on a thread of
//! its own, and the image goes back to the engine on the UI thread as one
//! root [`EventKind::CanvasImage`]. An image larger than the device's
//! bitmaps, or one its memory cannot hold, is
//! [`RenderFailure::TooLarge`] (`ERR_NSH_QUOTA_EXCEEDED`).

use std::{
    cell::RefCell,
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

use nsh_core::{
    Color, EventKind, EventPayload, ROOT_ID,
    canvas::{
        Drawing,
        render::{ImageFormat, RenderFailure},
    },
};
use rustc_hash::FxHashMap;
use windows::{
    Win32::{
        Foundation::{
            D2DERR_MAX_TEXTURE_SIZE_EXCEEDED, D2DERR_RECREATE_TARGET, E_FAIL, E_OUTOFMEMORY,
        },
        Graphics::{
            Direct2D::{
                Common::{
                    D2D_SIZE_U, D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_COMPOSITE_MODE_SOURCE_OVER,
                    D2D1_PIXEL_FORMAT,
                },
                D2D1_BITMAP_OPTIONS, D2D1_BITMAP_OPTIONS_CANNOT_DRAW, D2D1_BITMAP_OPTIONS_CPU_READ,
                D2D1_BITMAP_OPTIONS_TARGET, D2D1_BITMAP_PROPERTIES1,
                D2D1_DEVICE_CONTEXT_OPTIONS_NONE, D2D1_INTERPOLATION_MODE_LINEAR,
                D2D1_MAP_OPTIONS_READ, D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE, ID2D1Bitmap1,
            },
            Direct3D11::{
                D3D11_ASYNC_GETDATA_DONOTFLUSH, D3D11_QUERY_DESC, D3D11_QUERY_EVENT,
                ID3D11DeviceContext, ID3D11Query,
            },
            Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
            Imaging::{
                CLSID_WICImagingFactory, GUID_ContainerFormatPng, GUID_WICPixelFormat32bppBGRA,
                IWICImagingFactory, WICBitmapEncoderNoCache,
            },
        },
        System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
            CoUninitialize, STREAM_SEEK_END, STREAM_SEEK_SET, StructuredStorage::IPropertyBag2,
        },
        UI::Shell::SHCreateMemStream,
    },
    core::{BOOL, Error, HRESULT},
};

use super::{TextCache, record};
use crate::{gfx, image::CanvasBitmap, render::color_f, surface::Surface};

type Images = FxHashMap<Arc<str>, Option<CanvasBitmap>>;

/// Renders `drawing` into a `width` × `height` pixel image at `scale`
/// pixels per point and answers request `id`.
pub(crate) fn render(
    surface: &Rc<Surface>,
    id: u32,
    drawing: Arc<Drawing>,
    (width, height): (u32, u32),
    scale: f32,
    format: ImageFormat,
) {
    let key = surface.key();
    let ui = surface.ui_thread();
    let mut uris: Vec<Arc<str>> = drawing.images().map(|i| i.uri.clone()).collect();
    uris.sort_unstable();
    uris.dedup();
    let job = move |images: Images| {
        let job = Job {
            drawing,
            images,
            width,
            height,
            scale,
        };
        let answer = move |result: Result<Vec<u8>, RenderFailure>| {
            ui.invoke(move || {
                if let Some(surface) = Surface::by_key(key) {
                    surface.event(
                        ROOT_ID,
                        EventKind::CanvasImage,
                        EventPayload::CanvasImage { id, result },
                    );
                }
            });
        };
        match job.paint() {
            Ok(pending) => pending.when_done(move |read| match read {
                Ok(pixels) => encode_off_thread(pixels, (width, height), format, answer),
                Err(e) => answer(Err(e)),
            }),
            Err(e) => answer(Err(e)),
        }
    };
    if uris.is_empty() {
        job(Images::default());
        return;
    }
    let waiting = Rc::new(RefCell::new((uris.len(), Images::default(), Some(job))));
    for uri in uris {
        let waiting = waiting.clone();
        let key = uri.clone();
        // A cached image is handed over before `load_bitmap` returns: the
        // loop holds no borrow of `waiting`.
        crate::image::load_bitmap(surface, &uri, scale, move |result| {
            let mut w = waiting.borrow_mut();
            let image = result
                .inspect_err(|e| log::warn!("offscreen canvas: {e}"))
                .ok();
            w.1.insert(key, image);
            w.0 -= 1;
            if w.0 == 0
                && let Some(job) = w.2.take()
            {
                let images = std::mem::take(&mut w.1);
                drop(w);
                job(images);
            }
        });
    }
}

/// Encodes premultiplied BGRA `pixels` as `format` on a thread of its own
/// and hands the result to `answer` there.
fn encode_off_thread(
    pixels: Vec<u8>,
    (width, height): (u32, u32),
    format: ImageFormat,
    answer: impl FnOnce(Result<Vec<u8>, RenderFailure>) + Send + 'static,
) {
    let work = move || encode(pixels, (width, height), format).map_err(RenderFailure::from);
    // The closure moves into the thread only when it starts: keep a way
    // to run it here if no thread can be made.
    let slot = Arc::new(std::sync::Mutex::new(Some((work, answer))));
    let theirs = slot.clone();
    let spawned = std::thread::Builder::new()
        .name("nsh-canvas-encode".into())
        .spawn(move || {
            let taken = theirs.lock().unwrap_or_else(|e| e.into_inner()).take();
            if let Some((work, answer)) = taken {
                answer(work());
            }
        });
    if let Err(e) = spawned {
        log::debug!("offscreen canvas: encoding on the UI thread: {e}");
        let taken = slot.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some((work, answer)) = taken {
            answer(work());
        }
    }
}

/// `pixels` (premultiplied BGRA, rows packed) encoded as `format`.
fn encode(
    mut pixels: Vec<u8>,
    (width, height): (u32, u32),
    format: ImageFormat,
) -> Result<Vec<u8>, String> {
    match format {
        ImageFormat::Png => {
            unpremultiply(&mut pixels);
            // SAFETY: initializes COM on this thread for WIC; balanced by
            // `CoUninitialize` below when it succeeded (S_OK or S_FALSE).
            let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
            let png = encode_png(&pixels, width, height)
                .map_err(|e| format!("the image could not be encoded: {}", e.message()));
            if com {
                // SAFETY: every COM object `encode_png` made is released.
                unsafe { CoUninitialize() };
            }
            png
        }
        _ => Err(format!("{} images are not encoded here", format.mime())),
    }
}

/// Premultiplied BGRA to straight BGRA (what PNG holds), in place.
fn unpremultiply(pixels: &mut [u8]) {
    for p in pixels.as_chunks_mut::<4>().0 {
        let a = u32::from(p[3]);
        if a == 0 || a == 255 {
            continue;
        }
        for c in &mut p[..3] {
            *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
        }
    }
}

/// Straight BGRA `pixels` encoded as PNG with WIC (COM initialized on the
/// calling thread).
fn encode_png(pixels: &[u8], width: u32, height: u32) -> windows::core::Result<Vec<u8>> {
    // SAFETY: COM calls on objects made here; `pixels` holds `height`
    // rows of `width * 4` bytes, and `out` is `size` bytes long.
    unsafe {
        let wic: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
        let stream = SHCreateMemStream(None).ok_or_else(|| Error::from_hresult(E_OUTOFMEMORY))?;
        let encoder = wic.CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null())?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
        let mut frame = None;
        encoder.CreateNewFrame(&mut frame, std::ptr::null_mut())?;
        let frame = frame.ok_or_else(|| Error::from_hresult(E_FAIL))?;
        frame.Initialize(None::<&IPropertyBag2>)?;
        frame.SetSize(width, height)?;
        let mut pixel_format = GUID_WICPixelFormat32bppBGRA;
        frame.SetPixelFormat(&mut pixel_format)?;
        // PNG's encoder takes 32bpp BGRA as is.
        if pixel_format != GUID_WICPixelFormat32bppBGRA {
            return Err(Error::from_hresult(E_FAIL));
        }
        frame.WritePixels(height, width * 4, pixels)?;
        frame.Commit()?;
        encoder.Commit()?;
        let mut size = 0u64;
        stream.Seek(0, STREAM_SEEK_END, Some(&raw mut size))?;
        stream.Seek(0, STREAM_SEEK_SET, None)?;
        let len = u32::try_from(size).map_err(|_| Error::from_hresult(E_OUTOFMEMORY))?;
        let mut out = vec![0u8; len as usize];
        let mut read = 0u32;
        stream
            .Read(out.as_mut_ptr().cast(), len, Some(&raw mut read))
            .ok()?;
        out.truncate(read as usize);
        Ok(out)
    }
}

/// What the UI thread replays.
struct Job {
    drawing: Arc<Drawing>,
    images: Images,
    width: u32,
    height: u32,
    scale: f32,
}

/// How often [`Pending::when_done`] asks whether the GPU is done (a thread
/// timer: Windows rounds it up to its timer resolution, ~10–16 ms).
const POLL: Duration = Duration::from_millis(1);

/// How long [`Pending::when_done`] polls before it maps the bitmap anyway,
/// letting `Map` wait (a query that never ends: a hung or removed device).
const POLL_LIMIT: Duration = Duration::from_secs(5);

/// `Err(TooLarge)` when a `width` × `height` image does not fit in bitmaps
/// of at most `max` pixels a side (`GetMaximumBitmapSize`).
fn check_size((width, height): (u32, u32), max: u32) -> Result<(), RenderFailure> {
    if width > max || height > max {
        return Err(RenderFailure::TooLarge(format!(
            "a {width}×{height} pixel image is larger than this device's bitmaps ({max} pixels a \
             side)"
        )));
    }
    Ok(())
}

/// Whether `code`, a failure to make or map a bitmap, means the image is
/// too large for the device rather than that drawing failed.
fn means_too_large(code: HRESULT) -> bool {
    code == E_OUTOFMEMORY || code == D2DERR_MAX_TEXTURE_SIZE_EXCEEDED
}

/// `e`, a failure to make or map the image's bitmaps, as what JS gets.
fn bitmap_failure((width, height): (u32, u32), e: &Error) -> RenderFailure {
    if means_too_large(e.code()) {
        RenderFailure::TooLarge(format!(
            "a {width}×{height} pixel image does not fit in the graphics device's memory: {}",
            e.message()
        ))
    } else {
        drawing_failure(e)
    }
}

/// `e`, a failure to draw or read the image, as what JS gets.
fn drawing_failure(e: &Error) -> RenderFailure {
    RenderFailure::Failed(format!("the canvas could not be drawn: {}", e.message()))
}

impl Job {
    /// The drawing replayed into a transparent bitmap, y down, `scale`
    /// pixels per point, its animated values at 0, and copied into a
    /// CPU-readable one: the GPU work is submitted, not waited for.
    fn paint(&self) -> Result<Pending, RenderFailure> {
        let fail = |e: Error| drawing_failure(&e);
        let gfx = gfx::get().map_err(fail)?;
        let generation = gfx::generation();
        let (w, h) = (self.width, self.height);
        let too_large = |e: Error| bitmap_failure((w, h), &e);
        let dpi = 96.0 * self.scale;
        let props = |options: D2D1_BITMAP_OPTIONS| D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
            },
            dpiX: dpi,
            dpiY: dpi,
            bitmapOptions: options,
            colorContext: std::mem::ManuallyDrop::new(None),
        };
        let size = D2D_SIZE_U {
            width: w,
            height: h,
        };
        // SAFETY: COM calls on live objects of this thread's device; the
        // context is our own, so no frame is being drawn with it.
        unsafe {
            // A context of its own: the shared one may hold a target.
            let dc = gfx
                .device
                .CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE)
                .map_err(fail)?;
            check_size((w, h), dc.GetMaximumBitmapSize())?;
            let target = dc
                .CreateBitmap(size, None, 0, &props(D2D1_BITMAP_OPTIONS_TARGET))
                .map_err(too_large)?;
            let read = dc
                .CreateBitmap(
                    size,
                    None,
                    0,
                    &props(D2D1_BITMAP_OPTIONS_CPU_READ | D2D1_BITMAP_OPTIONS_CANNOT_DRAW),
                )
                .map_err(too_large)?;
            // Recorded once both bitmaps exist: an image too large to
            // hold costs no replay.
            let mut text = TextCache::default();
            let list =
                record(&gfx, &self.drawing.ops, 0, &[], &self.images, &mut text).map_err(fail)?;
            dc.SetTarget(&target);
            // The drawing is in points: one point is `scale` pixels.
            dc.SetDpi(dpi, dpi);
            dc.SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
            dc.BeginDraw();
            dc.Clear(Some(&color_f(Color::TRANSPARENT)));
            dc.DrawImage(
                &list,
                None,
                None,
                D2D1_INTERPOLATION_MODE_LINEAR,
                D2D1_COMPOSITE_MODE_SOURCE_OVER,
            );
            let drawn = dc.EndDraw(None, None);
            dc.SetTarget(None);
            if let Err(e) = drawn {
                if e.code() == D2DERR_RECREATE_TARGET {
                    gfx::lost();
                }
                return Err(fail(e));
            }
            // Only now: Direct2D batches the drawing until `EndDraw`, but
            // issues a bitmap copy at once, and a copy inside the draw went
            // to Direct3D ahead of the drawing (it read the bitmap empty).
            // `EndDraw` has submitted the drawing to Direct3D's immediate
            // context, so the copy follows it there, and the event query
            // ended after the copy passes once both are done.
            read.CopyFromBitmap(None, &target, None).map_err(fail)?;
            let context = gfx.d3d.GetImmediateContext().map_err(fail)?;
            let mut query = None;
            gfx.d3d
                .CreateQuery(
                    &D3D11_QUERY_DESC {
                        Query: D3D11_QUERY_EVENT,
                        MiscFlags: 0,
                    },
                    Some(&mut query),
                )
                .map_err(fail)?;
            let query = query.ok_or_else(|| fail(Error::from_hresult(E_FAIL)))?;
            context.End(&query);
            // Polls do not flush: this one starts the GPU on it.
            context.Flush();
            Ok(Pending {
                read,
                query,
                context,
                generation,
                width: w,
                height: h,
            })
        }
    }
}

/// A drawing on its way through the GPU into a CPU-readable bitmap.
struct Pending {
    /// The CPU-readable bitmap the copy goes into.
    read: ID2D1Bitmap1,
    /// An event query ended after the copy.
    query: ID3D11Query,
    /// The immediate context the query was ended on.
    context: ID3D11DeviceContext,
    /// [`gfx::generation`] when it was drawn.
    generation: u64,
    width: u32,
    height: u32,
}

impl Pending {
    /// Whether the GPU has finished the drawing and the copy, asked
    /// without flushing or waiting.
    fn done(&self) -> Result<bool, RenderFailure> {
        let mut done = BOOL(0);
        // SAFETY: an event query's data is a BOOL, written only when the
        // query has ended (S_OK); S_FALSE leaves it as it was.
        unsafe {
            self.context
                .GetData(
                    &self.query,
                    Some((&raw mut done).cast()),
                    std::mem::size_of::<BOOL>() as u32,
                    D3D11_ASYNC_GETDATA_DONOTFLUSH.0 as u32,
                )
                .map_err(|e| drawing_failure(&e))?;
        }
        Ok(done.as_bool())
    }

    /// Calls `f` with the pixels once the GPU is done, from this thread's
    /// message loop: polled on a thread timer every [`POLL`], so nothing
    /// waits; mapped anyway after [`POLL_LIMIT`].
    fn when_done(self, f: impl FnOnce(Result<Vec<u8>, RenderFailure>) + 'static) {
        self.poll(Instant::now() + POLL_LIMIT, Box::new(f));
    }

    fn poll(self, limit: Instant, f: Box<dyn FnOnce(Result<Vec<u8>, RenderFailure>)>) {
        match self.done() {
            Ok(false) if Instant::now() < limit => {
                let state = Rc::new(RefCell::new(Some((self, f))));
                let theirs = state.clone();
                let started = crate::image::after(POLL, move || {
                    if let Some((pending, f)) = theirs.borrow_mut().take() {
                        pending.poll(limit, f);
                    }
                });
                if started.is_none() {
                    // No timer: map now, waiting for the GPU.
                    if let Some((pending, f)) = state.borrow_mut().take() {
                        f(pending.read());
                    }
                }
            }
            Ok(_) => f(self.read()),
            Err(e) => f(Err(e)),
        }
    }

    /// The pixels: premultiplied BGRA, rows packed. Waits for the GPU if
    /// it is not done yet.
    fn read(self) -> Result<Vec<u8>, RenderFailure> {
        if gfx::generation() != self.generation {
            return Err(RenderFailure::Failed(
                "the canvas could not be drawn: the graphics device was lost".into(),
            ));
        }
        let (w, h) = (self.width as usize, self.height as usize);
        let row = w * 4;
        // SAFETY: the bitmap is ours and CPU-readable; the mapped memory
        // holds `h` rows `pitch` apart, each at least `row` bytes, and is
        // copied before `Unmap`.
        unsafe {
            let mapped = self
                .read
                .Map(D2D1_MAP_OPTIONS_READ)
                .map_err(|e| bitmap_failure((self.width, self.height), &e))?;
            let pitch = mapped.pitch as usize;
            let mut data = Vec::with_capacity(row * h);
            if pitch == row {
                data.extend_from_slice(std::slice::from_raw_parts(mapped.bits, row * h));
            } else {
                for y in 0..h {
                    let start = mapped.bits.add(y * pitch);
                    data.extend_from_slice(std::slice::from_raw_parts(start, row));
                }
            }
            let _ = self.read.Unmap();
            Ok(data)
        }
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::canvas::{CanvasOp, Num, Paint};

    use super::*;

    fn job(ops: Vec<CanvasOp>, (width, height): (u32, u32), scale: f32) -> Job {
        Job {
            drawing: Arc::new(Drawing {
                ops,
                ..Drawing::default()
            }),
            images: Images::default(),
            width,
            height,
            scale,
        }
    }

    /// The pixel at (x, y), y down, as `[b, g, r, a]` (premultiplied).
    fn pixel(data: &[u8], width: u32, x: usize, y: usize) -> [u8; 4] {
        let at = (y * width as usize + x) * 4;
        [data[at], data[at + 1], data[at + 2], data[at + 3]]
    }

    /// Asserts that the pixel at (x, y) is opaque red; on failure, says
    /// which device drew and how many pixels were drawn at all (none: the
    /// drawing never reached the bitmap that was read).
    #[track_caller]
    fn assert_red(data: &[u8], width: u32, (x, y): (usize, usize)) {
        let drawn = data.as_chunks::<4>().0.iter().filter(|p| p[3] != 0).count();
        assert_eq!(
            pixel(data, width, x, y),
            [0, 0, 255, 255],
            "pixel ({x}, {y}); {drawn} of {} pixels drawn; device: {}",
            data.len() / 4,
            device(),
        );
    }

    /// The thread's Direct3D adapter and feature level (on a machine
    /// without a GPU, "Microsoft Basic Render Driver": WARP).
    fn device() -> String {
        let describe = || -> windows::core::Result<String> {
            let gfx = gfx::get()?;
            // SAFETY: COM calls on the thread's live device.
            unsafe {
                let dxgi: windows::Win32::Graphics::Dxgi::IDXGIDevice =
                    windows::core::Interface::cast(&gfx.d3d)?;
                let desc = dxgi.GetAdapter()?.GetDesc()?;
                let len = desc.Description.iter().position(|&c| c == 0);
                let name = String::from_utf16_lossy(&desc.Description[..len.unwrap_or(128)]);
                Ok(format!(
                    "{name} (vendor {:#06x}, device {:#06x}), feature level {:#x}",
                    desc.VendorId,
                    desc.DeviceId,
                    gfx.d3d.GetFeatureLevel().0
                ))
            }
        };
        describe().unwrap_or_else(|e| format!("unknown ({e})"))
    }

    #[test]
    fn a_drawing_paints_y_down_at_its_scale() {
        if gfx::get().is_err() {
            // No Direct3D device, not even WARP.
            return;
        }
        let red = Paint::Color(Color(0xff00_00ff));
        let ops = vec![
            CanvasOp::FillStyle(red),
            CanvasOp::FillRect([
                Num::Const(0.0),
                Num::Const(0.0),
                Num::Const(30.0),
                Num::Const(10.0),
            ]),
        ];
        let data = job(ops, (60, 40), 2.0).paint().unwrap().read().unwrap();
        assert_eq!(data.len(), 60 * 40 * 4);
        assert_red(&data, 60, (5, 5));
        assert_red(&data, 60, (59, 19));
        assert_eq!(pixel(&data, 60, 5, 25)[3], 0);
    }

    /// An SVG drawn sharp is rasterized with more pixels than its own size
    /// has points: `drawImage`'s source rectangle and its default size stay
    /// in its own units.
    #[test]
    fn an_image_rasterized_at_a_scale_is_drawn_in_its_own_units() {
        if gfx::get().is_err() {
            return;
        }
        // 20 × 10 units at 2 pixels each: the left half red, the right blue.
        let (w, h) = (40u32, 20u32);
        let mut data = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..h {
            for x in 0..w {
                data.extend_from_slice(if x < w / 2 {
                    &[0, 0, 255, 255]
                } else {
                    &[255, 0, 0, 255]
                });
            }
        }
        let image = CanvasBitmap {
            frame: crate::image::Frame::from_bgra(w, h, data),
            scale: 2.0,
        };
        let uri: Arc<str> = Arc::from("asset:/mark.svg");
        let draw = |source, dest: [f32; 4]| CanvasOp::DrawImage {
            image: nsh_core::canvas::CanvasImage { uri: uri.clone() },
            source,
            dest: dest.map(Num::Const),
        };
        let nan = f32::NAN;
        let ops = vec![
            // Its own size: 20 × 10.
            draw(None, [0.0, 0.0, nan, nan]),
            // Its right half (units 10 to 20), 10 × 10 at (0, 20).
            draw(
                Some(nsh_core::geometry::Bounds::new(
                    nsh_core::geometry::point(
                        nsh_core::geometry::ScaledPixels(10.0),
                        nsh_core::geometry::ScaledPixels(0.0),
                    ),
                    nsh_core::geometry::size(
                        nsh_core::geometry::ScaledPixels(10.0),
                        nsh_core::geometry::ScaledPixels(10.0),
                    ),
                )),
                [0.0, 20.0, 10.0, 10.0],
            ),
        ];
        let mut job = job(ops, (40, 40), 1.0);
        job.images.insert(uri.clone(), Some(image));
        let data = job.paint().unwrap().read().unwrap();
        assert_red(&data, 40, (5, 5));
        assert_eq!(pixel(&data, 40, 15, 5), [255, 0, 0, 255], "the blue half");
        assert_eq!(pixel(&data, 40, 25, 5)[3], 0, "no wider than 20");
        assert_eq!(pixel(&data, 40, 5, 15)[3], 0, "no taller than 10");
        assert_eq!(
            pixel(&data, 40, 5, 25),
            [255, 0, 0, 255],
            "the source's blue"
        );
    }

    #[test]
    fn animated_values_paint_at_zero() {
        if gfx::get().is_err() {
            return;
        }
        let red = Paint::Color(Color(0xff00_00ff));
        // Slot 0 is the rectangle's x: unset, it is 0.
        let ops = vec![
            CanvasOp::FillStyle(red),
            CanvasOp::FillRect([
                Num::Slot(0),
                Num::Const(0.0),
                Num::Const(10.0),
                Num::Const(10.0),
            ]),
        ];
        let data = job(ops, (20, 10), 1.0).paint().unwrap().read().unwrap();
        assert_red(&data, 20, (2, 2));
        assert_eq!(pixel(&data, 20, 15, 2)[3], 0);
    }

    #[test]
    fn an_image_is_encoded_as_png() {
        let png = encode(vec![0; 3 * 2 * 4], (3, 2), ImageFormat::Png).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        // IHDR: the width and height, big-endian.
        assert_eq!(&png[16..24], &[0, 0, 0, 3, 0, 0, 0, 2]);
    }

    #[test]
    fn a_drawing_is_encoded_as_png() {
        if gfx::get().is_err() {
            return;
        }
        let ops = vec![
            CanvasOp::FillStyle(Paint::Color(Color(0x00ff_00ff))),
            CanvasOp::FillRect([
                Num::Const(0.0),
                Num::Const(0.0),
                Num::Const(4.0),
                Num::Const(4.0),
            ]),
        ];
        let pixels = job(ops, (8, 6), 2.0).paint().unwrap().read().unwrap();
        let png = encode(pixels, (8, 6), ImageFormat::Png).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&png[16..24], &[0, 0, 0, 8, 0, 0, 0, 6]);
    }

    #[test]
    fn the_gpu_finishes_without_being_waited_for() {
        if gfx::get().is_err() {
            return;
        }
        let ops = vec![
            CanvasOp::FillStyle(Paint::Color(Color(0xff00_00ff))),
            CanvasOp::FillRect([
                Num::Const(0.0),
                Num::Const(0.0),
                Num::Const(8.0),
                Num::Const(8.0),
            ]),
        ];
        let pending = job(ops, (8, 8), 1.0).paint().unwrap();
        let limit = Instant::now() + Duration::from_secs(10);
        while !pending.done().unwrap() {
            assert!(Instant::now() < limit, "the event query never ended");
            std::thread::sleep(Duration::from_millis(1));
        }
        let data = pending.read().unwrap();
        assert_red(&data, 8, (4, 4));
    }

    #[test]
    fn an_image_over_the_device_limit_is_too_large() {
        assert_eq!(check_size((16_384, 16_384), 16_384), Ok(()));
        assert!(matches!(
            check_size((16_385, 10), 16_384),
            Err(RenderFailure::TooLarge(m)) if m.contains("16384 pixels a side")
        ));
        assert!(matches!(
            check_size((10, 16_385), 16_384),
            Err(RenderFailure::TooLarge(_))
        ));
    }

    #[test]
    fn running_out_of_memory_is_too_large() {
        assert!(means_too_large(E_OUTOFMEMORY));
        assert!(means_too_large(D2DERR_MAX_TEXTURE_SIZE_EXCEEDED));
        assert!(!means_too_large(E_FAIL));
        assert!(!means_too_large(D2DERR_RECREATE_TARGET));
        let e = Error::from_hresult(E_OUTOFMEMORY);
        assert!(matches!(
            bitmap_failure((20_000, 20_000), &e),
            RenderFailure::TooLarge(m) if m.starts_with("a 20000×20000 pixel image")
        ));
        let e = Error::from_hresult(E_FAIL);
        assert!(matches!(
            bitmap_failure((20, 20), &e),
            RenderFailure::Failed(_)
        ));
    }

    #[test]
    fn premultiplied_pixels_become_straight() {
        // Half-transparent red, premultiplied; opaque and clear pixels
        // stay as they are.
        let mut pixels = vec![0, 0, 128, 128, 10, 20, 30, 255, 0, 0, 0, 0];
        unpremultiply(&mut pixels);
        assert_eq!(pixels, [0, 0, 255, 128, 10, 20, 30, 255, 0, 0, 0, 0]);
    }
}
