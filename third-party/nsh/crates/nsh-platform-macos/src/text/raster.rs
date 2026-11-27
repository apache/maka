//! Texts painted off the main thread.
//!
//! A content layer drawn by its delegate (`drawLayer:inContext:`) is drawn
//! by Core Animation during the main thread's transaction commit: a page
//! that shows a hundred new texts spends that commit allocating a backing
//! store per text and running CoreText into each. Instead, the engine
//! thread paints the texts of a batch it hands over ([`prerender`]) into
//! IOSurfaces, in parallel, before the batch leaves it; the main thread
//! sets a surface as the content layer's `contents` ([`show`]), which the
//! window server shows as it is. The page's first frame shows its text,
//! and the commit only carries the surfaces.
//!
//! A raster is a picture of one `MountItem::Text` at its view's known
//! `MountItem::Frame` size (remembered across batches in [`State`], so an
//! updated text whose frame did not change—such as a recycled list
//! cell—still paints off the main thread), at the window's backing scale.
//! Whatever it cannot know draws on the main thread as before: a layer of
//! another size or density (a view still waiting to be placed, a scaled
//! ancestor), a selection, an animated or transitioning color, or a
//! colors-only re-paint keeping the same layout (`super::damage` partial
//! redraw). A raster is shown once when its text draws; every later redraw
//! (selection, colors, density) is Core Animation's again, and a text out
//! of sight when its batch is applied drops its raster
//! ([`super::drop_raster`]), so no picture waits for a view that may never
//! show.

use std::{
    any::Any,
    sync::{Arc, Weak},
};

use nsh_core::{AttributedText, MountBatch, MountItem, NodeId, Points, Size, TextLayout};
use objc2::rc::Retained;
use objc2_core_foundation::{
    CFDictionary, CFNumber, CFRetained, CFString, CFType, CGFloat, CGPoint, CGRect, CGSize,
};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGColorSpace, CGContext, CGImageAlphaInfo, CGImageByteOrderInfo,
    kCGColorSpaceSRGB,
};
use objc2_io_surface::{
    IOSurfaceLockOptions, IOSurfaceRef, kIOSurfaceBytesPerElement, kIOSurfaceBytesPerRow,
    kIOSurfaceColorSpace, kIOSurfaceHeight, kIOSurfacePixelFormat, kIOSurfaceWidth,
};
use objc2_quartz_core::CALayer;
use rustc_hash::{FxHashMap, FxHashSet};

use super::CoreTextLayout;

/// `'BGRA'`: 8 bits a channel, premultiplied, blue first in memory.
const BGRA: i32 = 0x4247_5241;

/// The most pixels a side a raster has: a content layer's own bound
/// (`view::content_density`), past which the main thread draws it.
const MAX_SIDE: usize = 4096;

/// Below this many texts a batch's are painted on the engine thread alone:
/// a thread costs more than the few it would take over.
const PER_THREAD: usize = 8;

/// At most this many threads paint a batch's texts.
const MAX_THREADS: usize = 8;

/// One text painted off the main thread.
pub(crate) struct Raster {
    surface: CFRetained<IOSurfaceRef>,
    /// The layer size (points) and density it was painted for.
    size: CGSize,
    scale: CGFloat,
    /// What it shows: the item's text and layout, to tell it from another
    /// item of the same view in the batch.
    text: Arc<AttributedText>,
    layout: TextLayout,
}

// SAFETY: the surface is written only while it is made, on one thread;
// after that it is only read (shown), and IOSurfaces are shared between
// threads and processes. The text and layout are `Send` themselves.
unsafe impl Send for Raster {}

impl Raster {
    /// Whether it shows `text` laid out as `layout`.
    pub(super) fn shows(&self, text: &Arc<AttributedText>, layout: &TextLayout) -> bool {
        Arc::ptr_eq(&self.text, text) && Arc::ptr_eq(&self.layout.0, &layout.0)
    }
}

/// The rasters of a batch's texts, by view.
#[derive(Default)]
pub(crate) struct Rasters(FxHashMap<NodeId, Raster>);

impl Rasters {
    /// The raster of `id`'s text, if it was painted for `text` and
    /// `layout`.
    pub(crate) fn take(
        &mut self,
        id: NodeId,
        text: &Arc<AttributedText>,
        layout: &TextLayout,
    ) -> Option<Raster> {
        if self.0.get(&id)?.shows(text, layout) {
            self.0.remove(&id)
        } else {
            None
        }
    }
}

/// What [`prerender`] remembers across a surface's batches so a text
/// updated without a new `MountItem::Frame` (such as a recycled `<List>`
/// cell whose relative frame did not change) still paints off the main
/// thread at its known view size.
#[derive(Default)]
pub(crate) struct State {
    /// Last known `MountItem::Frame` size of each live node.
    sizes: FxHashMap<NodeId, Size<Points>>,
    /// Weak handle to the last pre-rendered `TextLayout` of each live text
    /// node, so colors-only updates that keep the same layout
    /// (`super::damage` partial redraws) do not re-rasterize the whole text
    /// into a new surface.
    layouts: FxHashMap<NodeId, Weak<dyn Any + Send + Sync>>,
}

/// Paints the texts of `batch` that are new, re-laid out, or resized at
/// the backing `scale` using each view's latest `MountItem::Frame` size in
/// `state`, on the engine thread and as many others as there are texts to
/// share (up to [`MAX_THREADS`]). Each view's last text item counts: the
/// earlier are replaced before anything draws. Same-layout updates at the
/// same view size are skipped so partial color redraws keep their backing
/// store.
pub(crate) fn prerender(batch: &MountBatch, scale: CGFloat, state: &mut State) -> Rasters {
    let mut resized: FxHashSet<NodeId> = FxHashSet::default();
    let mut texts: FxHashMap<NodeId, usize> = FxHashMap::default();
    for (i, item) in batch.items.iter().enumerate() {
        match item {
            MountItem::Create { id, .. } => {
                state.sizes.remove(id);
                state.layouts.remove(id);
            }
            MountItem::Frame { id, frame } => {
                if state.sizes.insert(*id, frame.size) != Some(frame.size) {
                    resized.insert(*id);
                }
            }
            MountItem::Text { id, .. } => {
                texts.insert(*id, i);
            }
            MountItem::Delete { id } => {
                state.sizes.remove(id);
                state.layouts.remove(id);
                texts.remove(id);
            }
            _ => {}
        }
    }
    if !(scale.is_finite() && scale > 0.0) {
        return Rasters::default();
    }
    let mut jobs: Vec<Job<'_>> = texts
        .into_iter()
        .filter_map(|(id, i)| {
            let MountItem::Text {
                text,
                layout,
                content,
                ..
            } = &batch.items[i]
            else {
                return None;
            };
            let size = state.sizes.get(&id)?;
            let same_layout = state
                .layouts
                .get(&id)
                .and_then(Weak::upgrade)
                .is_some_and(|prev| Arc::ptr_eq(&prev, &layout.0));
            state.layouts.insert(id, Arc::downgrade(&layout.0));
            if same_layout && !resized.contains(&id) {
                return None;
            }
            Some(Job {
                id,
                text,
                layout,
                content: *content,
                size: CGSize::new(size.width.0 as CGFloat, size.height.0 as CGFloat),
            })
        })
        .collect();
    if jobs.is_empty() {
        return Rasters::default();
    }
    let threads = std::thread::available_parallelism()
        .map_or(1, |n| n.get())
        .min(MAX_THREADS)
        .min(jobs.len().div_ceil(PER_THREAD))
        .max(1);
    let mut rasters = FxHashMap::default();
    if threads == 1 {
        rasters.extend(
            jobs.iter()
                .filter_map(|job| Some((job.id, job.paint(scale)?))),
        );
        return Rasters(rasters);
    }
    // Long texts first, spread over the threads in turn, so no thread gets
    // all of the long ones.
    jobs.sort_unstable_by(|a, b| {
        (b.size.width * b.size.height).total_cmp(&(a.size.width * a.size.height))
    });
    let jobs = &jobs;
    std::thread::scope(|scope| {
        let workers: Vec<_> = (1..threads)
            .map(|t| {
                scope.spawn(move || {
                    jobs.iter()
                        .skip(t)
                        .step_by(threads)
                        .filter_map(|job| Some((job.id, job.paint(scale)?)))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        // This thread takes its share too.
        rasters.extend(
            jobs.iter()
                .step_by(threads)
                .filter_map(|job| Some((job.id, job.paint(scale)?))),
        );
        for worker in workers {
            // A thread that panicked painted nothing: the main thread
            // draws its texts.
            if let Ok(painted) = worker.join() {
                rasters.extend(painted);
            }
        }
    });
    Rasters(rasters)
}

/// A text of a batch to paint.
struct Job<'a> {
    id: NodeId,
    text: &'a Arc<AttributedText>,
    layout: &'a TextLayout,
    content: nsh_core::Bounds<Points>,
    /// Its view's size (points).
    size: CGSize,
}

impl Job<'_> {
    /// Its picture at `scale`, or `None` when the main thread is to draw
    /// it (nothing to show, too large, not CoreText's, or no surface).
    fn paint(&self, scale: CGFloat) -> Option<Raster> {
        let laid = self.layout.downcast::<CoreTextLayout>()?;
        if self.text.text.is_empty() && !self.text.has_backgrounds() {
            return None;
        }
        let (w, h) = (
            (self.size.width * scale).ceil(),
            (self.size.height * scale).ceil(),
        );
        if !(w >= 1.0 && h >= 1.0) || w > MAX_SIDE as CGFloat || h > MAX_SIDE as CGFloat {
            return None;
        }
        let (w, h) = (w as usize, h as usize);
        let surface = surface(w, h)?;
        // SAFETY: the surface is new and this thread's alone: locked for
        // writing while the context draws into its memory, `h` rows of
        // `bytes_per_row` bytes, and unlocked before anyone else sees it.
        unsafe {
            if surface.lock(IOSurfaceLockOptions::empty(), std::ptr::null_mut()) != 0 {
                return None;
            }
            let painted = paint_into(&surface, (w, h), scale, |cx| {
                super::paint(cx, self.text, laid, self.content, None, None);
            });
            surface.unlock(IOSurfaceLockOptions::empty(), std::ptr::null_mut());
            painted?;
        }
        Some(Raster {
            surface,
            size: self.size,
            scale,
            text: self.text.clone(),
            layout: self.layout.clone(),
        })
    }
}

/// Runs `paint` into the locked `surface` of `w` × `h` pixels, cleared,
/// y down in points at `scale`: as Core Animation hands a content layer's
/// delegate its context, font smoothing on (Core Animation smooths, which
/// darkens stems, in the backing stores of layers that are not opaque too;
/// a raster drawn without it looked lighter on every glyph).
///
/// # Safety
///
/// `surface` is locked for writing and is `w` × `h` `'BGRA'` pixels.
unsafe fn paint_into(
    surface: &IOSurfaceRef,
    (w, h): (usize, usize),
    scale: CGFloat,
    paint: impl FnOnce(&CGContext),
) -> Option<()> {
    // SAFETY: a constant of CoreGraphics.
    let space = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))?;
    // SAFETY: the surface's memory, locked by the caller, holds `h` rows of
    // `bytes_per_row` bytes and outlives the context, dropped here.
    let context = unsafe {
        CGBitmapContextCreate(
            surface.base_address().as_ptr(),
            w,
            h,
            8,
            surface.bytes_per_row(),
            Some(&space),
            CGImageAlphaInfo::PremultipliedFirst.0 | CGImageByteOrderInfo::Order32Little.0,
        )
    }?;
    let c = Some(&*context);
    let full = CGRect::new(
        CGPoint::new(0.0, 0.0),
        CGSize::new(w as CGFloat, h as CGFloat),
    );
    CGContext::clear_rect(c, full);
    CGContext::set_allows_font_smoothing(c, true);
    CGContext::set_should_smooth_fonts(c, true);
    // Memory's first row is the picture's top, which a layer shows at its
    // top: y down from there, in points.
    CGContext::translate_ctm(c, 0.0, h as CGFloat);
    CGContext::scale_ctm(c, scale, -scale);
    paint(&context);
    CGContext::flush(c);
    Some(())
}

/// An IOSurface of `w` × `h` premultiplied `'BGRA'` pixels in sRGB, the
/// space the texts' colors are in.
fn surface(w: usize, h: usize) -> Option<CFRetained<IOSurfaceRef>> {
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
            IOSurfaceRef::align_property(kIOSurfaceBytesPerRow, w * 4),
        )
    };
    let numbers = [
        CFNumber::new_i64(w as i64),
        CFNumber::new_i64(h as i64),
        CFNumber::new_i32(4),
        CFNumber::new_i64(row as i64),
        CFNumber::new_i32(BGRA),
    ];
    let values: Vec<&CFType> = numbers.iter().map(|n| n.as_ref()).collect();
    let properties = CFDictionary::<CFString, CFType>::from_slices(&keys, &values);
    // SAFETY: the dictionary holds IOSurface's properties, numbers each.
    let surface = unsafe { IOSurfaceRef::new(properties.as_opaque()) }?;
    // The window server matches the colors from sRGB to the display's
    // (`kCGColorSpaceSRGB`'s value is its name).
    let srgb = CFString::from_static_str("kCGColorSpaceSRGB");
    // SAFETY: a color space name is a valid `IOSurfaceColorSpace`.
    unsafe { surface.set_value(kIOSurfaceColorSpace, srgb.as_ref()) };
    Some(surface)
}

/// Shows `raster` in `layer`, the content layer of a text drawn with
/// nothing the raster leaves out; whether it could (the layer's size and
/// density are those it was painted for).
pub(super) fn show(layer: &CALayer, raster: &Raster) -> bool {
    if layer.bounds().size != raster.size || layer.contentsScale() != raster.scale {
        return false;
    }
    let ptr = &*raster.surface as *const IOSurfaceRef as *mut objc2::runtime::AnyObject;
    // SAFETY: an IOSurfaceRef is an Objective-C object (`IOSurface`,
    // toll-free bridged); retained for the layer.
    let Some(object) = (unsafe { Retained::retain(ptr) }) else {
        return false;
    };
    // SAFETY: an IOSurface is a valid `contents` object.
    unsafe { layer.setContents(Some(&object)) };
    true
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, sync::Arc};

    use nsh_core::{
        AttributedText, Bounds, Color, MountBatch, MountItem, Point, Points, ResolvedTextStyle,
        Size, TextEngine,
    };
    use objc2::{ClassType, define_class, msg_send, rc::Retained};
    use objc2_core_foundation::{CGFloat, CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{
        CGBitmapContextGetBitmapInfo, CGBitmapContextGetBitsPerPixel,
        CGBitmapContextGetBytesPerRow, CGBitmapContextGetData, CGBitmapContextGetHeight,
        CGBitmapContextGetWidth, CGContext, CGImageAlphaInfo, CGImageByteOrderInfo,
    };
    use objc2_io_surface::IOSurfaceLockOptions;
    use objc2_quartz_core::CALayer;

    use super::{super::CoreTextEngine, State, prerender};

    /// What the probe layer paints.
    type Paint = Box<dyn Fn(&CGContext)>;

    thread_local! {
        /// What the probe layer paints, and the pixels Core Animation's
        /// backing store held after it did (RGBA, top row first).
        static PROBE: RefCell<(Option<Paint>, Option<Pixels>)> =
            RefCell::new((None, None));
    }

    /// Premultiplied RGBA bytes, `w` × `h`, top row first.
    struct Pixels {
        w: usize,
        h: usize,
        rgba: Vec<u8>,
    }

    /// The bitmap of `cx` as RGBA bytes, top row first.
    fn read_bitmap(cx: &CGContext) -> Pixels {
        let c = Some(cx);
        let data = CGBitmapContextGetData(c).cast::<u8>();
        assert!(
            !data.is_null(),
            "Core Animation's context is a bitmap context"
        );
        assert_eq!(CGBitmapContextGetBitsPerPixel(c), 32, "8 bits a channel");
        let (w, h, stride) = (
            CGBitmapContextGetWidth(c),
            CGBitmapContextGetHeight(c),
            CGBitmapContextGetBytesPerRow(c),
        );
        let info = CGBitmapContextGetBitmapInfo(c).0;
        let alpha = info & 0x1f;
        let little = info & 0x7000 == CGImageByteOrderInfo::Order32Little.0;
        let alpha_first = alpha == CGImageAlphaInfo::PremultipliedFirst.0
            || alpha == CGImageAlphaInfo::First.0
            || alpha == CGImageAlphaInfo::NoneSkipFirst.0;
        // Where R, G, B and A are in a pixel's four bytes.
        let order: [usize; 4] = match (little, alpha_first) {
            (true, true) => [2, 1, 0, 3],
            (true, false) => [3, 2, 1, 0],
            (false, true) => [1, 2, 3, 0],
            (false, false) => [0, 1, 2, 3],
        };
        let mut rgba = Vec::with_capacity(w * h * 4);
        for y in 0..h {
            // SAFETY: the context's own `h` rows of `stride` bytes.
            let row = unsafe { std::slice::from_raw_parts(data.add(y * stride), w * 4) };
            for px in row.as_chunks::<4>().0 {
                rgba.extend(order.iter().map(|&i| px[i]));
            }
        }
        Pixels { w, h, rgba }
    }

    define_class!(
        /// A layer that paints what [`PROBE`] holds in the context Core
        /// Animation gives it, and keeps what its backing store then holds.
        #[unsafe(super(CALayer))]
        #[name = "NshTextRasterProbe"]
        struct Probe;

        impl Probe {
            #[unsafe(method(drawInContext:))]
            fn draw_in_context(&self, cx: &CGContext) {
                let c = Some(cx);
                CGContext::save_g_state(c);
                // As the content layer's delegate: top down.
                if !self.contentsAreFlipped() {
                    CGContext::translate_ctm(c, 0.0, self.bounds().size.height);
                    CGContext::scale_ctm(c, 1.0, -1.0);
                }
                PROBE.with(|p| {
                    if let Some(paint) = &p.borrow().0 {
                        paint(cx);
                    }
                });
                CGContext::restore_g_state(c);
                CGContext::flush(c);
                let pixels = read_bitmap(cx);
                PROBE.with(|p| p.borrow_mut().1 = Some(pixels));
            }
        }
    );

    /// What Core Animation draws in a content layer of `size` points at
    /// `scale` for `paint`: the reference a raster must match.
    fn drawn_by_core_animation(
        size: CGSize,
        scale: CGFloat,
        paint: Box<dyn Fn(&CGContext)>,
    ) -> Pixels {
        PROBE.with(|p| *p.borrow_mut() = (Some(paint), None));
        // SAFETY: `+new` of a CALayer subclass.
        let layer: Retained<Probe> = unsafe { msg_send![Probe::class(), new] };
        layer.setBounds(CGRect::new(CGPoint::new(0.0, 0.0), size));
        layer.setContentsScale(scale);
        layer.setDrawsAsynchronously(false);
        layer.setNeedsDisplay();
        layer.displayIfNeeded();
        PROBE
            .with(|p| p.borrow_mut().1.take())
            .expect("Core Animation drew the layer")
    }

    fn text_item(engine: &CoreTextEngine, id: u32) -> (MountItem, Size<Points>) {
        let mut text = AttributedText::default();
        let style = ResolvedTextStyle {
            font_size: Points(15.0),
            line_height: Points(20.0),
            ..ResolvedTextStyle::default()
        };
        text.push("Painted off the main thread\n", style);
        // Gray and a color, as a dark theme's text and links.
        text.push(
            "Two lines, ",
            ResolvedTextStyle {
                color: Color(0xd4d4_d4ff),
                ..style
            },
        );
        text.push(
            "a link",
            ResolvedTextStyle {
                color: Color(0x3b82_f6ff),
                font_weight: 600,
                ..style
            },
        );
        let text = Arc::new(text);
        let prepared = engine.prepare(&text);
        let size = engine.measure(&prepared, Some(Points(240.0)));
        let layout = engine.layout(&prepared, size);
        let item = MountItem::Text {
            id,
            text,
            layout,
            content: Bounds::new(Point::new(Points(4.0), Points(3.0)), size),
        };
        (item, size)
    }

    /// The engine thread paints a batch's texts whose views get a frame in
    /// it, only for the item that put them there, and pixel for pixel as
    /// Core Animation draws them in the content layer's own backing store
    /// (font smoothing included; colors within a step of rounding, as the
    /// backing store's color space may not be sRGB).
    #[test]
    fn a_batch_paints_its_framed_texts_as_core_animation_draws_them() {
        let engine = CoreTextEngine::default();
        let (framed, size) = text_item(&engine, 2);
        let (unframed, _) = text_item(&engine, 4);
        let view = Size::new(size.width + Points(8.0), size.height + Points(6.0));
        let batch = MountBatch {
            items: vec![
                MountItem::Frame {
                    id: 2,
                    frame: Bounds::new(Point::default(), view),
                },
                framed.clone(),
                unframed,
            ],
        };
        let scale: CGFloat = 2.0;
        let mut rasters = prerender(&batch, scale, &mut State::default());
        let MountItem::Text {
            text,
            layout,
            content,
            ..
        } = &framed
        else {
            unreachable!()
        };
        // Another item of the same view does not take it.
        let other = Arc::new(AttributedText::default());
        assert!(rasters.take(2, &other, layout).is_none());
        assert!(rasters.take(4, text, layout).is_none());
        let raster = rasters.take(2, text, layout).expect("a raster");
        let points = CGSize::new(view.width.0 as CGFloat, view.height.0 as CGFloat);
        let (w, h) = (
            (points.width * scale).ceil() as usize,
            (points.height * scale).ceil() as usize,
        );
        assert_eq!((raster.surface.width(), raster.surface.height()), (w, h));

        let (text, layout, content) = (text.clone(), layout.clone(), *content);
        let expected = drawn_by_core_animation(
            points,
            scale,
            Box::new(move |cx| {
                let laid = layout.downcast::<super::super::CoreTextLayout>().unwrap();
                super::super::paint(cx, &text, laid, content, None, None);
            }),
        );
        assert_eq!((expected.w, expected.h), (w, h), "the backing store's size");

        let surface = &raster.surface;
        // SAFETY: locked for reading while its rows are compared; `'BGRA'`
        // pixels, `h` rows of `bytes_per_row` bytes.
        let (mut worst, mut differing, mut inked) = (0u8, 0usize, false);
        unsafe {
            assert_eq!(
                surface.lock(IOSurfaceLockOptions::ReadOnly, std::ptr::null_mut()),
                0
            );
            let base = surface.base_address().as_ptr().cast::<u8>();
            let stride = surface.bytes_per_row();
            for y in 0..h {
                let row = std::slice::from_raw_parts(base.add(y * stride), w * 4);
                for (x, px) in row.as_chunks::<4>().0.iter().enumerate() {
                    let ours = [px[2], px[1], px[0], px[3]];
                    let at = (y * w + x) * 4;
                    let theirs = &expected.rgba[at..at + 4];
                    inked |= ours[3] != 0;
                    // Coverage must match exactly; colors to a step.
                    assert_eq!(ours[3], theirs[3], "alpha at ({x}, {y})");
                    let diff = (0..3)
                        .map(|i| ours[i].abs_diff(theirs[i]))
                        .max()
                        .unwrap_or(0);
                    worst = worst.max(diff);
                    differing += usize::from(diff > 0);
                }
            }
            surface.unlock(IOSurfaceLockOptions::ReadOnly, std::ptr::null_mut());
        }
        assert!(inked, "the text is painted");
        assert!(
            worst <= 2,
            "colors differ by up to {worst} in {differing} pixels"
        );
    }

    #[test]
    fn updated_text_reuses_remembered_frame_size_until_deleted() {
        let engine = CoreTextEngine::default();
        let mut state = State::default();
        let scale: CGFloat = 2.0;

        // Batch 1: initial frame + text yields a raster and remembers the size.
        let (first, size) = text_item(&engine, 2);
        let view = Size::new(size.width + Points(8.0), size.height + Points(6.0));
        let mut rasters = prerender(
            &MountBatch {
                items: vec![
                    MountItem::Frame {
                        id: 2,
                        frame: Bounds::new(Point::default(), view),
                    },
                    first.clone(),
                ],
            },
            scale,
            &mut state,
        );
        let MountItem::Text {
            text: first_text,
            layout: first_layout,
            content,
            ..
        } = &first
        else {
            unreachable!()
        };
        assert!(rasters.take(2, first_text, first_layout).is_some());

        // Batch 2: updated text with a new layout (e.g. a recycled List cell)
        // and no MountItem::Frame reuses the remembered view size.
        let (second, _) = text_item(&engine, 2);
        let MountItem::Text {
            text: second_text,
            layout: second_layout,
            ..
        } = &second
        else {
            unreachable!()
        };
        let mut rasters = prerender(
            &MountBatch {
                items: vec![second.clone()],
            },
            scale,
            &mut state,
        );
        assert!(rasters.take(2, second_text, second_layout).is_some());

        // Batch 3: same layout at the same size (e.g. partial color redraw)
        // skips pre-rendering so partial invalidation keeps its backing store.
        let recolored_text = second_text.clone();
        let mut rasters = prerender(
            &MountBatch {
                items: vec![MountItem::Text {
                    id: 2,
                    text: recolored_text.clone(),
                    layout: second_layout.clone(),
                    content: *content,
                }],
            },
            scale,
            &mut state,
        );
        assert!(rasters.take(2, &recolored_text, second_layout).is_none());

        // Batch 4 & 5: deleting the node forgets its frame size.
        let _ = prerender(
            &MountBatch {
                items: vec![MountItem::Delete { id: 2 }],
            },
            scale,
            &mut state,
        );
        let (after_delete, _) = text_item(&engine, 2);
        let MountItem::Text {
            text: after_text,
            layout: after_layout,
            ..
        } = &after_delete
        else {
            unreachable!()
        };
        let mut rasters = prerender(
            &MountBatch {
                items: vec![after_delete.clone()],
            },
            scale,
            &mut state,
        );
        assert!(rasters.take(2, after_text, after_layout).is_none());
    }
}
