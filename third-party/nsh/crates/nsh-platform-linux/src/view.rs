//! `NshView`: the GTK widget of one node.
//!
//! The core lays everything out, so a view never measures itself: its
//! parent places it at the frame the core gave it (`size_allocate`, with
//! the frame's origin, the scroll offset, a sticky shift and the view's
//! transform in one `gsk::Transform`; the offset at whole points, see
//! [`placement`]). Sizes are kept as `f32` points in
//! [`ViewState::frame`] and drawing uses them; the integer allocation only
//! bounds picking.
//!
//! A view draws itself in `snapshot`: shadows and background
//! ([`crate::decor`]), its content (text, image, canvas), its children
//! (clipped to the rounded bounds when `overflow: hidden`), then its
//! border, as UIKit draws layer borders over the content. Views with text
//! widen their damage by the pixels glyphs paint outside their nodes
//! ([`TEXT_OVERHANG`]).
//!
//! Native GTK widgets a view hosts (a text field, a header) are
//! [`ViewState::natives`]: placed at their own rectangles, after the app's
//! children.

use std::cell::{Ref, RefCell, RefMut};

use gtk4::{self as gtk, glib, graphene, gsk, prelude::*, subclass::prelude::*};
// The scroll position, extent and motion of a `ViewKind::Scroll` view.
pub(crate) use nsh_core::scroll::ScrollState;
use nsh_core::{
    Bounds, EventMask, NodeId, PointerEvents, Points, TransformKind, ViewKind, ViewProps,
    ViewStyle,
    animation::AnimValues,
    geometry::{AbsoluteLength, DefiniteLength, REM_SIZE},
};

/// A native GTK widget a view hosts at `rect` (view coordinates).
#[derive(Debug, Clone)]
pub(crate) struct Native {
    /// The widget (a child of the view).
    pub(crate) widget: gtk::Widget,
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
    /// Scroll state (scroll views).
    pub(crate) scroll: Option<ScrollState>,
    /// Text content (text views).
    pub(crate) text: Option<crate::text::DrawnText>,
    /// The part of its selection area's selection its text draws (UTF-16,
    /// `start < end`; [`crate::selection_area`]).
    pub(crate) area_selection: Option<(u32, u32)>,
    /// Image content (image views).
    pub(crate) image: Option<crate::image::ImageState>,
    /// Canvas content.
    pub(crate) canvas: Option<crate::canvas::CanvasState>,
    /// Text field (input views).
    pub(crate) input: Option<std::rc::Rc<crate::text_input::InputState>>,
    /// Hosted GTK widgets.
    pub(crate) natives: Vec<Native>,
    /// The area descendants cover outside the bounds (`MountItem::Overflow`):
    /// hit testing looks there too.
    pub(crate) overflow: Option<Bounds<Points>>,
    /// Running layout / style transitions and keyframes.
    pub(crate) live: Option<Box<crate::transition::Live>>,
    /// What accessibility last gave GTK.
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
            area_selection: None,
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
        let mut r: [f32; 4] = s
            .corner_radius
            .to_array()
            .map(|r| r.unwrap_or(s.border_radius).0);
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

    /// Widens the damage of its text by [`TEXT_OVERHANG`] with a clear
    /// node: GTK damages the bounds of the nodes that differ between frames
    /// and of the subtrees that moved, and this node is in both whenever
    /// the text is (`phase` flips in the first snapshot after a
    /// [`NshView::changed`]).
    fn draw_overhang(&self, snapshot: &gtk::Snapshot, phase: bool) {
        if self.text.is_none() && self.input.is_none() {
            return;
        }
        // Any change of its bounds damages the old and the new ones.
        let m = TEXT_OVERHANG + if phase { 1.0 / 64.0 } else { 0.0 };
        snapshot.append_color(
            &gtk::gdk::RGBA::TRANSPARENT,
            &graphene::Rect::new(
                -m,
                -m,
                self.frame.size.width.0 + 2.0 * m,
                self.frame.size.height.0 + 2.0 * m,
            ),
        );
    }

    /// True if its children are clipped to its rounded bounds.
    pub(crate) fn clips(&self) -> bool {
        self.style.overflow_hidden
            || matches!(
                self.kind,
                ViewKind::Scroll | ViewKind::Image | ViewKind::Stack | ViewKind::Input
            )
    }

    /// The rounded rectangle of its bounds.
    pub(crate) fn rounded_bounds(&self) -> gsk::RoundedRect {
        rounded(
            graphene::Rect::new(0.0, 0.0, self.frame.size.width.0, self.frame.size.height.0),
            self.radii(),
        )
    }

    /// Its transform (static entries, overridden by animated ones) around
    /// its transform origin, or `None` when it has none.
    pub(crate) fn transform(&self) -> Option<gsk::Transform> {
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
        let mut m = gsk::Transform::new().translate(&graphene::Point::new(ox, oy));
        if oz != 0.0 {
            m = m.translate_3d(&graphene::Point3D::new(0.0, 0.0, oz));
        }
        for (i, op) in t.ops().iter().enumerate() {
            let v = self.anim.transform[i].unwrap_or(op.value);
            m = match op.kind {
                TransformKind::TranslateX => m.translate(&graphene::Point::new(v, 0.0)),
                TransformKind::TranslateY => m.translate(&graphene::Point::new(0.0, v)),
                TransformKind::TranslateXFraction => m.translate(&graphene::Point::new(v * w, 0.0)),
                TransformKind::TranslateYFraction => m.translate(&graphene::Point::new(0.0, v * h)),
                TransformKind::Scale => m.scale(v, v),
                TransformKind::ScaleX => m.scale(v, 1.0),
                TransformKind::ScaleY => m.scale(1.0, v),
                TransformKind::Rotate => m.rotate(v),
                TransformKind::RotateX => m.rotate_3d(v, &graphene::Vec3::x_axis()),
                TransformKind::RotateY => m.rotate_3d(v, &graphene::Vec3::y_axis()),
                TransformKind::SkewX => m.skew(v, 0.0),
                TransformKind::SkewY => m.skew(0.0, v),
                TransformKind::Perspective => {
                    if v > 0.0 {
                        m.perspective(v)
                    } else {
                        m
                    }
                }
            };
        }
        if let Some(extra) = extra {
            m = crate::transition::apply_extra(extra, m, h);
        }
        if oz != 0.0 {
            m = m.translate_3d(&graphene::Point3D::new(0.0, 0.0, -oz));
        }
        Some(m.translate(&graphene::Point::new(-ox, -oy)))
    }
}

/// A rounded rectangle with radii clockwise from the top left.
pub(crate) fn rounded(rect: graphene::Rect, r: [f32; 4]) -> gsk::RoundedRect {
    let s = |v: f32| graphene::Size::new(v.max(0.0), v.max(0.0));
    gsk::RoundedRect::new(rect, s(r[0]), s(r[1]), s(r[2]), s(r[3]))
}

/// Shifts a translation `(dx, dy)` off GTK 4.22's inexact damage path:
/// `gsk_transform_node_diff` takes the shortcut for whole offsets when `dx`
/// is whole and `dy` is not (it tests `floorf (dy) != dy`; fixed upstream
/// to `==`), and that shortcut translates the damage region by the
/// truncated offsets. The damage of a subtree that changed then lands up to
/// a point off, and the pixels it misses keep what moved or shrank there.
/// A `dx` off the whole points by an invisible fraction takes the exact path.
fn exact_damage(dx: f32, dy: f32) -> f32 {
    if dx.floor() == dx && dy.floor() != dy {
        dx + 1.0 / 256.0
    } else {
        dx
    }
}

/// The transform that places a child at `(x, y)` (parent coordinates),
/// then applies its own `transform`.
///
/// The offset is rounded to whole points, as GTK allocates its own widgets
/// (a `GtkViewport` scrolls by whole pixels): frames already are (the core
/// rounds layout), scroll offsets and shifts are not, and edges and text
/// stay sharp while scrolling.
fn placement(x: f32, y: f32, transform: Option<gsk::Transform>) -> gsk::Transform {
    let t = gsk::Transform::new().translate(&graphene::Point::new(x.round(), y.round()));
    let Some(own) = transform else {
        return t;
    };
    let t = t.transform(Some(&own));
    if t.category() != gsk::TransformCategory::_2dTranslate {
        return t;
    }
    let (dx, dy) = t.to_translate();
    let nudge = exact_damage(dx, dy) - dx;
    if nudge == 0.0 {
        t
    } else {
        t.translate(&graphene::Point::new(nudge, 0.0))
    }
}

/// How far text may paint outside its node's bounds (points): GSK bounds a
/// text node by the glyphs' unhinted ink, while the cairo renderer draws
/// them hinted, with the baseline rounded to the pixel grid, a pixel or so
/// beyond. Damage that follows the bounds misses those pixels.
const TEXT_OVERHANG: f32 = 2.0;

/// A resize callback ([`NshView::on_resize`]).
type Resized = Box<dyn Fn(f32, f32)>;

mod imp {
    use super::*;

    pub(crate) struct NshView {
        pub(crate) state: RefCell<ViewState>,
        /// Called with the new size when GTK resizes the view (the root:
        /// the window's content area).
        pub(crate) resized: RefCell<Option<Resized>>,
        /// The phase of the margin text adds to the damage
        /// ([`ViewState::draw_overhang`]), and whether it changed since
        /// the last snapshot ([`NshView::changed`]). A cell: GTK's signals
        /// call `changed` while the state may be borrowed.
        pub(crate) damage: std::cell::Cell<(bool, bool)>,
    }

    impl Default for NshView {
        fn default() -> Self {
            NshView {
                state: RefCell::new(ViewState::new(0, ViewKind::View)),
                resized: RefCell::new(None),
                damage: Default::default(),
            }
        }
    }

    #[glib::object_subclass]
    impl ObjectSubclass for NshView {
        const NAME: &'static str = "NshView";
        type Type = super::NshView;
        type ParentType = gtk::Widget;
        // Range roles (sliders, progress bars) expose their value to
        // assistive technologies through it (`crate::access`).
        type Interfaces = (gtk::AccessibleRange,);
    }

    impl AccessibleImpl for NshView {}

    impl AccessibleRangeImpl for NshView {
        fn set_current_value(&self, _value: f64) -> bool {
            // Values change from the app, not from assistive technologies.
            false
        }
    }

    impl NshView {
        /// Draws the view and its children.
        fn draw(&self, snapshot: &gtk::Snapshot) {
            let obj = self.obj();
            let state = self.state.borrow();
            if state.style.hidden || crate::decor::backface_away(&state) {
                return;
            }
            let opacity = state.opacity();
            if opacity <= 0.0 {
                return;
            }
            if opacity < 1.0 {
                snapshot.push_opacity(opacity as f64);
            }
            let filters = crate::decor::push_filters(snapshot, &state);
            let (phase, changed) = self.damage.get();
            let phase = phase ^ changed;
            self.damage.set((phase, false));
            state.draw_overhang(snapshot, phase);
            let soft = crate::decor::soft_shadows(obj.upcast_ref(), &state);
            crate::decor::draw_background(snapshot, &state, soft);
            let clip = state.clips();
            if clip {
                snapshot.push_rounded_clip(&state.rounded_bounds());
            }
            // The view's own content stays inside it, as a UIKit view's
            // drawing stays in its backing store: a cell the core has not
            // placed yet (no frame) draws nothing.
            if !clip {
                snapshot.push_clip(&graphene::Rect::new(
                    0.0,
                    0.0,
                    state.frame.size.width.0,
                    state.frame.size.height.0,
                ));
            }
            crate::text::draw(snapshot, &state);
            crate::image::draw(snapshot, &state);
            if state.canvas.is_some() {
                // The surface's own scale, fractional ones included.
                let scale = obj
                    .native()
                    .and_then(|n| n.surface())
                    .map_or(obj.scale_factor() as f64, |s| s.scale());
                crate::canvas::draw(snapshot, &obj, &state, scale);
            }
            if !clip {
                snapshot.pop();
            }
            drop(state);
            let mut child = obj.first_child();
            while let Some(widget) = child {
                child = widget.next_sibling();
                // A view inserted (or given a size) by a batch applied
                // since the last layout has no allocation until the next
                // frame's; snapshots taken in between (images of a screen
                // the app removed) skip it, as GTK would after warning.
                if let Some(view) = widget.downcast_ref::<super::NshView>()
                    && widget.width() == 0
                    && widget.height() == 0
                    && view.state().frame.size.width.0 >= 1.0
                    && view.state().frame.size.height.0 >= 1.0
                {
                    continue;
                }
                obj.snapshot_child(&widget, snapshot);
            }
            let state = self.state.borrow();
            crate::scroll::draw_indicator(snapshot, &state);
            if clip {
                snapshot.pop();
            }
            crate::decor::draw_border(snapshot, &state);
            for _ in 0..filters {
                snapshot.pop();
            }
            if opacity < 1.0 {
                snapshot.pop();
            }
        }
    }

    impl ObjectImpl for NshView {
        fn dispose(&self) {
            while let Some(child) = self.obj().first_child() {
                child.unparent();
            }
        }
    }

    impl WidgetImpl for NshView {
        fn measure(&self, _orientation: gtk::Orientation, _for_size: i32) -> (i32, i32, i32, i32) {
            // The core sizes every view; GTK's own sizing never applies.
            (0, 0, -1, -1)
        }

        fn size_allocate(&self, width: i32, height: i32, _baseline: i32) {
            if let Some(resized) = &*self.resized.borrow() {
                resized(width as f32, height as f32);
            }
            let state = self.state.borrow();
            let (sx, sy) = match &state.scroll {
                Some(s) => {
                    let inset = s.behavior.content_inset.map(|v| v.0);
                    (s.x.0 - inset.left, s.y.0 - inset.top)
                }
                None => (0.0, 0.0),
            };
            // Mirrored lists place each child at the mirror image of its
            // frame in the viewport, which also keeps cells unflipped.
            let mirror = state
                .scroll
                .as_ref()
                .is_some_and(|s| s.mirrored)
                .then_some(state.frame.size.width.0);
            let natives: Vec<Native> = state.natives.clone();
            drop(state);
            let mut child = self.obj().first_child();
            while let Some(widget) = child {
                child = widget.next_sibling();
                if let Some(rect) = natives.iter().find(|n| n.widget == widget).map(|n| n.rect) {
                    let t = placement(rect.origin.x.0, rect.origin.y.0, None);
                    widget.allocate(
                        rect.size.width.0.ceil().max(0.0) as i32,
                        rect.size.height.0.ceil().max(0.0) as i32,
                        -1,
                        Some(t),
                    );
                    continue;
                }
                // Popovers (context menus) size and place themselves, on
                // their parent's allocation.
                if let Some(popover) = widget.downcast_ref::<gtk::Popover>() {
                    popover.present();
                    continue;
                }
                let Some(view) = widget.downcast_ref::<super::NshView>() else {
                    continue;
                };
                let s = view.state();
                let f = s.frame;
                let mut x = f.origin.x.0 - sx + s.shift.0;
                if let Some(w) = mirror {
                    x = w - x - f.size.width.0;
                }
                let t = placement(x, f.origin.y.0 - sy + s.shift.1, s.transform());
                drop(s);
                widget.allocate(
                    f.size.width.0.ceil().max(0.0) as i32,
                    f.size.height.0.ceil().max(0.0) as i32,
                    -1,
                    Some(t),
                );
            }
        }

        fn snapshot(&self, snapshot: &gtk::Snapshot) {
            // The root's snapshot is the whole tree's that changed, which
            // the performance monitor reports ([`crate::fps`]).
            let started = (self.resized.borrow().is_some() && crate::fps::measuring())
                .then(nsh_core::time::Instant::now);
            self.draw(snapshot);
            if let Some(started) = started {
                crate::fps::snapshotted(started.elapsed());
            }
        }

        fn contains(&self, x: f64, y: f64) -> bool {
            let s = self.state.borrow();
            if s.style.hidden || matches!(s.props.pointer_events, PointerEvents::BoxNone) {
                return false;
            }
            let h = s.props.hit_slop.map(|v| v.0);
            x >= -(h.left as f64)
                && y >= -(h.top as f64)
                && x < (s.frame.size.width.0 + h.right) as f64
                && y < (s.frame.size.height.0 + h.bottom) as f64
        }
    }
}

glib::wrapper! {
    /// The widget of one node.
    pub(crate) struct NshView(ObjectSubclass<imp::NshView>)
        @extends gtk::Widget,
        @implements gtk::Accessible, gtk::AccessibleRange, gtk::Buildable, gtk::ConstraintTarget;
}

impl NshView {
    /// A new, detached view of node `id`.
    pub(crate) fn new(id: NodeId, kind: ViewKind) -> Self {
        let view: NshView = glib::Object::new();
        *view.imp().state.borrow_mut() = ViewState::new(id, kind);
        // Views never take keyboard focus themselves; hosted fields do.
        view.set_focusable(false);
        view
    }

    /// Its state.
    pub(crate) fn state(&self) -> Ref<'_, ViewState> {
        self.imp().state.borrow()
    }

    /// Its state, to change. Call [`NshView::changed`] or
    /// [`NshView::moved`] afterwards.
    pub(crate) fn state_mut(&self) -> RefMut<'_, ViewState> {
        self.imp().state.borrow_mut()
    }

    /// Node id.
    pub(crate) fn id(&self) -> NodeId {
        self.state().id
    }

    /// Kind.
    pub(crate) fn kind(&self) -> ViewKind {
        self.state().kind
    }

    /// Something it draws changed.
    pub(crate) fn changed(&self) {
        let damage = &self.imp().damage;
        damage.set((damage.get().0, true));
        self.queue_draw();
    }

    /// Its frame, transform or shift changed: the parent places it again.
    pub(crate) fn moved(&self) {
        if let Some(parent) = self.parent() {
            parent.queue_allocate();
        }
        self.queue_draw();
    }

    /// The view's parent view, if it is attached to one.
    pub(crate) fn parent_view(&self) -> Option<NshView> {
        self.parent().and_then(|p| p.downcast::<NshView>().ok())
    }

    /// Its child views, bottom to top.
    pub(crate) fn child_views(&self) -> Vec<NshView> {
        let mut out = Vec::new();
        let mut child = self.first_child();
        while let Some(widget) = child {
            child = widget.next_sibling();
            if let Ok(view) = widget.downcast::<NshView>() {
                out.push(view);
            }
        }
        out
    }

    /// Hosts `widget` at `rect` (or moves it there).
    pub(crate) fn set_native(&self, widget: &impl IsA<gtk::Widget>, rect: Bounds<Points>) {
        let widget = widget.as_ref();
        {
            let mut s = self.state_mut();
            match s.natives.iter_mut().find(|n| &n.widget == widget) {
                Some(n) => n.rect = rect,
                None => s.natives.push(Native {
                    widget: widget.clone(),
                    rect,
                }),
            }
        }
        if widget.parent().as_ref() != Some(self.upcast_ref()) {
            widget.set_parent(self);
        }
        self.queue_allocate();
    }

    /// Stops hosting `widget`.
    pub(crate) fn remove_native(&self, widget: &impl IsA<gtk::Widget>) {
        let widget = widget.as_ref();
        self.state_mut().natives.retain(|n| &n.widget != widget);
        if widget.parent().as_ref() == Some(self.upcast_ref()) {
            widget.unparent();
        }
    }

    /// Calls `f` with the size GTK gives the view on every allocation.
    pub(crate) fn on_resize(&self, f: impl Fn(f32, f32) + 'static) {
        *self.imp().resized.borrow_mut() = Some(Box::new(f));
    }
}

#[cfg(test)]
mod tests {
    use super::exact_damage;

    #[test]
    fn exact_damage_moves_whole_dx_off_the_truncating_path() {
        // The path GTK 4.22 truncates: whole dx, fractional dy.
        let dx = exact_damage(10.0, 3.5);
        assert!(dx != dx.floor() && (dx - 10.0).abs() < 0.01);
        // Exact paths stay as they are.
        assert_eq!(exact_damage(10.0, 3.0), 10.0);
        assert_eq!(exact_damage(10.25, 3.5), 10.25);
        assert_eq!(exact_damage(-4.5, 0.0), -4.5);
    }
}
