//! Navigation stacks, screens with their headers, modals.
//!
//! A stack's screens are its child views; only the top one shows (and the
//! one below it while a transition runs): the others are
//! [`ViewState::concealed`](crate::view::ViewState::concealed), so they are
//! neither drawn nor hit. Changes of the app's screens are reconciled at
//! the end of each batch, once every item is applied: a new top screen
//! slides in from the right over the previous one (which moves left a bit
//! and dims, as WinUI's and GNOME's navigation views do); a top screen the
//! app removes slides out as it last showed.
//!
//! GPUI has no offscreen pictures to record that last image into (the
//! Windows backend draws it into a Direct2D command list), so a departing
//! screen or modal keeps its views instead: once the batch starts tearing
//! one down ([`removing`]), the mounter's detaching of its descendants is
//! deferred ([`defer_detach`]). At the end of the batch the screen or modal
//! either stayed (then the deferred views are detached after all,
//! [`take_deferred`]) or was removed: then its whole subtree, still
//! intact, goes into a layer view that ignores the pointer and is drawn
//! moving out until the transition ends, when the layer is dropped with
//! everything in it. Views inside a departing layer are never detached
//! one by one (the app may delete them while it leaves). Native surfaces
//! (web views, videos) are destroyed when the app deletes their views, so
//! they are missing from a departing screen.
//!
//! NSH draws no header: a screen's `header` (the app's view,
//! [`ScreenConfig::header_view`]) is a child of the screen whose frame the
//! core sets at its top (as wide as the screen, as tall as it lays out),
//! with the content laid out below it; it is kept above the content. The
//! other header items (the native header's slots on iOS and Android) stay
//! concealed. Under the app's content each screen has an opaque backdrop in
//! the window's color, so a screen sliding over another hides it.
//!
//! Going back (Escape, Alt+Left, Command+[ on macOS, the Browser Back key,
//! the mouse's back button; Escape in a focused text field only leaves it)
//! sends `onBackPress` (`BackRequest`) to the top screen when the app
//! listens, then pops natively unless its `popOnBack` is false, then sends
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
//! when the app removes one it leaves as it last showed (its views kept, as
//! a departing screen's), then gets `onDismiss`.
//!
//! Transitions run on the surface's frame clock ([`Surface::on_frame`])
//! and only move views (`shift`, `fade`): nothing is laid out again while
//! they run.

use std::{cell::Cell, rc::Rc, time::Duration};

use nsh_core::{
    Bounds, Color, EdgeInsets, EventKind, EventPayload, ModalConfig, NodeId, PayloadValue, Points,
    ROOT_ID, ScreenConfig, Size, ViewKind,
    navigation::{
        Back, Reported, Stack, Tick, Transitions, back_target, dim, innermost, insets_payload,
        modal_in_offset, modal_motion, modal_out_offset, pop_offsets, push_offsets, screen_motion,
    },
};
use rustc_hash::FxHashMap;

use crate::{
    geom::rect,
    input::{KeyEvent, Modifiers},
    render::DrawCx,
    surface::Surface,
    view::{Hosted, NshView},
};

/// The node id of the views navigation makes itself (backgrounds, images
/// of leaving screens): never one of the app's (JS ids are even and small,
/// the core's odd and small) and never in the mounter.
const LAYER_ID: NodeId = NodeId::MAX;

const VK_ESCAPE: u16 = 0x1B;
const VK_LEFT: u16 = 0x25;
const VK_BROWSER_BACK: u16 = 0xA6;
/// `[` (Command+[ goes back on macOS).
const VK_OEM_4: u16 = 0xDB;

/// The window's color, under a screen's content (the platform's, so a
/// screen moving over another hides it).
fn window_color(dark: bool) -> Color {
    if dark {
        Color::rgba(0, 0, 0, 255)
    } else {
        Color::rgba(255, 255, 255, 255)
    }
}

/// `color` with its alpha scaled by `f`.
fn with_alpha(color: Color, f: f32) -> Color {
    let (r, g, b, a) = color.to_f64();
    let c = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    Color::rgba(c(r), c(g), c(b), c(a * f64::from(f)))
}

/// A view navigation makes itself (see [`LAYER_ID`]).
fn layer_view() -> NshView {
    NshView::new(LAYER_ID, ViewKind::View)
}

fn set_frame(view: &NshView, frame: Bounds<Points>) {
    let changed = std::mem::replace(&mut view.state_mut().frame, frame) != frame;
    if changed {
        view.moved();
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

/// True when `ancestor` is `view` or one of its ancestors.
fn is_ancestor(ancestor: &NshView, view: &NshView) -> bool {
    let mut v = Some(view.clone());
    while let Some(current) = v {
        if &current == ancestor {
            return true;
        }
        v = current.parent_view();
    }
    false
}

/// True when `view` is drawn: in a surface, and neither it nor an
/// ancestor is concealed or hidden.
pub(crate) fn is_shown(view: &NshView) -> bool {
    let mut v = view.clone();
    loop {
        {
            let s = v.state();
            if s.concealed || s.style.hidden {
                return false;
            }
        }
        match v.parent_view() {
            Some(p) => v = p,
            None => return v.attached(),
        }
    }
}

/// Takes the keyboard focus away from a field inside `view` before it is
/// concealed or removed: typing must not go to a field nobody sees.
fn drop_focus(surface: &Surface, view: &NshView) {
    if let Some(field) = crate::text_input::focused_view(surface)
        && is_ancestor(view, &field)
        && let Some(surface) = Surface::by_key(surface.key())
    {
        crate::text_input::blur_view(&surface, &field);
    }
    if let Some(native) = crate::native::focused_component(surface).and_then(|id| surface.view(id))
        && is_ancestor(view, &native)
    {
        crate::native::focus_surface(surface);
        surface.sync_focus();
    }
}

/// Conceals `view` (or shows it again).
fn set_concealed(surface: &Surface, view: &NshView, concealed: bool) {
    if view.state().concealed == concealed {
        return;
    }
    if concealed {
        drop_focus(surface, view);
    }
    view.state_mut().concealed = concealed;
    view.changed();
}

/// Moves `tail` to the end of `parent`'s children (drawn last), unless it
/// is there already.
fn keep_last(parent: &NshView, tail: &[NshView]) {
    let in_place =
        parent.with_children(|c| c.len() >= tail.len() && c[c.len() - tail.len()..] == *tail);
    if !in_place {
        for v in tail {
            v.insert_before(parent, None);
        }
    }
}

fn reduce_motion(surface: &Surface) -> bool {
    surface.environment.get().reduce_motion
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

/// Escape, Alt+Left and the Browser Back key go back (no other modifier
/// held), and Command+[ on macOS.
fn is_back_key(vk: u16, m: Modifiers) -> bool {
    let others = m.shift || m.ctrl || m.meta;
    match vk {
        VK_ESCAPE | VK_BROWSER_BACK => !others && !m.alt,
        VK_LEFT => m.alt && !others,
        VK_OEM_4 => cfg!(target_os = "macos") && m.meta && !m.shift && !m.ctrl && !m.alt,
        _ => false,
    }
}

/// A layer that holds the subtree of a screen or modal while it leaves
/// (see the module doc): `size` covers the stack or the window, the
/// subtree sits in it at its own frame, and nothing in it takes the
/// pointer.
fn departing_layer(view: &NshView, size: (f32, f32)) -> NshView {
    let layer = layer_view();
    set_frame(&layer, rect(0.0, 0.0, size.0, size.1));
    layer.state_mut().props.pointer_events = nsh_core::PointerEvents::None;
    view.insert_before(&layer, None);
    layer
}

/// The dimming of the screen under a pushed one: a plain fill.
struct Fill {
    color: Cell<Color>,
}

impl Fill {
    fn set_color(&self, color: Color, owner: &NshView) {
        if self.color.replace(color) != color {
            owner.changed();
        }
    }
}

impl Hosted for Fill {
    fn draw(&self, cx: &mut DrawCx<'_>, size: (f32, f32)) {
        let color = self.color.get();
        if color.is_transparent() {
            return;
        }
        cx.fill_rect(rect(0.0, 0.0, size.0, size.1), [0.0; 4], color);
    }

    // The pointer goes on to the screens, as over a plain view.
    fn hit(&self, _x: f32, _y: f32, _size: (f32, f32)) -> bool {
        false
    }
}

/// A screen's backdrop: the window's color in the appearance drawn.
struct Backdrop;

impl Hosted for Backdrop {
    fn draw(&self, cx: &mut DrawCx<'_>, size: (f32, f32)) {
        cx.fill_rect(
            rect(0.0, 0.0, size.0, size.1),
            [0.0; 4],
            window_color(cx.dark),
        );
    }

    // The pointer goes on to the screen, as over a plain view.
    fn hit(&self, _x: f32, _y: f32, _size: (f32, f32)) -> bool {
        false
    }
}

/// One screen.
struct ScreenNav {
    view: NshView,
    config: ScreenConfig,
    /// Its opaque background, under the app's content (its first child),
    /// hosting a [`Backdrop`].
    backdrop: NshView,
    backdrop_item: Rc<dyn Hosted>,
    /// The header items the app inserted (only the `header` one shows).
    items: Vec<NshView>,
    /// The size and insets last reported.
    reported: Reported,
}

impl ScreenNav {
    fn new(view: &NshView) -> Self {
        let backdrop = layer_view();
        let first = view.with_children(|c| c.first().cloned());
        backdrop.insert_before(view, first.as_ref());
        ScreenNav {
            view: view.clone(),
            config: ScreenConfig::default(),
            backdrop,
            backdrop_item: Rc::new(Backdrop),
            items: Vec::new(),
            reported: Reported::default(),
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
        set_frame(&self.backdrop, rect(0.0, 0.0, w, h));
        self.backdrop
            .set_native(&self.backdrop_item, rect(0.0, 0.0, w, h));
        for item in &self.items {
            let shown = Some(item.id()) == self.config.header_view;
            set_concealed(surface, item, !shown);
        }
    }

    /// Keeps the `header` over the app's content (which the app may insert
    /// after it), and the background under it.
    fn raise_header(&self) {
        let first = self.view.with_children(|c| c.first().cloned());
        if first.as_ref() != Some(&self.backdrop) {
            self.backdrop.insert_before(&self.view, first.as_ref());
        }
        let header = self.items.iter().find(|v| {
            Some(v.id()) == self.config.header_view && v.parent_view().as_ref() == Some(&self.view)
        });
        if let Some(header) = header {
            keep_last(&self.view, std::slice::from_ref(header));
        }
    }
}

/// One stack.
struct StackNav {
    view: NshView,
    /// Its screens as shown, and those the user popped.
    screens: Stack,
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
    /// The view that had the keyboard focus when it was presented: it
    /// gets it back when the modal closes, as a desktop dialog gives it
    /// back.
    restore: Option<crate::text_input::FocusTarget>,
}

/// The screen under the moving one darkening (a fill it hosts while the
/// transition runs).
struct Dim {
    view: NshView,
    fill: Rc<Fill>,
    item: Rc<dyn Hosted>,
}

impl Dim {
    fn new(view: &NshView) -> Dim {
        let fill = Rc::new(Fill {
            color: Cell::new(Color::TRANSPARENT),
        });
        let item: Rc<dyn Hosted> = fill.clone();
        let f = view.state().frame;
        view.set_native(&item, rect(0.0, 0.0, f.size.width.0, f.size.height.0));
        Dim {
            view: view.clone(),
            fill,
            item,
        }
    }

    /// Dims at `amount` (0 to 1).
    fn set(&self, amount: f32) {
        self.fill
            .set_color(with_alpha(Color::BLACK, dim(amount)), &self.view);
    }

    fn remove(&self) {
        self.view.remove_native(&self.item);
    }
}

/// What leaves the screen during a pop.
enum Leaving {
    /// The screen itself (popped by the user).
    View(NshView),
    /// A layer view (on top of the stack) holding a screen the app
    /// removed, with its views as they last showed.
    Departed(NshView),
}

enum Motion {
    Push {
        stack: NshView,
        entering: NshView,
        below: Option<NshView>,
        dim: Option<Dim>,
        fade: bool,
    },
    Pop {
        stack: NshView,
        leaving: Leaving,
        below: Option<NshView>,
        dim: Option<Dim>,
        fade: bool,
        /// The screen the user popped: concealed and reported at the end.
        popped: Option<NodeId>,
    },
    ModalIn {
        view: NshView,
        fade: bool,
    },
    ModalOut {
        /// The modal to report `onDismiss` for at the end (`None`: it was
        /// reported when the user closed it).
        dismiss: Option<NodeId>,
        /// A layer view on top of the root, covering it, holding the
        /// modal with its views as they last showed.
        layer: NshView,
        /// The modal (in the layer, unless the app presented it again).
        view: NshView,
        /// The modal's top edge (it slides down from there).
        top: f32,
        fade: bool,
    },
}

impl Motion {
    fn stack(&self) -> Option<&NshView> {
        match self {
            Motion::Push { stack, .. } | Motion::Pop { stack, .. } => Some(stack),
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
    /// Top screens and presented modals this batch started tearing down:
    /// their descendants stay attached until the end of the batch, so they
    /// can leave as they showed (see the module doc).
    keeping: Vec<NshView>,
    /// Views whose detaching was deferred: (view, its parent then, the
    /// kept screen or modal it is in).
    deferred: Vec<(NshView, NshView, NshView)>,
    /// Native roots temporarily detached by list retirement. Their
    /// presentation records and order survive until reinserted or deleted.
    parked: Vec<NshView>,
}

impl Nav {
    /// Forgets the app's views (it stopped; the surface drops its frame
    /// callbacks too).
    pub(crate) fn reset(&mut self) {
        *self = Nav::default();
    }

    fn is_parked(&self, view: &NshView) -> bool {
        self.parked.iter().any(|root| is_ancestor(root, view))
    }

    fn reinserted(&mut self, view: &NshView) -> bool {
        let Some(index) = self.parked.iter().position(|root| root == view) else {
            return false;
        };
        self.parked.swap_remove(index);
        for (id, stack) in &self.stacks {
            if is_ancestor(view, &stack.view) && !self.dirty.contains(id) {
                self.dirty.push(*id);
            }
        }
        true
    }

    fn top_modal(&self) -> Option<NodeId> {
        self.order.iter().rev().copied().find(|id| {
            self.modals
                .get(id)
                .and_then(|modal| modal.view.as_ref())
                .is_some_and(|view| !self.is_parked(view))
        })
    }

    fn screen(&mut self, view: &NshView) -> &mut ScreenNav {
        self.screens
            .entry(view.id())
            .or_insert_with(|| ScreenNav::new(view))
    }

    /// Takes kept screen or modal `id` (see [`Nav::keeping`]).
    fn take_kept(&mut self, id: NodeId) -> Option<NshView> {
        let i = self.keeping.iter().position(|v| v.id() == id)?;
        Some(self.keeping.swap_remove(i))
    }

    /// True when `view` is in the layer of a screen or modal leaving.
    fn in_departing(&self, view: &NshView) -> bool {
        self.transitions.iter().any(|motion| match motion {
            Motion::Pop {
                leaving: Leaving::Departed(layer),
                ..
            }
            | Motion::ModalOut { layer, .. } => is_ancestor(layer, view),
            _ => false,
        })
    }

    /// Whether the mounter's detaching of `view` waits (see
    /// [`defer_detach`]).
    fn defers(&mut self, view: &NshView) -> bool {
        let Some(parent) = view.parent_view() else {
            return false;
        };
        if self.in_departing(&parent) {
            return true;
        }
        let kept = self
            .keeping
            .iter()
            .find(|k| *k != view && is_ancestor(k, &parent))
            .cloned();
        match kept {
            Some(kept) => {
                self.deferred.push((view.clone(), parent, kept));
                true
            }
            None => false,
        }
    }

    /// The deferred views to detach after all: those whose screen or modal
    /// stayed (still shown where it was, not leaving) and that are still
    /// where they were. The screens and modals that stayed are no longer
    /// kept.
    fn stayed(&mut self) -> Vec<NshView> {
        let gone = |nav: &Nav, k: &NshView| !k.attached() || nav.in_departing(k);
        let stayed: Vec<NshView> = self
            .keeping
            .iter()
            .filter(|k| !gone(self, k))
            .cloned()
            .collect();
        self.keeping.retain(|k| !stayed.contains(k));
        let mut detach = Vec::new();
        self.deferred.retain(|(view, parent, kept)| {
            if !stayed.contains(kept) {
                return true;
            }
            if view.parent_view().as_ref() == Some(parent) {
                detach.push(view.clone());
            }
            false
        });
        detach
    }

    /// Ends the transitions `which` selects at once.
    fn finish(&mut self, surface: &Surface, which: impl Fn(&Motion) -> bool) {
        for motion in self.transitions.take(which) {
            self.end(surface, motion);
        }
    }

    /// Puts the views of `motion` where they are at eased progress `e`.
    fn apply(surface: &Surface, motion: &Motion, e: f32) {
        match motion {
            Motion::Push {
                stack,
                entering,
                below,
                dim,
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
                if let Some(dim) = dim {
                    dim.set(e);
                }
            }
            Motion::Pop {
                stack,
                leaving,
                below,
                dim,
                fade,
                ..
            } => {
                let (x, below_x) = pop_offsets(stack.state().frame.size.width, e);
                let v = match leaving {
                    Leaving::View(v) | Leaving::Departed(v) => v,
                };
                if *fade {
                    set_fade(v, 1.0 - e);
                } else {
                    set_shift(v, (x.0, 0.0));
                    if let Some(below) = below {
                        set_shift(below, (below_x.0, 0.0));
                    }
                }
                if let Some(dim) = dim {
                    dim.set(1.0 - e);
                }
            }
            Motion::ModalIn { view, fade } => {
                if *fade {
                    set_fade(view, e);
                } else {
                    // From below the window's bottom edge.
                    let h = surface.root.state().frame.size.height.0;
                    let y = view.state().frame.origin.y.0;
                    set_shift(view, (0.0, modal_in_offset(Points(h - y), e).0));
                }
            }
            Motion::ModalOut {
                layer, top, fade, ..
            } => {
                if *fade {
                    set_fade(layer, 1.0 - e);
                } else {
                    let h = surface.root.state().frame.size.height.0;
                    set_shift(layer, (0.0, modal_out_offset(Points(h - top), e).0));
                }
            }
        }
    }

    fn end(&mut self, surface: &Surface, motion: Motion) {
        Self::apply(surface, &motion, 1.0);
        match motion {
            Motion::Push { stack, dim, .. } => {
                if let Some(dim) = dim {
                    dim.remove();
                }
                self.settle(surface, stack.id());
            }
            Motion::Pop {
                stack,
                leaving,
                dim,
                popped,
                ..
            } => {
                if let Some(dim) = dim {
                    dim.remove();
                }
                match leaving {
                    Leaving::View(v) => {
                        set_concealed(surface, &v, true);
                        set_shift(&v, (0.0, 0.0));
                        set_fade(&v, 1.0);
                    }
                    Leaving::Departed(layer) => layer.unparent(),
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
            Motion::ModalOut { dismiss, layer, .. } => {
                layer.unparent();
                if let Some(id) = dismiss {
                    surface.event(id, EventKind::Dismiss, EventPayload::None);
                }
            }
        }
    }

    /// Shows only the top screen of `stack`, where it belongs.
    fn settle(&mut self, surface: &Surface, stack: NodeId) {
        let Some(st) = self.stacks.get(&stack) else {
            return;
        };
        let top = st.screens.top();
        for view in st.view.child_views() {
            if view.kind() != ViewKind::Screen {
                continue;
            }
            set_concealed(surface, &view, Some(view.id()) != top);
            set_shift(&view, (0.0, 0.0));
            set_fade(&view, 1.0);
        }
    }

    fn start(&mut self, surface: &Rc<Surface>, duration: Duration, motion: Motion) {
        Self::apply(surface, &motion, 0.0);
        self.transitions.push(duration, motion);
        if self.ticking {
            return;
        }
        self.ticking = true;
        surface.on_frame(|surface, now| {
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
                Tick::At(i, e) => Self::apply(surface, &self.transitions[i], e),
            }
        }
    }

    /// Shows the app's screens of `stack` after a batch changed them.
    fn reconcile(&mut self, surface: &Rc<Surface>, stack_id: NodeId) {
        if self
            .stacks
            .get(&stack_id)
            .is_some_and(|stack| self.is_parked(&stack.view))
        {
            return;
        }
        self.finish(surface, |m| m.stack().is_some_and(|s| s.id() == stack_id));
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
        // The top screen the app removed, with its views as they showed.
        let departed = match old {
            Some(old) if Some(old) != new && find(old).is_none() => self.take_kept(old),
            _ => None,
        };
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
            let s = self.screen(&view);
            // Every time (it only reports changes): the stack may have been
            // sized before its screens were known to it.
            s.report(surface, &stack);
        }
        if children.is_empty() && stack.parent_view().is_none() {
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
        let Some((duration, fade)) =
            screen_motion(animation.unwrap_or_default(), reduce_motion(surface))
        else {
            return;
        };
        let below = if pushing { find(old) } else { find(new) };
        if let Some(b) = &below {
            set_concealed(surface, b, false);
        }
        let dim = below.as_ref().filter(|_| !fade).map(Dim::new);
        if pushing {
            let Some(entering) = find(new) else { return };
            let motion = Motion::Push {
                stack,
                entering,
                below,
                dim,
                fade,
            };
            self.start(surface, duration, motion);
        } else {
            let leaving = match find(old) {
                Some(v) => {
                    set_concealed(surface, &v, false);
                    Leaving::View(v)
                }
                None => {
                    let Some(view) = departed else {
                        if let Some(dim) = dim {
                            dim.remove();
                        }
                        self.settle(surface, stack_id);
                        return;
                    };
                    let layer = departing_layer(&view, (frame.size.width.0, frame.size.height.0));
                    layer.insert_before(&stack, None);
                    Leaving::Departed(layer)
                }
            };
            let motion = Motion::Pop {
                stack,
                leaving,
                below,
                dim,
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
        self.finish(surface, |m| m.stack().is_some_and(|s| s.id() == stack_id));
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
        let animation = self.screens.get(&top).map(|s| s.config.animation);
        match (
            screen_motion(animation.unwrap_or_default(), reduce_motion(surface)),
            find(top),
        ) {
            (Some((duration, fade)), Some(leaving)) => {
                if let Some(b) = &below {
                    set_concealed(surface, b, false);
                }
                let dim = below.as_ref().filter(|_| !fade).map(Dim::new);
                let motion = Motion::Pop {
                    stack,
                    leaving: Leaving::View(leaving),
                    below,
                    dim,
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
            within.is_none_or(|w| is_ancestor(w, &st.view))
                && !self.is_parked(&st.view)
                && st.screens.takes_back(|top| {
                    self.screens
                        .get(&top)
                        .is_some_and(|s| s.config.prevent_back)
                })
                && is_shown(&st.view)
        };
        let candidates: Vec<&StackNav> = self.stacks.values().filter(|s| wants(s)).collect();
        innermost(&candidates, |c, o| is_ancestor(&c.view, &o.view)).map(|c| c.view.id())
    }

    /// Takes modal `id` away natively (it leaves as it last showed, its
    /// views kept), then reports `onDismiss` unless `reported` already.
    fn close_modal(&mut self, surface: &Rc<Surface>, id: NodeId, reported: bool) {
        self.finish(
            surface,
            |m| matches!(m, Motion::ModalIn { view, .. } if view.id() == id),
        );
        self.order.retain(|&m| m != id);
        // Its descendants were kept for this; once it is in its departing
        // layer, they stay with it.
        self.take_kept(id);
        let Some(m) = self.modals.get_mut(&id) else {
            return;
        };
        let Some(view) = m.view.take() else { return };
        let restore = m.restore.take();
        let motion = modal_motion(m.config.animation, reduce_motion(surface));
        let frame = view.state().frame;
        let leaves = motion.filter(|_| frame.size.width.0 > 0.0 && is_shown(&view));
        drop_focus(surface, &view);
        view.unparent();
        set_shift(&view, (0.0, 0.0));
        set_fade(&view, 1.0);
        if let Some(field) = restore
            && field.valid(surface)
            && crate::text_input::focused_view(surface).is_none()
            && is_ancestor(&self.focus_scope(surface), field.view())
        {
            // The navigation borrow is held: use the already checked scope.
            crate::input::restore_focus(surface, &field);
        }
        match leaves {
            Some((duration, fade)) => {
                let f = surface.root.state().frame;
                let layer = departing_layer(&view, (f.size.width.0, f.size.height.0));
                layer.insert_before(&surface.root, None);
                let motion = Motion::ModalOut {
                    dismiss: (!reported).then_some(id),
                    view,
                    layer,
                    top: frame.origin.y.0,
                    fade,
                };
                self.start(surface, duration, motion);
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
        if self.is_parked(&view) {
            return;
        }
        // `present` hid it: a fade starts it transparent again, a slide
        // moves it in as it is, without an animation it shows at once.
        set_fade(&view, 1.0);
        match modal_motion(m.config.animation, reduce_motion(surface)) {
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
        let back_press = surface.root.state().events.contains(EventKind::BackPress);
        self.go_back_to(surface, back_press)
    }

    /// Goes back to what [`Nav::back_target`] names.
    fn go_back_to(&mut self, surface: &Rc<Surface>, back_press: bool) -> bool {
        match self.back_target(back_press) {
            Some(Back::Stack(stack)) => self.back(surface, stack),
            Some(Back::Modal(id)) => self.request_close(surface, id),
            Some(Back::App) => surface.event(ROOT_ID, EventKind::BackPress, EventPayload::None),
            None => return false,
        }
        true
    }

    /// Where the keyboard focus may go: the newest modal, else the whole
    /// surface.
    fn focus_scope(&self, surface: &Surface) -> NshView {
        self.top_modal()
            .and_then(|id| self.modals.get(&id))
            .and_then(|m| m.view.clone())
            .unwrap_or_else(|| surface.root.clone())
    }

    /// What going back acts on (`back_press`: the app listens to
    /// `onBackPress`, and hears it before the stacks).
    fn back_target(&self, back_press: bool) -> Option<Back> {
        back_target(self.top_modal(), back_press, |modal| {
            let view = modal.and_then(|id| self.modals.get(&id)?.view.clone());
            self.back_stack(view.as_ref())
        })
    }

    /// Keeps the presented modals (and those leaving) over the app's
    /// views, each sheet right above its scrim.
    fn raise_modals(&self, surface: &Surface) {
        let mut tail: Vec<NshView> = Vec::new();
        for m in self.order.iter().filter_map(|id| self.modals.get(id)) {
            if let Some(view) = &m.view
                && !self.is_parked(view)
            {
                tail.push(view.clone());
            }
        }
        for motion in self.transitions.iter() {
            if let Motion::ModalOut { layer, .. } = motion {
                tail.push(layer.clone());
            }
        }
        keep_last(&surface.root, &tail);
    }

    /// Sizes modal `id` to the surface and reports it (with the surface's
    /// safe area).
    fn size_modal(&mut self, surface: &Surface, id: NodeId) {
        if self
            .modals
            .get(&id)
            .and_then(|modal| modal.view.as_ref())
            .is_some_and(|view| self.is_parked(view))
        {
            return;
        }
        let Some(m) = self.modals.get_mut(&id) else {
            return;
        };
        let Some(view) = &m.view else { return };
        let f = surface.root.state().frame;
        let frame = rect(0.0, 0.0, f.size.width.0, f.size.height.0);
        set_frame(view, frame);
        let size = frame.size;
        report(surface, id, &mut m.reported, size, safe_area(surface));
    }

    /// Keeps the views of `view` (a top screen or a presented modal)
    /// until the end of the batch, unless it would leave without a
    /// transition anyway.
    fn keep(&mut self, view: &NshView, animated: bool) {
        if animated && !self.keeping.contains(view) {
            self.keeping.push(view.clone());
        }
    }
}

/// `Command::Back`: goes back as without the app's listeners, once the
/// batch being applied is in.
pub(crate) fn default_back(surface: &Rc<Surface>) {
    let key = surface.key();
    crate::rt::invoke(move || {
        if let Some(surface) = Surface::by_key(key)
            && let Ok(mut nav) = surface.nav.try_borrow_mut()
        {
            nav.go_back_to(&surface, false);
        }
    });
}

/// Goes back (the newest modal, the innermost stack or the app's
/// `onBackPress`): whether something took it.
pub(crate) fn go_back(surface: &Rc<Surface>) -> bool {
    match surface.nav.try_borrow_mut() {
        Ok(mut nav) => nav.go_back(surface),
        Err(_) => false,
    }
}

/// A key nothing in the window used: Escape, Alt+Left and the Browser Back
/// key go back. Whether it was taken. Escape in a focused text field only
/// leaves the field (a desktop convention: it never navigates away from
/// what is being typed); Alt+Left and the Back key still go back. A key
/// held down goes back once.
pub(crate) fn key_pressed(surface: &Rc<Surface>, event: &KeyEvent) -> bool {
    if !event.down || event.repeat || !is_back_key(event.vk, event.modifiers) {
        return false;
    }
    if event.vk == VK_ESCAPE
        && let Some(field) = crate::text_input::focused(surface)
    {
        crate::text_input::blur(&field);
        return true;
    }
    go_back(surface)
}

/// A view is about to be removed or deleted: when it is (or is inside) the
/// top screen of a stack or a presented modal, that screen's or modal's
/// views are kept until the end of the batch ([`defer_detach`]), to leave
/// as they showed if the app removes it (later in the batch, in whatever
/// order the app releases its views).
pub(crate) fn removing(surface: &Rc<Surface>, view: &NshView) {
    let Ok(mut nav) = surface.nav.try_borrow_mut() else {
        return;
    };
    if nav.stacks.is_empty() && nav.order.is_empty() {
        return;
    }
    let reduce = reduce_motion(surface);
    let mut child = view.clone();
    loop {
        let parent = child.parent_view();
        let id = child.id();
        match child.kind() {
            ViewKind::Screen => {
                let on_top = parent.as_ref().is_some_and(|p| {
                    nav.stacks
                        .get(&p.id())
                        .is_some_and(|st| st.screens.top() == Some(id))
                });
                if on_top {
                    let animated = nav
                        .screens
                        .get(&id)
                        .is_none_or(|s| screen_motion(s.config.animation, reduce).is_some());
                    nav.keep(&child, animated);
                }
            }
            ViewKind::Modal => {
                let presented = nav
                    .modals
                    .get(&id)
                    .and_then(|m| m.view.as_ref().map(|v| (v == &child, m.config.animation)));
                if let Some((true, animation)) = presented {
                    let animated = modal_motion(animation, reduce).is_some();
                    nav.keep(&child, animated);
                }
            }
            _ => {}
        }
        match parent {
            Some(p) => child = p,
            None => break,
        }
    }
}

/// Temporarily parks the native roots identified by one core list cell.
/// Presentation order, return owners and popped screens remain native state;
/// neither parking nor restoring a retained row presents or dismisses it.
pub(crate) fn park(surface: &Rc<Surface>, roots: &[NshView]) {
    let within = |view: &NshView| roots.iter().any(|root| is_ancestor(root, view));
    let mut nav = surface.nav.borrow_mut();
    let affected_stacks: Vec<_> = nav
        .stacks
        .iter()
        .filter_map(|(id, stack)| {
            (within(&stack.view) || stack.view.child_views().iter().any(within)).then_some(*id)
        })
        .collect();
    let motions = nav.transitions.take(|motion| match motion {
        Motion::Push {
            stack,
            entering,
            below,
            ..
        } => within(stack) || within(entering) || below.as_ref().is_some_and(within),
        Motion::Pop {
            stack,
            leaving,
            below,
            ..
        } => {
            within(stack)
                || within(match leaving {
                    Leaving::View(view) | Leaving::Departed(view) => view,
                })
                || below.as_ref().is_some_and(within)
        }
        Motion::ModalIn { view, .. } => within(view),
        Motion::ModalOut { view, layer, .. } => within(view) || within(layer),
    });
    let reset = |view: &NshView| {
        set_shift(view, (0.0, 0.0));
        set_fade(view, 1.0);
    };
    for motion in motions {
        match motion {
            Motion::Push {
                entering,
                below,
                dim,
                ..
            } => {
                if let Some(dim) = dim {
                    dim.remove();
                }
                reset(&entering);
                if let Some(below) = below {
                    reset(&below);
                }
            }
            Motion::Pop {
                leaving,
                below,
                dim,
                popped,
                ..
            } => {
                if let Some(dim) = dim {
                    dim.remove();
                }
                match leaving {
                    Leaving::View(view) => reset(&view),
                    Leaving::Departed(layer) => layer.unparent(),
                }
                if let Some(below) = below {
                    reset(&below);
                }
                if let Some(id) = popped {
                    surface.event(id, EventKind::Dismiss, EventPayload::None);
                }
            }
            Motion::ModalIn { view, .. } => reset(&view),
            Motion::ModalOut {
                view,
                layer,
                dismiss,
                ..
            } => {
                reset(&view);
                layer.unparent();
                if let Some(id) = dismiss {
                    surface.event(id, EventKind::Dismiss, EventPayload::None);
                }
            }
        }
    }
    nav.keeping.retain(|view| !within(view));
    nav.deferred
        .retain(|(view, parent, kept)| !within(view) && !within(parent) && !within(kept));
    nav.dirty.retain(|id| !affected_stacks.contains(id));
    let presenting = std::mem::take(&mut nav.presenting);
    nav.presenting = presenting
        .into_iter()
        .filter(|id| {
            nav.modals
                .get(id)
                .and_then(|modal| modal.view.as_ref())
                .is_none_or(|view| !within(view))
        })
        .collect();
    for root in roots {
        if !nav.parked.contains(root) {
            nav.parked.push(root.clone());
        }
        reset(root);
        root.unparent();
    }
}

/// Whether a live native view is temporarily owned by a parked list root.
pub(crate) fn is_parked(surface: &Surface, view: &NshView) -> bool {
    surface.nav.borrow().is_parked(view)
}

/// An ordinary root has been inserted back into its native parent. Its
/// retained stack state is reconciled only after the whole batch returns.
pub(crate) fn reinserted(surface: &Rc<Surface>, view: &NshView) -> bool {
    surface.nav.borrow_mut().reinserted(view)
}

/// A real source removal ends parking; the ordinary removal path still
/// dismisses navigation and revokes return ownership as before.
pub(crate) fn source_removing(surface: &Surface, view: &NshView) {
    surface
        .nav
        .borrow_mut()
        .parked
        .retain(|root| !is_ancestor(view, root));
}

/// The mounter detaches `view` (removed or deleted): true when that waits,
/// because `view` is inside a top screen or modal the batch started
/// tearing down (it may leave as it showed; [`take_deferred`] hands back
/// the views to detach after all) or inside one leaving (it goes with
/// it).
pub(crate) fn defer_detach(surface: &Surface, view: &NshView) -> bool {
    match surface.nav.try_borrow_mut() {
        Ok(mut nav) => nav.defers(view),
        Err(_) => false,
    }
}

/// The batch is applied, before [`end_batch`]: the views whose detaching
/// waited and that the mounter detaches now (their screen or modal
/// stayed).
pub(crate) fn take_deferred(surface: &Surface) -> Vec<NshView> {
    match surface.nav.try_borrow_mut() {
        Ok(mut nav) => nav.stayed(),
        Err(_) => Vec::new(),
    }
}

/// A screen was pushed (`added`) or popped in `stack`.
pub(crate) fn stack_changed(surface: &Rc<Surface>, stack: &NshView, added: Option<&NshView>) {
    let mut nav = surface.nav.borrow_mut();
    let id = stack.id();
    nav.stacks.entry(id).or_insert_with(|| StackNav {
        view: stack.clone(),
        screens: Stack::default(),
    });
    if let Some(screen) = added.filter(|v| v.kind() == ViewKind::Screen) {
        nav.screen(screen);
        // Until the end of the batch decides which screen shows: a screen
        // pushed under the top one must not flash.
        if nav.stacks[&id]
            .screens
            .top()
            .is_some_and(|top| top != screen.id())
        {
            set_concealed(surface, screen, true);
        }
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
    let s = nav.screen(view);
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
    if nav.modals.get(&id).is_some_and(|m| m.view.is_some()) {
        if nav.reinserted(view) {
            view.insert_before(&surface.root, None);
            set_shift(view, (0.0, 0.0));
            set_fade(view, 1.0);
            nav.size_modal(surface, id);
        }
        return;
    }
    // Presented again while it leaves: it stops leaving.
    nav.finish(
        surface,
        |m| matches!(m, Motion::ModalOut { view: v, .. } if v == view),
    );
    let m = nav.modals.entry(id).or_default();
    // The field being typed in under the modal leaves it (until the modal
    // closes); one of the modal's own keeps it.
    let field = crate::text_input::focused_target(surface)
        .or_else(|| {
            crate::native::focused_component(surface)
                .and_then(|id| surface.view(id))
                .map(crate::text_input::FocusTarget::View)
        })
        .filter(|f| !is_ancestor(view, f.view()));
    if let Some(field) = &field {
        drop_focus(surface, field.view());
    }
    m.restore = field;
    m.view = Some(view.clone());
    m.closed = false;
    m.reported = Reported::default();
    view.insert_before(&surface.root, None);
    nav.order.push(id);
    nav.size_modal(surface, id);
    // Shown at the end of the batch, as the options it brings say (its
    // `ModalConfig` comes after this item); until then it does not show.
    set_fade(view, 0.0);
    nav.presenting.push(id);
}

/// Where the keyboard focus may go (Tab): the newest modal, else the whole
/// surface.
pub(crate) fn focus_scope(surface: &Surface) -> NshView {
    surface.nav.borrow().focus_scope(surface)
}

/// The presented modals' return owners, captured before a mount batch can
/// remove a popup or modal they opened from.
pub(crate) fn focus_returns(
    surface: &Surface,
) -> Vec<(NshView, Option<crate::text_input::FocusTarget>)> {
    let nav = surface.nav.borrow();
    nav.order
        .iter()
        .filter_map(|id| {
            let modal = nav.modals.get(id)?;
            Some((modal.view.clone()?, modal.restore.clone()))
        })
        .collect()
}

/// Inherit a retiring scope's surviving owner. Native modal dismissal
/// still consumes this same return target, including outside mount batches.
pub(crate) fn set_focus_return(
    surface: &Surface,
    view: &NshView,
    target: Option<crate::text_input::FocusTarget>,
) {
    let mut nav = surface.nav.borrow_mut();
    if let Some(modal) = nav.modals.get_mut(&view.id())
        && modal.view.as_ref() == Some(view)
    {
        modal.restore = target;
    }
}

/// A modal was removed: dismiss it.
pub(crate) fn dismiss(surface: &Rc<Surface>, view: &NshView) {
    let mut nav = surface.nav.borrow_mut();
    let id = view.id();
    match nav.modals.get_mut(&id) {
        // The user closed it already, and it was reported.
        Some(m) if m.closed => m.closed = false,
        Some(_) => nav.close_modal(surface, id, false),
        None => {
            drop_focus(surface, view);
            view.unparent();
        }
    }
}

/// A header item was inserted into `parent` (a screen).
pub(crate) fn header_item(surface: &Rc<Surface>, parent: &NshView, child: &NshView) {
    let mut nav = surface.nav.borrow_mut();
    if child.parent_view().as_ref() != Some(parent) {
        child.insert_before(parent, None);
    }
    nav.reinserted(child);
    let s = nav.screen(parent);
    if !s.items.contains(child) {
        s.items.push(child.clone());
    }
    // Shown by the screen's layout at the end of the batch when it is the
    // `header` (the core places it).
    set_concealed(surface, child, true);
}

/// A header item was removed.
pub(crate) fn header_item_removed(surface: &Rc<Surface>, view: &NshView) {
    let mut nav = surface.nav.borrow_mut();
    if let Some(screen) = view.parent_view()
        && let Some(s) = nav.screens.get_mut(&screen.id())
    {
        s.items.retain(|v| v != view);
    }
    view.unparent();
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
    for stack in std::mem::take(&mut nav.dirty) {
        nav.reconcile(surface, stack);
    }
    let presented = !nav.presenting.is_empty();
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
    // Screens and modals that left took their views along.
    nav.keeping.clear();
    nav.deferred.clear();
    let scope = nav.focus_scope(surface);
    let focus = crate::text_input::focused_view(surface)
        .or_else(|| crate::native::focused_component(surface).and_then(|id| surface.view(id)));
    let needs_focus = presented
        && !focus.is_some_and(|view| {
            is_ancestor(&scope, &view) && crate::input::focusable(surface, &view)
        });
    drop(nav);
    if needs_focus {
        crate::input::tab_to_edge(surface, false);
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::{
        ModalAnimation,
        element::{IntoElement, ParentElement, Styled, component, engine_context, text},
    };

    use super::*;

    #[component]
    fn RetirementNavigation() -> impl IntoElement {
        let count = engine_context::<std::sync::atomic::AtomicUsize>().unwrap();
        nsh_base::nav_stack()
            .flex_1()
            .child(nsh_base::nav_page().title("home").child(text("home")))
            .child(
                nsh_base::nav_page()
                    .title("detail")
                    .on_dismiss(move |_: &()| {
                        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    })
                    .child(text("detail")),
            )
    }

    #[test]
    fn back_keys() {
        let none = Modifiers::default();
        let alt = Modifiers { alt: true, ..none };
        let ctrl = Modifiers { ctrl: true, ..none };
        assert!(is_back_key(VK_ESCAPE, none));
        assert!(is_back_key(VK_BROWSER_BACK, none));
        assert!(is_back_key(VK_LEFT, alt));
        assert!(!is_back_key(VK_LEFT, none));
        assert!(!is_back_key(VK_ESCAPE, ctrl));
        assert!(!is_back_key(VK_LEFT, Modifiers { ctrl: true, ..alt }));
        assert!(!is_back_key(0x41, none));
    }

    /// A root that counts as attached to a surface, and views under it.
    fn root() -> NshView {
        let root = NshView::new(ROOT_ID, ViewKind::View);
        root.set_invalidate(Rc::new(|| {}));
        root
    }

    fn child(parent: &NshView, id: NodeId, kind: ViewKind) -> NshView {
        let v = NshView::new(id, kind);
        v.insert_before(parent, None);
        v
    }

    /// A stack under `parent` with screens `ids` (the last on top).
    fn stack(nav: &mut Nav, parent: &NshView, id: NodeId, ids: &[NodeId]) -> NshView {
        let stack = child(parent, id, ViewKind::Stack);
        for &s in ids {
            let screen = child(&stack, s, ViewKind::Screen);
            nav.screen(&screen);
            if s != *ids.last().unwrap() {
                screen.state_mut().concealed = true;
            }
        }
        let mut screens = Stack::default();
        screens.reconcile(ids);
        nav.stacks.insert(
            id,
            StackNav {
                view: stack.clone(),
                screens,
            },
        );
        stack
    }

    #[test]
    fn going_back_pops_the_innermost_stack() {
        let root = root();
        let mut nav = Nav::default();
        // Nothing to pop: the app's onBackPress, if it listens.
        assert_eq!(nav.back_target(false), None);
        assert_eq!(nav.back_target(true), Some(Back::App));
        let outer = stack(&mut nav, &root, 2, &[4, 6]);
        assert_eq!(nav.back_target(false), Some(Back::Stack(2)));
        // The app's listeners hear it before the stack pops.
        assert_eq!(nav.back_target(true), Some(Back::App));
        // A stack inside the top screen, with a screen to pop: it goes
        // first.
        let top = outer.child_views().last().cloned().unwrap();
        stack(&mut nav, &top, 8, &[10, 12]);
        assert_eq!(nav.back_target(false), Some(Back::Stack(8)));
        // A stack in a concealed screen does not count.
        let below = outer.child_views()[0].clone();
        stack(&mut nav, &below, 14, &[16, 18]);
        assert_eq!(nav.back_target(false), Some(Back::Stack(8)));
        // A single screen that prevents going back still hears it.
        let lone = stack(&mut nav, &root, 20, &[22]);
        nav.stacks.remove(&2);
        nav.stacks.remove(&8);
        nav.screens.get_mut(&22).unwrap().config.prevent_back = true;
        assert_eq!(nav.back_target(false), Some(Back::Stack(20)));
        drop(lone);
    }

    #[test]
    fn going_back_asks_the_newest_modal_first() {
        let root = root();
        let mut nav = Nav::default();
        stack(&mut nav, &root, 2, &[4, 6]);
        let modal = child(&root, 30, ViewKind::Modal);
        nav.modals.insert(
            30,
            ModalNav {
                view: Some(modal.clone()),
                ..ModalNav::default()
            },
        );
        nav.order.push(30);
        // The stack outside the modal does not pop.
        assert_eq!(nav.back_target(true), Some(Back::Modal(30)));
        // A stack inside it does.
        stack(&mut nav, &modal, 32, &[34, 36]);
        assert_eq!(nav.back_target(true), Some(Back::Stack(32)));
        // Popped down to one screen: the modal is asked to close.
        nav.stacks.get_mut(&32).unwrap().screens.pop();
        assert_eq!(nav.back_target(true), Some(Back::Modal(30)));
    }

    #[test]
    fn header_views_stay_above_the_content() {
        let screen = NshView::new(4, ViewKind::Screen);
        let mut s = ScreenNav::new(&screen);
        let header = child(&screen, 5, ViewKind::HeaderItem);
        s.items.push(header.clone());
        s.config.header_view = Some(5);
        let content = child(&screen, 6, ViewKind::View);
        s.raise_header();
        assert_eq!(
            screen.child_views(),
            vec![s.backdrop.clone(), content.clone(), header.clone()]
        );
        // Content inserted later goes under the header again.
        let more = child(&screen, 8, ViewKind::View);
        s.raise_header();
        assert_eq!(
            screen.child_views(),
            vec![s.backdrop.clone(), content, more, header.clone()]
        );
        header.unparent();
        s.raise_header();
        assert!(header.parent_view().is_none());
        header.insert_before(&screen, None);
        s.raise_header();
        assert_eq!(screen.child_views().last(), Some(&header));
    }

    #[test]
    fn parked_modals_restore_their_existing_order_without_presenting_again() {
        let surface = Surface::new(nsh_engine::Environment::default());
        let lower = child(&surface.root, 2, ViewKind::Modal);
        let upper = child(&surface.root, 4, ViewKind::Modal);
        for modal in [&lower, &upper] {
            modal_config(
                &surface,
                modal,
                &ModalConfig {
                    animation: ModalAnimation::None,
                    ..Default::default()
                },
            );
            present(&surface, modal);
        }
        end_batch(&surface);
        assert_eq!(surface.nav.borrow().order, vec![2, 4]);

        park(&surface, std::slice::from_ref(&lower));
        end_batch(&surface);
        assert!(!lower.attached());
        assert_eq!(focus_scope(&surface), upper);
        assert_eq!(surface.nav.borrow().order, vec![2, 4]);

        present(&surface, &lower);
        assert!(surface.nav.borrow().presenting.is_empty());
        end_batch(&surface);
        assert!(lower.attached());
        assert_eq!(surface.nav.borrow().order, vec![2, 4]);
        assert_eq!(
            surface.root.child_views(),
            vec![lower.clone(), upper.clone()]
        );
        assert_eq!(focus_scope(&surface), upper);
        assert!(surface.nav.borrow().transitions.is_empty());

        park(&surface, std::slice::from_ref(&lower));
        source_removing(&surface, &lower);
        dismiss(&surface, &lower);
        assert!(!is_parked(&surface, &lower));
        assert_eq!(surface.nav.borrow().order, vec![4]);
    }

    #[test]
    fn parking_a_stack_preserves_its_native_popped_screens() {
        let surface = Surface::new(nsh_engine::Environment::default());
        let owner = child(&surface.root, 2, ViewKind::View);
        stack(&mut surface.nav.borrow_mut(), &owner, 4, &[6, 8]);
        let expected = {
            let mut nav = surface.nav.borrow_mut();
            let stack = nav.stacks.get_mut(&4).unwrap();
            assert_eq!(stack.screens.pop(), Some(8));
            stack.screens.clone()
        };
        park(&surface, std::slice::from_ref(&owner));
        end_batch(&surface);
        assert_eq!(surface.nav.borrow().stacks[&4].screens, expected);
        owner.insert_before(&surface.root, None);
        assert!(reinserted(&surface, &owner));
        end_batch(&surface);
        assert_eq!(surface.nav.borrow().stacks[&4].screens, expected);
        assert!(surface.nav.borrow().transitions.is_empty());
    }

    #[gpui::test]
    fn parking_during_a_user_pop_delivers_its_existing_dismiss_once(cx: &mut gpui::TestAppContext) {
        use std::{sync::atomic::AtomicUsize, time::Instant};

        fn flush(surface: &Rc<Surface>) {
            let (tx, rx) = crossbeam_channel::bounded(1);
            surface.control(|control| {
                control.advance_clock(Duration::ZERO, move || tx.send(()).unwrap());
            });
            rx.recv_timeout(Duration::from_secs(5)).unwrap();
            surface.drain();
        }

        cx.executor().allow_parking();
        let context = nsh_core::element::EngineContext::default().with(AtomicUsize::new(0));
        let count = context.get::<AtomicUsize>().unwrap();
        let (surface, _app) = cx.update(|cx| {
            let app = crate::rt::init_test_app(cx);
            let surface = Surface::new(nsh_engine::Environment::default());
            surface.set_error_handler(Box::new(|error| panic!("{error:?}")));
            surface.resized(640.0, 384.0, 1.0);
            *surface.text_system.borrow_mut() = Some(cx.text_system().clone());
            surface.start(
                nsh_engine::EngineConfig {
                    context,
                    ..nsh_engine::EngineConfig::new(nsh_engine::App::Rust(
                        nsh_core::element::Root::of::<RetirementNavigation>(),
                    ))
                },
                false,
            );
            (surface, app)
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        let stack = loop {
            flush(&surface);
            if let Some(stack) = surface
                .nav
                .borrow()
                .stacks
                .values()
                .find(|stack| {
                    stack.screens.shown().len() == 2 && stack.view.state().frame.size.width.0 > 0.0
                })
                .map(|stack| stack.view.clone())
            {
                break stack;
            }
            assert!(Instant::now() < deadline, "native stack did not mount");
        };
        assert!(go_back(&surface));
        assert!(
            surface
                .nav
                .borrow()
                .transitions
                .iter()
                .any(|motion| matches!(
                    motion,
                    Motion::Pop {
                        popped: Some(_),
                        ..
                    }
                ))
        );
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 0);
        park(&surface, std::slice::from_ref(&stack));
        flush(&surface);
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 1);
        surface
            .nav
            .borrow_mut()
            .tick(&surface, surface.clock() + 10.0);
        flush(&surface);
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 1);
        surface.stop();
    }

    #[test]
    fn a_departing_screen_keeps_its_views() {
        let root = root();
        let mut nav = Nav::default();
        let stack = stack(&mut nav, &root, 2, &[4, 6]);
        let top = stack.child_views()[1].clone();
        let content = child(&top, 8, ViewKind::View);
        let label = child(&content, 10, ViewKind::Text);
        // Nothing kept: views detach at once.
        assert!(!nav.defers(&label));
        // The batch tears the top screen down: its views wait.
        nav.keep(&top, true);
        assert!(nav.defers(&label));
        assert!(nav.defers(&content));
        // The screen itself leaves its stack.
        assert!(!nav.defers(&top));
        top.unparent();
        // It is gone: nothing is detached, the subtree is intact.
        assert!(nav.stayed().is_empty());
        assert_eq!(label.parent_view(), Some(content.clone()));
        assert_eq!(nav.take_kept(6), Some(top));
    }

    #[test]
    fn views_of_a_screen_that_stayed_detach_at_the_end() {
        let root = root();
        let mut nav = Nav::default();
        let stack = stack(&mut nav, &root, 2, &[4]);
        let top = stack.child_views()[0].clone();
        let a = child(&top, 8, ViewKind::View);
        let b = child(&top, 10, ViewKind::View);
        nav.keep(&top, true);
        assert!(nav.defers(&a));
        assert!(nav.defers(&b));
        // `b` moved elsewhere in the batch: it stays where it went.
        b.insert_before(&root, None);
        assert_eq!(nav.stayed(), vec![a]);
        assert!(nav.keeping.is_empty());
        assert!(nav.deferred.is_empty());
        // A screen that leaves without a transition keeps nothing.
        nav.keep(&top, false);
        assert!(nav.keeping.is_empty());
    }

    /// A modal's options come after its insertion in the batch: it shows
    /// as they say, whatever the default animation would have done.
    #[test]
    fn modals_show_as_the_options_after_their_insertion_say() {
        for animation in [
            ModalAnimation::None,
            ModalAnimation::Slide,
            ModalAnimation::Fade,
        ] {
            let surface = Surface::new(nsh_engine::Environment::default());
            let config = ModalConfig {
                animation,
                ..ModalConfig::default()
            };
            for item in [
                nsh_core::MountItem::Create {
                    id: 8,
                    kind: ViewKind::Modal,
                },
                nsh_core::MountItem::Insert {
                    parent: ROOT_ID,
                    child: 8,
                    before: None,
                },
                nsh_core::MountItem::ModalConfig { id: 8, config },
            ] {
                surface.mounter.borrow_mut().apply(&surface, &item);
            }
            surface.mounter.borrow_mut().end_batch(&surface);
            let fade = surface.mounter.borrow().views.get(8).unwrap().state().fade;
            // Only a fade starts transparent; a slide moves it in shown.
            let expected = if animation == ModalAnimation::Fade {
                0.0
            } else {
                1.0
            };
            assert_eq!(fade, expected, "{animation:?}");
        }
    }
}
