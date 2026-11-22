//! `blurRadius`: a stack blur (a fast approximation of a Gaussian) of
//! decoded images, on the decoding queue. Pure Rust: no CoreImage or
//! Accelerate to load at launch.

use std::ffi::c_void;

use objc2_core_foundation::{CFRetained, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextCreateImage, CGBitmapContextGetBytesPerRow,
    CGBitmapContextGetData, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo,
    CGImageByteOrderInfo,
};

/// `image` blurred by `radius` pixels and passed through a 4×5 color
/// `matrix` (CSS filters on images).
pub(crate) fn filtered(
    image: &CGImage,
    radius: f64,
    matrix: Option<[f32; 20]>,
) -> Option<CFRetained<CGImage>> {
    let radius = radius.round().clamp(0.0, 254.0) as usize;
    let (width, height) = (CGImage::width(Some(image)), CGImage::height(Some(image)));
    if (radius == 0 && matrix.is_none()) || width == 0 || height == 0 {
        return None;
    }
    let space = CGColorSpace::new_device_rgb()?;
    // SAFETY: CoreGraphics allocates the pixels (null data) for an RGBA
    // context of these dimensions; the pointer is used while `context`
    // lives, within `bytes_per_row * height` bytes.
    unsafe {
        let context = CGBitmapContextCreate(
            std::ptr::null_mut::<c_void>(),
            width,
            height,
            8,
            width * 4,
            Some(&space),
            CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0,
        )?;
        CGContext::draw_image(
            Some(&context),
            CGRect::new(CGPoint::ZERO, CGSize::new(width as f64, height as f64)),
            Some(image),
        );
        let data = CGBitmapContextGetData(Some(&context)).cast::<u8>();
        if data.is_null() {
            return None;
        }
        let stride = CGBitmapContextGetBytesPerRow(Some(&context));
        let pixels = std::slice::from_raw_parts_mut(data, stride * height);
        if radius > 0 {
            stack_blur(pixels, width, height, stride, radius);
        }
        if let Some(m) = matrix {
            color_matrix(pixels, width, height, stride, &m);
        }
        CGBitmapContextCreateImage(Some(&context))
    }
}

/// Applies a 4×5 color matrix (unpremultiplied sRGB, offsets in 0..1) to
/// premultiplied RGBA pixels in place.
pub(crate) fn color_matrix(
    pixels: &mut [u8],
    width: usize,
    height: usize,
    stride: usize,
    m: &[f32; 20],
) {
    for y in 0..height {
        let row = &mut pixels[y * stride..y * stride + width * 4];
        for px in row.as_chunks_mut::<4>().0 {
            let a = px[3] as f32 / 255.0;
            if a == 0.0 && m[19] == 0.0 {
                continue;
            }
            let un = |c: u8| {
                if a > 0.0 {
                    (c as f32 / 255.0 / a).min(1.0)
                } else {
                    0.0
                }
            };
            let (r, g, b) = (un(px[0]), un(px[1]), un(px[2]));
            let out = |i: usize| {
                (m[i] * r + m[i + 1] * g + m[i + 2] * b + m[i + 3] * a + m[i + 4]).clamp(0.0, 1.0)
            };
            let na = out(15);
            px[0] = (out(0) * na * 255.0).round() as u8;
            px[1] = (out(5) * na * 255.0).round() as u8;
            px[2] = (out(10) * na * 255.0).round() as u8;
            px[3] = (na * 255.0).round() as u8;
        }
    }
}

/// Blurs RGBA pixels in place: rows, then columns.
pub(crate) fn stack_blur(
    pixels: &mut [u8],
    width: usize,
    height: usize,
    stride: usize,
    radius: usize,
) {
    let mut stack = vec![[0u32; 4]; 2 * radius + 1];
    for y in 0..height {
        blur_line(pixels, y * stride, 4, width, radius, &mut stack);
    }
    for x in 0..width {
        blur_line(pixels, x * 4, stride, height, radius, &mut stack);
    }
}

/// One stack blur pass over `count` pixels starting at byte `start`,
/// `step` bytes apart. Reads only ahead of what it writes, so it works in
/// place; the stack keeps the original values.
fn blur_line(
    pixels: &mut [u8],
    start: usize,
    step: usize,
    count: usize,
    radius: usize,
    stack: &mut [[u32; 4]],
) {
    if count == 0 {
        return;
    }
    let div = 2 * radius + 1;
    let last = count - 1;
    let pixel = |pixels: &[u8], i: usize| -> [u32; 4] {
        let at = start + i.min(last) * step;
        [
            pixels[at] as u32,
            pixels[at + 1] as u32,
            pixels[at + 2] as u32,
            pixels[at + 3] as u32,
        ]
    };
    let (mut sum, mut sum_in, mut sum_out) = ([0u32; 4], [0u32; 4], [0u32; 4]);
    for (i, slot) in stack.iter_mut().enumerate().take(radius + 1) {
        let p = pixel(pixels, 0);
        *slot = p;
        for c in 0..4 {
            sum[c] += p[c] * (i as u32 + 1);
            sum_out[c] += p[c];
        }
    }
    for i in 1..=radius {
        let p = pixel(pixels, i);
        stack[i + radius] = p;
        for c in 0..4 {
            sum[c] += p[c] * (radius + 1 - i) as u32;
            sum_in[c] += p[c];
        }
    }
    let weight = ((radius + 1) * (radius + 1)) as u32;
    let mut sp = radius;
    for x in 0..count {
        let at = start + x * step;
        for c in 0..4 {
            pixels[at + c] = (sum[c] / weight) as u8;
            sum[c] -= sum_out[c];
        }
        let slot = (sp + div - radius) % div;
        let incoming = pixel(pixels, x + radius + 1);
        for c in 0..4 {
            sum_out[c] -= stack[slot][c];
            sum_in[c] += incoming[c];
            sum[c] += sum_in[c];
        }
        stack[slot] = incoming;
        sp = (sp + 1) % div;
        for c in 0..4 {
            sum_out[c] += stack[sp][c];
            sum_in[c] -= stack[sp][c];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spreads_a_point_and_keeps_flat_areas() {
        let (w, h) = (9, 9);
        let mut px = vec![0u8; w * h * 4];
        let center = (4 * w + 4) * 4;
        px[center..center + 4].copy_from_slice(&[255, 255, 255, 255]);
        stack_blur(&mut px, w, h, w * 4, 2);
        assert!(px[center + 3] < 255 && px[center + 3] > 0);
        assert!(px[((4 * w + 5) * 4) + 3] > 0, "spread to the neighbor");
        let mut flat = vec![100u8; w * h * 4];
        stack_blur(&mut flat, w, h, w * 4, 3);
        assert!(flat.iter().all(|&v| v == 100));
    }
}
