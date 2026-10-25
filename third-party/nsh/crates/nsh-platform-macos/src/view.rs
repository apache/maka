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
//! ([`crate::decor`]). Text and canvas drawings are drawn into the layer by
//! `drawRect:` (CoreText / Core Graphics); other views use `updateLayer`
//! and get no backing store.
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
use objc2::{
    AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, ProtocolObject},
};
use objc2_app_kit::{
    NSDragOperation, NSDraggingDestination, NSDraggingInfo, NSEvent, NSEventType, NSResponder,
    NSTrackingArea, NSTrackingAreaOptions, NSView, NSViewLayerContentsRedrawPolicy,
    NSWindowOrderingMode,
};
use objc2_core_foundation::{CGFloat, CGPoint, CGRect, CGSize};
use objc2_core_graphics::CGContext;
use objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSPoint, NSRect};
use objc2_quartz_core::{CALayer, CALayerDelegate, CATransform3D};

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
    pub(crate) tracked: u8,
    /// Current interaction states (pressed, hovered, focused).
    pub(crate) states: u8,
    /// Extra translation (sticky list cells, screen transitions).
    pub(crate) shift: (f32, f32),
    /// Extra opacity (screen and modal transitions).
    pub(crate) fade: f32,
    /// Scroll state (scroll views).
    pub(crate) scroll: Option<ScrollState>,
    /// Text content (text views).
    pub(crate) text: Option<crate::text::DrawnText>,
    /// Image content (image views).
    pub(crate) image: Option<crate::image::ImageState>,
    /// Canvas content.
    pub(crate) canvas: Option<crate::canvas::CanvasState>,
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
            scroll: matches!(kind, ViewKind::Scroll).then(ScrollState::default),
            text: None,
            image: None,
            canvas: None,
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

    /// Its shadow, with animated color, opacity and radius.
    pub(crate) fn shadow(&self) -> nsh_core::Shadow {
        let mut s = self.style.shadow;
        let a = &self.anim;
        s.color = a.shadow_color.unwrap_or(s.color);
        s.opacity = a.shadow_opacity.unwrap_or(s.opacity);
        s.radius = a.shadow_radius.unwrap_or(s.radius);
        s
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

    /// True if it draws content with `drawRect:` (text, canvas).
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
    /// Set once the root's tracking area is installed.
    tracking: Cell<bool>,
    /// Text and canvas views: the layer their content is drawn in
    /// ([`NshView::redraw`]), and its delegate.
    content: RefCell<Option<(Retained<CALayer>, Retained<Drawer>)>>,
    /// Its content changed while it could not be seen
    /// ([`crate::mount::Mounter::draw_when_shown`]).
    stale: Cell<bool>,
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
            if !layer.contentsAreFlipped() {
                // Drawing is top down, as in a flipped view.
                CGContext::translate_ctm(c, 0.0, layer.bounds().size.height);
                CGContext::scale_ctm(c, 1.0, -1.0);
            }
            crate::text::draw(cx, &state);
            // What Core Animation redraws (all of it, or a canvas's part
            // that animated values changed), top down.
            let dirty = CGContext::clip_bounding_box(c);
            let (size, scale) = (layer.bounds().size, layer.contentsScale());
            let asynchronous = layer.drawsAsynchronously();
            if crate::fps::measuring() && state.canvas.is_some() {
                let start = std::time::Instant::now();
                crate::canvas::draw(cx, &state, dirty, size, scale, asynchronous);
                crate::fps::drew_canvas(start.elapsed());
            } else {
                crate::canvas::draw(cx, &state, dirty, size, scale, asynchronous);
            }
            CGContext::restore_g_state(c);
            // Where the next paint happens (`canvas.rs`): Core Animation's
            // threads for a canvas painting often, at once for the rest.
            if let Some(canvas) = &state.canvas
                && canvas.draws_asynchronously() != asynchronous
            {
                layer.setDrawsAsynchronously(!asynchronous);
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
            self.ivars().surface.borrow().upgrade().map_or(NSDragOperation::None, |surface| {
                crate::file_drop::begin(&surface, sender)
            })
        }

        #[unsafe(method(draggingUpdated:))]
        fn dragging_updated(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> NSDragOperation {
            self.ivars().surface.borrow().upgrade().map_or(NSDragOperation::None, |surface| {
                crate::file_drop::update(&surface, sender)
            })
        }

        #[unsafe(method(draggingExited:))]
        fn dragging_exited(&self, _sender: Option<&ProtocolObject<dyn NSDraggingInfo>>) {
            if let Some(surface) = self.ivars().surface.borrow().upgrade() {
                crate::file_drop::clear(&surface);
            }
        }

        #[unsafe(method(prepareForDragOperation:))]
        fn prepare_drag(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> bool {
            self.ivars().surface.borrow().upgrade().is_some_and(|surface| {
                crate::file_drop::update(&surface, sender) == NSDragOperation::Copy
            })
        }

        #[unsafe(method(performDragOperation:))]
        fn perform_drag(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> bool {
            self.ivars().surface.borrow().upgrade().is_some_and(|surface| {
                crate::file_drop::perform(&surface, sender)
            })
        }

        #[unsafe(method(draggingEnded:))]
        fn dragging_ended(&self, _sender: &ProtocolObject<dyn NSDraggingInfo>) {
            if let Some(surface) = self.ivars().surface.borrow().upgrade() {
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
            if let Some(surface) = self.surface()
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
            let root = self.ivars().surface.borrow().strong_count() > 0;
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
            (view.id() == ROOT_ID || crate::input::is_key_control(&view))
                && self.keyboard_surface().is_some_and(|s| {
                    !(crate::text_input::editing(&s) && clicking(self.mtm()))
                })
        }

        #[unsafe(method(becomeFirstResponder))]
        fn become_first_responder(&self) -> bool {
            // SAFETY: NSView's standard responder transition.
            let accepted: bool = unsafe { msg_send![super(self), becomeFirstResponder] };
            if accepted && let Some(surface) = self.keyboard_surface() {
                crate::input::set_state(&surface, &NshView(self.retain()), nsh_core::tailwind::state::FOCUSED, true);
            }
            accepted
        }

        #[unsafe(method(resignFirstResponder))]
        fn resign_first_responder(&self) -> bool {
            // SAFETY: NSView's standard responder transition.
            let accepted: bool = unsafe { msg_send![super(self), resignFirstResponder] };
            if accepted && let Some(surface) = self.keyboard_surface() {
                crate::input::set_state(&surface, &NshView(self.retain()), nsh_core::tailwind::state::FOCUSED, false);
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
            match self.surface() {
                Some(surface) => crate::input::cursor_update(&surface),
                // SAFETY: NSView's own handling (passes it up).
                None => unsafe { msg_send![super(self), cursorUpdate: event] },
            }
        }

        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, event: &NSEvent) {
            match self.surface() {
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
            if let Some(surface) = self.surface() {
                crate::text::copy(&surface);
            }
        }

        /// The Edit menu's Select All (Cmd+A): a selectable text's or a
        /// selection area's.
        #[unsafe(method(selectAll:))]
        fn select_all(&self, _sender: Option<&AnyObject>) {
            if let Some(surface) = self.surface() {
                crate::text::select_all(&surface);
            }
        }

        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            let handled = self.keyboard_surface().is_some_and(|surface| {
                surface.measure(false, || {
                    let handled = crate::input::key(&surface, event, true);
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
            if let Some(surface) = self.surface() {
                surface.resized(size.width as f32, size.height as f32);
            }
        }

        // None while VoiceOver must not reach the children
        // ([`crate::access::hides_children`]), else AppKit's.
        #[unsafe(method_id(accessibilityChildren))]
        fn accessibility_children(&self) -> Option<Retained<NSArray>> {
            let hides = self
                .ivars()
                .state
                .try_borrow()
                .is_ok_and(|s| crate::access::hides_children(&s));
            if hides {
                Some(NSArray::new())
            } else {
                // SAFETY: NSView's own children.
                unsafe { msg_send![super(self), accessibilityChildren] }
            }
        }

        #[unsafe(method(viewDidMoveToSuperview))]
        fn view_did_move_to_superview(&self) {
            // AppKit resets the layer's geometry when it attaches the
            // view: views placed before they were inserted lose their
            // transforms.
            NshView(self.retain()).set_layer_geometry();
        }

        #[unsafe(method(viewDidMoveToWindow))]
        fn view_did_move_to_window(&self) {
            NshView(self.retain()).set_layer_geometry();
            NshView(self.retain()).rescale();
            if let Some(surface) = self.surface() {
                self.install_tracking();
                crate::system::window_changed(&surface);
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
    // Only the root stores a surface. A focused pressable child uses its
    // ancestors for keyboard handling; drawing and pointer hooks stay root-only.
    fn keyboard_surface(&self) -> Option<std::rc::Rc<Surface>> {
        if let Some(surface) = self.surface() {
            return Some(surface);
        }
        let mut parent = superview(self);
        while let Some(view) = parent {
            if let Some(root) = view.downcast_ref::<ViewObj>()
                && let Some(surface) = root.surface()
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

    /// What the root's `hitTest:` returns inside it: a hosted AppKit view
    /// nsh's picking lands on (past overlays that let the pointer
    /// through), else the root itself. `point` is in the root's
    /// superview's coordinates.
    fn root_hit(&self, point: NSPoint) -> Retained<NSView> {
        let me = || Retained::from(&**self);
        let Some(surface) = self.surface() else {
            return me();
        };
        let outer = superview(self);
        let p = self.convertPoint_fromView(point, outer.as_deref());
        let Some(native) = crate::input::native_at(&surface, p.x as f32, p.y as f32) else {
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
        if let Some(surface) = self.surface() {
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
#[cfg(any(feature = "dev", test))]
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
            tracking: Cell::new(false),
            content: RefCell::new(None),
            stale: Cell::new(false),
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

    /// Something it draws changed: content (text, canvas) is drawn again
    /// and the decoration applied again.
    pub(crate) fn changed(&self) {
        self.restyle();
        self.redraw();
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

    /// Draws its content (text, canvas) again, if it draws any.
    pub(crate) fn redraw(&self) {
        // A view that stopped drawing clears what it drew.
        if !self.state().draws() && self.ivars().content.borrow().is_none() {
            return;
        }
        if let Some(layer) = self.content_layer() {
            layer.setNeedsDisplay();
        }
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
        layer.setNeedsDisplayOnBoundsChange(true);
        // Drawn at once: text is cheap to draw, which measured faster than
        // asynchronously, and a canvas moves to Core Animation's threads
        // once it paints often (`canvas.rs`; paths and gradients are
        // costly: on the Stocks demo main-thread time per frame went from
        // 3.5 to 1.8 ms).
        layer.setDrawsAsynchronously(false);
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

    /// The scale of its window's backing (2 before it has one).
    fn backing_scale(&self) -> CGFloat {
        self.ns().window().map_or(2.0, |w| w.backingScaleFactor())
    }

    /// Its window or screen changed: the content layer draws at the new
    /// scale.
    fn rescale(&self) {
        if let Some((layer, _)) = &*self.ivars().content.borrow() {
            let scale = self.backing_scale();
            if layer.contentsScale() != scale {
                layer.setContentsScale(scale);
                layer.setNeedsDisplay();
            }
        }
    }

    /// Part of what it draws changed (`rect`, in its own coordinates, y
    /// down): only that is drawn again (a canvas's animated values).
    pub(crate) fn redraw_rect(&self, rect: nsh_core::Bounds<nsh_core::Points>) {
        let Some(layer) = self.content_layer() else {
            return;
        };
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
    /// entirely outside what its ancestors show (a list row out of sight).
    pub(crate) fn shown(&self) -> bool {
        let ns = self.ns();
        if ns.window().is_none() || ns.isHiddenOrHasHiddenAncestor() {
            return false;
        }
        // `visibleRect` follows the bounds as AppKit has them committed;
        // while a scroll offset shows as a layer transform the truth is
        // the scroll state, so the clip is each ancestor's effective
        // viewport — the same walk, scroll-state origins instead
        // ([`crate::scroll::bounds_origin`]; a plain view's is (0, 0)).
        // Ancestor transforms are not applied: nearly all are identity,
        // and a transformed clip at most defers or draws early.
        // Placed frames (`ns().frame()`: a sticky shift and mirroring
        // applied), not the logical ones, for the view and its ancestors
        // alike: the clip spaces are the ancestors' containers'.
        let ancestors = std::iter::successors(self.parent_view(), NshView::parent_view)
            .map(|p| (placed(p.ns().frame()), crate::scroll::bounds_origin(&p)));
        clip_shows(placed(ns.frame()), ancestors)
    }

    /// Its frame, transform or shift changed: places it again.
    pub(crate) fn moved(&self) {
        self.place();
        crate::decor::apply(self);
    }

    /// Places the view at its frame (with its parent's mirroring and its
    /// shift) and sets its layer's transform, opacity and visibility.
    pub(crate) fn place(&self) {
        let mirror = self.parent_view().and_then(|p| {
            let s = p.state();
            s.scroll
                .as_ref()
                .is_some_and(|sc| sc.mirrored)
                .then_some(s.frame.size.width.0)
        });
        let (rect, root) = {
            let s = self.state();
            let f = s.frame;
            let mut x = f.origin.x.0 + s.shift.0;
            if let Some(w) = mirror {
                x = w - x - f.size.width.0;
            }
            let y = f.origin.y.0 + s.shift.1;
            (
                ns_rect(x, y, f.size.width.0, f.size.height.0),
                s.id == ROOT_ID && self.ivars().surface.borrow().strong_count() > 0,
            )
        };
        if !root && self.ns().frame() != rect {
            self.ns().setFrame(rect);
            self.size_container();
            crate::native::resized(self);
            self.place_natives();
            if let Some((layer, _)) = &*self.ivars().content.borrow() {
                // A new size draws it again (`needsDisplayOnBoundsChange`).
                layer.setFrame(CGRect::new(CGPoint::new(0.0, 0.0), rect.size));
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

    /// Whether the pointer may target it (`pointerEvents` and visibility).
    pub(crate) fn can_target(&self) -> bool {
        let s = self.state();
        !s.style.hidden
            && !matches!(s.props.pointer_events, PointerEvents::None)
            // Animating out (`LayoutAnimation`): already gone for input.
            && !s.live.as_ref().is_some_and(|l| l.dying())
            // A screen under the top one, a modal leaving.
            && !self.ns().isHidden()
    }

    /// An object for `msg_send!` calls AppKit's bindings lack.
    #[allow(dead_code)]
    pub(crate) fn as_object(&self) -> &AnyObject {
        let view: &NSView = self.ns();
        view.as_ref()
    }
}

/// A rectangle as `(x0, y0, x1, y1)`.
type Span = (f32, f32, f32, f32);

fn placed(f: NSRect) -> Span {
    let (x, y) = (f.origin.x as f32, f.origin.y as f32);
    (x, y, x + f.size.width as f32, y + f.size.height as f32)
}

/// Whether `rect` (in its parent's content space) is not clipped away by
/// `ancestors`, innermost first: each one's placed frame (in its own
/// parent's content space) and the origin its content shows from (a
/// scroll view's offset, (0, 0) otherwise).
fn clip_shows(rect: Span, ancestors: impl IntoIterator<Item = (Span, (f32, f32))>) -> bool {
    let (mut x0, mut y0, mut x1, mut y1) = rect;
    for (frame, (ox, oy)) in ancestors {
        let (w, h) = (frame.2 - frame.0, frame.3 - frame.1);
        x0 = x0.max(ox);
        y0 = y0.max(oy);
        x1 = x1.min(ox + w);
        y1 = y1.min(oy + h);
        if x1 <= x0 || y1 <= y0 {
            return false;
        }
        // Into the grandparent's content space: the offset origin shows
        // at the frame's origin.
        x0 += frame.0 - ox;
        x1 += frame.0 - ox;
        y0 += frame.1 - oy;
        y1 += frame.1 - oy;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_row_shows_through_the_scroll_offset() {
        let screen = ((0.0, 0.0, 400.0, 800.0), (0.0, 0.0));
        let row = (0.0, 0.0, 400.0, 40.0);
        let list = |y| ((0.0, 0.0, 400.0, 600.0), (0.0, y));
        assert!(clip_shows(row, [list(0.0), screen]));
        assert!(!clip_shows(row, [list(1000.0), screen]));
    }

    #[test]
    fn a_text_in_a_pinned_sticky_header_shows() {
        // The header's logical frame is at the top of the content; scrolled
        // 1000 points, it is placed (shifted) at 1000, where the list shows.
        let text = (8.0, 8.0, 200.0, 32.0);
        let header = ((0.0, 1000.0, 400.0, 1040.0), (0.0, 0.0));
        let list = ((0.0, 0.0, 400.0, 600.0), (0.0, 1000.0));
        assert!(clip_shows(text, [header, list]));
        let logical = ((0.0, 0.0, 400.0, 40.0), (0.0, 0.0));
        assert!(!clip_shows(text, [logical, list]));
    }

    #[test]
    fn a_text_in_a_mirrored_cell_shows() {
        // A 400-point mirrored list scrolled 500 points: its bounds origin is
        // -500, and the cell at logical x 600 is placed at 400 - 600 - 90.
        let text = (10.0, 10.0, 80.0, 70.0);
        let list = ((0.0, 0.0, 400.0, 80.0), (-500.0, 0.0));
        let cell = ((-290.0, 0.0, -200.0, 80.0), (0.0, 0.0));
        assert!(clip_shows(text, [cell, list]));
        let logical = ((600.0, 0.0, 690.0, 80.0), (0.0, 0.0));
        assert!(!clip_shows(text, [logical, list]));
    }

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
