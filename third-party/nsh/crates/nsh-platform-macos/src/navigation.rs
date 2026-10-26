//! Navigation stacks, screens, modals.
//!
//! A stack's screens are its child views; only the top one shows (and the
//! one below it while a transition runs): the others are hidden
//! (`NSView.hidden`), so they are neither drawn nor picked. Changes of the
//! app's screens are reconciled at the end of each batch, once every item
//! is applied: a new top screen slides in from the right over the previous
//! one (which moves left a bit); a top screen the app removes slides out as
//! the image it last showed (rendered from its layers when it is detached,
//! before the same batch tears its content down). The rendering leaves
//! out what other processes draw, web pages and videos: their live views
//! go with the image ([`crate::native::lend`]), so they do not go blank
//! as the screen (or a modal, which leaves the same way) slides out.
//!
//! NSH draws no header: a screen's `header` (the app's view,
//! [`ScreenConfig::header_view`]) is a child of the screen whose frame the
//! core sets at its top (as wide as the screen, as tall as it lays out),
//! with the content laid out below it; it is kept above the content. The
//! other header items (the native header's slots on iOS and Android) stay
//! hidden. Under the app's content each screen has an opaque backdrop in
//! the window's color, so a screen sliding over another hides it.
//!
//! Going back (Escape, Option+Left, Command+[, the mouse's back button;
//! Escape in a focused text field or web view only leaves it) sends
//! `onBackPress` (`BackRequest`) to the top screen when the app listens,
//! then pops natively unless its `popOnBack` is false, then sends
//! `onDismiss`, which removes the route in JS; until the app removes the
//! screen it is `popped` and ignored. The answer comes from props mounted
//! beforehand, never from JS. The newest modal comes first: a stack inside
//! it pops, else it gets `onRequestClose` (reason `"cancel"`; with
//! `closeOnEscape` it also closes natively, and gets `onDismiss` right
//! after).
//!
//! Modals are children of the surface's root, kept above the app's views,
//! at the size of the surface: transparent layers with no look of their own
//! (the runtime renders the app's popup and backdrop in them; the
//! presentation is ignored). They slide up or fade in, then get `onShow`;
//! when the app removes one it leaves as an image of its last frame, then
//! gets `onDismiss`.
//!
//! Transitions run on the display link ([`Surface::add_frame_callback`])
//! and only move views (`shift`, `fade`): nothing is laid out again while
//! they run.

use std::{rc::Rc, time::Duration};

use nsh_core::{
    Bounds, Color, EdgeInsets, EventKind, EventPayload, ModalAnimation, ModalConfig, NodeId,
    PayloadValue, Point, Points, ROOT_ID, ScreenAnimation, ScreenConfig, Size, ViewKind,
    navigation::{
        Back, Reported, Stack, Tick, Transitions, back_target, innermost, insets_payload,
        modal_in_offset, modal_out_offset, pop_offsets, push_offsets,
    },
};
use nsh_engine::ColorScheme;
use objc2::{
    MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained, runtime::AnyObject,
};
use objc2_app_kit::{
    NSEvent, NSEventModifierFlags, NSResponder, NSText, NSView, NSWindowOrderingMode,
};
use objc2_core_foundation::{CFRetained, CGFloat};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace, CGContext, CGImage,
    CGImageAlphaInfo, CGImageByteOrderInfo,
};
use objc2_foundation::{NSObject, NSObjectProtocol, NSPoint, NSRect};
use rustc_hash::FxHashMap;

use crate::{
    decor::cg_color,
    surface::Surface,
    view::{Container, NshView, ViewObj, ns_rect},
};

/// How far below the window a modal with a shadow of the app's starts, so
/// that its shadow is not seen at the bottom edge.
const SHADOW_ROOM: f32 = 48.0;

/// The window's color (AppKit's), under a screen's content, so a screen
/// moving over another hides it.
fn window_color(dark: bool) -> Color {
    if dark {
        Color::rgba(30, 30, 30, 255)
    } else {
        Color::rgba(255, 255, 255, 255)
    }
}

define_class!(
    /// A plain drawing navigation hosts (the last image of a screen or
    /// modal that is leaving): its layer's contents. The pointer passes
    /// through it.
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshNavFill"]
    struct Fill;

    unsafe impl NSObjectProtocol for Fill {}

    impl Fill {
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

        #[unsafe(method_id(hitTest:))]
        fn hit_test(&self, _point: NSPoint) -> Option<Retained<NSView>> {
            None
        }
    }
);

impl Fill {
    fn new(mtm: MainThreadMarker) -> Retained<Fill> {
        // SAFETY: NSView's designated initializer.
        let fill: Retained<Fill> =
            unsafe { msg_send![Fill::alloc(mtm), initWithFrame: NSRect::ZERO] };
        fill.setWantsLayer(true);
        fill
    }

    fn set_image(&self, image: &CGImage) {
        if let Some(layer) = self.layer() {
            // SAFETY: a CGImage is a Core Foundation object, and valid
            // layer contents.
            unsafe {
                let contents = &*(image as *const CGImage).cast::<AnyObject>();
                layer.setContents(Some(contents));
            }
        }
    }

    fn set_opacity(&self, opacity: f32) {
        if let Some(layer) = self.layer() {
            layer.setOpacity(opacity);
        }
    }
}

/// An opaque background placed first in `view` (under its content). A
/// [`Container`] (an "own" view for [`NshView::insert_before`]), so the
/// app's views keep going above it, below the hosted AppKit views.
fn new_backdrop(view: &NshView) -> Retained<Container> {
    // SAFETY: NSView's designated initializer.
    let c: Retained<Container> =
        unsafe { msg_send![Container::alloc(view.mtm()), initWithFrame: NSRect::ZERO] };
    c.setWantsLayer(true);
    view.ns()
        .addSubview_positioned_relativeTo(&c, NSWindowOrderingMode::Below, None);
    c
}

fn set_layer_color(view: &NSView, color: Option<Color>) {
    if let Some(layer) = view.layer() {
        layer.setBackgroundColor(color.and_then(cg_color).as_deref());
    }
}

/// One screen.
struct ScreenNav {
    view: NshView,
    config: ScreenConfig,
    /// Its opaque background, under the app's content.
    backdrop: Retained<Container>,
    /// The header items the app inserted (only the `header` one shows).
    items: Vec<NshView>,
    /// The size and insets last reported.
    reported: Reported,
    /// The size the background was placed at.
    backdrop_size: (f32, f32),
    /// Native projection suspended by List retirement, awaiting Insert or
    /// source deletion; its screen configuration remains authoritative.
    parked: bool,
}

/// One stack.
struct StackNav {
    view: NshView,
    /// Its screens as shown, and those the user popped.
    screens: Stack,
    /// The top screen's view: its image is kept when the app removes it.
    top: Option<NshView>,
    /// The image the top screen showed when the app took it away.
    image: Option<(NodeId, Shot)>,
}

/// One modal (kept while its node lives: the app may show it again).
#[derive(Default)]
struct ModalNav {
    config: ModalConfig,
    /// Its view while it is presented.
    view: Option<NshView>,
    /// The user closed it natively (`closeOnEscape`) and it was reported:
    /// the app's removal only forgets it.
    closed: bool,
    reported: Reported,
    /// The input or pressable view that had the keyboard focus when it was
    /// presented (a popover's trigger, a field; held weakly, as the app
    /// may remove it meanwhile): it gets the focus back when the modal
    /// closes, as on the other desktops.
    focus_before: Option<objc2::rc::Weak<ViewObj>>,
}

/// What leaves the screen during a pop.
enum Leaving {
    /// The screen itself (popped by the user).
    View(NshView),
    /// The image of a screen the app removed, hosted by the stack.
    Image(Shot),
}

enum Motion {
    Push {
        stack: NshView,
        entering: NshView,
        below: Option<NshView>,
        fade: bool,
    },
    Pop {
        stack: NshView,
        /// The screen owner, including when only its snapshot remains.
        owner: NodeId,
        leaving: Leaving,
        below: Option<NshView>,
        fade: bool,
        /// The screen the user popped: hidden and reported at the end.
        popped: Option<NodeId>,
    },
    ModalIn {
        view: NshView,
        fade: bool,
    },
    ModalOut {
        /// Native owner, retained even when Dismiss was already reported.
        id: NodeId,
        /// The modal to report `onDismiss` for at the end (`None`: it was
        /// reported when the user closed it).
        dismiss: Option<NodeId>,
        image: Shot,
        /// Where the modal was.
        frame: Bounds<Points>,
        fade: bool,
    },
}

impl Motion {
    fn stack(&self) -> Option<NodeId> {
        match self {
            Motion::Push { stack, .. } | Motion::Pop { stack, .. } => Some(stack.id()),
            _ => None,
        }
    }
}

/// The navigation state of a surface.
#[derive(Default)]
pub(crate) struct Nav {
    stacks: FxHashMap<NodeId, StackNav>,
    screens: FxHashMap<NodeId, ScreenNav>,
    modals: FxHashMap<NodeId, ModalNav>,
    /// Presented modals, oldest first.
    order: Vec<NodeId>,
    /// Stacks whose screens changed in this batch.
    dirty: Vec<NodeId>,
    /// Modals presented in this batch.
    presenting: Vec<NodeId>,
    transitions: Transitions<Motion>,
    ticking: bool,
    /// The appearance the backgrounds have.
    dark: Option<bool>,
}

fn dark(surface: &Surface) -> bool {
    surface.environment.get().color_scheme == ColorScheme::Dark
}

fn rect(x: f32, y: f32, width: f32, height: f32) -> Bounds<Points> {
    Bounds {
        origin: Point {
            x: Points(x),
            y: Points(y),
        },
        size: Size {
            width: Points(width),
            height: Points(height),
        },
    }
}

/// How a modal comes and goes: the duration and whether it fades;
/// `None`: at once.
fn modal_motion(surface: &Surface, animation: ModalAnimation) -> Option<(Duration, bool)> {
    nsh_core::navigation::modal_motion(animation, surface.environment.get().reduce_motion)
}

/// The surface's safe-area insets.
fn safe_area(surface: &Surface) -> EdgeInsets {
    let safe = surface.environment.get().safe_area;
    EdgeInsets {
        top: safe.top,
        right: safe.right,
        bottom: safe.bottom,
        left: safe.left,
    }
}

/// Reports root `id`'s size and insets when they changed.
fn report(
    surface: &Surface,
    id: NodeId,
    last: &mut Reported,
    size: Size<Points>,
    insets: EdgeInsets,
) {
    let Some(insets_changed) = last.update(size, insets) else {
        return;
    };
    surface.control(|c| c.set_root_size(id, size, insets));
    if insets_changed {
        surface.event(id, EventKind::Insets, insets_payload(insets));
    }
}

/// Takes the keyboard focus away from inside `view` before it is hidden or
/// detached (a text field of a screen that is gone would keep typing),
/// giving it to the surface's root.
fn drop_focus(surface: &Surface, view: &NSView) {
    let Some(window) = view.window() else { return };
    let Some(responder) = window.firstResponder() else {
        return;
    };
    if responder
        .downcast_ref::<NSView>()
        .is_some_and(|r| r.isDescendantOf(view))
    {
        window.makeFirstResponder(Some(surface.root.ns()));
    }
}

/// The input or pressable view that has the keyboard focus in `surface`'s
/// window (not the root, which holds it when nothing else does). A field
/// edits in the window's shared field editor, a subview of the field only
/// while it edits, and a text view sits in a scroll view: the input is the
/// responder's nearest view of ours.
fn focused(surface: &Surface) -> Option<objc2::rc::Weak<ViewObj>> {
    let root = surface.root.ns();
    let responder = root.window()?.firstResponder()?;
    let mut at = responder.downcast::<NSView>().ok()?;
    if !at.isDescendantOf(root) {
        return None;
    }
    while &*at != root {
        if let Some(view) = NshView::from_ns(&at)
            && (view.kind() == ViewKind::Input || crate::input::is_key_control(&view))
        {
            let obj: &ViewObj = &view;
            return Some(objc2::rc::Weak::from(obj));
        }
        at = crate::view::superview(&at)?;
    }
    None
}

/// Gives the keyboard focus back to `view` (what had it before a modal
/// opened), if the focus fell to the root or the window meanwhile and
/// `view` can still take it inside `scope` (the newest modal still
/// presented, else the root). A field gets the caret at the end, as
/// `focus()` puts it (AppKit would select its whole text).
fn restore_focus(surface: &Surface, scope: &NSView, view: Option<objc2::rc::Weak<ViewObj>>) {
    let Some(view) = view
        .and_then(|w| w.load())
        .and_then(|v| NshView::from_ns(&v))
    else {
        return;
    };
    let Some(window) = surface.root.ns().window() else {
        return;
    };
    // Nothing else took it meanwhile: the root, or the window itself,
    // holds it.
    let at_root = window.firstResponder().is_none_or(|r| {
        r.downcast_ref::<NSView>()
            .is_none_or(|v| v == surface.root.ns())
    });
    if !at_root || view.ns().window().is_none() || !view.ns().isDescendantOf(scope) {
        return;
    }
    if view.kind() == ViewKind::Input {
        if view.can_target() && !view.ns().isHiddenOrHasHiddenAncestor() {
            crate::text_input::focus(&view);
        }
    } else if crate::input::is_key_control(&view) {
        window.makeFirstResponder(Some(view.ns()));
    }
}

/// Hides `view` (a screen not on top, a header item other than `header`).
fn hide(surface: &Surface, view: &NshView) {
    if !view.ns().isHidden() {
        drop_focus(surface, view.ns());
        view.ns().setHidden(true);
    }
}

/// Shows `view` again (its layer's visibility follows its style).
fn show(view: &NshView) {
    if view.ns().isHidden() {
        view.ns().setHidden(false);
        view.place();
    }
}

fn set_shift(view: &NshView, shift: (f32, f32)) {
    let changed = std::mem::replace(&mut view.state_mut().shift, shift) != shift;
    if changed {
        view.place();
    }
}

fn set_fade(view: &NshView, fade: f32) {
    let changed = std::mem::replace(&mut view.state_mut().fade, fade) != fade;
    if changed {
        view.place();
    }
}

/// How far below the window `view` must go to be out of sight with its
/// shadow.
fn shadow_room(view: &NshView) -> f32 {
    if view.state().style.shadow.is_visible() {
        SHADOW_ROOM
    } else {
        0.0
    }
}

/// What `view` shows now, rendered from its layers (it may be detached:
/// layers keep what they drew).
fn image_of(surface: &Surface, view: &NshView) -> Option<CFRetained<CGImage>> {
    let layer = view.ns().layer()?;
    let f = view.state().frame;
    if f.size.width.0 <= 0.0 || f.size.height.0 <= 0.0 {
        return None;
    }
    let scale = surface
        .root
        .ns()
        .window()
        .map_or(2.0, |w| w.backingScaleFactor());
    let (pw, ph) = (
        (f.size.width.0 as f64 * scale).ceil() as usize,
        (f.size.height.0 as f64 * scale).ceil() as usize,
    );
    let space = CGColorSpace::new_device_rgb()?;
    // SAFETY: CoreGraphics allocates the pixels (null data) for an RGBA
    // context of these dimensions; the layer is rendered on the main
    // thread, which owns it.
    unsafe {
        let context = CGBitmapContextCreate(
            std::ptr::null_mut(),
            pw,
            ph,
            8,
            pw * 4,
            Some(&space),
            CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0,
        )?;
        // Layers of flipped views draw y down.
        CGContext::translate_ctm(Some(&context), 0.0, ph as CGFloat);
        CGContext::scale_ctm(Some(&context), scale, -scale);
        // The view's own transform and opacity are where it is placed, not
        // what it shows.
        let opacity = layer.opacity();
        layer.setOpacity(1.0);
        layer.renderInContext(&context);
        layer.setOpacity(opacity);
        CGBitmapContextCreateImage(Some(&context))
    }
}

/// The last image of a screen or modal that leaves, hosted by navigation
/// while it leaves. `renderInContext:` draws no web page (WebKit's process
/// draws them), so the live web views it showed are lent to it
/// ([`crate::native::lend`]), and given back or let go with it.
struct Shot {
    fill: Retained<Fill>,
    _lent: Vec<crate::native::Lent>,
}

impl std::ops::Deref for Shot {
    type Target = Fill;

    fn deref(&self) -> &Fill {
        &self.fill
    }
}

/// What `view` shows now, as a view of its own to host while it leaves
/// (`view` may be detached; it is not changed but for its web views).
fn shot(surface: &Rc<Surface>, view: &NshView) -> Option<Shot> {
    let image = image_of(surface, view)?;
    let fill = Fill::new(surface.mtm);
    fill.set_image(&image);
    let lent = crate::native::lend(surface, view, &fill);
    Some(Shot { fill, _lent: lent })
}

/// Moves `tail` to the end of `parent`'s subviews (drawn last), unless
/// they are there already (moving a view out of place would cost its
/// focus).
fn keep_last(parent: &NSView, tail: &[Retained<NSView>]) {
    let subviews = parent.subviews();
    let n = subviews.len();
    let in_place = tail.len() <= n
        && tail
            .iter()
            .enumerate()
            .all(|(i, v)| *subviews.objectAtIndex(n - tail.len() + i) == **v);
    if !in_place {
        for v in tail {
            parent.addSubview_positioned_relativeTo(v, NSWindowOrderingMode::Above, None);
        }
    }
}

impl ScreenNav {
    fn new(view: &NshView, dark: bool) -> Self {
        let backdrop = new_backdrop(view);
        set_layer_color(&backdrop, Some(window_color(dark)));
        ScreenNav {
            view: view.clone(),
            config: ScreenConfig::default(),
            backdrop,
            items: Vec::new(),
            reported: Reported::default(),
            backdrop_size: (-1.0, -1.0),
            parked: false,
        }
    }

    /// Reports the screen's size (its stack's) and insets: the window's
    /// safe area, but the top's when its `header` covers it.
    fn report(&mut self, surface: &Surface, stack: &NshView) {
        if self.parked {
            return;
        }
        let f = stack.state().frame;
        let mut insets = safe_area(surface);
        if self.config.header_view.is_some() {
            insets.top = Points::ZERO;
        }
        let id = self.view.id();
        let size = f.size;
        report(surface, id, &mut self.reported, size, insets);
    }

    /// Places the background, and shows the `header` item (where the core
    /// put it) and only that one.
    fn layout(&mut self, surface: &Surface) {
        let (w, h) = {
            let f = self.view.state().frame;
            (f.size.width.0, f.size.height.0)
        };
        if self.backdrop_size != (w, h) {
            self.backdrop_size = (w, h);
            self.backdrop.setFrame(ns_rect(0.0, 0.0, w, h));
        }
        for item in &self.items {
            if Some(item.id()) == self.config.header_view {
                show(item);
            } else {
                hide(surface, item);
            }
        }
    }

    /// Keeps the `header` over the app's content (which the app may insert
    /// after it).
    fn raise_header(&self) {
        let header = self
            .items
            .iter()
            .find(|v| Some(v.id()) == self.config.header_view);
        if let Some(header) = header {
            keep_last(self.view.ns(), &[Retained::from(header.ns())]);
        }
    }
}

impl Nav {
    /// Forgets the app's views (it stopped); a running frame callback
    /// stays.
    pub(crate) fn reset(&mut self) {
        // The views navigation hosts in the root (the mounter only takes
        // the app's views away).
        let mut hosted: Vec<Retained<NSView>> = Vec::new();
        for motion in self.transitions.iter() {
            if let Motion::ModalOut { image, .. } = motion {
                hosted.push(Retained::into_super(image.fill.clone()));
            }
        }
        for view in hosted {
            match crate::view::superview(&view).and_then(|s| NshView::from_ns(&s)) {
                Some(root) => root.remove_native(&view),
                None => view.removeFromSuperview(),
            }
        }
        *self = Nav {
            ticking: self.ticking,
            ..Nav::default()
        };
    }

    fn screen(&mut self, surface: &Surface, view: &NshView) -> &mut ScreenNav {
        self.screens
            .entry(view.id())
            .or_insert_with(|| ScreenNav::new(view, dark(surface)))
    }

    /// Ends the transitions `which` selects at once.
    fn finish(&mut self, surface: &Surface, which: impl Fn(&Motion) -> bool) {
        for motion in self.transitions.take(which) {
            self.end(surface, motion);
        }
    }

    /// Puts the views of `motion` where they are at eased progress `e`.
    fn apply(&self, surface: &Surface, motion: &Motion, e: f32) {
        match motion {
            Motion::Push {
                stack,
                entering,
                below,
                fade,
            } => {
                let (x, below_x) = push_offsets(stack.state().frame.size.width, e);
                if *fade {
                    set_fade(entering, e);
                } else {
                    set_shift(entering, (x.0, 0.0));
                    if let Some(below) = below {
                        set_shift(below, (below_x.0, 0.0));
                    }
                }
            }
            Motion::Pop {
                stack,
                leaving,
                below,
                fade,
                ..
            } => {
                let f = stack.state().frame;
                let (x, below_x) = pop_offsets(f.size.width, e);
                match leaving {
                    Leaving::View(v) if *fade => set_fade(v, 1.0 - e),
                    Leaving::View(v) => set_shift(v, (x.0, 0.0)),
                    Leaving::Image(image) => {
                        let x = if *fade {
                            image.set_opacity(1.0 - e);
                            0.0
                        } else {
                            x.0
                        };
                        stack.set_native(image, rect(x, 0.0, f.size.width.0, f.size.height.0));
                    }
                }
                if let (Some(below), false) = (below, fade) {
                    set_shift(below, (below_x.0, 0.0));
                }
            }
            Motion::ModalIn { view, fade } => {
                if *fade {
                    set_fade(view, e);
                } else {
                    // From below the window's bottom edge (its shadow
                    // too).
                    let h = surface.root.state().frame.size.height.0 + shadow_room(view);
                    let y = view.state().frame.origin.y.0;
                    set_shift(view, (0.0, modal_in_offset(Points(h - y), e).0));
                }
            }
            Motion::ModalOut {
                image, frame, fade, ..
            } => {
                let h = surface.root.state().frame.size.height.0;
                let y = if *fade {
                    image.set_opacity(1.0 - e);
                    frame.origin.y.0
                } else {
                    frame.origin.y.0 + modal_out_offset(Points(h - frame.origin.y.0), e).0
                };
                surface.root.set_native(
                    image,
                    rect(frame.origin.x.0, y, frame.size.width.0, frame.size.height.0),
                );
            }
        }
    }

    fn end(&mut self, surface: &Surface, motion: Motion) {
        self.apply(surface, &motion, 1.0);
        match motion {
            Motion::Push { stack, .. } => self.settle(surface, stack.id()),
            Motion::Pop {
                stack,
                leaving,
                popped,
                ..
            } => {
                match leaving {
                    Leaving::View(v) => {
                        hide(surface, &v);
                        set_shift(&v, (0.0, 0.0));
                        set_fade(&v, 1.0);
                    }
                    Leaving::Image(image) => stack.remove_native(&image),
                }
                self.settle(surface, stack.id());
                if let Some(id) = popped {
                    surface.event(id, EventKind::Dismiss, EventPayload::None);
                }
            }
            Motion::ModalIn { view, .. } => {
                set_shift(&view, (0.0, 0.0));
                set_fade(&view, 1.0);
                surface.event(view.id(), EventKind::Show, EventPayload::None);
            }
            Motion::ModalOut { dismiss, image, .. } => {
                surface.root.remove_native(&image);
                if let Some(id) = dismiss {
                    surface.event(id, EventKind::Dismiss, EventPayload::None);
                }
            }
        }
    }

    /// Shows only the top screen of `stack`, where it belongs.
    fn settle(&mut self, surface: &Surface, stack: NodeId) {
        let top = self.stacks.get(&stack).and_then(|stack| {
            stack
                .screens
                .shown()
                .iter()
                .rev()
                .copied()
                .find(|id| self.screens.get(id).is_some_and(|screen| !screen.parked))
        });
        let Some(st) = self.stacks.get_mut(&stack) else {
            return;
        };
        st.top = None;
        for view in st.view.child_views() {
            if view.kind() != ViewKind::Screen {
                continue;
            }
            set_shift(&view, (0.0, 0.0));
            set_fade(&view, 1.0);
            if Some(view.id()) == top {
                show(&view);
                st.top = Some(view);
            } else {
                hide(surface, &view);
            }
        }
    }

    fn start(&mut self, surface: &Rc<Surface>, duration: Duration, motion: Motion) {
        self.apply(surface, &motion, 0.0);
        self.transitions.push(duration, motion);
        if self.ticking {
            return;
        }
        self.ticking = true;
        surface.add_frame_callback(|surface, now| {
            let Ok(mut nav) = surface.nav.try_borrow_mut() else {
                return true;
            };
            nav.tick(surface, now);
            if nav.transitions.is_empty() {
                nav.ticking = false;
                false
            } else {
                true
            }
        });
    }

    fn tick(&mut self, surface: &Surface, now: f64) {
        for tick in self.transitions.tick(now) {
            match tick {
                Tick::Ended(motion) => self.end(surface, motion),
                Tick::At(i, e) => self.apply(surface, &self.transitions[i], e),
            }
        }
    }

    /// The duration and whether it fades; `None`: no animation.
    fn screen_motion(surface: &Surface, animation: ScreenAnimation) -> Option<(Duration, bool)> {
        nsh_core::navigation::screen_motion(animation, surface.environment.get().reduce_motion)
    }

    /// Shows the app's screens of `stack` after a batch changed them.
    fn reconcile(&mut self, surface: &Rc<Surface>, stack_id: NodeId) {
        self.finish(surface, |m| m.stack() == Some(stack_id));
        let Some(st) = self.stacks.get_mut(&stack_id) else {
            return;
        };
        let stack = st.view.clone();
        let children: Vec<NshView> = stack
            .child_views()
            .into_iter()
            .filter(|v| v.kind() == ViewKind::Screen)
            .collect();
        let find = |id: NodeId| children.iter().find(|c| c.id() == id).cloned();
        let ids: Vec<NodeId> = children.iter().map(NshView::id).collect();
        let prev = st.screens.reconcile(&ids);
        let desired = st.screens.shown().to_vec();
        let active = |id: &&NodeId| self.screens.get(*id).is_some_and(|screen| !screen.parked);
        let (old, new) = (
            prev.iter().rev().find(active).copied(),
            desired.iter().rev().find(active).copied(),
        );
        let frame = stack.state().frame;
        // The image the top screen showed when the app removed it.
        let image = st
            .image
            .take()
            .filter(|(id, _)| Some(*id) == old && Some(*id) != new && find(*id).is_none())
            .map(|(_, image)| image);
        let leaving_animation = old
            .and_then(|id| self.screens.get(&id))
            .map(|s| s.config.animation);
        for id in &prev {
            if find(*id).is_none() {
                self.screens.remove(id);
            }
        }
        for &id in &desired {
            let Some(view) = find(id) else { continue };
            let s = self.screen(surface, &view);
            if !prev.contains(&id) {
                s.report(surface, &stack);
            }
        }
        if children.is_empty() && !stack.has_parent() {
            // The stack is gone.
            self.stacks.remove(&stack_id);
            return;
        }
        self.settle(surface, stack_id);
        let (Some(old), Some(new)) = (old, new) else {
            return;
        };
        if old == new || frame.size.width.0 <= 0.0 {
            return;
        }
        let pushing = !prev.contains(&new);
        let animation = if pushing {
            self.screens.get(&new).map(|s| s.config.animation)
        } else {
            leaving_animation
        };
        let Some((duration, fade)) = Self::screen_motion(surface, animation.unwrap_or_default())
        else {
            return;
        };
        if pushing {
            let Some(entering) = find(new) else { return };
            let below = find(old);
            if let Some(b) = &below {
                show(b);
            }
            let motion = Motion::Push {
                stack,
                entering,
                below,
                fade,
            };
            self.start(surface, duration, motion);
        } else {
            let leaving = match find(old) {
                Some(v) => {
                    show(&v);
                    Leaving::View(v)
                }
                None => {
                    let Some(image) = image else { return };
                    Leaving::Image(image)
                }
            };
            let motion = Motion::Pop {
                stack,
                owner: old,
                leaving,
                below: find(new),
                fade,
                popped: None,
            };
            self.start(surface, duration, motion);
        }
    }

    /// The user goes back in `stack`: tells the top screen when the app
    /// listens (`onBackPress`), then pops it natively unless it prevents it
    /// (`popOnBack` false), and tells the app once it is gone.
    fn back(&mut self, surface: &Rc<Surface>, stack_id: NodeId) {
        self.finish(surface, |m| m.stack() == Some(stack_id));
        let Some(st) = self.stacks.get_mut(&stack_id) else {
            return;
        };
        let Some(top) = st.screens.top() else { return };
        if let Some(s) = self.screens.get(&top) {
            if s.view.state().events.contains(EventKind::BackRequest) {
                surface.event(top, EventKind::BackRequest, EventPayload::None);
            }
            if s.config.prevent_back {
                return;
            }
        }
        if st.screens.pop().is_none() {
            return;
        }
        let stack = st.view.clone();
        let children = stack.child_views();
        let find = |id: NodeId| children.iter().find(|c| c.id() == id).cloned();
        let below = st.screens.top().and_then(find);
        st.top = below.clone();
        let animation = self.screens.get(&top).map(|s| s.config.animation);
        match (
            Self::screen_motion(surface, animation.unwrap_or_default()),
            find(top),
        ) {
            (Some((duration, fade)), Some(leaving)) => {
                if let Some(b) = &below {
                    show(b);
                }
                let motion = Motion::Pop {
                    stack,
                    owner: top,
                    leaving: Leaving::View(leaving),
                    below,
                    fade,
                    popped: Some(top),
                };
                self.start(surface, duration, motion);
            }
            _ => {
                self.settle(surface, stack_id);
                surface.event(top, EventKind::Dismiss, EventPayload::None);
            }
        }
    }

    /// The stack going back acts on: the innermost shown one that can pop
    /// or asks first, inside `within` (the newest modal) when given.
    fn back_stack(&self, within: Option<&NshView>) -> Option<NodeId> {
        let wants = |st: &StackNav| {
            let ns = st.view.ns();
            ns.window().is_some()
                && !ns.isHiddenOrHasHiddenAncestor()
                && within.is_none_or(|w| ns.isDescendantOf(w.ns()))
                && st.screens.takes_back(|top| {
                    self.screens
                        .get(&top)
                        .is_some_and(|screen| screen.config.prevent_back)
                })
        };
        let candidates: Vec<&StackNav> = self.stacks.values().filter(|s| wants(s)).collect();
        innermost(&candidates, |c, o| o.view.ns().isDescendantOf(c.view.ns())).map(|c| c.view.id())
    }

    /// Where the keyboard focus may go ([`focus_scope`]).
    fn scope(&self, surface: &Surface) -> Retained<NSView> {
        self.order
            .iter()
            .rev()
            .find_map(|id| {
                self.modals
                    .get(id)?
                    .view
                    .as_ref()
                    .filter(|view| view.has_parent())
            })
            .map_or_else(
                || Retained::from(surface.root.ns()),
                |v| Retained::from(v.ns()),
            )
    }

    /// Takes modal `id` away natively (it leaves as an image of its last
    /// frame), then reports `onDismiss` unless `reported` already.
    fn close_modal(&mut self, surface: &Rc<Surface>, id: NodeId, reported: bool) {
        self.finish(
            surface,
            |m| matches!(m, Motion::ModalIn { view, .. } if view.id() == id),
        );
        let newer: Vec<NodeId> = self
            .order
            .iter()
            .skip_while(|&&m| m != id)
            .skip(1)
            .copied()
            .collect();
        self.order.retain(|&m| m != id);
        let Some(m) = self.modals.get_mut(&id) else {
            return;
        };
        let Some(view) = m.view.take() else { return };
        let focus_before = m.focus_before.take();
        let frame = view.state().frame;
        let motion = modal_motion(surface, m.config.animation);
        let shown = view.ns().window().is_some();
        let image = motion.filter(|_| shown).and_then(|_| shot(surface, &view));
        if view.has_parent() {
            drop_focus(surface, view.ns());
            view.unparent();
        }
        // A newer modal still covers what had the focus: one that remembers
        // a view of this modal (gone now) gives this one's back instead.
        for newer in newer {
            if let Some(n) = self.modals.get_mut(&newer)
                && n.focus_before
                    .as_ref()
                    .and_then(|w| w.load())
                    .is_some_and(|v| v.isDescendantOf(view.ns()))
            {
                n.focus_before = focus_before.clone();
            }
        }
        restore_focus(surface, &self.scope(surface), focus_before);
        set_shift(&view, (0.0, 0.0));
        set_fade(&view, 1.0);
        match (motion, image) {
            (Some((duration, fade)), Some(image)) => {
                surface.root.set_native(
                    &image,
                    rect(
                        frame.origin.x.0,
                        frame.origin.y.0,
                        frame.size.width.0,
                        frame.size.height.0,
                    ),
                );
                let motion = Motion::ModalOut {
                    id,
                    dismiss: (!reported).then_some(id),
                    image,
                    frame,
                    fade,
                };
                self.start(surface, duration, motion);
            }
            _ => {
                if !reported {
                    surface.event(id, EventKind::Dismiss, EventPayload::None);
                }
            }
        }
    }

    /// Animates presented modal `id` in, then reports `onShow`.
    fn show_modal(&mut self, surface: &Rc<Surface>, id: NodeId) {
        let Some(m) = self.modals.get(&id) else {
            return;
        };
        let Some(view) = m.view.clone() else { return };
        match modal_motion(surface, m.config.animation) {
            Some((duration, fade)) => {
                self.start(surface, duration, Motion::ModalIn { view, fade });
            }
            None => surface.event(id, EventKind::Show, EventPayload::None),
        }
    }

    /// The user asks modal `id` to close (going back): it hears
    /// `onRequestClose` (reason `"cancel"`). With `closeOnEscape` it also
    /// leaves natively and hears `onDismiss` right after, as on iOS (the
    /// runtime keeps the handler of a modal the app removed in between).
    fn request_close(&mut self, surface: &Rc<Surface>, id: NodeId) {
        let reason = EventPayload::Map(vec![("reason", PayloadValue::Str("cancel".into()))]);
        surface.event(id, EventKind::RequestClose, reason);
        if let Some(m) = self.modals.get_mut(&id)
            && m.config.close_on_escape
            && m.view.is_some()
        {
            m.closed = true;
            surface.event(id, EventKind::Dismiss, EventPayload::None);
            self.close_modal(surface, id, true);
        }
    }

    /// Going back: a stack inside the newest modal pops, else the modal
    /// asks to close; without a modal the app's `onBackPress` hears it
    /// first when it listens (it sends `Command::Back` when no listener
    /// takes it), else the innermost stack pops. Whether something took it.
    fn go_back(&mut self, surface: &Rc<Surface>) -> bool {
        if self.active_modal().is_none()
            && surface.root.state().events.contains(EventKind::BackPress)
        {
            surface.event(ROOT_ID, EventKind::BackPress, EventPayload::None);
            return true;
        }
        self.default_back(surface)
    }

    /// Going back as without the app's listeners (`Command::Back`): a
    /// stack inside the newest modal pops, else the modal asks to close,
    /// else the innermost stack pops. Whether something took it.
    fn default_back(&mut self, surface: &Rc<Surface>) -> bool {
        let target = back_target(self.active_modal(), false, |modal| {
            let view = modal.and_then(|id| self.modals.get(&id)?.view.clone());
            self.back_stack(view.as_ref())
        });
        match target {
            Some(Back::Stack(stack)) => self.back(surface, stack),
            Some(Back::Modal(id)) => self.request_close(surface, id),
            Some(Back::App) | None => return false,
        }
        true
    }

    /// Keeps the presented modals (and those leaving) over the app's
    /// views.
    fn raise_modals(&self, surface: &Surface) {
        let mut tail: Vec<Retained<NSView>> = Vec::new();
        for m in self.order.iter().filter_map(|id| self.modals.get(id)) {
            if let Some(view) = &m.view
                && view.has_parent()
            {
                tail.push(Retained::from(view.ns()));
            }
        }
        for motion in self.transitions.iter() {
            if let Motion::ModalOut { image, .. } = motion {
                tail.push(Retained::into_super(image.fill.clone()));
            }
        }
        keep_last(surface.root.ns(), &tail);
    }

    /// Sizes modal `id` to the surface and reports it (with the surface's
    /// safe area).
    fn size_modal(&mut self, surface: &Surface, id: NodeId) {
        let Some(m) = self.modals.get_mut(&id) else {
            return;
        };
        let Some(view) = &m.view else { return };
        if !view.has_parent() {
            return;
        }
        let f = surface.root.state().frame;
        let frame = rect(0.0, 0.0, f.size.width.0, f.size.height.0);
        if std::mem::replace(&mut view.state_mut().frame, frame) != frame {
            view.moved();
        }
        let size = frame.size;
        report(surface, id, &mut m.reported, size, safe_area(surface));
    }

    /// Colors the screens' backgrounds for the appearance, when it changed
    /// since they were colored.
    fn follow_appearance(&mut self, surface: &Surface) {
        let dark = dark(surface);
        if self.dark.replace(dark).is_none_or(|d| d == dark) {
            return;
        }
        for s in self.screens.values() {
            set_layer_color(&s.backdrop, Some(window_color(dark)));
        }
    }

    fn active_modal(&self) -> Option<NodeId> {
        self.order.iter().rev().copied().find(|id| {
            self.modals
                .get(id)
                .and_then(|modal| modal.view.as_ref())
                .is_some_and(NshView::has_parent)
        })
    }
}

/// Where the keyboard focus may go: the newest presented modal (what is
/// under it cannot be used), else the whole surface.
pub(crate) fn focus_scope(surface: &Surface) -> Retained<NSView> {
    match surface.nav.try_borrow() {
        Ok(nav) => nav.scope(surface),
        Err(_) => Retained::from(surface.root.ns()),
    }
}

/// Goes back (the newest modal, the innermost stack or the app's
/// `onBackPress`): whether something took it. The mouse's back button
/// calls it too.
pub(crate) fn go_back(surface: &Rc<Surface>) -> bool {
    match surface.nav.try_borrow_mut() {
        Ok(mut nav) => crate::surface::quiet(|| nav.go_back(surface)),
        Err(_) => false,
    }
}

/// `Command::Back`: goes back as without the app's listeners, once the
/// batch being applied is in.
pub(crate) fn default_back(surface: &Rc<Surface>) {
    let key = surface.key();
    dispatch2::DispatchQueue::main().exec_async(move || {
        if let Some(surface) = Surface::with_key(key)
            && let Ok(mut nav) = surface.nav.try_borrow_mut()
        {
            crate::surface::quiet(|| nav.default_back(&surface));
        }
    });
}

/// True when an AppKit text field (its field editor) or text view has the
/// window's keyboard focus.
fn focused_field(surface: &Surface) -> bool {
    surface
        .root
        .ns()
        .window()
        .and_then(|w| w.firstResponder())
        .is_some_and(|r| r.downcast_ref::<NSText>().is_some())
}

/// A key nothing in the window used: Escape, Option+Left and Command+[ go
/// back. Whether it was taken. Escape in a focused text field or web view
/// only leaves it (a desktop convention: it never navigates away from what
/// is being typed); Option+Left and Command+[ still go back.
pub(crate) fn key_pressed(surface: &Rc<Surface>, event: &NSEvent) -> bool {
    const ESCAPE: u16 = 53;
    const LEFT: u16 = 123;
    let mods = event.modifierFlags()
        & (NSEventModifierFlags::Control
            | NSEventModifierFlags::Option
            | NSEventModifierFlags::Shift
            | NSEventModifierFlags::Command);
    let code = event.keyCode();
    let bracket = || crate::input::shortcut_key(event) == Some('[');
    let escape = code == ESCAPE && mods.is_empty();
    let back = escape
        || (code == LEFT && mods == NSEventModifierFlags::Option)
        || (mods == NSEventModifierFlags::Command && bracket());
    // A page's Escape reaches here only when the page let it go (WebKit
    // sends the keys a page does not use up the responder chain): it
    // hands the keyboard back to the app, as a field's does, rather than
    // closing the screen under a form being filled in. Option+Left and
    // Command+[ a page does not use still go back.
    if escape && (focused_field(surface) || crate::native::web_focused(surface)) {
        if let Some(window) = surface.root.ns().window() {
            window.makeFirstResponder(Some(surface.root.ns()));
        }
        return true;
    }
    back && go_back(surface)
}

/// A screen was pushed (`added`) or popped in `stack`.
pub(crate) fn stack_changed(surface: &Rc<Surface>, stack: &NshView, added: Option<&NshView>) {
    let mut nav = surface.nav.borrow_mut();
    let id = stack.id();
    let st = nav.stacks.entry(id).or_insert_with(|| StackNav {
        view: stack.clone(),
        screens: Stack::default(),
        top: None,
        image: None,
    });
    // The top screen just left: keep what it shows before the rest of the
    // batch takes its content apart.
    if added.is_none()
        && st.image.is_none()
        && let Some(top) = st.top.clone()
        && !top.has_parent()
    {
        st.image = shot(surface, &top).map(|image| (top.id(), image));
    }
    if let Some(screen) = added.filter(|v| v.kind() == ViewKind::Screen) {
        let state = nav.screen(surface, screen);
        let restoring = std::mem::take(&mut state.parked);
        if restoring {
            state.report(surface, stack);
            let children: Vec<_> = stack
                .child_views()
                .iter()
                .filter(|child| child.kind() == ViewKind::Screen)
                .map(NshView::id)
                .collect();
            if let Some(state) = nav.stacks.get_mut(&id) {
                state.screens.reconcile(&children);
            }
            nav.dirty.retain(|&stack| stack != id);
            nav.settle(surface, id);
            return;
        }
        // Hidden until the batch is reconciled: a screen pushed under the
        // top one must not flash.
        hide(surface, screen);
    }
    if !nav.dirty.contains(&id) {
        nav.dirty.push(id);
    }
}

/// A stack's frame changed.
pub(crate) fn stack_resized(surface: &Rc<Surface>, stack: &NshView) {
    let mut nav = surface.nav.borrow_mut();
    let nav = &mut *nav;
    let Some(st) = nav.stacks.get(&stack.id()) else {
        return;
    };
    for id in st.screens.shown() {
        if let Some(s) = nav.screens.get_mut(id) {
            s.report(surface, stack);
        }
    }
}

/// `ScreenConfig`.
pub(crate) fn screen_config(surface: &Rc<Surface>, view: &NshView, config: &ScreenConfig) {
    let mut nav = surface.nav.borrow_mut();
    let s = nav.screen(surface, view);
    s.config = config.clone();
    s.layout(surface);
    if let Some(stack) = view.parent_view().filter(|p| p.kind() == ViewKind::Stack) {
        s.report(surface, &stack);
    }
}

/// `ModalConfig`.
pub(crate) fn modal_config(surface: &Rc<Surface>, view: &NshView, config: &ModalConfig) {
    let mut nav = surface.nav.borrow_mut();
    let id = view.id();
    nav.modals.entry(id).or_default().config = *config;
    nav.size_modal(surface, id);
}

/// A modal was inserted: present it.
pub(crate) fn present(surface: &Rc<Surface>, view: &NshView) {
    let mut nav = surface.nav.borrow_mut();
    let id = view.id();
    let m = nav.modals.entry(id).or_default();
    if m.view.is_some() {
        if !view.has_parent() {
            view.insert_before(&surface.root, None);
            nav.size_modal(surface, id);
            nav.raise_modals(surface);
        }
        return;
    }
    m.view = Some(view.clone());
    m.closed = false;
    m.reported = Reported::default();
    m.focus_before = focused(surface);
    if view.has_parent() {
        view.unparent();
    }
    view.insert_before(&surface.root, None);
    nav.order.push(id);
    nav.size_modal(surface, id);
    nav.raise_modals(surface);
    // Animated in at the end of the batch, with the options it brings.
    nav.presenting.push(id);
}

/// A modal was removed: dismiss it.
pub(crate) fn dismiss(surface: &Rc<Surface>, view: &NshView) {
    let mut nav = surface.nav.borrow_mut();
    let id = view.id();
    if !view.has_parent()
        && let Some(modal) = nav.modals.get_mut(&id)
        && modal.view.is_some()
    {
        modal.view = None;
        modal.focus_before = None;
        modal.closed = false;
        nav.order.retain(|&modal| modal != id);
        return;
    }
    match nav.modals.get_mut(&id) {
        // The user closed it already, and it was reported.
        Some(m) if m.closed => m.closed = false,
        Some(_) => nav.close_modal(surface, id, false),
        None => {
            if view.has_parent() {
                drop_focus(surface, view.ns());
                view.unparent();
            }
        }
    }
}

/// Parks only the native root supplied by Core. Navigation participation
/// and capture end immediately, with no lifecycle event or focus return.
pub(crate) fn park_retired_root(surface: &Rc<Surface>, view: &NshView) {
    let id = view.id();
    let parent = view.parent_view();
    let mut nav = surface.nav.borrow_mut();
    let inside = |candidate: &NshView| candidate.ns().isDescendantOf(view.ns());
    for motion in nav.transitions.take(|motion| match motion {
        Motion::Push {
            stack,
            entering,
            below,
            ..
        } => inside(stack) || inside(entering) || below.as_ref().is_some_and(&inside),
        Motion::Pop {
            stack,
            owner,
            leaving,
            below,
            ..
        } => {
            *owner == id
                || inside(stack)
                || matches!(leaving, Leaving::View(leaving) if inside(leaving))
                || below.as_ref().is_some_and(&inside)
        }
        Motion::ModalIn { view, .. } => inside(view),
        Motion::ModalOut { id: owner, .. } => *owner == id,
    }) {
        let reset = |view: &NshView| {
            set_shift(view, (0.0, 0.0));
            set_fade(view, 1.0);
        };
        match motion {
            Motion::Push {
                entering, below, ..
            } => {
                reset(&entering);
                if let Some(below) = below {
                    reset(&below);
                }
            }
            Motion::Pop {
                stack,
                leaving,
                below,
                popped,
                ..
            } => {
                match leaving {
                    Leaving::View(leaving) => reset(&leaving),
                    Leaving::Image(image) => stack.remove_native(&image),
                }
                if let Some(below) = below {
                    reset(&below);
                }
                if let Some(id) = popped {
                    surface.event(id, EventKind::Dismiss, EventPayload::None);
                }
            }
            Motion::ModalIn { view, .. } => reset(&view),
            Motion::ModalOut { image, dismiss, .. } => {
                surface.root.remove_native(&image);
                if let Some(id) = dismiss {
                    surface.event(id, EventKind::Dismiss, EventPayload::None);
                }
            }
        }
    }
    nav.presenting.retain(|&modal| modal != id);
    if let Some(screen) = nav.screens.get_mut(&id) {
        screen.parked = true;
    }
    if view.kind() == ViewKind::HeaderItem
        && let Some(screen) = parent
            .as_ref()
            .and_then(|parent| nav.screens.get_mut(&parent.id()))
    {
        screen.items.retain(|item| item != view);
    }
    if view.kind() == ViewKind::Screen {
        // Keep the SDK's screen order and canonical popped membership;
        // hidden native roots cannot receive keyboard or pointer input.
        view.ns().setHidden(true);
    } else if view.has_parent() {
        view.unparent();
    }
    set_shift(view, (0.0, 0.0));
    set_fade(view, 1.0);
    if let Some(parent) = parent.filter(|parent| parent.kind() == ViewKind::Stack) {
        if let Some(stack) = nav.stacks.get_mut(&parent.id()) {
            if let Some((_, image)) = stack.image.take() {
                parent.remove_native(&image);
            }
        }
        nav.settle(surface, parent.id());
    }
}

/// Parked navigation records retain their live native configuration until
/// Insert or source Delete; deletion releases those strong native owners.
pub(crate) fn deleted_parked_root(surface: &Surface, view: &NshView) {
    let mut nav = surface.nav.borrow_mut();
    if view.kind() == ViewKind::Modal
        && !view.has_parent()
        && nav
            .modals
            .get(&view.id())
            .is_some_and(|modal| modal.view.is_some())
    {
        nav.modals.remove(&view.id());
        nav.order.retain(|&id| id != view.id());
        nav.presenting.retain(|&id| id != view.id());
    }
    if nav
        .screens
        .get(&view.id())
        .is_some_and(|screen| screen.parked)
    {
        nav.screens.remove(&view.id());
    }
}

/// A header item was inserted into `parent` (a screen).
pub(crate) fn header_item(surface: &Rc<Surface>, parent: &NshView, child: &NshView) {
    let mut nav = surface.nav.borrow_mut();
    if child.parent_view().as_ref() != Some(parent) {
        if child.has_parent() {
            child.unparent();
        }
        child.insert_before(parent, None);
    }
    let s = nav.screen(surface, parent);
    if !s.items.contains(child) {
        s.items.push(child.clone());
    }
    // Shown by the screen's layout at the end of the batch when it is the
    // `header` (the core places it).
    hide(surface, child);
}

/// A header item was removed.
pub(crate) fn header_item_removed(surface: &Rc<Surface>, view: &NshView) {
    let mut nav = surface.nav.borrow_mut();
    if let Some(screen) = view.parent_view()
        && let Some(s) = nav.screens.get_mut(&screen.id())
    {
        s.items.retain(|v| v != view);
    }
    if view.has_parent() {
        drop_focus(surface, view.ns());
        view.unparent();
    }
    show(view);
    set_shift(view, (0.0, 0.0));
}

/// The surface was resized (modals follow).
pub(crate) fn surface_resized(surface: &Surface, _width: f32, _height: f32) {
    let Ok(mut nav) = surface.nav.try_borrow_mut() else {
        return;
    };
    for id in nav.order.clone() {
        nav.size_modal(surface, id);
    }
}

/// A batch was applied.
pub(crate) fn end_batch(surface: &Rc<Surface>) {
    let mut nav = surface.nav.borrow_mut();
    nav.follow_appearance(surface);
    for stack in std::mem::take(&mut nav.dirty) {
        nav.reconcile(surface, stack);
    }
    for id in std::mem::take(&mut nav.presenting) {
        nav.show_modal(surface, id);
    }
    // Screen sizes change with the app's layout.
    for s in nav.screens.values_mut() {
        s.layout(surface);
        s.raise_header();
    }
    if !nav.order.is_empty() || !nav.transitions.is_empty() {
        nav.raise_modals(surface);
    }
}
