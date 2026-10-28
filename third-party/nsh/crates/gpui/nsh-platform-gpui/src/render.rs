//! Drawing a surface's view tree with GPUI.
//!
//! [`SurfaceElement`] is the GPUI element of one surface: it fills the
//! space its parent gives it, reports that size to the engine, takes the
//! pointer and keys over it ([`crate::events`]) and paints the whole tree
//! in its `paint` through [`draw_view`], which draws one view and its
//! subtree in this order:
//!
//! 1. shadows and background ([`crate::decor::draw_background`]),
//! 2. the content, clipped to the bounds: a shader's frame (to the rounded
//!    bounds), text, image, canvas,
//! 3. the children (clipped to the bounds when the view clips),
//! 4. the hosted items ([`crate::view::Native`]) and the scroll indicator,
//! 5. the border ([`crate::decor::draw_border`]).
//!
//! GPUI paints primitives (quads, paths, glyphs, images) in window
//! coordinates (logical pixels, which are nsh's points), with no world
//! transform and no group opacity. [`DrawCx`] keeps both itself: the
//! current transform maps the view's coordinates to the window's, and
//! opacity and color filters ([`DrawCx::push_color_matrix`]) apply to
//! every color, as GPUI's own element opacity does. Axis-aligned
//! rectangles (translations and scales) are GPUI's quads, exact; under a
//! rotation, skew or perspective they are filled as paths whose points are
//! mapped one by one ([`DrawCx::fill_contours`]), so they turn and project
//! with the view; glyphs are placed at their mapped origins, upright.
//!
//! Clips are rectangles in window coordinates (GPUI's content masks),
//! intersected as they nest. A clip that is rounded or not axis-aligned
//! is also kept as a convex polygon that paths are cut to exactly, and the
//! innermost rounded clip rounds the corners of the quads and images that
//! reach into its corners ([`DrawCx::clip_rounded`]): backgrounds and
//! images of a rounded card's children follow its corners, though other
//! content (glyphs, borders) is clipped to its rectangle.

use std::rc::Rc;

use gpui::{
    App, Bounds, ContentMask, Corners, Edges, Element, ElementId, GlobalElementId, Hitbox,
    HitboxBehavior, Hsla, InspectorElementId, IntoElement, LayoutId, PaintQuad, Pixels, Point,
    Window, point, px, size,
};
use nsh_core::{Color, Points};

use crate::{
    decor::shape,
    geom::Mat4,
    surface::Surface,
    view::{Hosted, NshView},
};

/// A color as GPUI's.
pub(crate) fn hsla(c: Color) -> Hsla {
    let (r, g, b, a) = c.to_f64();
    gpui::Rgba {
        r: r as f32,
        g: g as f32,
        b: b as f32,
        a: a as f32,
    }
    .into()
}

/// A rectangle in window coordinates.
pub(crate) fn bounds(x: f32, y: f32, w: f32, h: f32) -> Bounds<Pixels> {
    Bounds::new(point(px(x), px(y)), size(px(w), px(h)))
}

/// The innermost rounded clip (window coordinates).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct RoundedClip {
    /// The clip's rectangle.
    pub(crate) bounds: Bounds<Pixels>,
    /// Its corner radii, clockwise from the top left.
    pub(crate) radii: [f32; 4],
}

/// Saved state of the `push_*` methods of [`DrawCx`].
#[derive(Clone)]
struct Saved {
    clip: Bounds<Pixels>,
    opacity: f32,
    matrix: Option<[f32; 20]>,
    rounded: Option<RoundedClip>,
    clip_polygon: Option<Rc<[shape::Pt]>>,
}

/// The state of one drawing pass.
pub(crate) struct DrawCx<'a> {
    /// The window painted into (in its paint phase).
    pub(crate) window: &'a mut Window,
    /// The app.
    pub(crate) app: &'a mut App,
    /// The transform of the view being drawn (its coordinates to the
    /// window's, points).
    pub(crate) transform: Mat4,
    /// Pixels per point.
    pub(crate) scale: f32,
    /// The surface draws in its dark appearance.
    pub(crate) dark: bool,
    /// The opacity everything is drawn with.
    pub(crate) opacity: f32,
    /// The clip in window coordinates.
    pub(crate) clip: Bounds<Pixels>,
    /// The color filters everything is drawn with (a 4x5 matrix on
    /// straight sRGB colors, as [`nsh_core::Filter::color_matrix`]).
    pub(crate) matrix: Option<[f32; 20]>,
    /// The innermost rounded clip, when it is axis-aligned.
    pub(crate) rounded: Option<RoundedClip>,
    /// The clip as a convex polygon (window coordinates) when it is
    /// rounded or not axis-aligned: paths are cut to it.
    clip_polygon: Option<Rc<[shape::Pt]>>,
    saved: Vec<Saved>,
    /// Hosted items drawn in this pass, with their window bounds.
    pub(crate) drawn: Vec<(Rc<dyn Hosted>, Bounds<Pixels>)>,
    /// Paths painted in this pass, and milliseconds spent rasterizing
    /// canvases, while frame statistics are kept ([`crate::stats`]).
    pub(crate) measured: Option<(u32, f64)>,
}

impl<'a> DrawCx<'a> {
    /// A pass over `clip` (window coordinates).
    pub(crate) fn new(
        window: &'a mut Window,
        app: &'a mut App,
        clip: Bounds<Pixels>,
        dark: bool,
    ) -> Self {
        let scale = window.scale_factor();
        crate::decor::new_pass();
        DrawCx {
            window,
            app,
            transform: Mat4::new(),
            scale,
            dark,
            opacity: 1.0,
            clip,
            matrix: None,
            rounded: None,
            clip_polygon: None,
            saved: Vec::new(),
            drawn: Vec::new(),
            measured: None,
        }
    }

    /// Sets the transform (view coordinates to window coordinates).
    pub(crate) fn set_transform(&mut self, m: Mat4) {
        self.transform = m;
    }

    /// True when the transform keeps rectangles axis-aligned (and has no
    /// perspective): they can be drawn as quads.
    pub(crate) fn axis_aligned(&self) -> bool {
        let [_, b, c, _, _, _] = self.transform.affine();
        self.transform.is_affine() && b.abs() < 1e-6 && c.abs() < 1e-6
    }

    /// The scale of the transform (the larger of its axes'): sizes that
    /// do not follow rectangles (radii, font sizes, line widths) scale by
    /// it.
    pub(crate) fn transform_scale(&self) -> f32 {
        if !self.transform.is_affine() {
            // Projected: how far a point's neighbors land at the origin.
            let (o, x, y) = (
                self.map_pt((0.0, 0.0)),
                self.map_pt((1.0, 0.0)),
                self.map_pt((0.0, 1.0)),
            );
            return (x.0 - o.0)
                .hypot(x.1 - o.1)
                .max((y.0 - o.0).hypot(y.1 - o.1));
        }
        let [a, b, c, d, _, _] = self.transform.affine();
        (a * a + b * b).sqrt().max((c * c + d * d).sqrt())
    }

    /// Where `(x, y)` of the current coordinates lands in the window
    /// (projected through a perspective; a point behind the viewer lands
    /// where the transform without its perspective puts it).
    pub(crate) fn map(&self, x: f32, y: f32) -> Point<Pixels> {
        let (x, y) = self.map_pt((x, y));
        point(px(x), px(y))
    }

    /// [`DrawCx::map`] as a pair.
    fn map_pt(&self, (x, y): shape::Pt) -> shape::Pt {
        if let Some(p) = self.transform.map(x, y) {
            return p;
        }
        let [a, b, c, d, tx, ty] = self.transform.affine();
        (a * x + c * y + tx, b * x + d * y + ty)
    }

    /// The window bounds of the rectangle (current coordinates): exact
    /// when [`DrawCx::axis_aligned`], else its bounding box.
    pub(crate) fn rect(&self, x: f32, y: f32, w: f32, h: f32) -> Bounds<Pixels> {
        match self.transform.bounds(x, y, w, h) {
            Some((bx, by, bw, bh)) => bounds(bx, by, bw, bh),
            None => bounds(0.0, 0.0, 0.0, 0.0),
        }
    }

    /// `color` with the pass's color filters and opacity.
    pub(crate) fn color(&self, color: Color) -> Hsla {
        let (r, g, b, a) = color.to_f64();
        let mut c = [r as f32, g as f32, b as f32, a as f32];
        if let Some(m) = &self.matrix {
            c = crate::decor::apply_color_matrix(m, c);
        }
        gpui::Rgba {
            r: c[0],
            g: c[1],
            b: c[2],
            a: c[3] * self.opacity,
        }
        .into()
    }

    /// True when the color filters leave no color (images can only be
    /// drawn in color or gray).
    #[allow(dead_code, reason = "for images, which are being ported")]
    pub(crate) fn grayscale(&self) -> bool {
        self.matrix.as_ref().is_some_and(crate::decor::desaturates)
    }

    /// Draws what follows at `opacity` (multiplied into the colors).
    pub(crate) fn push_opacity(&mut self, opacity: f32) {
        self.save();
        self.opacity *= opacity;
    }

    /// Draws what follows through the color matrix `m` (applied before
    /// the filters already pushed: an ancestor's filters see the result).
    pub(crate) fn push_color_matrix(&mut self, m: [f32; 20]) {
        self.save();
        self.matrix = Some(match &self.matrix {
            Some(outer) => crate::decor::compose_color_matrices(&m, outer),
            None => m,
        });
    }

    /// Clips what follows to the rectangle (current coordinates; exactly
    /// for paths, to its bounds for the rest when the transform rotates).
    pub(crate) fn push_clip_rect(&mut self, x: f32, y: f32, w: f32, h: f32) {
        self.save();
        let r = self.rect(x, y, w, h);
        self.clip = self.clip.intersect(&r);
        if !self.axis_aligned() {
            let polygon = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)];
            self.clip_to_polygon(&polygon);
        }
    }

    /// Clips what follows to the rounded rectangle `rect` (current
    /// coordinates): paths exactly, quads and images by rounding their
    /// corners, the rest to its rectangle.
    pub(crate) fn push_clip_rounded(&mut self, rect: nsh_core::Bounds<Points>, radii: [f32; 4]) {
        self.save();
        let (x, y, w, h) = (
            rect.origin.x.0,
            rect.origin.y.0,
            rect.size.width.0,
            rect.size.height.0,
        );
        let b = self.rect(x, y, w, h);
        self.clip = self.clip.intersect(&b);
        let round = radii.iter().any(|r| *r > 0.0);
        if self.axis_aligned() {
            if round {
                let k = self.transform_scale();
                self.rounded = Some(RoundedClip {
                    bounds: b,
                    radii: radii.map(|r| r * k),
                });
                let window = crate::geom::rect(
                    f32::from(b.origin.x),
                    f32::from(b.origin.y),
                    f32::from(b.size.width),
                    f32::from(b.size.height),
                );
                let polygon =
                    shape::rounded(window, shape::circular(radii.map(|r| r * k)), self.scale);
                self.intersect_clip_polygon(polygon);
            }
        } else {
            let px = self.transform_scale() * self.scale;
            let polygon = shape::rounded(rect, shape::circular(radii), px);
            self.clip_to_polygon(&polygon);
        }
    }

    /// Cuts the clip polygon to `polygon` (current coordinates, convex).
    fn clip_to_polygon(&mut self, polygon: &[shape::Pt]) {
        let mapped: Vec<shape::Pt> = polygon.iter().map(|&p| self.map_pt(p)).collect();
        self.intersect_clip_polygon(mapped);
    }

    /// Cuts the clip polygon to `polygon` (window coordinates, convex).
    fn intersect_clip_polygon(&mut self, polygon: Vec<shape::Pt>) {
        let polygon = match &self.clip_polygon {
            Some(outer) => shape::clip_convex(&polygon, outer),
            None => polygon,
        };
        self.clip_polygon = Some(polygon.into());
    }

    /// True when the clip is rounded or not axis-aligned (kept as a
    /// polygon, [`DrawCx::shows`]).
    pub(crate) fn has_clip_polygon(&self) -> bool {
        self.clip_polygon.is_some()
    }

    /// True if the window point `(x, y)` lies inside the clip polygon (or
    /// there is none): what GPUI cannot cut to it (glyphs) is shown or not
    /// whole by such a point.
    pub(crate) fn shows(&self, x: f32, y: f32) -> bool {
        self.clip_polygon
            .as_ref()
            .is_none_or(|p| p.len() < 3 || shape::contains(p, (x, y)))
    }

    /// `bounds` with corner `radii` (window coordinates) as the innermost
    /// rounded clip shows them: where they reach past one of its rounded
    /// corners, cut to its rectangle with that corner's radius. Quads and
    /// images filled this way follow a rounded parent's corners.
    pub(crate) fn clip_rounded(
        &self,
        bounds: Bounds<Pixels>,
        radii: Corners<Pixels>,
    ) -> (Bounds<Pixels>, Corners<Pixels>) {
        match &self.rounded {
            Some(clip) => rounded_in_clip(bounds, radii, clip),
            None => (bounds, radii),
        }
    }

    fn save(&mut self) {
        self.saved.push(Saved {
            clip: self.clip,
            opacity: self.opacity,
            matrix: self.matrix,
            rounded: self.rounded,
            clip_polygon: self.clip_polygon.clone(),
        });
    }

    /// Pops the last push.
    pub(crate) fn pop(&mut self) {
        match self.saved.pop() {
            Some(s) => {
                self.clip = s.clip;
                self.opacity = s.opacity;
                self.matrix = s.matrix;
                self.rounded = s.rounded;
                self.clip_polygon = s.clip_polygon;
            }
            None => log::error!("render: pop without push"),
        }
    }

    /// True when nothing drawn now can show (clipped away, transparent).
    pub(crate) fn culled(&self) -> bool {
        self.opacity <= 0.0 || self.clip.size.width <= px(0.0) || self.clip.size.height <= px(0.0)
    }

    /// Runs `f` with the window inside the current clip.
    pub(crate) fn paint<R>(&mut self, f: impl FnOnce(&mut Window, &mut App) -> R) -> R {
        let mask = ContentMask { bounds: self.clip };
        let app = &mut *self.app;
        self.window
            .with_content_mask(Some(mask), |window| f(window, app))
    }

    /// Fills the rounded rectangle (current coordinates) with `color`.
    pub(crate) fn fill_rounded(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        radius: f32,
        color: Color,
    ) {
        self.fill_rect(crate::geom::rect(x, y, w, h), [radius; 4], color);
    }

    /// Fills `rect` (current coordinates) with corner radii (clockwise
    /// from the top left) in `color`: a quad (its corners following the
    /// rounded clip), or a path when the transform rotates.
    pub(crate) fn fill_rect(
        &mut self,
        rect: nsh_core::Bounds<Points>,
        radii: [f32; 4],
        color: Color,
    ) {
        if color.0 & 0xff == 0 || self.culled() {
            return;
        }
        if self.axis_aligned() {
            let c = self.color(color);
            let b = self.rect(
                rect.origin.x.0,
                rect.origin.y.0,
                rect.size.width.0,
                rect.size.height.0,
            );
            let k = self.transform_scale();
            let (cut, cut_radii) = self.clip_rounded(b, corners(radii, k));
            if fits(cut, cut_radii) {
                let quad = gpui::fill(cut, c).corner_radii(cut_radii);
                self.paint(|window, _| window.paint_quad(quad));
                return;
            }
            // GPUI's quads round each quarter with its own corner's radius
            // only: a corner of the clip larger than half the cut side is
            // filled as a path, cut to the clip exactly.
            let px = k * self.scale;
            let polygon = shape::rounded(rect, shape::circular(radii), px);
            self.fill_contours(&[polygon], color);
        } else {
            let px = self.transform_scale() * self.scale;
            let polygon = shape::rounded(rect, shape::circular(radii), px);
            self.fill_contours(&[polygon], color);
        }
    }

    /// Fills the contours (current coordinates) with `color`, even-odd (a
    /// contour inside another cuts a hole), cut to the clip.
    pub(crate) fn fill_contours(&mut self, contours: &[Vec<shape::Pt>], color: Color) {
        if color.0 & 0xff == 0 || self.culled() {
            return;
        }
        let c = self.color(color);
        let mut builder = gpui::PathBuilder::fill()
            .with_style(gpui::PathStyle::Fill(gpui::FillOptions::even_odd()));
        let mut any = false;
        for contour in contours {
            if contour.len() < 3 {
                continue;
            }
            let mut mapped: Vec<shape::Pt> = contour.iter().map(|&p| self.map_pt(p)).collect();
            if let Some(clip) = &self.clip_polygon {
                mapped = shape::clip_convex(&mapped, clip);
                if mapped.len() < 3 {
                    continue;
                }
            }
            let points: Vec<Point<Pixels>> =
                mapped.iter().map(|&(x, y)| point(px(x), px(y))).collect();
            builder.add_polygon(&points, true);
            any = true;
        }
        if !any {
            return;
        }
        match builder.build() {
            Ok(path) => {
                if let Some((paths, _)) = &mut self.measured {
                    *paths += 1;
                }
                self.paint(|window, _| window.paint_path(path, c))
            }
            Err(err) => log::debug!("render: path not filled: {err}"),
        }
    }

    /// Paints `quad` (window coordinates) inside the clip.
    pub(crate) fn paint_quad(&mut self, quad: PaintQuad) {
        if self.culled() {
            return;
        }
        self.paint(|window, _| window.paint_quad(quad));
    }
}

/// True if GPUI's quad draws `radii` on `bounds`: each fits its quarter
/// (its signed distance takes each quarter's radius alone).
pub(crate) fn fits(bounds: Bounds<Pixels>, radii: Corners<Pixels>) -> bool {
    let half = f32::from(bounds.size.width.min(bounds.size.height)) / 2.0 + 0.5;
    [
        radii.top_left,
        radii.top_right,
        radii.bottom_right,
        radii.bottom_left,
    ]
    .iter()
    .all(|r| f32::from(*r) <= half)
}

/// `bounds` with corner `radii` inside the rounded `clip` (see
/// [`DrawCx::clip_rounded`]).
fn rounded_in_clip(
    bounds: Bounds<Pixels>,
    radii: Corners<Pixels>,
    clip: &RoundedClip,
) -> (Bounds<Pixels>, Corners<Pixels>) {
    let c = &clip.bounds;
    let (l, t, r, b) = (
        f32::from(bounds.left()),
        f32::from(bounds.top()),
        f32::from(bounds.right()),
        f32::from(bounds.bottom()),
    );
    let (cl, ct, cr, cb) = (
        f32::from(c.left()),
        f32::from(c.top()),
        f32::from(c.right()),
        f32::from(c.bottom()),
    );
    // How far inside each of the clip's sides (top, right, bottom, left)
    // the rectangle is (0 when it reaches or crosses it), and which it
    // crosses (the cut moves its edge there).
    const EPS: f32 = 0.01;
    let inset = [t - ct, cr - r, cb - b, l - cl].map(|d| d.max(0.0));
    let cross = [t < ct - EPS, r > cr + EPS, b > cb + EPS, l < cl - EPS];
    // A corner inside the arc of a rounded clip corner takes its radius,
    // less how far inside it is (a child inset by its parent's border
    // follows the parent's curve: the arc's concentric radius); one whose
    // edge the cut moves is cut straight.
    let mut out = [
        f32::from(radii.top_left),
        f32::from(radii.top_right),
        f32::from(radii.bottom_right),
        f32::from(radii.bottom_left),
    ];
    let sides = [(0, 3), (0, 1), (2, 1), (2, 3)];
    let mut rounded = [false; 4];
    for (i, &(v, hz)) in sides.iter().enumerate() {
        let radius = clip.radii[i] - inset[v].max(inset[hz]);
        if radius > EPS {
            out[i] = out[i].max(radius);
            rounded[i] = true;
        }
    }
    if !rounded.contains(&true) {
        return (bounds, radii);
    }
    for (i, &(v, hz)) in sides.iter().enumerate() {
        if !rounded[i] && (cross[v] || cross[hz]) {
            out[i] = 0.0;
        }
    }
    let cut = bounds.intersect(c);
    (
        cut,
        Corners {
            top_left: px(out[0]),
            top_right: px(out[1]),
            bottom_right: px(out[2]),
            bottom_left: px(out[3]),
        },
    )
}

/// Corner radii (clockwise from the top left) as GPUI's, scaled by `k`.
pub(crate) fn corners(radii: [f32; 4], k: f32) -> Corners<Pixels> {
    Corners {
        top_left: px(radii[0] * k),
        top_right: px(radii[1] * k),
        bottom_right: px(radii[2] * k),
        bottom_left: px(radii[3] * k),
    }
}

/// Edge widths (top, right, bottom, left) as GPUI's, scaled by `k`.
pub(crate) fn edges(widths: [f32; 4], k: f32) -> Edges<Pixels> {
    Edges {
        top: px(widths[0] * k),
        right: px(widths[1] * k),
        bottom: px(widths[2] * k),
        left: px(widths[3] * k),
    }
}

/// A quad that draws only a border of `color`.
///
/// Its fill is `color` at zero alpha, as GPUI's own `div` borders: the
/// shader blends the border's inner antialiased edge toward the fill
/// without premultiplying, so a transparent black fill darkens the inner
/// edge of rounded corners (and of any edge off the pixel grid).
pub(crate) fn border_quad(
    bounds: Bounds<Pixels>,
    radii: Corners<Pixels>,
    widths: Edges<Pixels>,
    color: Hsla,
    style: gpui::BorderStyle,
) -> PaintQuad {
    let mut fill = color;
    fill.a = 0.0;
    gpui::quad(bounds, radii, fill, widths, color, style)
}

/// Draws `view` and its subtree; `parent` is the transform of the
/// parent's coordinates and `origin` where the view goes in them.
pub(crate) fn draw_view(cx: &mut DrawCx<'_>, view: &NshView, parent: Mat4, origin: (f32, f32)) {
    let state = view.state();
    if state.style.hidden || state.concealed {
        return;
    }
    let opacity = state.opacity();
    if opacity <= 0.0 {
        return;
    }
    let mut local = Mat4::new().translate(origin.0, origin.1);
    if let Some(t) = state.transform() {
        local = Mat4::mul(&t, &local);
    }
    let world = Mat4::mul(&local, &parent);
    if crate::decor::backface_away(&state, &world) {
        return;
    }
    let matrix = crate::decor::color_matrix(&state);
    drop(state);
    cx.set_transform(world);
    cx.push_opacity(opacity);
    if let Some(m) = matrix {
        cx.push_color_matrix(m);
    }
    draw_content(cx, view, world);
    if matrix.is_some() {
        cx.pop();
    }
    cx.pop();
}

/// Draws what `view` draws and its subtree at `world` (set on the
/// context): the content's shadow, shadows and background, the content
/// clipped to the bounds,
/// the children, the hosted items, the scroll indicator, the border and
/// outline.
pub(crate) fn draw_content(cx: &mut DrawCx<'_>, view: &NshView, world: Mat4) {
    crate::decor::draw_content_shadow(cx, view, world);
    let state = view.state();
    crate::decor::draw_background(cx, &state);
    let clip = state.clips();
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    if clip {
        cx.push_clip_rounded(crate::geom::rect(0.0, 0.0, w, h), state.radii());
        crate::text::draw_shadow(cx, &state);
    } else {
        // Text shadows spread past the view, as CSS's do.
        crate::text::draw_shadow(cx, &state);
        // The view's own content stays inside it, as a UIKit view's drawing
        // stays in its backing store.
        cx.push_clip_rect(0.0, 0.0, w, h);
    }
    crate::shader::draw(cx, &state);
    crate::text::draw(cx, &state);
    crate::text::draw_focus(cx, view, &state);
    crate::image::draw(cx, &state);
    match cx.measured {
        Some(_) => {
            let start = std::time::Instant::now();
            crate::canvas::draw(cx, &state);
            if let Some((_, ms)) = &mut cx.measured {
                *ms += start.elapsed().as_secs_f64() * 1e3;
            }
        }
        None => crate::canvas::draw(cx, &state),
    }
    if !clip {
        cx.pop();
    }
    let natives = state.natives.clone();
    let culled = clip && cx.culled();
    drop(state);
    if !culled {
        view.with_children(|children| {
            for child in children {
                let origin = {
                    let s = child.state();
                    view.state().child_origin(s.frame, s.shift)
                };
                draw_view(cx, child, world, origin);
            }
        });
    }
    cx.set_transform(world);
    for native in &natives {
        let r = native.rect;
        let m = Mat4::new()
            .translate(r.origin.x.0, r.origin.y.0)
            .then(&world);
        cx.set_transform(m);
        native.item.draw(cx, (r.size.width.0, r.size.height.0));
        let b = cx.rect(0.0, 0.0, r.size.width.0, r.size.height.0);
        cx.drawn.push((native.item.clone(), b));
    }
    cx.set_transform(world);
    let state = view.state();
    let nested = state.scroll.is_some() && crate::scroll::nested(view);
    crate::scroll::draw_indicator(cx, &state, nested);
    if clip {
        cx.pop();
    }
    crate::decor::draw_border(cx, &state);
}

/// The GPUI element of a surface: fills its parent's space and draws the
/// surface's view tree.
pub(crate) struct SurfaceElement {
    pub(crate) surface: Rc<Surface>,
    pub(crate) focus: gpui::FocusHandle,
    pub(crate) view: gpui::WeakEntity<crate::app::AppView>,
}

impl IntoElement for SurfaceElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for SurfaceElement {
    type RequestLayoutState = ();
    type PrepaintState = Hitbox;

    fn id(&self) -> Option<ElementId> {
        // An id gives the element a node in GPUI's accessibility tree.
        Some("nsh-surface".into())
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = gpui::Style::default();
        style.size.width = gpui::relative(1.0).into();
        style.size.height = gpui::relative(1.0).into();
        style.flex_grow = 1.0;
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let surface = &self.surface;
        surface.drawing();
        surface
            .origin
            .set((f32::from(bounds.origin.x), f32::from(bounds.origin.y)));
        surface.resized(
            f32::from(bounds.size.width),
            f32::from(bounds.size.height),
            window.scale_factor(),
        );
        crate::system::window_prepaint(surface, window, cx);
        let start = std::time::Instant::now();
        if surface.wants_frames() {
            surface.tick();
        }
        if let Some(stats) = surface.stats.borrow_mut().as_mut() {
            stats.tick(start);
        }
        // Changes made by the tick are in this frame.
        surface.drawing();
        crate::access::prepaint(surface, &self.focus, window, cx);
        window.set_focus_handle(&self.focus, cx);
        let hitbox = window.insert_hitbox(bounds, HitboxBehavior::BlockMouse);
        // Native components and web views take the input over their boxes.
        crate::native::prepaint(surface, window, cx);
        hitbox
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _layout: &mut Self::RequestLayoutState,
        hitbox: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let start = std::time::Instant::now();
        let surface = self.surface.clone();
        let dark = crate::system::dark(&surface);
        // Embedded with a theme, the surface is drawn on the host's
        // background.
        let background = match &*surface.host_theme.borrow() {
            Some(theme) if dark => theme.background.dark.into(),
            Some(theme) => theme.background.light.into(),
            None => crate::system::window_background(&surface),
        };
        if background.0 & 0xff != 0 {
            window.paint_quad(gpui::fill(bounds, hsla(background)));
        }
        // Before the tree: painting a native component's element leaves its
        // dispatch node active (GPUI enters each element's node and never
        // leaves it), and key listeners go to the active node, where they
        // would hear keys only while focus is inside the component.
        crate::events::install(
            &surface,
            &self.focus,
            &self.view,
            hitbox,
            bounds,
            window,
            cx,
        );
        let drawn = {
            crate::canvas::begin_pass(surface.key());
            let mut dcx = DrawCx::new(window, cx, bounds, dark);
            if surface.stats.borrow().is_some() {
                dcx.measured = Some((0, 0.0));
            }
            let origin = (f32::from(bounds.origin.x), f32::from(bounds.origin.y));
            draw_view(&mut dcx, &surface.root, Mat4::new(), origin);
            if let (Some(stats), Some((paths, canvas))) =
                (surface.stats.borrow_mut().as_mut(), dcx.measured)
            {
                stats.content(paths, canvas);
            }
            std::mem::take(&mut dcx.drawn)
        };
        surface.items_placed(drawn);
        // Animations tick on the window's frames while they run (and stop
        // asking when idle); a change made while painting (a frame client
        // added, an item placed) is drawn in the next frame, as no entry
        // point flushes after a paint.
        let requested = surface.wants_frames() || surface.invalidated();
        if requested {
            window.request_animation_frame();
        }
        crate::access::paint(&surface, window, cx);
        if let Some(stats) = surface.stats.borrow_mut().as_mut() {
            if requested {
                stats.requested();
            }
            stats.painted(start, window.is_window_active());
        }
    }

    fn a11y_role(&self) -> Option<gpui::accesskit::Role> {
        Some(crate::access::ROLE)
    }

    fn a11y_synthetic_children(
        &mut self,
        _hitbox: &mut Self::PrepaintState,
        builder: &mut gpui::A11ySubtreeBuilder,
    ) {
        crate::access::synthetic(&self.surface, builder);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn radii(c: Corners<Pixels>) -> [f32; 4] {
        [
            f32::from(c.top_left),
            f32::from(c.top_right),
            f32::from(c.bottom_right),
            f32::from(c.bottom_left),
        ]
    }

    #[test]
    fn rounded_clips_round_what_reaches_their_corners() {
        let clip = RoundedClip {
            bounds: bounds(0.0, 0.0, 100.0, 60.0),
            radii: [20.0; 4],
        };
        // A band across the top, wider than the clip: its top corners take
        // the clip's, its bottom ones are cut straight.
        let (b, r) = rounded_in_clip(
            bounds(-10.0, -5.0, 120.0, 30.0),
            corners([4.0; 4], 1.0),
            &clip,
        );
        assert_eq!(b, bounds(0.0, 0.0, 100.0, 25.0));
        assert_eq!(radii(r), [20.0, 20.0, 0.0, 0.0]);
        // A band exactly as wide keeps its own bottom corners.
        let (_, r) = rounded_in_clip(bounds(0.0, 0.0, 100.0, 30.0), corners([4.0; 4], 1.0), &clip);
        assert_eq!(radii(r), [20.0, 20.0, 4.0, 4.0]);
        // Inside, away from the corners: as it was.
        let inside = bounds(30.0, 20.0, 10.0, 10.0);
        let (b, r) = rounded_in_clip(inside, corners([2.0; 4], 1.0), &clip);
        assert_eq!((b, radii(r)), (inside, [2.0; 4]));
        // Inset by a parent's 1 pt border: the parent's curve, 1 pt in.
        let (b, r) = rounded_in_clip(bounds(1.0, 1.0, 98.0, 58.0), corners([0.0; 4], 1.0), &clip);
        assert_eq!((b, radii(r)), (bounds(1.0, 1.0, 98.0, 58.0), [19.0; 4]));
    }

    #[test]
    fn quads_fit_radii_up_to_half_their_side() {
        let b = bounds(0.0, 0.0, 100.0, 40.0);
        assert!(fits(b, corners([20.0; 4], 1.0)));
        assert!(!fits(b, corners([30.0, 0.0, 0.0, 0.0], 1.0)));
    }

    #[test]
    fn border_quads_fill_with_the_border_color_at_zero_alpha() {
        // GPUI mixes the inner antialiased edge toward the fill without
        // premultiplying: a transparent black fill darkens rounded corners.
        let color = gpui::hsla(0.0, 0.0, 0.9, 1.0);
        let q = border_quad(
            bounds(0.0, 0.0, 100.0, 60.0),
            corners([8.0; 4], 1.0),
            edges([1.0; 4], 1.0),
            color,
            gpui::BorderStyle::Solid,
        );
        assert_eq!(q.background, gpui::hsla(0.0, 0.0, 0.9, 0.0).into());
        assert_eq!(q.border_color, color);
    }
}
