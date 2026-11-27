//! View decoration: shadows, backgrounds, gradients, borders, outlines and
//! filters, appended to the view's GSK snapshot on every draw.
//!
//! Order, bottom to top (CSS painting order): outer shadows (`boxShadow`
//! layers, last first), the background color, gradients (last first), inset shadows (inside the padding box),
//! the children, the border and the outline. The border is drawn over the
//! children, as UIKit draws layer borders: the core places content inside
//! the border, so only overflowing children reach under it. Filters ([`push_filters`]) wrap all of it.
//!
//! Not drawn: `mixBlendMode` and `backdropFilter` need what lies behind the
//! view, which a widget's snapshot does not have (GTK 4.22's copy / paste
//! nodes could provide it, but the bindings are built for 4.14 and the
//! experimental copy/paste blur path is not part of the renderer); the
//! background color still draws, so frosted bars stay readable.
//! Android's `elevation` is Android only.
//!
//! `borderCurve: "continuous"` draws everything rounded through a path
//! ([`Shape`], the outline of `nsh_core::shape`), since GSK's rounded
//! rectangles only have elliptical corners. Views with circular corners keep
//! GSK's rounded nodes, which are cheaper.
//!
//! `maskImage` ([`push_mask`]) draws the topmost gradient of the list, as iOS
//! and macOS do: its alpha masks the view's box, so what overflows the box
//! is masked out, as in CSS.
//!
//! Gradient stops reuse thread-local buffers. Rounded paths use a bounded
//! cache shared by equal geometry, preserving GSK's raster cache while views
//! move. Animated geometry replaces old entries rather than retaining every frame.

use std::{cell::RefCell, collections::VecDeque};

use gtk4::{self as gtk, gdk, graphene, gsk, prelude::*};
use nsh_core::{
    BorderStyle, Color, Filter, Gradient, GradientKind, GradientSize,
    geometry::{Corners, Percentage, Points, Radians, Size, bounds, deg, point, size},
    shape::{self, Segment},
};

use crate::view::{ViewState, rounded};

/// A core color as a GDK color.
pub(crate) fn rgba(c: Color) -> gdk::RGBA {
    let v = c.0;
    gdk::RGBA::new(
        (v >> 24) as f32 / 255.0,
        ((v >> 16) & 0xff) as f32 / 255.0,
        ((v >> 8) & 0xff) as f32 / 255.0,
        (v & 0xff) as f32 / 255.0,
    )
}

/// True if `backfaceVisibility: "hidden"` hides the view: its own
/// rotations turn it away (its ancestors' are not considered, as on
/// Android).
pub(crate) fn backface_away(state: &ViewState) -> bool {
    // The z axis's own component keeps its sign through translations and a
    // perspective, so it tells which way the face points.
    state.style.backface_hidden
        && state
            .transform()
            .is_some_and(|t| t.to_matrix().value(2, 2) < 0.0)
}

/// A rounded box as a path: `continuous` corners ease into the edges.
#[derive(Clone, Copy, PartialEq)]
struct Shape {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    /// Each corner's radii along its horizontal and vertical edge (top left,
    /// top right, bottom right, bottom left).
    radii: [(f32, f32); 4],
    continuous: bool,
}

impl Shape {
    /// A box whose corners have one radius each.
    fn new(rect: (f32, f32, f32, f32), radii: [f32; 4], continuous: bool) -> Self {
        let (x, y, w, h) = rect;
        Self {
            x,
            y,
            w,
            h,
            radii: radii.map(|r| (r.max(0.0), r.max(0.0))),
            continuous,
        }
    }

    /// The view's bounds, when its corners are continuous: other views use
    /// GSK's cheaper rounded nodes.
    fn of(state: &ViewState) -> Option<Self> {
        let radii = state.radii();
        (state.style.continuous_corners && radii.iter().any(|&r| r > 0.0)).then(|| {
            let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
            Self::new((0.0, 0.0, w, h), radii, true)
        })
    }

    fn add_to(&self, path: &gsk::PathBuilder) {
        let corner = |(w, h): (f32, f32)| size(Points(w), Points(h));
        let [tl, tr, br, bl] = self.radii;
        let rect = bounds(
            point(Points(self.x), Points(self.y)),
            size(Points(self.w), Points(self.h)),
        );
        let corners = Corners {
            top_left: corner(tl),
            top_right: corner(tr),
            bottom_right: corner(br),
            bottom_left: corner(bl),
        };
        shape::rounded_rect(rect, corners, self.continuous, false, &mut |s| match s {
            Segment::Move(p) => path.move_to(p.x.0, p.y.0),
            Segment::Line(p) => path.line_to(p.x.0, p.y.0),
            Segment::Cubic([a, b, c]) => path.cubic_to(a.x.0, a.y.0, b.x.0, b.y.0, c.x.0, c.y.0),
            Segment::Close => path.close(),
        });
    }

    fn path(&self) -> gsk::Path {
        self.cached_path(None)
    }

    fn cached_path(&self, inner: Option<Self>) -> gsk::Path {
        // GSK caches rasterized paths by identity. Rebuilding an identical
        // path invalidates that GPU cache even when only the widget moves.
        // Bound retained geometry so animated dimensions cannot grow it forever.
        thread_local! {
            static PATHS: RefCell<VecDeque<(Shape, Option<Shape>, gsk::Path)>> =
                const { RefCell::new(VecDeque::new()) };
        }
        PATHS.with_borrow_mut(|paths| {
            if let Some(ix) = paths
                .iter()
                .position(|(outer, hole, _)| outer == self && *hole == inner)
            {
                let entry = paths.remove(ix).unwrap();
                let path = entry.2.clone();
                paths.push_front(entry);
                return path;
            }
            let builder = gsk::PathBuilder::new();
            self.add_to(&builder);
            if let Some(inner) = inner {
                inner.add_to(&builder);
            }
            let path = builder.to_path();
            if paths.len() == 128 {
                paths.pop_back();
            }
            paths.push_front((*self, inner, path.clone()));
            path
        })
    }

    /// This box moved by `(dx, dy)` and grown by `d` (shrunk when negative);
    /// only rounded corners change, as a CSS shadow's do.
    fn moved(&self, dx: f32, dy: f32, d: f32) -> Self {
        let r = |v: f32| if v > 0.0 { (v + d).max(0.0) } else { 0.0 };
        Self {
            x: self.x + dx - d,
            y: self.y + dy - d,
            w: (self.w + 2.0 * d).max(0.0),
            h: (self.h + 2.0 * d).max(0.0),
            radii: self.radii.map(|(a, b)| (r(a), r(b))),
            continuous: self.continuous,
        }
    }

    /// The area between this box and `inner`.
    fn ring(&self, inner: &Self) -> gsk::Path {
        self.cached_path(Some(*inner))
    }
}

/// The view's continuous-cornered bounds, when it clips to them and can be
/// clipped piecewise ([`append_clipped`]): drawn only through a
/// translation, so its cut lines can sit on device pixels.
pub(crate) fn piecewise_clip(widget: &gtk::Widget, state: &ViewState) -> Option<PiecewiseClip> {
    let shape = Shape::of(state)?;
    let native = widget.native()?;
    let m = widget.compute_transform(&native)?;
    let translated = m.is_2d()
        && m.value(0, 0) == 1.0
        && m.value(1, 1) == 1.0
        && m.value(0, 1) == 0.0
        && m.value(1, 0) == 0.0;
    if !translated {
        return None;
    }
    let scale = native.surface().map_or(1.0, |s| s.scale() as f32);
    Some(PiecewiseClip {
        shape,
        origin: (m.value(3, 0), m.value(3, 1)),
        scale,
    })
}

/// A continuous clip drawn in pieces ([`append_clipped`]).
pub(crate) struct PiecewiseClip {
    shape: Shape,
    /// The view's offset in its native surface, in points.
    origin: (f32, f32),
    /// The surface's device scale.
    scale: f32,
}

/// Appends `node` clipped to the continuous-cornered box of `clip`.
///
/// Masking the whole subtree with the path ([`push_clip`]) makes GSK render
/// it offscreen at its full size every frame, a large view's whole area.
/// Only the corners differ from a rectangle: the box is cut into a middle
/// band, a top and a bottom band between the corners (plain rectangle clips,
/// no offscreen) and the four corner squares, which alone are masked with
/// the path. The cuts sit on device pixels, so neighboring pieces meet
/// without an antialiased seam.
pub(crate) fn append_clipped(
    snapshot: &gtk::Snapshot,
    clip: &PiecewiseClip,
    node: &gsk::RenderNode,
) {
    let s = &clip.shape;
    let (ox, oy) = clip.origin;
    let k = clip.scale.max(1.0);
    let snap_x = |x: f32| (((ox + x) * k).round() / k - ox).clamp(0.0, s.w);
    let snap_y = |y: f32| (((oy + y) * k).round() / k - oy).clamp(0.0, s.h);
    // How far each corner's curve reaches along its edges: up to
    // `(1 + SMOOTHING) * r`, never past its share of the edge.
    let reach = |r: f32, other: f32, len: f32| {
        if r <= 0.0 {
            return 0.0;
        }
        let share = len * r / (r + other.max(0.0));
        (r * (1.0 + nsh_core::shape::SMOOTHING as f32))
            .min(share)
            .ceil()
    };
    let [tl, tr, br, bl] = s.radii;
    // The bands' edges, enclosing every corner's curve.
    let left = snap_x(reach(tl.0, tr.0, s.w).max(reach(bl.0, br.0, s.w)));
    let right = snap_x(s.w - reach(tr.0, tl.0, s.w).max(reach(br.0, bl.0, s.w)));
    let top = snap_y(reach(tl.1, bl.1, s.h).max(reach(tr.1, br.1, s.h)));
    let bottom = snap_y(s.h - reach(bl.1, tl.1, s.h).max(reach(br.1, tr.1, s.h)));
    let rect = |x0: f32, y0: f32, x1: f32, y1: f32| {
        (x1 > x0 && y1 > y0).then(|| graphene::Rect::new(x0, y0, x1 - x0, y1 - y0))
    };
    let plain = |r: Option<graphene::Rect>| {
        if let Some(r) = r {
            snapshot.push_clip(&r);
            snapshot.append_node(node);
            snapshot.pop();
        }
    };
    let (bottom, right) = (bottom.max(top), right.max(left));
    // The box's own edges off device pixels: a rectangle clip there is cut
    // to whole pixels by some renderers (GL scissors), dropping the
    // partially covered row or column the path keeps. The bands stop at the
    // last whole device pixel inside the box; the thin strip beyond it is
    // masked with the path like the corners.
    let inner = |v: f32, o: f32, up: bool| {
        let d = (o + v) * k;
        let d = if up { d.ceil() } else { d.floor() };
        d / k - o
    };
    let x0 = inner(0.0, ox, true).clamp(0.0, left);
    let x1 = inner(s.w, ox, false).clamp(right, s.w);
    let y0 = inner(0.0, oy, true).clamp(0.0, top);
    let y1 = inner(s.h, oy, false).clamp(bottom, s.h);
    plain(rect(x0, top, x1, bottom));
    plain(rect(left, y0, right, top));
    plain(rect(left, bottom, right, y1));
    let path = s.path();
    // The corners' outer sides reach past the box: there the path alone
    // antialiases the edge, not the path and the clip twice over.
    let o = 1.0;
    for r in [
        rect(-o, -o, left, top),
        rect(right, -o, s.w + o, top),
        rect(right, bottom, s.w + o, s.h + o),
        rect(-o, bottom, left, s.h + o),
        rect(-o, top, x0, bottom).filter(|_| x0 > 0.0),
        rect(x1, top, s.w + o, bottom).filter(|_| x1 < s.w),
        rect(left, -o, right, y0).filter(|_| y0 > 0.0),
        rect(left, y1, right, s.h + o).filter(|_| y1 < s.h),
    ]
    .into_iter()
    .flatten()
    {
        snapshot.push_clip(&r);
        snapshot.push_fill(&path, gsk::FillRule::Winding);
        snapshot.append_node(node);
        snapshot.pop();
        snapshot.pop();
    }
}

/// Clips what follows to the view's rounded bounds, until the matching pop.
pub(crate) fn push_clip(snapshot: &gtk::Snapshot, state: &ViewState) {
    match Shape::of(state) {
        Some(shape) => snapshot.push_fill(&shape.path(), gsk::FillRule::Winding),
        None => snapshot.push_rounded_clip(&state.rounded_bounds()),
    }
}

/// Masks what follows with the view's `maskImage`, until the matching pop;
/// false if it has none (nothing to pop).
pub(crate) fn push_mask(snapshot: &gtk::Snapshot, state: &ViewState) -> bool {
    let Some(mask) = state
        .style
        .effects
        .as_deref()
        .and_then(|e| e.mask_images.first())
    else {
        return false;
    };
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    snapshot.push_mask(gsk::MaskMode::Alpha);
    if w > 0.0 && h > 0.0 {
        draw_gradient(snapshot, mask, w, h);
    }
    snapshot.pop();
    true
}

/// A shadow's immutable render inputs, in widget-local coordinates.
#[derive(Clone, PartialEq)]
struct ContinuousShadow {
    shape: Shape,
    color: gdk::RGBA,
    params: (f32, f32, f32, f32),
    inset: bool,
}

/// How long a resized shadow's size holds still before it is baked.
const SETTLED: std::time::Duration = std::time::Duration::from_millis(150);

impl ContinuousShadow {
    /// The same shadow of a box of another size.
    fn resized(&self, other: &Self) -> bool {
        self.inset == other.inset
            && self.color == other.color
            && self.params == other.params
            && self.shape.radii == other.shape.radii
            && self.shape.continuous == other.shape.continuous
            && (self.shape.w != other.shape.w || self.shape.h != other.shape.h)
    }

    fn append(self, snapshot: &gtk::Snapshot, widget: &gtk::Widget) {
        // A retained BlurNode still runs its GPU passes on every snapshot.
        // Render immutable decoration once, without downloading its pixels.
        // Only widget-local shape/color/blur and device scale affect the image;
        // movement and ancestor opacity are applied by the parent snapshot.
        thread_local! {
            static SHADOWS: RefCell<VecDeque<(ContinuousShadow, f32, gsk::RenderNode, usize)>> =
                const { RefCell::new(VecDeque::new()) };
            /// Shadows recently drawn without a baked image.
            static SEEN: RefCell<VecDeque<(ContinuousShadow, f32)>> =
                const { RefCell::new(VecDeque::new()) };
        }
        let native = widget.native();
        // Preserve vector quality for scale/rotation/perspective transforms,
        // including transforms inherited from an ancestor.
        let translated = native
            .as_ref()
            .and_then(|n| widget.compute_transform(n))
            .is_some_and(|m| {
                m.is_2d()
                    && m.value(0, 0) == 1.0
                    && m.value(1, 1) == 1.0
                    && m.value(0, 1) == 0.0
                    && m.value(1, 0) == 0.0
            });
        if !translated {
            if self.inset {
                draw_continuous_inset_shadow(snapshot, &self.shape, &self.color, self.params);
            } else {
                draw_continuous_outset_shadow(snapshot, &self.shape, &self.color, self.params);
            }
            return;
        }
        let scale = native
            .as_ref()
            .and_then(|n| n.surface())
            .map_or(1.0, |s| s.scale() as f32);
        SHADOWS.with_borrow_mut(|shadows| {
            if let Some(ix) = shadows
                .iter()
                .position(|(key, cached_scale, _, _)| *key == self && *cached_scale == scale)
            {
                let entry = shadows.remove(ix).unwrap();
                snapshot.append_node(&entry.2);
                shadows.push_front(entry);
                return;
            }
            // Baking renders offscreen and waits for it on the main thread
            // (a window-sized shadow takes ~20 ms). A resizing view's shadow
            // has a new shape every frame and would be baked every frame,
            // never reused. While the same shadow was just drawn at another
            // size, an outer shadow is GSK's outset shadow of the
            // round-cornered box, which GSK draws from a cached nine slice
            // at any size (blurring the continuous shape is a full-size
            // offscreen per frame); the corners differ by a few blurred
            // pixels. A redraw once the size holds still bakes the exact one.
            let resizing = SEEN.with_borrow_mut(|seen| {
                if let Some(ix) = seen
                    .iter()
                    .position(|(key, cached_scale)| *key == self && *cached_scale == scale)
                {
                    seen.remove(ix);
                    return false;
                }
                let resizing = seen
                    .iter()
                    .any(|(key, cached_scale)| *cached_scale == scale && key.resized(&self));
                if seen.len() >= 64 {
                    seen.pop_back();
                }
                seen.push_front((self.clone(), scale));
                resizing
            });
            if resizing {
                if self.inset {
                    draw_continuous_inset_shadow(snapshot, &self.shape, &self.color, self.params);
                } else {
                    let s = &self.shape;
                    let corner = |(h, v): (f32, f32)| graphene::Size::new(h, v);
                    let outline = gsk::RoundedRect::new(
                        graphene::Rect::new(s.x, s.y, s.w, s.h),
                        corner(s.radii[0]),
                        corner(s.radii[1]),
                        corner(s.radii[2]),
                        corner(s.radii[3]),
                    );
                    let (dx, dy, spread, blur) = self.params;
                    snapshot.append_outset_shadow(&outline, &self.color, dx, dy, spread, blur);
                }
                let weak = widget.downgrade();
                gtk::glib::timeout_add_local_once(SETTLED, move || {
                    if let Some(widget) = weak.upgrade() {
                        widget.queue_draw();
                    }
                });
                return;
            }
            let drawing = gtk::Snapshot::new();
            if self.inset {
                draw_continuous_inset_shadow(&drawing, &self.shape, &self.color, self.params);
            } else {
                draw_continuous_outset_shadow(&drawing, &self.shape, &self.color, self.params);
            }
            let Some(node) = drawing.to_node() else {
                return;
            };
            let bounds = node.bounds();
            let pixels = ((bounds.width() * scale).ceil() as usize)
                .saturating_mul((bounds.height() * scale).ceil() as usize);
            // Oversized effects keep the vector path; never allocate an
            // unbounded cached texture for an animated size or blur radius.
            let renderer = widget.native().and_then(|n| n.renderer());
            let Some(renderer) = renderer.filter(|_| pixels > 0 && pixels <= 4 * 1024 * 1024)
            else {
                snapshot.append_node(&node);
                return;
            };
            forget_freed_nodes_textures(&renderer);
            let drawing = gtk::Snapshot::new();
            drawing.scale(scale, scale);
            drawing.append_node(&node);
            let viewport = graphene::Rect::new(
                bounds.x() * scale,
                bounds.y() * scale,
                bounds.width() * scale,
                bounds.height() * scale,
            );
            let texture = renderer.render_texture(drawing.to_node().unwrap(), Some(&viewport));
            let cached: gsk::RenderNode = gsk::TextureNode::new(&texture, &bounds).upcast();
            snapshot.append_node(&cached);
            while shadows.len() >= 64
                || shadows.iter().map(|s| s.3).sum::<usize>() + pixels > 16 * 1024 * 1024
            {
                shadows.pop_back();
            }
            shadows.push_front((self, scale, cached, pixels));
        });
    }
}

/// GTK's `gl` renderer caches the offscreens of blur and other nodes under the
/// node's address without holding the node, and drops them only two frames
/// later. A new node allocated at a freed node's address is then drawn with
/// that node's image, so a shadow baked from one could be wrong for as long as
/// it is cached. Two empty frames drop them all before a node that must be right.
fn forget_freed_nodes_textures(renderer: &gsk::Renderer) {
    if renderer.type_().name() != "GskGLRenderer" {
        return;
    }
    let empty = gsk::ColorNode::new(
        &gdk::RGBA::TRANSPARENT,
        &graphene::Rect::new(0.0, 0.0, 1.0, 1.0),
    );
    for _ in 0..2 {
        renderer.render_texture(&empty, None);
    }
}

fn continuous_outset_shadow(
    snapshot: &gtk::Snapshot,
    shape: &Shape,
    color: &gdk::RGBA,
    params: (f32, f32, f32, f32),
    widget: &gtk::Widget,
) {
    ContinuousShadow {
        shape: *shape,
        color: *color,
        params,
        inset: false,
    }
    .append(snapshot, widget);
}

fn continuous_inset_shadow(
    snapshot: &gtk::Snapshot,
    shape: &Shape,
    color: &gdk::RGBA,
    params: (f32, f32, f32, f32),
    widget: &gtk::Widget,
) {
    ContinuousShadow {
        shape: *shape,
        color: *color,
        params,
        inset: true,
    }
    .append(snapshot, widget);
}

/// An outer shadow of a continuous `shape`: the moved and spread shape
/// blurred, masked to outside `shape` as CSS paints outer shadows.
fn draw_continuous_outset_shadow(
    snapshot: &gtk::Snapshot,
    shape: &Shape,
    color: &gdk::RGBA,
    (dx, dy, spread, blur): (f32, f32, f32, f32),
) {
    snapshot.push_mask(gsk::MaskMode::InvertedAlpha);
    snapshot.append_fill(&shape.path(), gsk::FillRule::Winding, &gdk::RGBA::WHITE);
    snapshot.pop();
    if blur > 0.0 {
        snapshot.push_blur(blur as f64);
    }
    let moved = shape.moved(dx, dy, spread);
    snapshot.append_fill(&moved.path(), gsk::FillRule::Winding, color);
    if blur > 0.0 {
        snapshot.pop();
    }
    snapshot.pop();
}

/// An inset shadow of a continuous padding box: outside the moved and
/// shrunk box, blurred and clipped to the padding box.
fn draw_continuous_inset_shadow(
    snapshot: &gtk::Snapshot,
    padding: &Shape,
    color: &gdk::RGBA,
    (dx, dy, spread, blur): (f32, f32, f32, f32),
) {
    snapshot.push_fill(&padding.path(), gsk::FillRule::Winding);
    if blur > 0.0 {
        snapshot.push_blur(blur as f64);
    }
    // Far enough out that the blur brings no edge into the box.
    let m = 2.0 * blur + dx.abs() + dy.abs() + spread.abs() + 1.0;
    let path = gsk::PathBuilder::new();
    path.add_rect(&graphene::Rect::new(
        padding.x - m,
        padding.y - m,
        padding.w + 2.0 * m,
        padding.h + 2.0 * m,
    ));
    padding.moved(dx, dy, -spread).add_to(&path);
    snapshot.append_fill(&path.to_path(), gsk::FillRule::EvenOdd, color);
    if blur > 0.0 {
        snapshot.pop();
    }
    snapshot.pop();
}

/// True if the view's outer shadows must be drawn as blurred shapes
/// ([`draw_background`]'s `soft`): GSK's Cairo renderer (software
/// rendering, `GSK_RENDERER=cairo`) draws an outset shadow node under a
/// rotation or skew axis-aligned and cut off at its bounds, while it
/// renders blur nodes through the transform. Other renderers, and views
/// only moved or scaled, keep GSK's outset shadows (cached, no offscreen).
pub(crate) fn soft_shadows(widget: &gtk::Widget, state: &ViewState) -> bool {
    let shadowed = state
        .style
        .effects
        .as_ref()
        .is_some_and(|e| e.box_shadows.iter().any(|b| !b.inset && b.is_visible()));
    if !shadowed
        || !widget
            .native()
            .and_then(|n| n.renderer())
            .is_some_and(|r| r.is::<gsk::CairoRenderer>())
    {
        return false;
    }
    let Some(root) = widget.root() else {
        return false;
    };
    // Rotations, skews and projections mix the axes or the w row.
    widget.compute_transform(&root).is_none_or(|m| {
        [(0, 1), (1, 0), (0, 3), (1, 3), (2, 3)]
            .iter()
            .any(|&(r, c)| m.value(r, c).abs() > 1e-5)
    })
}

/// An outer shadow of `outline`: GSK's outset shadow node, or with `soft`
/// the moved and spread shape blurred, masked to outside `outline` as CSS
/// paints outer shadows.
#[allow(clippy::too_many_arguments)]
fn outset_shadow(
    snapshot: &gtk::Snapshot,
    outline: &gsk::RoundedRect,
    color: &gdk::RGBA,
    dx: f32,
    dy: f32,
    spread: f32,
    blur: f32,
    soft: bool,
) {
    if !soft {
        snapshot.append_outset_shadow(outline, color, dx, dy, spread, blur);
        return;
    }
    let mut shape = *outline;
    shape.offset(dx, dy);
    if spread != 0.0 {
        shape.shrink(-spread, -spread, -spread, -spread);
    }
    snapshot.push_mask(gsk::MaskMode::InvertedAlpha);
    snapshot.push_rounded_clip(outline);
    snapshot.append_color(&gdk::RGBA::WHITE, outline.bounds());
    snapshot.pop();
    snapshot.pop();
    if blur > 0.0 {
        // GSK takes a blur radius as CSS takes a shadow's blur: twice the
        // Gaussian's deviation, as its outset shadows do.
        snapshot.push_blur(blur as f64);
    }
    snapshot.push_rounded_clip(&shape);
    snapshot.append_color(color, shape.bounds());
    snapshot.pop();
    if blur > 0.0 {
        snapshot.pop();
    }
    snapshot.pop();
}

/// Shadows, the background, gradients and inset shadows, under the
/// content; the border too when the children are not clipped. `soft`
/// draws outer shadows as blurred shapes ([`soft_shadows`]).
pub(crate) fn draw_background(
    snapshot: &gtk::Snapshot,
    state: &ViewState,
    soft: bool,
    widget: &gtk::Widget,
) {
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    if w <= 0.0 || h <= 0.0 {
        return;
    }
    let rect = graphene::Rect::new(0.0, 0.0, w, h);
    let radii = state.radii();
    let outline = rounded(rect, radii);
    let effects = state.style.effects.as_deref();
    let shape = Shape::of(state);

    if let Some(e) = effects {
        // CSS lists the top layer first.
        for b in e.box_shadows.iter().rev() {
            if !b.inset && b.is_visible() {
                if let Some(shape) = &shape {
                    let params = (b.offset_x.0, b.offset_y.0, b.spread.0, b.blur.0.max(0.0));
                    continuous_outset_shadow(snapshot, shape, &rgba(b.color), params, widget);
                    continue;
                }
                outset_shadow(
                    snapshot,
                    &outline,
                    &rgba(b.color),
                    b.offset_x.0,
                    b.offset_y.0,
                    b.spread.0,
                    b.blur.0.max(0.0),
                    soft,
                );
            }
        }
    }

    let bg = state.background();
    let gradients = effects.map_or(&[][..], |e| &e.background_images[..]);
    if !bg.is_transparent() || !gradients.is_empty() {
        let round = radii.iter().any(|&r| r > 0.0);
        if let Some(shape) = &shape {
            snapshot.push_fill(&shape.path(), gsk::FillRule::Winding);
        } else if round {
            snapshot.push_rounded_clip(&outline);
        }
        if !bg.is_transparent() {
            snapshot.append_color(&rgba(bg), &rect);
        }
        for g in gradients.iter().rev() {
            draw_gradient(snapshot, g, w, h);
        }
        if round || shape.is_some() {
            snapshot.pop();
        }
    }

    if let Some(e) = effects
        && e.box_shadows.iter().any(|b| b.inset && b.is_visible())
    {
        let widths = state.style.borders.widths.to_array().map(|w| w.0);
        let padding = padding_box(w, h, radii, widths);
        let continuous = shape.map(|_| padding_shape(w, h, radii, widths));
        for b in e.box_shadows.iter().rev() {
            if b.inset && b.is_visible() {
                if let Some(padding) = &continuous {
                    let params = (b.offset_x.0, b.offset_y.0, b.spread.0, b.blur.0.max(0.0));
                    continuous_inset_shadow(snapshot, padding, &rgba(b.color), params, widget);
                    continue;
                }
                snapshot.append_inset_shadow(
                    &padding,
                    &rgba(b.color),
                    b.offset_x.0,
                    b.offset_y.0,
                    b.spread.0,
                    b.blur.0.max(0.0),
                );
            }
        }
    }
}

/// The border and the outline, over the children (as UIKit draws layer
/// borders, so content the core placed under a border never covers it).
pub(crate) fn draw_border(snapshot: &gtk::Snapshot, state: &ViewState) {
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    if w <= 0.0 || h <= 0.0 {
        return;
    }
    // With the animated color: a border declared transparent shows once
    // its color is animated.
    let border = state.borders().is_visible();
    let o = state.style.outline;
    if !border && !o.is_visible() {
        return;
    }
    let radii = state.radii();
    let continuous = Shape::of(state).is_some();
    if border {
        let outline = rounded(graphene::Rect::new(0.0, 0.0, w, h), radii);
        draw_borders(snapshot, state, &outline);
    }
    if o.is_visible() {
        // Outside the border box by `offset`; rounded corners follow the
        // border radius outwards, square ones stay square.
        let (d, width) = ((o.offset + o.width).0, o.width.0);
        let (ow, oh) = (w + 2.0 * d, h + 2.0 * d);
        if ow <= 0.0 || oh <= 0.0 {
            return;
        }
        let rect = graphene::Rect::new(-d, -d, ow, oh);
        if o.style == BorderStyle::Solid && continuous {
            let outer = Shape::new((-d, -d, ow, oh), radii.map(|r| grown(r, d)), true);
            let inner = Shape::new(
                (-d + width, -d + width, ow - 2.0 * width, oh - 2.0 * width),
                radii.map(|r| grown(r, d - width)),
                true,
            );
            snapshot.append_fill(&outer.ring(&inner), gsk::FillRule::EvenOdd, &rgba(o.color));
        } else if o.style == BorderStyle::Solid {
            let c = rgba(o.color);
            let outer = rounded(rect, radii.map(|r| grown(r, d)));
            snapshot.append_border(&outer, &[width; 4], &[c, c, c, c]);
        } else {
            let half = width / 2.0;
            let line = Shape::new(
                (-d + half, -d + half, ow - width, oh - width),
                radii.map(|r| grown(r, d - half)),
                continuous,
            );
            stroke(snapshot, &line, width, o.style, &rgba(o.color));
        }
    }
}

/// A corner radius `d` points further out (CSS: only rounded corners grow).
fn grown(r: f32, d: f32) -> f32 {
    if r > 0.0 { (r + d).max(0.0) } else { 0.0 }
}

/// The padding box (inside the borders); its corners are the outer ones
/// less the borders' widths on each axis, elliptical where they differ.
fn padding_box(w: f32, h: f32, radii: [f32; 4], widths: [f32; 4]) -> gsk::RoundedRect {
    let [top, right, bottom, left] = widths;
    let rect = graphene::Rect::new(
        left,
        top,
        (w - left - right).max(0.0),
        (h - top - bottom).max(0.0),
    );
    let c = |r: f32, x: f32, y: f32| graphene::Size::new((r - x).max(0.0), (r - y).max(0.0));
    gsk::RoundedRect::new(
        rect,
        c(radii[0], left, top),
        c(radii[1], right, top),
        c(radii[2], right, bottom),
        c(radii[3], left, bottom),
    )
}

/// [`padding_box`] as a continuous [`Shape`].
fn padding_shape(w: f32, h: f32, radii: [f32; 4], widths: [f32; 4]) -> Shape {
    let [top, right, bottom, left] = widths;
    let c = |r: f32, x: f32, y: f32| ((r - x).max(0.0), (r - y).max(0.0));
    Shape {
        x: left,
        y: top,
        w: (w - left - right).max(0.0),
        h: (h - top - bottom).max(0.0),
        radii: [
            c(radii[0], left, top),
            c(radii[1], right, top),
            c(radii[2], right, bottom),
            c(radii[3], left, bottom),
        ],
        continuous: true,
    }
}

/// Draws each side of a border in turn: `draw` with the side's width and
/// color, clipped to its trapezoid (corners split at 45°).
fn each_side(
    snapshot: &gtk::Snapshot,
    b: &nsh_core::Borders,
    w: f32,
    h: f32,
    mut draw: impl FnMut(f32, Color),
) {
    let m = w.min(h) / 2.0;
    for side in 0..4 {
        let (bw, c) = (b.width(side).0, b.colors[side]);
        if bw <= 0.0 || c.is_transparent() {
            continue;
        }
        let quad = match side {
            0 => [(0.0, 0.0), (w, 0.0), (w - m, m), (m, m)],
            1 => [(w, 0.0), (w, h), (w - m, h - m), (w - m, m)],
            2 => [(w, h), (0.0, h), (m, h - m), (w - m, h - m)],
            _ => [(0.0, h), (0.0, 0.0), (m, m), (m, h - m)],
        };
        let p = gsk::PathBuilder::new();
        p.move_to(quad[0].0, quad[0].1);
        for &(x, y) in &quad[1..] {
            p.line_to(x, y);
        }
        p.close();
        snapshot.push_fill(&p.to_path(), gsk::FillRule::Winding);
        draw(bw, c);
        snapshot.pop();
    }
}

/// The view's borders along `outline` (its rounded bounds).
fn draw_borders(snapshot: &gtk::Snapshot, state: &ViewState, outline: &gsk::RoundedRect) {
    let b = &state.borders();
    if !b.is_visible() {
        return;
    }
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    let radii = state.radii();
    let continuous = Shape::of(state).is_some();
    if b.style == BorderStyle::Solid {
        if !continuous {
            snapshot.append_border(
                outline,
                &b.widths.to_array().map(|w| w.0),
                &b.colors.map(rgba),
            );
            return;
        }
        let outer = Shape::new((0.0, 0.0, w, h), radii, true);
        let inner = padding_shape(w, h, radii, b.widths.to_array().map(|w| w.0));
        let ring = outer.ring(&inner);
        if let Some((_, c)) = b.uniform() {
            snapshot.append_fill(&ring, gsk::FillRule::EvenOdd, &rgba(c));
        } else {
            each_side(snapshot, b, w, h, |_, c| {
                snapshot.append_fill(&ring, gsk::FillRule::EvenOdd, &rgba(c));
            });
        }
        return;
    }
    let line = |bw: f32| {
        let half = bw / 2.0;
        Shape::new(
            (half, half, (w - bw).max(0.0), (h - bw).max(0.0)),
            radii.map(|r| (r - half).max(0.0)),
            continuous,
        )
    };
    if let Some((bw, c)) = b.uniform() {
        let bw = bw.0;
        stroke(snapshot, &line(bw), bw, b.style, &rgba(c));
        return;
    }
    // Sides that differ: the whole outline stroked with each side's width
    // and color, clipped to that side's trapezoid.
    each_side(snapshot, b, w, h, |bw, c| {
        stroke(snapshot, &line(bw), bw, b.style, &rgba(c));
    });
}

/// Strokes `line`, `width` wide, dashed or dotted as `style` says.
fn stroke(
    snapshot: &gtk::Snapshot,
    line: &Shape,
    width: f32,
    style: BorderStyle,
    color: &gdk::RGBA,
) {
    let s = gsk::Stroke::new(width);
    match style {
        BorderStyle::Solid => {}
        BorderStyle::Dashed => s.set_dash(&[width * 3.0, width * 3.0]),
        BorderStyle::Dotted => {
            // Zero-length dashes with round caps draw dots.
            s.set_dash(&[0.0, width * 2.0]);
            s.set_line_cap(gsk::LineCap::Round);
        }
    }
    snapshot.append_stroke(&line.path(), &s, color);
}

/// Pushes the view's filters around everything it draws; returns how many
/// pushes to pop.
pub(crate) fn push_filters(snapshot: &gtk::Snapshot, state: &ViewState) -> usize {
    let mut pushes = 0;
    let Some(effects) = &state.style.effects else {
        return pushes;
    };
    // CSS applies the first filter first: it is the innermost push, so
    // the list is pushed from its end. Neighboring color filters make one
    // matrix.
    let f = &effects.filters[..];
    let mut end = f.len();
    while end > 0 {
        if f[end - 1].color_matrix().is_some() {
            let mut start = end - 1;
            while start > 0 && f[start - 1].color_matrix().is_some() {
                start -= 1;
            }
            if let Some(m) = nsh_core::compose_color_matrices(&f[start..end])
                && !is_identity(&m)
            {
                let (matrix, offset) = gsk_color_matrix(&m);
                snapshot.push_color_matrix(
                    &graphene::Matrix::from_float(matrix),
                    &graphene::Vec4::from_float(offset),
                );
                pushes += 1;
            }
            end = start;
            continue;
        }
        match f[end - 1] {
            // CSS's blur length is the Gaussian's deviation, GSK's radius
            // twice that.
            Filter::Blur(r) if r.0 > 0.0 => {
                snapshot.push_blur(r.0 as f64 * 2.0);
                pushes += 1;
            }
            Filter::DropShadow {
                offset_x,
                offset_y,
                blur,
                color,
            } if !color.is_transparent() => {
                snapshot.push_shadow(&[gsk::Shadow::new(
                    rgba(color),
                    offset_x.0,
                    offset_y.0,
                    blur.0.max(0.0),
                )]);
                pushes += 1;
            }
            _ => {}
        }
        end -= 1;
    }
    pushes
}

/// True if the 4×5 color matrix changes nothing.
fn is_identity(m: &[f32; 20]) -> bool {
    m.iter().enumerate().all(|(i, v)| {
        let id = if i % 5 == i / 5 { 1.0 } else { 0.0 };
        (v - id).abs() < 1e-6
    })
}

/// A row-major 4×5 color matrix (an output channel per row, offsets last)
/// as GSK's matrix and offset: graphene keeps one input channel's
/// contributions per row, the transpose.
fn gsk_color_matrix(m: &[f32; 20]) -> ([f32; 16], [f32; 4]) {
    let mut out = [0.0; 16];
    for (i, v) in out.iter_mut().enumerate() {
        let (input, output) = (i / 4, i % 4);
        *v = m[output * 5 + input];
    }
    (out, [m[4], m[9], m[14], m[19]])
}

/// Reused stop buffers: resolved stops, the tiles of a repeating conic
/// gradient, the stops fitted to `0..=1`, and GSK's.
struct Stops {
    typed: Vec<(Color, Percentage)>,
    resolved: Vec<(Color, f32)>,
    tiled: Vec<(Color, f32)>,
    fitted: Vec<(Color, f32)>,
    gsk: Vec<gsk::ColorStop>,
}

thread_local! {
    static STOPS: RefCell<Stops> = const {
        RefCell::new(Stops {
            typed: Vec::new(),
            resolved: Vec::new(),
            tiled: Vec::new(),
            fitted: Vec::new(),
            gsk: Vec::new(),
        })
    };
}

/// Draws one gradient over the `w` × `h` box.
fn draw_gradient(snapshot: &gtk::Snapshot, g: &Gradient, w: f32, h: f32) {
    if g.stops.len() < 2 {
        return;
    }
    STOPS.with(|stops| {
        let Ok(mut stops) = stops.try_borrow_mut() else {
            return;
        };
        let Stops {
            typed,
            resolved,
            tiled,
            fitted,
            gsk: out,
        } = &mut *stops;
        let size = Size::new(Points(w), Points(h));
        g.resolve_stops(size, typed);
        resolved.clear();
        resolved.extend(typed.iter().map(|&(c, p)| (c, p.0)));
        dehue(resolved);
        let first = resolved[0].1;
        let last = resolved[resolved.len() - 1].1;
        let repeating = g.repeating && last - first > 1e-4;
        let bounds = graphene::Rect::new(0.0, 0.0, w, h);
        match g.kind {
            GradientKind::Radial {
                circle,
                size: shape,
                x,
                y,
            } => {
                let (cx, cy) = (x.0 * w, y.0 * h);
                let (rx, ry) = radial_radii(circle, shape, cx, cy, w, h);
                // GSK's ray starts at the center or beyond.
                let (lo, hi) = if repeating {
                    (first.max(0.0), last)
                } else {
                    (0.0, last.max(1.0))
                };
                if hi <= lo {
                    return;
                }
                fit_stops(resolved, lo, hi, fitted);
                gsk_stops(fitted, out);
                // The ending shape is scaled to `hi`, so the stops span
                // the radii. A repeating one is made as a node: GTK 4.22's
                // `gtk_snapshot_append_repeating_radial_gradient` draws it
                // without repeating.
                let center = graphene::Point::new(cx, cy);
                let (rx, ry) = ((rx * hi).max(0.01), (ry * hi).max(0.01));
                let start = lo / hi;
                if repeating {
                    snapshot.append_node(gsk::RepeatingRadialGradientNode::new(
                        &bounds, &center, rx, ry, start, 1.0, out,
                    ));
                } else {
                    snapshot.append_radial_gradient(&bounds, &center, rx, ry, start, 1.0, out);
                }
            }
            GradientKind::Conic { from, x, y } => {
                // GSK has no repeating conic gradient: the tiles become
                // stops.
                if repeating {
                    tile_stops(resolved, tiled);
                    fit_stops(tiled, 0.0, 1.0, fitted);
                } else {
                    fit_stops(resolved, 0.0, 1.0, fitted);
                }
                gsk_stops(fitted, out);
                let center = graphene::Point::new(x.0 * w, y.0 * h);
                // GSK takes the start angle in degrees.
                snapshot.append_conic_gradient(&bounds, &center, from.to_degrees(), out);
            }
            kind => {
                let angle = kind.linear_angle(size).unwrap_or(deg(180.0));
                let (a, b) = linear_line(angle, w, h);
                // GSK's stops lie in `0..=1`: the line is stretched to
                // cover stops outside it (and, repeating, cut to one
                // period).
                let (lo, hi) = if repeating {
                    (first, last)
                } else {
                    (first.min(0.0), last.max(1.0))
                };
                fit_stops(resolved, lo, hi, fitted);
                gsk_stops(fitted, out);
                let at =
                    |t: f32| graphene::Point::new(a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
                let (start, end) = (at(lo), at(hi));
                if repeating {
                    snapshot.append_repeating_linear_gradient(&bounds, &start, &end, out);
                } else {
                    snapshot.append_linear_gradient(&bounds, &start, &end, out);
                }
            }
        }
    });
}

/// Fills `out` with GSK's stops.
fn gsk_stops(stops: &[(Color, f32)], out: &mut Vec<gsk::ColorStop>) {
    out.clear();
    out.extend(stops.iter().map(|&(c, p)| gsk::ColorStop::new(p, rgba(c))));
}

/// Gives transparent stops their neighbor's hue, so fades to transparent
/// do not pass through gray (CSS mixes premultiplied colors).
fn dehue(stops: &mut [(Color, f32)]) {
    for i in 0..stops.len() {
        if !stops[i].0.is_transparent() {
            continue;
        }
        let neighbor = stops[i + 1..]
            .iter()
            .chain(stops[..i].iter().rev())
            .map(|s| s.0)
            .find(|n| !n.is_transparent());
        if let Some(n) = neighbor {
            stops[i].0 = Color(n.0 & 0xffff_ff00);
        }
    }
}

/// The color between `a` and `b` at `t`.
fn mix(a: Color, b: Color, t: f32) -> Color {
    let ch = |shift: u32| {
        let (x, y) = (
            ((a.0 >> shift) & 0xff) as f32,
            ((b.0 >> shift) & 0xff) as f32,
        );
        ((x + (y - x) * t).round().clamp(0.0, 255.0) as u32) << shift
    };
    Color(ch(24) | ch(16) | ch(8) | ch(0))
}

/// Maps the stops' range `lo..hi` onto `0..=1`, cutting stops outside it
/// (with the colors interpolated at the cuts); at least two stops come
/// out.
fn fit_stops(stops: &[(Color, f32)], lo: f32, hi: f32, out: &mut Vec<(Color, f32)>) {
    out.clear();
    let span = (hi - lo).max(f32::EPSILON);
    let mut prev: Option<(Color, f32)> = None;
    for &(c, p) in stops {
        let t = (p - lo) / span;
        if t > 1.0 {
            if let Some((pc, pt)) = prev
                && pt < 1.0
            {
                if pt < 0.0 {
                    out.push((mix(pc, c, -pt / (t - pt)), 0.0));
                }
                out.push((mix(pc, c, (1.0 - pt) / (t - pt)), 1.0));
            }
            break;
        }
        if t >= 0.0 {
            if let Some((pc, pt)) = prev
                && pt < 0.0
                && t > 0.0
            {
                out.push((mix(pc, c, -pt / (t - pt)), 0.0));
            }
            out.push((c, t));
        }
        prev = Some((c, t));
    }
    match out.len() {
        0 => {
            // Every stop on one side: the nearest color fills the range.
            let c = match stops.first() {
                Some(&(c, p)) if p > hi => c,
                _ => stops.last().map_or(Color::TRANSPARENT, |s| s.0),
            };
            out.extend([(c, 0.0), (c, 1.0)]);
        }
        1 => {
            let c = out[0].0;
            out.clear();
            out.extend([(c, 0.0), (c, 1.0)]);
        }
        _ => {}
    }
    for s in out.iter_mut() {
        s.1 = s.1.clamp(0.0, 1.0);
    }
}

/// Most stops a repeating conic gradient is unrolled to.
const MAX_TILED: usize = 512;

/// Repeats the stops' period over `0..=1`, from a period before it (for
/// [`fit_stops`] to cut).
fn tile_stops(stops: &[(Color, f32)], out: &mut Vec<(Color, f32)>) {
    out.clear();
    let (first, last) = (stops[0].1, stops[stops.len() - 1].1);
    let period = last - first;
    let mut k = (-first / period).floor() - 1.0;
    while out.len() + stops.len() <= MAX_TILED {
        let shift = k * period;
        if first + shift > 1.0 {
            break;
        }
        out.extend(stops.iter().map(|&(c, p)| (c, p + shift)));
        k += 1.0;
    }
}

/// The ends of a CSS linear gradient line at `angle` degrees (0 up,
/// clockwise) through the center of a `w` × `h` box: long enough that the
/// corners get the end colors.
fn linear_line(angle: Radians, w: f32, h: f32) -> ((f32, f32), (f32, f32)) {
    let (s, c) = angle.sin_cos();
    let len = (w * s).abs() + (h * c).abs();
    let (dx, dy) = (s * len / 2.0, -c * len / 2.0);
    let (cx, cy) = (w / 2.0, h / 2.0);
    ((cx - dx, cy - dy), (cx + dx, cy + dy))
}

/// The horizontal and vertical radii of a radial gradient's ending shape
/// centered at `(cx, cy)` in a `w` × `h` box.
fn radial_radii(circle: bool, size: GradientSize, cx: f32, cy: f32, w: f32, h: f32) -> (f32, f32) {
    let near = (cx.min(w - cx).abs(), cy.min(h - cy).abs());
    let far = (cx.max(w - cx).abs(), cy.max(h - cy).abs());
    if circle {
        let r = match size {
            GradientSize::ClosestSide => near.0.min(near.1),
            GradientSize::FarthestSide => far.0.max(far.1),
            GradientSize::ClosestCorner => near.0.hypot(near.1),
            GradientSize::FarthestCorner => far.0.hypot(far.1),
        };
        return (r, r);
    }
    // An ellipse to a corner keeps the side ellipse's aspect ratio.
    let s = std::f32::consts::SQRT_2;
    match size {
        GradientSize::ClosestSide => near,
        GradientSize::FarthestSide => far,
        GradientSize::ClosestCorner => (near.0 * s, near.1 * s),
        GradientSize::FarthestCorner => (far.0 * s, far.1 * s),
    }
}

#[cfg(test)]
#[path = "decor/bench.rs"]
mod bench;

#[cfg(test)]
mod tests {
    use super::*;

    const RED: Color = Color(0xff00_00ff);
    const BLUE: Color = Color(0x0000_ffff);

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-3
    }

    #[test]
    fn cached_shadows_match_vector_drawing_and_update_with_their_inputs() {
        crate::gtk_test::run(|| {
            use gtk::glib::translate::ToGlibPtr;

            use crate::view::NshView;

            let view = NshView::new(1, nsh_core::ViewKind::View);
            view.state_mut().frame = crate::gtk_test::frame(0.0, 0.0, 200.0, 100.0);
            let window = gtk::Window::new();
            window.set_child(Some(&view));
            window.set_default_size(200, 100);
            window.present();
            assert!(crate::gtk_test::wait_until(|| view.width() > 0));
            let renderer = window.renderer().unwrap();
            let pointer =
                |n: &gsk::RenderNode| -> *mut gsk::ffi::GskRenderNode { n.to_glib_none().0 };
            let pixels = |node: &gsk::RenderNode| {
                forget_freed_nodes_textures(&renderer);
                let drawing = gtk::Snapshot::new();
                drawing.scale(window.scale_factor() as f32, window.scale_factor() as f32);
                drawing.append_node(node);
                let bounds = graphene::Rect::new(
                    -30.0 * window.scale_factor() as f32,
                    -30.0 * window.scale_factor() as f32,
                    260.0 * window.scale_factor() as f32,
                    160.0 * window.scale_factor() as f32,
                );
                let texture = renderer.render_texture(drawing.to_node().unwrap(), Some(&bounds));
                let mut downloader = gdk::TextureDownloader::new(&texture);
                downloader.set_format(gdk::MemoryFormat::R8g8b8a8Premultiplied);
                downloader.download_bytes().0
            };
            for inset in [false, true] {
                let mut previous = None;
                for (radius, blur, color) in
                    [(20.0, 8.0, RED), (25.0, 8.0, RED), (25.0, 12.0, BLUE)]
                {
                    let key = ContinuousShadow {
                        shape: Shape::new((0.0, 0.0, 200.0, 100.0), [radius; 4], true),
                        color: rgba(color),
                        params: (1.0, 2.0, 0.0, blur),
                        inset,
                    };
                    let drawing = gtk::Snapshot::new();
                    key.clone().append(&drawing, view.upcast_ref());
                    let cached = drawing.to_node().unwrap();
                    assert_eq!(cached.node_type(), gsk::RenderNodeType::TextureNode);
                    let repeated = gtk::Snapshot::new();
                    key.clone().append(&repeated, view.upcast_ref());
                    assert_eq!(pointer(&cached), pointer(&repeated.to_node().unwrap()));
                    if let Some(previous) = previous {
                        assert_ne!(pointer(&cached), pointer(&previous));
                    }
                    let reference = gtk::Snapshot::new();
                    if inset {
                        draw_continuous_inset_shadow(
                            &reference, &key.shape, &key.color, key.params,
                        );
                    } else {
                        draw_continuous_outset_shadow(
                            &reference, &key.shape, &key.color, key.params,
                        );
                    }
                    let expected = pixels(&reference.to_node().unwrap());
                    let actual = pixels(&cached);
                    assert_eq!(actual.len(), expected.len());
                    let error = actual
                        .iter()
                        .zip(expected.iter())
                        .map(|(a, b)| a.abs_diff(*b))
                        .max()
                        .unwrap();
                    assert!(
                        error <= 2,
                        "cached shadow differs by {error} channel levels"
                    );
                    previous = Some(cached);
                }
            }
            // A resizing view's shadow has a new shape every frame: after the
            // first size it is GSK's outset shadow, never an offscreen render
            // per frame; drawn again at a size that held still, it is baked.
            let resized = |width: f32| ContinuousShadow {
                shape: Shape::new((0.0, 0.0, width, 100.0), [20.0; 4], true),
                color: rgba(RED),
                params: (-3.0, 0.0, 0.0, 18.0),
                inset: false,
            };
            let node = |key: ContinuousShadow| {
                let drawing = gtk::Snapshot::new();
                key.append(&drawing, view.upcast_ref());
                drawing.to_node().unwrap()
            };
            assert_eq!(
                node(resized(120.0)).node_type(),
                gsk::RenderNodeType::TextureNode
            );
            for step in 1..8 {
                let width = 120.0 + step as f32 * 7.5;
                assert_eq!(
                    node(resized(width)).node_type(),
                    gsk::RenderNodeType::OutsetShadowNode
                );
            }
            assert_eq!(
                node(resized(172.5)).node_type(),
                gsk::RenderNodeType::TextureNode
            );
            // An ancestor/widget scale must bypass an otherwise matching
            // image, so zooming does not magnify a low-resolution shadow.
            view.allocate(200, 100, -1, Some(gsk::Transform::new().scale(1.5, 1.5)));
            let drawing = gtk::Snapshot::new();
            ContinuousShadow {
                shape: Shape::new((0.0, 0.0, 200.0, 100.0), [20.0; 4], true),
                color: rgba(RED),
                params: (1.0, 2.0, 0.0, 8.0),
                inset: false,
            }
            .append(&drawing, view.upcast_ref());
            assert_ne!(
                drawing.to_node().unwrap().node_type(),
                gsk::RenderNodeType::TextureNode
            );
            window.destroy();
        });
    }

    #[test]
    fn piecewise_continuous_clip_matches_the_path_mask() {
        crate::gtk_test::run(|| {
            let window = gtk::Window::new();
            window.set_default_size(200, 100);
            window.present();
            assert!(crate::gtk_test::wait_until(|| window.surface().is_some()));
            let surface = window.surface().unwrap();
            // The renderers whose path mask antialiases a fractional edge, not
            // the window's: GTK picks the older GL renderer for software GL
            // (llvmpipe), which draws a fill node as a cairo texture placed
            // with hard edges, so on a half device pixel the reference fills
            // the row the box covers half while a plain clip leaves it out.
            // Cairo opens on every display; NGL, GTK's renderer on GPUs,
            // wherever OpenGL does.
            let cairo = gsk::CairoRenderer::new().upcast::<gsk::Renderer>();
            cairo.realize(Some(&surface)).expect("the cairo renderer");
            let ngl = gsk::NglRenderer::new().upcast::<gsk::Renderer>();
            let renderers = match ngl.realize(Some(&surface)) {
                Ok(()) => vec![cairo, ngl],
                Err(_) => vec![cairo],
            };
            // A translucent gradient, so a doubly drawn or missed seam shows.
            let content = || {
                let s = gtk::Snapshot::new();
                s.append_linear_gradient(
                    &graphene::Rect::new(-10.0, -10.0, 340.0, 220.0),
                    &graphene::Point::new(0.0, 0.0),
                    &graphene::Point::new(320.0, 200.0),
                    &[
                        gsk::ColorStop::new(0.0, gdk::RGBA::new(1.0, 0.0, 0.0, 0.6)),
                        gsk::ColorStop::new(1.0, gdk::RGBA::new(0.0, 0.0, 1.0, 0.6)),
                    ],
                );
                s.to_node().unwrap()
            };
            for renderer in &renderers {
                for (scale, origin, radii) in [
                    (1.0, (0.0, 0.0), [20.0; 4]),
                    (1.6, (13.3, 7.7), [20.0; 4]),
                    (2.0, (0.5, 0.25), [24.0, 0.0, 12.0, 60.0]),
                    (1.6, (0.0, 0.0), [100.0; 4]),
                ] {
                    let shape = Shape::new((0.0, 0.0, 300.0, 180.0), radii, true);
                    let render = |draw: &dyn Fn(&gtk::Snapshot)| {
                        let drawing = gtk::Snapshot::new();
                        drawing.scale(scale, scale);
                        drawing.translate(&graphene::Point::new(origin.0, origin.1));
                        draw(&drawing);
                        let bounds = graphene::Rect::new(
                            0.0,
                            0.0,
                            ((origin.0 + 300.0) * scale).ceil(),
                            ((origin.1 + 180.0) * scale).ceil(),
                        );
                        let texture =
                            renderer.render_texture(drawing.to_node().unwrap(), Some(&bounds));
                        let mut downloader = gdk::TextureDownloader::new(&texture);
                        downloader.set_format(gdk::MemoryFormat::R8g8b8a8Premultiplied);
                        downloader.download_bytes()
                    };
                    let node = content();
                    let (expected, stride) = render(&|s| {
                        s.push_fill(&shape.path(), gsk::FillRule::Winding);
                        s.append_node(&node);
                        s.pop();
                    });
                    let clip = PiecewiseClip {
                        shape,
                        origin,
                        scale,
                    };
                    let (actual, _) = render(&|s| append_clipped(s, &clip, &node));
                    let (at, error) = actual
                        .iter()
                        .zip(expected.iter())
                        .map(|(a, b)| a.abs_diff(*b))
                        .enumerate()
                        .max_by_key(|&(_, error)| error)
                        .unwrap();
                    let i = at / 4 * 4;
                    // Seams or doubled corners differ by 30 levels and more;
                    // the path mask itself covers the box's outer edge pixels
                    // a few levels short of exact (76 for 76.5 at half
                    // coverage).
                    assert!(
                        error <= 10,
                        "{}: scale {scale}, radii {radii:?}: differs by {error} channel \
                         levels at ({}, {}): {:?} for {:?}",
                        renderer.type_().name(),
                        at % stride / 4,
                        at / stride,
                        &actual[i..i + 4],
                        &expected[i..i + 4],
                    );
                }
                renderer.unrealize();
            }
            window.destroy();
        });
    }

    #[test]
    fn equal_shapes_reuse_paths_and_changed_geometry_does_not() {
        use gtk::glib::translate::ToGlibPtr;

        let shape = Shape::new((0.0, 0.0, 200.0, 100.0), [20.0; 4], true);
        let first = shape.path();
        let same = shape.path();
        let pointer = |p: &gsk::Path| -> *mut gsk::ffi::GskPath { p.to_glib_none().0 };
        assert_eq!(pointer(&first), pointer(&same));
        let changed = shape.moved(0.0, 0.0, 5.0).path();
        assert_ne!(pointer(&first), pointer(&changed));
        assert!(changed.in_fill(&graphene::Point::new(100.0, -4.0), gsk::FillRule::Winding));
        assert!(!first.in_fill(&graphene::Point::new(100.0, -4.0), gsk::FillRule::Winding));
        let inner = shape.moved(0.0, 0.0, -2.0);
        let ring = shape.ring(&inner);
        assert_eq!(pointer(&ring), pointer(&shape.ring(&inner)));
        assert!(!ring.in_fill(&graphene::Point::new(100.0, 50.0), gsk::FillRule::EvenOdd));
        // Eviction must not invalidate a path retained by a render node.
        for ix in 0..256 {
            shape.moved(ix as f32, 0.0, 0.0).path();
        }
        assert!(first.in_fill(&graphene::Point::new(100.0, 50.0), gsk::FillRule::Winding));
    }

    #[test]
    fn continuous_corners_ease_into_the_edges() {
        let inside = |continuous, x, y| {
            Shape::new((0.0, 0.0, 200.0, 100.0), [20.0; 4], continuous)
                .path()
                .in_fill(&graphene::Point::new(x, y), gsk::FillRule::Winding)
        };
        // Just inside the top edge, where a quarter circle has already met it
        // and the continuous curve is still coming down to it.
        assert!(inside(false, 16.5, 0.5));
        assert!(!inside(true, 16.5, 0.5));
        // The middle of an edge and the box's center are the same.
        assert!(inside(true, 100.0, 0.5));
        assert!(inside(true, 100.0, 50.0));
        assert!(!inside(true, 0.5, 0.5));
    }

    #[test]
    fn linear_lines() {
        // `to right` over a wide box spans its width.
        let (a, b) = linear_line(deg(90.0), 200.0, 100.0);
        assert!(close(a.0, 0.0) && close(a.1, 50.0));
        assert!(close(b.0, 200.0) && close(b.1, 50.0));
        // 180° (the default) runs top to bottom.
        let (a, b) = linear_line(deg(180.0), 200.0, 100.0);
        assert!(close(a.0, 100.0) && close(a.1, 0.0));
        assert!(close(b.0, 100.0) && close(b.1, 100.0));
        // 45° over a square runs corner to corner.
        let (a, b) = linear_line(deg(45.0), 100.0, 100.0);
        assert!(close(a.0, 0.0) && close(a.1, 100.0));
        assert!(close(b.0, 100.0) && close(b.1, 0.0));
    }

    #[test]
    fn radial_sizes() {
        let (rx, ry) = radial_radii(true, GradientSize::FarthestCorner, 50.0, 50.0, 100.0, 100.0);
        assert!(close(rx, 50.0 * std::f32::consts::SQRT_2) && close(rx, ry));
        let (rx, ry) = radial_radii(false, GradientSize::FarthestSide, 25.0, 50.0, 200.0, 100.0);
        assert!(close(rx, 175.0) && close(ry, 50.0));
        let (rx, _) = radial_radii(true, GradientSize::ClosestSide, 25.0, 50.0, 200.0, 100.0);
        assert!(close(rx, 25.0));
    }

    #[test]
    fn stops_fit_the_range() {
        let mut out = Vec::new();
        // Stretched: 0..1 inside -1..1.
        fit_stops(&[(RED, 0.0), (BLUE, 1.0)], -1.0, 1.0, &mut out);
        assert_eq!(out, [(RED, 0.5), (BLUE, 1.0)]);
        // Cut at both ends, interpolated.
        fit_stops(&[(RED, -1.0), (BLUE, 2.0)], 0.0, 1.0, &mut out);
        assert_eq!(out.len(), 2);
        assert!(close(out[0].1, 0.0) && close(out[1].1, 1.0));
        assert_eq!(out[0].0, mix(RED, BLUE, 1.0 / 3.0));
        assert_eq!(out[1].0, mix(RED, BLUE, 2.0 / 3.0));
        // All past the end: the first color.
        fit_stops(&[(RED, 2.0), (BLUE, 3.0)], 0.0, 1.0, &mut out);
        assert_eq!(out, [(RED, 0.0), (RED, 1.0)]);
        // All before the start: the last color.
        fit_stops(&[(RED, -2.0), (BLUE, -1.0)], 0.0, 1.0, &mut out);
        assert_eq!(out, [(BLUE, 0.0), (BLUE, 1.0)]);
    }

    #[test]
    fn conic_tiles_cover_the_turn() {
        let mut tiled = Vec::new();
        let mut out = Vec::new();
        tile_stops(&[(RED, 0.0), (BLUE, 0.25)], &mut tiled);
        fit_stops(&tiled, 0.0, 1.0, &mut out);
        assert!(close(out[0].1, 0.0) && close(out[out.len() - 1].1, 1.0));
        assert!(out.windows(2).all(|w| w[0].1 <= w[1].1));
        for p in [0.0, 0.25, 0.5, 0.75, 1.0] {
            assert!(out.iter().any(|s| s.0 == RED && close(s.1, p)), "{p}");
        }
    }

    #[test]
    fn transparent_stops_keep_hue() {
        let mut s = [(RED, 0.0), (Color::TRANSPARENT, 1.0)];
        dehue(&mut s);
        assert_eq!(s[1].0, Color(0xff00_0000));
    }

    #[test]
    fn color_matrices_transpose() {
        let m = nsh_core::compose_color_matrices(&[Filter::Invert(1.0)]).unwrap();
        let (g, off) = gsk_color_matrix(&m);
        assert_eq!(g[0], -1.0);
        assert_eq!(off, [1.0, 1.0, 1.0, 0.0]);
        assert!(is_identity(
            &nsh_core::compose_color_matrices(&[Filter::Brightness(1.0)]).unwrap()
        ));
        // Sepia's green input feeds red: graphene keeps it in row 1.
        let m = nsh_core::compose_color_matrices(&[Filter::Sepia(1.0)]).unwrap();
        let (g, _) = gsk_color_matrix(&m);
        assert!(close(g[4], 0.769));
    }
}
