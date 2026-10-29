//! Navigation stacks, screens, modals.
//!
//! A stack's screens are its child views; only the top one shows (and the
//! one below it while a transition runs): the others are
//! [`ViewState::concealed`](crate::view::ViewState::concealed), so they are
//! neither drawn nor hit. Changes of the app's screens are reconciled at
//! the end of each batch, once every item is applied: a new top screen
//! slides in from the right over the previous one (which moves left a bit
//! and dims, as WinUI's and GNOME's navigation views do); a top screen the
//! app removes slides out as the image it last showed. That image is
//! recorded into a Direct2D command list ([`record`]) when the batch first
//! tears something of the screen down ([`removing`]), before its views are
//! detached.
//!
//! NSH draws no header: a screen's `header` (the app's view,
//! [`ScreenConfig::header_view`]) is a child of the screen whose frame the
//! core sets at its top (as wide as the screen, as tall as it lays out),
//! with the content laid out below it; it is kept above the content. The
//! other header items (the native header's slots on iOS and Android) stay
//! concealed. Under the app's content each screen has an opaque backdrop in
//! the window's color, so a screen sliding over another hides it.
//!
//! Going back (Escape, Alt+Left, the Browser Back key, the mouse's back
//! button; Escape in a focused text field only leaves it) sends
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
//! Transitions run on the surface's frame clock ([`Surface::on_frame`])
//! and only move views (`shift`, `fade`): nothing is laid out again while
//! they run.

use std::{cell::Cell, rc::Rc, time::Duration};

use nsh_core::{
    Bounds, Color, EdgeInsets, EventKind, EventPayload, ModalAnimation, ModalConfig, NodeId,
    PayloadValue, Points, ROOT_ID, ScreenConfig, Size, ViewKind,
    navigation::{
        Back, Reported, Stack, Tick, Transitions, back_target, dim, innermost, insets_payload,
        modal_in_offset, modal_motion, modal_out_offset, pop_offsets, push_offsets, screen_motion,
    },
};
use rustc_hash::FxHashMap;
use windows::Win32::Graphics::Direct2D::{
    Common::D2D1_COMPOSITE_MODE_SOURCE_OVER, D2D1_INTERPOLATION_MODE_LINEAR, ID2D1CommandList,
};
use windows_numerics::Matrix3x2;

use crate::{
    geom::{Mat4, rect},
    input::{KeyEvent, Modifiers},
    render::{DrawCx, rect_f},
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
fn is_shown(view: &NshView) -> bool {
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
    if let Some(field) = crate::text_input::focused(surface)
        && is_ancestor(view, &field)
    {
        crate::text_input::blur(&field);
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
/// held).
fn is_back_key(vk: u16, m: Modifiers) -> bool {
    let others = m.shift || m.ctrl || m.meta;
    match vk {
        VK_ESCAPE | VK_BROWSER_BACK => !others && !m.alt,
        VK_LEFT => m.alt && !others,
        _ => false,
    }
}

/// Draws `view`'s subtree, as it shows now at its origin, into a command
/// list: the image a screen or modal leaves as once the app tore its views
/// down.
fn record(surface: &Surface, view: &NshView) -> Option<Picture> {
    let gfx = crate::gfx::get().ok()?;
    let scale = surface.scale();
    let dark = crate::system::dark(surface);
    let dc = &gfx.dc;
    // SAFETY: COM calls on the live context, outside any other drawing (a
    // batch is applied between frames); `EndDraw` follows `BeginDraw` and
    // the previous target is restored.
    unsafe {
        let list: ID2D1CommandList = dc.CreateCommandList().ok()?;
        let previous = dc.GetTarget().ok();
        dc.SetTarget(&list);
        dc.SetDpi(96.0 * scale, 96.0 * scale);
        dc.BeginDraw();
        dc.SetTransform(&Matrix3x2::identity());
        let drawn = match DrawCx::new(&gfx, scale, dark, surface.now()) {
            Ok(mut cx) => {
                cx.offscreen = true;
                // As it shows when settled: a transition's fade is not
                // part of it.
                let fade = std::mem::replace(&mut view.state_mut().fade, 1.0);
                crate::render::draw_view(&mut cx, view, Mat4::new(), (0.0, 0.0));
                view.state_mut().fade = fade;
                true
            }
            Err(_) => false,
        };
        let ended = dc.EndDraw(None, None);
        dc.SetTarget(previous.as_ref());
        list.Close().ok()?;
        (drawn && ended.is_ok()).then(|| Picture {
            list,
            generation: crate::gfx::generation(),
        })
    }
}

/// A recorded image of a view's subtree, drawn at the item's origin.
struct Picture {
    list: ID2D1CommandList,
    /// The device generation it was recorded in (its resources die with
    /// the device).
    generation: u64,
}

impl Hosted for Picture {
    fn draw(&self, cx: &mut DrawCx<'_>, _size: (f32, f32)) {
        if self.generation != crate::gfx::generation() {
            return;
        }
        // SAFETY: a COM call between BeginDraw and EndDraw, with a closed
        // command list of the same device.
        unsafe {
            cx.dc.DrawImage(
                &self.list,
                None,
                None,
                D2D1_INTERPOLATION_MODE_LINEAR,
                D2D1_COMPOSITE_MODE_SOURCE_OVER,
            );
        }
    }

    fn hit(&self, _x: f32, _y: f32, _size: (f32, f32)) -> bool {
        false
    }
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
        // SAFETY: a COM call between BeginDraw and EndDraw.
        unsafe {
            cx.dc
                .FillRectangle(&rect_f(0.0, 0.0, size.0, size.1), cx.solid(color))
        };
    }

    fn hit(&self, _x: f32, _y: f32, _size: (f32, f32)) -> bool {
        false
    }
}

/// A screen's backdrop: the window's color in the appearance drawn.
struct Backdrop;

impl Hosted for Backdrop {
    fn draw(&self, cx: &mut DrawCx<'_>, size: (f32, f32)) {
        let color = window_color(cx.dark);
        // SAFETY: a COM call between BeginDraw and EndDraw.
        unsafe {
            cx.dc
                .FillRectangle(&rect_f(0.0, 0.0, size.0, size.1), cx.solid(color))
        };
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
    /// Its native projection is suspended by a list retirement.
    parked: bool,
    /// Its opaque background, under the app's content (its first child),
    /// hosting a [`Backdrop`].
    backdrop: NshView,
    backdrop_item: Rc<dyn Hosted>,
    /// The header items the app inserted (only the `header` one shows).
    items: Vec<NshView>,
    /// The size and insets last reported.
    reported: Reported,
}

fn top_screen(screens: &FxHashMap<NodeId, ScreenNav>, shown: &[NodeId]) -> Option<NodeId> {
    shown
        .iter()
        .rev()
        .copied()
        .find(|id| !screens.get(id).is_some_and(|screen| screen.parked))
}

impl ScreenNav {
    fn new(view: &NshView) -> Self {
        let backdrop = layer_view();
        let first = view.with_children(|c| c.first().cloned());
        backdrop.insert_before(view, first.as_ref());
        ScreenNav {
            view: view.clone(),
            config: ScreenConfig::default(),
            parked: false,
            backdrop,
            backdrop_item: Rc::new(Backdrop),
            items: Vec::new(),
            reported: Reported::default(),
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
        let frame = rect(0.0, 0.0, w, h);
        // Hosted once, then again only when the size changes (hosting
        // redraws).
        let hosted = !self.backdrop.state().natives.is_empty();
        if !hosted || self.backdrop.state().frame != frame {
            set_frame(&self.backdrop, frame);
            self.backdrop.set_native(&self.backdrop_item, frame);
        }
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
        let header = self
            .items
            .iter()
            .find(|v| Some(v.id()) == self.config.header_view);
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
    /// The field that had the keyboard focus when it was presented: it
    /// gets it back when the modal closes, as a desktop dialog gives it
    /// back.
    restore: Option<NshView>,
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
    /// A layer view (on top of the stack) with the image of a screen the
    /// app removed.
    Image(NshView),
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
        /// The outgoing screen, including when only its snapshot remains.
        leaving_id: NodeId,
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
        /// The modal owning this snapshot, even when dismissal was reported.
        id: NodeId,
        /// The modal to report `onDismiss` for at the end (`None`: it was
        /// reported when the user closed it).
        dismiss: Option<NodeId>,
        /// A layer view on top of the root with the modal's last image, at
        /// the modal's frame.
        layer: NshView,
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
    /// The images of top screens and modals recorded in this batch, before
    /// their views were torn down.
    images: Vec<(NodeId, Picture)>,
}

impl Nav {
    /// Forgets the app's views (it stopped; the surface drops its frame
    /// callbacks too).
    pub(crate) fn reset(&mut self) {
        *self = Nav::default();
    }

    fn screen(&mut self, view: &NshView) -> &mut ScreenNav {
        self.screens
            .entry(view.id())
            .or_insert_with(|| ScreenNav::new(view))
    }

    fn take_image(&mut self, id: NodeId) -> Option<Picture> {
        let i = self.images.iter().position(|(i, _)| *i == id)?;
        Some(self.images.swap_remove(i).1)
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
                    Leaving::View(v) | Leaving::Image(v) => v,
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
            Motion::ModalOut { layer, fade, .. } => {
                if *fade {
                    set_fade(layer, 1.0 - e);
                } else {
                    let h = surface.root.state().frame.size.height.0;
                    let y = layer.state().frame.origin.y.0;
                    set_shift(layer, (0.0, modal_out_offset(Points(h - y), e).0));
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
                    Leaving::Image(layer) => layer.unparent(),
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
        let top = top_screen(&self.screens, st.screens.shown());
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
        let (old, new) = (
            top_screen(&self.screens, &prev),
            top_screen(&self.screens, &desired),
        );
        let frame = stack.state().frame;
        // The image the top screen showed when the app removed it.
        let image = match old {
            Some(old) if Some(old) != new && find(old).is_none() => self.take_image(old),
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
                    let Some(picture) = image else {
                        if let Some(dim) = dim {
                            dim.remove();
                        }
                        self.settle(surface, stack_id);
                        return;
                    };
                    let layer = layer_view();
                    set_frame(
                        &layer,
                        rect(0.0, 0.0, frame.size.width.0, frame.size.height.0),
                    );
                    let item: Rc<dyn Hosted> = Rc::new(picture);
                    layer.set_native(
                        &item,
                        rect(0.0, 0.0, frame.size.width.0, frame.size.height.0),
                    );
                    layer.insert_before(&stack, None);
                    Leaving::Image(layer)
                }
            };
            let motion = Motion::Pop {
                leaving_id: old,
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
                    leaving_id: top,
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
                && st.screens.takes_back(|top| {
                    self.screens
                        .get(&top)
                        .is_some_and(|screen| screen.config.prevent_back)
                })
                && is_shown(&st.view)
        };
        let candidates: Vec<&StackNav> = self.stacks.values().filter(|s| wants(s)).collect();
        innermost(&candidates, |c, o| is_ancestor(&c.view, &o.view)).map(|c| c.view.id())
    }

    /// Takes modal `id` away natively (it leaves as an image of its last
    /// frame), then reports `onDismiss` unless `reported` already.
    fn close_modal(&mut self, surface: &Rc<Surface>, id: NodeId, reported: bool) {
        self.finish(
            surface,
            |m| matches!(m, Motion::ModalIn { view, .. } if view.id() == id),
        );
        self.order.retain(|&m| m != id);
        let recorded = self.take_image(id);
        let Some(m) = self.modals.get_mut(&id) else {
            return;
        };
        let Some(view) = m.view.take() else { return };
        let restore = m.restore.take();
        let motion = modal_motion(m.config.animation, reduce_motion(surface));
        let frame = view.state().frame;
        // Recorded when the batch began tearing it down, or now (the user
        // closed it: it is whole).
        let image = match motion {
            Some(_) if frame.size.width.0 > 0.0 => {
                recorded.or_else(|| is_shown(&view).then(|| record(surface, &view)).flatten())
            }
            _ => None,
        };
        drop_focus(surface, &view);
        view.unparent();
        set_shift(&view, (0.0, 0.0));
        set_fade(&view, 1.0);
        if let Some(field) = restore
            && field.attached()
            && crate::text_input::focused(surface).is_none()
            && is_ancestor(&self.focus_scope(surface), &field)
        {
            // Not while another modal still covers it.
            crate::text_input::focus(&field);
        }
        match (motion, image) {
            (Some((duration, fade)), Some(picture)) => {
                let layer = layer_view();
                set_frame(&layer, frame);
                let item: Rc<dyn Hosted> = Rc::new(picture);
                layer.set_native(
                    &item,
                    rect(0.0, 0.0, frame.size.width.0, frame.size.height.0),
                );
                layer.insert_before(&surface.root, None);
                let motion = Motion::ModalOut {
                    id,
                    dismiss: (!reported).then_some(id),
                    layer,
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
        match modal_motion(m.config.animation, reduce_motion(surface)) {
            Some((duration, fade)) => {
                if !fade {
                    set_fade(&view, 1.0);
                }
                self.start(surface, duration, Motion::ModalIn { view, fade });
            }
            None => {
                set_fade(&view, 1.0);
                surface.event(id, EventKind::Show, EventPayload::None);
            }
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
        self.go_back_to(
            surface,
            surface.root.state().events.contains(EventKind::BackPress),
        )
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

    fn top_modal(&self) -> Option<NodeId> {
        self.order.iter().rev().copied().find(|id| {
            self.modals
                .get(id)
                .and_then(|modal| modal.view.as_ref())
                .is_some_and(|view| view.parent_view().is_some())
        })
    }

    /// Keeps the presented modals (and those leaving) over the app's
    /// views.
    fn raise_modals(&self, surface: &Surface) {
        let mut tail: Vec<NshView> = Vec::new();
        for m in self.order.iter().filter_map(|id| self.modals.get(id)) {
            if let Some(view) = m.view.as_ref().filter(|view| view.parent_view().is_some()) {
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
        let Some(m) = self.modals.get_mut(&id) else {
            return;
        };
        let Some(view) = m.view.as_ref().filter(|view| view.parent_view().is_some()) else {
            return;
        };
        let f = surface.root.state().frame;
        let frame = rect(0.0, 0.0, f.size.width.0, f.size.height.0);
        set_frame(view, frame);
        let size = frame.size;
        report(surface, id, &mut m.reported, size, safe_area(surface));
    }

    /// Records the image of `view` (a top screen or a presented modal) once
    /// per batch, unless it would leave without a transition anyway.
    fn capture(&mut self, surface: &Surface, view: &NshView, animated: bool) {
        let id = view.id();
        if !animated || !is_shown(view) || self.images.iter().any(|(i, _)| *i == id) {
            return;
        }
        if let Some(picture) = record(surface, view) {
            self.images.push((id, picture));
        }
    }
}

/// `Command::Back`: goes back as without the app's listeners, once the
/// batch being applied is in.
pub(crate) fn default_back(surface: &Rc<Surface>) {
    let key = surface.key();
    crate::window::invoke(move || {
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
/// image is recorded first, to leave as once its views are torn down
/// (later in the batch, in whatever order the app releases them).
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
                    nav.capture(surface, &child, animated);
                }
            }
            ViewKind::Modal => {
                let presented = nav
                    .modals
                    .get(&id)
                    .and_then(|m| m.view.as_ref().map(|v| (v == &child, m.config.animation)));
                if let Some((true, animation)) = presented {
                    let animated = modal_motion(animation, reduce).is_some();
                    nav.capture(surface, &child, animated);
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

/// A screen was pushed (`added`) or popped in `stack`.
pub(crate) fn stack_changed(surface: &Rc<Surface>, stack: &NshView, added: Option<&NshView>) {
    let mut nav = surface.nav.borrow_mut();
    let id = stack.id();
    nav.stacks.entry(id).or_insert_with(|| StackNav {
        view: stack.clone(),
        screens: Stack::default(),
    });
    if let Some(screen) = added.filter(|v| v.kind() == ViewKind::Screen) {
        if std::mem::take(&mut nav.screen(screen).parked) {
            nav.screen(screen).report(surface, stack);
            let children: Vec<_> = stack
                .child_views()
                .iter()
                .filter(|child| child.kind() == ViewKind::Screen)
                .map(NshView::id)
                .collect();
            nav.stacks
                .get_mut(&id)
                .unwrap()
                .screens
                .reconcile(&children);
            nav.settle(surface, id);
            return;
        }
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
    let m = nav.modals.entry(id).or_default();
    if m.view.is_some() {
        if view.parent_view().is_none() {
            view.insert_before(&surface.root, None);
            nav.size_modal(surface, id);
        }
        return;
    }
    // The field being typed in under the modal leaves it (until the modal
    // closes); one of the modal's own keeps it.
    let field = crate::text_input::focused(surface).filter(|f| !is_ancestor(view, f));
    if let Some(field) = &field {
        crate::text_input::blur(field);
    }
    m.restore = field;
    m.view = Some(view.clone());
    m.closed = false;
    m.reported = Reported::default();
    // Escape asks the modal to close: the keyboard is the window's.
    crate::native::take_keyboard(surface);
    view.insert_before(&surface.root, None);
    nav.order.push(id);
    nav.size_modal(surface, id);
    // Animated in at the end of the batch, with the options it brings
    // (until then it does not show).
    if nav.modals[&id].config.animation != ModalAnimation::None {
        set_fade(view, 0.0);
    }
    nav.presenting.push(id);
}

/// Where the keyboard focus may go (Tab): the newest modal, else the whole
/// surface.
pub(crate) fn focus_scope(surface: &Surface) -> NshView {
    surface.nav.borrow().focus_scope(surface)
}

/// A modal was removed: dismiss it.
pub(crate) fn dismiss(surface: &Rc<Surface>, view: &NshView) {
    let mut nav = surface.nav.borrow_mut();
    let id = view.id();
    if view.parent_view().is_none()
        && let Some(m) = nav.modals.get_mut(&id)
        && m.view.is_some()
    {
        m.view = None;
        m.restore = None;
        nav.order.retain(|&modal| modal != id);
        nav.presenting.retain(|&modal| modal != id);
        return;
    }
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

/// Parks a supplied recycling root immediately, with no navigation lifecycle
/// or focus-return action. Its normal Insert can restore the same live view.
pub(crate) fn park_retired_root(surface: &Rc<Surface>, view: &NshView) {
    let inside = |candidate: &NshView| is_ancestor(view, candidate);
    let id = view.id();
    let parent = view.parent_view();
    let mut nav = surface.nav.borrow_mut();
    if let Some(screen) = nav.screens.get_mut(&id) {
        screen.parked = true;
    }
    for motion in nav.transitions.take(|motion| match motion {
        Motion::Push { stack, entering, below, .. } => inside(stack) || inside(entering)
            || below.as_ref().is_some_and(&inside),
        Motion::Pop { leaving_id, stack, leaving, below, .. } => *leaving_id == id || inside(stack)
            || matches!(leaving, Leaving::View(leaving) | Leaving::Image(leaving) if inside(leaving))
            || below.as_ref().is_some_and(&inside),
        Motion::ModalIn { view, .. } => inside(view),
        Motion::ModalOut { id: owner, .. } => *owner == id,
    }) {
        let reset = |view: &NshView| {
            set_shift(view, (0.0, 0.0));
            set_fade(view, 1.0);
        };
        match motion {
            Motion::Push { entering, below, dim, .. } => {
                if let Some(dim) = dim { dim.remove(); }
                reset(&entering);
                if let Some(below) = below { reset(&below); }
            }
            Motion::Pop { leaving, below, dim, popped, .. } => {
                if let Some(dim) = dim { dim.remove(); }
                match leaving {
                    Leaving::View(leaving) => reset(&leaving),
                    Leaving::Image(layer) => layer.unparent(),
                }
                if let Some(below) = below { reset(&below); }
                if let Some(id) = popped {
                    surface.event(id, EventKind::Dismiss, EventPayload::None);
                }
            }
            Motion::ModalIn { view, .. } => reset(&view),
            Motion::ModalOut { layer, dismiss, .. } => {
                layer.unparent();
                if let Some(id) = dismiss {
                    surface.event(id, EventKind::Dismiss, EventPayload::None);
                }
            }
        }
    }
    nav.presenting.retain(|&modal| modal != id);
    nav.images.retain(|(owner, _)| *owner != id);
    if view.kind() == ViewKind::HeaderItem
        && let Some(screen) = parent
            .as_ref()
            .and_then(|parent| nav.screens.get_mut(&parent.id()))
    {
        screen.items.retain(|item| item != view);
    }
    if view.kind() == ViewKind::Screen {
        set_concealed(surface, view, true);
    } else {
        view.unparent();
    }
    set_shift(view, (0.0, 0.0));
    set_fade(view, 1.0);
    if let Some(parent) = parent.filter(|parent| parent.kind() == ViewKind::Stack) {
        nav.settle(surface, parent.id());
    }
}

/// A real deletion releases metadata that kept a suspended projection alive.
pub(crate) fn deleted_parked_root(surface: &Surface, view: &NshView) {
    let mut nav = surface.nav.borrow_mut();
    let id = view.id();
    if view.kind() == ViewKind::Modal && view.parent_view().is_none() {
        nav.modals.remove(&id);
        nav.order.retain(|&modal| modal != id);
        nav.presenting.retain(|&modal| modal != id);
    }
    if nav.screens.get(&id).is_some_and(|screen| screen.parked) {
        nav.screens.remove(&id);
    }
}

/// A header item was inserted into `parent` (a screen).
pub(crate) fn header_item(surface: &Rc<Surface>, parent: &NshView, child: &NshView) {
    let mut nav = surface.nav.borrow_mut();
    if child.parent_view().as_ref() != Some(parent) {
        child.insert_before(parent, None);
    }
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
    // Images of screens and modals that stayed are of no use.
    nav.images.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modal_without_animation_is_visible_when_config_arrives_after_insertion() {
        let surface = Surface::new(Default::default());
        let modal = NshView::new(2, ViewKind::Modal);
        present(&surface, &modal);
        let config = ModalConfig {
            animation: ModalAnimation::None,
            ..Default::default()
        };
        modal_config(&surface, &modal, &config);
        end_batch(&surface);
        assert_eq!(modal.state().fade, 1.0);
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
        root.set_invalidate(Rc::new(|_| {}));
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
            vec![s.backdrop.clone(), content, more, header]
        );
    }
}
