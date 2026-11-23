//! Navigation stacks, screens, modals.
//!
//! A stack's screens are its child views; only the top one shows (and the
//! one below it while a transition runs): the others are not child
//! visible, so GTK neither draws nor picks them. Changes of the app's
//! screens are reconciled at the end of each batch, once every item is
//! applied: a new top screen slides in from the right over the previous
//! one (which moves left a bit, as GNOME's navigation view does); a top
//! screen the app removes slides out as the image it last showed (a
//! `gtk::WidgetPaintable` of the top screen keeps it when the view is
//! unmapped, as the same batch tears its content down).
//!
//! NSH draws no header: a screen's `header` (the app's view,
//! [`ScreenConfig::header_view`]) is a child of the screen whose frame the
//! core sets at its top (as wide as the screen, as tall as it lays out),
//! with the content laid out below it; it is kept above the content. The
//! other header items (the native header's slots on iOS and Android) stay
//! hidden. Under the app's content each screen has an opaque backdrop in
//! the window's color, so a screen sliding over another hides it.
//!
//! Going back (Escape, Alt+Left, the Back key, the mouse's back button;
//! Escape in a focused text field or page only leaves it; the others go
//! back in a page's history first while the page has the focus, or the
//! pointer for the mouse button) sends `onBackPress` (`BackRequest`) to the
//! top screen when the app listens, then pops natively unless its
//! `popOnBack` is false, then sends `onDismiss`, which removes the route in
//! JS; until the app removes the screen it is `popped` and ignored. The
//! answer comes from props mounted beforehand, never from JS. The newest
//! modal comes first: a stack inside it pops, else it gets
//! `onRequestClose` (reason `"cancel"`; with `closeOnEscape` it also closes
//! natively, and gets `onDismiss` right after).
//!
//! Modals are children of the surface's root, kept above the app's views,
//! at the size of the surface: transparent layers with no look of their own
//! (the runtime renders the app's popup and backdrop in them; the
//! presentation is ignored). They slide up or fade in, then get `onShow`;
//! when the app removes one it leaves as an image of its last frame, then
//! gets `onDismiss`.
//!
//! Transitions run on the surface's frames ([`Surface::add_frame_callback`]:
//! the root's frame clock, and their ends kept while it stops) and only
//! move views (`shift`, `fade`): nothing is laid out again while they run.

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    time::Duration,
};

use gtk4::{self as gtk, gdk, glib, graphene, gsk, prelude::*, subclass::prelude::*};
use nsh_core::{
    Bounds, EdgeInsets, EventKind, EventPayload, ModalAnimation, ModalConfig, NodeId, PayloadValue,
    Point, Points, ROOT_ID, ScreenAnimation, ScreenConfig, Size, ViewKind,
    navigation::{
        Back, Reported, Stack, Tick, Transitions, back_target, innermost, insets_payload,
        modal_in_offset, modal_out_offset, pop_offsets, push_offsets,
    },
};
use nsh_engine::ColorScheme;
use rustc_hash::FxHashMap;

use crate::{
    surface::{Next, Surface},
    view::NshView,
};

/// The window's color (libadwaita's), under a screen's content, so a screen
/// moving over another hides it.
fn window_color(dark: bool) -> gdk::RGBA {
    if dark {
        gdk::RGBA::new(0.141, 0.141, 0.141, 1.0)
    } else {
        gdk::RGBA::new(0.98, 0.98, 0.98, 1.0)
    }
}

mod imp {
    use super::*;

    /// See [`super::Layer`].
    #[derive(Default)]
    pub(crate) struct Layer {
        pub(crate) fill: Cell<Option<gdk::RGBA>>,
        pub(crate) node: RefCell<Option<gsk::RenderNode>>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for Layer {
        const NAME: &'static str = "NshNavLayer";
        type Type = super::Layer;
        type ParentType = gtk::Widget;
    }

    impl ObjectImpl for Layer {}

    impl WidgetImpl for Layer {
        fn measure(&self, _orientation: gtk::Orientation, _for_size: i32) -> (i32, i32, i32, i32) {
            (0, 0, -1, -1)
        }

        fn snapshot(&self, snapshot: &gtk::Snapshot) {
            let obj = self.obj();
            let (w, h) = (obj.width() as f32, obj.height() as f32);
            if let Some(c) = self.fill.get() {
                snapshot.append_color(&c, &graphene::Rect::new(0.0, 0.0, w, h));
            }
            if let Some(node) = &*self.node.borrow() {
                snapshot.append_node(node);
            }
        }
    }
}

glib::wrapper! {
    /// A plain drawing a view hosts: a fill (a screen's background) or the
    /// last image of a screen or modal that is leaving.
    pub(crate) struct Layer(ObjectSubclass<imp::Layer>)
        @extends gtk::Widget,
        @implements gtk::Accessible, gtk::Buildable, gtk::ConstraintTarget;
}

impl Layer {
    fn new() -> Self {
        let layer: Layer = glib::Object::new();
        layer.set_can_target(false);
        layer.set_focusable(false);
        layer
    }

    fn set_fill(&self, fill: Option<gdk::RGBA>) {
        if self.imp().fill.replace(fill) != fill {
            self.queue_draw();
        }
    }

    fn set_node(&self, node: Option<gsk::RenderNode>) {
        *self.imp().node.borrow_mut() = node;
        self.queue_draw();
    }
}

/// One screen.
struct ScreenNav {
    view: NshView,
    config: ScreenConfig,
    /// Its opaque background, under the app's content.
    backdrop: Layer,
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
    /// Watches the top screen: keeps its last image when it is unmapped.
    paintable: Option<(NodeId, gtk::WidgetPaintable)>,
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
    /// Watches it while it is presented: keeps its last image.
    paintable: Option<gtk::WidgetPaintable>,
    /// What had the keyboard focus when it was presented: it gets it back
    /// when the modal closes, as a desktop dialog gives it back.
    restore: Option<glib::WeakRef<NshView>>,
}

/// What leaves the screen during a pop.
enum Leaving {
    /// The screen itself (popped by the user).
    View(NshView),
    /// The image of a screen the app removed, hosted by the stack.
    Image(Layer),
}

enum Motion {
    Push {
        stack: NshView,
        entering: NshView,
        below: Option<NshView>,
        fade: bool,
        shader: Option<NavRun>,
    },
    Pop {
        stack: NshView,
        leaving: Leaving,
        below: Option<NshView>,
        fade: bool,
        /// The screen the user popped: hidden and reported at the end.
        popped: Option<NodeId>,
        shader: Option<NavRun>,
    },
    ModalIn {
        view: NshView,
        /// The root view it shows in (its window's).
        host: NshView,
        fade: bool,
        shader: Option<NavRun>,
    },
    ModalOut {
        /// The modal to report `onDismiss` for at the end (`None`: it was
        /// reported when the user closed it).
        dismiss: Option<NodeId>,
        /// The root view it showed in (its window's).
        host: NshView,
        layer: Layer,
        /// Where the modal was.
        frame: Bounds<Points>,
        fade: bool,
        shader: Option<NavRun>,
    },
}

/// A page's or a dialog's transition through a shader that runs: a layer
/// over the stack (the root for a dialog) showing a
/// [`crate::shader::NavPainter`]'s node, moved on the shader's own clock
/// while the views stand where they end under it.
struct NavRun {
    host: NshView,
    layer: Layer,
    painter: std::cell::RefCell<crate::shader::NavPainter>,
    duration: Duration,
}

impl NavRun {
    fn tick(&self) {
        let node = self.painter.borrow_mut().node(&self.layer);
        self.layer.set_node(Some(node));
    }
}

impl Drop for NavRun {
    fn drop(&mut self) {
        self.host.remove_native(&self.layer);
    }
}

impl Motion {
    fn overlay(&self) -> Option<&NavRun> {
        match self {
            Motion::Push { shader, .. }
            | Motion::Pop { shader, .. }
            | Motion::ModalIn { shader, .. }
            | Motion::ModalOut { shader, .. } => shader.as_ref(),
        }
    }

    /// Draws the transition through `shader` over the view it happens in:
    /// pictures of its lower side (without the upper one) and of its upper
    /// side, the views at rest.
    fn add_overlay(&mut self, surface: &Surface, shader: &nsh_core::NavShader) {
        use crate::shader::{NavPainter, nav_picture};
        // Without a GPU device it keeps its own motion.
        if surface.shader_renderer().is_none() {
            return;
        }
        let rest = |v: &NshView| {
            set_shift(v, (0.0, 0.0));
            set_fade(v, 1.0);
        };
        // The host, the upper view (or image) and whether it goes.
        let (host, upper, image, reverse): (NshView, Option<NshView>, Option<gtk::Widget>, bool) =
            match self {
                Motion::Push {
                    stack,
                    entering,
                    below,
                    ..
                } => {
                    rest(entering);
                    below.iter().for_each(rest);
                    (stack.clone(), Some(entering.clone()), None, false)
                }
                Motion::Pop {
                    stack,
                    leaving,
                    below,
                    ..
                } => {
                    below.iter().for_each(rest);
                    match leaving {
                        Leaving::View(v) => {
                            rest(v);
                            (stack.clone(), Some(v.clone()), None, true)
                        }
                        Leaving::Image(layer) => {
                            layer.set_opacity(1.0);
                            (stack.clone(), None, Some(layer.clone().upcast()), true)
                        }
                    }
                }
                Motion::ModalIn { view, host, .. } => {
                    rest(view);
                    (host.clone(), Some(view.clone()), None, false)
                }
                Motion::ModalOut { layer, host, .. } => {
                    layer.set_opacity(1.0);
                    (host.clone(), None, Some(layer.clone().upcast()), true)
                }
            };
        let (Some(from), Some(to)) = (
            nav_picture(&host, upper.as_ref(), image.as_ref()),
            nav_picture(&host, None, None),
        ) else {
            return;
        };
        let size = host.state().frame.size;
        let Some(painter) = NavPainter::new(
            surface,
            &shader.layer,
            (&from, &to),
            size,
            shader.duration,
            reverse,
        ) else {
            return;
        };
        let layer = Layer::new();
        host.set_native(&layer, rect(0.0, 0.0, size.width.0, size.height.0));
        let run = NavRun {
            host,
            layer,
            painter: std::cell::RefCell::new(painter),
            duration: shader.duration,
        };
        run.tick();
        match self {
            Motion::Push { shader, .. }
            | Motion::Pop { shader, .. }
            | Motion::ModalIn { shader, .. }
            | Motion::ModalOut { shader, .. } => *shader = Some(run),
        }
    }

    fn stack(&self) -> Option<NodeId> {
        match self {
            Motion::Push { stack, .. } | Motion::Pop { stack, .. } => Some(stack.id()),
            _ => None,
        }
    }

    /// A dialog's coming or going drawn through its shader.
    fn modal_through_shader(&self) -> bool {
        matches!(self, Motion::ModalIn { .. } | Motion::ModalOut { .. }) && self.overlay().is_some()
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
    keys_installed: bool,
    /// The appearance the screens' backgrounds have.
    dark: Option<bool>,
    /// How pages and dialogs come and go through a shader, by node.
    shaders: FxHashMap<NodeId, nsh_core::NavShader>,
    /// Pages and dialogs with a shader deleted in this batch: their shaders
    /// go at its end, once their leave in it went through them.
    deleted: Vec<NodeId>,
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

/// Takes the keyboard focus away from inside `widget` before it is hidden
/// or unparented: GTK would hand it to the parent, which (not focusable)
/// gives it to its first focusable descendant, the field of another
/// screen (selecting all its text).
pub(crate) fn drop_focus(widget: &impl IsA<gtk::Widget>) {
    let widget = widget.as_ref();
    if let Some(root) = widget.root()
        && root
            .focus()
            .is_some_and(|f| &f == widget || f.is_ancestor(widget))
    {
        root.set_focus(None::<&gtk::Widget>);
    }
}

/// Hides `widget` (not child visible), without passing its focus on.
fn hide(widget: &impl IsA<gtk::Widget>) {
    if widget.as_ref().is_child_visible() {
        drop_focus(widget);
        widget.as_ref().set_child_visible(false);
    }
}

fn set_shift(view: &NshView, shift: (f32, f32)) {
    let changed = std::mem::replace(&mut view.state_mut().shift, shift) != shift;
    if changed {
        view.moved();
    }
}

fn set_fade(view: &NshView, fade: f32) {
    let changed = std::mem::replace(&mut view.state_mut().fade, fade) != fade;
    if changed {
        view.changed();
    }
}

/// What `paintable` shows now (its widget, or the image it kept of it).
fn image_of(paintable: &gtk::WidgetPaintable, width: f32, height: f32) -> Option<gsk::RenderNode> {
    let snapshot = gtk::Snapshot::new();
    paintable.snapshot(&snapshot, width as f64, height as f64);
    snapshot.to_node()
}

/// The root views modals show in: the surface's (the main window's) and
/// those of the app's windows of its own.
fn hosts(surface: &Surface) -> Vec<(NodeId, NshView)> {
    let mut hosts = vec![(ROOT_ID, surface.root.clone())];
    hosts.extend(crate::window::roots(surface));
    hosts
}

/// Moves `tail` to the end of `parent`'s children (drawn last), unless it
/// is there already.
fn keep_last(parent: &impl IsA<gtk::Widget>, tail: &[gtk::Widget]) {
    let mut expected = parent.last_child();
    let in_place = tail.iter().rev().all(|w| {
        let ok = expected.as_ref() == Some(w);
        expected = expected.as_ref().and_then(|e| e.prev_sibling());
        ok
    });
    if !in_place {
        for w in tail {
            w.insert_before(parent, None::<&gtk::Widget>);
        }
    }
}

impl ScreenNav {
    fn new(view: &NshView) -> Self {
        let backdrop = Layer::new();
        // First, under the app's content.
        backdrop.insert_after(view, None::<&gtk::Widget>);
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

    /// Gives the background the window's color in the appearance `dark`.
    fn style(&self, dark: bool) {
        self.backdrop.set_fill(Some(window_color(dark)));
    }

    /// Places the background, and shows the `header` item (where the core
    /// put it) and only that one.
    fn layout(&mut self) {
        let (w, h) = {
            let f = self.view.state().frame;
            (f.size.width.0, f.size.height.0)
        };
        if self.backdrop_size != (w, h) {
            self.backdrop_size = (w, h);
            self.view.set_native(&self.backdrop, rect(0.0, 0.0, w, h));
        }
        for item in &self.items {
            if Some(item.id()) == self.config.header_view {
                item.set_child_visible(true);
            } else {
                hide(item);
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
            keep_last(&self.view, &[header.clone().upcast()]);
        }
    }
}

impl Nav {
    /// Forgets the app's views (it stopped); the window's key handlers
    /// and a running tick callback stay.
    pub(crate) fn reset(&mut self) {
        *self = Nav {
            ticking: self.ticking,
            keys_installed: self.keys_installed,
            ..Nav::default()
        };
    }

    fn screen(&mut self, view: &NshView) -> &mut ScreenNav {
        self.screens
            .entry(view.id())
            .or_insert_with(|| ScreenNav::new(view))
    }

    /// Whether a transition runs.
    #[cfg(feature = "dev")]
    pub(crate) fn transitioning(&self) -> bool {
        !self.transitions.is_empty()
    }

    /// Ends the transitions `which` selects at once.
    fn finish(&mut self, surface: &Surface, which: impl Fn(&Motion) -> bool) {
        for motion in self.transitions.take(which) {
            self.end(surface, motion);
        }
    }

    /// Puts the views of `motion` where they are at eased progress `e`;
    /// under a shader's overlay, where they end.
    fn apply(&self, motion: &Motion, e: f32) {
        self.place(motion, if motion.overlay().is_some() { 1.0 } else { e });
    }

    /// A frame of `motion` at eased progress `e`.
    fn frame(&self, motion: &Motion, e: f32) {
        match motion.overlay() {
            Some(run) => run.tick(),
            None => self.place(motion, e),
        }
    }

    /// Puts the views of `motion` where they are at eased progress `e`.
    fn place(&self, motion: &Motion, e: f32) {
        match motion {
            Motion::Push {
                stack,
                entering,
                below,
                fade,
                ..
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
                    Leaving::Image(layer) => {
                        let x = if *fade {
                            layer.set_opacity((1.0 - e) as f64);
                            0.0
                        } else {
                            x.0
                        };
                        stack.set_native(layer, rect(x, 0.0, f.size.width.0, f.size.height.0));
                    }
                }
                if let (Some(below), false) = (below, fade) {
                    set_shift(below, (below_x.0, 0.0));
                }
            }
            Motion::ModalIn {
                view, host, fade, ..
            } => {
                if *fade {
                    set_fade(view, e);
                } else {
                    // From below the window's bottom edge.
                    let h = host.state().frame.size.height.0;
                    let y = view.state().frame.origin.y.0;
                    set_shift(view, (0.0, modal_in_offset(Points(h - y), e).0));
                }
            }
            Motion::ModalOut {
                layer,
                host,
                frame,
                fade,
                ..
            } => {
                let h = host.state().frame.size.height.0;
                let y = if *fade {
                    layer.set_opacity((1.0 - e) as f64);
                    frame.origin.y.0
                } else {
                    frame.origin.y.0 + modal_out_offset(Points(h - frame.origin.y.0), e).0
                };
                host.set_native(
                    layer,
                    rect(frame.origin.x.0, y, frame.size.width.0, frame.size.height.0),
                );
            }
        }
    }

    fn end(&mut self, surface: &Surface, motion: Motion) {
        self.apply(&motion, 1.0);
        match motion {
            Motion::Push { stack, .. } => self.settle(stack.id()),
            Motion::Pop {
                stack,
                leaving,
                popped,
                ..
            } => {
                match leaving {
                    Leaving::View(v) => {
                        hide(&v);
                        set_shift(&v, (0.0, 0.0));
                        set_fade(&v, 1.0);
                    }
                    Leaving::Image(layer) => stack.remove_native(&layer),
                }
                self.settle(stack.id());
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
                layer,
                host,
                ..
            } => {
                host.remove_native(&layer);
                if let Some(id) = dismiss {
                    surface.event(id, EventKind::Dismiss, EventPayload::None);
                }
            }
        }
    }

    /// Shows only the top screen of `stack`, where it belongs.
    fn settle(&mut self, stack: NodeId) {
        let Some(st) = self.stacks.get(&stack) else {
            return;
        };
        let top = st.screens.top();
        for view in st.view.child_views() {
            if view.kind() != ViewKind::Screen {
                continue;
            }
            if Some(view.id()) == top {
                view.set_child_visible(true);
            } else {
                hide(&view);
            }
            set_shift(&view, (0.0, 0.0));
            set_fade(&view, 1.0);
        }
    }

    /// Starts `motion` through `shader` for the shader's duration; where
    /// there is none or it cannot be drawn, as the page's or the dialog's
    /// own motion for `own` (`None`: its `animation` is `"none"`, so it
    /// ends at once).
    fn start(
        &mut self,
        surface: &Rc<Surface>,
        own: Option<Duration>,
        mut motion: Motion,
        shader: Option<&nsh_core::NavShader>,
    ) {
        self.apply(&motion, 0.0);
        if let Some(shader) = shader {
            motion.add_overlay(surface, shader);
        }
        let duration = match (motion.overlay(), own) {
            (Some(run), _) => run.duration,
            (None, Some(own)) => own,
            (None, None) => {
                self.end(surface, motion);
                return;
            }
        };
        self.apply(&motion, 0.0);
        self.transitions.push(duration, motion);
        if self.ticking {
            return;
        }
        self.ticking = true;
        // On the surface's frames, which also keep the transitions' ends
        // while the window draws none: screens settle and report it on time.
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

    /// A frame at `now` (seconds).
    fn tick(&mut self, surface: &Surface, now: f64) {
        for tick in self.transitions.tick(now) {
            match tick {
                Tick::Ended(motion) => self.end(surface, motion),
                Tick::At(i, e) => self.frame(&self.transitions[i], e),
            }
        }
    }

    /// The duration and whether it fades; `None`: no animation.
    fn screen_motion(surface: &Surface, animation: ScreenAnimation) -> Option<(Duration, bool)> {
        nsh_core::navigation::screen_motion(animation, surface.environment.get().reduce_motion)
    }

    /// The `transitionShader` page or dialog `id` comes and goes through:
    /// none when the user asks for less motion (it then comes and goes with
    /// its own reduced `animation`).
    fn shader(&self, surface: &Surface, id: NodeId) -> Option<nsh_core::NavShader> {
        if surface.environment.get().reduce_motion {
            return None;
        }
        self.shaders.get(&id).cloned()
    }

    /// Shows the app's screens of `stack` after a batch changed them.
    fn reconcile(&mut self, surface: &Rc<Surface>, stack_id: NodeId) {
        self.finish(surface, |m| m.stack() == Some(stack_id));
        let dark = dark(surface);
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
        let image = match (old, &st.paintable) {
            (Some(old), Some((watched, paintable)))
                if Some(old) != new && *watched == old && find(old).is_none() =>
            {
                image_of(paintable, frame.size.width.0, frame.size.height.0)
            }
            _ => None,
        };
        match (new.and_then(find), &mut st.paintable) {
            (Some(top), Some((watched, paintable))) => {
                if *watched != top.id() {
                    *watched = top.id();
                    paintable.set_widget(Some(&top));
                }
            }
            (Some(top), slot @ None) => {
                *slot = Some((top.id(), gtk::WidgetPaintable::new(Some(&top))));
            }
            (None, slot) => *slot = None,
        }
        let leaving_animation = old.and_then(|id| {
            let s = self.screens.get(&id)?;
            Some((s.config.animation, self.shader(surface, id)))
        });
        for id in &prev {
            if find(*id).is_none() {
                self.screens.remove(id);
            }
        }
        for &id in &desired {
            let Some(view) = find(id) else { continue };
            let s = self.screen(&view);
            if !prev.contains(&id) {
                s.style(dark);
                s.report(surface, &stack);
            }
        }
        if children.is_empty() && stack.parent().is_none() {
            // The stack is gone.
            self.stacks.remove(&stack_id);
            return;
        }
        self.settle(stack_id);
        let (Some(old), Some(new)) = (old, new) else {
            return;
        };
        if old == new || frame.size.width.0 <= 0.0 {
            return;
        }
        let pushing = !prev.contains(&new);
        let animation = if pushing {
            self.screens
                .get(&new)
                .map(|s| (s.config.animation, self.shader(surface, new)))
        } else {
            leaving_animation
        };
        let (animation, shader) = animation.unwrap_or_default();
        // The shader replaces the page's own motion, which runs where it
        // does not (`"none"`: at once).
        let own = Self::screen_motion(surface, animation);
        if own.is_none() && shader.is_none() {
            return;
        }
        let fade = own.is_some_and(|(_, fade)| fade);
        let own = own.map(|(duration, _)| duration);
        if pushing {
            let Some(entering) = find(new) else { return };
            let below = find(old);
            if let Some(b) = &below {
                b.set_child_visible(true);
            }
            let motion = Motion::Push {
                stack,
                entering,
                below,
                fade,
                shader: None,
            };
            self.start(surface, own, motion, shader.as_ref());
        } else {
            let leaving = match find(old) {
                Some(v) => {
                    v.set_child_visible(true);
                    Leaving::View(v)
                }
                None => {
                    let Some(node) = image else { return };
                    let layer = Layer::new();
                    layer.set_node(Some(node));
                    Leaving::Image(layer)
                }
            };
            let motion = Motion::Pop {
                stack,
                leaving,
                below: find(new),
                fade,
                popped: None,
                shader: None,
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
        if let (Some(below), Some((watched, paintable))) = (&below, &mut st.paintable) {
            *watched = below.id();
            paintable.set_widget(Some(below));
        }
        let (animation, shader) = self
            .screens
            .get(&top)
            .map(|s| (s.config.animation, self.shader(surface, top)))
            .unwrap_or_default();
        let own = Self::screen_motion(surface, animation);
        match (own.is_some() || shader.is_some(), find(top)) {
            (true, Some(leaving)) => {
                if let Some(b) = &below {
                    b.set_child_visible(true);
                }
                let motion = Motion::Pop {
                    stack,
                    leaving: Leaving::View(leaving),
                    below,
                    fade: own.is_some_and(|(_, fade)| fade),
                    popped: Some(top),
                    shader: None,
                };
                self.start(surface, own.map(|(d, _)| d), motion, shader.as_ref());
            }
            _ => {
                self.settle(stack_id);
                surface.event(top, EventKind::Dismiss, EventPayload::None);
            }
        }
    }

    /// The stack going back acts on: the innermost shown one that can pop
    /// or asks first, inside `within` (the newest modal) when given.
    fn back_stack(&self, within: Option<&NshView>) -> Option<NodeId> {
        let wants = |st: &StackNav| {
            st.view.is_mapped()
                && nsh_core::navigation::shown_in_layout(
                    std::iter::successors(Some(st.view.clone()), NshView::parent_view)
                        .filter(|v| v.parent_view().is_some())
                        .map(|v| v.state().frame),
                )
                && within.is_none_or(|w| st.view.is_ancestor(w))
                && st.screens.takes_back(|top| {
                    self.screens
                        .get(&top)
                        .is_some_and(|s| s.config.prevent_back)
                })
        };
        let candidates: Vec<&StackNav> = self.stacks.values().filter(|s| wants(s)).collect();
        innermost(&candidates, |c, o| o.view.is_ancestor(&c.view)).map(|c| c.view.id())
    }

    /// Takes modal `id` away natively (it leaves as an image of its last
    /// frame), then reports `onDismiss` unless `reported` already.
    fn close_modal(&mut self, surface: &Rc<Surface>, id: NodeId, reported: bool) {
        // Its own coming, and any dialog's change through a shader, end
        // first.
        self.finish(surface, |m| {
            m.modal_through_shader() || matches!(m, Motion::ModalIn { view, .. } if view.id() == id)
        });
        self.order.retain(|&m| m != id);
        let shader = self.shader(surface, id);
        let window = self.window_of(surface, id);
        let Some(m) = self.modals.get_mut(&id) else {
            return;
        };
        let Some(view) = m.view.take() else { return };
        let restore = m.restore.take().and_then(|w| w.upgrade());
        let host = view
            .parent()
            .and_downcast::<NshView>()
            .unwrap_or_else(|| surface.root.clone());
        let frame = view.state().frame;
        let own = modal_motion(surface, m.config.animation);
        // Unmapped, the paintable keeps the image the modal showed last.
        let paintable = m.paintable.take();
        let mapped = view.is_mapped();
        if view.parent().is_some() {
            drop_focus(&view);
            view.unparent();
        }
        let image = match (own.is_some() || shader.is_some(), paintable) {
            (true, Some(paintable)) if mapped => {
                image_of(&paintable, frame.size.width.0, frame.size.height.0)
            }
            _ => None,
        };
        set_shift(&view, (0.0, 0.0));
        set_fade(&view, 1.0);
        self.scope_focus(surface);
        self.restore_focus(surface, &host, window, restore);
        match image {
            Some(node) => {
                let layer = Layer::new();
                layer.set_node(Some(node));
                let motion = Motion::ModalOut {
                    dismiss: (!reported).then_some(id),
                    host,
                    layer,
                    frame,
                    fade: own.is_some_and(|(_, fade)| fade),
                    shader: None,
                };
                self.start(surface, own.map(|(d, _)| d), motion, shader.as_ref());
            }
            None => {
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
        let own = modal_motion(surface, m.config.animation);
        // A dialog's change through a shader that still runs ends first.
        self.finish(surface, Motion::modal_through_shader);
        let shader = self.shader(surface, id);
        if own.is_none() && shader.is_none() {
            surface.event(id, EventKind::Show, EventPayload::None);
            return;
        }
        let host = self.host(surface, id);
        let motion = Motion::ModalIn {
            view,
            host,
            fade: own.is_some_and(|(_, fade)| fade),
            shader: None,
        };
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
    fn go_back(&mut self, surface: &Rc<Surface>) -> bool {
        if self.newest_in(surface, ROOT_ID).is_none()
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
        self.back_in(surface, ROOT_ID)
    }

    /// Going back in window `window` (the main one or one of the app's
    /// own): its newest modal and its stacks only.
    fn back_in(&mut self, surface: &Rc<Surface>, window: NodeId) -> bool {
        let newest = self.newest_in(surface, window);
        // A window of the app's own: only the stacks inside it.
        let root = (window != ROOT_ID).then(|| crate::window::host_root(surface, window));
        let target = back_target(newest, false, |modal| {
            let view = modal
                .and_then(|id| self.modals.get(&id)?.view.clone())
                .or_else(|| root.clone());
            self.back_stack(view.as_ref())
        });
        match target {
            Some(Back::Stack(stack)) => self.back(surface, stack),
            Some(Back::Modal(id)) => self.request_close(surface, id),
            Some(Back::App) | None => return false,
        }
        true
    }

    /// Keeps the keyboard focus inside the newest modal: Tab never reaches
    /// the views under it (`can-focus` off holds for a widget's descendants
    /// too). The modal's own ancestors stay on, whichever view opened it:
    /// a field inside the modal needs them. Dialogs are not views, and keep
    /// theirs.
    fn scope_focus(&self, surface: &Surface) {
        // Each window keeps the focus inside its own newest modal.
        for (window, host) in hosts(surface) {
            let top = self
                .newest_in(surface, window)
                .and_then(|id| self.modals.get(&id))
                .and_then(|m| m.view.clone());
            let mut child = host.first_child();
            while let Some(c) = child {
                child = c.next_sibling();
                if let Some(view) = c.downcast_ref::<NshView>() {
                    let allowed = top.as_ref().is_none_or(|t| {
                        let top = t.upcast_ref::<gtk::Widget>();
                        &c == top || c.is_ancestor(top)
                    });
                    view.set_can_focus(allowed);
                }
            }
        }
    }

    /// Gives the keyboard focus back to `restore` if nothing else took it
    /// meanwhile and it can still take keyboard focus inside the active
    /// scope (the newest modal still shown in `window`, else `host`).
    /// Editor caret sinks reject pointer targeting (`can_target == false`)
    /// but still regain keyboard focus; hidden, zero-sized, disabled, dying
    /// or detached targets stay unfocused.
    fn restore_focus(
        &self,
        surface: &Surface,
        host: &NshView,
        window: NodeId,
        restore: Option<NshView>,
    ) {
        let Some(view) = restore else {
            return;
        };
        let Some(root) = host.root() else {
            return;
        };
        if root.focus().is_some() {
            return;
        }
        let scope = self
            .newest_in(surface, window)
            .and_then(|id| self.modals.get(&id).and_then(|m| m.view.clone()))
            .unwrap_or_else(|| host.clone());
        if !can_restore_focus(&scope, &view) {
            return;
        }
        if view.kind() == ViewKind::Input {
            crate::text_input::focus(&view);
        } else {
            crate::key_focus::focus(&view);
        }
    }

    /// The window modal `id` shows in: its `ModalConfig.window` while that
    /// window is open, else the main one.
    fn window_of(&self, surface: &Surface, id: NodeId) -> NodeId {
        self.modals
            .get(&id)
            .map(|m| m.config.window)
            .filter(|&w| w != ROOT_ID && crate::window::is_window(surface, w))
            .unwrap_or(ROOT_ID)
    }

    /// The root view modal `id` shows in.
    fn host(&self, surface: &Surface, id: NodeId) -> NshView {
        crate::window::host_root(surface, self.window_of(surface, id))
    }

    /// The newest modal presented in window `window`.
    fn newest_in(&self, surface: &Surface, window: NodeId) -> Option<NodeId> {
        self.order
            .iter()
            .rev()
            .copied()
            .find(|&id| self.window_of(surface, id) == window)
    }

    /// Keeps the presented modals (and those leaving) over the app's
    /// views.
    fn raise_modals(&self, surface: &Surface) {
        // Per window: the root view each shows in.
        let mut tails: Vec<(NshView, Vec<gtk::Widget>)> = Vec::new();
        let mut push =
            |host: NshView, widget: gtk::Widget| match tails.iter_mut().find(|(h, _)| *h == host) {
                Some((_, tail)) => tail.push(widget),
                None => tails.push((host, vec![widget])),
            };
        for &id in &self.order {
            if let Some(view) = self.modals.get(&id).and_then(|m| m.view.clone()) {
                push(self.host(surface, id), view.upcast());
            }
        }
        for motion in self.transitions.iter() {
            if let Motion::ModalOut { layer, host, .. } = motion {
                push(host.clone(), layer.clone().upcast());
            }
        }
        for (host, tail) in tails {
            keep_last(&host, &tail);
        }
    }

    /// Sizes modal `id` to the root view of its window and reports it
    /// (with the surface's safe area in the main window).
    fn size_modal(&mut self, surface: &Surface, id: NodeId) {
        let presenting = self.presenting.contains(&id);
        let window = self.window_of(surface, id);
        let host = crate::window::host_root(surface, window);
        let Some(m) = self.modals.get_mut(&id) else {
            return;
        };
        let Some(view) = &m.view else { return };
        let insets = if window == ROOT_ID {
            safe_area(surface)
        } else {
            EdgeInsets::default()
        };
        let f = host.state().frame;
        let frame = rect(0.0, 0.0, f.size.width.0, f.size.height.0);
        if std::mem::replace(&mut view.state_mut().frame, frame) != frame {
            view.queue_allocate();
            view.moved();
        }
        let size = frame.size;
        // Reported once its batch is applied ([`end_batch`]): a window
        // of the app's own (`Window.open`) is presented first and only
        // claimed by the batch's commands, and must not be laid out at the
        // surface's size in between.
        if presenting {
            return;
        }
        report(surface, id, &mut m.reported, size, insets);
    }

    /// Listens to the window's back keys and the mouse's back button.
    fn install_keys(&mut self, surface: &Rc<Surface>) {
        if self.keys_installed {
            return;
        }
        let Some(window) = surface.root.root() else {
            return;
        };
        self.keys_installed = true;
        let keys = gtk::EventControllerKey::new();
        let weak = Rc::downgrade(surface);
        keys.connect_key_pressed(move |_, key, _, modifiers| match weak.upgrade() {
            Some(surface) if key_pressed(&surface, key, modifiers) => glib::Propagation::Stop,
            _ => glib::Propagation::Proceed,
        });
        window.add_controller(keys);
        let click = gtk::GestureClick::new();
        click.set_button(8);
        let weak: Weak<Surface> = Rc::downgrade(surface);
        click.connect_pressed(move |gesture, _, _, _| {
            if let Some(surface) = weak.upgrade()
                && go_back(&surface)
            {
                gesture.set_state(gtk::EventSequenceState::Claimed);
            }
        });
        window.add_controller(click);
    }
}

/// Whether `view` is inside the newest modal of its own window.
pub(crate) fn in_focus_scope(surface: &Surface, view: &NshView) -> bool {
    // AT can query an inserted action during a mount/navigation mutation.
    let (Ok(_windows), Ok(nav)) = (surface.windows.try_borrow(), surface.nav.try_borrow()) else {
        return false;
    };
    let Some(window) = crate::window::try_root_id(surface, view) else {
        return false;
    };
    let scope = nav
        .newest_in(surface, window)
        .and_then(|id| nav.modals.get(&id))
        .and_then(|modal| modal.view.as_ref());
    scope.is_none_or(|scope| view == scope || view.is_ancestor(scope))
}

/// Goes back (the newest modal, the innermost stack or the app's
/// `onBackPress`): whether something took it.
pub(crate) fn go_back(surface: &Rc<Surface>) -> bool {
    match surface.nav.try_borrow_mut() {
        Ok(mut nav) => nav.go_back(surface),
        Err(_) => false,
    }
}

/// `Command::Back`: goes back as without the app's listeners, once the
/// batch being applied is in.
pub(crate) fn default_back(surface: &Rc<Surface>) {
    let surface = Rc::downgrade(surface);
    glib::idle_add_local_once(move || {
        if let Some(surface) = surface.upgrade()
            && let Ok(mut nav) = surface.nav.try_borrow_mut()
        {
            nav.default_back(&surface);
        }
    });
}

/// The window of root view `host`, when a text field (a `gtk::TextView` or
/// any `gtk::Editable`) or a web view's page has its keyboard focus.
fn focused_field_in(host: &NshView) -> Option<gtk::Root> {
    let root = host.root()?;
    let focus = root.focus()?;
    (focus.is::<gtk::TextView>()
        || focus.is::<gtk::Editable>()
        || crate::native::page_of(&focus).is_some())
    .then_some(root)
}

/// Whether a text field (or a web view's page) has the keyboard focus in
/// the window the keys go to: the main window's, or one of the app's own.
#[cfg(feature = "dev")]
pub(crate) fn key_window_field_focused(surface: &Surface) -> bool {
    focused_field_in(&crate::window::key_root(surface)).is_some()
}

/// A key nothing in the window used: Escape, Alt+Left and the Back key go
/// back. Whether it was taken. Escape in a focused text field only leaves
/// the field (a desktop convention: it never navigates away from what is
/// being typed), and so does Escape a focused page did not use (WebKit
/// hands those back to the window); Alt+Left and the Back key still go
/// back (in a page they go back in its history first, `native::web`).
pub(crate) fn key_pressed(
    surface: &Rc<Surface>,
    key: gdk::Key,
    modifiers: gdk::ModifierType,
) -> bool {
    key_pressed_in(surface, ROOT_ID, key, modifiers)
}

/// [`key_pressed`] in window `window` (the main one or one of the app's
/// own): it goes back among that window's modals and stacks.
pub(crate) fn key_pressed_in(
    surface: &Rc<Surface>,
    window: NodeId,
    key: gdk::Key,
    modifiers: gdk::ModifierType,
) -> bool {
    let mods = modifiers
        & (gdk::ModifierType::CONTROL_MASK
            | gdk::ModifierType::ALT_MASK
            | gdk::ModifierType::SHIFT_MASK
            | gdk::ModifierType::SUPER_MASK);
    let back = match key {
        gdk::Key::Escape | gdk::Key::Back => mods.is_empty(),
        gdk::Key::Left | gdk::Key::KP_Left => mods == gdk::ModifierType::ALT_MASK,
        _ => false,
    };
    if back
        && key == gdk::Key::Escape
        && let Some(root) = focused_field_in(&crate::window::host_root(surface, window))
    {
        root.set_focus(None::<&gtk::Widget>);
        return true;
    }
    back && go_back_in(surface, window)
}

/// Goes back in window `window` (the main one, with the app's
/// `onBackPress`, or one of the app's own: its newest modal, else its
/// innermost stack): whether something took it.
pub(crate) fn go_back_in(surface: &Rc<Surface>, window: NodeId) -> bool {
    if window == ROOT_ID {
        return go_back(surface);
    }
    match surface.nav.try_borrow_mut() {
        Ok(mut nav) => nav.back_in(surface, window),
        Err(_) => false,
    }
}

/// A screen was pushed (`added`) or popped in `stack`.
pub(crate) fn stack_changed(surface: &Rc<Surface>, stack: &NshView, added: Option<&NshView>) {
    let mut nav = surface.nav.borrow_mut();
    let id = stack.id();
    nav.stacks.entry(id).or_insert_with(|| StackNav {
        view: stack.clone(),
        screens: Stack::default(),
        paintable: None,
    });
    if let Some(screen) = added.filter(|v| v.kind() == ViewKind::Screen) {
        nav.screen(screen);
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
    let dark = dark(surface);
    let mut nav = surface.nav.borrow_mut();
    let s = nav.screen(view);
    s.config = config.clone();
    s.style(dark);
    s.layout();
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
    nav.modals.entry(id).or_default().config = config.clone();
    nav.size_modal(surface, id);
}

/// `NavShader`: how page or dialog `id` comes and goes through a shader.
pub(crate) fn nav_shader(surface: &Rc<Surface>, id: NodeId, shader: Option<nsh_core::NavShader>) {
    let mut nav = surface.nav.borrow_mut();
    match shader {
        Some(shader) => nav.shaders.insert(id, shader),
        None => nav.shaders.remove(&id),
    };
}

/// Node `id` was deleted: the shader it came and went through as a page or
/// a dialog goes at the end of the batch, after its leave (a stack
/// reconciles its pages then) went through it.
pub(crate) fn deleted(surface: &Surface, id: NodeId) {
    let mut nav = surface.nav.borrow_mut();
    if nav.shaders.contains_key(&id) {
        nav.deleted.push(id);
    }
}

/// A modal was inserted: present it.
pub(crate) fn present(surface: &Rc<Surface>, view: &NshView) {
    if crate::window::is_window(surface, view.id()) {
        return;
    }
    let mut nav = surface.nav.borrow_mut();
    let id = view.id();
    // In its window (`ModalConfig.window`, sent before it is presented).
    nav.modals.entry(id).or_default();
    let host = nav.host(surface, id);
    let m = nav.modals.get_mut(&id).expect("just made");
    if m.view.is_some() {
        return;
    }
    // The field being typed in under the modal leaves it (until the modal
    // closes).
    let window = host.root();
    let focus = window
        .as_ref()
        .and_then(|r| r.focus())
        .filter(|f| f.is_ancestor(&host));
    if let (Some(window), Some(_)) = (&window, &focus) {
        window.set_focus(None::<&gtk::Widget>);
    }
    m.restore = focus
        .and_then(|f| enclosing_view(&f, &host))
        .map(|v| v.downgrade());
    m.view = Some(view.clone());
    m.paintable = Some(gtk::WidgetPaintable::new(Some(view)));
    m.closed = false;
    m.reported = Reported::default();
    if view.parent().is_some() {
        view.unparent();
    }
    view.insert_before(&host, None::<&gtk::Widget>);
    nav.order.push(id);
    nav.scope_focus(surface);
    nav.size_modal(surface, id);
    // Animated in at the end of the batch, with the options it brings.
    nav.presenting.push(id);
}

/// Modal `id` is shown in a window of its own (`Window.open`) instead:
/// it leaves the surface's modals at once, without events, and the focus
/// it took goes back.
pub(crate) fn release(surface: &Rc<Surface>, id: NodeId) {
    let mut nav = surface.nav.borrow_mut();
    let window = nav.window_of(surface, id);
    let host = nav.host(surface, id);
    nav.order.retain(|&m| m != id);
    nav.presenting.retain(|&m| m != id);
    let restore = nav
        .modals
        .remove(&id)
        .and_then(|m| m.restore)
        .and_then(|w| w.upgrade());
    nav.scope_focus(surface);
    nav.restore_focus(surface, &host, window, restore);
}

/// The enclosing [`NshView`] of `widget` inside `host` (`None` if detached or
/// at `host` itself).
fn enclosing_view(widget: &gtk::Widget, host: &NshView) -> Option<NshView> {
    let host_widget = host.upcast_ref::<gtk::Widget>();
    let mut at = Some(widget.clone());
    while let Some(w) = at {
        if &w == host_widget {
            return None;
        }
        if let Some(view) = w.downcast_ref::<NshView>() {
            return Some(view.clone());
        }
        at = w.parent();
    }
    None
}

/// Whether `view` is attached inside `scope` and eligible for restored
/// keyboard focus.
fn can_restore_focus(scope: &NshView, view: &NshView) -> bool {
    let Ok(s) = view.try_state() else {
        return false;
    };
    if s.frame.size.width <= Points(0.0) || s.frame.size.height <= Points(0.0) {
        return false;
    }
    drop(s);
    let scope_widget = scope.upcast_ref::<gtk::Widget>();
    let mut at = Some(view.clone().upcast::<gtk::Widget>());
    let mut reached_scope = false;
    while let Some(w) = at {
        if &w == scope_widget {
            reached_scope = true;
            break;
        }
        if !w.is_visible() || !w.is_child_visible() || !w.is_sensitive() {
            return false;
        }
        if let Some(v) = w.downcast_ref::<NshView>() {
            let Ok(s) = v.try_state() else {
                return false;
            };
            if s.style.hidden
                || s.props.accessibility.state.disabled
                || s.live.as_ref().is_some_and(|l| l.dying())
            {
                return false;
            }
        }
        at = w.parent();
    }
    reached_scope
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
            if view.parent().is_some() {
                drop_focus(view);
                view.unparent();
            }
        }
    }
}

/// A header item was inserted into `parent` (a screen).
pub(crate) fn header_item(surface: &Rc<Surface>, parent: &NshView, child: &NshView) {
    let mut nav = surface.nav.borrow_mut();
    if child.parent().as_ref() != Some(parent.upcast_ref()) {
        if child.parent().is_some() {
            child.unparent();
        }
        child.insert_before(parent, None::<&gtk::Widget>);
    }
    let s = nav.screen(parent);
    if !s.items.contains(child) {
        s.items.push(child.clone());
    }
    // Shown by the screen's layout at the end of the batch when it is the
    // `header` (the core places it).
    hide(child);
}

/// A header item was removed.
pub(crate) fn header_item_removed(surface: &Rc<Surface>, view: &NshView) {
    let mut nav = surface.nav.borrow_mut();
    if let Some(screen) = view.parent_view()
        && let Some(s) = nav.screens.get_mut(&screen.id())
    {
        s.items.retain(|v| v != view);
    }
    if view.parent().is_some() {
        view.unparent();
    }
    set_shift(view, (0.0, 0.0));
}

/// The surface was resized (modals follow).
pub(crate) fn surface_resized(surface: &Surface, _width: f32, _height: f32) {
    resize_modals(surface);
}

/// A root view was resized (the surface's or a window's): the modals in
/// it follow.
pub(crate) fn resize_modals(surface: &Surface) {
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
    nav.install_keys(surface);
    let dark = dark(surface);
    if nav.dark.replace(dark).is_some_and(|d| d != dark) {
        for s in nav.screens.values() {
            s.style(dark);
        }
    }
    for stack in std::mem::take(&mut nav.dirty) {
        nav.reconcile(surface, stack);
    }
    for id in std::mem::take(&mut nav.presenting) {
        nav.size_modal(surface, id);
        nav.show_modal(surface, id);
    }
    // The pages and dialogs this batch deleted left through their shaders
    // above (a dialog when it was removed).
    for id in std::mem::take(&mut nav.deleted) {
        nav.shaders.remove(&id);
    }
    // Screen sizes change with the app's layout.
    for s in nav.screens.values_mut() {
        s.layout();
        s.raise_header();
    }
    if !nav.order.is_empty() || !nav.transitions.is_empty() {
        nav.raise_modals(surface);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use nsh_core::{
        Hsla, InputConfig, MountItem, PointerEvents, ViewProps, ViewStyle,
        shader::{Shader, ShaderLayer},
    };

    use super::*;
    use crate::gtk_test::{self, apply, frame, show, view, wait_until};

    #[derive(Clone, Copy)]
    enum TargetKind {
        Input,
        NonTargetableInput,
        Editor,
        RichEditor,
        Stop,
    }

    fn mount_target(surface: &Rc<Surface>, id: NodeId, kind: TargetKind) {
        let view_kind = match kind {
            TargetKind::Stop => ViewKind::View,
            _ => ViewKind::Input,
        };
        let mut items = vec![
            MountItem::Create {
                id,
                kind: view_kind,
            },
            MountItem::Insert {
                parent: ROOT_ID,
                child: id,
                before: None,
            },
            MountItem::Frame {
                id,
                frame: frame(0.0, 0.0, 120.0, 32.0),
            },
        ];
        match kind {
            TargetKind::Input => {
                items.push(MountItem::Input {
                    id,
                    config: Box::new(InputConfig::default()),
                });
                items.push(MountItem::InputValue {
                    id,
                    text: "hello".into(),
                    count: 1,
                });
            }
            TargetKind::NonTargetableInput => {
                items.push(MountItem::ViewProps {
                    id,
                    props: Box::new(ViewProps {
                        pointer_events: PointerEvents::None,
                        ..Default::default()
                    }),
                });
                items.push(MountItem::Input {
                    id,
                    config: Box::new(InputConfig::default()),
                });
            }
            TargetKind::Editor | TargetKind::RichEditor => {
                items.push(MountItem::ViewProps {
                    id,
                    props: Box::new(ViewProps {
                        pointer_events: PointerEvents::None,
                        ..Default::default()
                    }),
                });
                let mut config = InputConfig {
                    multiline: matches!(kind, TargetKind::Editor),
                    caret_hidden: true,
                    ..Default::default()
                };
                config.style.color = Hsla::transparent_black().into();
                items.push(MountItem::Input {
                    id,
                    config: Box::new(config),
                });
            }
            TargetKind::Stop => {
                items.push(MountItem::ViewProps {
                    id,
                    props: Box::new(ViewProps {
                        focusable: Some(true),
                        ..Default::default()
                    }),
                });
            }
        }
        apply(surface, &items);
    }

    fn focus_target(target: &NshView, kind: TargetKind) {
        match kind {
            TargetKind::Stop => crate::key_focus::focus(target),
            _ => crate::text_input::focus(target),
        }
    }

    fn has_target_focus(window: &gtk::Window, target: &NshView, kind: TargetKind) -> bool {
        GtkWindowExt::focus(window).is_some_and(|w| match kind {
            TargetKind::Stop => &w == target.upcast_ref::<gtk::Widget>(),
            _ => w.is_ancestor(target),
        })
    }

    fn mount_modal(surface: &Rc<Surface>, id: NodeId, config: ModalConfig) {
        apply(
            surface,
            &[
                MountItem::Create {
                    id,
                    kind: ViewKind::Modal,
                },
                MountItem::ModalConfig { id, config },
                MountItem::Frame {
                    id,
                    frame: frame(0.0, 0.0, 200.0, 200.0),
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: id,
                    before: None,
                },
            ],
        );
        end_batch(surface);
    }

    fn close_modal_by_remove(surface: &Rc<Surface>, id: NodeId) {
        apply(surface, &[MountItem::Remove { id }]);
        end_batch(surface);
    }

    #[test]
    fn modal_close_restores_focus_to_editors_non_targetable_inputs_and_stops() {
        gtk_test::run(|| {
            for kind in [
                TargetKind::Input,
                TargetKind::NonTargetableInput,
                TargetKind::Editor,
                TargetKind::RichEditor,
                TargetKind::Stop,
            ] {
                let surface = gtk_test::surface();
                mount_target(&surface, 10, kind);
                let window = show(&surface);
                let target = view(&surface, 10);
                assert!(wait_until(|| target.is_mapped()));
                focus_target(&target, kind);
                assert!(
                    wait_until(|| has_target_focus(&window, &target, kind)),
                    "initial focus should enter target"
                );
                if matches!(kind, TargetKind::Input)
                    && let Some(line) = GtkWindowExt::focus(&window).and_downcast::<gtk::Text>()
                {
                    line.set_position(5);
                    line.select_region(5, 5);
                }

                mount_modal(&surface, 20, ModalConfig::default());
                assert!(
                    wait_until(|| !has_target_focus(&window, &target, kind)),
                    "presenting a modal drops background focus"
                );

                close_modal_by_remove(&surface, 20);
                assert!(
                    wait_until(|| has_target_focus(&window, &target, kind)),
                    "closing the modal restores focus"
                );
                match GtkWindowExt::focus(&window) {
                    Some(w) if matches!(kind, TargetKind::Editor) => {
                        let tv = w.downcast_ref::<gtk::TextView>().expect("editor text view");
                        assert!(tv.buffer().insert_interactive_at_cursor("!", true));
                        assert_eq!(
                            tv.buffer().text(
                                &tv.buffer().start_iter(),
                                &tv.buffer().end_iter(),
                                false
                            ),
                            "!"
                        );
                    }
                    Some(w) if !matches!(kind, TargetKind::Stop) => {
                        let line = w.downcast_ref::<gtk::Text>().expect("line text");
                        if matches!(kind, TargetKind::Input) {
                            assert_eq!(line.selection_bounds(), None);
                        }
                        let mut pos = line.position();
                        line.insert_text("!", &mut pos);
                        assert!(line.text().ends_with('!'));
                    }
                    _ => assert!(matches!(kind, TargetKind::Stop)),
                }
                window.destroy();
            }
        });
    }

    fn open_modal_over(kind: TargetKind) -> (Rc<Surface>, gtk::Window, NshView) {
        let surface = gtk_test::surface();
        mount_target(&surface, 10, kind);
        let window = show(&surface);
        let target = view(&surface, 10);
        assert!(wait_until(|| target.is_mapped()));
        focus_target(&target, kind);
        assert!(wait_until(|| has_target_focus(&window, &target, kind)));
        mount_modal(&surface, 20, ModalConfig::default());
        (surface, window, target)
    }

    #[test]
    fn modal_close_skips_hidden_disabled_dying_zero_sized_and_covered_targets() {
        gtk_test::run(|| {
            // Hidden style (`visibility: hidden`), zero-sized (`display: none`),
            // disabled, dying (exit animation), or still covered by an upper modal.
            type Case = (&'static str, fn(&Rc<Surface>));
            let cases: &[Case] = &[
                ("hidden", |s| {
                    apply(
                        s,
                        &[MountItem::ViewStyle {
                            id: 10,
                            style: Box::new(ViewStyle {
                                hidden: true,
                                ..Default::default()
                            }),
                        }],
                    );
                }),
                ("disabled", |s| {
                    let mut disabled = ViewProps::default();
                    disabled.accessibility.state.disabled = true;
                    apply(
                        s,
                        &[MountItem::ViewProps {
                            id: 10,
                            props: Box::new(disabled),
                        }],
                    );
                }),
                ("zero-sized", |s| {
                    apply(
                        s,
                        &[MountItem::Frame {
                            id: 10,
                            frame: frame(0.0, 0.0, 0.0, 0.0),
                        }],
                    );
                }),
                ("covered", |s| {
                    mount_modal(s, 21, ModalConfig::default());
                }),
                ("dying", |s| {
                    apply(
                        s,
                        &[
                            MountItem::LayoutAnimation(nsh_core::LayoutAnimation::EASE_IN_EASE_OUT),
                            MountItem::Remove { id: 10 },
                        ],
                    );
                }),
            ];
            for (name, mutate) in cases {
                let (surface, window, _) = open_modal_over(TargetKind::Editor);
                mutate(&surface);
                close_modal_by_remove(&surface, 20);
                assert_eq!(
                    GtkWindowExt::focus(&window),
                    None,
                    "{name} target must stay unfocused"
                );
                window.destroy();
            }
        });
    }

    #[test]
    fn modal_close_preserves_newer_focus_and_supports_escape_and_release() {
        gtk_test::run(|| {
            // Focus taken by another control after closing or outside stays put.
            {
                let surface = gtk_test::surface();
                mount_target(&surface, 10, TargetKind::Editor);
                mount_target(&surface, 11, TargetKind::Input);
                let window = show(&surface);
                let first = view(&surface, 10);
                let other = view(&surface, 11);
                assert!(wait_until(|| first.is_mapped() && other.is_mapped()));
                focus_target(&first, TargetKind::Editor);
                assert!(wait_until(|| has_target_focus(
                    &window,
                    &first,
                    TargetKind::Editor
                )));

                mount_modal(&surface, 20, ModalConfig::default());
                // A focus change elsewhere (e.g. from app logic) before close.
                surface.nav.borrow().scope_focus(&surface);
                crate::text_input::focus(&other);
                assert!(wait_until(|| has_target_focus(
                    &window,
                    &other,
                    TargetKind::Input
                )));
                close_modal_by_remove(&surface, 20);
                assert!(has_target_focus(&window, &other, TargetKind::Input));
                window.destroy();
            }

            // `closeOnEscape` restores editor focus.
            {
                let surface = gtk_test::surface();
                mount_target(&surface, 10, TargetKind::Editor);
                let window = show(&surface);
                let target = view(&surface, 10);
                assert!(wait_until(|| target.is_mapped()));
                focus_target(&target, TargetKind::Editor);
                assert!(wait_until(|| has_target_focus(
                    &window,
                    &target,
                    TargetKind::Editor
                )));
                mount_modal(
                    &surface,
                    20,
                    ModalConfig {
                        close_on_escape: true,
                        ..Default::default()
                    },
                );
                assert!(key_pressed(
                    &surface,
                    gdk::Key::Escape,
                    gdk::ModifierType::empty()
                ));
                assert!(wait_until(|| has_target_focus(
                    &window,
                    &target,
                    TargetKind::Editor
                )));
                window.destroy();
            }

            // `release` restores single-line Input focus without selecting text.
            {
                let surface = gtk_test::surface();
                mount_target(&surface, 10, TargetKind::Input);
                let window = show(&surface);
                let target = view(&surface, 10);
                assert!(wait_until(|| target.is_mapped()));
                focus_target(&target, TargetKind::Input);
                assert!(wait_until(|| has_target_focus(
                    &window,
                    &target,
                    TargetKind::Input
                )));
                if let Some(line) = GtkWindowExt::focus(&window).and_downcast::<gtk::Text>() {
                    line.set_position(5);
                    line.select_region(5, 5);
                }
                mount_modal(&surface, 20, ModalConfig::default());
                release(&surface, 20);
                assert!(wait_until(|| has_target_focus(
                    &window,
                    &target,
                    TargetKind::Input
                )));
                if let Some(line) = GtkWindowExt::focus(&window).and_downcast::<gtk::Text>() {
                    assert_eq!(line.selection_bounds(), None);
                }
                window.destroy();
            }
        });
    }

    /// A page's shader goes with the page, at the end of the batch that
    /// deletes it: its leave in that batch (the stack reconciles at the
    /// end) still goes through it.
    #[test]
    fn a_deleted_page_takes_its_shader_along() {
        gtk_test::run(|| {
            let surface = gtk_test::surface();
            let shader = Shader::compile(
                "fn shade(uv: vec2f) -> vec4f { return mix(sample_from(uv), sample_to(uv), nsh.progress); }",
            )
            .expect("a shader");
            let shader = nsh_core::NavShader::new(
                Arc::new(ShaderLayer::new(shader, &[], &mut Vec::new())),
                Duration::from_millis(500),
            );
            apply(
                &surface,
                &[
                    MountItem::Create {
                        id: 6,
                        kind: ViewKind::Screen,
                    },
                    MountItem::NavShader {
                        id: 6,
                        shader: Some(shader),
                    },
                ],
            );
            end_batch(&surface);
            let kept = || surface.nav.borrow().shaders.contains_key(&6);
            assert!(kept());
            apply(&surface, &[MountItem::Delete { id: 6 }]);
            assert!(kept(), "while the batch that deletes it is applied");
            end_batch(&surface);
            assert!(!kept());
        });
    }
}
