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
    surface::{Next, Surface},
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
    /// The root it is presented over while it is: the surface's, or that
    /// of the window of the app's own it belongs to (`ModalConfig.window`).
    host: Option<NshView>,
    /// The user closed it natively (`closeOnEscape`) and it was reported:
    /// the app's removal only forgets it.
    closed: bool,
    reported: Reported,
    /// The input or Tab stop that had the keyboard focus when it was
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
        leaving: Leaving,
        below: Option<NshView>,
        fade: bool,
        /// The screen the user popped: hidden and reported at the end.
        popped: Option<NodeId>,
    },
    ModalIn {
        view: NshView,
        /// The root it comes in over.
        host: NshView,
        fade: bool,
    },
    ModalOut {
        /// The root it leaves from.
        host: NshView,
        /// The modal to report `onDismiss` for at the end (`None`: it was
        /// reported when the user closed it).
        dismiss: Option<NodeId>,
        image: Shot,
        /// Where the modal was.
        frame: Bounds<Points>,
        fade: bool,
    },
    /// A motion drawn through the page's or dialog's `transitionShader`:
    /// its views at rest under the overlay until it ends.
    Shader {
        overlay: Box<crate::shader::NavOverlay>,
        motion: Box<Motion>,
    },
}

impl Motion {
    fn stack(&self) -> Option<NodeId> {
        match self.inner() {
            Motion::Push { stack, .. } | Motion::Pop { stack, .. } => Some(stack.id()),
            _ => None,
        }
    }

    /// A dialog's coming or going drawn through its shader (over the
    /// surface's root).
    fn through_shader_over_root(&self) -> bool {
        matches!(self, Motion::Shader { .. })
            && matches!(
                self.inner(),
                Motion::ModalIn { .. } | Motion::ModalOut { .. }
            )
    }

    /// The motion itself, whether or not drawn through a shader.
    fn inner(&self) -> &Motion {
        match self {
            Motion::Shader { motion, .. } => motion.inner(),
            m => m,
        }
    }

    /// Draws `self` through `shader` instead: pictures of the view it
    /// happens in without and with the upper side (what comes, or what
    /// leaves: backwards), its views at rest. `self` when there is nothing
    /// to draw it over (its views at rest: [`Nav::start`] puts them back).
    fn through(self, surface: &Surface, shader: &nsh_core::NavShader) -> Motion {
        let rest = |v: &NshView| {
            set_shift(v, (0.0, 0.0));
            set_fade(v, 1.0);
        };
        let (host, upper, image, backwards) = match &self {
            Motion::Push {
                stack,
                entering,
                below,
                ..
            } => {
                rest(entering);
                below.iter().for_each(rest);
                (stack, Retained::from(entering.ns()), None, false)
            }
            Motion::Pop {
                stack,
                leaving,
                below,
                ..
            } => {
                below.iter().for_each(rest);
                let (upper, image) = match leaving {
                    Leaving::View(v) => {
                        rest(v);
                        (Retained::from(v.ns()), None)
                    }
                    Leaving::Image(image) => {
                        image.set_opacity(1.0);
                        (
                            Retained::into_super(image.fill.clone()),
                            Some(image.image.clone()),
                        )
                    }
                };
                (stack, upper, image, true)
            }
            Motion::ModalIn { view, host, .. } => {
                rest(view);
                (host, Retained::from(view.ns()), None, false)
            }
            Motion::ModalOut { image, host, .. } => {
                image.set_opacity(1.0);
                (
                    host,
                    Retained::into_super(image.fill.clone()),
                    Some(image.image.clone()),
                    true,
                )
            }
            Motion::Shader { .. } => return self,
        };
        let overlay =
            crate::shader::NavOverlay::new(surface, host, &upper, image, shader, backwards);
        match overlay {
            Some(overlay) => Motion::Shader {
                overlay: Box::new(overlay),
                motion: Box::new(self),
            },
            None => self,
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
    /// The `transitionShader`s of pages and dialogs.
    shaders: FxHashMap<NodeId, nsh_core::NavShader>,
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
/// giving it to the root of its window.
fn drop_focus(surface: &Surface, view: &NSView) {
    let Some(window) = view.window() else { return };
    let Some(responder) = window.firstResponder() else {
        return;
    };
    if responder
        .downcast_ref::<NSView>()
        .is_some_and(|r| r.isDescendantOf(view))
    {
        let root = crate::window::root_in(surface, &window).unwrap_or_else(|| surface.root.clone());
        window.makeFirstResponder(Some(root.ns()));
    }
}

/// The root a modal with `config` is presented over: that of the window of
/// the app's own it belongs to, else the surface's.
fn modal_host(surface: &Surface, id: NodeId, config: &ModalConfig) -> NshView {
    let window = config.window;
    if window != ROOT_ID
        && window != id
        && let Some(root) = crate::window::root_view(surface, window)
    {
        return root;
    }
    surface.root.clone()
}

/// The input or Tab stop that has the keyboard focus in the window of
/// `root` (not the root, which holds it when nothing else does). A field
/// edits in the window's shared field editor, a subview of the field only
/// while it edits, and a text view sits in a scroll view: the input is the
/// responder's nearest view of ours.
fn focused(root: &NshView) -> Option<objc2::rc::Weak<ViewObj>> {
    let root = root.ns();
    let responder = root.window()?.firstResponder()?;
    let mut at = responder.downcast::<NSView>().ok()?;
    if !at.isDescendantOf(root) {
        return None;
    }
    while &*at != root {
        if let Some(view) = NshView::from_ns(&at)
            && ((view.kind() == ViewKind::Input && view.can_reach())
                || crate::input::is_key_stop(&view))
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
    let Some(window) = scope.window() else {
        return;
    };
    let root = crate::window::root_in(surface, &window).unwrap_or_else(|| surface.root.clone());
    // Nothing else took it meanwhile: the root, or the window itself,
    // holds it.
    let at_root = window
        .firstResponder()
        .is_none_or(|r| r.downcast_ref::<NSView>().is_none_or(|v| v == root.ns()));
    if !at_root || view.ns().window().is_none() || !view.ns().isDescendantOf(scope) {
        return;
    }
    if view.kind() == ViewKind::Input {
        if view.can_reach() {
            crate::text_input::focus(&view);
        }
    } else if crate::input::is_key_stop(&view) {
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
    if crate::visual::draws_outside(&view.state().style) {
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
    let scale = view
        .ns()
        .window()
        .or_else(|| surface.root.ns().window())
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
        // Out of the tree AppKit no longer flips its layers: drawn as it
        // showed in it.
        let detached = layer.superlayer().is_none() && !layer.isGeometryFlipped();
        if detached {
            layer.setGeometryFlipped(true);
        }
        layer.renderInContext(&context);
        if detached {
            layer.setGeometryFlipped(false);
        }
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
    /// What it shows (a page's or a dialog's `transitionShader` reads it).
    image: CFRetained<CGImage>,
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
    Some(Shot {
        fill,
        image,
        _lent: lent,
    })
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
        }
    }

    /// Reports the screen's size (its stack's) and insets: the window's
    /// safe area, but the top's when its `header` covers it.
    fn report(&mut self, surface: &Surface, stack: &NshView) {
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
            if let Motion::ModalOut { image, .. } = motion.inner() {
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
            Motion::Shader { overlay, .. } => overlay.tick(surface),
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
            Motion::ModalIn { view, host, fade } => {
                if *fade {
                    set_fade(view, e);
                } else {
                    // From below the window's bottom edge (its shadow
                    // too).
                    let h = host.state().frame.size.height.0 + shadow_room(view);
                    let y = view.state().frame.origin.y.0;
                    set_shift(view, (0.0, modal_in_offset(Points(h - y), e).0));
                }
            }
            Motion::ModalOut {
                image,
                host,
                frame,
                fade,
                ..
            } => {
                let h = host.state().frame.size.height.0;
                let y = if *fade {
                    image.set_opacity(1.0 - e);
                    frame.origin.y.0
                } else {
                    frame.origin.y.0 + modal_out_offset(Points(h - frame.origin.y.0), e).0
                };
                host.set_native(
                    image,
                    rect(frame.origin.x.0, y, frame.size.width.0, frame.size.height.0),
                );
            }
        }
    }

    fn end(&mut self, surface: &Surface, motion: Motion) {
        if let Motion::Shader { overlay, motion } = motion {
            // The views go where they end under the overlay, then it goes.
            self.end(surface, *motion);
            drop(overlay);
            return;
        }
        self.apply(surface, &motion, 1.0);
        match motion {
            Motion::Shader { .. } => {}
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
            Motion::ModalOut {
                dismiss,
                image,
                host,
                ..
            } => {
                host.remove_native(&image);
                if let Some(id) = dismiss {
                    surface.event(id, EventKind::Dismiss, EventPayload::None);
                }
            }
        }
    }

    /// Shows only the top screen of `stack`, where it belongs.
    fn settle(&mut self, surface: &Surface, stack: NodeId) {
        let Some(st) = self.stacks.get_mut(&stack) else {
            return;
        };
        let top = st.screens.top();
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

    /// Starts `motion` through `shader` for the shader's duration; where
    /// there is none or it cannot be drawn, as the page's or the dialog's
    /// own motion for `own` (`None`: its `animation` is `"none"`, so it
    /// ends at once, never moving for the shader's duration).
    fn start(
        &mut self,
        surface: &Rc<Surface>,
        own: Option<Duration>,
        motion: Motion,
        shader: Option<&nsh_core::NavShader>,
    ) {
        self.apply(surface, &motion, 0.0);
        let motion = match shader {
            Some(shader) => motion.through(surface, shader),
            None => motion,
        };
        let duration = match (&motion, shader) {
            (Motion::Shader { .. }, Some(shader)) => shader.duration + crate::shader::LINGER,
            _ => {
                let Some(duration) = own else {
                    self.end(surface, motion);
                    return;
                };
                // Nothing to draw it over: the motion itself, from its
                // start.
                self.apply(surface, &motion, 0.0);
                duration
            }
        };
        self.transitions.push(duration, motion);
        if self.ticking {
            return;
        }
        self.ticking = true;
        surface.add_frame_callback(|surface, now| {
            let Ok(mut nav) = surface.nav.try_borrow_mut() else {
                return Next::At(now);
            };
            nav.tick(surface, now);
            match nav.transitions.deadline(now) {
                Some(at) => Next::At(at),
                None => {
                    nav.ticking = false;
                    Next::Done
                }
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

    /// The `transitionShader` page or dialog `id` comes and goes through
    /// (none when motion is reduced, or where there is no GPU device to
    /// draw it: the page or dialog then comes and goes with its own
    /// `animation`).
    fn shader(&self, surface: &Surface, id: NodeId) -> Option<nsh_core::NavShader> {
        let reduce = surface.environment.get().reduce_motion;
        self.shaders
            .get(&id)
            .filter(|_| !reduce && surface.shaders.renderer().is_some())
            .cloned()
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
        let (old, new) = (prev.last().copied(), desired.last().copied());
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
        let leaving_shader = old.and_then(|id| self.shader(surface, id));
        for id in &prev {
            if find(*id).is_none() {
                self.screens.remove(id);
                self.shaders.remove(id);
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
        let shader = if pushing {
            self.shader(surface, new)
        } else {
            leaving_shader
        };
        let own = Self::screen_motion(surface, animation.unwrap_or_default());
        if own.is_none() && shader.is_none() {
            return;
        }
        let fade = own.is_some_and(|(_, fade)| fade);
        let own = own.map(|(duration, _)| duration);
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
            self.start(surface, own, motion, shader.as_ref());
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
                leaving,
                below: find(new),
                fade,
                popped: None,
            };
            self.start(surface, own, motion, shader.as_ref());
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
        let shader = self.shader(surface, top);
        let own = Self::screen_motion(surface, animation.unwrap_or_default());
        match (own.is_some() || shader.is_some(), find(top)) {
            (true, Some(leaving)) => {
                if let Some(b) = &below {
                    show(b);
                }
                let motion = Motion::Pop {
                    stack,
                    leaving: Leaving::View(leaving),
                    below,
                    fade: own.is_some_and(|(_, fade)| fade),
                    popped: Some(top),
                };
                self.start(surface, own.map(|(d, _)| d), motion, shader.as_ref());
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
            st.view.is_shown_in_tree()
                && nsh_core::navigation::shown_in_layout(
                    std::iter::successors(Some(st.view.clone()), NshView::parent_view)
                        .filter(|v| v.parent_view().is_some())
                        .map(|v| v.state().frame),
                )
                && within.is_none_or(|w| st.view.ns().isDescendantOf(w.ns()))
                && st.screens.takes_back(|top| {
                    self.screens
                        .get(&top)
                        .is_some_and(|s| s.config.prevent_back)
                })
        };
        let candidates: Vec<&StackNav> = self.stacks.values().filter(|s| wants(s)).collect();
        innermost(&candidates, |c, o| o.view.ns().isDescendantOf(c.view.ns())).map(|c| c.view.id())
    }

    /// Where the keyboard focus may go in the window of `root`
    /// ([`focus_scope`]).
    fn scope(&self, root: &NshView) -> Retained<NSView> {
        self.newest_in(root)
            .and_then(|id| self.modals.get(&id)?.view.as_ref())
            .map_or_else(|| Retained::from(root.ns()), |v| Retained::from(v.ns()))
    }

    /// The newest modal presented over `root`.
    fn newest_in(&self, root: &NshView) -> Option<NodeId> {
        self.order.iter().rev().copied().find(|id| {
            self.modals
                .get(id)
                .is_some_and(|m| m.host.as_ref() == Some(root))
        })
    }

    /// Takes modal `id` away natively (it leaves as an image of its last
    /// frame), then reports `onDismiss` unless `reported` already.
    fn close_modal(&mut self, surface: &Rc<Surface>, id: NodeId, reported: bool) {
        // Its own coming, and any dialog's change through a shader, end
        // first.
        self.finish(surface, |m| {
            m.through_shader_over_root()
                || matches!(m.inner(), Motion::ModalIn { view, .. } if view.id() == id)
        });
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
        let host = m.host.take().unwrap_or_else(|| surface.root.clone());
        let focus_before = m.focus_before.take();
        let frame = view.state().frame;
        let animation = m.config.animation;
        let shader = self.shader(surface, id);
        let own = modal_motion(surface, animation);
        let animates = own.is_some() || shader.is_some();
        let shown = view.ns().window().is_some();
        let image = (animates && shown).then(|| shot(surface, &view)).flatten();
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
        restore_focus(surface, &self.scope(&host), focus_before);
        set_shift(&view, (0.0, 0.0));
        set_fade(&view, 1.0);
        match (own, image) {
            (own, Some(image)) => {
                host.set_native(
                    &image,
                    rect(
                        frame.origin.x.0,
                        frame.origin.y.0,
                        frame.size.width.0,
                        frame.size.height.0,
                    ),
                );
                let motion = Motion::ModalOut {
                    host,
                    dismiss: (!reported).then_some(id),
                    image,
                    frame,
                    fade: own.is_some_and(|(_, fade)| fade),
                };
                self.start(surface, own.map(|(d, _)| d), motion, shader.as_ref());
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
        let host = m.host.clone().unwrap_or_else(|| surface.root.clone());
        let own = modal_motion(surface, m.config.animation);
        // A dialog's change through a shader that still runs ends first.
        self.finish(surface, Motion::through_shader_over_root);
        let shader = self.shader(surface, id);
        if own.is_none() && shader.is_none() {
            surface.event(id, EventKind::Show, EventPayload::None);
            return;
        }
        let fade = own.is_some_and(|(_, fade)| fade);
        let motion = Motion::ModalIn { view, host, fade };
        self.start(surface, own.map(|(d, _)| d), motion, shader.as_ref());
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
    ///
    /// In the window of `root`: a window of the app's own has its modals
    /// and stacks, and no `onBackPress`.
    fn go_back(&mut self, surface: &Rc<Surface>, root: &NshView) -> bool {
        if *root == surface.root
            && self.newest_in(root).is_none()
            && surface.root.state().events.contains(EventKind::BackPress)
        {
            surface.event(ROOT_ID, EventKind::BackPress, EventPayload::None);
            return true;
        }
        self.default_back(surface, root)
    }

    /// Going back as without the app's listeners (`Command::Back`): a
    /// stack inside the newest modal pops, else the modal asks to close,
    /// else the innermost stack pops. Whether something took it.
    fn default_back(&mut self, surface: &Rc<Surface>, root: &NshView) -> bool {
        let target = back_target(self.newest_in(root), false, |modal| {
            let view = modal.and_then(|id| self.modals.get(&id)?.view.clone());
            self.back_stack(Some(view.as_ref().unwrap_or(root)))
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
        // Over the root each is presented over (the surface's, a window's).
        let mut tails: Vec<(NshView, Vec<Retained<NSView>>)> = Vec::new();
        let mut push = |host: &NshView, view: Retained<NSView>| match tails
            .iter_mut()
            .find(|(h, _)| h == host)
        {
            Some((_, tail)) => tail.push(view),
            None => tails.push((host.clone(), vec![view])),
        };
        for m in self.order.iter().filter_map(|id| self.modals.get(id)) {
            if let Some(view) = &m.view {
                push(
                    m.host.as_ref().unwrap_or(&surface.root),
                    Retained::from(view.ns()),
                );
            }
        }
        for motion in self.transitions.iter() {
            if let Motion::ModalOut { image, host, .. } = motion.inner() {
                push(host, Retained::into_super(image.fill.clone()));
            }
        }
        for (host, tail) in tails {
            keep_last(host.ns(), &tail);
        }
    }

    /// Sizes modal `id` to the surface and reports it (with the surface's
    /// safe area).
    fn size_modal(&mut self, surface: &Surface, id: NodeId) {
        let Some(m) = self.modals.get_mut(&id) else {
            return;
        };
        let Some(view) = &m.view else { return };
        let host = m.host.as_ref().unwrap_or(&surface.root);
        let f = host.state().frame;
        let frame = rect(0.0, 0.0, f.size.width.0, f.size.height.0);
        if std::mem::replace(&mut view.state_mut().frame, frame) != frame {
            view.moved();
        }
        let size = frame.size;
        // A window of the app's own has no safe area of the surface's.
        let insets = if *host == surface.root {
            safe_area(surface)
        } else {
            EdgeInsets::default()
        };
        report(surface, id, &mut m.reported, size, insets);
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
}

/// Where the keyboard focus may go: the newest presented modal (what is
/// under it cannot be used), else the whole surface.
pub(crate) fn focus_scope(surface: &Surface) -> Retained<NSView> {
    // In a window of the app's own, the window's root: the main window's
    // modals are over the main window only.
    focus_scope_in(surface, &crate::input::event_root(surface))
}

fn focus_scope_in(surface: &Surface, root: &NshView) -> Retained<NSView> {
    match surface.nav.try_borrow() {
        Ok(nav) => nav.scope(root),
        Err(_) => Retained::from(root.ns()),
    }
}

/// [`focus_scope`] of `window`, for focus that does not come from an event
/// in it (`focus()`, `autoFocus`): outside one, the surface's event root is
/// the main window.
pub(crate) fn focus_scope_of(
    surface: &Surface,
    window: &objc2_app_kit::NSWindow,
) -> Retained<NSView> {
    let root = crate::window::root_in(surface, window)
        .unwrap_or_else(|| crate::input::event_root(surface));
    focus_scope_in(surface, &root)
}

/// Whether `view` is in the focus scope of the window it is in.
pub(crate) fn in_focus_scope(surface: &Surface, view: &NSView) -> bool {
    view.window()
        .is_some_and(|window| view.isDescendantOf(&focus_scope_of(surface, &window)))
}

/// Goes back (the newest modal, the innermost stack or the app's
/// `onBackPress`): whether something took it. The mouse's back button
/// calls it too.
pub(crate) fn go_back(surface: &Rc<Surface>) -> bool {
    match surface.nav.try_borrow_mut() {
        Ok(mut nav) => {
            let root = crate::input::event_root(surface);
            crate::surface::quiet(|| nav.go_back(surface, &root))
        }
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
            crate::surface::quiet(|| nav.default_back(&surface, &surface.root));
        }
    });
}

/// True when an AppKit text field (its field editor) or text view has the
/// window's keyboard focus.
fn focused_field(root: &NshView) -> bool {
    root.ns()
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
    if escape && crate::text_input::composing_focused(surface) {
        return true;
    }
    if escape {
        crate::text_input::disarm(surface);
    }
    let root = crate::input::event_root(surface);
    if escape && (focused_field(&root) || crate::native::web_focused(surface)) {
        if let Some(window) = root.ns().window() {
            window.makeFirstResponder(Some(root.ns()));
        }
        return true;
    }
    // In the window the key is in (the main one, a window of the app's
    // own): its modals and stacks, then its `closeOnEscape`.
    (back && go_back(surface)) || (escape && crate::window::escape(surface))
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
        nav.screen(surface, screen);
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
    if crate::window::is_window(surface, view.id()) {
        return;
    }
    let mut nav = surface.nav.borrow_mut();
    let id = view.id();
    nav.modals.entry(id).or_default().config = *config;
    nav.size_modal(surface, id);
}

/// The `transitionShader` page or dialog `view` comes and goes through
/// (`None`: its `animation`).
pub(crate) fn set_shader(
    surface: &Rc<Surface>,
    view: &NshView,
    shader: Option<nsh_core::NavShader>,
) {
    let mut nav = surface.nav.borrow_mut();
    match shader {
        Some(shader) => nav.shaders.insert(view.id(), shader),
        None => nav.shaders.remove(&view.id()),
    };
}

/// `view` is deleted: a dialog's `transitionShader` goes with it (a
/// page's leaves in [`Nav::reconcile`], which reads it first when the page
/// was the one on top).
pub(crate) fn deleted(surface: &Surface, view: &NshView) {
    if view.kind() == ViewKind::Modal {
        surface.nav.borrow_mut().shaders.remove(&view.id());
    }
}

/// A modal was inserted: present it.
pub(crate) fn present(surface: &Rc<Surface>, view: &NshView) {
    if crate::window::is_window(surface, view.id()) {
        return;
    }
    let host = {
        let mut nav = surface.nav.borrow_mut();
        let id = view.id();
        let m = nav.modals.entry(id).or_default();
        if m.view.is_some() {
            return;
        }
        let host = modal_host(surface, id, &m.config);
        m.view = Some(view.clone());
        m.host = Some(host.clone());
        m.closed = false;
        m.reported = Reported::default();
        m.focus_before = focused(&host);
        if view.has_parent() {
            view.unparent();
        }
        view.insert_before(&host, None);
        nav.order.push(id);
        nav.size_modal(surface, id);
        nav.raise_modals(surface);
        // Animated in at the end of the batch, with the options it brings.
        nav.presenting.push(id);
        host
    };
    if let Some(window) = host.ns().window()
        && window.firstResponder().is_some_and(|r| {
            r.downcast_ref::<NSView>().is_some_and(|v| {
                v != host.ns() && v.isDescendantOf(host.ns()) && !v.isDescendantOf(view.ns())
            })
        })
    {
        crate::text_input::to_root(&window, surface);
    }
}

/// Modal `id` is shown in a window of its own (`Window.open`) instead:
/// it leaves the surface's modals at once, without events or animation,
/// and the focus it took goes back.
pub(crate) fn release(surface: &Rc<Surface>, id: NodeId) {
    let mut nav = surface.nav.borrow_mut();
    nav.order.retain(|&m| m != id);
    nav.presenting.retain(|&m| m != id);
    let Some(mut m) = nav.modals.remove(&id) else {
        return;
    };
    if let Some(view) = m.view.take()
        && view.has_parent()
    {
        drop_focus(surface, view.ns());
    }
    let host = m.host.take().unwrap_or_else(|| surface.root.clone());
    let scope = nav.scope(&host);
    restore_focus(surface, &scope, m.focus_before.take());
}

/// A modal was removed: dismiss it.
pub(crate) fn dismiss(surface: &Rc<Surface>, view: &NshView) {
    if crate::window::removed(surface, view) {
        return;
    }
    let mut nav = surface.nav.borrow_mut();
    let id = view.id();
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

/// The root of a window of the app's own was resized: the modals over it
/// follow.
pub(crate) fn window_resized(surface: &Surface, root: &NshView) {
    let Ok(mut nav) = surface.nav.try_borrow_mut() else {
        return;
    };
    let ids: Vec<NodeId> = nav
        .order
        .iter()
        .copied()
        .filter(|id| {
            nav.modals
                .get(id)
                .is_some_and(|m| m.host.as_ref() == Some(root))
        })
        .collect();
    for id in ids {
        nav.size_modal(surface, id);
    }
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
