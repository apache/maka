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
//! copy would force an offscreen pass over the whole window); the
//! background color still draws, so frosted bars stay readable.
//! `borderCurve: "continuous"` draws circular corners, matching the clip of
//! the children. Android's `elevation` is Android only.
//!
//! Drawing allocates nothing of its own: gradient stops are resolved into
//! thread-local buffers reused across draws. Dashed borders build a GSK path
//! (GSK allocates it).

use std::cell::RefCell;

use gtk4::{self as gtk, gdk, graphene, gsk, prelude::*};
use nsh_core::{
    BorderStyle, Color, Filter, Gradient, GradientKind, GradientSize,
    geometry::{Percentage, Points, Radians, Size, deg},
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
pub(crate) fn draw_background(snapshot: &gtk::Snapshot, state: &ViewState, soft: bool) {
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    if w <= 0.0 || h <= 0.0 {
        return;
    }
    let rect = graphene::Rect::new(0.0, 0.0, w, h);
    let radii = state.radii();
    let outline = rounded(rect, radii);
    let effects = state.style.effects.as_deref();

    if let Some(e) = effects {
        // CSS lists the top layer first.
        for b in e.box_shadows.iter().rev() {
            if !b.inset && b.is_visible() {
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
        if round {
            snapshot.push_rounded_clip(&outline);
        }
        if !bg.is_transparent() {
            snapshot.append_color(&rgba(bg), &rect);
        }
        for g in gradients.iter().rev() {
            draw_gradient(snapshot, g, w, h);
        }
        if round {
            snapshot.pop();
        }
    }

    if let Some(e) = effects
        && e.box_shadows.iter().any(|b| b.inset && b.is_visible())
    {
        let padding = padding_box(
            w,
            h,
            radii,
            state.style.borders.widths.to_array().map(|w| w.0),
        );
        for b in e.box_shadows.iter().rev() {
            if b.inset && b.is_visible() {
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
        if o.style == BorderStyle::Solid {
            let c = rgba(o.color);
            let outer = rounded(rect, radii.map(|r| grown(r, d)));
            snapshot.append_border(&outer, &[width; 4], &[c, c, c, c]);
        } else {
            let half = width / 2.0;
            let line = rounded(
                graphene::Rect::new(-d + half, -d + half, ow - width, oh - width),
                radii.map(|r| grown(r, d - half)),
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

/// The view's borders along `outline` (its rounded bounds).
fn draw_borders(snapshot: &gtk::Snapshot, state: &ViewState, outline: &gsk::RoundedRect) {
    let b = &state.borders();
    if !b.is_visible() {
        return;
    }
    if b.style == BorderStyle::Solid {
        snapshot.append_border(
            outline,
            &b.widths.to_array().map(|w| w.0),
            &b.colors.map(rgba),
        );
        return;
    }
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    let radii = state.radii();
    let line = |bw: f32| {
        let half = bw / 2.0;
        rounded(
            graphene::Rect::new(half, half, (w - bw).max(0.0), (h - bw).max(0.0)),
            radii.map(|r| (r - half).max(0.0)),
        )
    };
    if let Some((bw, c)) = b.uniform() {
        let bw = bw.0;
        stroke(snapshot, &line(bw), bw, b.style, &rgba(c));
        return;
    }
    // Sides that differ: the whole outline stroked with each side's width
    // and color, clipped to that side's trapezoid (corners split at 45°).
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
        stroke(snapshot, &line(bw), bw, b.style, &rgba(c));
        snapshot.pop();
    }
}

/// Strokes `line`, `width` wide, dashed or dotted as `style` says.
fn stroke(
    snapshot: &gtk::Snapshot,
    line: &gsk::RoundedRect,
    width: f32,
    style: BorderStyle,
    color: &gdk::RGBA,
) {
    let p = gsk::PathBuilder::new();
    p.add_rounded_rect(line);
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
    snapshot.append_stroke(&p.to_path(), &s, color);
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
mod tests {
    use super::*;

    const RED: Color = Color(0xff00_00ff);
    const BLUE: Color = Color(0x0000_ffff);

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-3
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
