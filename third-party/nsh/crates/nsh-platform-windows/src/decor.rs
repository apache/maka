//! View decoration: shadows, backgrounds, gradients, borders, outlines,
//! filters, blend modes and backdrop filters, drawn with Direct2D.
//!
//! Order, bottom to top (CSS painting order): the backdrop filter, outer
//! shadows (`boxShadow` layers, last first), the background color, gradients (last first), inset shadows (inside the
//! padding box), the content and children ([`crate::render`]), the border
//! and the outline. The border is drawn over the children, as UIKit draws
//! layer borders: the core places content inside the border, so only
//! overflowing children reach under it.
//!
//! Blurred shadows are drawn once into bitmaps kept by what they look like
//! ([`cache`]): redrawing a view, or another view with the same shadow,
//! does not blur again. Filters and `mixBlendMode` draw the view's
//! subtree offscreen first and composite it through Direct2D effects
//! ([`layer`]). `mixBlendMode` and `backdropFilter` read
//! what the window drew behind the view ([`layer::backdrop`]); inside a view
//! drawn offscreen (filtered or 3D-transformed) the blend is normal and the
//! backdrop unfiltered.
//!
//! `borderCurve: "continuous"` draws circular corners, matching the clip of
//! the children. Android's `elevation` is Android only.

mod cache;
mod gradient;
pub(crate) mod layer;

use std::{cell::RefCell, hash::Hasher};

use nsh_core::{BorderStyle, Borders, Bounds, Color, Outline, Points};
use rustc_hash::FxHasher;
use windows::{
    Win32::Graphics::{
        Direct2D::{
            Common::{
                D2D_SIZE_F, D2D_SIZE_U, D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_COMPOSITE_MODE,
                D2D1_COMPOSITE_MODE_DESTINATION_IN, D2D1_COMPOSITE_MODE_DESTINATION_OUT,
                D2D1_COMPOSITE_MODE_SOURCE_OVER, D2D1_FIGURE_BEGIN_FILLED, D2D1_FIGURE_END_CLOSED,
                D2D1_FILL_MODE_ALTERNATE, D2D1_PIXEL_FORMAT,
            },
            D2D1_ARC_SEGMENT, D2D1_ARC_SIZE_SMALL, D2D1_BITMAP_OPTIONS_TARGET,
            D2D1_BITMAP_PROPERTIES1, D2D1_CAP_STYLE_FLAT, D2D1_CAP_STYLE_ROUND,
            D2D1_DASH_STYLE_CUSTOM, D2D1_INTERPOLATION_MODE_LINEAR, D2D1_LINE_JOIN_MITER,
            D2D1_LINE_JOIN_ROUND, D2D1_ROUNDED_RECT, D2D1_STROKE_STYLE_PROPERTIES,
            D2D1_SWEEP_DIRECTION_CLOCKWISE, ID2D1Brush, ID2D1CommandList, ID2D1DeviceContext,
            ID2D1Factory, ID2D1Geometry, ID2D1GeometrySink, ID2D1Image, ID2D1StrokeStyle,
        },
        Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
    },
    core::Interface,
};
use windows_numerics::{Matrix3x2, Vector2};

use self::{cache::Baked, gradient::Paint};
use crate::{
    geom::{Mat4, rect},
    gfx::Gfx,
    render::{DrawCx, color_f, rect_f},
    view::{NshView, ViewState},
};

/// True if `backfaceVisibility: "hidden"` hides the view: with `world`
/// (its full transform to the window) its front faces away from the
/// viewer.
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

/// How far the view's own decoration reaches out of its bounds (points):
/// shadows, the outline, filters.
pub(crate) fn outset(state: &ViewState) -> f32 {
    let mut o: f32 = 0.0;
    let outline = state.style.outline;
    if outline.is_visible() {
        o = o.max((outline.offset + outline.width).0);
    }
    if let Some(e) = &state.style.effects {
        for b in e.box_shadows.iter().filter(|b| !b.inset && b.is_visible()) {
            o = o.max(
                b.offset_x.0.abs().max(b.offset_y.0.abs()) + b.spread.0 + 1.5 * b.blur.0.max(0.0),
            );
        }
        o += layer::filters_outset(&e.filters);
    }
    o.ceil()
}

/// True if the view is drawn offscreen and composited as one image
/// ([`draw_layered`]): it has filters or a blend mode.
pub(crate) fn layered(state: &ViewState) -> bool {
    state.style.blend_mode != nsh_core::BlendMode::Normal
        || state
            .style
            .effects
            .as_ref()
            .is_some_and(|e| layer::filters_visible(&e.filters))
}

/// Draws `view` (at `world`, set on the context) offscreen, then through
/// its filters and its blend mode.
pub(crate) fn draw_layered(cx: &mut DrawCx<'_>, view: &NshView, world: Mat4) {
    let Some(list) = layer::record(cx, |inner| {
        inner.set_transform(world);
        crate::render::draw_content(inner, view, world);
    }) else {
        return;
    };
    let state = view.state();
    let lin = layer::linear(&world);
    let filters = state
        .style
        .effects
        .as_ref()
        .map_or(&[][..], |e| &e.filters[..]);
    let image = (|| -> windows::core::Result<ID2D1Image> {
        let mut image = layer::apply_filters(cx.dc, list.cast()?, filters, &lin, false)?;
        if let Some(mode) = layer::blend_mode(state.style.blend_mode)
            && cx.backdrop
        {
            let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
            let area = state.overflow.unwrap_or(rect(0.0, 0.0, w, h));
            let o = layer::filters_outset(filters);
            let bounds = world.bounds(
                area.origin.x.0 - o,
                area.origin.y.0 - o,
                area.size.width.0 + 2.0 * o,
                area.size.height.0 + 2.0 * o,
            );
            if let Some((x, y, bw, bh)) = bounds
                && let Some((back, bx, by)) = layer::backdrop(cx, x, y, bw, bh)
            {
                let placed = layer::transformed(cx.dc, &back, &Matrix3x2::translation(bx, by))?;
                image = layer::blend(cx.dc, &placed, &image, mode)?;
            }
        }
        Ok(image)
    })();
    drop(state);
    match image {
        Ok(image) => {
            // SAFETY: COM calls on the live context; the image is in window
            // coordinates.
            unsafe {
                cx.dc.SetTransform(&Matrix3x2::identity());
                cx.dc.DrawImage(
                    &image,
                    None,
                    None,
                    D2D1_INTERPOLATION_MODE_LINEAR,
                    D2D1_COMPOSITE_MODE_SOURCE_OVER,
                );
            }
        }
        Err(err) => log::debug!("decor: filters not applied: {err}"),
    }
    cx.set_transform(world);
}

/// Draws the view's backdrop filter: what the window drew behind it,
/// filtered, inside its rounded bounds.
pub(crate) fn draw_backdrop(cx: &mut DrawCx<'_>, state: &ViewState) {
    if !cx.backdrop {
        return;
    }
    let Some(e) = state.style.effects.as_deref() else {
        return;
    };
    if !layer::filters_visible(&e.backdrop_filters) {
        return;
    }
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    if w <= 0.0 || h <= 0.0 {
        return;
    }
    let world = cx.transform;
    let lin = layer::linear(&world);
    // What lies around the bounds blurs into them.
    let o = layer::filters_outset(&e.backdrop_filters) * layer::length_scale(&lin);
    let Some((x, y, bw, bh)) = world.bounds(0.0, 0.0, w, h) else {
        return;
    };
    let Some((back, bx, by)) = layer::backdrop(cx, x - o, y - o, bw + 2.0 * o, bh + 2.0 * o) else {
        return;
    };
    let image = match layer::apply_filters(cx.dc, back, &e.backdrop_filters, &lin, true) {
        Ok(image) => image,
        Err(err) => {
            log::debug!("decor: backdrop filter not applied: {err}");
            return;
        }
    };
    cx.push_clip_rounded(rect(0.0, 0.0, w, h), state.radii());
    // SAFETY: COM calls on the live context; the image is in window
    // coordinates, offset to where it was copied from.
    unsafe {
        cx.dc.SetTransform(&Matrix3x2::identity());
        cx.dc.DrawImage(
            &image,
            Some(&Vector2 { X: bx, Y: by }),
            None,
            D2D1_INTERPOLATION_MODE_LINEAR,
            D2D1_COMPOSITE_MODE_SOURCE_OVER,
        );
    }
    cx.set_transform(world);
    cx.pop();
}

/// Draws the view's shadows, background color, gradients and inset
/// shadows, under its content.
pub(crate) fn draw_background(cx: &mut DrawCx<'_>, state: &ViewState) {
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    if w <= 0.0 || h <= 0.0 {
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
                    blur: b.blur.0.max(0.0),
                    color: b.color,
                    cut: true,
                };
                outer_shadow(cx, w, h, radii, &spec);
            }
        }
    }

    let bg = state.background();
    let gradients = effects.map_or(&[][..], |e| &e.background_images[..]);
    if !bg.is_transparent() || !gradients.is_empty() {
        let shape = BoxShape::new(cx, w, h, radii);
        if !bg.is_transparent() {
            shape.fill(cx, cx.solid(bg));
        }
        for g in gradients.iter().rev() {
            match gradient::paint(cx, g, w, h) {
                Some(Paint::Brush(brush)) => shape.fill(cx, &brush),
                Some(Paint::Bitmap(baked)) => {
                    let clip = shape.geometry.is_some();
                    if let Some(g) = &shape.geometry {
                        cx.push_clip_geometry(g);
                    }
                    draw_baked(cx, &baked);
                    if clip {
                        cx.pop();
                    }
                }
                None => {}
            }
        }
    }

    if let Some(e) = effects {
        let widths = state.style.borders.widths.to_array().map(|w| w.0);
        for b in e.box_shadows.iter().rev() {
            if b.inset && b.is_visible() {
                let spec = ShadowSpec {
                    dx: b.offset_x.0,
                    dy: b.offset_y.0,
                    spread: b.spread.0,
                    blur: b.blur.0.max(0.0),
                    color: b.color,
                    cut: true,
                };
                inset_shadow(cx, w, h, radii, widths, &spec);
            }
        }
    }
}

/// The view's rounded box, filled the cheapest way its corners allow.
struct BoxShape {
    w: f32,
    h: f32,
    radii: [f32; 4],
    /// The rounded outline when the corners differ.
    geometry: Option<ID2D1Geometry>,
}

impl BoxShape {
    fn new(cx: &DrawCx<'_>, w: f32, h: f32, radii: [f32; 4]) -> BoxShape {
        let round = radii.iter().any(|&r| r > 0.0);
        let geometry = round
            .then(|| cx.rounded_geometry(rect(0.0, 0.0, w, h), radii))
            .flatten();
        BoxShape {
            w,
            h,
            radii,
            geometry,
        }
    }

    fn fill<B: windows::core::Param<ID2D1Brush>>(&self, cx: &DrawCx<'_>, brush: B) {
        let uniform = self.radii.iter().all(|&r| r == self.radii[0]);
        // SAFETY: COM calls between BeginDraw and EndDraw.
        unsafe {
            if self.radii[0] <= 0.0 && uniform {
                cx.dc
                    .FillRectangle(&rect_f(0.0, 0.0, self.w, self.h), brush);
            } else if uniform {
                let rr = D2D1_ROUNDED_RECT {
                    rect: rect_f(0.0, 0.0, self.w, self.h),
                    radiusX: self.radii[0],
                    radiusY: self.radii[0],
                };
                cx.dc.FillRoundedRectangle(&rr, brush);
            } else if let Some(g) = &self.geometry {
                cx.dc.FillGeometry(g, brush, None);
            }
        }
    }
}

/// Draws a decoration bitmap where it goes (view coordinates).
fn draw_baked(cx: &DrawCx<'_>, b: &Baked) {
    // SAFETY: a COM call between BeginDraw and EndDraw.
    unsafe {
        cx.dc.DrawBitmap(
            &b.bitmap,
            Some(&rect_f(b.x, b.y, b.width, b.height)),
            1.0,
            D2D1_INTERPOLATION_MODE_LINEAR,
            None,
            None,
        );
    }
}

/// One shadow: a `boxShadow` layer.
#[derive(Debug, Clone, Copy, PartialEq)]
struct ShadowSpec {
    dx: f32,
    dy: f32,
    /// How far the shape grows (negative: shrinks).
    spread: f32,
    /// CSS blur: twice the Gaussian's deviation.
    blur: f32,
    color: Color,
    /// Cut out of the box (outer CSS shadows): a translucent fill does not
    /// show it.
    cut: bool,
}

/// Most pixels along a side of a shadow bitmap; larger shadows are drawn
/// at a lower resolution (a blur has no fine detail to lose).
const MAX_BAKE: f32 = 4096.0;

/// The cache key of a shadow of kind `kind` (`b'o'` outer, `b'i'` inset)
/// on a `w` x `h` box: everything its bitmap depends on.
fn shadow_key(
    kind: u8,
    w: f32,
    h: f32,
    radii: [f32; 4],
    widths: [f32; 4],
    spec: &ShadowSpec,
    scale: f32,
) -> u64 {
    let mut hasher = FxHasher::default();
    hasher.write_u8(kind);
    for v in [w, h, spec.dx, spec.dy, spec.spread, spec.blur, scale]
        .into_iter()
        .chain(radii)
        .chain(widths)
    {
        hasher.write_u32(v.to_bits());
    }
    hasher.write_u32(spec.color.0);
    hasher.write_u8(spec.cut as u8);
    hasher.finish()
}

/// `r` snapped outwards to whole pixels at `scale`.
fn snapped(r: Bounds<Points>, scale: f32) -> Bounds<Points> {
    let x0 = (r.origin.x.0 * scale).floor() / scale;
    let y0 = (r.origin.y.0 * scale).floor() / scale;
    let x1 = ((r.origin.x.0 + r.size.width.0) * scale).ceil() / scale;
    let y1 = ((r.origin.y.0 + r.size.height.0) * scale).ceil() / scale;
    rect(x0, y0, x1 - x0, y1 - y0)
}

/// The scale a bitmap of `r` is drawn at: the window's, less when it would
/// exceed [`MAX_BAKE`] pixels.
fn bake_scale(r: Bounds<Points>, scale: f32) -> f32 {
    scale
        .min(MAX_BAKE / r.size.width.0.max(1.0))
        .min(MAX_BAKE / r.size.height.0.max(1.0))
}

/// Draws an outer shadow of the `w` x `h` box with `radii`.
fn outer_shadow(cx: &DrawCx<'_>, w: f32, h: f32, radii: [f32; 4], spec: &ShadowSpec) {
    let s = spec.spread;
    let shape = rect(spec.dx - s, spec.dy - s, w + 2.0 * s, h + 2.0 * s);
    if shape.size.width.0 <= 0.0 || shape.size.height.0 <= 0.0 {
        return;
    }
    let sigma = spec.blur / 2.0;
    let e = (3.0 * sigma).ceil();
    let region = rect(
        shape.origin.x.0 - e,
        shape.origin.y.0 - e,
        shape.size.width.0 + 2.0 * e,
        shape.size.height.0 + 2.0 * e,
    );
    let scale = bake_scale(region, cx.scale);
    let region = snapped(region, scale);
    let key = shadow_key(b'o', w, h, radii, [0.0; 4], spec, scale);
    let gfx = cx.gfx;
    let baked = cache::get_or_make(key, || {
        let shape_radii = radii.map(|r| grown(r, s));
        let shape_geometry = crate::render::rounded_geometry(gfx, shape, shape_radii)?;
        let cut = if spec.cut {
            Some(crate::render::rounded_geometry(
                gfx,
                rect(0.0, 0.0, w, h),
                radii,
            )?)
        } else {
            None
        };
        bake(
            gfx,
            region,
            scale,
            &shape_geometry,
            spec.color,
            sigma,
            cut.as_ref(),
            D2D1_COMPOSITE_MODE_DESTINATION_OUT,
        )
    });
    if let Some(b) = baked {
        draw_baked(cx, &b);
    }
}

/// Draws an inset shadow of the `w` x `h` box with `radii` and border
/// `widths`: inside the padding box.
fn inset_shadow(
    cx: &DrawCx<'_>,
    w: f32,
    h: f32,
    radii: [f32; 4],
    widths: [f32; 4],
    spec: &ShadowSpec,
) {
    let (padding, corners) = padding_box(w, h, radii, widths);
    if padding.size.width.0 <= 0.0 || padding.size.height.0 <= 0.0 {
        return;
    }
    let sigma = spec.blur / 2.0;
    let scale = bake_scale(padding, cx.scale);
    let region = snapped(padding, scale);
    let key = shadow_key(b'i', w, h, radii, widths, spec, scale);
    let gfx = cx.gfx;
    let baked = cache::get_or_make(key, || {
        let s = spec.spread;
        // The shadow is everything outside the hole: the padding box moved
        // and shrunk by the spread.
        let hole = rect(
            padding.origin.x.0 + spec.dx + s,
            padding.origin.y.0 + spec.dy + s,
            padding.size.width.0 - 2.0 * s,
            padding.size.height.0 - 2.0 * s,
        );
        let hole_corners = corners.map(|(x, y)| ((x - s).max(0.0), (y - s).max(0.0)));
        let reach = 3.0 * sigma + spec.dx.abs() + spec.dy.abs() + s.abs() + 2.0;
        let outside = rect(
            region.origin.x.0 - reach,
            region.origin.y.0 - reach,
            region.size.width.0 + 2.0 * reach,
            region.size.height.0 + 2.0 * reach,
        );
        let mut figures = vec![(outside, [(0.0, 0.0); 4])];
        if hole.size.width.0 > 0.0 && hole.size.height.0 > 0.0 {
            figures.push((hole, hole_corners));
        }
        let paint = path(gfx, &figures)?;
        let clip = path(gfx, &[(padding, corners)])?;
        bake(
            gfx,
            region,
            scale,
            &paint,
            spec.color,
            sigma,
            Some(&clip),
            D2D1_COMPOSITE_MODE_DESTINATION_IN,
        )
    });
    if let Some(b) = baked {
        draw_baked(cx, &b);
    }
}

/// A bitmap of `region` (points, at `scale` pixels per point) holding
/// `shape` filled with `color` and blurred by `sigma`, then composited with
/// `mask` (filled opaque) by `mode`: cut out of it (`DESTINATION_OUT`) or
/// kept inside it (`DESTINATION_IN`).
#[allow(clippy::too_many_arguments)]
fn bake(
    gfx: &Gfx,
    region: Bounds<Points>,
    scale: f32,
    shape: &ID2D1Geometry,
    color: Color,
    sigma: f32,
    mask: Option<&ID2D1Geometry>,
    mode: D2D1_COMPOSITE_MODE,
) -> Option<Baked> {
    let px = (
        (region.size.width.0 * scale).round().max(1.0) as u32,
        (region.size.height.0 * scale).round().max(1.0) as u32,
    );
    layer::with_context(gfx, |dc| {
        let paint = record_fill(dc, scale, shape, color)?;
        let mask = match mask {
            Some(m) => Some(record_fill(dc, scale, m, Color(0xffff_ffff))?),
            None => None,
        };
        // SAFETY: COM calls on the offscreen context and its own target;
        // `EndDraw` follows `BeginDraw`.
        unsafe {
            let bitmap = dc
                .CreateBitmap(
                    D2D_SIZE_U {
                        width: px.0,
                        height: px.1,
                    },
                    None,
                    0,
                    &D2D1_BITMAP_PROPERTIES1 {
                        pixelFormat: D2D1_PIXEL_FORMAT {
                            format: DXGI_FORMAT_B8G8R8A8_UNORM,
                            alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
                        },
                        dpiX: 96.0 * scale,
                        dpiY: 96.0 * scale,
                        bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET,
                        colorContext: std::mem::ManuallyDrop::new(None),
                    },
                )
                .map_err(|err| log::debug!("decor: shadow bitmap not made: {err}"))
                .ok()?;
            dc.SetTarget(&bitmap);
            dc.SetDpi(96.0 * scale, 96.0 * scale);
            dc.BeginDraw();
            dc.Clear(Some(&color_f(Color::TRANSPARENT)));
            dc.SetTransform(&Matrix3x2::translation(
                -region.origin.x.0,
                -region.origin.y.0,
            ));
            let image: Option<ID2D1Image> = if sigma > 0.0 {
                layer::blur(dc, &paint.cast().ok()?, sigma, false).ok()
            } else {
                paint.cast().ok()
            };
            if let Some(image) = image {
                dc.DrawImage(
                    &image,
                    None,
                    None,
                    D2D1_INTERPOLATION_MODE_LINEAR,
                    D2D1_COMPOSITE_MODE_SOURCE_OVER,
                );
            }
            if let Some(mask) = mask {
                dc.DrawImage(&mask, None, None, D2D1_INTERPOLATION_MODE_LINEAR, mode);
            }
            dc.EndDraw(None, None)
                .map_err(|err| log::debug!("decor: shadow not drawn: {err}"))
                .ok()?;
            dc.SetTarget(None);
            Some(Baked {
                bitmap,
                x: region.origin.x.0,
                y: region.origin.y.0,
                width: region.size.width.0,
                height: region.size.height.0,
            })
        }
    })
    .flatten()
}

/// A command list of `geometry` filled with `color`, recorded by `dc` (no
/// target set) at `scale`.
fn record_fill(
    dc: &ID2D1DeviceContext,
    scale: f32,
    geometry: &ID2D1Geometry,
    color: Color,
) -> Option<ID2D1CommandList> {
    // SAFETY: COM calls on the offscreen context; `EndDraw` follows
    // `BeginDraw` and the list is closed before use.
    unsafe {
        let list = dc.CreateCommandList().ok()?;
        dc.SetTarget(&list);
        dc.SetDpi(96.0 * scale, 96.0 * scale);
        dc.BeginDraw();
        dc.SetTransform(&Matrix3x2::identity());
        if let Ok(brush) = dc.CreateSolidColorBrush(&color_f(color), None) {
            dc.FillGeometry(geometry, &brush, None);
        }
        let ended = dc.EndDraw(None, None);
        dc.SetTarget(None);
        ended.ok()?;
        list.Close().ok()?;
        Some(list)
    }
}

/// Draws the border and the outline, over the children (as UIKit draws
/// layer borders, so content the core placed under a border never covers
/// it).
pub(crate) fn draw_border(cx: &mut DrawCx<'_>, state: &ViewState) {
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    if w <= 0.0 || h <= 0.0 {
        return;
    }
    // With the animated color: a border declared transparent shows once
    // its color is animated.
    let b = state.borders();
    let o = state.style.outline;
    if !b.is_visible() && !o.is_visible() {
        return;
    }
    let radii = state.radii();
    if b.is_visible() {
        draw_borders(cx, &b, w, h, radii);
    }
    if o.is_visible() {
        draw_outline(cx, &o, w, h, radii);
    }
}

/// The borders of a `w` x `h` box with `radii`.
fn draw_borders(cx: &mut DrawCx<'_>, b: &Borders, w: f32, h: f32, radii: [f32; 4]) {
    let widths = b.widths.to_array().map(|w| w.0);
    let uniform = b.uniform().map(|(bw, c)| (bw.0, c));
    let uniform_radii = radii.iter().all(|&r| r == radii[0]);
    if b.style == BorderStyle::Solid {
        if let Some((bw, c)) = uniform {
            let half = bw / 2.0;
            let line = rect_f(half, half, (w - bw).max(0.0), (h - bw).max(0.0));
            // Stroking the middle line is exact while the inner corners
            // stay round (or square).
            if uniform_radii && (radii[0] <= 0.0 || radii[0] >= bw) {
                // SAFETY: COM calls between BeginDraw and EndDraw.
                unsafe {
                    if radii[0] <= 0.0 {
                        cx.dc.DrawRectangle(&line, cx.solid(c), bw, None);
                    } else {
                        let rr = D2D1_ROUNDED_RECT {
                            rect: line,
                            radiusX: radii[0] - half,
                            radiusY: radii[0] - half,
                        };
                        cx.dc.DrawRoundedRectangle(&rr, cx.solid(c), bw, None);
                    }
                }
                return;
            }
        }
        // The ring between the border box and the padding box.
        let (inner, corners) = padding_box(w, h, radii, widths);
        let mut figures = vec![(rect(0.0, 0.0, w, h), circular(radii))];
        if inner.size.width.0 > 0.0 && inner.size.height.0 > 0.0 {
            figures.push((inner, corners));
        }
        let Some(ring) = path(cx.gfx, &figures) else {
            return;
        };
        let mut drawn = (0..4).filter(|&i| widths[i] > 0.0);
        let first = drawn.next().map_or(Color::TRANSPARENT, |i| b.colors[i]);
        if drawn.all(|i| b.colors[i] == first) {
            // SAFETY: a COM call between BeginDraw and EndDraw.
            unsafe { cx.dc.FillGeometry(&ring, cx.solid(first), None) };
            return;
        }
        for (side, quad) in side_quads(w, h, widths).iter().enumerate() {
            let c = b.colors[side];
            if widths[side] <= 0.0 || c.is_transparent() {
                continue;
            }
            let Some(clip) = polygon(cx.gfx, quad) else {
                continue;
            };
            cx.push_clip_geometry(&clip);
            // SAFETY: as above.
            unsafe { cx.dc.FillGeometry(&ring, cx.solid(c), None) };
            cx.pop();
        }
        return;
    }
    let Some(style) = stroke_style(cx.gfx, b.style) else {
        return;
    };
    let line = |bw: f32| {
        let half = bw / 2.0;
        crate::render::rounded_geometry(
            cx.gfx,
            rect(half, half, (w - bw).max(0.0), (h - bw).max(0.0)),
            radii.map(|r| (r - half).max(0.0)),
        )
    };
    if let Some((bw, c)) = uniform {
        if let Some(g) = line(bw) {
            // SAFETY: as above.
            unsafe { cx.dc.DrawGeometry(&g, cx.solid(c), bw, &style) };
        }
        return;
    }
    // Sides that differ: the whole line stroked with each side's width and
    // color, clipped to that side's part of the box.
    for (side, quad) in side_quads(w, h, widths).iter().enumerate() {
        let (bw, c) = (widths[side], b.colors[side]);
        if bw <= 0.0 || c.is_transparent() {
            continue;
        }
        let (Some(clip), Some(g)) = (polygon(cx.gfx, quad), line(bw)) else {
            continue;
        };
        cx.push_clip_geometry(&clip);
        // SAFETY: as above.
        unsafe { cx.dc.DrawGeometry(&g, cx.solid(c), bw, &style) };
        cx.pop();
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
    if o.style == BorderStyle::Solid {
        let outer = (rect(-d, -d, ow, oh), circular(radii.map(|r| grown(r, d))));
        let inner = rect(-off, -off, w + 2.0 * off, h + 2.0 * off);
        let mut figures = vec![outer];
        if inner.size.width.0 > 0.0 && inner.size.height.0 > 0.0 {
            figures.push((inner, circular(radii.map(|r| grown(r, off)))));
        }
        if let Some(ring) = path(cx.gfx, &figures) {
            // SAFETY: a COM call between BeginDraw and EndDraw.
            unsafe { cx.dc.FillGeometry(&ring, cx.solid(o.color), None) };
        }
        return;
    }
    let half = width / 2.0;
    let line = crate::render::rounded_geometry(
        cx.gfx,
        rect(-d + half, -d + half, ow - width, oh - width),
        radii.map(|r| grown(r, d - half)),
    );
    if let (Some(line), Some(style)) = (line, stroke_style(cx.gfx, o.style)) {
        // SAFETY: as above.
        unsafe { cx.dc.DrawGeometry(&line, cx.solid(o.color), width, &style) };
    }
}

/// A corner radius `d` points further out (CSS: only rounded corners grow;
/// shrinking stops at square).
fn grown(r: f32, d: f32) -> f32 {
    if r > 0.0 { (r + d).max(0.0) } else { 0.0 }
}

/// Horizontal and vertical radii of the corners, clockwise from the top
/// left.
type Corners = [(f32, f32); 4];

/// Circular corners.
fn circular(radii: [f32; 4]) -> Corners {
    radii.map(|r| (r, r))
}

/// The padding box (inside the borders `widths`: top, right, bottom, left)
/// of a `w` x `h` box; its corners are the outer ones less the borders'
/// widths on each axis, elliptical where they differ, square where a
/// border is wider than its corner.
fn padding_box(w: f32, h: f32, radii: [f32; 4], widths: [f32; 4]) -> (Bounds<Points>, Corners) {
    let [top, right, bottom, left] = widths;
    let r = rect(
        left,
        top,
        (w - left - right).max(0.0),
        (h - top - bottom).max(0.0),
    );
    let c = |r: f32, x: f32, y: f32| ((r - x).max(0.0), (r - y).max(0.0));
    (
        r,
        [
            c(radii[0], left, top),
            c(radii[1], right, top),
            c(radii[2], right, bottom),
            c(radii[3], left, bottom),
        ],
    )
}

/// `c` scaled down as CSS does when adjacent corners overlap on a `w` x
/// `h` box.
fn fit_corners(w: f32, h: f32, c: Corners) -> Corners {
    let sides = [
        (c[0].0 + c[1].0, w),
        (c[1].1 + c[2].1, h),
        (c[2].0 + c[3].0, w),
        (c[3].1 + c[0].1, h),
    ];
    let f = sides
        .iter()
        .filter(|(sum, _)| *sum > 0.0)
        .map(|(sum, len)| len / sum)
        .fold(1.0f32, f32::min);
    if f < 1.0 {
        c.map(|(x, y)| (x * f, y * f))
    } else {
        c
    }
}

/// Each side's part of a `w` x `h` box with border `widths`, clockwise from
/// the top: the corners are split along the lines from the outer corners
/// through the inner ones (as CSS joins differing borders), ending at the
/// box's middle lines.
fn side_quads(w: f32, h: f32, widths: [f32; 4]) -> [[(f32, f32); 4]; 4] {
    let [t, r, b, l] = widths;
    // Each corner's split, from the outer corner inwards.
    let end = |(cx, cy): (f32, f32), (dx, dy): (f32, f32)| {
        let (dx, dy) = if dx == 0.0 && dy == 0.0 {
            (
                if cx == 0.0 { 1.0 } else { -1.0 },
                if cy == 0.0 { 1.0 } else { -1.0 },
            )
        } else {
            (dx, dy)
        };
        let kx = if dx != 0.0 {
            (w / 2.0) / dx.abs()
        } else {
            f32::INFINITY
        };
        let ky = if dy != 0.0 {
            (h / 2.0) / dy.abs()
        } else {
            f32::INFINITY
        };
        let k = kx.min(ky);
        (cx + dx * k, cy + dy * k)
    };
    let tl = end((0.0, 0.0), (l, t));
    let tr = end((w, 0.0), (-r, t));
    let br = end((w, h), (-r, -b));
    let bl = end((0.0, h), (l, -b));
    [
        [(0.0, 0.0), (w, 0.0), tr, tl],
        [(w, 0.0), (w, h), br, tr],
        [(w, h), (0.0, h), bl, br],
        [(0.0, h), (0.0, 0.0), tl, bl],
    ]
}

/// Adds the rounded rectangle `r` with corners `c` as a closed figure.
///
/// # Safety
///
/// `sink` must be open.
unsafe fn add_rounded(sink: &ID2D1GeometrySink, r: Bounds<Points>, c: Corners) {
    let c = fit_corners(r.size.width.0, r.size.height.0, c);
    let (x, y, w, h) = (r.origin.x.0, r.origin.y.0, r.size.width.0, r.size.height.0);
    let p = |px: f32, py: f32| Vector2 { X: px, Y: py };
    let arc = |to: Vector2, (rx, ry): (f32, f32)| D2D1_ARC_SEGMENT {
        point: to,
        size: D2D_SIZE_F {
            width: rx,
            height: ry,
        },
        rotationAngle: 0.0,
        sweepDirection: D2D1_SWEEP_DIRECTION_CLOCKWISE,
        arcSize: D2D1_ARC_SIZE_SMALL,
    };
    let round = |(rx, ry): (f32, f32)| rx > 0.0 && ry > 0.0;
    // Square corners (either radius zero) count as no corner.
    let c = c.map(|k| if round(k) { k } else { (0.0, 0.0) });
    // SAFETY: the caller keeps the sink open.
    unsafe {
        sink.BeginFigure(p(x + c[0].0, y), D2D1_FIGURE_BEGIN_FILLED);
        sink.AddLine(p(x + w - c[1].0, y));
        if round(c[1]) {
            sink.AddArc(&arc(p(x + w, y + c[1].1), c[1]));
        }
        sink.AddLine(p(x + w, y + h - c[2].1));
        if round(c[2]) {
            sink.AddArc(&arc(p(x + w - c[2].0, y + h), c[2]));
        }
        sink.AddLine(p(x + c[3].0, y + h));
        if round(c[3]) {
            sink.AddArc(&arc(p(x, y + h - c[3].1), c[3]));
        }
        sink.AddLine(p(x, y + c[0].1));
        if round(c[0]) {
            sink.AddArc(&arc(p(x + c[0].0, y), c[0]));
        }
        sink.EndFigure(D2D1_FIGURE_END_CLOSED);
    }
}

/// A path of rounded rectangles, filled alternately (a rectangle inside
/// another makes a ring).
fn path(gfx: &Gfx, figures: &[(Bounds<Points>, Corners)]) -> Option<ID2D1Geometry> {
    // SAFETY: COM calls on live objects; the sink is closed before use.
    unsafe {
        let path = gfx.factory.CreatePathGeometry().ok()?;
        let sink = path.Open().ok()?;
        sink.SetFillMode(D2D1_FILL_MODE_ALTERNATE);
        for &(r, c) in figures {
            add_rounded(&sink, r, c);
        }
        sink.Close().ok()?;
        path.cast().ok()
    }
}

/// A closed polygon.
fn polygon(gfx: &Gfx, points: &[(f32, f32)]) -> Option<ID2D1Geometry> {
    let (&(x0, y0), rest) = points.split_first()?;
    // SAFETY: as above.
    unsafe {
        let path = gfx.factory.CreatePathGeometry().ok()?;
        let sink = path.Open().ok()?;
        sink.BeginFigure(Vector2 { X: x0, Y: y0 }, D2D1_FIGURE_BEGIN_FILLED);
        for &(x, y) in rest {
            sink.AddLine(Vector2 { X: x, Y: y });
        }
        sink.EndFigure(D2D1_FIGURE_END_CLOSED);
        sink.Close().ok()?;
        path.cast().ok()
    }
}

/// Stroke styles of dashed and dotted lines, made again with the factory.
struct StrokeStyles {
    generation: u64,
    dashed: ID2D1StrokeStyle,
    dotted: ID2D1StrokeStyle,
}

thread_local! {
    static STROKES: RefCell<Option<StrokeStyles>> = const { RefCell::new(None) };
}

/// The stroke style of a dashed or dotted line (`None` for solid lines,
/// which need none). Dashes are as long as three widths, as the gaps
/// between them; dots are round, two widths apart.
fn stroke_style(gfx: &Gfx, style: BorderStyle) -> Option<ID2D1StrokeStyle> {
    if style == BorderStyle::Solid {
        return None;
    }
    let generation = crate::gfx::generation();
    STROKES.with(|cell| {
        let mut cell = cell.borrow_mut();
        if cell.as_ref().is_none_or(|s| s.generation != generation) {
            let make = |cap, join, dashes: &[f32]| {
                let props = D2D1_STROKE_STYLE_PROPERTIES {
                    startCap: cap,
                    endCap: cap,
                    dashCap: cap,
                    lineJoin: join,
                    miterLimit: 10.0,
                    dashStyle: D2D1_DASH_STYLE_CUSTOM,
                    dashOffset: 0.0,
                };
                // SAFETY: a COM call on the live factory with valid
                // properties.
                unsafe { ID2D1Factory::CreateStrokeStyle(&gfx.factory, &props, Some(dashes)) }
            };
            // Zero-length dashes with round caps draw dots.
            let made =
                make(D2D1_CAP_STYLE_FLAT, D2D1_LINE_JOIN_MITER, &[3.0, 3.0]).and_then(|dashed| {
                    Ok((
                        dashed,
                        make(D2D1_CAP_STYLE_ROUND, D2D1_LINE_JOIN_ROUND, &[0.0, 2.0])?,
                    ))
                });
            match made {
                Ok((dashed, dotted)) => {
                    *cell = Some(StrokeStyles {
                        generation,
                        dashed,
                        dotted,
                    })
                }
                Err(err) => {
                    log::debug!("decor: no stroke style: {err}");
                    return None;
                }
            }
        }
        let s = cell.as_ref()?;
        Some(if style == BorderStyle::Dotted {
            s.dotted.clone()
        } else {
            s.dashed.clone()
        })
    })
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
        // A mirror is not a back face; a half turn about x is.
        assert!(!faces_away(&Mat4::new().scale(-1.0, 1.0)));
        assert!(faces_away(&Mat4::new().rotate_x(180.0)));
        // A parent's half turn turns the child too.
        let child = Mat4::new().translate(10.0, 10.0).then(&turned(180.0));
        assert!(faces_away(&child));
        assert!(close(det4(&Mat4::new().scale(2.0, 3.0).m), 6.0));
    }

    #[test]
    fn padding_box_corners() {
        // Uniform 2 pt borders inside 10 pt corners: 8 pt inner corners.
        let (r, c) = padding_box(100.0, 50.0, [10.0; 4], [2.0; 4]);
        assert_eq!(
            (r.origin.x.0, r.origin.y.0, r.size.width.0, r.size.height.0),
            (2.0, 2.0, 96.0, 46.0)
        );
        assert_eq!(c[0], (8.0, 8.0));
        // Differing borders make elliptical corners, square past the radius.
        let (_, c) = padding_box(100.0, 50.0, [6.0, 0.0, 1.0, 0.0], [6.0, 2.0, 4.0, 1.0]);
        assert_eq!(c[0], (5.0, 0.0));
        assert_eq!(c[1], (0.0, 0.0));
        assert_eq!(c[2], (0.0, 0.0));
    }

    #[test]
    fn corners_fit_the_box() {
        let c = fit_corners(
            10.0,
            100.0,
            [(10.0, 10.0), (10.0, 10.0), (0.0, 0.0), (0.0, 0.0)],
        );
        assert!(close(c[0].0, 5.0) && close(c[1].0, 5.0));
        let c = fit_corners(100.0, 100.0, [(10.0, 20.0); 4]);
        assert_eq!(c[0], (10.0, 20.0));
    }

    #[test]
    fn side_quads_split_at_the_corners() {
        // A square with even borders: every side ends at the center.
        let q = side_quads(100.0, 100.0, [4.0; 4]);
        assert_eq!(q[0], [(0.0, 0.0), (100.0, 0.0), (50.0, 50.0), (50.0, 50.0)]);
        // A wide top border takes more of the top corners: the split runs
        // from the corner through the inner corner (10, 40).
        let q = side_quads(200.0, 100.0, [40.0, 10.0, 10.0, 10.0]);
        let (x, y) = q[0][3];
        assert!(close(y / x, 4.0), "{x} {y}");
        // No left border: the top and bottom parts reach the left edge.
        let q = side_quads(100.0, 100.0, [4.0, 4.0, 4.0, 0.0]);
        assert!(close(q[0][3].0, 0.0));
        assert!(close(q[3][2].0, 0.0) && close(q[3][3].0, 0.0));
    }

    #[test]
    fn grown_corners() {
        assert_eq!(grown(10.0, 4.0), 14.0);
        assert_eq!(grown(0.0, 4.0), 0.0);
        assert_eq!(grown(3.0, -5.0), 0.0);
    }

    #[test]
    fn shadow_keys() {
        let spec = ShadowSpec {
            dx: 0.0,
            dy: 4.0,
            spread: 0.0,
            blur: 12.0,
            color: Color(0x0000_0040),
            cut: true,
        };
        let key = |spec: &ShadowSpec, w: f32, scale: f32| {
            shadow_key(b'o', w, 50.0, [8.0; 4], [0.0; 4], spec, scale)
        };
        let base = key(&spec, 100.0, 1.5);
        assert_eq!(base, key(&spec, 100.0, 1.5));
        assert_ne!(base, key(&spec, 101.0, 1.5));
        assert_ne!(base, key(&spec, 100.0, 2.0));
        assert_ne!(base, key(&ShadowSpec { blur: 10.0, ..spec }, 100.0, 1.5));
        assert_ne!(
            base,
            key(
                &ShadowSpec {
                    color: Color(0x0000_0041),
                    ..spec
                },
                100.0,
                1.5
            )
        );
        assert_ne!(base, key(&ShadowSpec { cut: false, ..spec }, 100.0, 1.5));
        assert_ne!(
            base,
            shadow_key(b'i', 100.0, 50.0, [8.0; 4], [0.0; 4], &spec, 1.5)
        );
    }

    #[test]
    fn regions_snap_outwards() {
        let r = snapped(rect(0.3, -0.2, 10.0, 5.0), 2.0);
        assert_eq!((r.origin.x.0, r.origin.y.0), (0.0, -0.5));
        assert!(r.origin.x.0 + r.size.width.0 >= 10.3 && r.origin.y.0 + r.size.height.0 >= 4.8);
        assert!(close(bake_scale(rect(0.0, 0.0, 8192.0, 10.0), 2.0), 0.5));
    }
}
