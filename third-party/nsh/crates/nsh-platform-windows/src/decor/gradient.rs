//! Gradient backgrounds: CSS's linear, radial and conic gradients (and
//! their repeating forms) as Direct2D brushes.
//!
//! Linear and radial gradients are Direct2D gradient brushes; their stop
//! collections interpolate premultiplied colors, as CSS does (a fade to
//! `transparent` does not pass through gray). Direct2D's stops lie in
//! `0..=1` along the brush, so stops outside that range are fitted to it
//! ([`fit_stops`]) as the Linux backend does for GSK. Direct2D has no conic
//! gradient: it is drawn into a bitmap once per size and kept in the
//! decoration cache ([`super::cache`]).
//!
//! Drawing allocates nothing of its own on repeated frames: stops are
//! resolved into thread-local buffers, stop collections are kept by their
//! content (the brush that holds one is cheap to make).

use std::{
    cell::RefCell,
    hash::{Hash, Hasher},
};

use nsh_core::{
    Color, Gradient, GradientKind, GradientSize,
    geometry::{Percentage, Points, Radians, Size, deg},
};
use rustc_hash::{FxHashMap, FxHasher};
use windows::{
    Win32::Graphics::{
        Direct2D::{
            Common::{
                D2D_SIZE_U, D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_GRADIENT_STOP, D2D1_PIXEL_FORMAT,
            },
            D2D1_BITMAP_OPTIONS_NONE, D2D1_BITMAP_PROPERTIES1, D2D1_BUFFER_PRECISION_8BPC_UNORM,
            D2D1_COLOR_INTERPOLATION_MODE_PREMULTIPLIED, D2D1_COLOR_SPACE_SRGB, D2D1_EXTEND_MODE,
            D2D1_EXTEND_MODE_CLAMP, D2D1_EXTEND_MODE_WRAP, D2D1_LINEAR_GRADIENT_BRUSH_PROPERTIES,
            D2D1_RADIAL_GRADIENT_BRUSH_PROPERTIES, ID2D1Brush, ID2D1GradientStopCollection1,
        },
        Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
    },
    core::Interface,
};
use windows_numerics::Vector2;

use super::cache::{self, Baked};
use crate::render::{DrawCx, color_f};

/// Reused buffers: resolved stops, the tiles of a repeating gradient, the
/// stops fitted to `0..=1`, and Direct2D's.
struct Stops {
    typed: Vec<(Color, Percentage)>,
    resolved: Vec<(Color, f32)>,
    tiled: Vec<(Color, f32)>,
    fitted: Vec<(Color, f32)>,
    d2d: Vec<D2D1_GRADIENT_STOP>,
}

/// Stop collections by content, made again when the device is.
struct Collections {
    generation: u64,
    map: FxHashMap<u64, ID2D1GradientStopCollection1>,
}

/// Most stop collections kept: a screen shows a few dozen gradients.
const MAX_COLLECTIONS: usize = 256;

thread_local! {
    static STOPS: RefCell<Stops> = const {
        RefCell::new(Stops {
            typed: Vec::new(),
            resolved: Vec::new(),
            tiled: Vec::new(),
            fitted: Vec::new(),
            d2d: Vec::new(),
        })
    };
    static COLLECTIONS: RefCell<Option<Collections>> = const { RefCell::new(None) };
}

pub(super) fn clear_thread_cache() {
    let _ = COLLECTIONS.try_with(|c| c.borrow_mut().take());
}

/// What the brush of one gradient paints: a Direct2D brush in the view's
/// coordinates, or (conic) a bitmap covering the box.
pub(crate) enum Paint {
    /// A gradient brush.
    Brush(ID2D1Brush),
    /// A bitmap of the `w` x `h` box.
    Bitmap(Baked),
}

/// The paint of gradient `g` over a `w` x `h` box, or `None` when it
/// draws nothing (fewer than two stops, an empty box, a device error).
pub(crate) fn paint(cx: &DrawCx<'_>, g: &Gradient, w: f32, h: f32) -> Option<Paint> {
    if g.stops.len() < 2 || w <= 0.0 || h <= 0.0 {
        return None;
    }
    STOPS.with(|stops| {
        let mut stops = stops.try_borrow_mut().ok()?;
        let Stops {
            typed,
            resolved,
            tiled,
            fitted,
            d2d,
        } = &mut *stops;
        let size = Size::new(Points(w), Points(h));
        g.resolve_stops(size, typed);
        resolved.clear();
        resolved.extend(typed.iter().map(|&(c, p)| (c, p.0)));
        let first = resolved[0].1;
        let last = resolved[resolved.len() - 1].1;
        let repeating = g.repeating && last - first > 1e-4;
        match g.kind {
            GradientKind::Radial {
                circle,
                size: shape,
                x,
                y,
            } => {
                let (cx0, cy0) = (x.0 * w, y.0 * h);
                let (rx, ry) = radial_radii(circle, shape, cx0, cy0, w, h);
                let (rx, ry, extend) = if repeating {
                    // One period (`first..last` of the radii) becomes the
                    // brush's `0..1`, the stops tiled into it so that its
                    // wrap starts at the center in phase.
                    let period = last - first;
                    let scaled: &mut Vec<(Color, f32)> = fitted;
                    scaled.clear();
                    scaled.extend(resolved.iter().map(|&(c, p)| (c, p / period)));
                    tile_stops(scaled, tiled);
                    fit_stops(tiled, 0.0, 1.0, scaled);
                    (rx * period, ry * period, D2D1_EXTEND_MODE_WRAP)
                } else {
                    // The ending shape is scaled to cover the last stop.
                    let hi = last.max(1.0);
                    fit_stops(resolved, 0.0, hi, fitted);
                    (rx * hi, ry * hi, D2D1_EXTEND_MODE_CLAMP)
                };
                let collection = collection(cx, fitted, extend, d2d)?;
                let props = D2D1_RADIAL_GRADIENT_BRUSH_PROPERTIES {
                    center: Vector2 { X: cx0, Y: cy0 },
                    gradientOriginOffset: Vector2 { X: 0.0, Y: 0.0 },
                    radiusX: rx.max(0.01),
                    radiusY: ry.max(0.01),
                };
                // SAFETY: COM calls on the live context with valid
                // properties.
                let brush = unsafe { cx.dc.CreateRadialGradientBrush(&props, None, &collection) };
                brush.ok()?.cast().ok().map(Paint::Brush)
            }
            GradientKind::Conic { .. } => conic(cx, g, w, h).map(Paint::Bitmap),
            kind => {
                let angle = kind.linear_angle(size).unwrap_or(deg(180.0));
                let (a, b) = linear_line(angle, w, h);
                // The line is stretched to cover stops outside `0..=1`
                // (and, repeating, cut to one period, which the brush
                // wraps).
                let (lo, hi) = if repeating {
                    (first, last)
                } else {
                    (first.min(0.0), last.max(1.0))
                };
                fit_stops(resolved, lo, hi, fitted);
                let extend = if repeating {
                    D2D1_EXTEND_MODE_WRAP
                } else {
                    D2D1_EXTEND_MODE_CLAMP
                };
                let collection = collection(cx, fitted, extend, d2d)?;
                let at = |t: f32| Vector2 {
                    X: a.0 + (b.0 - a.0) * t,
                    Y: a.1 + (b.1 - a.1) * t,
                };
                let props = D2D1_LINEAR_GRADIENT_BRUSH_PROPERTIES {
                    startPoint: at(lo),
                    endPoint: at(hi),
                };
                // SAFETY: as above.
                let brush = unsafe { cx.dc.CreateLinearGradientBrush(&props, None, &collection) };
                brush.ok()?.cast().ok().map(Paint::Brush)
            }
        }
    })
}

/// The stop collection of `stops` (fitted to `0..=1`), kept by content.
fn collection(
    cx: &DrawCx<'_>,
    stops: &[(Color, f32)],
    extend: D2D1_EXTEND_MODE,
    d2d: &mut Vec<D2D1_GRADIENT_STOP>,
) -> Option<ID2D1GradientStopCollection1> {
    let mut hasher = FxHasher::default();
    hasher.write_i32(extend.0);
    for &(c, p) in stops {
        hasher.write_u32(c.0);
        hasher.write_u32(p.to_bits());
    }
    let key = hasher.finish();
    let generation = crate::gfx::generation();
    COLLECTIONS.with(|cell| {
        let mut cell = cell.borrow_mut();
        let cols = cell.get_or_insert_with(|| Collections {
            generation,
            map: FxHashMap::default(),
        });
        if cols.generation != generation {
            cols.map.clear();
            cols.generation = generation;
        }
        if let Some(c) = cols.map.get(&key) {
            return Some(c.clone());
        }
        d2d.clear();
        d2d.extend(stops.iter().map(|&(c, p)| D2D1_GRADIENT_STOP {
            position: p,
            color: color_f(c),
        }));
        // SAFETY: a COM call on the live context with a valid stop list.
        let made = unsafe {
            cx.dc.CreateGradientStopCollection(
                d2d,
                D2D1_COLOR_SPACE_SRGB,
                D2D1_COLOR_SPACE_SRGB,
                D2D1_BUFFER_PRECISION_8BPC_UNORM,
                extend,
                D2D1_COLOR_INTERPOLATION_MODE_PREMULTIPLIED,
            )
        }
        .map_err(|err| log::debug!("decor: gradient stops not made: {err}"))
        .ok()?;
        if cols.map.len() >= MAX_COLLECTIONS {
            cols.map.clear();
        }
        cols.map.insert(key, made.clone());
        Some(made)
    })
}

/// Most pixels along a side of a conic gradient's bitmap: larger boxes
/// stretch it (a conic gradient has no detail finer than its stops).
const MAX_CONIC: f32 = 768.0;

/// A conic gradient drawn into a bitmap covering the `w` x `h` box, kept in
/// the decoration cache.
fn conic(cx: &DrawCx<'_>, g: &Gradient, w: f32, h: f32) -> Option<Baked> {
    let GradientKind::Conic { from, x, y } = g.kind else {
        return None;
    };
    let scale = cx.scale.min(MAX_CONIC / w).min(MAX_CONIC / h).max(0.01);
    let px = (
        (w * scale).ceil().max(1.0) as u32,
        (h * scale).ceil().max(1.0) as u32,
    );
    let mut hasher = FxHasher::default();
    hasher.write_u8(b'c');
    hasher.write_u32(from.0.to_bits());
    hasher.write_u32(x.0.to_bits());
    hasher.write_u32(y.0.to_bits());
    hasher.write_u8(g.repeating as u8);
    for s in &g.stops {
        hasher.write_u32(s.color.0);
        // Conic stops are angles: fractions, never lengths.
        s.position.hash(&mut hasher);
    }
    hasher.write_u32(px.0);
    hasher.write_u32(px.1);
    hasher.write_u32(w.to_bits());
    hasher.write_u32(h.to_bits());
    let key = hasher.finish();
    cache::get_or_make(key, || {
        let resolved: Vec<(Color, f32)> = g
            .resolved_stops(Size::new(Points(w), Points(h)))
            .into_iter()
            .map(|(c, p)| (c, p.0))
            .collect();
        let (first, last) = (resolved[0].1, resolved[resolved.len() - 1].1);
        let mut fitted = Vec::new();
        if g.repeating && last - first > 1e-4 {
            let mut tiled = Vec::new();
            tile_stops(&resolved, &mut tiled);
            fit_stops(&tiled, 0.0, 1.0, &mut fitted);
        } else {
            fit_stops(&resolved, 0.0, 1.0, &mut fitted);
        }
        let premul: Vec<([f32; 4], f32)> =
            fitted.iter().map(|&(c, p)| (premultiplied(c), p)).collect();
        let (cxp, cyp) = (x.0 * w * scale, y.0 * h * scale);
        let mut pixels = vec![0u8; (px.0 * px.1 * 4) as usize];
        for row in 0..px.1 {
            for col in 0..px.0 {
                let (dx, dy) = (col as f32 + 0.5 - cxp, row as f32 + 0.5 - cyp);
                let t = conic_t(dx, dy, from.to_degrees());
                let c = sample(&premul, t);
                let i = ((row * px.0 + col) * 4) as usize;
                // BGRA, premultiplied.
                pixels[i] = (c[2] * 255.0).round() as u8;
                pixels[i + 1] = (c[1] * 255.0).round() as u8;
                pixels[i + 2] = (c[0] * 255.0).round() as u8;
                pixels[i + 3] = (c[3] * 255.0).round() as u8;
            }
        }
        let props = D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
            },
            // The bitmap's DIPs are the box's points.
            dpiX: 96.0 * px.0 as f32 / w,
            dpiY: 96.0 * px.1 as f32 / h,
            bitmapOptions: D2D1_BITMAP_OPTIONS_NONE,
            colorContext: std::mem::ManuallyDrop::new(None),
        };
        // SAFETY: the pixel buffer holds `px.1` rows of `px.0 * 4` bytes.
        let bitmap = unsafe {
            cx.dc.CreateBitmap(
                D2D_SIZE_U {
                    width: px.0,
                    height: px.1,
                },
                Some(pixels.as_ptr().cast()),
                px.0 * 4,
                &props,
            )
        }
        .map_err(|err| log::debug!("decor: conic gradient not made: {err}"))
        .ok()?;
        Some(Baked {
            bitmap,
            x: 0.0,
            y: 0.0,
            width: w,
            height: h,
        })
    })
}

/// Where a conic gradient is at offset `(dx, dy)` from its center
/// (`0..1`, a turn clockwise from `from` degrees, 0 pointing up).
fn conic_t(dx: f32, dy: f32, from: f32) -> f32 {
    let deg = dx.atan2(-dy).to_degrees();
    ((deg - from) / 360.0).rem_euclid(1.0)
}

/// `c` as premultiplied `0..1` channels (r, g, b, a).
fn premultiplied(c: Color) -> [f32; 4] {
    let (r, g, b, a) = c.to_f64();
    let a = a as f32;
    [r as f32 * a, g as f32 * a, b as f32 * a, a]
}

/// The color of sorted premultiplied stops at `t`.
fn sample(stops: &[([f32; 4], f32)], t: f32) -> [f32; 4] {
    let Some(&(first, p0)) = stops.first() else {
        return [0.0; 4];
    };
    if t <= p0 {
        return first;
    }
    for pair in stops.windows(2) {
        let ((a, pa), (b, pb)) = (pair[0], pair[1]);
        if t <= pb {
            let k = if pb - pa > 1e-6 {
                (t - pa) / (pb - pa)
            } else {
                1.0
            };
            return std::array::from_fn(|i| a[i] + (b[i] - a[i]) * k);
        }
    }
    stops[stops.len() - 1].0
}

/// The color between `a` and `b` at `t` (premultiplied, as Direct2D
/// interpolates the stops).
fn mix(a: Color, b: Color, t: f32) -> Color {
    let (pa, pb) = (premultiplied(a), premultiplied(b));
    let p: [f32; 4] = std::array::from_fn(|i| pa[i] + (pb[i] - pa[i]) * t);
    let alpha = p[3];
    let ch = |v: f32| {
        let straight = if alpha > 0.0 { v / alpha } else { 0.0 };
        (straight * 255.0).round().clamp(0.0, 255.0) as u32
    };
    let a8 = (alpha * 255.0).round().clamp(0.0, 255.0) as u32;
    Color((ch(p[0]) << 24) | (ch(p[1]) << 16) | (ch(p[2]) << 8) | a8)
}

/// Maps the stops' range `lo..hi` onto `0..=1`, cutting stops outside it
/// (with the colors interpolated at the cuts); at least two stops come
/// out.
pub(super) fn fit_stops(stops: &[(Color, f32)], lo: f32, hi: f32, out: &mut Vec<(Color, f32)>) {
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

/// Most stops a repeating gradient is unrolled to.
const MAX_TILED: usize = 512;

/// Repeats the stops' period over `0..=1`, from a period before it (for
/// [`fit_stops`] to cut).
pub(super) fn tile_stops(stops: &[(Color, f32)], out: &mut Vec<(Color, f32)>) {
    out.clear();
    let (first, last) = (stops[0].1, stops[stops.len() - 1].1);
    let period = last - first;
    if period <= 1e-6 {
        out.extend_from_slice(stops);
        return;
    }
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
/// clockwise) through the center of a `w` x `h` box: long enough that the
/// corners get the end colors.
pub(super) fn linear_line(angle: Radians, w: f32, h: f32) -> ((f32, f32), (f32, f32)) {
    let (s, c) = angle.sin_cos();
    let len = (w * s).abs() + (h * c).abs();
    let (dx, dy) = (s * len / 2.0, -c * len / 2.0);
    let (cx, cy) = (w / 2.0, h / 2.0);
    ((cx - dx, cy - dy), (cx + dx, cy + dy))
}

/// The horizontal and vertical radii of a radial gradient's ending shape
/// centered at `(cx, cy)` in a `w` x `h` box.
pub(super) fn radial_radii(
    circle: bool,
    size: GradientSize,
    cx: f32,
    cy: f32,
    w: f32,
    h: f32,
) -> (f32, f32) {
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
    fn corner_angles_follow_the_box() {
        // `to top right` of a square is 45°, of a wide box steeper.
        let k = GradientKind::LinearCorner {
            right: true,
            bottom: false,
        };
        let angle = |w: f32, h: f32| {
            k.linear_angle(Size::new(Points(w), Points(h)))
                .unwrap()
                .to_degrees()
        };
        assert!(close(angle(100.0, 100.0), 45.0));
        assert!(angle(200.0, 100.0) > 45.0);
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
    fn mixing_is_premultiplied() {
        // Halfway to transparent keeps the hue at half alpha.
        let c = mix(RED, Color::TRANSPARENT, 0.5);
        assert_eq!(c.0 >> 8, 0xff_0000);
        assert!(((c.0 & 0xff) as i32 - 128).abs() <= 1);
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
    fn conic_angles_turn_clockwise_from_the_top() {
        assert!(close(conic_t(0.0, -1.0, 0.0), 0.0));
        assert!(close(conic_t(1.0, 0.0, 0.0), 0.25));
        assert!(close(conic_t(0.0, 1.0, 0.0), 0.5));
        assert!(close(conic_t(-1.0, 0.0, 0.0), 0.75));
        // `from 90deg` starts on the right.
        assert!(close(conic_t(1.0, 0.0, 90.0), 0.0));
    }

    #[test]
    fn samples_interpolate() {
        let stops = [([1.0, 0.0, 0.0, 1.0], 0.0), ([0.0, 0.0, 1.0, 1.0], 1.0)];
        let mid = sample(&stops, 0.5);
        assert!(close(mid[0], 0.5) && close(mid[2], 0.5) && close(mid[3], 1.0));
        assert_eq!(sample(&stops, -1.0), stops[0].0);
        assert_eq!(sample(&stops, 2.0), stops[1].0);
    }
}
