//! `Command::RenderCanvas` (`OffscreenCanvas`'s `convertToBlob`): a drawing
//! replayed as a canvas view's is ([`Replay`]), into a Cairo image surface
//! of its own, and encoded as PNG by GDK. The images it names load first
//! through the shared loader ([`crate::image::load_bitmap`]); the image
//! goes to the engine as one root [`EventKind::CanvasImage`].
//!
//! The replay runs on the main thread, as an on-screen canvas' does: its
//! text is laid out with the main thread's Pango context and the desktop's
//! UI family (GTK's settings), so an offscreen drawing's text matches the
//! canvas' and `measureText`. The encoding, the costly part of a large
//! image (compression), runs on a thread of its own, which answers the
//! engine directly.

use std::{cell::RefCell, rc::Rc, sync::Arc};

use gtk4::{cairo, gdk, glib, prelude::*};
use nsh_core::{
    EventKind, EventPayload, ROOT_ID,
    canvas::{
        Drawing,
        render::{ImageFormat, RenderFailure},
    },
};
use rustc_hash::FxHashMap;

use super::{CanvasBitmap, Replay, State, TextCache};
use crate::surface::Surface;

/// The images a drawing names, by URI: `None` when one failed to load.
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
    let mut control = None;
    surface.control(|c| control = Some(c.clone()));
    let Some(control) = control else { return };
    let mut uris: Vec<Arc<str>> = drawing.images().map(|i| i.uri.clone()).collect();
    uris.sort_unstable();
    uris.dedup();
    let job = move |images: Images| {
        let size = (
            i32::try_from(width).unwrap_or(i32::MAX),
            i32::try_from(height).unwrap_or(i32::MAX),
        );
        let painted = paint(&drawing, &images, size, f64::from(scale));
        drop(images);
        let pixels = match painted.and_then(Pixels::new) {
            Ok(pixels) => pixels,
            Err(failure) => {
                control.dispatch_event(
                    ROOT_ID,
                    EventKind::CanvasImage,
                    EventPayload::CanvasImage {
                        id,
                        result: Err(failure),
                    },
                );
                return;
            }
        };
        // The control answers from the thread, or here when no thread
        // starts: the request is answered either way.
        let thread = control.clone();
        let spawned = std::thread::Builder::new()
            .name("nsh-canvas-encode".into())
            .spawn(move || {
                let result = encode(pixels, format);
                thread.dispatch_event(
                    ROOT_ID,
                    EventKind::CanvasImage,
                    EventPayload::CanvasImage { id, result },
                );
            });
        if let Err(e) = spawned {
            control.dispatch_event(
                ROOT_ID,
                EventKind::CanvasImage,
                EventPayload::CanvasImage {
                    id,
                    result: Err(format!("the image could not be encoded: {e}").into()),
                },
            );
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
        // A cached texture is handed over before `load_bitmap` returns: no
        // borrow of `waiting` is held across the call.
        crate::image::load_bitmap(surface, &uri, f64::from(scale), move |result| {
            let image = result
                .and_then(CanvasBitmap::new)
                .inspect_err(|e| log::warn!("offscreen canvas: {e}"))
                .ok();
            let mut w = waiting.borrow_mut();
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

/// `drawing` replayed into a transparent `pw` × `ph` pixel surface, y
/// down, `scale` pixels per point, its animated values at 0 (no slot is
/// set).
fn paint(
    drawing: &Drawing,
    images: &Images,
    (pw, ph): (i32, i32),
    scale: f64,
) -> Result<cairo::ImageSurface, RenderFailure> {
    let fail = |e| failure(e, (pw, ph));
    let surface = cairo::ImageSurface::create(cairo::Format::ARgb32, pw, ph).map_err(fail)?;
    surface.set_device_scale(scale, scale);
    {
        let cr = cairo::Context::new(&surface).map_err(fail)?;
        let mut text = TextCache::default();
        let mut replay = Replay {
            cr: &cr,
            args: &[],
            images,
            text: &mut text,
            scale,
            base: cr.matrix(),
            state: State::default(),
            stack: Vec::new(),
            has_path: false,
            stash: None,
        };
        for op in &drawing.ops {
            replay.op(op);
        }
        // A layer of the replay (a group, a shadow) Cairo had no memory
        // for leaves the image without it.
        match cr.status() {
            Err(cairo::Error::NoMemory) => return Err(fail(cairo::Error::NoMemory)),
            Err(e) => log::warn!("offscreen canvas: cairo: {e}"),
            Ok(()) => {}
        }
    }
    surface.flush();
    Ok(surface)
}

/// What Cairo's `error` making or drawing a `pw` × `ph` pixel image
/// means for the app: a size past Cairo's (32767 pixels a side) or memory
/// it could not allocate is [`RenderFailure::TooLarge`].
fn failure(error: cairo::Error, (pw, ph): (i32, i32)) -> RenderFailure {
    match error {
        cairo::Error::InvalidSize | cairo::Error::NoMemory => RenderFailure::TooLarge(format!(
            "the system could not allocate a {pw}×{ph} bitmap ({error})"
        )),
        e => RenderFailure::Failed(format!("the canvas could not be drawn: {e}")),
    }
}

/// A painted surface's pixels, which the encoding thread owns.
struct Pixels {
    data: cairo::ImageSurfaceDataOwned,
    width: i32,
    height: i32,
    stride: usize,
}

impl Pixels {
    /// `surface`'s pixels (no other reference to it may be left).
    fn new(surface: cairo::ImageSurface) -> Result<Self, RenderFailure> {
        let (width, height) = (surface.width(), surface.height());
        let stride = surface.stride() as usize;
        let data = surface
            .take_data()
            .map_err(|e| RenderFailure::from(format!("the canvas could not be drawn: {e}")))?;
        Ok(Pixels {
            data,
            width,
            height,
            stride,
        })
    }
}

/// `pixels` encoded as `format`.
fn encode(pixels: Pixels, format: ImageFormat) -> Result<Vec<u8>, RenderFailure> {
    let Pixels {
        data,
        width,
        height,
        stride,
    } = pixels;
    // Cairo's ARGB32 is premultiplied, native-endian: BGRA in memory on
    // little-endian machines. GDK unpremultiplies as it writes.
    let memory = if cfg!(target_endian = "little") {
        gdk::MemoryFormat::B8g8r8a8Premultiplied
    } else {
        gdk::MemoryFormat::A8r8g8b8Premultiplied
    };
    let bytes = glib::Bytes::from_owned(data);
    let texture = gdk::MemoryTexture::new(width, height, memory, &bytes, stride);
    match format {
        ImageFormat::Png => Ok(texture.save_to_png_bytes().to_vec()),
        _ => Err(format!("{} images are not encoded here", format.mime()).into()),
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::{
        Color,
        canvas::{CanvasOp, Num, Paint},
    };

    use super::*;

    fn red_band(size: (i32, i32), scale: f64) -> cairo::ImageSurface {
        let red = Paint::Color(Color(0xff00_00ff));
        let drawing = Drawing {
            ops: vec![
                CanvasOp::FillStyle(red),
                CanvasOp::FillRect([
                    Num::Const(0.0),
                    Num::Const(0.0),
                    Num::Const(30.0),
                    Num::Const(10.0),
                ]),
            ],
            ..Drawing::default()
        };
        paint(&drawing, &Images::default(), size, scale).unwrap()
    }

    #[test]
    fn a_drawing_paints_y_down_at_its_scale() {
        let mut surface = red_band((60, 40), 2.0);
        assert_eq!((surface.width(), surface.height()), (60, 40));
        let stride = surface.stride() as usize;
        let data = surface.data().unwrap();
        // Premultiplied ARGB32, native-endian (BGRA on little-endian).
        let pixel = |x: usize, y: usize| {
            let at = y * stride + x * 4;
            u32::from_ne_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]])
        };
        // 30 × 10 points at the top left are 60 × 20 pixels.
        assert_eq!(pixel(5, 5), 0xffff_0000);
        assert_eq!(pixel(59, 19), 0xffff_0000);
        assert_eq!(pixel(5, 25) >> 24, 0);
    }

    #[test]
    fn an_image_past_cairos_size_is_too_large() {
        // Cairo takes at most 32767 pixels a side.
        let drawing = Drawing::default();
        let failure = paint(&drawing, &Images::default(), (40_000, 1), 1.0).unwrap_err();
        assert!(matches!(failure, RenderFailure::TooLarge(_)), "{failure:?}");
    }

    #[test]
    fn cairos_size_and_memory_errors_are_too_large() {
        for e in [cairo::Error::InvalidSize, cairo::Error::NoMemory] {
            assert!(matches!(failure(e, (1, 1)), RenderFailure::TooLarge(_)));
        }
        assert!(matches!(
            failure(cairo::Error::InvalidFormat, (1, 1)),
            RenderFailure::Failed(_)
        ));
    }

    #[test]
    fn an_image_is_encoded_as_png() {
        let surface = red_band((3, 2), 1.0);
        let png = encode(Pixels::new(surface).unwrap(), ImageFormat::Png).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        // IHDR's width and height.
        assert_eq!(&png[16..24], &[0, 0, 0, 3, 0, 0, 0, 2]);
    }
}
