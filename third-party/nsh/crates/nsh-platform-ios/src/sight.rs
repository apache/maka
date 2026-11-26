//! Whether a view can be seen ([`shown`]): in a window, not hidden, and not
//! entirely clipped away by an ancestor that clips its children (a scroll
//! view it was scrolled out of, a box with `overflow: hidden`). Shader
//! views out of sight skip their frames ([`crate::shader`]).
//!
//! The geometry is the macOS backend's
//! ([`nsh_platform_apple::sight::Sights`]), read from UIKit's view tree
//! ([`UiViews`]): a view's placed frame from its `center` and `bounds`
//! (`frame` follows the transform), what its content shows from its
//! `bounds` origin (a scroll view's offset), and its layer transform about
//! the anchor. A zoomed scroll view's zoom is the transform of the view it
//! zooms, which this reads like any other.

use std::cell::RefCell;

use nsh_core::Matrix;
use nsh_platform_apple::sight::{Sights, Span, Tree};
use objc2::{ClassType, Message, rc::Retained};
use objc2_foundation::NSObjectProtocol;
use objc2_quartz_core::CATransform3D;
use objc2_ui_kit::{UIView, UIWindow};

/// Whether any of `view` can be seen now.
pub(crate) fn shown(view: &UIView) -> bool {
    thread_local! {
        /// Kept for its allocations: shaders in sight ask on every frame.
        static SIGHTS: RefCell<Sights<Retained<UIView>>> = RefCell::default();
    }
    let (view, views) = (view.retain(), UiViews(&is_window));
    SIGHTS.with(|sights| match sights.try_borrow_mut() {
        Ok(mut sights) => {
            sights.clear();
            let shown = sights.shows(&views, &view);
            sights.clear();
            shown
        }
        Err(_) => Sights::default().shows(&views, &view),
    })
}

fn is_window(view: &UIView) -> bool {
    view.isKindOfClass(UIWindow::class())
}

/// UIKit's view tree, up to the window (a view `.0` says is one).
struct UiViews<'a>(&'a dyn Fn(&UIView) -> bool);

impl Tree for UiViews<'_> {
    type Node = Retained<UIView>;

    fn key(&self, node: &Self::Node) -> usize {
        Retained::as_ptr(node) as usize
    }

    fn parent(&self, node: &Self::Node) -> Option<Self::Node> {
        node.superview()
    }

    fn hidden(&self, node: &Self::Node) -> bool {
        node.isHidden()
    }

    fn top_shown(&self, node: &Self::Node) -> bool {
        // The top of a tree in a window is the window; anything else is
        // out of every window.
        (self.0)(node) && !node.isHidden()
    }

    fn frame(&self, node: &Self::Node) -> Span {
        let (center, bounds) = (node.center(), node.bounds());
        let anchor = node.layer().anchorPoint();
        let (w, h) = (bounds.size.width, bounds.size.height);
        let x = (center.x - w * anchor.x) as f32;
        let y = (center.y - h * anchor.y) as f32;
        (x, y, x + w as f32, y + h as f32)
    }

    fn transform(&self, node: &Self::Node) -> Option<Matrix> {
        let layer = node.layer();
        let t = layer.transform();
        if is_identity(&t) {
            return None;
        }
        let size = node.bounds().size;
        let anchor = layer.anchorPoint();
        let (ax, ay) = (size.width * anchor.x, size.height * anchor.y);
        let z = layer.anchorPointZ();
        // To the anchor, transform, and back (row vectors).
        Some(
            translation(-ax, -ay, -z)
                .mul(&matrix(&t))
                .mul(&translation(ax, ay, z)),
        )
    }

    fn content(&self, node: &Self::Node) -> ((f32, f32), f32, bool) {
        let origin = node.bounds().origin;
        // The window shows only what is within it.
        let clips = node.clipsToBounds() || (self.0)(node);
        ((origin.x as f32, origin.y as f32), 1.0, clips)
    }
}

/// `t` as a [`Matrix`] (the same layout).
fn matrix(t: &CATransform3D) -> Matrix {
    Matrix([
        t.m11, t.m12, t.m13, t.m14, //
        t.m21, t.m22, t.m23, t.m24, //
        t.m31, t.m32, t.m33, t.m34, //
        t.m41, t.m42, t.m43, t.m44,
    ])
}

fn translation(x: f64, y: f64, z: f64) -> Matrix {
    let mut m = Matrix::IDENTITY;
    (m.0[12], m.0[13], m.0[14]) = (x, y, z);
    m
}

fn is_identity(t: &CATransform3D) -> bool {
    matrix(t) == Matrix::IDENTITY
}

#[cfg(test)]
mod tests {
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};

    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> CGRect {
        CGRect::new(CGPoint::new(x, y), CGSize::new(w, h))
    }

    fn view(mtm: MainThreadMarker, frame: CGRect) -> Retained<UIView> {
        UIView::initWithFrame(UIView::alloc(mtm), frame)
    }

    /// Whether `view` shows under `top`, which stands in for the window: a
    /// test runs off the main thread, where UIKit makes no windows.
    fn shown_under(top: &UIView, view: &UIView) -> bool {
        let is_top = |v: &UIView| std::ptr::eq(v, top);
        Sights::default().shows(&UiViews(&is_top), &view.retain())
    }

    /// A shader's host in a scrolled view (a scroll view scrolls by its
    /// bounds' origin): it stops showing once scrolled out of the viewport
    /// and shows again once scrolled back.
    #[test]
    fn a_view_scrolled_out_of_its_scroll_view_does_not_show() {
        // SAFETY: the views are made, used and dropped on this thread
        // alone, outside any window: UIKit never sees them.
        let mtm = unsafe { MainThreadMarker::new_unchecked() };
        let window = view(mtm, rect(0.0, 0.0, 400.0, 800.0));
        let scroll = view(mtm, rect(0.0, 100.0, 400.0, 600.0));
        scroll.setClipsToBounds(true);
        window.addSubview(&scroll);
        let host = view(mtm, rect(0.0, 200.0, 400.0, 200.0));
        scroll.addSubview(&host);
        let scroll_to = |y: f64| scroll.setBounds(rect(0.0, y, 400.0, 600.0));
        assert!(shown_under(&window, &host));
        scroll_to(1000.0);
        assert!(!shown_under(&window, &host), "scrolled away");
        // Its edge at the viewport's top is out of sight; a point in is not.
        scroll_to(400.0);
        assert!(!shown_under(&window, &host));
        scroll_to(399.0);
        assert!(shown_under(&window, &host), "scrolled back");
        // Hidden, or out of the window: not shown.
        scroll.setHidden(true);
        assert!(!shown_under(&window, &host));
        scroll.setHidden(false);
        scroll.removeFromSuperview();
        assert!(!shown_under(&window, &host));
    }

    /// A box that does not clip lets what overflows it show, up to the
    /// window's edge; one that clips does not. A transform moves what
    /// shows.
    #[test]
    fn clips_and_transforms_decide_what_shows() {
        // SAFETY: as above.
        let mtm = unsafe { MainThreadMarker::new_unchecked() };
        let window = view(mtm, rect(0.0, 0.0, 400.0, 800.0));
        let card = view(mtm, rect(0.0, 0.0, 100.0, 100.0));
        window.addSubview(&card);
        let host = view(mtm, rect(150.0, 0.0, 50.0, 50.0));
        card.addSubview(&host);
        assert!(shown_under(&window, &host), "overflow shows");
        card.setClipsToBounds(true);
        assert!(!shown_under(&window, &host), "clipped away");
        card.setClipsToBounds(false);
        // Moved past the window's right edge, then back.
        host.layer()
            .setTransform(CATransform3D::new_translation(300.0, 0.0, 0.0));
        assert!(!shown_under(&window, &host));
        host.layer()
            .setTransform(CATransform3D::new_translation(-100.0, 0.0, 0.0));
        assert!(shown_under(&window, &host));
        // Scaled down about its middle (the anchor): a box at x 380 to
        // 480 shrinks to 425 to 435, past the edge (about its top left it
        // would still reach in, 380 to 390).
        host.layer()
            .setTransform(CATransform3D::new_translation(0.0, 0.0, 0.0));
        host.setFrame(rect(380.0, 0.0, 100.0, 100.0));
        assert!(shown_under(&window, &host));
        let mut small = host.layer().transform();
        (small.m11, small.m22) = (0.1, 0.1);
        host.layer().setTransform(small);
        assert!(!shown_under(&window, &host));
    }
}
