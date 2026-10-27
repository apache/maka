//! View decoration: shadows, backgrounds, gradients, borders, outlines and
//! filters, drawn with GPUI's primitives.
//!
//! Order, bottom to top (CSS painting order): outer shadows (`boxShadow`
//! layers, last first), the
//! background color, gradients (last first, [`gradient`]), inset shadows
//! (inside the padding box), the content and children ([`crate::render`]),
//! the border and the outline. The border is drawn over the children, as
//! UIKit draws layer borders: the core places content inside the border,
//! so only overflowing children reach under it.
//!
//! Axis-aligned views use GPUI's primitives as they are: shadows are its
//! blurred rounded-box shadows (`paint_drop_shadows`,
//! `paint_inset_shadows`), the background and a border in one color are
//! quads (per-side widths, per-corner radii, dashes). Everything a quad
//! cannot draw is filled as paths of polygons ([`shape`]): borders whose
//! sides differ in color (each side's part of the ring, split along the
//! corners' diagonals as CSS splits them), dotted lines (round dots), and
//! every decoration of a rotated, skewed or projected view, so that it
//! turns with the view. A path cannot be blurred: a rotated view's shadow
//! is a stack of translucent outlines growing over the blur's width.
//!
//! `filter: drop-shadow(…)` follows the content. GPUI cannot draw the
//! content offscreen, so the content's shadow is the shadows of the boxes
//! of the view's filled descendants (and images), drawn under all of them
//! ([`draw_content_shadow`]), and of the glyphs of its texts, painted in
//! the shadow's color around their places (a blur faked by copies);
//! borders cast none. Shadows are not cut out of a translucent fill (GPUI
//! draws them whole).
//!
//! Color filters (brightness, contrast, grayscale, hue-rotate, invert,
//! opacity, saturate, sepia) are color matrices applied to every color the
//! view's subtree draws ([`DrawCx::push_color_matrix`]); images, which
//! GPUI draws in color or gray only, turn gray under a desaturating
//! filter. GPUI has no offscreen passes: `blur()`, `backdropFilter` and
//! `mixBlendMode` are not drawn. `borderCurve: "continuous"` draws circular
//! corners, matching the clip of the children; Android's `elevation` is
//! Android only.

mod gradient;
pub(crate) mod shape;

use gpui::{BoxShadow, point, px};
use nsh_core::{BorderStyle, Borders, Color, Filter, Outline, ViewKind};

use self::shape::{Pt, circular, clip_convex, grown, padding_box, rounded, side_quads};
use crate::{
    geom::{Mat4, rect},
    render::{DrawCx, border_quad, corners, edges, fits},
    view::{NshView, ViewState},
};

/// A drawing pass starts: decoration images drawn lately stay in GPUI's
/// atlas ([`gradient`]).
pub(crate) fn new_pass() {
    gradient::new_pass();
}

/// `c` with its alpha multiplied by `a`.
fn faded(c: Color, a: f32) -> Color {
    let alpha = ((c.0 & 0xff) as f32 * a.clamp(0.0, 1.0)).round() as u32;
    Color((c.0 & 0xffff_ff00) | alpha.min(255))
}

/// True if the view paints its box: its shadow then takes the box's shape.
fn has_fill(state: &ViewState) -> bool {
    !state.background().is_transparent()
        || state.anim.background.is_some()
        || state
            .style
            .effects
            .as_ref()
            .is_some_and(|e| !e.background_images.is_empty())
}

/// True if the view's box casts a shadow of the content of an ancestor
/// ([`draw_content_shadow`]): it is filled or shows an image.
fn casts_shadow(state: &ViewState) -> bool {
    has_fill(state) || (state.kind == ViewKind::Image && state.image.is_some())
}

/// True when `state` is turned away from the viewer and hides its back.
pub(crate) fn backface_away(state: &ViewState, world: &Mat4) -> bool {
    state.style.backface_hidden && faces_away(world)
}

/// True if the plane z = 0 seen through `m` shows its back: CSS's test, the
/// z-z entry of the inverse matrix is negative. That entry is the minor of
/// rows and columns x, y and w (the plane's homography) over the whole
/// determinant, so a mirror (`scaleX(-1)`) is not a back face, a half turn
/// about y is.
fn faces_away(m: &Mat4) -> bool {
    let a = &m.m;
    let h = [
        [a[0][0], a[0][1], a[0][3]],
        [a[1][0], a[1][1], a[1][3]],
        [a[3][0], a[3][1], a[3][3]],
    ];
    let minor = det3(&h);
    let det = det4(a);
    det.abs() > 1e-12 && minor / det < 0.0
}

fn det3(m: &[[f32; 3]; 3]) -> f32 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

fn det4(m: &[[f32; 4]; 4]) -> f32 {
    (0..4)
        .map(|c| {
            let minor: [[f32; 3]; 3] = std::array::from_fn(|r| {
                let row = &m[r + 1];
                let mut k = 0;
                std::array::from_fn(|_| {
                    if k == c {
                        k += 1;
                    }
                    k += 1;
                    row[k - 1]
                })
            });
            let sign = if c % 2 == 0 { 1.0 } else { -1.0 };
            sign * m[0][c] * det3(&minor)
        })
        .sum()
}

/// The color matrix of the view's filters, or `None` when they change no
/// color.
pub(crate) fn color_matrix(state: &ViewState) -> Option<[f32; 20]> {
    let e = state.style.effects.as_deref()?;
    let m = nsh_core::compose_color_matrices(&e.filters)?;
    (!is_identity(&m)).then_some(m)
}

/// True if `m` leaves colors as they are.
fn is_identity(m: &[f32; 20]) -> bool {
    m.iter().enumerate().all(|(i, &v)| {
        let want = if i % 6 == 0 { 1.0 } else { 0.0 };
        (v - want).abs() < 1e-5
    })
}

/// `c` (straight RGBA in `0..=1`) through the color matrix `m`, clamped.
pub(crate) fn apply_color_matrix(m: &[f32; 20], c: [f32; 4]) -> [f32; 4] {
    std::array::from_fn(|row| {
        let r = &m[row * 5..row * 5 + 5];
        (r[0] * c[0] + r[1] * c[1] + r[2] * c[2] + r[3] * c[3] + r[4]).clamp(0.0, 1.0)
    })
}

/// The color matrix applying `first`, then `then`.
pub(crate) fn compose_color_matrices(first: &[f32; 20], then: &[f32; 20]) -> [f32; 20] {
    let mut r = [0.0; 20];
    for row in 0..4 {
        for col in 0..5 {
            let mut v = if col == 4 { then[row * 5 + 4] } else { 0.0 };
            for k in 0..4 {
                v += then[row * 5 + k] * first[k * 5 + col];
            }
            r[row * 5 + col] = v;
        }
    }
    r
}

/// True if `m` maps every color to a gray (its color rows are equal).
pub(crate) fn desaturates(m: &[f32; 20]) -> bool {
    (0..5).all(|i| (m[i] - m[5 + i]).abs() < 0.02 && (m[i] - m[10 + i]).abs() < 0.02)
}

/// One shadow: a `boxShadow` layer or a drop shadow.
#[derive(Debug, Clone, Copy, PartialEq)]
struct ShadowSpec {
    dx: f32,
    dy: f32,
    /// How far the shape grows (negative: shrinks).
    spread: f32,
    /// The Gaussian's deviation (half the CSS blur).
    sigma: f32,
    color: Color,
}

/// How many outlines a rotated view's blurred shadow is drawn as.
const SHADOW_LAYERS: usize = 10;

/// How far each outline of a blurred shadow drawn as [`SHADOW_LAYERS`]
/// outlines grows (deviations), and the alpha each is drawn with so that
/// where all overlap, they show `alpha`.
fn shadow_layers(sigma: f32, alpha: f32) -> (Vec<f32>, f32) {
    if sigma <= 0.0 {
        return (vec![0.0], alpha);
    }
    let n = SHADOW_LAYERS;
    let grow = (0..n)
        .map(|i| sigma * (-1.5 + 3.0 * (i as f32 + 0.5) / n as f32))
        .collect();
    let a = 1.0 - (1.0 - alpha.clamp(0.0, 1.0)).powf(1.0 / n as f32);
    (grow, a)
}

/// Where copies of glyphs are painted to fake a blur of deviation `sigma`
/// (`sigma_px` in pixels): the glyphs, then two rings around them; and the
/// alpha each copy takes for all of them over each other to show a given
/// alpha.
fn silhouette_offsets(sigma_px: f32, sigma: f32) -> (Vec<Pt>, impl Fn(f32) -> f32) {
    let mut offsets = vec![(0.0, 0.0)];
    if sigma_px >= 0.5 {
        // Close rings: copies further out read as ghosts of the text
        // rather than a blur.
        for (ring, r) in [(0, 0.3 * sigma), (1, 0.6 * sigma)] {
            for i in 0..12 {
                let a = std::f32::consts::TAU * (i as f32 + 0.5 * ring as f32) / 12.0;
                offsets.push((r * a.cos(), r * a.sin()));
            }
        }
    }
    let n = offsets.len() as f32;
    (offsets, move |alpha: f32| {
        1.0 - (1.0 - alpha.clamp(0.0, 1.0)).powf(1.0 / n)
    })
}

/// `c` with alpha `a` (`0..=1`).
fn with_alpha(c: Color, a: f32) -> Color {
    Color((c.0 & 0xffff_ff00) | (a.clamp(0.0, 1.0) * 255.0).round() as u32)
}

/// Draws an outer shadow of the `w` x `h` box with `radii` (current
/// coordinates).
fn outer_shadow(cx: &mut DrawCx<'_>, w: f32, h: f32, radii: [f32; 4], spec: &ShadowSpec) {
    if spec.color.is_transparent() || cx.culled() {
        return;
    }
    if cx.axis_aligned() {
        let k = cx.transform_scale();
        let shadows = [BoxShadow {
            color: cx.color(spec.color),
            offset: point(px(spec.dx * k), px(spec.dy * k)),
            blur_radius: px(spec.sigma.max(0.0) * k),
            spread_radius: px(spec.spread * k),
            inset: false,
        }];
        let b = cx.rect(0.0, 0.0, w, h);
        let c = corners(radii, k);
        cx.paint(|window, _| window.paint_drop_shadows(b, c, &shadows));
        return;
    }
    let px_per = pixels(cx);
    let alpha = (spec.color.0 & 0xff) as f32 / 255.0;
    let (grow, a) = shadow_layers(spec.sigma, alpha);
    let color = with_alpha(spec.color, a);
    for g in grow {
        let s = spec.spread + g;
        let (sw, sh) = (w + 2.0 * s, h + 2.0 * s);
        if sw <= 0.0 || sh <= 0.0 {
            continue;
        }
        let shape = rounded(
            rect(spec.dx - s, spec.dy - s, sw, sh),
            circular(radii.map(|r| grown(r, s))),
            px_per,
        );
        cx.fill_contours(&[shape], color);
    }
}

/// Draws an inset shadow of the `w` x `h` box with `radii` and border
/// `widths`: inside the padding box.
fn inset_shadow(
    cx: &mut DrawCx<'_>,
    w: f32,
    h: f32,
    radii: [f32; 4],
    widths: [f32; 4],
    spec: &ShadowSpec,
) {
    if spec.color.is_transparent() || cx.culled() {
        return;
    }
    let (padding, inner) = padding_box(w, h, radii, widths);
    if padding.size.width.0 <= 0.0 || padding.size.height.0 <= 0.0 {
        return;
    }
    if cx.axis_aligned() {
        let k = cx.transform_scale();
        let shadows = [BoxShadow {
            color: cx.color(spec.color),
            offset: point(px(spec.dx * k), px(spec.dy * k)),
            blur_radius: px(spec.sigma.max(0.0) * k),
            spread_radius: px(spec.spread * k),
            inset: true,
        }];
        let b = cx.rect(
            padding.origin.x.0,
            padding.origin.y.0,
            padding.size.width.0,
            padding.size.height.0,
        );
        // GPUI's corners are circular: the padding box's elliptical ones
        // (borders of different widths) are averaged.
        let c = corners(inner.map(|(x, y)| (x + y) / 2.0), k);
        cx.paint(|window, _| window.paint_inset_shadows(b, c, &shadows));
        return;
    }
    // The shadow is the padding box less a hole (the padding box moved and
    // shrunk by the spread), whose edge the blur softens.
    let px_per = pixels(cx);
    let outline = rounded(padding, inner, px_per);
    let alpha = (spec.color.0 & 0xff) as f32 / 255.0;
    let (grow, a) = shadow_layers(spec.sigma, alpha);
    let color = with_alpha(spec.color, a);
    for g in grow {
        let s = spec.spread - g;
        let hole = rect(
            padding.origin.x.0 + spec.dx + s,
            padding.origin.y.0 + spec.dy + s,
            padding.size.width.0 - 2.0 * s,
            padding.size.height.0 - 2.0 * s,
        );
        let mut contours = vec![outline.clone()];
        if hole.size.width.0 > 0.0 && hole.size.height.0 > 0.0 {
            let hole_corners = inner.map(|(x, y)| ((x - s).max(0.0), (y - s).max(0.0)));
            contours.push(clip_convex(&rounded(hole, hole_corners, px_per), &outline));
        }
        cx.fill_contours(&contours, color);
    }
}

/// Draws the shadows of the view's content (`drop-shadow` filters): the
/// boxes of its filled descendants cast them, under all of them. `world`
/// is the view's transform, set on the context again after.
pub(crate) fn draw_content_shadow(cx: &mut DrawCx<'_>, view: &NshView, world: Mat4) {
    let specs = {
        let state = view.state();
        let mut specs = Vec::new();
        if let Some(e) = &state.style.effects {
            for f in &e.filters {
                if let Filter::DropShadow {
                    offset_x,
                    offset_y,
                    blur,
                    color,
                } = *f
                    && !color.is_transparent()
                {
                    specs.push(ShadowSpec {
                        dx: offset_x.0,
                        dy: offset_y.0,
                        spread: 0.0,
                        sigma: blur.0.max(0.0) / 2.0,
                        color,
                    });
                }
            }
        }
        specs
    };
    if specs.is_empty() || cx.culled() {
        return;
    }
    for spec in &specs {
        let at = Mat4::new().translate(spec.dx, spec.dy).then(&world);
        cast(cx, view, at, spec, 1.0);
    }
    cx.set_transform(world);
}

/// Draws the shadow `spec` (its offset already in `world`) of `view`'s box
/// when it casts one, then of its subtree's.
fn cast(cx: &mut DrawCx<'_>, view: &NshView, world: Mat4, spec: &ShadowSpec, opacity: f32) {
    let state = view.state();
    if state.style.hidden || state.concealed {
        return;
    }
    if casts_shadow(&state) {
        let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
        cx.set_transform(world);
        let s = ShadowSpec {
            dx: 0.0,
            dy: 0.0,
            color: faded(spec.color, opacity),
            ..*spec
        };
        outer_shadow(cx, w, h, state.radii(), &s);
    }
    if state.text.is_some() {
        cx.set_transform(world);
        let (offsets, a) = silhouette_offsets(spec.sigma * pixels(cx), spec.sigma);
        let alpha = (spec.color.0 & 0xff) as f32 / 255.0 * opacity;
        crate::text::draw_silhouette(cx, &state, &offsets, with_alpha(spec.color, a(alpha)));
    }
    view.with_children(|children| {
        for child in children {
            let (local, child_opacity) = {
                let cs = child.state();
                let o = state.child_origin(cs.frame, cs.shift);
                let mut local = Mat4::new().translate(o.0, o.1);
                if let Some(t) = cs.transform() {
                    local = Mat4::mul(&t, &local);
                }
                (local, cs.opacity())
            };
            if child_opacity <= 0.0 {
                continue;
            }
            cast(
                cx,
                child,
                Mat4::mul(&local, &world),
                spec,
                opacity * child_opacity,
            );
        }
    });
}

/// Draws the view's shadows, background color, gradients and inset
/// shadows, under its content (view coordinates set on `cx`).
pub(crate) fn draw_background(cx: &mut DrawCx<'_>, state: &ViewState) {
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    if w <= 0.0 || h <= 0.0 || cx.culled() {
        return;
    }
    let radii = state.radii();
    let effects = state.style.effects.as_deref();

    if let Some(e) = effects {
        // CSS lists the top layer first.
        for b in e.box_shadows.iter().rev() {
            if !b.inset && b.is_visible() {
                let spec = ShadowSpec {
                    dx: b.offset_x.0,
                    dy: b.offset_y.0,
                    spread: b.spread.0,
                    sigma: b.blur.0.max(0.0) / 2.0,
                    color: b.color,
                };
                outer_shadow(cx, w, h, radii, &spec);
            }
        }
    }

    let background = state.background();
    if !background.is_transparent() {
        cx.fill_rect(rect(0.0, 0.0, w, h), radii, background);
    }
    if let Some(e) = effects {
        for g in e.background_images.iter().rev() {
            gradient::draw(cx, g, w, h, radii);
        }
        let widths = state.style.borders.widths.to_array().map(|w| w.0);
        for b in e.box_shadows.iter().rev() {
            if b.inset && b.is_visible() {
                let spec = ShadowSpec {
                    dx: b.offset_x.0,
                    dy: b.offset_y.0,
                    spread: b.spread.0,
                    sigma: b.blur.0.max(0.0) / 2.0,
                    color: b.color,
                };
                inset_shadow(cx, w, h, radii, widths, &spec);
            }
        }
    }
}

/// Draws the border and the outline, over the children (as UIKit draws
/// layer borders, so content the core placed under a border never covers
/// it).
pub(crate) fn draw_border(cx: &mut DrawCx<'_>, state: &ViewState) {
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    if w <= 0.0 || h <= 0.0 || cx.culled() {
        return;
    }
    // With the animated color: a border declared transparent shows once
    // its color is animated.
    let b = state.borders();
    let o = state.style.outline;
    let radii = state.radii();
    if b.is_visible() {
        draw_borders(cx, &b, w, h, radii);
    }
    if o.is_visible() {
        draw_outline(cx, &o, w, h, radii);
    }
}

/// Pixels per unit of the current coordinates (how finely curves are
/// flattened).
fn pixels(cx: &DrawCx<'_>) -> f32 {
    cx.transform_scale() * cx.scale
}

/// The color all drawn sides share, if they do.
fn shared_color(b: &Borders) -> Option<Color> {
    let widths = b.widths.to_array().map(|w| w.0);
    let mut drawn = (0..4).filter(|&i| widths[i] > 0.0);
    let first = drawn.next().map_or(Color::TRANSPARENT, |i| b.colors[i]);
    drawn.all(|i| b.colors[i] == first).then_some(first)
}

/// The borders of a `w` x `h` box with `radii`.
fn draw_borders(cx: &mut DrawCx<'_>, b: &Borders, w: f32, h: f32, radii: [f32; 4]) {
    let shared = shared_color(b);
    let widths = b.widths.to_array().map(|w| w.0);
    let uniform_width = widths.iter().all(|&x| x == widths[0]);
    let quad_style = match b.style {
        BorderStyle::Solid => Some(gpui::BorderStyle::Solid),
        // GPUI's dashes follow one width around the box.
        BorderStyle::Dashed if uniform_width => Some(gpui::BorderStyle::Dashed),
        _ => None,
    };
    let k = cx.transform_scale();
    let bounds = cx.rect(0.0, 0.0, w, h);
    let quad_fits = cx.axis_aligned() && fits(bounds, corners(radii, k));
    if let (Some(color), Some(style), true) = (shared, quad_style, quad_fits) {
        let quad = border_quad(
            bounds,
            corners(radii, k),
            edges(widths, k),
            cx.color(color),
            style,
        );
        cx.paint_quad(quad);
        return;
    }
    let px_per = pixels(cx);
    let quads = side_quads(w, h, widths);
    if b.style == BorderStyle::Solid {
        let ring = shape::ring(w, h, radii, widths, px_per);
        if let Some(color) = shared {
            cx.fill_contours(&ring, color);
            return;
        }
        // Each side's part of the ring: the ring cut to the side's two
        // triangles (cutting distributes over the even-odd fill).
        for (side, quad) in quads.iter().enumerate() {
            let c = b.colors[side];
            if widths[side] <= 0.0 || c.is_transparent() {
                continue;
            }
            let mut contours = Vec::with_capacity(4);
            for tri in shape::side_triangles(quad) {
                for contour in &ring {
                    contours.push(clip_convex(contour, &tri));
                }
            }
            cx.fill_contours(&contours, c);
        }
        return;
    }
    // Dashes and dots along the line through the middle of the borders,
    // each in the color and width of the side it lies on.
    let half = widths.map(|x| x / 2.0);
    let (line_rect, line_corners) = padding_box(w, h, radii, half);
    let line = rounded(line_rect, line_corners, px_per);
    let widest = widths.iter().copied().fold(0.0, f32::max);
    let mut by_side: [Vec<Vec<Pt>>; 4] = Default::default();
    if b.style == BorderStyle::Dotted {
        for c in shape::dots(&line, 2.0 * widest) {
            let side = shape::side_of(&quads, c);
            by_side[side].push(shape::circle(c, widths[side] / 2.0, px_per));
        }
    } else {
        for dash in shape::dashes(&line, 3.0 * widest, 3.0 * widest) {
            let mid = dash[dash.len() / 2];
            let side = shape::side_of(&quads, mid);
            by_side[side].push(shape::thick(&dash, widths[side]));
        }
    }
    for (side, contours) in by_side.iter().enumerate() {
        if widths[side] > 0.0 && !contours.is_empty() {
            cx.fill_contours(contours, b.colors[side]);
        }
    }
}

/// The outline: outside the border box by its offset; rounded corners
/// follow the border radius outwards, square ones stay square.
fn draw_outline(cx: &mut DrawCx<'_>, o: &Outline, w: f32, h: f32, radii: [f32; 4]) {
    let (width, off) = (o.width.0, o.offset.0);
    let d = off + width;
    let (ow, oh) = (w + 2.0 * d, h + 2.0 * d);
    if ow <= 0.0 || oh <= 0.0 {
        return;
    }
    let outer_radii = radii.map(|r| grown(r, d));
    let quad_style = match o.style {
        BorderStyle::Solid => Some(gpui::BorderStyle::Solid),
        BorderStyle::Dashed => Some(gpui::BorderStyle::Dashed),
        BorderStyle::Dotted => None,
    };
    let k = cx.transform_scale();
    let bounds = cx.rect(-d, -d, ow, oh);
    let quad_fits = cx.axis_aligned() && fits(bounds, corners(outer_radii, k));
    if let (Some(style), true) = (quad_style, quad_fits) {
        let quad = border_quad(
            bounds,
            corners(outer_radii, k),
            edges([width; 4], k),
            cx.color(o.color),
            style,
        );
        cx.paint_quad(quad);
        return;
    }
    let px_per = pixels(cx);
    if o.style == BorderStyle::Solid {
        let mut contours = vec![rounded(rect(-d, -d, ow, oh), circular(outer_radii), px_per)];
        let inner = rect(-off, -off, w + 2.0 * off, h + 2.0 * off);
        if inner.size.width.0 > 0.0 && inner.size.height.0 > 0.0 {
            contours.push(rounded(
                inner,
                circular(radii.map(|r| grown(r, off))),
                px_per,
            ));
        }
        cx.fill_contours(&contours, o.color);
        return;
    }
    let half = width / 2.0;
    let line = rounded(
        rect(-d + half, -d + half, ow - width, oh - width),
        circular(radii.map(|r| grown(r, d - half))),
        px_per,
    );
    let contours: Vec<Vec<Pt>> = if o.style == BorderStyle::Dotted {
        shape::dots(&line, 2.0 * width)
            .into_iter()
            .map(|c| shape::circle(c, half, px_per))
            .collect()
    } else {
        shape::dashes(&line, 3.0 * width, 3.0 * width)
            .iter()
            .map(|dash| shape::thick(dash, width))
            .collect()
    };
    cx.fill_contours(&contours, o.color);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-3
    }

    #[test]
    fn back_faces() {
        let turned = |deg: f32| {
            Mat4::new()
                .translate(50.0, 50.0)
                .perspective(800.0)
                .rotate_y(deg)
                .translate(-50.0, -50.0)
        };
        assert!(!faces_away(&turned(0.0)));
        assert!(!faces_away(&turned(60.0)));
        assert!(faces_away(&turned(120.0)));
        assert!(faces_away(&turned(180.0)));
        assert!(!faces_away(&turned(300.0)));
        assert!(!faces_away(&Mat4::new().scale(-1.0, 1.0)));
        assert!(faces_away(&Mat4::new().rotate_x(180.0)));
        assert!(close(det4(&Mat4::new().scale(2.0, 3.0).m), 6.0));
    }

    #[test]
    fn faded_scales_alpha() {
        assert_eq!(faded(Color(0x1020_30ff), 0.5).0, 0x1020_3080);
        assert_eq!(faded(Color(0x1020_30ff), 2.0).0, 0x1020_30ff);
        assert_eq!(with_alpha(Color(0x1020_30ff), 0.0).0, 0x1020_3000);
    }

    #[test]
    fn color_matrices() {
        let gray = Filter::Grayscale(1.0).color_matrix().unwrap();
        let c = apply_color_matrix(&gray, [1.0, 0.0, 0.0, 1.0]);
        assert!(close(c[0], c[1]) && close(c[1], c[2]) && close(c[3], 1.0));
        assert!(desaturates(&gray));
        assert!(!desaturates(
            &Filter::Grayscale(0.5).color_matrix().unwrap()
        ));
        assert!(is_identity(
            &Filter::Brightness(1.0).color_matrix().unwrap()
        ));
        assert!(!is_identity(&gray));
        // Brightness 0.5, then opacity 0.5.
        let m = compose_color_matrices(
            &Filter::Brightness(0.5).color_matrix().unwrap(),
            &Filter::Opacity(0.5).color_matrix().unwrap(),
        );
        let c = apply_color_matrix(&m, [1.0, 0.5, 0.0, 1.0]);
        assert!(close(c[0], 0.5) && close(c[1], 0.25) && close(c[3], 0.5));
        // Order matters: invert then brightness 0 is black, brightness 0
        // then invert is white.
        let inv = Filter::Invert(1.0).color_matrix().unwrap();
        let dark = Filter::Brightness(0.0).color_matrix().unwrap();
        let c = apply_color_matrix(&compose_color_matrices(&inv, &dark), [0.2, 0.2, 0.2, 1.0]);
        assert!(close(c[0], 0.0));
        let c = apply_color_matrix(&compose_color_matrices(&dark, &inv), [0.2, 0.2, 0.2, 1.0]);
        assert!(close(c[0], 1.0));
    }

    #[test]
    fn shadow_layers_add_up() {
        let (grow, a) = shadow_layers(4.0, 0.5);
        assert_eq!(grow.len(), SHADOW_LAYERS);
        // Symmetric around the shape's edge, over three deviations.
        assert!(close(grow[0], -grow[SHADOW_LAYERS - 1]));
        assert!(grow[SHADOW_LAYERS - 1] < 6.0);
        // All layers over each other give the shadow's alpha.
        assert!(close(1.0 - (1.0 - a).powi(SHADOW_LAYERS as i32), 0.5));
        assert_eq!(shadow_layers(0.0, 0.5), (vec![0.0], 0.5));
    }

    #[test]
    fn silhouettes_fake_a_blur() {
        let (offsets, a) = silhouette_offsets(0.2, 0.1);
        assert_eq!(offsets, [(0.0, 0.0)]);
        assert!(close(a(0.5), 0.5));
        let (offsets, a) = silhouette_offsets(8.0, 4.0);
        assert_eq!(offsets.len(), 25);
        assert!(offsets.iter().all(|p| p.0.hypot(p.1) <= 2.4 + 1e-3));
        let n = offsets.len() as i32;
        assert!(close(1.0 - (1.0 - a(0.9)).powi(n), 0.9));
    }

    #[test]
    fn shared_border_colors() {
        let mut b = Borders {
            widths: [1.0, 2.0, 0.0, 1.0].map(nsh_core::Points).into(),
            colors: [Color::BLACK; 4],
            style: BorderStyle::Solid,
        };
        assert_eq!(shared_color(&b), Some(Color::BLACK));
        // A side without width does not count.
        b.colors[2] = Color(0xff00_00ff);
        assert_eq!(shared_color(&b), Some(Color::BLACK));
        b.colors[1] = Color(0xff00_00ff);
        assert_eq!(shared_color(&b), None);
    }
}
