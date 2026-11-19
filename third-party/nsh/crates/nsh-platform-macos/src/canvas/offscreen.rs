//! `Command::RenderCanvas` (`OffscreenCanvas`'s `convertToBlob`): a drawing
//! replayed as a canvas view's is ([`CanvasState::paint`]), into a bitmap
//! context of its own off the main thread, and encoded with ImageIO. The
//! images it names load first, on the main thread, through the shared
//! loader; the image goes to the engine as one root
//! [`EventKind::CanvasImage`].

use std::{cell::RefCell, rc::Rc, sync::Arc};

use dispatch2::DispatchQueue;
use nsh_core::{
    EventKind, EventPayload, ROOT_ID,
    canvas::{
        Drawing,
        render::{ImageFormat, RenderFailure},
    },
};
use nsh_platform_apple::canvas_image::{bitmap_context, encode};
use objc2_core_foundation::{CFRetained, CGFloat, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{CGBitmapContextCreateImage, CGContext, CGImage};
use rustc_hash::FxHashMap;

use super::CanvasState;
use crate::surface::Surface;

type Images = FxHashMap<Arc<str>, Option<crate::image::CanvasBitmap>>;

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
            format,
        };
        DispatchQueue::global_queue(dispatch2::GlobalQueueIdentifier::Priority(
            dispatch2::DispatchQueueGlobalPriority::Default,
        ))
        .exec_async(move || {
            let result = job.encode();
            DispatchQueue::main().exec_async(move || {
                if let Some(surface) = Surface::with_key(key) {
                    surface.event(
                        ROOT_ID,
                        EventKind::CanvasImage,
                        EventPayload::CanvasImage { id, result },
                    );
                }
            });
        });
    };
    if uris.is_empty() {
        job(Images::default());
        return;
    }
    // Each image once, as a canvas view loads them: the job runs when the
    // last has loaded or failed (a failed one draws nothing).
    let waiting = Rc::new(RefCell::new((uris.len(), Images::default(), Some(job))));
    for uri in uris {
        let waiting = waiting.clone();
        let key = uri.clone();
        crate::image::load(surface, &uri, scale, move |result| {
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

/// What a background thread paints and encodes.
struct Job {
    drawing: Arc<Drawing>,
    images: Images,
    width: u32,
    height: u32,
    scale: f32,
    format: ImageFormat,
}

// SAFETY: Core Graphics images are immutable and thread-safe; the drawing is
// plain data. The job is moved to one thread and used there only.
unsafe impl Send for Job {}

impl Job {
    fn encode(self) -> Result<Vec<u8>, RenderFailure> {
        let format = self.format;
        let image = self.paint()?;
        encode(&image, format)
    }

    /// The drawing replayed into a transparent bitmap, y down, `scale`
    /// pixels per point.
    fn paint(self) -> Result<CFRetained<CGImage>, RenderFailure> {
        let (pw, ph) = (self.width as usize, self.height as usize);
        let scale = CGFloat::from(self.scale);
        let canvas = CanvasState {
            drawing: Some(self.drawing),
            images: self.images,
            ..CanvasState::default()
        };
        let cx = bitmap_context(pw, ph)?;
        // As a flipped view over a window's: y down, points.
        CGContext::translate_ctm(Some(&cx), 0.0, ph as CGFloat);
        CGContext::scale_ctm(Some(&cx), scale, -scale);
        // The bitmap's base space (its pixels, y up) from the view's.
        let base = CGContext::ctm(Some(&cx));
        let size = CGSize::new(pw as CGFloat / scale, ph as CGFloat / scale);
        canvas.paint(
            &cx,
            CGRect::new(CGPoint::ZERO, size),
            size,
            scale,
            false,
            base,
        );
        CGBitmapContextCreateImage(Some(&cx)).ok_or_else(|| "the canvas could not be drawn".into())
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::{
        Color,
        canvas::{CanvasOp, Num, Paint},
    };

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
            format: ImageFormat::Png,
        }
    }

    /// The pixel at (x, y), y down, as `[b, g, r, a]` (premultiplied).
    fn pixel(image: &CGImage, x: usize, y: usize) -> [u8; 4] {
        let (w, h) = (CGImage::width(Some(image)), CGImage::height(Some(image)));
        let cx = bitmap_context(w, h).unwrap();
        // SAFETY: the bitmap Core Graphics allocated holds `w * h * 4`
        // bytes while the context lives; read after drawing the image in.
        unsafe {
            CGContext::draw_image(
                Some(&cx),
                CGRect::new(CGPoint::ZERO, CGSize::new(w as CGFloat, h as CGFloat)),
                Some(image),
            );
            let data = objc2_core_graphics::CGBitmapContextGetData(Some(&cx)).cast::<u8>();
            // Rows are stored top first.
            let at = (y * w + x) * 4;
            let p = std::slice::from_raw_parts(data, w * h * 4);
            [p[at], p[at + 1], p[at + 2], p[at + 3]]
        }
    }

    #[test]
    fn a_drawing_paints_y_down_at_its_scale() {
        let red = Paint::Color(Color(0xff00_00ff));
        // The top half red, the rest transparent.
        let ops = vec![
            CanvasOp::FillStyle(red),
            CanvasOp::FillRect([
                Num::Const(0.0),
                Num::Const(0.0),
                Num::Const(30.0),
                Num::Const(10.0),
            ]),
        ];
        let image = job(ops, (60, 40), 2.0).paint().unwrap();
        assert_eq!(
            (CGImage::width(Some(&image)), CGImage::height(Some(&image))),
            (60, 40)
        );
        assert_eq!(pixel(&image, 5, 5), [0, 0, 255, 255]);
        assert_eq!(pixel(&image, 59, 19), [0, 0, 255, 255]);
        assert_eq!(pixel(&image, 5, 25)[3], 0);
    }

    #[test]
    fn an_image_is_encoded_as_png() {
        let png = job(Vec::new(), (3, 2), 1.0).encode().unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        // IHDR: width and height, big-endian.
        assert_eq!(&png[16..24], &[0, 0, 0, 3, 0, 0, 0, 2]);
    }

    #[test]
    fn a_bitmap_past_the_systems_limits_is_too_large() {
        // Rows whose byte length overflows, and 4 EiB no allocator gives.
        for (width, height) in [(usize::MAX, 1), (1 << 40, 1 << 20)] {
            assert!(
                matches!(
                    bitmap_context(width, height),
                    Err(RenderFailure::TooLarge(_))
                ),
                "{width}×{height}"
            );
        }
    }
}
