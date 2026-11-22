//! Zoomable scroll views (`maximumZoomScale` above `minimumZoomScale`): the
//! children live in a [`ZoomView`] filling the content, which UIKit scales
//! (`viewForZoomingInScrollView:`). Its bounds stay the unzoomed content
//! size, so the core's frames of the children stay valid.

use objc2::{ClassType, MainThreadMarker, MainThreadOnly, define_class, rc::Retained};
use objc2_core_foundation::{CGFloat, CGPoint, CGRect, CGSize};
use objc2_foundation::{NSObject, NSObjectProtocol};
use objc2_ui_kit::{UIResponder, UIScrollView, UIView};

define_class!(
    /// The zoomed content of a scroll view.
    #[unsafe(super(UIView, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshZoomView"]
    pub(crate) struct ZoomView;
);

/// The zoom view of `scroll`, if it zooms.
pub(crate) fn zoom_view(scroll: &UIScrollView) -> Option<Retained<UIView>> {
    scroll
        .subviews()
        .iter()
        .find(|v| v.isKindOfClass(ZoomView::class()))
}

/// Gives `scroll` a zoom view (moving its node children into it) or takes
/// it away (moving them back, unzoomed). Returns the zoom view.
pub(crate) fn set_zoomable(
    scroll: &UIScrollView,
    on: bool,
    mtm: MainThreadMarker,
) -> Option<Retained<UIView>> {
    match (on, zoom_view(scroll)) {
        (true, None) => {
            // SAFETY: a plain view initializer.
            let zoom: Retained<UIView> =
                Retained::into_super(unsafe { objc2::msg_send![ZoomView::alloc(mtm), init] });
            let size = scroll.contentSize();
            zoom.setFrame(CGRect::new(CGPoint::ZERO, size));
            // Node views only: UIKit's own subviews (indicators, the
            // refresh control) stay. Node views are tagged with their id.
            for child in scroll.subviews().iter().filter(|v| v.tag() > 0) {
                zoom.addSubview(&child);
            }
            scroll.insertSubview_atIndex(&zoom, 0);
            Some(zoom)
        }
        (false, Some(zoom)) => {
            scroll.setZoomScale(1.0);
            let size = zoom.bounds().size;
            for child in zoom.subviews().iter() {
                scroll.insertSubview_belowSubview(&child, &zoom);
            }
            zoom.removeFromSuperview();
            scroll.setContentSize(size);
            None
        }
        (_, zoom) => zoom,
    }
}

/// Lays the zoom view out for an unzoomed content size of `size` at the
/// current zoom scale; with `center`, content smaller than the viewport is
/// centered.
pub(crate) fn layout(scroll: &UIScrollView, zoom: &UIView, size: CGSize, center: bool) {
    let s = scroll.zoomScale();
    let scaled = CGSize::new(size.width * s, size.height * s);
    // Bounds and center, never the frame: the view has a (zoom) transform.
    zoom.setBounds(CGRect::new(CGPoint::ZERO, size));
    let viewport = scroll.bounds().size;
    let inset = scroll.adjustedContentInset();
    let free = |viewport: CGFloat, content: CGFloat| -> CGFloat {
        if center {
            (viewport - content).max(0.0)
        } else {
            0.0
        }
    };
    let dx = free(viewport.width - inset.left - inset.right, scaled.width);
    let dy = free(viewport.height - inset.top - inset.bottom, scaled.height);
    zoom.setCenter(CGPoint::new(
        (scaled.width + dx) / 2.0,
        (scaled.height + dy) / 2.0,
    ));
    scroll.setContentSize(scaled);
}

/// Zooms `scroll` to `scale` around the content point `center` (unzoomed
/// points), or around the middle of what is visible.
pub(crate) fn zoom_to(
    scroll: &UIScrollView,
    scale: f32,
    center: Option<(f32, f32)>,
    animated: bool,
) {
    let scale = (scale as CGFloat).clamp(scroll.minimumZoomScale(), scroll.maximumZoomScale());
    let s = scroll.zoomScale();
    let bounds = scroll.bounds();
    let (cx, cy) = match center {
        Some((x, y)) => (x as CGFloat, y as CGFloat),
        None => (
            (bounds.origin.x + bounds.size.width / 2.0) / s,
            (bounds.origin.y + bounds.size.height / 2.0) / s,
        ),
    };
    let size = CGSize::new(bounds.size.width / scale, bounds.size.height / scale);
    let rect = CGRect::new(
        CGPoint::new(cx - size.width / 2.0, cy - size.height / 2.0),
        size,
    );
    scroll.zoomToRect_animated(rect, animated);
}

/// Redraws the drawn views inside `zoom` (texts, canvases) at the zoomed
/// resolution once a zoom ends, so they stay sharp instead of scaling their
/// bitmaps. Each view's backing store is capped at 4096 pixels a side.
pub(crate) fn sharpen(zoom: &UIView, scale: CGFloat) {
    let screen = zoom.window().map_or(2.0, |w| w.screen().scale());
    fn walk(view: &UIView, scale: CGFloat, screen: CGFloat) {
        for child in view.subviews().iter() {
            let drawn = child.isKindOfClass(crate::text_view::TextView::class())
                || child.isKindOfClass(crate::canvas::CanvasView::class());
            if drawn {
                let size = child.bounds().size;
                let side = size.width.max(size.height).max(1.0);
                let factor = (screen * scale.max(1.0)).min(4096.0 / side).max(screen);
                if (child.contentScaleFactor() - factor).abs() > 0.01 {
                    child.setContentScaleFactor(factor);
                    child.setNeedsDisplay();
                }
            }
            walk(&child, scale, screen);
        }
    }
    walk(zoom, scale, screen);
}
