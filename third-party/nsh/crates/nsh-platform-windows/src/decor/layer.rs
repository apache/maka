//! Offscreen drawing and Direct2D effects: filters, content shadows, blend
//! modes and backdrop filters.
//!
//! A view whose look depends on everything it draws (a `filter`, React
//! Native's shadow of the content, `mixBlendMode`) is first recorded into
//! a command list ([`record`]): its whole subtree drawn by a second device
//! context of the same device, in window coordinates, so the pass's
//! context and the layers pushed on it are left alone. The command list
//! then goes through an effect graph ([`apply_filters`], [`drop_shadow`])
//! and is drawn as one image.
//!
//! Effects run in window coordinates (points): a blur's radius and a
//! shadow's offset are mapped through the view's transform first, so a
//! scaled or rotated view's filters scale and turn with it, as CSS
//! applies filters in the element's own coordinates.
//!
//! `mixBlendMode` and `backdropFilter` need what is already drawn behind
//! the view: [`backdrop`] copies those pixels out of the pass's target
//! (after closing and reopening the layers pushed so far, whose content
//! is only in the target once they are popped). It works in the window's
//! own pass and in screenshots, not inside a view drawn offscreen (a
//! filtered or 3D-transformed ancestor): there the blend is normal and the
//! backdrop is not filtered.

use std::cell::RefCell;

use nsh_core::{BlendMode, Color, Filter};
use windows::{
    Win32::Graphics::Direct2D::{
        CLSID_D2D1Blend, CLSID_D2D1ColorMatrix, CLSID_D2D1Composite, CLSID_D2D1GaussianBlur,
        CLSID_D2D1Shadow, CLSID_D2D12DAffineTransform,
        Common::{
            D2D_POINT_2U, D2D_RECT_U, D2D_SIZE_U, D2D1_BLEND_MODE, D2D1_BLEND_MODE_COLOR,
            D2D1_BLEND_MODE_COLOR_BURN, D2D1_BLEND_MODE_COLOR_DODGE, D2D1_BLEND_MODE_DARKEN,
            D2D1_BLEND_MODE_DIFFERENCE, D2D1_BLEND_MODE_EXCLUSION, D2D1_BLEND_MODE_HARD_LIGHT,
            D2D1_BLEND_MODE_HUE, D2D1_BLEND_MODE_LIGHTEN, D2D1_BLEND_MODE_LINEAR_BURN,
            D2D1_BLEND_MODE_LINEAR_DODGE, D2D1_BLEND_MODE_LUMINOSITY, D2D1_BLEND_MODE_MULTIPLY,
            D2D1_BLEND_MODE_OVERLAY, D2D1_BLEND_MODE_SATURATION, D2D1_BLEND_MODE_SCREEN,
            D2D1_BLEND_MODE_SOFT_LIGHT, D2D1_BORDER_MODE_HARD, D2D1_BORDER_MODE_SOFT,
            D2D1_COMPOSITE_MODE_SOURCE_OVER,
        },
        D2D1_2DAFFINETRANSFORM_PROP_TRANSFORM_MATRIX, D2D1_BITMAP_OPTIONS_NONE,
        D2D1_BITMAP_PROPERTIES1, D2D1_BLEND_PROP_MODE, D2D1_COLORMATRIX_PROP_CLAMP_OUTPUT,
        D2D1_COLORMATRIX_PROP_COLOR_MATRIX, D2D1_COMPOSITE_PROP_MODE,
        D2D1_DEVICE_CONTEXT_OPTIONS_NONE, D2D1_GAUSSIANBLUR_PROP_BORDER_MODE,
        D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION, D2D1_PROPERTY_TYPE, D2D1_PROPERTY_TYPE_BOOL,
        D2D1_PROPERTY_TYPE_ENUM, D2D1_PROPERTY_TYPE_FLOAT, D2D1_PROPERTY_TYPE_MATRIX_3X2,
        D2D1_PROPERTY_TYPE_MATRIX_5X4, D2D1_PROPERTY_TYPE_VECTOR4,
        D2D1_SHADOW_PROP_BLUR_STANDARD_DEVIATION, D2D1_SHADOW_PROP_COLOR, ID2D1Bitmap1,
        ID2D1CommandList, ID2D1DeviceContext, ID2D1Effect, ID2D1Image,
    },
    core::{GUID, Interface, Result},
};
use windows_numerics::Matrix3x2;

use crate::{geom::Mat4, gfx::Gfx, render::DrawCx};

struct Pool {
    generation: u64,
    free: Vec<ID2D1DeviceContext>,
}

thread_local! {
    /// Device contexts for offscreen drawing, reused (nested offscreen
    /// drawing takes one each).
    static POOL: RefCell<Pool> = const {
        RefCell::new(Pool {
            generation: 0,
            free: Vec::new(),
        })
    };
}

pub(super) fn clear_thread_cache() {
    let _ = POOL.try_with(|p| {
        let mut p = p.borrow_mut();
        p.free.clear();
        p.generation = 0;
    });
}

/// Runs `f` with a device context of `gfx`'s device that nobody else is
/// drawing with (its target unset, no drawing begun).
pub(crate) fn with_context<R>(gfx: &Gfx, f: impl FnOnce(&ID2D1DeviceContext) -> R) -> Option<R> {
    let generation = crate::gfx::generation();
    let taken = POOL.with(|p| {
        let mut p = p.borrow_mut();
        if p.generation != generation {
            p.free.clear();
            p.generation = generation;
        }
        p.free.pop()
    });
    let dc = match taken {
        Some(dc) => dc,
        // SAFETY: a COM call on the live device.
        None => match unsafe {
            gfx.device
                .CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE)
        } {
            Ok(dc) => dc,
            Err(err) => {
                log::warn!("decor: no offscreen device context: {err}");
                return None;
            }
        },
    };
    let out = f(&dc);
    // SAFETY: a COM call on a live context; unsets what `f` drew into.
    unsafe { dc.SetTarget(None) };
    POOL.with(|p| {
        let mut p = p.borrow_mut();
        if p.generation == generation {
            p.free.push(dc);
        }
    });
    Some(out)
}

/// Draws with `f` into `target` (a command list or a target bitmap of
/// `scale` pixels per point) through an offscreen context set up like
/// `cx`'s, cleared first with `clear`; the hosted items `f` draws join
/// `cx`'s. False when drawing failed.
pub(crate) fn draw_into(
    cx: &mut DrawCx<'_>,
    target: &ID2D1Image,
    scale: f32,
    clear: bool,
    f: impl FnOnce(&mut DrawCx<'_>),
) -> bool {
    let gfx = cx.gfx;
    let mut drawn = Vec::new();
    let mut composed = Vec::new();
    let ok = with_context(gfx, |dc| {
        // SAFETY: COM calls on the live contexts; `EndDraw` follows
        // `BeginDraw`.
        unsafe {
            dc.SetTarget(target);
            dc.SetDpi(96.0 * scale, 96.0 * scale);
            dc.SetTextAntialiasMode(cx.dc.GetTextAntialiasMode());
            dc.BeginDraw();
            dc.SetTransform(&Matrix3x2::identity());
            if clear {
                dc.Clear(Some(&crate::render::color_f(Color::TRANSPARENT)));
            }
        }
        match cx.nested(dc, scale) {
            Ok(mut inner) => {
                f(&mut inner);
                drawn = std::mem::take(&mut inner.drawn);
                composed = std::mem::take(&mut inner.composed);
            }
            Err(err) => log::debug!("decor: offscreen pass not started: {err}"),
        }
        // SAFETY: closes the `BeginDraw` above.
        match unsafe { dc.EndDraw(None, None) } {
            Ok(()) => true,
            Err(err) => {
                log::debug!("decor: offscreen drawing failed: {err}");
                false
            }
        }
    })
    .unwrap_or(false);
    cx.drawn.append(&mut drawn);
    cx.adopt_composed(composed);
    ok
}

/// Records what `f` draws (in window coordinates) into a command list.
pub(crate) fn record(
    cx: &mut DrawCx<'_>,
    f: impl FnOnce(&mut DrawCx<'_>),
) -> Option<ID2D1CommandList> {
    // SAFETY: a COM call on the live context.
    let list = unsafe { cx.dc.CreateCommandList() }.ok()?;
    let target: ID2D1Image = list.cast().ok()?;
    let scale = cx.scale;
    let ok = draw_into(cx, &target, scale, false, f);
    // SAFETY: a COM call on the list, recorded and no longer a target.
    unsafe { list.Close() }.ok()?;
    ok.then_some(list)
}

/// A new effect.
fn effect(dc: &ID2D1DeviceContext, id: &GUID) -> Result<ID2D1Effect> {
    // SAFETY: a COM call on the live context with a valid id.
    unsafe { dc.CreateEffect(id) }
}

/// Sets property `index` of `e` to `value` (of the property's type).
fn set<T: Copy>(e: &ID2D1Effect, index: i32, ty: D2D1_PROPERTY_TYPE, value: &T) -> Result<()> {
    // SAFETY: `value` is a plain value of `size_of::<T>()` bytes, read as
    // bytes for the duration of the call.
    let bytes = unsafe {
        std::slice::from_raw_parts((value as *const T).cast::<u8>(), std::mem::size_of::<T>())
    };
    // SAFETY: a COM call on a live effect; the type matches the property.
    unsafe { e.SetValue(index as u32, ty, bytes) }
}

/// The output of `e` with `input` as its input 0.
fn output(e: &ID2D1Effect, input: &ID2D1Image) -> Result<ID2D1Image> {
    // SAFETY: COM calls on a live effect and image.
    unsafe {
        e.SetInput(0, input, false);
        e.GetOutput()
    }
}

/// The linear part of a 2D transform: `(M11, M12, M21, M22)`.
pub(crate) type Linear = [f32; 4];

/// The linear part of `m`.
pub(crate) fn linear(m: &Mat4) -> Linear {
    let t = m.to_3x2();
    [t.M11, t.M12, t.M21, t.M22]
}

/// How much `lin` scales lengths (the square root of its area scale).
pub(crate) fn length_scale(lin: &Linear) -> f32 {
    (lin[0] * lin[3] - lin[1] * lin[2]).abs().sqrt()
}

/// The vector `(x, y)` through `lin`.
pub(crate) fn map_vector(lin: &Linear, x: f32, y: f32) -> (f32, f32) {
    (x * lin[0] + y * lin[2], x * lin[1] + y * lin[3])
}

/// A row-major 4x5 color matrix (an output channel per row, offsets last)
/// as Direct2D's 5x4 one: a row per input channel (the offsets' last), a
/// column per output.
pub(crate) fn d2d_color_matrix(m: &[f32; 20]) -> [f32; 20] {
    std::array::from_fn(|i| {
        let (input, out) = (i / 4, i % 4);
        m[out * 5 + input]
    })
}

/// True if the 4x5 color matrix changes nothing.
pub(crate) fn is_identity(m: &[f32; 20]) -> bool {
    m.iter().enumerate().all(|(i, v)| {
        let id = if i % 5 == i / 5 { 1.0 } else { 0.0 };
        (v - id).abs() < 1e-6
    })
}

/// True if `filters` change anything.
pub(crate) fn filters_visible(filters: &[Filter]) -> bool {
    filters.iter().any(|f| match *f {
        Filter::Blur(r) => r.0 > 0.0,
        Filter::DropShadow { color, .. } => !color.is_transparent(),
        _ => f.color_matrix().is_some_and(|m| !is_identity(&m)),
    })
}

/// How far `filters` reach out of what they filter (points, before the
/// view's transform).
pub(crate) fn filters_outset(filters: &[Filter]) -> f32 {
    filters
        .iter()
        .map(|f| match *f {
            Filter::Blur(r) => 3.0 * r.0.max(0.0),
            Filter::DropShadow {
                offset_x,
                offset_y,
                blur,
                ..
            } => offset_x.0.abs().max(offset_y.0.abs()) + 1.5 * blur.0.max(0.0),
            _ => 0.0,
        })
        .sum()
}

/// A Gaussian blur of deviation `sigma` (points); `hard` keeps the edges
/// opaque (a backdrop) instead of fading them.
pub(crate) fn blur(
    dc: &ID2D1DeviceContext,
    input: &ID2D1Image,
    sigma: f32,
    hard: bool,
) -> Result<ID2D1Image> {
    let e = effect(dc, &CLSID_D2D1GaussianBlur)?;
    set(
        &e,
        D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION.0,
        D2D1_PROPERTY_TYPE_FLOAT,
        &sigma,
    )?;
    let mode = if hard {
        D2D1_BORDER_MODE_HARD
    } else {
        D2D1_BORDER_MODE_SOFT
    };
    set(
        &e,
        D2D1_GAUSSIANBLUR_PROP_BORDER_MODE.0,
        D2D1_PROPERTY_TYPE_ENUM,
        &(mode.0 as u32),
    )?;
    output(&e, input)
}

/// `input` through the 4x5 color matrix `m`.
fn color_matrix(dc: &ID2D1DeviceContext, input: &ID2D1Image, m: &[f32; 20]) -> Result<ID2D1Image> {
    let e = effect(dc, &CLSID_D2D1ColorMatrix)?;
    set(
        &e,
        D2D1_COLORMATRIX_PROP_COLOR_MATRIX.0,
        D2D1_PROPERTY_TYPE_MATRIX_5X4,
        &d2d_color_matrix(m),
    )?;
    set(
        &e,
        D2D1_COLORMATRIX_PROP_CLAMP_OUTPUT.0,
        D2D1_PROPERTY_TYPE_BOOL,
        &1i32,
    )?;
    output(&e, input)
}

/// `input` moved by `t`.
pub(crate) fn transformed(
    dc: &ID2D1DeviceContext,
    input: &ID2D1Image,
    t: &Matrix3x2,
) -> Result<ID2D1Image> {
    let e = effect(dc, &CLSID_D2D12DAffineTransform)?;
    set(
        &e,
        D2D1_2DAFFINETRANSFORM_PROP_TRANSFORM_MATRIX.0,
        D2D1_PROPERTY_TYPE_MATRIX_3X2,
        t,
    )?;
    output(&e, input)
}

/// `input` over a shadow of its shape: `color`, moved by `(dx, dy)` and
/// blurred by `blur` (CSS: twice the deviation), in the view's coordinates
/// mapped by `lin`.
pub(crate) fn drop_shadow(
    dc: &ID2D1DeviceContext,
    input: &ID2D1Image,
    dx: f32,
    dy: f32,
    blur: f32,
    color: Color,
    lin: &Linear,
) -> Result<ID2D1Image> {
    let shadow = effect(dc, &CLSID_D2D1Shadow)?;
    let sigma = blur.max(0.0) / 2.0 * length_scale(lin);
    set(
        &shadow,
        D2D1_SHADOW_PROP_BLUR_STANDARD_DEVIATION.0,
        D2D1_PROPERTY_TYPE_FLOAT,
        &sigma,
    )?;
    let (r, g, b, a) = color.to_f64();
    let rgba = [r as f32, g as f32, b as f32, a as f32];
    set(
        &shadow,
        D2D1_SHADOW_PROP_COLOR.0,
        D2D1_PROPERTY_TYPE_VECTOR4,
        &rgba,
    )?;
    let shadow = output(&shadow, input)?;
    let (mx, my) = map_vector(lin, dx, dy);
    let moved = transformed(dc, &shadow, &Matrix3x2::translation(mx, my))?;
    let comp = effect(dc, &CLSID_D2D1Composite)?;
    set(
        &comp,
        D2D1_COMPOSITE_PROP_MODE.0,
        D2D1_PROPERTY_TYPE_ENUM,
        &(D2D1_COMPOSITE_MODE_SOURCE_OVER.0 as u32),
    )?;
    // SAFETY: COM calls on live effects and images; input 0 is the
    // destination (below), input 1 the source.
    unsafe {
        comp.SetInput(0, &moved, false);
        comp.SetInput(1, input, false);
        comp.GetOutput()
    }
}

/// `input` through CSS `filters` (the first applies first), in the view's
/// coordinates mapped by `lin`. `hard` keeps a blur's edges opaque.
pub(crate) fn apply_filters(
    dc: &ID2D1DeviceContext,
    input: ID2D1Image,
    filters: &[Filter],
    lin: &Linear,
    hard: bool,
) -> Result<ID2D1Image> {
    let mut image = input;
    let mut i = 0;
    while i < filters.len() {
        if filters[i].color_matrix().is_some() {
            // Neighboring color filters make one matrix.
            let mut end = i + 1;
            while end < filters.len() && filters[end].color_matrix().is_some() {
                end += 1;
            }
            if let Some(m) = nsh_core::compose_color_matrices(&filters[i..end])
                && !is_identity(&m)
            {
                image = color_matrix(dc, &image, &m)?;
            }
            i = end;
            continue;
        }
        match filters[i] {
            Filter::Blur(r) if r.0 > 0.0 => {
                image = blur(dc, &image, r.0 * length_scale(lin), hard)?;
            }
            Filter::DropShadow {
                offset_x,
                offset_y,
                blur,
                color,
            } if !color.is_transparent() => {
                image = drop_shadow(dc, &image, offset_x.0, offset_y.0, blur.0, color, lin)?;
            }
            _ => {}
        }
        i += 1;
    }
    Ok(image)
}

/// Direct2D's blend mode for `mode`, `None` for `Normal`.
pub(crate) fn blend_mode(mode: BlendMode) -> Option<D2D1_BLEND_MODE> {
    Some(match mode {
        BlendMode::Normal => return None,
        BlendMode::Multiply => D2D1_BLEND_MODE_MULTIPLY,
        BlendMode::Screen => D2D1_BLEND_MODE_SCREEN,
        BlendMode::Overlay => D2D1_BLEND_MODE_OVERLAY,
        BlendMode::Darken => D2D1_BLEND_MODE_DARKEN,
        BlendMode::Lighten => D2D1_BLEND_MODE_LIGHTEN,
        BlendMode::ColorDodge => D2D1_BLEND_MODE_COLOR_DODGE,
        BlendMode::ColorBurn => D2D1_BLEND_MODE_COLOR_BURN,
        BlendMode::HardLight => D2D1_BLEND_MODE_HARD_LIGHT,
        BlendMode::SoftLight => D2D1_BLEND_MODE_SOFT_LIGHT,
        BlendMode::Difference => D2D1_BLEND_MODE_DIFFERENCE,
        BlendMode::Exclusion => D2D1_BLEND_MODE_EXCLUSION,
        BlendMode::Hue => D2D1_BLEND_MODE_HUE,
        BlendMode::Saturation => D2D1_BLEND_MODE_SATURATION,
        BlendMode::Color => D2D1_BLEND_MODE_COLOR,
        BlendMode::Luminosity => D2D1_BLEND_MODE_LUMINOSITY,
        // `max(0, s + d - 1)` and `min(1, s + d)`.
        BlendMode::PlusDarker => D2D1_BLEND_MODE_LINEAR_BURN,
        BlendMode::PlusLighter => D2D1_BLEND_MODE_LINEAR_DODGE,
    })
}

/// `source` blended over `backdrop` with `mode`.
pub(crate) fn blend(
    dc: &ID2D1DeviceContext,
    backdrop: &ID2D1Image,
    source: &ID2D1Image,
    mode: D2D1_BLEND_MODE,
) -> Result<ID2D1Image> {
    let e = effect(dc, &CLSID_D2D1Blend)?;
    set(
        &e,
        D2D1_BLEND_PROP_MODE.0,
        D2D1_PROPERTY_TYPE_ENUM,
        &(mode.0 as u32),
    )?;
    // SAFETY: COM calls on a live effect and images; input 0 is the
    // destination, input 1 the source.
    unsafe {
        e.SetInput(0, backdrop, false);
        e.SetInput(1, source, false);
        e.GetOutput()
    }
}

/// A copy of what the pass drew so far in the window rectangle `(x, y, w,
/// h)` (points), with where it lies (points, whole pixels); `None` when
/// the pass cannot read its target (an offscreen pass) or the rectangle is
/// outside it.
pub(crate) fn backdrop(
    cx: &mut DrawCx<'_>,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
) -> Option<(ID2D1Image, f32, f32)> {
    if !cx.backdrop {
        return None;
    }
    let scale = cx.scale;
    // Content drawn into pushed layers reaches the target when they pop:
    // the copy is made while they are closed.
    cx.flatten(|dc| {
        // SAFETY: COM calls on the live context and its target; the copy
        // happens after the pending drawing is flushed into the target.
        unsafe {
            dc.Flush(None, None).ok()?;
            let target: ID2D1Bitmap1 = dc.GetTarget().ok()?.cast().ok()?;
            let size = target.GetPixelSize();
            let left = ((x * scale).floor().max(0.0) as u32).min(size.width);
            let top = ((y * scale).floor().max(0.0) as u32).min(size.height);
            let right = (((x + w) * scale).ceil().max(0.0) as u32).min(size.width);
            let bottom = (((y + h) * scale).ceil().max(0.0) as u32).min(size.height);
            if right <= left || bottom <= top {
                return None;
            }
            let copy = dc
                .CreateBitmap(
                    D2D_SIZE_U {
                        width: right - left,
                        height: bottom - top,
                    },
                    None,
                    0,
                    &D2D1_BITMAP_PROPERTIES1 {
                        pixelFormat: target.GetPixelFormat(),
                        dpiX: 96.0 * scale,
                        dpiY: 96.0 * scale,
                        bitmapOptions: D2D1_BITMAP_OPTIONS_NONE,
                        colorContext: std::mem::ManuallyDrop::new(None),
                    },
                )
                .ok()?;
            copy.CopyFromBitmap(
                Some(&D2D_POINT_2U { x: 0, y: 0 }),
                &target,
                Some(&D2D_RECT_U {
                    left,
                    top,
                    right,
                    bottom,
                }),
            )
            .map_err(|err| log::debug!("decor: backdrop not copied: {err}"))
            .ok()?;
            Some((copy.cast().ok()?, left as f32 / scale, top as f32 / scale))
        }
    })
}

#[cfg(test)]
mod tests {
    use nsh_core::geometry::{deg, px};

    use super::*;

    #[test]
    fn color_matrices_transpose() {
        let m = nsh_core::compose_color_matrices(&[Filter::Invert(1.0)]).unwrap();
        let d = d2d_color_matrix(&m);
        // Red in, red out.
        assert_eq!(d[0], -1.0);
        // The offsets are the last row.
        assert_eq!(&d[16..], &[1.0, 1.0, 1.0, 0.0]);
        // Sepia's green input feeds red: row 1 (green in), column 0.
        let m = nsh_core::compose_color_matrices(&[Filter::Sepia(1.0)]).unwrap();
        assert!((d2d_color_matrix(&m)[4] - 0.769).abs() < 1e-6);
        // Opacity scales alpha only.
        let m = Filter::Opacity(0.25).color_matrix().unwrap();
        let d = d2d_color_matrix(&m);
        assert_eq!(d[15], 0.25);
        assert_eq!(d[0], 1.0);
    }

    #[test]
    fn identity_filters_change_nothing() {
        assert!(is_identity(
            &Filter::Brightness(1.0).color_matrix().unwrap()
        ));
        assert!(is_identity(&Filter::Saturate(1.0).color_matrix().unwrap()));
        assert!(is_identity(&Filter::Grayscale(0.0).color_matrix().unwrap()));
        assert!(is_identity(
            &Filter::HueRotate(deg(0.0)).color_matrix().unwrap()
        ));
        assert!(!is_identity(
            &Filter::Grayscale(1.0).color_matrix().unwrap()
        ));
        assert!(!filters_visible(&[
            Filter::Contrast(1.0),
            Filter::Blur(px(0.0))
        ]));
        assert!(filters_visible(&[Filter::Contrast(1.2)]));
        // Full grayscale leaves equal channels.
        let m = Filter::Grayscale(1.0).color_matrix().unwrap();
        for row in 0..3 {
            assert!((m[row * 5] - 0.2126).abs() < 1e-6);
        }
    }

    #[test]
    fn transforms_scale_effects() {
        let m = Mat4::new().scale(2.0, 2.0).rotate(90.0);
        let lin = linear(&m);
        assert!((length_scale(&lin) - 2.0).abs() < 1e-5);
        // A shadow 4 pt down turns with the view: 8 pt to the left.
        let (x, y) = map_vector(&lin, 0.0, 4.0);
        assert!((x + 8.0).abs() < 1e-4 && y.abs() < 1e-4);
    }

    #[test]
    fn blend_modes_map() {
        assert!(blend_mode(BlendMode::Normal).is_none());
        assert_eq!(
            blend_mode(BlendMode::Multiply),
            Some(D2D1_BLEND_MODE_MULTIPLY)
        );
        assert_eq!(
            blend_mode(BlendMode::PlusLighter),
            Some(D2D1_BLEND_MODE_LINEAR_DODGE)
        );
    }

    #[test]
    fn outsets_cover_blurs_and_shadows() {
        assert_eq!(filters_outset(&[Filter::Blur(px(4.0))]), 12.0);
        let s = Filter::DropShadow {
            offset_x: px(2.0),
            offset_y: px(6.0),
            blur: px(8.0),
            color: Color::BLACK,
        };
        assert_eq!(filters_outset(&[s]), 18.0);
    }
}
