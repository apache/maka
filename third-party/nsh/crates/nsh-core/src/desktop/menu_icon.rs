//! What the desktop backends share of a menu item's icon
//! ([`MenuAction::icon`](super::MenuAction::icon)): the size it is drawn at
//! and the pixel work a menu that takes bitmaps needs. Loading is the
//! backends' image pipeline ([`crate::image`]), as for any image: off the
//! main thread, so a menu never waits for an icon, and through the same
//! caches. An SVG is a template: only its alpha counts, painted in the
//! color of the menu's text, which a bitmap keeps its own colors against.

use crate::{
    Color, ResizeMode,
    geometry::{DevicePixels, Points, Size, size},
    image::Want,
};

/// The side of the square an icon is fitted in, in points: macOS's menu
/// image size, which GPUI's rows use too; Windows' comes from
/// `SM_CXSMICON` at the window's DPI.
pub const SIDE: Points = Points(16.0);

/// What to ask the image pipeline for: the icon fitted in [`SIDE`] at
/// `scale` device pixels per point. A decode's size is rounded up to a
/// size bucket, so it may come back larger than the box.
pub fn want(scale: f32) -> Want {
    Want {
        size: size(SIDE, SIDE),
        scale,
        mode: ResizeMode::Contain,
    }
}

/// The size an image of `pixels` shows at in a square of `side`: its aspect
/// ratio kept and its longer side `side` long, so a small bitmap grows as a
/// large one shrinks and every icon of a menu has the same visual weight.
pub fn fitted(pixels: Size<DevicePixels>, side: Points) -> Size<Points> {
    let (w, h) = (pixels.width.0.max(1) as f32, pixels.height.0.max(1) as f32);
    let scale = side.0 / w.max(h);
    size(Points(w * scale), Points(h * scale))
}

/// `pixels` (premultiplied, four bytes each in any channel order, rows
/// packed) scaled to fit a `side` × `side` canvas and centered on it. Win32
/// menus size their icon column by the bitmaps themselves, so every icon
/// must be the full square for the labels to line up. Each new pixel
/// averages the source pixels it covers, which keeps thin strokes when an
/// icon shrinks and is exact when it stays the size it is.
pub fn canvas(pixels: &[u8], width: u32, height: u32, side: u32) -> Vec<u8> {
    let mut out = vec![0; side as usize * side as usize * 4];
    if width == 0 || height == 0 || pixels.len() < width as usize * height as usize * 4 {
        return out;
    }
    let fit = fitted(
        size(DevicePixels(width as i32), DevicePixels(height as i32)),
        Points(side as f32),
    );
    let (fit_w, fit_h) = (
        (fit.width.0.round() as u32).clamp(1, side),
        (fit.height.0.round() as u32).clamp(1, side),
    );
    let (left, top) = ((side - fit_w) / 2, (side - fit_h) / 2);
    for y in 0..fit_h {
        let (y0, y1) = span(y, fit_h, height);
        for x in 0..fit_w {
            let (x0, x1) = span(x, fit_w, width);
            let mut sum = [0.0_f32; 4];
            let mut weight = 0.0_f32;
            let mut sy = y0.floor();
            while sy < y1 {
                let wy = (y1.min(sy + 1.0) - y0.max(sy)).max(0.0);
                let mut sx = x0.floor();
                while sx < x1 {
                    let wx = (x1.min(sx + 1.0) - x0.max(sx)).max(0.0);
                    let at = (sy as usize * width as usize + sx as usize) * 4;
                    for (s, p) in sum.iter_mut().zip(&pixels[at..at + 4]) {
                        *s += *p as f32 * wx * wy;
                    }
                    weight += wx * wy;
                    sx += 1.0;
                }
                sy += 1.0;
            }
            let at = (((top + y) * side + left + x) * 4) as usize;
            for (o, s) in out[at..at + 4].iter_mut().zip(sum) {
                *o = (s / weight.max(f32::EPSILON)).round() as u8;
            }
        }
    }
    out
}

/// The source range pixel `i` of `count` covers along a side of `source`
/// pixels.
fn span(i: u32, count: u32, source: u32) -> (f32, f32) {
    let step = source as f32 / count as f32;
    (i as f32 * step, ((i + 1) as f32 * step).min(source as f32))
}

/// Paints `color` through the alpha of premultiplied BGRA `pixels`, in
/// place: a template icon in the color of the menu's text.
pub fn tint(pixels: &mut [u8], color: Color) {
    let (r, g, b, a) = color.to_f64();
    for px in pixels.as_chunks_mut::<4>().0 {
        let alpha = px[3] as f64 * a;
        let channel = |c: f64| (c * alpha).round() as u8;
        *px = [channel(b), channel(g), channel(r), alpha.round() as u8];
    }
}

/// Multiplies premultiplied `pixels` by `opacity`, in place: a bitmap icon
/// of a disabled item, which a menu that takes bitmaps draws as it is.
pub fn fade(pixels: &mut [u8], opacity: f32) {
    for channel in pixels {
        *channel = (*channel as f32 * opacity).round() as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixels(width: i32, height: i32) -> Size<DevicePixels> {
        size(DevicePixels(width), DevicePixels(height))
    }

    #[test]
    fn an_icon_fits_the_square_with_its_ratio() {
        assert_eq!(fitted(pixels(48, 48), SIDE), size(SIDE, SIDE));
        assert_eq!(fitted(pixels(64, 32), SIDE), size(SIDE, Points(8.0)));
        assert_eq!(fitted(pixels(32, 64), SIDE), size(Points(8.0), SIDE));
        // A small bitmap grows: the icons of a menu line up.
        assert_eq!(fitted(pixels(8, 8), SIDE), size(SIDE, SIDE));
        // A broken size divides by nothing.
        assert_eq!(fitted(pixels(0, 0), SIDE), size(SIDE, SIDE));
    }

    #[test]
    fn asks_for_the_box_at_the_screens_scale() {
        use crate::image::Natural;
        let want = want(2.0);
        // An SVG draws at the box's pixels, whatever size it declares; a
        // large bitmap decodes small, a small one is not enlarged.
        assert_eq!(
            want.longest(Natural::Vector(size(Points(24.0), Points(24.0))), 1.0, None),
            32
        );
        assert_eq!(want.longest(Natural::Pixels(512, 512), 1.0, None), 32);
        assert_eq!(want.longest(Natural::Pixels(16, 16), 1.0, None), 16);
    }

    #[test]
    fn a_canvas_of_the_same_size_copies() {
        let source: Vec<u8> = (0..16).collect();
        assert_eq!(canvas(&source, 2, 2, 2), source);
    }

    #[test]
    fn a_canvas_averages_what_it_shrinks() {
        let source = [
            0, 0, 0, 0, 100, 100, 100, 100, //
            200, 200, 200, 200, 100, 100, 100, 100,
        ];
        assert_eq!(canvas(&source, 2, 2, 1), [100, 100, 100, 100]);
    }

    #[test]
    fn a_canvas_centers_what_is_not_square() {
        // Two pixels wide, one high, on a 2 × 2 canvas: (2 - 1) / 2 rows
        // above it round down.
        let source = [10, 20, 30, 40, 50, 60, 70, 80];
        assert_eq!(
            canvas(&source, 2, 1, 2),
            [
                10, 20, 30, 40, 50, 60, 70, 80, //
                0, 0, 0, 0, 0, 0, 0, 0,
            ]
        );
        // A small square grows to fill the canvas.
        let dot = canvas(&[9, 9, 9, 9], 1, 1, 3);
        assert!(dot.iter().all(|c| *c == 9));
        // Wide on an odd canvas: the row in the middle.
        let wide = canvas(&[9; 9 * 4], 9, 1, 3);
        assert_eq!(&wide[..12], [0; 12]);
        assert_eq!(&wide[12..24], [9; 12]);
        assert_eq!(&wide[24..], [0; 12]);
    }

    #[test]
    fn a_canvas_of_nothing_is_empty() {
        assert_eq!(canvas(&[], 0, 0, 1), [0, 0, 0, 0]);
        assert_eq!(canvas(&[1, 2], 2, 2, 1), [0, 0, 0, 0], "too few bytes");
    }

    #[test]
    fn a_template_keeps_its_alpha_in_the_new_color() {
        // BGRA: half transparent white and fully opaque black.
        let mut px = [128, 128, 128, 128, 0, 0, 0, 255];
        tint(&mut px, Color::rgba(255, 0, 0, 255));
        assert_eq!(px, [0, 0, 128, 128, 0, 0, 255, 255]);
        // A translucent color scales the alpha, premultiplied.
        let mut px = [0, 0, 0, 255];
        tint(&mut px, Color::rgba(255, 255, 255, 128));
        assert_eq!(px, [128, 128, 128, 128]);
    }

    #[test]
    fn fading_scales_every_channel() {
        let mut px = [100, 50, 0, 200];
        fade(&mut px, 0.5);
        assert_eq!(px, [50, 25, 0, 100]);
    }
}
