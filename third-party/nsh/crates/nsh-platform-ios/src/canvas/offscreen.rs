//! `Command::RenderCanvas` (`OffscreenCanvas`'s `convertToBlob`): a drawing
//! replayed as a canvas view's is ([`super::paint`]), into a bitmap context
//! of its own off the main thread, and encoded with ImageIO. The images it
//! names load first, on the main thread, through the surface's
//! [`ImageLoader`] (decoded at their natural size, as a canvas view's, so
//! they share its cache); the image goes to the engine as one root
//! [`EventKind::CanvasImage`].

use std::sync::Arc;

use dispatch2::{DispatchQueue, DispatchQueueGlobalPriority, GlobalQueueIdentifier};
use nsh_core::{
    EventKind, EventPayload, ROOT_ID,
    canvas::{
        Drawing,
        render::{ImageFormat, RenderFailure},
    },
};
use nsh_engine::EngineControl;
use nsh_platform_apple::canvas_image::{bitmap_context, encode};
use objc2_core_foundation::{CFRetained, CGFloat};
use objc2_core_graphics::{CGBitmapContextCreateImage, CGContext, CGImage};

use super::Images;
use crate::image::{DecodedImage, ImageLoader, Look, Request};

/// The images a render waits for: their cache keys and URIs.
type Waiting = Vec<(String, Arc<str>)>;

/// The renders waiting for their images.
#[derive(Default)]
pub(crate) struct Offscreen {
    /// Each render, with the cache keys of the images it waits for and
    /// their URIs.
    pending: Vec<(Job, Waiting)>,
}

/// A `Command::RenderCanvas`.
pub(crate) struct RenderRequest {
    /// The request, answered as [`EventPayload::CanvasImage`]'s `id`.
    pub(crate) id: u32,
    /// What to draw, in points.
    pub(crate) drawing: Arc<Drawing>,
    /// The image's size in pixels.
    pub(crate) width: u32,
    pub(crate) height: u32,
    /// Pixels per point.
    pub(crate) scale: f32,
    /// The encoding.
    pub(crate) format: ImageFormat,
}

impl Offscreen {
    /// Starts `request`: requests the images its drawing names from
    /// `loader` (decoded for `display_scale`, as a canvas view's), and
    /// renders once they are all in, answering through `control`.
    pub(crate) fn render(
        &mut self,
        request: RenderRequest,
        loader: &mut ImageLoader,
        display_scale: CGFloat,
        control: &EngineControl,
    ) {
        let mut uris: Vec<Arc<str>> = request.drawing.images().map(|i| i.uri.clone()).collect();
        uris.sort_unstable();
        uris.dedup();
        let mut job = Job {
            id: request.id,
            drawing: request.drawing,
            images: Images::default(),
            width: request.width,
            height: request.height,
            scale: request.scale,
            format: request.format,
        };
        let mut waiting = Vec::new();
        for uri in uris {
            // The root waits in the loader: it tells the mounter, which
            // hands every finished image to `image_loaded`.
            match loader.request(ROOT_ID, &uri, None, 0, display_scale, Look::default()) {
                Request::Ready(decoded) => {
                    job.images.insert(uri, decoded.image);
                }
                Request::Pending => {
                    waiting.push((ImageLoader::key(&uri, 0, Look::default()), uri));
                }
            }
        }
        if waiting.is_empty() {
            job.start(control.clone());
        } else {
            self.pending.push((job, waiting));
        }
    }

    /// The image of cache key `key` finished loading (or failed): renders
    /// waiting for nothing else start. A failed image is left out, as a
    /// canvas view leaves it out.
    pub(crate) fn image_loaded(
        &mut self,
        key: &str,
        result: &Result<DecodedImage, String>,
        control: &EngineControl,
    ) {
        let mut i = 0;
        while i < self.pending.len() {
            let (job, waiting) = &mut self.pending[i];
            if let Some(at) = waiting.iter().position(|(k, _)| k == key) {
                let (_, uri) = waiting.swap_remove(at);
                match result {
                    Ok(decoded) => {
                        job.images.insert(uri, decoded.image.clone());
                    }
                    Err(message) => log::warn!("offscreen canvas: {message}"),
                }
                if waiting.is_empty() {
                    let (job, _) = self.pending.swap_remove(i);
                    job.start(control.clone());
                    continue;
                }
            }
            i += 1;
        }
    }
}

/// What a background thread paints and encodes.
struct Job {
    id: u32,
    drawing: Arc<Drawing>,
    images: Images,
    width: u32,
    height: u32,
    scale: f32,
    format: ImageFormat,
}

// SAFETY: `UIImage` is immutable and documented as safe to use from any
// thread (as `DecodedImage`'s); the job is moved to one thread and only
// used there. The rest is plain data.
unsafe impl Send for Job {}

impl Job {
    /// Paints and encodes on a background queue, then answers the engine
    /// from there: `EngineControl` takes events from any thread, and a
    /// surface gone by then has no engine to read them.
    fn start(self, control: EngineControl) {
        DispatchQueue::global_queue(GlobalQueueIdentifier::Priority(
            DispatchQueueGlobalPriority::Default,
        ))
        .exec_async(move || {
            let id = self.id;
            let result = self.encode();
            control.dispatch_event(
                ROOT_ID,
                EventKind::CanvasImage,
                EventPayload::CanvasImage { id, result },
            );
        });
    }

    fn encode(self) -> Result<Vec<u8>, RenderFailure> {
        let format = self.format;
        let image = self.paint()?;
        encode(&image, format)
    }

    /// The drawing replayed into a transparent bitmap, y down, `scale`
    /// pixels per point, its animated values at 0.
    fn paint(&self) -> Result<CFRetained<CGImage>, RenderFailure> {
        let (pw, ph) = (self.width as usize, self.height as usize);
        let scale = CGFloat::from(self.scale);
        let cx = bitmap_context(pw, ph)?;
        // Core Graphics bitmaps are y up: flip to the canvas's space.
        CGContext::translate_ctm(Some(&cx), 0.0, ph as CGFloat);
        CGContext::scale_ctm(Some(&cx), scale, -scale);
        // The bitmap's base space (its pixels, y up) from the canvas's,
        // where shadows are cast.
        let base = CGContext::ctm(Some(&cx));
        super::paint(&cx, &self.drawing, &[], &self.images, base);
        CGBitmapContextCreateImage(Some(&cx)).ok_or_else(|| "the canvas could not be drawn".into())
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::{
        Color,
        canvas::{CanvasOp, Num, Paint},
        geometry::{Point, Points},
    };
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};

    use super::*;

    fn job(ops: Vec<CanvasOp>, (width, height): (u32, u32), scale: f32) -> Job {
        Job {
            id: 0,
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
            let at = (y * w + x) * 4;
            let p = std::slice::from_raw_parts(data, w * h * 4);
            [p[at], p[at + 1], p[at + 2], p[at + 3]]
        }
    }

    #[test]
    fn a_drawing_paints_y_down_at_its_scale() {
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
    fn a_shadow_falls_by_its_offset_in_the_canvas_points() {
        // A black square at (10, 10), 10 points wide, casting a hard red
        // shadow 20 points right and 15 down, at 2 pixels per point: the
        // shadow's middle is at (35, 30) points, (70, 60) pixels.
        let c = Num::Const;
        let ops = vec![
            CanvasOp::ShadowColor(Color(0xff0000ff)),
            CanvasOp::ShadowBlur(Points(0.0)),
            CanvasOp::ShadowOffset(Point::new(Points(20.0), Points(15.0))),
            CanvasOp::FillStyle(Paint::Color(Color(0x000000ff))),
            CanvasOp::FillRect([c(10.0), c(10.0), c(10.0), c(10.0)]),
        ];
        let image = job(ops, (200, 80), 2.0).paint().unwrap();
        assert_eq!(pixel(&image, 30, 30), [0, 0, 0, 255], "the square");
        assert_eq!(pixel(&image, 70, 60), [0, 0, 255, 255], "its shadow");
        // Not cast upward (a y up base space), nor half as far (offsets
        // taken as pixels).
        assert_eq!(pixel(&image, 70, 1)[3], 0);
        assert_eq!(pixel(&image, 50, 45)[3], 0);
    }

    #[test]
    fn an_image_is_encoded_as_png() {
        let png = job(Vec::new(), (3, 2), 1.0).encode().unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&png[16..24], &[0, 0, 0, 3, 0, 0, 0, 2]);
    }
}
