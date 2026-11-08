//! `NshView`: the AppKit view of one node.
//!
//! The core lays everything out, so a view never measures itself: it sits
//! at the frame the core gave it ([`NshView::place`]: the frame's origin,
//! a sticky shift, mirrored lists, and the view's transform on its layer).
//! Views are flipped (y down) and layer-backed; scroll views move their
//! children by the bounds origin of their [`container`](NshView::container)
//! (as `NSClipView` scrolls), so a scroll is one call.
//!
//! What a view looks like is mostly Core Animation: its layer's background,
//! corners, border and shadow, and sublayers for the rest
//! ([`crate::decor`]). Every view uses `updateLayer` and gets no backing
//! store; text and canvas drawings (CoreText / Core Graphics) go into a
//! content sublayer whose delegate draws them (`drawLayer:inContext:`,
//! [`NshView::redraw`]).
//!
//! Children are subviews of the view, or of its container when it has one:
//! scroll views always do, and a view that clips its children and casts a
//! shadow does (clipping a layer clips its shadow too). Native AppKit views
//! a view hosts (a text field, a header) are [`ViewState::natives`]: they
//! sit above the children, at their own rectangles.
//!
//! The root view of a surface takes every mouse event over an app's view
//! (`hitTest:`) and hands it to [`crate::input`], which picks the view
//! itself (transforms, `overflow`, `pointerEvents`, hit slop); hosted
//! native views get their own events.

use std::{
    cell::{Cell, Ref, RefCell, RefMut},
    rc::Weak,
};

use nsh_core::{
    Bounds, EventMask, Matrix, NodeId, PointerEvents, Points, ROOT_ID, ViewKind, ViewProps,
    ViewStyle, animation::AnimValues,
};
#[cfg(feature = "terminal")]
use nsh_core::{Point, Size};
use objc2::{
    AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, ProtocolObject, Sel},
    sel,
};
use objc2_app_kit::{
    NSAccessibility, NSDragOperation, NSDraggingDestination, NSDraggingInfo, NSEvent, NSEventType,
    NSResponder, NSTrackingArea, NSTrackingAreaOptions, NSView, NSViewLayerContentsRedrawPolicy,
    NSWindowOrderingMode,
};
use objc2_core_foundation::{CGAffineTransform, CGFloat, CGPoint, CGRect, CGSize};
use objc2_core_graphics::CGContext;
use objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSPoint, NSRange, NSRect, NSString};
use objc2_quartz_core::{CALayer, CALayerDelegate, CATransform3D, kCAGravityTopLeft};

use crate::surface::{Surface, quiet};

/// Scroll position and extent of a [`ViewKind::Scroll`] view.
#[derive(Debug, Default, Clone)]
pub(crate) struct ScrollState {
    /// Current offset (points; content coordinates of the viewport's top
    /// left).
    pub(crate) x: f32,
    /// Vertical offset.
    pub(crate) y: f32,
    /// Size of the scrollable content.
    pub(crate) content: (f32, f32),
    /// Scrolls horizontally.
    pub(crate) horizontal: bool,
    /// Shows the scroll indicator.
    pub(crate) indicator: bool,
    /// How it scrolls (paging, snapping, insets...).
    pub(crate) behavior: nsh_core::ScrollBehavior,
    /// Scrolls the core asked for (`ScrollBy`, `scrollTo`) that were
    /// applied: reported with each offset.
    pub(crate) applied: u32,
    /// The sticky cells: (cell, start, end).
    pub(crate) sticky: Vec<nsh_core::StickyCell>,
    /// A horizontal list laid out right to left: children are placed
    /// mirrored (offsets stay left to right).
    pub(crate) mirrored: bool,
    /// Gestures, glides and the indicator ([`crate::scroll`]).
    pub(crate) live: crate::scroll::Live,
}

impl ScrollState {
    /// The largest offsets.
    pub(crate) fn max(&self, viewport: (f32, f32)) -> (f32, f32) {
        let inset = self.behavior.content_inset.map(|v| v.0);
        (
            (self.content.0 + inset.left + inset.right - viewport.0).max(0.0),
            (self.content.1 + inset.top + inset.bottom - viewport.1).max(0.0),
        )
    }
}

/// A native AppKit view a view hosts at `rect` (view coordinates).
#[derive(Debug, Clone)]
pub(crate) struct Native {
    /// The view (a subview of the node's view).
    pub(crate) view: Retained<NSView>,
    /// Where it goes.
    pub(crate) rect: Bounds<Points>,
}

/// Everything the mounter set on one view.
pub(crate) struct ViewState {
    /// Node id.
    pub(crate) id: NodeId,
    /// What it is.
    pub(crate) kind: ViewKind,
    /// Frame in the parent (points).
    pub(crate) frame: Bounds<Points>,
    /// Visual style.
    pub(crate) style: Box<ViewStyle>,
    /// Native animation values.
    pub(crate) anim: AnimValues,
    /// Events JS listens to.
    pub(crate) events: EventMask,
    /// Touch, accessibility and test properties.
    pub(crate) props: Box<ViewProps>,
    /// States to report (`TrackStates`), and the current ones.
    pub(crate) tracked: u16,
    /// Current interaction states (pressed, hovered, focused).
    pub(crate) states: u16,
    /// Extra translation (sticky list cells, screen transitions).
    pub(crate) shift: (f32, f32),
    /// Extra opacity (screen and modal transitions).
    pub(crate) fade: f32,
    /// Scroll state (scroll views). Boxed, as the image, canvas and
    /// shader states: few views have one, and every view's state is
    /// allocated with its AppKit view.
    pub(crate) scroll: Option<Box<ScrollState>>,
    /// Text content (text views).
    pub(crate) text: Option<crate::text::DrawnText>,
    /// Image content (image views).
    pub(crate) image: Option<Box<crate::image::ImageState>>,
    /// Canvas content.
    pub(crate) canvas: Option<Box<crate::canvas::CanvasState>>,
    /// What a shader draws under the children ([`crate::shader`]).
    pub(crate) shader: Option<Box<crate::shader::ShaderState>>,
    /// Text field (input views).
    pub(crate) input: Option<std::rc::Rc<crate::text_input::InputState>>,
    /// Hosted AppKit views.
    pub(crate) natives: Vec<Native>,
    /// The area descendants cover outside the bounds (`MountItem::Overflow`):
    /// hit testing looks there too.
    pub(crate) overflow: Option<Bounds<Points>>,
    /// Running layout / style transitions and keyframes.
    pub(crate) live: Option<Box<crate::transition::Live>>,
    /// The layers decoration added ([`crate::decor`]).
    pub(crate) decor: crate::decor::Decor,
    /// What accessibility last gave AppKit.
    pub(crate) access: crate::access::Applied,
}

impl ViewState {
    fn new(id: NodeId, kind: ViewKind) -> Self {
        ViewState {
            id,
            kind,
            frame: Bounds::default(),
            style: Box::default(),
            anim: AnimValues::default(),
            events: EventMask::default(),
            props: Box::default(),
            tracked: 0,
            states: 0,
            shift: (0.0, 0.0),
            fade: 1.0,
            scroll: matches!(kind, ViewKind::Scroll).then(Box::default),
            text: None,
            image: None,
            canvas: None,
            shader: None,
            input: None,
            natives: Vec::new(),
            overflow: None,
            live: None,
            decor: Default::default(),
            access: Default::default(),
        }
    }

    /// The opacity it is drawn with.
    pub(crate) fn opacity(&self) -> f32 {
        let live = self.live.as_ref().map_or(1.0, |l| l.opacity());
        // `filter: opacity()` scales it like the property.
        let filters = self.style.effects.as_ref().map_or(1.0, |e| {
            e.filters
                .iter()
                .map(|f| match *f {
                    nsh_core::Filter::Opacity(o) => o,
                    _ => 1.0,
                })
                .product()
        });
        self.anim.opacity.unwrap_or(self.style.opacity) * self.fade * live * filters
    }

    /// Its borders, with an animated color.
    pub(crate) fn borders(&self) -> nsh_core::Borders {
        let mut b = self.style.borders;
        if let Some(c) = self.anim.border_color {
            b.colors = [c; 4];
        }
        b
    }

    /// Its background color, animated or not.
    pub(crate) fn background(&self) -> nsh_core::Color {
        self.anim.background.unwrap_or(self.style.background_color)
    }

    /// True if its children are clipped to its rounded bounds.
    pub(crate) fn clips(&self) -> bool {
        self.style.overflow_hidden
            || matches!(
                self.kind,
                ViewKind::Scroll | ViewKind::Image | ViewKind::Stack | ViewKind::Input
            )
    }

    /// True if it draws content into its content layer (text, canvas).
    pub(crate) fn draws(&self) -> bool {
        self.text.is_some() || self.canvas.is_some()
    }

    /// Its transform (static entries, overridden by animated ones) around
    /// its transform origin, as a row-vector matrix about its top left
    /// corner (the layer's anchor), or `None` when it has none.
    pub(crate) fn transform(&self) -> Option<Matrix> {
        let t = &self.style.transform;
        let animated = self.anim.transform.iter().any(Option::is_some);
        let extra = self.live.as_ref().and_then(|l| l.extra());
        if extra.is_none() && (t.ops().is_empty() || (!animated && t.is_identity())) {
            return None;
        }
        let (w, h) = (self.frame.size.width.0, self.frame.size.height.0);
        let mut m = t.matrix(|i| self.anim.transform.get(i).copied().flatten());
        if let Some(extra) = extra {
            m = crate::transition::apply_extra(extra, m, h);
        }
        let o = self.style.transform_origin;
        let at = |len: nsh_core::geometry::DefiniteLength, side: f32| {
            len.to_points(
                nsh_core::geometry::AbsoluteLength::Points(Points(side)),
                nsh_core::geometry::REM_SIZE,
            )
            .0 as f64
        };
        let (ox, oy, oz) = (at(o.x, w), at(o.y, h), o.z.0 as f64);
        // To the origin, transform, and back (row vectors).
        Some(
            translation(-ox, -oy, -oz)
                .mul(&m)
                .mul(&translation(ox, oy, oz)),
        )
    }
}

/// A translation matrix (row vectors, as Core Animation).
pub(crate) fn translation(x: f64, y: f64, z: f64) -> Matrix {
    let mut m = Matrix::IDENTITY;
    (m.0[12], m.0[13], m.0[14]) = (x, y, z);
    m
}

/// Where `(x, y)` of the plane lands under row-vector transform `m` (`None` behind the viewer).
#[cfg(feature = "terminal")]
pub(crate) fn map_point(m: &Matrix, x: f32, y: f32) -> Option<(f32, f32)> {
    let m = &m.0;
    let (x, y) = (x as f64, y as f64);
    let w = x * m[3] + y * m[7] + m[15];
    if w <= 1e-6 {
        return None;
    }
    Some((
        ((x * m[0] + y * m[4] + m[12]) / w) as f32,
        ((x * m[1] + y * m[5] + m[13]) / w) as f32,
    ))
}

/// The axis-aligned bounds of `bounds` once mapped by `m`.
#[cfg(feature = "terminal")]
pub(crate) fn map_bounds(m: &Matrix, bounds: Bounds<Points>) -> Option<Bounds<Points>> {
    let (x, y) = (bounds.origin.x.0, bounds.origin.y.0);
    let (w, h) = (bounds.size.width.0, bounds.size.height.0);
    let mut min = (f32::MAX, f32::MAX);
    let mut max = (f32::MIN, f32::MIN);
    for (cx, cy) in [(x, y), (x + w, y), (x, y + h), (x + w, y + h)] {
        let (px, py) = map_point(m, cx, cy)?;
        min = (min.0.min(px), min.1.min(py));
        max = (max.0.max(px), max.1.max(py));
    }
    Some(Bounds::new(
        Point::new(Points(min.0), Points(min.1)),
        Size::new(Points(max.0 - min.0), Points(max.1 - min.1)),
    ))
}

/// `m` as a Core Animation matrix.
pub(crate) fn ca_transform(m: &Matrix) -> CATransform3D {
    let m = m.0;
    CATransform3D {
        m11: m[0],
        m12: m[1],
        m13: m[2],
        m14: m[3],
        m21: m[4],
        m22: m[5],
        m23: m[6],
        m24: m[7],
        m31: m[8],
        m32: m[9],
        m33: m[10],
        m34: m[11],
        m41: m[12],
        m42: m[13],
        m43: m[14],
        m44: m[15],
    }
}

/// The identity transform.
pub(crate) const IDENTITY: CATransform3D = CATransform3D {
    m11: 1.0,
    m12: 0.0,
    m13: 0.0,
    m14: 0.0,
    m21: 0.0,
    m22: 1.0,
    m23: 0.0,
    m24: 0.0,
    m31: 0.0,
    m32: 0.0,
    m33: 1.0,
    m34: 0.0,
    m41: 0.0,
    m42: 0.0,
    m43: 0.0,
    m44: 1.0,
};

/// A rectangle in points.
pub(crate) fn ns_rect(x: f32, y: f32, width: f32, height: f32) -> NSRect {
    CGRect::new(
        CGPoint::new(x as CGFloat, y as CGFloat),
        CGSize::new(width.max(0.0) as CGFloat, height.max(0.0) as CGFloat),
    )
}

/// Ivars of [`ViewObj`].
pub(crate) struct Ivars {
    state: RefCell<ViewState>,
    /// Holds the children (scroll views; views that clip their children
    /// and cast a shadow).
    container: RefCell<Option<Retained<Container>>>,
    /// The surface (root views only): mouse, keyboard and resizes go there.
    surface: RefCell<Weak<Surface>>,
    /// The surface whose window of the app's own (`Window.open`) this view
    /// is the root of: its mouse and keyboard go there, picked in this
    /// view ([`crate::input::enter`]); its resizes are the window's
    /// ([`crate::window`]).
    window: RefCell<Weak<Surface>>,
    /// Set once the root's tracking area is installed.
    tracking: Cell<bool>,
    /// Text and canvas views: the layer their content is drawn in
    /// ([`NshView::redraw`]), and its delegate.
    content: RefCell<Option<(Retained<CALayer>, Retained<Drawer>)>>,
    /// A canvas's small animated suffix, above its static content.
    overlay: RefCell<Option<(Retained<CALayer>, Retained<Drawer>)>>,
    /// Its content changed while it could not be seen
    /// ([`crate::mount::Mounter::draw_when_shown`]).
    stale: Cell<bool>,
    /// Its frame waits to be placed ([`crate::mount::Mounter`]'s `unplaced`).
    unplaced: Cell<bool>,
}

define_class!(
    /// Draws a text or canvas view's content into its content layer.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = objc2::rc::Weak<ViewObj>]
    #[name = "NshContentDrawer"]
    struct Drawer;

    unsafe impl NSObjectProtocol for Drawer {}

    unsafe impl CALayerDelegate for Drawer {
        #[unsafe(method(drawLayer:inContext:))]
        fn draw_layer(&self, layer: &CALayer, cx: &CGContext) {
            let Some(view) = self.ivars().load() else {
                return;
            };
            let Ok(state) = view.ivars().state.try_borrow() else {
                return;
            };
            let c = Some(cx);
            CGContext::save_g_state(c);
            // The layer's space, in points, is the context's base space:
            // y down where its contents are flipped.
            let mut base = CGAffineTransform {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                tx: 0.0,
                ty: 0.0,
            };
            if !layer.contentsAreFlipped() {
                // Drawing is top down, as in a flipped view.
                CGContext::translate_ctm(c, 0.0, layer.bounds().size.height);
                CGContext::scale_ctm(c, 1.0, -1.0);
                base.d = -1.0;
            }
            let asynchronous = layer.drawsAsynchronously();
            let overlay = view.ivars().overlay.borrow();
            let part = match overlay.as_ref() {
                Some((top, _)) if std::ptr::eq(&**top, layer) => crate::canvas::LayerPart::Suffix,
                Some(_) => crate::canvas::LayerPart::Prefix,
                None => crate::canvas::LayerPart::Whole { asynchronous },
            };
            if part == crate::canvas::LayerPart::Suffix {
                let origin = layer.frame().origin;
                CGContext::translate_ctm(c, -origin.x, -origin.y);
            } else {
                crate::text::draw(cx, &state);
            }
            // What Core Animation redraws (all of it, or a canvas's part
            // that animated values changed), top down.
            let dirty = CGContext::clip_bounding_box(c);
            let (size, scale) = (layer.bounds().size, layer.contentsScale());
            if crate::fps::measuring() && state.canvas.is_some() {
                let start = std::time::Instant::now();
                crate::canvas::draw(cx, &state, dirty, size, scale, base, part);
                crate::fps::drew_canvas(start.elapsed());
            } else {
                crate::canvas::draw(cx, &state, dirty, size, scale, base, part);
            }
            CGContext::restore_g_state(c);
            // Where the next paint happens (`canvas.rs`): Core Animation's
            // threads for a canvas painting often, at once for the rest.
            if let Some(canvas) = &state.canvas {
                let desired = part != crate::canvas::LayerPart::Suffix && canvas.draws_asynchronously();
                if desired != asynchronous {
                    layer.setDrawsAsynchronously(desired);
                }
            }
        }

        // Nothing nsh changes animates implicitly.
        #[unsafe(method_id(actionForLayer:forKey:))]
        fn action_for_layer(
            &self,
            _layer: &CALayer,
            _key: &objc2_foundation::NSString,
        ) -> Option<Retained<AnyObject>> {
            // SAFETY: `+[NSNull null]` returns the shared instance.
            unsafe { msg_send![objc2::class!(NSNull), null] }
        }
    }
);

define_class!(
    /// The AppKit class of [`NshView`].
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Ivars]
    #[name = "NshView"]
    pub(crate) struct ViewObj;

    unsafe impl NSObjectProtocol for ViewObj {}

    // SAFETY: AppKit invokes these SDK-typed callbacks on the main thread.
    unsafe impl NSDraggingDestination for ViewObj {
        #[unsafe(method(draggingEntered:))]
        fn dragging_entered(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> NSDragOperation {
            self.input_surface().map_or(NSDragOperation::None, |surface| {
                crate::file_drop::begin(&surface, sender)
            })
        }

        #[unsafe(method(draggingUpdated:))]
        fn dragging_updated(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> NSDragOperation {
            self.input_surface().map_or(NSDragOperation::None, |surface| {
                crate::file_drop::update(&surface, sender)
            })
        }

        #[unsafe(method(draggingExited:))]
        fn dragging_exited(&self, _sender: Option<&ProtocolObject<dyn NSDraggingInfo>>) {
            if let Some(surface) = self.input_surface() {
                crate::file_drop::clear(&surface);
            }
        }

        #[unsafe(method(prepareForDragOperation:))]
        fn prepare_drag(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> bool {
            self.input_surface().is_some_and(|surface| {
                crate::file_drop::update(&surface, sender) == NSDragOperation::Copy
            })
        }

        #[unsafe(method(performDragOperation:))]
        fn perform_drag(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> bool {
            self.input_surface().is_some_and(|surface| {
                crate::file_drop::perform(&surface, sender)
            })
        }

        #[unsafe(method(draggingEnded:))]
        fn dragging_ended(&self, _sender: &ProtocolObject<dyn NSDraggingInfo>) {
            if let Some(surface) = self.input_surface() {
                crate::file_drop::clear(&surface);
            }
        }
    }

    impl ViewObj {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method(wantsUpdateLayer))]
        fn wants_update_layer(&self) -> bool {
            // Text and canvas content is drawn in a layer of its own
            // ([`NshView::redraw`]): drawn by `drawRect:`, AppKit would
            // display every such view under a scroll view on every
            // scroll step (it invalidates them when their visible rect
            // changes, clipped or not).
            true
        }

        #[unsafe(method(updateLayer))]
        fn update_layer(&self) {}

        // AppKit sets a layer-backed view's layer geometry (anchor,
        // position, transform) from the view when it lays it out or
        // displays it: nsh's transforms would be gone after the first
        // display of a view whose transform does not animate.
        #[unsafe(method(layout))]
        fn layout(&self) {
            // SAFETY: NSView's own layout.
            unsafe { msg_send![super(self), layout] }
            NshView(self.retain()).set_layer_geometry();
        }

        #[unsafe(method(viewWillStartLiveResize))]
        fn view_will_start_live_resize(&self) {
            // SAFETY: NSView's own notification.
            unsafe { msg_send![super(self), viewWillStartLiveResize] }
            if let Some(surface) = self.ivars().surface.borrow().upgrade() {
                surface.live_resize(true);
            }
        }

        #[unsafe(method(viewDidEndLiveResize))]
        fn view_did_end_live_resize(&self) {
            // SAFETY: NSView's own notification.
            unsafe { msg_send![super(self), viewDidEndLiveResize] }
            if let Some(surface) = self.ivars().surface.borrow().upgrade() {
                surface.live_resize(false);
            }
        }

        #[unsafe(method(viewWillDraw))]
        fn view_will_draw(&self) {
            // SAFETY: NSView's own preparation (it displays the subviews).
            unsafe { msg_send![super(self), viewWillDraw] }
            NshView(self.retain()).set_layer_geometry();
        }

        #[unsafe(method_id(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> Option<Retained<NSView>> {
            // A press hit tests (and its hosted view converts it) with
            // AppKit's geometry: scroll offsets still shown as layer
            // transforms move into the bounds first.
            if let Some(surface) = self.input_surface()
                && pressing(self.mtm())
            {
                crate::scroll::commit_pending(&surface);
            }
            // SAFETY: NSView's own hit testing.
            let hit: Option<Retained<NSView>> = unsafe { msg_send![super(self), hitTest: point] };
            // The root takes every event over the app's own views and
            // picks the view itself (`crate::input`); hosted AppKit views
            // get theirs when nsh's picking lands on them. Not when
            // AppKit's does: it skips subviews outside their superview's
            // frame (an absolutely positioned menu over a web view),
            // ignores layer transforms and hidden layers, and reaches
            // views animating out or under `pointerEvents: "none"`.
            let root = self.ivars().surface.borrow().strong_count() > 0
                || self.ivars().window.borrow().strong_count() > 0;
            match hit {
                Some(_) if root => Some(self.root_hit(point)),
                other => other,
            }
        }

        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            true
        }

        #[unsafe(method(mouseDownCanMoveWindow))]
        fn mouse_down_can_move_window(&self) -> bool {
            // Under a hidden title bar AppKit would drag the window from a
            // view that is not opaque before it sees the press: nsh decides
            // (`windowDrag`, `crate::chrome`).
            false
        }

        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool {
            // A click outside a field that edits leaves the focus in it, as
            // desktop apps do (`blur()` and Escape still hand it over).
            let view = NshView(self.retain());
            (view.id() == ROOT_ID || crate::input::is_key_stop(&view))
                && self.keyboard_surface().is_some_and(|s| {
                    !(crate::text_input::editing(&s) && clicking(self.mtm()))
                })
        }

        #[unsafe(method(becomeFirstResponder))]
        fn become_first_responder(&self) -> bool {
            // SAFETY: NSView's standard responder transition.
            let accepted: bool = unsafe { msg_send![super(self), becomeFirstResponder] };
            if accepted && let Some(surface) = self.keyboard_surface() {
                let view = NshView(self.retain());
                crate::input::set_state(&surface, &view, nsh_core::tailwind::state::FOCUSED, true);
                // The stops Tab reaches report it, as inputs do.
                if view.id() != ROOT_ID {
                    surface.event(view.id(), nsh_core::EventKind::Focus, nsh_core::EventPayload::None);
                    crate::text_input::maybe_disarm(&surface);
                }
            }
            accepted
        }

        #[unsafe(method(resignFirstResponder))]
        fn resign_first_responder(&self) -> bool {
            // SAFETY: NSView's standard responder transition.
            let accepted: bool = unsafe { msg_send![super(self), resignFirstResponder] };
            if accepted && let Some(surface) = self.keyboard_surface() {
                let view = NshView(self.retain());
                crate::input::set_state(&surface, &view, nsh_core::tailwind::state::FOCUSED, false);
                // The stops Tab reaches report it, as inputs do.
                if view.id() != ROOT_ID {
                    surface.event(view.id(), nsh_core::EventKind::Blur, nsh_core::EventPayload::None);
                }
            }
            accepted
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            self.pointer(event);
        }

        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) {
            self.pointer(event);
        }

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, event: &NSEvent) {
            self.pointer(event);
        }

        #[unsafe(method(rightMouseDown:))]
        fn right_mouse_down(&self, event: &NSEvent) {
            self.pointer(event);
        }

        #[unsafe(method(rightMouseDragged:))]
        fn right_mouse_dragged(&self, event: &NSEvent) {
            self.pointer(event);
        }

        #[unsafe(method(rightMouseUp:))]
        fn right_mouse_up(&self, event: &NSEvent) {
            self.pointer(event);
        }

        #[unsafe(method(otherMouseDown:))]
        fn other_mouse_down(&self, event: &NSEvent) {
            self.pointer(event);
        }

        #[unsafe(method(otherMouseDragged:))]
        fn other_mouse_dragged(&self, event: &NSEvent) {
            self.pointer(event);
        }

        #[unsafe(method(otherMouseUp:))]
        fn other_mouse_up(&self, event: &NSEvent) {
            self.pointer(event);
        }

        #[unsafe(method(mouseMoved:))]
        fn mouse_moved(&self, event: &NSEvent) {
            self.pointer(event);
        }

        #[unsafe(method(mouseEntered:))]
        fn mouse_entered(&self, event: &NSEvent) {
            self.pointer(event);
        }

        #[unsafe(method(mouseExited:))]
        fn mouse_exited(&self, event: &NSEvent) {
            self.pointer(event);
        }

        // The root sets NSH's cursor; other views pass it up to it.
        #[unsafe(method(cursorUpdate:))]
        fn cursor_update(&self, event: &NSEvent) {
            match self.input_surface() {
                Some(surface) => crate::input::cursor_update(&surface),
                // SAFETY: NSView's own handling (passes it up).
                None => unsafe { msg_send![super(self), cursorUpdate: event] },
            }
        }

        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, event: &NSEvent) {
            match self.input_surface() {
                // Scrolls move views: a frame for the performance monitor.
                Some(surface) => surface.measure(true, || {
                    crate::input::event(&surface, event);
                    quiet(|| surface.revisit());
                }),
                // SAFETY: NSResponder's own handling (passes it up).
                None => unsafe { msg_send![super(self), scrollWheel: event] },
            }
        }

        #[unsafe(method(magnifyWithEvent:))]
        fn magnify(&self, event: &NSEvent) {
            self.pointer(event);
        }

        #[unsafe(method(rotateWithEvent:))]
        fn rotate(&self, event: &NSEvent) {
            self.pointer(event);
        }

        /// The Edit menu's Copy (Cmd+C): the selected text.
        #[unsafe(method(copy:))]
        fn copy(&self, _sender: Option<&AnyObject>) {
            if let Some(surface) = self.input_surface() {
                crate::text::copy(&surface);
            }
        }

        /// The Edit menu's Select All (Cmd+A): a selectable text's or a
        /// selectable view's.
        #[unsafe(method(selectAll:))]
        fn select_all(&self, _sender: Option<&AnyObject>) {
            if let Some(surface) = self.input_surface() {
                crate::text::select_all(&surface);
            }
        }

        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            let handled = self.keyboard_surface().is_some_and(|surface| {
                surface.measure(false, || {
                    let handled = crate::input::key(&surface, event, true)
                        || crate::keymap::unhandled(&surface, event);
                    // Keys scroll too.
                    quiet(|| surface.revisit());
                    handled
                })
            });
            if !handled {
                // SAFETY: NSResponder's own handling (beeps at the end).
                unsafe { msg_send![super(self), keyDown: event] }
            }
        }

        // `AXPress`: what accessibility clients press a button with.
        #[unsafe(method(accessibilityPerformPress))]
        fn accessibility_perform_press(&self) -> bool {
            self.keyboard_surface().is_some_and(|surface| {
                crate::input::accessibility_press(&surface, &NshView(self.retain()))
            })
        }

        // `AXShowMenu`: what accessibility clients open a context menu
        // with (VoiceOver's VO-Shift-M).
        #[unsafe(method(accessibilityPerformShowMenu))]
        fn accessibility_perform_show_menu(&self) -> bool {
            self.keyboard_surface().is_some_and(|surface| {
                crate::input::accessibility_show_menu(&surface, &NshView(self.retain()))
            })
        }

        // AppKit offers `AXPress` and `AXShowMenu` on every view that
        // implements them: only on the views they act on.
        #[unsafe(method(isAccessibilitySelectorAllowed:))]
        fn is_accessibility_selector_allowed(&self, selector: Sel) -> bool {
            if selector == sel!(accessibilityPerformPress) {
                self.ivars().state.try_borrow().is_ok()
                    && self.keyboard_surface().is_some_and(|surface| {
                        crate::input::takes_accessibility_press(&surface, &NshView(self.retain()))
                    })
            } else if selector == sel!(accessibilityPerformShowMenu) {
                self.ivars().state.try_borrow().is_ok()
                    && self.keyboard_surface().is_some_and(|surface| {
                        crate::input::takes_accessibility_show_menu(
                            &surface,
                            &NshView(self.retain()),
                        )
                    })
            } else if let Some(allowed) = crate::access::table::allows(&NshView(self.retain()), selector) {
                allowed
            } else {
                // SAFETY: NSView's own answer.
                unsafe { msg_send![super(self), isAccessibilitySelectorAllowed: selector] }
            }
        }

        #[unsafe(method(keyUp:))]
        fn key_up(&self, event: &NSEvent) {
            let handled = self
                .keyboard_surface()
                .is_some_and(|surface| crate::input::key(&surface, event, false));
            if !handled {
                // SAFETY: NSResponder's own handling.
                unsafe { msg_send![super(self), keyUp: event] }
            }
        }

        #[unsafe(method(setFrameSize:))]
        fn set_frame_size(&self, size: CGSize) {
            // SAFETY: NSView's own resize.
            unsafe { msg_send![super(self), setFrameSize: size] }
            // The root resized by its window or host (the rest also moves
            // in [`NshView::place`]).
            crate::sight::moved();
            if let Some(surface) = self.surface() {
                surface.resized(size.width as f32, size.height as f32);
            } else if let Some(surface) = self.ivars().window.borrow().upgrade() {
                crate::window::resized(&surface, &NshView(self.retain()));
            }
        }

        #[unsafe(method(accessibilityFrame))]
        fn accessibility_frame(&self) -> NSRect {
            crate::access::frame(self).unwrap_or_else(|| {
                // SAFETY: NSView's own geometry for an unattached view.
                unsafe { msg_send![super(self), accessibilityFrame] }
            })
        }

        // What VoiceOver reaches of the children ([`crate::access::reached`]).
        #[unsafe(method_id(accessibilityChildren))]
        fn accessibility_children(&self) -> Option<Retained<NSArray>> {
            let reached = self
                .ivars()
                .state
                .try_borrow()
                .map_or(crate::access::Reached::All, |s| crate::access::reached(&s));
            // SAFETY: NSView's own children.
            let all = || -> Option<Retained<NSArray>> {
                unsafe { msg_send![super(self), accessibilityChildren] }
            };
            match reached {
                crate::access::Reached::All => all(),
                crate::access::Reached::Controls => Some(crate::access::controls(all())),
                crate::access::Reached::None => Some(NSArray::new()),
            }
        }

        // Its label, else for a view that folds its content the texts in
        // it ([`crate::access::content_label`]).
        #[unsafe(method_id(accessibilityLabel))]
        fn accessibility_label(&self) -> Option<Retained<NSString>> {
            // SAFETY: NSView's own label, as `setAccessibilityLabel:` set it.
            let own: Option<Retained<NSString>> =
                unsafe { msg_send![super(self), accessibilityLabel] };
            own.or_else(|| {
                crate::access::content_label(&NshView(self.retain()))
                    .map(|name| NSString::from_str(&name))
            })
        }

        // Its value, else for static text that folds its content (an
        // option, a tree item) the texts in it
        // ([`crate::access::content_value`]).
        #[unsafe(method_id(accessibilityValue))]
        fn accessibility_value(&self) -> Option<Retained<AnyObject>> {
            // SAFETY: NSView's own value, as `setAccessibilityValue:` set it.
            let own: Option<Retained<AnyObject>> =
                unsafe { msg_send![super(self), accessibilityValue] };
            own.or_else(|| {
                crate::access::content_value(&NshView(self.retain()))
                    .map(|name| Retained::into_super(Retained::into_super(NSString::from_str(&name))))
            })
        }

        #[unsafe(method_id(accessibilityRows))]
        fn accessibility_rows(&self) -> Option<Retained<NSArray>> {
            crate::access::table::rows(&NshView(self.retain()))
                .map(|rows| crate::access::table::array(&rows))
        }

        #[unsafe(method_id(accessibilityVisibleRows))]
        fn accessibility_visible_rows(&self) -> Option<Retained<NSArray>> {
            crate::access::table::rows(&NshView(self.retain())).map(|rows| {
                crate::access::table::array(&rows.into_iter().filter(NshView::shown).collect::<Vec<_>>())
            })
        }

        #[unsafe(method_id(accessibilityColumns))]
        fn accessibility_columns(&self) -> Option<Retained<NSArray>> {
            crate::access::table::columns(&NshView(self.retain()), false)
        }

        #[unsafe(method_id(accessibilityVisibleColumns))]
        fn accessibility_visible_columns(&self) -> Option<Retained<NSArray>> {
            crate::access::table::columns(&NshView(self.retain()), true)
        }

        #[unsafe(method_id(accessibilityVisibleCells))]
        fn accessibility_visible_cells(&self) -> Option<Retained<NSArray>> {
            crate::access::table::visible_cells(&NshView(self.retain()))
        }

        #[unsafe(method_id(accessibilitySelectedRows))]
        fn accessibility_selected_rows(&self) -> Option<Retained<NSArray>> {
            crate::access::table::rows(&NshView(self.retain())).map(|rows| {
                crate::access::table::array(&rows.into_iter().filter(|r| r.ns().isAccessibilitySelected()).collect::<Vec<_>>())
            })
        }

        #[unsafe(method(accessibilityRowCount))]
        fn accessibility_row_count(&self) -> isize {
            crate::access::table::rows(&NshView(self.retain())).map_or(0, |r| r.len() as isize)
        }

        #[unsafe(method(accessibilityColumnCount))]
        fn accessibility_column_count(&self) -> isize {
            crate::access::table::column_count(&NshView(self.retain())) as isize
        }

        #[unsafe(method(accessibilityIndex))]
        fn accessibility_index(&self) -> isize {
            crate::access::table::row_index(&NshView(self.retain())).map_or(0, |i| i as isize)
        }

        #[unsafe(method(accessibilityRowIndexRange))]
        fn accessibility_row_index_range(&self) -> NSRange {
            crate::access::table::range(&NshView(self.retain()), false)
        }

        #[unsafe(method(accessibilityColumnIndexRange))]
        fn accessibility_column_index_range(&self) -> NSRange {
            crate::access::table::range(&NshView(self.retain()), true)
        }

        #[unsafe(method_id(accessibilityCellForColumn:row:))]
        fn accessibility_cell(&self, column: isize, row: isize) -> Option<Retained<AnyObject>> {
            crate::access::table::cell(&NshView(self.retain()), column, row)
                .map(|v| v.ns().retain().into_super().into_super().into_super())
        }

        #[unsafe(method_id(accessibilityHeader))]
        fn accessibility_header(&self) -> Option<Retained<AnyObject>> {
            crate::access::table::header(&NshView(self.retain()))
                .map(|v| v.ns().retain().into_super().into_super().into_super())
        }

        #[unsafe(method_id(accessibilityColumnHeaderUIElements))]
        fn accessibility_column_headers(&self) -> Option<Retained<NSArray>> {
            crate::access::table::headers(&NshView(self.retain()))
                .map(|headers| crate::access::table::array(&headers))
        }

        #[unsafe(method(viewDidMoveToSuperview))]
        fn view_did_move_to_superview(&self) {
            crate::sight::moved();
            // AppKit resets the layer's geometry when it attaches the
            // view: views placed before they were inserted lose their
            // transforms.
            NshView(self.retain()).set_layer_geometry();
        }

        #[unsafe(method(viewDidMoveToWindow))]
        fn view_did_move_to_window(&self) {
            crate::sight::moved();
            NshView(self.retain()).set_layer_geometry();
            NshView(self.retain()).rescale();
            if self.ivars().window.borrow().strong_count() > 0 {
                self.install_tracking();
            }
            if let Some(surface) = self.surface() {
                self.install_tracking();
                crate::system::window_changed(&surface);
                // What was mounted before the view was in a window was put
                // off: a host app may insert the view after its app's first
                // batches, and an idle surface has no frame to revisit at.
                if self.window().is_some() {
                    surface.revisit();
                }
            }
        }

        // Hidden or shown, itself or with an ancestor (AppKit tells every
        // view under it): what was out of sight under it may show.
        #[unsafe(method(viewDidHide))]
        fn view_did_hide(&self) {
            crate::sight::moved();
            // SAFETY: NSView's own handling.
            unsafe { msg_send![super(self), viewDidHide] }
        }

        #[unsafe(method(viewDidUnhide))]
        fn view_did_unhide(&self) {
            crate::sight::moved();
            // SAFETY: NSView's own handling.
            unsafe { msg_send![super(self), viewDidUnhide] }
            // What changed while it was hidden (a host app hides a view
            // scrolled out of sight) was put off; an idle surface has no
            // frame to revisit at.
            if let Some(surface) = self.surface() {
                surface.revisit();
            }
        }

        #[unsafe(method(viewDidChangeEffectiveAppearance))]
        fn view_did_change_effective_appearance(&self) {
            if let Some(surface) = self.surface() {
                crate::system::appearance_changed(&surface);
            }
        }

        #[unsafe(method(viewDidChangeBackingProperties))]
        fn view_did_change_backing_properties(&self) {
            NshView(self.retain()).rescale();
            if let Some(surface) = self.surface() {
                crate::system::window_changed(&surface);
            }
        }
    }
);

impl ViewObj {
    // Only the root stores a surface. A focused child (a Tab stop) uses its
    // ancestors for keyboard handling; drawing and pointer hooks stay root-only.
    fn keyboard_surface(&self) -> Option<std::rc::Rc<Surface>> {
        if let Some(surface) = self.input_surface() {
            return Some(surface);
        }
        let mut parent = superview(self);
        while let Some(view) = parent {
            if let Some(root) = view.downcast_ref::<ViewObj>()
                && let Some(surface) = root.input_surface()
            {
                return Some(surface);
            }
            parent = superview(&view);
        }
        None
    }

    fn surface(&self) -> Option<std::rc::Rc<Surface>> {
        self.ivars().surface.borrow().upgrade()
    }

    /// The surface an event reaching this view goes to, when it is a root:
    /// the surface's own, or a window of the app's own's
    /// ([`NshView::set_window_of`]). The surface's input then picks in this
    /// view's window ([`crate::input::enter`]).
    ///
    /// A window under a modal dialog of the app's own takes no input
    /// ([`crate::window::blocked`]).
    fn input_surface(&self) -> Option<std::rc::Rc<Surface>> {
        if let Some(surface) = self.surface() {
            if crate::window::blocked(&surface, None) {
                return None;
            }
            crate::input::enter(&surface, None);
            return Some(surface);
        }
        let surface = self.ivars().window.borrow().upgrade()?;
        let root = NshView(self.retain());
        if crate::window::blocked(&surface, Some(&root)) {
            return None;
        }
        crate::input::enter(&surface, Some(root));
        Some(surface)
    }

    /// What the root's `hitTest:` returns inside it: a hosted AppKit view
    /// nsh's picking lands on (past overlays that let the pointer
    /// through), else the root itself. `point` is in the root's
    /// superview's coordinates.
    fn root_hit(&self, point: NSPoint) -> Retained<NSView> {
        let me = || Retained::from(&**self);
        // A query AppKit makes at any time: it picks in this root and leaves
        // the input's window (`input::enter`) to the events. A window under
        // a modal dialog of the app's own hands nothing to its hosted views.
        let own = self.surface().is_none();
        let Some(surface) = self
            .surface()
            .or_else(|| self.ivars().window.borrow().upgrade())
        else {
            return me();
        };
        let root = NshView(self.retain());
        if crate::window::is_blocked(&surface, own.then_some(&root)) {
            return me();
        }
        let outer = superview(self);
        let p = self.convertPoint_fromView(point, outer.as_deref());
        let Some(native) = crate::input::native_at(&root, p.x as f32, p.y as f32) else {
            return me();
        };
        // A web view that does not scroll leaves wheels to the app's
        // scroll views (an embedded page in a scrolling screen).
        if scrolling(self.mtm()) && crate::native::passes_wheel(&surface, &native) {
            return me();
        }
        let Some(holder) = superview(&native) else {
            return me();
        };
        let q = holder.convertPoint_fromView(point, outer.as_deref());
        native.hitTest(q).unwrap_or_else(me)
    }

    fn pointer(&self, event: &NSEvent) {
        // Under `nsh test --target macos` the agent's mouse is the only
        // one: the user's (and the enters and exits AppKit derives from
        // where it really is) would change what a test hovers with where it
        // happens to rest, and a locked screen sends none.
        #[cfg(feature = "dev")]
        {
            let surface = self
                .surface()
                .or_else(|| self.ivars().window.borrow().upgrade());
            if surface.is_some_and(|s| s.testing())
                && scripted_type().is_none()
                && !crate::synth::from_agent(event)
            {
                return;
            }
        }
        if let Some(surface) = self.input_surface() {
            // Drags may scroll or pan (a frame for the performance
            // monitor); the rest changes the screen through the engine.
            let drag = matches!(
                event.r#type(),
                NSEventType::LeftMouseDragged
                    | NSEventType::RightMouseDragged
                    | NSEventType::OtherMouseDragged
            );
            surface.measure(drag, || {
                crate::input::event(&surface, event);
                if drag {
                    quiet(|| surface.revisit());
                }
            });
        }
    }

    /// Mouse moves, enters and exits over the root (hover, cursors).
    fn install_tracking(&self) {
        if self.ivars().tracking.replace(true) {
            return;
        }
        let options = NSTrackingAreaOptions::MouseMoved
            | NSTrackingAreaOptions::MouseEnteredAndExited
            | NSTrackingAreaOptions::ActiveAlways
            | NSTrackingAreaOptions::InVisibleRect;
        // SAFETY: the owner (this view) outlives the tracking area, which
        // it holds itself.
        let area = unsafe {
            NSTrackingArea::initWithRect_options_owner_userInfo(
                NSTrackingArea::alloc(),
                NSRect::ZERO,
                options,
                Some(self),
                None,
            )
        };
        self.addTrackingArea(&area);
    }
}

define_class!(
    /// Holds a view's children ([`NshView::container`]): flipped, the
    /// view's size, scrolled by its bounds origin.
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshContainer"]
    pub(crate) struct Container;

    unsafe impl NSObjectProtocol for Container {}

    impl Container {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method(wantsUpdateLayer))]
        fn wants_update_layer(&self) -> bool {
            true
        }

        #[unsafe(method(updateLayer))]
        fn update_layer(&self) {}
    }
);

/// Whether `view` is an app's view (or a container of one), as opposed to
/// a hosted AppKit view.
pub(crate) fn is_ours(view: &NSView) -> bool {
    view.downcast_ref::<ViewObj>().is_some()
        || view.downcast_ref::<Container>().is_some()
        || crate::visual::is_backdrop(view)
}

/// Whether the event AppKit handles is a mouse press.
fn clicking(mtm: MainThreadMarker) -> bool {
    use objc2_app_kit::{NSApplication, NSEventType};
    NSApplication::sharedApplication(mtm)
        .currentEvent()
        .is_some_and(|e| {
            matches!(
                e.r#type(),
                NSEventType::LeftMouseDown
                    | NSEventType::RightMouseDown
                    | NSEventType::OtherMouseDown
            )
        })
}

/// Whether the event AppKit handles (or the test agent hands the window)
/// is a mouse press.
fn pressing(mtm: MainThreadMarker) -> bool {
    scripted_type().map_or_else(
        || clicking(mtm),
        |t| {
            matches!(
                t,
                NSEventType::LeftMouseDown
                    | NSEventType::RightMouseDown
                    | NSEventType::OtherMouseDown
            )
        },
    )
}

/// Whether the event AppKit handles is a mouse wheel or trackpad scroll.
fn scrolling(mtm: MainThreadMarker) -> bool {
    scripted_type()
        .or_else(|| {
            objc2_app_kit::NSApplication::sharedApplication(mtm)
                .currentEvent()
                .map(|e| e.r#type())
        })
        .is_some_and(|t| t == NSEventType::ScrollWheel)
}

thread_local! {
    /// The event the test agent hands its window (`crate::synth`) while
    /// the window handles it: `sendEvent:` does not make it
    /// `NSApp.currentEvent`, which the root's `hitTest:` looks at.
    static SCRIPTED: RefCell<Option<Retained<NSEvent>>> = const { RefCell::new(None) };
}

/// The type of the event the test agent hands its window now.
fn scripted_type() -> Option<NSEventType> {
    SCRIPTED.with_borrow(|e| e.as_ref().map(|e| e.r#type()))
}

/// Runs `f` (which hands `event` to a window) with `event` as the one
/// AppKit handles, for the root's `hitTest:`.
#[cfg(any(feature = "dev", feature = "terminal", test))]
pub(crate) fn scripted<R>(event: &NSEvent, f: impl FnOnce() -> R) -> R {
    let old = SCRIPTED.replace(Some(event.retain()));
    let r = f();
    SCRIPTED.set(old);
    r
}

/// `view`'s superview.
pub(crate) fn superview(view: &NSView) -> Option<Retained<NSView>> {
    // SAFETY: a plain getter, on the main thread (views are main-thread
    // only); AppKit keeps the superview alive while `view` is in it.
    unsafe { view.superview() }
}

/// The innermost `NshView` at or containing `view`.
pub(crate) fn enclosing(view: &NSView) -> Option<NshView> {
    let mut current = Some(Retained::from(view));
    while let Some(ns) = current {
        if let Some(nsh) = NshView::from_ns(&ns) {
            return Some(nsh);
        }
        current = superview(&ns);
    }
    None
}

/// Makes `view` layer-backed with the policies every view of ours uses.
fn setup(view: &NSView) {
    view.setWantsLayer(true);
    view.setLayerContentsRedrawPolicy(NSViewLayerContentsRedrawPolicy::OnSetNeedsDisplay);
    if let Some(layer) = view.layer() {
        layer.setAnchorPoint(CGPoint::new(0.0, 0.0));
    }
}

/// The view of one node: a cheap handle (cloning retains).
#[derive(Clone)]
pub(crate) struct NshView(Retained<ViewObj>);

impl std::fmt::Debug for NshView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = self.state();
        write!(f, "NshView({} {:?})", s.id, s.kind)
    }
}

impl PartialEq for NshView {
    fn eq(&self, other: &Self) -> bool {
        std::ptr::eq(&*self.0, &*other.0)
    }
}

impl Eq for NshView {}

impl std::ops::Deref for NshView {
    type Target = ViewObj;

    fn deref(&self) -> &ViewObj {
        &self.0
    }
}

impl NshView {
    /// A new, detached view of node `id`.
    pub(crate) fn new(mtm: MainThreadMarker, id: NodeId, kind: ViewKind) -> Self {
        let obj = mtm.alloc::<ViewObj>().set_ivars(Ivars {
            state: RefCell::new(ViewState::new(id, kind)),
            container: RefCell::new(None),
            surface: RefCell::new(Weak::new()),
            window: RefCell::new(Weak::new()),
            tracking: Cell::new(false),
            content: RefCell::new(None),
            overlay: RefCell::new(None),
            stale: Cell::new(false),
            unplaced: Cell::new(false),
        });
        // SAFETY: NSView's designated initializer.
        let obj: Retained<ViewObj> = unsafe { msg_send![super(obj), initWithFrame: NSRect::ZERO] };
        setup(&obj);
        let view = NshView(obj);
        if kind == ViewKind::Scroll {
            view.ensure_container();
        }
        view
    }

    /// Makes this the root view of `surface`: it takes the surface's mouse
    /// and keyboard events and reports its size.
    pub(crate) fn set_surface(&self, surface: Weak<Surface>) {
        *self.ivars().surface.borrow_mut() = surface;
    }

    /// Makes this the root view of a window of `surface`'s app
    /// (`Window.open`; `Weak::new()` when it leaves it): it takes the
    /// window's mouse and keyboard events for the surface, and its resizes
    /// are reported as the window's ([`crate::window`]).
    pub(crate) fn set_window_of(&self, surface: Weak<Surface>) {
        *self.ivars().window.borrow_mut() = surface;
    }

    /// From an AppKit view of ours, if it is one.
    pub(crate) fn from_ns(view: &NSView) -> Option<NshView> {
        view.downcast_ref::<ViewObj>().map(|v| NshView(v.retain()))
    }

    /// The AppKit view.
    pub(crate) fn ns(&self) -> &NSView {
        &self.0
    }

    /// Its state.
    pub(crate) fn state(&self) -> Ref<'_, ViewState> {
        self.ivars().state.borrow()
    }

    /// Its state, to change. Call [`NshView::changed`] or
    /// [`NshView::moved`] afterwards.
    pub(crate) fn state_mut(&self) -> RefMut<'_, ViewState> {
        self.ivars().state.borrow_mut()
    }

    /// Its state, unless it is borrowed to change.
    pub(crate) fn try_state(&self) -> Option<Ref<'_, ViewState>> {
        self.ivars().state.try_borrow().ok()
    }

    /// Its state, to change, unless it is borrowed.
    pub(crate) fn try_state_mut(&self) -> Option<RefMut<'_, ViewState>> {
        self.ivars().state.try_borrow_mut().ok()
    }

    /// Node id.
    pub(crate) fn id(&self) -> NodeId {
        self.state().id
    }

    /// Kind.
    pub(crate) fn kind(&self) -> ViewKind {
        self.state().kind
    }

    /// The view that holds its children: its container, or itself.
    pub(crate) fn container(&self) -> Retained<NSView> {
        match &*self.ivars().container.borrow() {
            Some(c) => Retained::from(&**c),
            None => Retained::from(self.ns()),
        }
    }

    /// Its container, if it has one.
    pub(crate) fn container_view(&self) -> Option<Retained<NSView>> {
        self.ivars()
            .container
            .borrow()
            .as_ref()
            .map(|c| Retained::from(&**c))
    }

    /// Gives it a container (moving its children into it), if it has none.
    pub(crate) fn ensure_container(&self) -> Retained<NSView> {
        if let Some(c) = self.container_view() {
            return c;
        }
        let mtm = self.mtm();
        // SAFETY: NSView's designated initializer.
        let c: Retained<Container> =
            unsafe { msg_send![Container::alloc(mtm), initWithFrame: self.ns().bounds()] };
        setup(&c);
        let children = self.child_views();
        let first_native = self.ns().subviews().iter().find(|v| !is_ours(v));
        match first_native {
            Some(native) => self.ns().addSubview_positioned_relativeTo(
                &c,
                NSWindowOrderingMode::Below,
                Some(&native),
            ),
            None => self.ns().addSubview(&c),
        }
        for child in children {
            c.addSubview(child.ns());
        }
        *self.ivars().container.borrow_mut() = Some(c.clone());
        self.size_container();
        Retained::from(&*c as &NSView)
    }

    /// Sizes the container to the view's bounds.
    fn size_container(&self) {
        if let Some(c) = &*self.ivars().container.borrow() {
            let f = self.state().frame;
            let origin = crate::scroll::bounds_origin(self);
            c.setFrame(ns_rect(0.0, 0.0, f.size.width.0, f.size.height.0));
            c.setBoundsOrigin(NSPoint::new(origin.0 as CGFloat, origin.1 as CGFloat));
            if let Some(layer) = c.layer() {
                layer.setSublayerTransform(IDENTITY);
            }
        }
    }

    /// The origin of the container's bounds as AppKit has it: the last
    /// committed scroll offset, possibly stale while the offset shows as
    /// a layer transform.
    pub(crate) fn container_bounds_origin(&self) -> (f32, f32) {
        self.container_view().map_or((0.0, 0.0), |c| {
            let o = c.bounds().origin;
            (o.x as f32, o.y as f32)
        })
    }

    /// Shows the scroll offset by translating the container layer's
    /// sublayers `(dx, dy)` points: the pixels move without view geometry
    /// changing, so AppKit walks no descendant geometry (`setBoundsOrigin`
    /// invalidates every descendant's window geometry — focus, tracking
    /// areas, cursor rects — each scroll step, which is the scroll jank).
    /// [`NshView::commit_bounds_origin`] syncs the views once it settles.
    pub(crate) fn set_layer_scroll(&self, dx: f32, dy: f32) {
        let Some(layer) = self.container_view().and_then(|c| c.layer()) else {
            return;
        };
        let mut t = IDENTITY;
        t.m41 = dx as CGFloat;
        t.m42 = dy as CGFloat;
        layer.setSublayerTransform(t);
    }

    /// Commits the scroll offset to the container's bounds origin and
    /// drops the layer transform: a no-op visually (the transform carried
    /// exactly the committed-to-live difference), one subtree walk for
    /// AppKit to learn where things are; none when they are there.
    pub(crate) fn commit_bounds_origin(&self, x: f32, y: f32) {
        let c = self.ensure_container();
        let origin = NSPoint::new(x as CGFloat, y as CGFloat);
        if c.bounds().origin != origin {
            c.setBoundsOrigin(origin);
        }
        if let Some(layer) = c.layer() {
            layer.setSublayerTransform(IDENTITY);
        }
    }

    /// Invalidates the terminal capture for native visual work outside engine batches.
    #[cfg(feature = "terminal")]
    pub(crate) fn invalidate_capture(&self) {
        if let Some(surface) = self.0.keyboard_surface()
            && surface.terminal.get()
        {
            surface
                .capture_revision
                .set(surface.capture_revision.get().wrapping_add(1));
            let wake = surface.terminal_wake.borrow().clone();
            if let Some(wake) = wake {
                wake();
            }
        }
    }

    /// Something it draws changed: content (text, canvas) is drawn again
    /// and the decoration applied again.
    pub(crate) fn changed(&self) {
        self.restyle();
        self.redraw();
        crate::shader::ui_changed(self);
    }

    /// Its style changed: the decoration is applied again (the content is
    /// drawn again separately, [`NshView::redraw`]).
    pub(crate) fn restyle(&self) {
        // Opacity is the layer's (an animated one changes without a move).
        if let Some(layer) = self.ns().layer() {
            layer.setOpacity(self.state().opacity().clamp(0.0, 1.0));
        }
        crate::decor::apply(self);
    }

    /// Marks its content as changed out of sight (or not); whether that
    /// changed the mark.
    pub(crate) fn set_stale(&self, stale: bool) -> bool {
        self.ivars().stale.replace(stale) != stale
    }

    /// Whether its content changed out of sight and waits to show
    /// ([`crate::mount::Mounter::draw_when_shown`]).
    pub(crate) fn is_stale(&self) -> bool {
        self.ivars().stale.get()
    }

    /// Marks whether its frame waits to be placed; true if that changed.
    pub(crate) fn set_unplaced(&self, unplaced: bool) -> bool {
        self.ivars().unplaced.replace(unplaced) != unplaced
    }

    /// Draws its content (text, canvas) again, if it draws any.
    pub(crate) fn redraw(&self) {
        // A view that stopped drawing clears what it drew.
        if !self.state().draws() && self.ivars().content.borrow().is_none() {
            return;
        }
        if let Some(layer) = self.content_layer() {
            self.update_canvas_overlay();
            layer.setNeedsDisplay();
        }
    }

    /// Updates the small animated surface and reports a partition change.
    fn update_canvas_overlay(&self) -> bool {
        let bounds = self
            .state()
            .canvas
            .as_ref()
            .and_then(|canvas| canvas.layer_bounds(self.ns().frame().size));
        let mut overlay = self.ivars().overlay.borrow_mut();
        let Some(bounds) = bounds else {
            if let Some((layer, _)) = overlay.take() {
                layer.removeFromSuperlayer();
                return true;
            }
            return false;
        };
        let changed = overlay.is_none();
        if changed {
            let Some(host) = self.ns().layer() else {
                return false;
            };
            let mtm = MainThreadMarker::from(&*self.0);
            let drawer = mtm
                .alloc::<Drawer>()
                .set_ivars(objc2::rc::Weak::from_retained(&self.0));
            // SAFETY: NSObject's initializer.
            let drawer: Retained<Drawer> = unsafe { msg_send![super(drawer), init] };
            let layer = CALayer::new();
            layer.setDelegate(Some(objc2::runtime::ProtocolObject::from_ref(&*drawer)));
            layer.setAnchorPoint(CGPoint::new(0.0, 0.0));
            layer.setContentsScale(self.backing_scale());
            layer.setZPosition(crate::decor::BEHIND / 4.0);
            host.addSublayer(&layer);
            *overlay = Some((layer, drawer));
        }
        if let Some((layer, _)) = &*overlay {
            if layer.frame() != bounds {
                layer.setFrame(bounds);
            }
            layer.setNeedsDisplay();
        }
        changed
    }

    /// The layer its content is drawn in (made on first use).
    fn content_layer(&self) -> Option<Retained<CALayer>> {
        if let Some((layer, _)) = &*self.ivars().content.borrow() {
            return Some(layer.clone());
        }
        let host = self.ns().layer()?;
        let mtm = MainThreadMarker::from(&*self.0);
        let drawer = mtm
            .alloc::<Drawer>()
            .set_ivars(objc2::rc::Weak::from_retained(&self.0));
        // SAFETY: NSObject's initializer.
        let drawer: Retained<Drawer> = unsafe { msg_send![super(drawer), init] };
        let layer = CALayer::new();
        layer.setDelegate(Some(objc2::runtime::ProtocolObject::from_ref(&*drawer)));
        layer.setAnchorPoint(CGPoint::new(0.0, 0.0));
        // Drawn at once: text is cheap to draw, which measured faster than
        // asynchronously, and a canvas moves to Core Animation's threads
        // once it paints often (`canvas.rs`; paths and gradients are
        // costly: on the Stocks demo main-thread time per frame went from
        // 3.5 to 1.8 ms).
        layer.setDrawsAsynchronously(false);
        // A text keeps its picture through another width of the same lines:
        // never stretched. The rest draw again at their new size.
        if self.state().text.is_some() {
            layer.setContentsGravity(unsafe { kCAGravityTopLeft });
        }
        layer.setContentsScale(self.backing_scale());
        // Above the decoration behind it (fills, gradients, inset
        // shadows), below the children and the borders in front.
        layer.setZPosition(crate::decor::BEHIND / 2.0);
        let size = self.ns().frame().size;
        layer.setFrame(CGRect::new(CGPoint::new(0.0, 0.0), size));
        host.addSublayer(&layer);
        *self.ivars().content.borrow_mut() = Some((layer.clone(), drawer));
        Some(layer)
    }

    /// Its content layer got a new size: drawn again when it can be seen.
    /// A window's resize gives a new size to every text of a long page, and
    /// Core Animation draws each layer marked (`needsDisplayOnBoundsChange`
    /// did) wherever it is, seen or not.
    fn content_resized(&self) {
        if self.is_stale() {
            return;
        }
        let mut top = self.clone();
        while let Some(parent) = top.parent_view() {
            top = parent;
        }
        match top.ivars().surface.borrow().upgrade() {
            Some(surface) => {
                self.set_stale(true);
                surface.draw_when_shown(self.clone());
            }
            // Out of the tree: Core Animation draws a marked layer once it
            // is in one.
            None => self.redraw(),
        }
    }

    /// The scale of its window's backing (2 before it has one).
    pub(crate) fn backing_scale(&self) -> CGFloat {
        if let Some(surface) = self.0.keyboard_surface()
            && surface.terminal.get()
        {
            return surface.terminal_scale.get() as CGFloat;
        }
        self.ns().window().map_or(2.0, |w| w.backingScaleFactor())
    }

    /// Its window or screen changed: the content layer draws at the new
    /// scale.
    fn rescale(&self) {
        for surface in [&self.ivars().content, &self.ivars().overlay] {
            if let Some((layer, _)) = &*surface.borrow() {
                let scale = self.backing_scale();
                if layer.contentsScale() != scale {
                    layer.setContentsScale(scale);
                    layer.setNeedsDisplay();
                }
            }
        }
    }

    /// Part of what it draws changed (`rect`, in its own coordinates, y
    /// down): only that is drawn again (a canvas's animated values).
    pub(crate) fn redraw_rect(&self, rect: nsh_core::Bounds<nsh_core::Points>) {
        crate::shader::ui_changed(self);
        let Some(layer) = self.content_layer() else {
            return;
        };
        let changed = self.update_canvas_overlay();
        if changed {
            layer.setNeedsDisplay();
        }
        if self.ivars().overlay.borrow().is_some() || changed {
            return;
        }
        // Layer space is y up unless its contents are flipped
        // (`drawLayer:inContext:` flips the drawing the same way).
        let y = if layer.contentsAreFlipped() {
            rect.origin.y.0 as CGFloat
        } else {
            layer.bounds().size.height - (rect.origin.y.0 + rect.size.height.0) as CGFloat
        };
        layer.setNeedsDisplayInRect(CGRect::new(
            CGPoint::new(rect.origin.x.0 as CGFloat, y),
            CGSize::new(rect.size.width.0 as CGFloat, rect.size.height.0 as CGFloat),
        ));
    }

    /// Whether any of it can be seen: in a window, not hidden, and not
    /// entirely clipped away by its ancestors (a list row out of sight).
    /// Only ancestors that clip their children (`overflow: hidden`, scroll
    /// views, stacks, ...) and the root (the window shows only it) cut it
    /// off: what overflows any other ancestor shows, as in CSS (a label
    /// centered on a zero-width anchor).
    pub(crate) fn shown(&self) -> bool {
        thread_local! {
            /// Kept for its allocations: animated canvases in sight ask on
            /// every frame.
            static SIGHTS: RefCell<crate::sight::Sights<NshView>> = RefCell::default();
        }
        SIGHTS.with(|sights| match sights.try_borrow_mut() {
            Ok(mut sights) => {
                sights.clear();
                let shown = sights.shows(&Views, self);
                sights.clear();
                shown
            }
            Err(_) => crate::sight::Sights::default().shows(&Views, self),
        })
    }

    /// Its frame, transform or shift changed: places it again.
    pub(crate) fn moved(&self) {
        self.place();
        crate::decor::apply(self);
        crate::shader::ui_changed(self);
    }

    /// Where its frame puts it, with its parent's mirroring and its shift.
    fn placed_rect(&self) -> NSRect {
        let mirror = self.parent_view().and_then(|p| {
            let s = p.state();
            s.scroll
                .as_ref()
                .is_some_and(|sc| sc.mirrored)
                .then_some(s.frame.size.width.0)
        });
        let s = self.state();
        let f = s.frame;
        let mut x = f.origin.x.0 + s.shift.0;
        if let Some(w) = mirror {
            x = w - x - f.size.width.0;
        }
        let y = f.origin.y.0 + s.shift.1;
        ns_rect(x, y, f.size.width.0, f.size.height.0)
    }

    /// Places the view at its frame (with its parent's mirroring and its
    /// shift) and sets its layer's transform, opacity and visibility.
    pub(crate) fn place(&self) {
        let rect = self.placed_rect();
        let root = {
            let s = self.state();
            s.id == ROOT_ID && self.ivars().surface.borrow().strong_count() > 0
        };
        if !root && self.ns().frame() != rect {
            self.ns().setFrame(rect);
            // A transform or opacity alone (an endless animation) does
            // not count: views out of sight stay so ([`crate::sight`]).
            crate::sight::moved();
            self.size_container();
            crate::native::resized(self);
            self.place_natives();
            let resized = self
                .ivars()
                .content
                .borrow()
                .as_ref()
                .is_some_and(|(layer, _)| {
                    let resized = layer.bounds().size != rect.size;
                    layer.setFrame(CGRect::new(CGPoint::new(0.0, 0.0), rect.size));
                    resized
                });
            // A text's box changes with its own `MountItem::Text`, which
            // says whether it draws again, unless its picture was cut.
            let keeps = self.state().text.as_ref().is_some_and(|t| !t.cut.get());
            if resized && !keeps {
                self.content_resized();
            }
        }
        self.set_layer_geometry();
    }

    /// Sets the layer's anchor, position, transform, opacity and
    /// visibility from the view's frame and state. AppKit sets a
    /// layer-backed view's anchor, position and transform when it moves the
    /// view or attaches it: this runs again after each.
    fn set_layer_geometry(&self) {
        let Some(layer) = self.ns().layer() else {
            return;
        };
        let (transform, opacity, hidden) = {
            // AppKit may attach the view while its state is being changed
            // (mounting): that change places it again.
            let Ok(s) = self.0.ivars().state.try_borrow() else {
                return;
            };
            (
                s.transform(),
                s.opacity(),
                // A hidden NSView (a screen under the top one) keeps its
                // layer hidden too.
                s.style.hidden || crate::decor::backface_away(&s) || self.ns().isHidden(),
            )
        };
        layer.setAnchorPoint(CGPoint::new(0.0, 0.0));
        layer.setPosition(self.ns().frame().origin);
        let t = transform.as_ref().map_or(IDENTITY, ca_transform);
        layer.setTransform(t);
        layer.setOpacity(opacity.clamp(0.0, 1.0));
        layer.setHidden(hidden);
    }

    /// Hosted native views at their rectangles.
    fn place_natives(&self) {
        let natives = self.state().natives.clone();
        for n in natives {
            let r = n.rect;
            n.view.setFrame(ns_rect(
                r.origin.x.0,
                r.origin.y.0,
                r.size.width.0,
                r.size.height.0,
            ));
        }
    }

    /// The view's parent view, if it is attached to one.
    pub(crate) fn parent_view(&self) -> Option<NshView> {
        let mut sup = superview(self.ns())?;
        if sup.downcast_ref::<Container>().is_some() {
            sup = superview(&sup)?;
        }
        NshView::from_ns(&sup)
    }

    /// Whether it is in a parent view.
    pub(crate) fn has_parent(&self) -> bool {
        superview(self.ns()).is_some()
    }

    /// Its child views, bottom to top.
    pub(crate) fn child_views(&self) -> Vec<NshView> {
        self.container()
            .subviews()
            .iter()
            .filter_map(|v| NshView::from_ns(&v))
            .collect()
    }

    /// Inserts it into `parent` below `before` (on top of the other
    /// children without one; hosted native views stay above).
    pub(crate) fn insert_before(&self, parent: &NshView, before: Option<&NshView>) {
        let container = parent.container();
        let above = before
            .map(|b| Retained::from(b.ns()))
            .or_else(|| container.subviews().iter().find(|v| !is_ours(v)));
        match above {
            Some(above) => container.addSubview_positioned_relativeTo(
                self.ns(),
                NSWindowOrderingMode::Below,
                Some(&above),
            ),
            None => container.addSubview(self.ns()),
        }
        self.place();
    }

    /// Takes it out of its parent.
    pub(crate) fn unparent(&self) {
        self.ns().removeFromSuperview();
    }

    /// Hosts `view` at `rect` (or moves it there).
    pub(crate) fn set_native(&self, view: &NSView, rect: Bounds<Points>) {
        {
            let mut s = self.state_mut();
            match s.natives.iter_mut().find(|n| &*n.view == view) {
                Some(n) => n.rect = rect,
                None => s.natives.push(Native {
                    view: Retained::from(view),
                    rect,
                }),
            }
        }
        if superview(view).as_deref() != Some(self.ns()) {
            self.ns().addSubview(view);
        }
        view.setFrame(ns_rect(
            rect.origin.x.0,
            rect.origin.y.0,
            rect.size.width.0,
            rect.size.height.0,
        ));
    }

    /// Stops hosting `view`.
    pub(crate) fn remove_native(&self, view: &NSView) {
        self.state_mut().natives.retain(|n| &*n.view != view);
        if superview(view).as_deref() == Some(self.ns()) {
            view.removeFromSuperview();
        }
    }

    /// Whether this view itself is hidden (`NSView` hidden or `style.hidden`).
    pub(crate) fn is_hidden(&self) -> bool {
        self.ns().isHidden() || self.try_state().is_none_or(|s| s.style.hidden)
    }

    /// Whether this view is attached to a window with no hidden `NSView` or
    /// `style.hidden` ancestor.
    pub(crate) fn is_shown_in_tree(&self) -> bool {
        let ns = self.ns();
        if ns.window().is_none() || ns.isHiddenOrHasHiddenAncestor() {
            return false;
        }
        let mut at = Some(self.clone());
        while let Some(v) = at {
            if v.try_state().is_none_or(|s| s.style.hidden) {
                return false;
            }
            at = v.parent_view();
        }
        true
    }

    /// Whether the pointer may target it (`pointerEvents` and visibility).
    pub(crate) fn can_target(&self) -> bool {
        let Some(s) = self.try_state() else {
            return false;
        };
        !s.style.hidden
            && !matches!(s.props.pointer_events, PointerEvents::None)
            // Animating out (`LayoutAnimation`): already gone for input.
            && !s.live.as_ref().is_some_and(|l| l.dying())
            // A screen under the top one, a modal leaving.
            && !self.ns().isHidden()
    }

    /// Whether input and keyboard focus can reach `self` through its ancestors.
    pub(crate) fn can_reach(&self) -> bool {
        let ns = self.ns();
        if ns.window().is_none() || ns.isHiddenOrHasHiddenAncestor() {
            return false;
        }
        // An input's own `none` / `box-none` lets presses through to what it
        // covers (Editor and RichEditor's caret sink); its keyboard focus does
        // not depend on it.
        if self.try_state().is_none_or(|s| {
            s.style.hidden
                || s.live.as_ref().is_some_and(|l| l.dying())
                || (s.kind != ViewKind::Input
                    && matches!(
                        s.props.pointer_events,
                        PointerEvents::None | PointerEvents::BoxNone
                    ))
        }) {
            return false;
        }
        let mut parent = self.parent_view();
        while let Some(ancestor) = parent {
            if !ancestor.can_target()
                || ancestor
                    .try_state()
                    .is_none_or(|s| s.props.pointer_events == PointerEvents::BoxOnly)
            {
                return false;
            }
            parent = ancestor.parent_view();
        }
        true
    }

    fn local_to_parent(&self, parent: &NshView) -> Option<Matrix> {
        let origin = self.ns().frame().origin;
        let offset =
            if superview(self.ns()).is_some_and(|sup| sup.downcast_ref::<Container>().is_some()) {
                crate::scroll::bounds_origin(parent)
            } else {
                (0.0, 0.0)
            };
        let step = translation(origin.x - offset.0 as f64, origin.y - offset.1 as f64, 0.0);
        let transform = self.try_state()?.transform();
        Some(match transform {
            Some(t) => t.mul(&step),
            None => step,
        })
    }

    /// Transform from this view's coordinates to `root`'s (points).
    pub(crate) fn to_root(&self, root: &NshView) -> Option<Matrix> {
        let mut m = Matrix::IDENTITY;
        let mut view = self.clone();
        while view != *root {
            let parent = view.parent_view()?;
            let local = view.local_to_parent(&parent)?;
            m = m.mul(&local);
            view = parent;
        }
        Some(m)
    }

    /// The axis-aligned box of this view (in its own coordinates) left in sight
    /// by clipping ancestors below the surface root.
    #[cfg(feature = "terminal")]
    pub(crate) fn visible_bounds(&self) -> Bounds<Points> {
        let size = self.ns().bounds().size;
        let (w, h) = (size.width as f32, size.height as f32);
        let full = Bounds::new(Point::default(), Size::new(Points(w), Points(h)));
        let (mut left, mut top) = (0.0f32, 0.0f32);
        let (mut right, mut bottom) = (w, h);
        let mut m = Matrix::IDENTITY;
        let mut view = self.clone();
        while let Some(parent) = view.parent_view() {
            let Some(local) = view.local_to_parent(&parent) else {
                return full;
            };
            m = m.mul(&local);
            let clip = parent.try_state().and_then(|p| {
                (p.id != ROOT_ID && p.clips()).then(|| {
                    let ps = parent.ns().bounds().size;
                    (ps.width as f32, ps.height as f32)
                })
            });
            if let Some((cw, ch)) = clip {
                let mut min = (f32::MAX, f32::MAX);
                let mut max = (f32::MIN, f32::MIN);
                for (cx, cy) in [(0.0, 0.0), (cw, 0.0), (0.0, ch), (cw, ch)] {
                    let Some((x, y)) = crate::input::unproject(&m, (cx, cy))
                        .filter(|&(px, py)| map_point(&m, px, py).is_some())
                    else {
                        return full;
                    };
                    min = (min.0.min(x), min.1.min(y));
                    max = (max.0.max(x), max.1.max(y));
                }
                left = left.max(min.0);
                top = top.max(min.1);
                right = right.min(max.0);
                bottom = bottom.min(max.1);
            }
            view = parent;
        }
        Bounds::new(
            Point::new(Points(left), Points(top)),
            Size::new(
                Points((right - left).max(0.0)),
                Points((bottom - top).max(0.0)),
            ),
        )
    }

    /// An object for `msg_send!` calls AppKit's bindings lack.
    #[allow(dead_code)]
    pub(crate) fn as_object(&self) -> &AnyObject {
        let view: &NSView = self.ns();
        view.as_ref()
    }
}

/// The views as [`crate::sight`] reads them ([`NshView::shown`],
/// [`crate::mount::Mounter::revisit`]).
///
/// `visibleRect` follows the bounds as AppKit has them committed; while a
/// scroll offset shows as a layer transform the truth is the scroll state,
/// so each ancestor's content shows from its scroll-state origin
/// ([`crate::scroll::bounds_origin`]; a plain view's is (0, 0)). Ancestor
/// transforms are not applied: nearly all are identity, and a transformed
/// clip at most defers or draws early. Frames are the placed ones
/// (`ns().frame()`: a sticky shift and mirroring applied), not the logical
/// ones, for the view and its ancestors alike: the clip spaces are the
/// ancestors' containers'. Hidden views are AppKit's (a screen under the
/// top one) or `style.hidden`, looked at once per view a pass resolves; the
/// containers between a view and its parent are never hidden.
pub(crate) struct Views;

impl crate::sight::Tree for Views {
    type Node = NshView;

    fn key(&self, node: &NshView) -> usize {
        Retained::as_ptr(&node.0) as usize
    }

    fn parent(&self, node: &NshView) -> Option<NshView> {
        node.parent_view()
    }

    fn hidden(&self, node: &NshView) -> bool {
        node.is_hidden()
    }

    fn top_shown(&self, node: &NshView) -> bool {
        let ns = node.ns();
        ns.window().is_some() && !ns.isHiddenOrHasHiddenAncestor() && !node.is_hidden()
    }

    fn frame(&self, node: &NshView) -> crate::sight::Span {
        crate::sight::placed(node.ns().frame())
    }

    fn content(&self, node: &NshView) -> ((f32, f32), bool) {
        let clips = {
            let s = node.state();
            s.clips() || s.id == ROOT_ID
        };
        (crate::scroll::bounds_origin(node), clips)
    }
}

/// [`Views`] with the frames the layout gave, placed or not: what can be
/// seen once the views waiting to be placed are ([`crate::mount::Mounter`]).
pub(crate) struct Planned;

impl crate::sight::Tree for Planned {
    type Node = NshView;

    fn key(&self, node: &NshView) -> usize {
        Views.key(node)
    }

    fn parent(&self, node: &NshView) -> Option<NshView> {
        Views.parent(node)
    }

    fn hidden(&self, node: &NshView) -> bool {
        Views.hidden(node)
    }

    fn top_shown(&self, node: &NshView) -> bool {
        Views.top_shown(node)
    }

    fn frame(&self, node: &NshView) -> crate::sight::Span {
        // A running layout animation shows its in-between frame.
        if node.state().live.is_some() || node.state().id == ROOT_ID {
            return Views.frame(node);
        }
        crate::sight::placed(node.placed_rect())
    }

    fn content(&self, node: &NshView) -> ((f32, f32), bool) {
        Views.content(node)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripted_wheels_are_the_event_handled() {
        use objc2_core_graphics::{CGEvent, CGScrollEventUnit};
        let cg =
            CGEvent::new_scroll_wheel_event2(None, CGScrollEventUnit::Pixel, 1, -3, 0, 0).unwrap();
        let wheel = NSEvent::eventWithCGEvent(&cg).unwrap();
        assert_eq!(scripted_type(), None);
        let inside = scripted(&wheel, scripted_type);
        assert_eq!(inside, Some(NSEventType::ScrollWheel));
        assert_eq!(scripted_type(), None);
    }
}
