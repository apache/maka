//! `NshView`: the retained view of one node.
//!
//! The core lays everything out, so a view never measures itself: it sits
//! at the frame the core gave it ([`ViewState::frame`], points in its
//! parent), moved by its parent's scroll offset, a sticky shift and its own
//! transform ([`ViewState::transform`], around its transform origin).
//!
//! Views form a tree of reference-counted nodes: a parent holds its
//! children in drawing order (bottom to top), a child its parent weakly.
//! A view draws itself in [`crate::render`]: shadows and background
//! ([`crate::decor`]), its content (text, image, canvas), its children
//! (clipped to the rounded bounds when `overflow: hidden`), the items it
//! hosts ([`ViewState::natives`]: text editors, web views, ...), then its
//! border, as UIKit draws layer borders over the content.
//!
//! Changing what a view draws calls [`NshView::changed`], which walks up to
//! the root and asks its surface to draw again: all views of a window are
//! drawn in one pass, so damage is the window.

use std::{
    cell::{Cell, Ref, RefCell, RefMut},
    rc::{Rc, Weak},
};

// The scroll position, extent and motion of a `ViewKind::Scroll` view.
pub(crate) use nsh_core::scroll::ScrollState;
use nsh_core::{
    Bounds, EventMask, NodeId, Points, TransformKind, ViewKind, ViewProps, ViewStyle,
    animation::AnimValues,
    geometry::{AbsoluteLength, DefiniteLength, REM_SIZE},
};

use crate::{geom::Mat4, render::DrawCx};

/// A pointer event a hosted item gets, in its own coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ItemPointer {
    /// What happened.
    pub(crate) kind: crate::input::PointerKind,
    /// Where (points, item coordinates).
    pub(crate) x: f32,
    /// Where.
    pub(crate) y: f32,
    /// Consecutive clicks (1, 2 for a double click, ...).
    pub(crate) clicks: u32,
    /// Shift, Ctrl and Alt.
    pub(crate) modifiers: crate::input::Modifiers,
    /// The button of a press or release: 0 left, 1 right, 2 middle, 3 back
    /// (X1), 4 forward (X2). Items other than [`Hosted::raw`] ones only
    /// get the left one.
    pub(crate) button: u8,
    /// Which pointer: 1 is the mouse, touch and pen contacts have their own
    /// (their `WM_POINTER` id plus 2).
    pub(crate) pointer: u32,
    /// A finger.
    pub(crate) touch: bool,
    /// A pen.
    pub(crate) pen: bool,
}

/// Something a view hosts and draws above its children: a text editor, a
/// header with its title and buttons, a dialog. Items take the pointer
/// before the views below them ([`crate::input`]).
pub(crate) trait Hosted {
    /// Draws the item in `size` (points; the context is in item
    /// coordinates).
    fn draw(&self, cx: &mut DrawCx<'_>, size: (f32, f32));

    /// True when the item takes the pointer at `(x, y)` (item coordinates).
    fn hit(&self, x: f32, y: f32, size: (f32, f32)) -> bool {
        x >= 0.0 && y >= 0.0 && x < size.0 && y < size.1
    }

    /// A pointer event while the item has the pointer (it was pressed on
    /// it, or it is under the pointer). True when handled.
    fn pointer(&self, event: &ItemPointer) -> bool {
        let _ = event;
        false
    }

    /// The cursor over `(x, y)`.
    fn cursor(&self, x: f32, y: f32) -> Option<crate::input::Cursor> {
        let _ = (x, y);
        None
    }

    /// Where the last frame drew it, in window pixels, or `None` when it
    /// was not drawn (hidden, clipped away): items backed by a child
    /// window (a web view) move it there.
    fn placed(&self, rect: Option<windows::Win32::Foundation::RECT>) {
        let _ = rect;
    }

    /// True for an item whose content the system composes itself (a web
    /// view's page): the frame's drawing splits there, and what is drawn
    /// after it goes on a layer above it ([`crate::compose`]).
    fn composed(&self) -> bool {
        false
    }

    /// The visual of a [`Hosted::composed`] item, stacked between the
    /// layers.
    fn visual(&self) -> Option<windows::Win32::Graphics::DirectComposition::IDCompositionVisual2> {
        None
    }

    /// Where the last frame put a [`Hosted::composed`] item, or `None` when
    /// it was not drawn.
    fn compose_at(&self, at: Option<&crate::compose::Placement>) {
        let _ = at;
    }

    /// True when the item takes the pointer as it comes (every button,
    /// every move while one is down, no presses or drags of its views): a
    /// web view's page.
    fn raw(&self) -> bool {
        false
    }

    /// A wheel or touchpad scroll at `(x, y)` (item coordinates) for a
    /// [`Hosted::raw`] item; true when it took it (else the scroll views
    /// around it get it).
    fn wheel(&self, x: f32, y: f32, event: &crate::input::WheelEvent) -> bool {
        let _ = (x, y, event);
        false
    }
}

/// An item a view hosts at `rect` (view coordinates).
#[derive(Clone)]
pub(crate) struct Native {
    /// The item.
    pub(crate) item: Rc<dyn Hosted>,
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
    /// Extra opacity (press feedback, screen and modal transitions).
    pub(crate) fade: f32,
    /// Not drawn and not hit (screens below the top one of a stack).
    pub(crate) concealed: bool,
    /// Scroll state (scroll views).
    pub(crate) scroll: Option<ScrollState>,
    /// Text content (text views).
    pub(crate) text: Option<crate::text::DrawnText>,
    /// Image content (image views).
    pub(crate) image: Option<crate::image::ImageState>,
    /// Canvas content.
    pub(crate) canvas: Option<crate::canvas::CanvasState>,
    /// Text field (input views).
    pub(crate) input: Option<Rc<crate::text_input::InputState>>,
    /// Hosted items, drawn above the children.
    pub(crate) natives: Vec<Native>,
    /// The area descendants cover outside the bounds (`MountItem::Overflow`):
    /// hit testing looks there too.
    pub(crate) overflow: Option<Bounds<Points>>,
    /// Running layout / style transitions and keyframes.
    pub(crate) live: Option<Box<crate::transition::Live>>,
    /// What accessibility last exposed.
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
            concealed: false,
            scroll: matches!(kind, ViewKind::Scroll).then(ScrollState::default),
            text: None,
            image: None,
            canvas: None,
            input: None,
            natives: Vec::new(),
            overflow: None,
            live: None,
            access: Default::default(),
        }
    }

    /// The opacity it is drawn with.
    pub(crate) fn opacity(&self) -> f32 {
        let live = self.live.as_ref().map_or(1.0, |l| l.opacity());
        self.anim.opacity.unwrap_or(self.style.opacity) * self.fade * live
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

    /// The corner radii (top left, top right, bottom right, bottom left),
    /// clamped as CSS clamps them to the box.
    pub(crate) fn radii(&self) -> [f32; 4] {
        let s = &self.style;
        let corners = s.corner_radius.to_array();
        let mut r: [f32; 4] = std::array::from_fn(|i| corners[i].unwrap_or(s.border_radius).0);
        let (w, h) = (self.frame.size.width.0, self.frame.size.height.0);
        let sums = [r[0] + r[1], r[1] + r[2], r[2] + r[3], r[3] + r[0]];
        let lens = [w, h, w, h];
        let f = sums
            .iter()
            .zip(lens)
            .filter(|(s, _)| **s > 0.0)
            .map(|(s, l)| l / s)
            .fold(1.0f32, f32::min);
        if f < 1.0 {
            r.iter_mut().for_each(|v| *v *= f);
        }
        r
    }

    /// True if its children are clipped to its rounded bounds.
    pub(crate) fn clips(&self) -> bool {
        self.style.overflow_hidden
            || matches!(
                self.kind,
                ViewKind::Scroll | ViewKind::Image | ViewKind::Stack | ViewKind::Input
            )
    }

    /// Its transform (static entries, overridden by animated ones) around
    /// its transform origin, or `None` when it has none.
    pub(crate) fn transform(&self) -> Option<Mat4> {
        let t = &self.style.transform;
        let animated = self.anim.transform.iter().any(Option::is_some);
        let extra = self.live.as_ref().and_then(|l| l.extra());
        if extra.is_none() && (t.ops().is_empty() || (!animated && t.is_identity())) {
            return None;
        }
        let (w, h) = (self.frame.size.width.0, self.frame.size.height.0);
        let o = self.style.transform_origin;
        let at = |l: DefiniteLength, side: f32| {
            l.to_points(AbsoluteLength::Points(Points(side)), REM_SIZE)
                .0
        };
        let (ox, oy, oz) = (at(o.x, w), at(o.y, h), o.z.0);
        let mut m = Mat4::new().translate_3d(ox, oy, oz);
        for (i, op) in t.ops().iter().enumerate() {
            let v = self.anim.transform[i].unwrap_or(op.value);
            m = match op.kind {
                TransformKind::TranslateX => m.translate(v, 0.0),
                TransformKind::TranslateY => m.translate(0.0, v),
                TransformKind::TranslateXFraction => m.translate(v * w, 0.0),
                TransformKind::TranslateYFraction => m.translate(0.0, v * h),
                TransformKind::Scale => m.scale(v, v),
                TransformKind::ScaleX => m.scale(v, 1.0),
                TransformKind::ScaleY => m.scale(1.0, v),
                TransformKind::Rotate => m.rotate(v),
                TransformKind::RotateX => m.rotate_x(v),
                TransformKind::RotateY => m.rotate_y(v),
                TransformKind::SkewX => m.skew(v, 0.0),
                TransformKind::SkewY => m.skew(0.0, v),
                TransformKind::Perspective => m.perspective(v),
            };
        }
        if let Some(extra) = extra {
            m = crate::transition::apply_extra(extra, m, h);
        }
        Some(m.translate_3d(-ox, -oy, -oz))
    }

    /// Where a child at `frame` (with its `shift`) goes in this view's
    /// coordinates: its frame's origin, less the scroll offset, mirrored in
    /// a right-to-left list.
    pub(crate) fn child_origin(&self, frame: Bounds<Points>, shift: (f32, f32)) -> (f32, f32) {
        let (sx, sy) = self.scroll.as_ref().map_or((0.0, 0.0), |s| {
            let o = s.origin();
            (o.x.0, o.y.0)
        });
        let mut x = frame.origin.x.0 - sx + shift.0;
        if self.scroll.as_ref().is_some_and(|s| s.mirrored) {
            x = self.frame.size.width.0 - x - frame.size.width.0;
        }
        (x, frame.origin.y.0 - sy + shift.1)
    }
}

/// Called with the view of the tree that changed: the root's surface draws
/// it again ([`crate::surface::Surface::invalidate_view`]).
pub(crate) type Invalidate = Rc<dyn Fn(&NshView)>;

/// A rectangle in the window's DIPs (points).
pub(crate) type WindowRect = windows::Win32::Graphics::Direct2D::Common::D2D_RECT_F;

struct Node {
    state: RefCell<ViewState>,
    parent: RefCell<Weak<Node>>,
    children: RefCell<Vec<NshView>>,
    /// Set on a surface's root only.
    invalidate: RefCell<Option<Invalidate>>,
    /// It is on its surface's list of changed views.
    queued: Cell<bool>,
    /// Where the window's last frame painted it (not its children), clipped
    /// to what was visible: the area to draw again when it changes.
    painted: Cell<Option<WindowRect>>,
}

/// The smallest rectangle holding `a` and `b`.
pub(crate) fn union(a: &WindowRect, b: &WindowRect) -> WindowRect {
    WindowRect {
        left: a.left.min(b.left),
        top: a.top.min(b.top),
        right: a.right.max(b.right),
        bottom: a.bottom.max(b.bottom),
    }
}

/// The view of one node (a cheap, reference-counted handle).
#[derive(Clone)]
pub(crate) struct NshView(Rc<Node>);

impl PartialEq for NshView {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for NshView {}

impl std::fmt::Debug for NshView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.0.state.try_borrow() {
            Ok(s) => write!(f, "NshView({} {:?})", s.id, s.kind),
            Err(_) => f.write_str("NshView(..)"),
        }
    }
}

impl NshView {
    /// A new, detached view of node `id`.
    pub(crate) fn new(id: NodeId, kind: ViewKind) -> Self {
        NshView(Rc::new(Node {
            state: RefCell::new(ViewState::new(id, kind)),
            parent: RefCell::new(Weak::new()),
            children: RefCell::new(Vec::new()),
            invalidate: RefCell::new(None),
            queued: Cell::new(false),
            painted: Cell::new(None),
        }))
    }

    /// Its state.
    pub(crate) fn state(&self) -> Ref<'_, ViewState> {
        self.0.state.borrow()
    }

    /// Its state, to change. Call [`NshView::changed`] or
    /// [`NshView::moved`] afterwards.
    pub(crate) fn state_mut(&self) -> RefMut<'_, ViewState> {
        self.0.state.borrow_mut()
    }

    /// Its state, if it is not borrowed mutably right now.
    pub(crate) fn try_state(&self) -> Option<Ref<'_, ViewState>> {
        self.0.state.try_borrow().ok()
    }

    /// Node id.
    pub(crate) fn id(&self) -> NodeId {
        self.state().id
    }

    /// Kind.
    pub(crate) fn kind(&self) -> ViewKind {
        self.state().kind
    }

    /// Makes this view a surface's root: changes anywhere in its tree call
    /// `invalidate`.
    pub(crate) fn set_invalidate(&self, invalidate: Invalidate) {
        *self.0.invalidate.borrow_mut() = Some(invalidate);
    }

    /// Something it or its subtree draws changed: its surface draws that
    /// again (if it is in one).
    pub(crate) fn changed(&self) {
        if self.0.queued.get() {
            return;
        }
        let mut node = self.0.clone();
        loop {
            let parent = node.parent.borrow().upgrade();
            match parent {
                Some(p) => node = p,
                None => break,
            }
        }
        let invalidate = node.invalidate.borrow().clone();
        if let Some(f) = invalidate {
            f(self);
        }
    }

    /// Whether it is on its surface's list of changed views; set by the
    /// surface, which clears it when it draws.
    pub(crate) fn set_queued(&self, queued: bool) {
        self.0.queued.set(queued);
    }

    /// Records where the window's frame painted it.
    pub(crate) fn set_painted(&self, rect: Option<WindowRect>) {
        self.0.painted.set(rect);
    }

    /// Where the window's last frames painted it and its subtree, as one
    /// rectangle (`None`: nowhere).
    pub(crate) fn painted_subtree(&self) -> Option<WindowRect> {
        let mut area = self.0.painted.get();
        for child in self.0.children.borrow().iter() {
            if let Some(b) = child.painted_subtree() {
                area = Some(match area {
                    Some(a) => union(&a, &b),
                    None => b,
                });
            }
        }
        area
    }

    /// Its frame, transform or shift changed.
    pub(crate) fn moved(&self) {
        self.changed();
    }

    /// True when it is in a tree with a surface (its root draws).
    pub(crate) fn attached(&self) -> bool {
        let mut node = self.0.clone();
        loop {
            let parent = node.parent.borrow().upgrade();
            match parent {
                Some(p) => node = p,
                None => break,
            }
        }
        node.invalidate.borrow().is_some()
    }

    /// The view's parent view, if it is attached to one.
    pub(crate) fn parent_view(&self) -> Option<NshView> {
        self.0.parent.borrow().upgrade().map(NshView)
    }

    /// Its child views, bottom to top.
    pub(crate) fn child_views(&self) -> Vec<NshView> {
        self.0.children.borrow().clone()
    }

    /// Calls `f` with its children, bottom to top, without copying them
    /// (`f` must not change this view's children).
    pub(crate) fn with_children<R>(&self, f: impl FnOnce(&[NshView]) -> R) -> R {
        f(&self.0.children.borrow())
    }

    /// Inserts this view into `parent`, below `before` (on top when `None`
    /// or not a child of `parent`). Detaches it from its old parent first.
    pub(crate) fn insert_before(&self, parent: &NshView, before: Option<&NshView>) {
        self.unparent();
        *self.0.parent.borrow_mut() = Rc::downgrade(&parent.0);
        let mut children = parent.0.children.borrow_mut();
        let at = before
            .and_then(|b| children.iter().position(|c| c == b))
            .unwrap_or(children.len());
        children.insert(at, self.clone());
        drop(children);
        // Where it draws now (its parent draws nothing new of its own).
        self.changed();
    }

    /// Takes this view out of its parent.
    pub(crate) fn unparent(&self) {
        // Where it was drawn is drawn again: queued while it can still
        // reach its surface.
        if self.parent_view().is_some() {
            self.changed();
        }
        let parent = self.0.parent.replace(Weak::new()).upgrade();
        if let Some(parent) = parent {
            parent.children.borrow_mut().retain(|c| c != self);
        }
    }

    /// Hosts `item` at `rect` (or moves it there).
    pub(crate) fn set_native(&self, item: &Rc<dyn Hosted>, rect: Bounds<Points>) {
        {
            let mut s = self.state_mut();
            match s.natives.iter_mut().find(|n| Rc::ptr_eq(&n.item, item)) {
                Some(n) => n.rect = rect,
                None => s.natives.push(Native {
                    item: item.clone(),
                    rect,
                }),
            }
        }
        self.changed();
    }

    /// Stops hosting `item`.
    pub(crate) fn remove_native(&self, item: &Rc<dyn Hosted>) {
        self.state_mut()
            .natives
            .retain(|n| !Rc::ptr_eq(&n.item, item));
        item.placed(None);
        self.changed();
    }

    /// The transform from this view's coordinates to its root's (the
    /// window's content, points), or `None` when it is not attached.
    pub(crate) fn to_root(&self) -> Option<Mat4> {
        let mut m = Mat4::new();
        let mut view = self.clone();
        loop {
            let parent = view.parent_view();
            let s = view.state();
            let Some(parent) = parent else {
                drop(s);
                return self.attached_root(&view).then_some(m);
            };
            let (x, y) = parent.state().child_origin(s.frame, s.shift);
            let mut local = Mat4::new().translate(x, y);
            if let Some(t) = s.transform() {
                local = Mat4::mul(&t, &local);
            }
            drop(s);
            m = Mat4::mul(&m, &local);
            view = parent;
        }
    }

    fn attached_root(&self, root: &NshView) -> bool {
        root.0.invalidate.borrow().is_some()
    }
}
