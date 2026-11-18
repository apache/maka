//! The bitmaps `OffscreenCanvas` renders draw into and the encoding of what
//! they hold, shared by the macOS and iOS backends: both replay a drawing
//! with Core Graphics and encode it with ImageIO.

use nsh_core::canvas::render::{ImageFormat, RenderFailure};
use objc2_core_foundation::{CFMutableData, CFRetained, CFString};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo,
    CGImageByteOrderInfo, kCGColorSpaceSRGB,
};
use objc2_image_io::CGImageDestination;

/// A transparent `width` × `height` pixel bitmap context in sRGB, its
/// pixels 32-bit premultiplied BGRA (`[b, g, r, a]` in memory), rows top
/// first, its base space the pixels, y up (Core Graphics' own). sRGB tags
/// the images made of it, so they show the colors the screen shows.
/// [`RenderFailure::TooLarge`] when Core Graphics cannot make it: the size
/// is past what it takes or the memory for it could not be allocated.
pub fn bitmap_context(width: usize, height: usize) -> Result<CFRetained<CGContext>, RenderFailure> {
    // SAFETY: an extern static Core Graphics defines, read once.
    let name = unsafe { kCGColorSpaceSRGB };
    let space = CGColorSpace::with_name(Some(name)).ok_or("the sRGB color space is unavailable")?;
    let bytes_per_row = width
        .checked_mul(4)
        .ok_or_else(|| too_large(width, height))?;
    // SAFETY: a null data pointer makes Core Graphics allocate the bitmap;
    // 8 bits per component and 4 bytes per pixel match the premultiplied
    // 32-bit layout asked for.
    unsafe {
        CGBitmapContextCreate(
            std::ptr::null_mut(),
            width,
            height,
            8,
            bytes_per_row,
            Some(&space),
            CGImageAlphaInfo::PremultipliedFirst.0 | CGImageByteOrderInfo::Order32Little.0,
        )
    }
    .ok_or_else(|| too_large(width, height))
}

fn too_large(width: usize, height: usize) -> RenderFailure {
    RenderFailure::TooLarge(format!(
        "the system could not allocate a {width}×{height} bitmap"
    ))
}

/// `image` encoded as `format` with ImageIO, or why it could not be.
pub fn encode(image: &CGImage, format: ImageFormat) -> Result<Vec<u8>, RenderFailure> {
    let uti = match format {
        ImageFormat::Png => "public.png",
        other => return Err(format!("{other:?} images are not supported").into()),
    };
    let failed = || RenderFailure::from("the image could not be encoded");
    let out = CFMutableData::new(None, 0).ok_or_else(failed)?;
    // SAFETY: a valid mutable data and type identifier, no options; one
    // image added before `finalize`.
    unsafe {
        let destination = CGImageDestination::with_data(&out, &CFString::from_str(uti), 1, None)
            .ok_or_else(failed)?;
        destination.add_image(image, None);
        if destination.finalize() {
            Ok(out.to_vec())
        } else {
            Err(failed())
        }
    }
}
