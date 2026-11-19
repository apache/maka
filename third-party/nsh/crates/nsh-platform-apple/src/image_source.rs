//! What the macOS and iOS backends read alike from an ImageIO source: which
//! of its images to show, its size and its frames' delays.
//!
//! A file of several images is an animation only in a format that animates
//! (GIF, APNG, animated WebP, HEIF and AVIF sequences, JPEG XL): every frame
//! plays. An icon (ICO, ICNS, CUR) holds one picture at several sizes and
//! shows the one that fits the size shown, as browsers show a favicon. Any
//! other file of several images (TIFF pages, HEIC collections, MPO) shows
//! its primary image, as the other platforms and the natural size do.

use std::ops::Range;

use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFString, CFType};
use objc2_image_io::CGImageSource;

/// The type identifiers of the formats whose images, when a file holds
/// several, are the frames of an animation.
const ANIMATIONS: &[&str] = &[
    "com.compuserve.gif",
    "public.png",
    "org.webmproject.webp",
    "public.heics",
    "public.avis",
    "public.avif",
    "public.jpeg-xl",
];

/// The type identifiers of the icon formats, whose images are one picture
/// at several sizes.
const ICONS: &[&str] = &["com.microsoft.ico", "com.apple.icns", "com.microsoft.cur"];

/// The indices of the images of `source` to decode: the frames of an
/// animation (at most `max_frames`), or the one image of a still file
/// (`still`).
pub fn shown(source: &CGImageSource, longest: u32, max_frames: usize) -> Range<usize> {
    if is_animation(source) {
        // SAFETY: a plain query of a valid source.
        return 0..unsafe { source.count() }.clamp(1, max_frames.max(1));
    }
    let still = still(source, longest);
    still..still + 1
}

/// Whether `source` is an animation: several images in a format that
/// animates.
pub fn is_animation(source: &CGImageSource) -> bool {
    // SAFETY: a plain query of a valid source.
    let count = unsafe { source.count() };
    count > 1 && is_kind(source, ANIMATIONS)
}

/// Whether the type of `source` is one of `kinds`.
fn is_kind(source: &CGImageSource, kinds: &[&str]) -> bool {
    // SAFETY: a plain query of a valid source.
    unsafe { source.r#type() }.is_some_and(|kind| kinds.contains(&kind.to_string().as_str()))
}

/// The image of a still `source` to show `longest` pixels long. An icon's
/// is the smallest at least that long, or the largest when none is (or
/// `longest` is 0), a full-color one before an indexed one the same size;
/// any other file's is its primary image, whatever the size shown.
pub fn still(source: &CGImageSource, longest: u32) -> usize {
    // SAFETY: a plain query of a valid source.
    let count = unsafe { source.count() };
    if count <= 1 {
        return 0;
    }
    if !is_kind(source, ICONS) {
        // SAFETY: a plain query of a valid source.
        let primary = unsafe { source.primary_image_index() };
        return if primary < count { primary } else { 0 };
    }
    let images: Vec<(usize, u32, bool)> = (0..count)
        .map(|i| {
            let image = Properties::of(source, i);
            (i, image.width.max(image.height), image.indexed)
        })
        .collect();
    let largest = images
        .iter()
        .max_by_key(|(i, side, indexed)| (*side, !*indexed, std::cmp::Reverse(*i)));
    let fitting = images
        .iter()
        .filter(|(_, side, _)| longest > 0 && *side >= longest)
        .min_by_key(|(i, side, indexed)| (*side, *indexed, *i));
    fitting.or(largest).map_or(0, |(i, ..)| *i)
}

/// The natural pixel size of `source`, as displayed (EXIF orientations 5–8
/// turn it a quarter): the size of the image it shows when nothing asks
/// for a size (an animation's first frame, an icon's largest image, any
/// other file's primary image).
pub fn source_size(source: &CGImageSource) -> (u32, u32) {
    let index = match is_animation(source) {
        true => 0,
        false => still(source, 0),
    };
    image_size(source, index)
}

/// The pixel size of image `index` of `source`, as displayed (EXIF
/// orientations 5–8 turn it a quarter).
pub fn image_size(source: &CGImageSource, index: usize) -> (u32, u32) {
    Properties::of(source, index).size()
}

/// What choosing and sizing an image reads of its properties, read at once.
#[derive(Default)]
struct Properties {
    width: u32,
    height: u32,
    orientation: u32,
    indexed: bool,
}

impl Properties {
    /// The properties of image `index` of `source` (zeros when it has
    /// none).
    fn of(source: &CGImageSource, index: usize) -> Self {
        use objc2_image_io::{
            kCGImagePropertyIsIndexed, kCGImagePropertyOrientation, kCGImagePropertyPixelHeight,
            kCGImagePropertyPixelWidth,
        };
        // SAFETY: a CoreFoundation dictionary of CFString keys, read with
        // the documented ImageIO keys and value types.
        unsafe {
            let Some(props) = source.properties_at_index(index, None) else {
                return Self::default();
            };
            let props: &CFDictionary<CFString, CFType> = props.cast_unchecked();
            let number = |key: &CFString| {
                props
                    .get(key)
                    .and_then(|v| v.downcast_ref::<CFNumber>().and_then(|n| n.as_i64()))
                    .unwrap_or(0)
                    .clamp(0, u32::MAX as i64) as u32
            };
            Self {
                width: number(kCGImagePropertyPixelWidth),
                height: number(kCGImagePropertyPixelHeight),
                orientation: number(kCGImagePropertyOrientation),
                indexed: props
                    .get(kCGImagePropertyIsIndexed)
                    .and_then(|v| v.downcast_ref::<CFBoolean>().map(|b| b.as_bool()))
                    .unwrap_or(false),
            }
        }
    }

    /// The size as displayed.
    fn size(&self) -> (u32, u32) {
        match self.orientation {
            5..=8 => (self.height, self.width),
            _ => (self.width, self.height),
        }
    }
}

/// The delay of frame `i` in centiseconds (GIF's unit), at least 2 (as
/// browsers: shorter ones show for 10).
pub fn frame_delay(source: &CGImageSource, i: usize) -> u32 {
    use objc2_image_io::{
        kCGImagePropertyAPNGDelayTime, kCGImagePropertyAPNGUnclampedDelayTime,
        kCGImagePropertyGIFDelayTime, kCGImagePropertyGIFDictionary,
        kCGImagePropertyGIFUnclampedDelayTime, kCGImagePropertyHEICSDelayTime,
        kCGImagePropertyHEICSDictionary, kCGImagePropertyHEICSUnclampedDelayTime,
        kCGImagePropertyPNGDictionary, kCGImagePropertyWebPDelayTime,
        kCGImagePropertyWebPDictionary, kCGImagePropertyWebPUnclampedDelayTime,
    };
    // SAFETY: CoreFoundation dictionaries of CFString keys, read with the
    // documented ImageIO keys and value types.
    let seconds = unsafe {
        source.properties_at_index(i, None).and_then(|props| {
            let props: &CFDictionary<CFString, CFType> = props.cast_unchecked();
            [
                (
                    kCGImagePropertyGIFDictionary,
                    kCGImagePropertyGIFUnclampedDelayTime,
                    kCGImagePropertyGIFDelayTime,
                ),
                (
                    kCGImagePropertyPNGDictionary,
                    kCGImagePropertyAPNGUnclampedDelayTime,
                    kCGImagePropertyAPNGDelayTime,
                ),
                (
                    kCGImagePropertyWebPDictionary,
                    kCGImagePropertyWebPUnclampedDelayTime,
                    kCGImagePropertyWebPDelayTime,
                ),
                (
                    kCGImagePropertyHEICSDictionary,
                    kCGImagePropertyHEICSUnclampedDelayTime,
                    kCGImagePropertyHEICSDelayTime,
                ),
            ]
            .into_iter()
            .find_map(|(dict, unclamped, clamped)| {
                let format = props.get(dict)?;
                let format: &CFDictionary<CFString, CFType> =
                    format.downcast_ref::<CFDictionary>()?.cast_unchecked();
                let number = |key| {
                    format
                        .get(key)
                        .and_then(|v| v.downcast_ref::<CFNumber>().and_then(|n| n.as_cgfloat()))
                        .filter(|s| *s > 0.0)
                };
                number(unclamped).or_else(|| number(clamped))
            })
        })
    };
    match seconds {
        Some(s) if s >= 0.02 => (s * 100.0).round() as u32,
        _ => 10,
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::canvas::render::ImageFormat;
    use objc2_core_foundation::{CFData, CFMutableData, CFRetained, CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{CGBitmapContextCreateImage, CGContext, CGImage};
    use objc2_image_io::CGImageDestination;

    use super::*;
    use crate::canvas_image::{bitmap_context, encode};

    /// An opaque `side` × `side` image.
    fn image(side: usize) -> CFRetained<CGImage> {
        let context = bitmap_context(side, side).unwrap();
        let all = CGRect::new(CGPoint::ZERO, CGSize::new(side as f64, side as f64));
        CGContext::fill_rect(Some(&context), all);
        CGBitmapContextCreateImage(Some(&context)).unwrap()
    }

    /// An `side` × `side` PNG.
    fn png(side: usize) -> Vec<u8> {
        encode(&image(side), ImageFormat::Png).unwrap()
    }

    /// Images `sides` pixels square, in that order, in one file of type
    /// `uti` written by ImageIO (a GIF's frames, a TIFF's pages).
    fn written(uti: &str, sides: &[usize]) -> Vec<u8> {
        let out = CFMutableData::new(None, 0).unwrap();
        // SAFETY: a valid mutable data and type identifier, no options;
        // `sides.len()` images added before `finalize`.
        unsafe {
            let destination =
                CGImageDestination::with_data(&out, &CFString::from_str(uti), sides.len(), None)
                    .unwrap();
            for side in sides {
                destination.add_image(&image(*side), None);
            }
            assert!(destination.finalize());
        }
        out.to_vec()
    }

    /// An ICO of PNGs `sides` pixels square, in that order, as favicons
    /// are.
    fn ico(sides: &[usize]) -> Vec<u8> {
        let entries: Vec<_> = sides.iter().map(|side| (*side, 32, png(*side))).collect();
        icon_file(&entries)
    }

    /// An ICO of `(side, bits per pixel, encoded image)` entries, in that
    /// order.
    fn icon_file(entries: &[(usize, u16, Vec<u8>)]) -> Vec<u8> {
        let mut out = vec![0, 0, 1, 0, entries.len() as u8, 0];
        let mut offset = 6 + 16 * entries.len();
        for (side, bits, data) in entries {
            let side = (*side % 256) as u8;
            let colors = if *bits < 8 { 1u8 << bits } else { 0 };
            out.extend([side, side, colors, 0, 1, 0]);
            out.extend(bits.to_le_bytes());
            out.extend((data.len() as u32).to_le_bytes());
            out.extend((offset as u32).to_le_bytes());
            offset += data.len();
        }
        for (.., data) in entries {
            out.extend(data);
        }
        out
    }

    /// A `side` × `side` ICO bitmap of `bits` per pixel: its header, a
    /// palette when it has one, its pixels and an all-opaque mask.
    fn bmp(side: usize, bits: u16) -> Vec<u8> {
        let mut out = Vec::new();
        for value in [40, side as u32, 2 * side as u32] {
            out.extend(value.to_le_bytes());
        }
        out.extend(1u16.to_le_bytes());
        out.extend(bits.to_le_bytes());
        out.extend([0; 24]);
        if bits < 8 {
            for i in 0..1u32 << bits {
                out.extend([(i * 16) as u8, 0x40, 0x80, 0]);
            }
        }
        let row = (side * bits as usize).div_ceil(32) * 4;
        out.extend(std::iter::repeat_n(0xff, row * side));
        out.extend(std::iter::repeat_n(0, side.div_ceil(32) * 4 * side));
        out
    }

    fn source(bytes: &[u8]) -> CFRetained<CGImageSource> {
        // SAFETY: valid data.
        unsafe { CGImageSource::with_data(&CFData::from_bytes(bytes), None) }.unwrap()
    }

    /// The longest side of the one image `range` holds.
    fn side(source: &CGImageSource, range: Range<usize>) -> u32 {
        assert_eq!(range.len(), 1, "one image");
        let (w, h) = image_size(source, range.start);
        w.max(h)
    }

    #[test]
    fn a_multi_size_icon_shows_the_image_that_fits() {
        for sides in [[16, 32, 48], [48, 32, 16], [32, 16, 48]] {
            let icon = source(&ico(&sides));
            assert!(!is_animation(&icon), "{sides:?} is no animation");
            assert_eq!(side(&icon, shown(&icon, 24, 600)), 32);
            assert_eq!(side(&icon, shown(&icon, 32, 600)), 32);
            assert_eq!(side(&icon, shown(&icon, 12, 600)), 16);
            assert_eq!(
                side(&icon, shown(&icon, 64, 600)),
                48,
                "none fits: the largest"
            );
            assert_eq!(
                side(&icon, shown(&icon, 0, 600)),
                48,
                "natural size: the largest"
            );
            assert_eq!(side(&icon, shown(&icon, 24, 1)), 32);
            assert_eq!(source_size(&icon), (48, 48));
        }
    }

    #[test]
    fn an_icon_prefers_full_color_to_a_palette_the_same_size() {
        for entries in [[(16, 4), (16, 32)], [(16, 32), (16, 4)]] {
            let entries: Vec<_> = entries
                .iter()
                .map(|(side, bits)| (*side, *bits, bmp(*side, *bits)))
                .collect();
            let icon = source(&icon_file(&entries));
            // SAFETY: a plain query of a valid source.
            assert_eq!(unsafe { icon.count() }, 2);
            for longest in [0, 16] {
                let shown = shown(&icon, longest, 600);
                assert_eq!(side(&icon, shown.clone()), 16);
                assert!(!Properties::of(&icon, shown.start).indexed);
            }
        }
    }

    #[test]
    fn a_multi_page_tiff_shows_its_first_page() {
        for sides in [[40, 20], [20, 40]] {
            let tiff = source(&written("public.tiff", &sides));
            assert!(!is_animation(&tiff));
            let first = sides[0] as u32;
            for longest in [0, 16, 30, 64] {
                assert_eq!(
                    shown(&tiff, longest, 600),
                    0..1,
                    "{sides:?} at {longest}: the first page, whatever the size shown"
                );
            }
            assert_eq!(side(&tiff, shown(&tiff, 16, 1)), first);
            assert_eq!(source_size(&tiff), (first, first), "{sides:?}");
        }
    }

    #[test]
    fn an_animation_plays_every_frame() {
        let gif = source(&written("com.compuserve.gif", &[8, 8, 8]));
        assert!(is_animation(&gif));
        assert_eq!(shown(&gif, 4, 600), 0..3);
        assert_eq!(shown(&gif, 4, 2), 0..2);
        assert_eq!(shown(&gif, 0, 1), 0..1, "its first frame alone");
        assert_eq!(frame_delay(&gif, 1), 10);
    }

    #[test]
    fn a_single_image_is_shown_whole() {
        let png = source(&png(8));
        assert!(!is_animation(&png));
        assert_eq!(shown(&png, 4, 600), 0..1);
        assert_eq!(source_size(&png), (8, 8));
    }
}
