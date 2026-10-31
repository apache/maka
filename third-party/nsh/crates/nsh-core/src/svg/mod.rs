//! SVG images for the native backends (feature `svg`), and SVGs as
//! canvas drawings ([`drawing`], what `element::svg` shows).
//!
//! The platforms' image decoders (ImageIO, `BitmapFactory`, WIC, GDK) do not
//! read SVG, so every native backend hands sniffed SVG bytes to this module
//! and draws the premultiplied RGBA [`Raster`] it gets back through its usual
//! bitmap path (tint, blur and `objectFit` included). One renderer, resvg,
//! draws them on every platform, so an SVG looks the same everywhere. The web
//! runtime does not enable the feature: the browser draws SVG itself.
//!
//! An SVG is a self-contained picture here: usvg gets no resources directory
//! and an `<image>` resolver that resolves nothing, so `href`s to files, URLs
//! or `data:` never load, and its font database is empty, so `<text>` is not
//! drawn (the main workspace also builds resvg without its `text`,
//! `system-fonts` and `raster-images` features; GPUI's workspace turns them
//! on for GPUI). Remote SVGs come through each backend's own fetch, with its
//! capability checks.
//!
//! An SVG from the network is untrusted input, so what drawing one takes is
//! bounded: a document of at most [`MAX_BYTES`] (a `.svgz` once inflated), a
//! raster of at most [`MAX_SIDE`] pixels a side and [`MAX_PIXELS`] in all, and
//! layers (resvg draws every group with opacity, a mask, a clip path, filters
//! or a blend mode into a pixmap of its own, and nested ones coexist) of at
//! most [`MAX_LAYER_PIXELS`] at once by a conservative estimate made before
//! drawing (`layers.rs`). A panic in the parser or the renderer is an
//! [`Error`] too: the backends call these functions where an unwinding panic
//! would abort the process (GCD blocks, JNI functions).
//!
//! Sizes are in points: a CSS pixel of the SVG (its root `width` / `height`,
//! else its `viewBox`) is one point. Icons and logos carry a `viewBox`; one
//! without a size and a `viewBox` reaches as far as what it draws.

use std::{fmt, io::Read, panic};

use resvg::{
    tiny_skia,
    usvg::{self, roxmltree},
};

use crate::geometry::{DevicePixels, Points, Size};

mod drawing;
#[cfg(not(target_arch = "wasm32"))]
pub(crate) mod drawings;
mod layers;
#[cfg(test)]
mod tests;

pub use self::drawing::drawing;

/// How much of a compressed SVG (`.svgz`) [`sniff`] inflates to find the
/// root element.
const SNIFF_INFLATED: u64 = 4096;

/// The largest SVG document read, in bytes (a `.svgz` once inflated):
/// larger ones are refused rather than filling memory.
pub const MAX_BYTES: usize = 16 << 20;

/// The longest side of a raster, in pixels: a sanity limit, as large as
/// the textures GPUs take.
pub const MAX_SIDE: u32 = 8192;

/// The most pixels of a raster (64 MiB of RGBA): a full-screen image on a
/// 5K display (14.7 million pixels) fits. A raster asked for larger is drawn
/// smaller, with its aspect ratio.
pub const MAX_PIXELS: u32 = 1 << 24;

/// The most pixels of layers drawing an SVG may hold at once beside its
/// raster, four rasters' worth (256 MiB), by the estimate of `layers.rs`:
/// an SVG over it is refused.
pub const MAX_LAYER_PIXELS: u32 = 4 * MAX_PIXELS;

/// How many pixels per point backends that draw one raster at every size
/// (Windows, Linux, GPUI) render an SVG at, so it stays sharp when shown
/// larger than its intrinsic size or on high-density screens.
pub const OVERSAMPLE: u32 = 4;

/// The longest side of an oversampled raster ([`rasterize_oversampled`]),
/// in pixels.
pub const MAX_OVERSAMPLED_SIDE: u32 = 2048;

/// A drawn SVG: premultiplied RGBA, row by row without padding.
#[derive(Debug, Clone, PartialEq, Default)]
#[non_exhaustive]
pub struct Raster {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// `width * height * 4` bytes of premultiplied RGBA.
    pub pixels: Vec<u8>,
    /// The SVG's intrinsic size (what [`size`] returns).
    pub size: Size<Points>,
}

/// Why an SVG could not be read or drawn.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Error {
    /// The bytes are no SVG document: not UTF-8, malformed XML or gzip
    /// data, or a root that is not `<svg>`; what the parser said.
    Invalid(String),
    /// The document is larger than [`MAX_BYTES`] (a `.svgz` once inflated).
    TooLarge,
    /// The SVG has no area: a width or height of zero or less, or neither a
    /// size, a `viewBox` nor anything drawn to measure it by.
    NoArea,
    /// The raster asked for has no pixels (a size or scale of zero).
    NoPixels,
    /// Drawing it would hold more than [`MAX_LAYER_PIXELS`] pixels of
    /// layers at once: about `pixels`.
    OverBudget {
        /// The estimate, in pixels.
        pixels: u64,
    },
    /// Drawing it would visit more nodes than a document may hold: shared
    /// patterns, masks and clip paths count each time they are drawn.
    TooManyNodes,
    /// The parser or the renderer panicked on it.
    Panicked,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Invalid(reason) => write!(f, "invalid SVG: {reason}"),
            Error::TooLarge => write!(
                f,
                "the SVG document is larger than {} MiB (a .svgz once inflated)",
                MAX_BYTES >> 20
            ),
            Error::NoArea => write!(
                f,
                "the SVG has no area: a zero width or height, or nothing to size it by"
            ),
            Error::NoPixels => write!(f, "an SVG raster of no pixels was asked for"),
            Error::OverBudget { pixels } => write!(
                f,
                "drawing the SVG would hold about {pixels} pixels of layers at once, over the \
                 {MAX_LAYER_PIXELS} allowed"
            ),
            Error::TooManyNodes => write!(
                f,
                "drawing the SVG would visit more than {} nodes",
                layers::MAX_VISITS
            ),
            Error::Panicked => write!(f, "the SVG renderer panicked on this document"),
        }
    }
}

impl std::error::Error for Error {}

/// Whether `bytes` are an SVG image: the root element is `<svg`, after an
/// optional byte order mark, XML declaration, comments and doctype, or the
/// same compressed with gzip (`.svgz`). File names and MIME types are never
/// trusted; this looks at the bytes.
pub fn sniff(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut head = Vec::new();
        // A truncated read still holds the start of the document.
        let _ = flate2::read::GzDecoder::new(bytes)
            .take(SNIFF_INFLATED)
            .read_to_end(&mut head);
        return sniff_text(&head);
    }
    sniff_text(bytes)
}

fn sniff_text(bytes: &[u8]) -> bool {
    let mut rest = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    loop {
        rest = rest.trim_ascii_start();
        let skipped = if rest.starts_with(b"<?") {
            after(rest, b"?>")
        } else if rest.starts_with(b"<!--") {
            after(rest, b"-->")
        } else if rest.starts_with(b"<!") {
            // A doctype, maybe with an internal subset (`[ ... ]`).
            match (find(rest, b"["), find(rest, b">")) {
                (Some(open), Some(close)) if open < close => {
                    after(&rest[open..], b"]").and_then(|r| after(r, b">"))
                }
                _ => after(rest, b">"),
            }
        } else {
            break;
        };
        match skipped {
            Some(r) => rest = r,
            None => return false,
        }
    }
    rest.starts_with(b"<svg")
        && matches!(
            rest.get(4),
            Some(b' ' | b'\t' | b'\r' | b'\n' | b'>' | b'/')
        )
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn after<'a>(haystack: &'a [u8], needle: &[u8]) -> Option<&'a [u8]> {
    find(haystack, needle).map(|i| &haystack[i + needle.len()..])
}

/// Runs `f`, turning a panic into [`Error::Panicked`].
fn guarded<T>(f: impl FnOnce() -> Result<T, Error>) -> Result<T, Error> {
    // Nothing `f` touches outlives it, so a half-done parse or drawing is
    // never seen again.
    panic::catch_unwind(panic::AssertUnwindSafe(f)).unwrap_or(Err(Error::Panicked))
}

/// The options every SVG is parsed with: nothing outside the document is
/// read (no resources directory, `<image>` `href`s resolve to nothing).
fn options() -> usvg::Options<'static> {
    usvg::Options {
        resources_dir: None,
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: Box::new(|_, _, _| None),
            resolve_string: Box::new(|_, _| None),
        },
        ..usvg::Options::default()
    }
}

/// Parses an SVG (or gzip-compressed SVG) with the safe [`options`].
fn parse(bytes: &[u8]) -> Result<usvg::Tree, Error> {
    parse_with(bytes, &options())
}

fn parse_with(bytes: &[u8], options: &usvg::Options<'_>) -> Result<usvg::Tree, Error> {
    let inflated;
    let bytes = if bytes.starts_with(&[0x1f, 0x8b]) {
        inflated = inflate(bytes)?;
        &inflated[..]
    } else if bytes.len() > MAX_BYTES {
        return Err(Error::TooLarge);
    } else {
        bytes
    };
    let text = std::str::from_utf8(bytes).map_err(|_| Error::Invalid("not UTF-8".into()))?;
    let doc = xml(text)?;
    let Some(side) = OneSide::of(&doc, text) else {
        return convert(&doc, options);
    };
    // A root with only a width or only a height takes the other from the
    // viewBox's aspect ratio, as in browsers (usvg makes it 100%). The
    // missing side goes into the text before usvg converts it, which takes
    // the given side in points: read here for absolute units, else from a
    // first conversion.
    let given = match side.points() {
        Some(points) => points,
        None => side.given(convert(&doc, options)?.size()),
    };
    convert(&xml(&side.completed(text, given))?, options)
}

fn xml(text: &str) -> Result<roxmltree::Document<'_>, Error> {
    let options = roxmltree::ParsingOptions {
        allow_dtd: true,
        ..roxmltree::ParsingOptions::default()
    };
    roxmltree::Document::parse_with_options(text, options)
        .map_err(|e| Error::Invalid(e.to_string()))
}

fn convert(
    doc: &roxmltree::Document<'_>,
    options: &usvg::Options<'_>,
) -> Result<usvg::Tree, Error> {
    usvg::Tree::from_xmltree(doc, options).map_err(|e| match e {
        usvg::Error::InvalidSize => Error::NoArea,
        e => Error::Invalid(e.to_string()),
    })
}

/// A root `<svg>` with a `viewBox` and only one of `width` and `height`
/// (not a percentage).
struct OneSide<'a> {
    /// `width` is the one given (else `height`).
    width: bool,
    /// Its value as written.
    value: &'a str,
    /// The `viewBox`'s width and height.
    view_box: (f32, f32),
    /// Where the missing attribute goes in the text: after the root's tag
    /// name.
    at: usize,
}

impl<'a> OneSide<'a> {
    fn of(doc: &'a roxmltree::Document<'_>, text: &str) -> Option<OneSide<'a>> {
        let root = doc.root_element();
        let view_box: Vec<f32> = root
            .attribute("viewBox")?
            .split(|c: char| c.is_ascii_whitespace() || c == ',')
            .filter(|s| !s.is_empty())
            .filter_map(|s| s.parse().ok())
            .collect();
        let [_, _, vw, vh] = view_box[..] else {
            return None;
        };
        if !(vw > 0.0 && vh > 0.0) {
            return None;
        }
        let (width, value) = match (root.attribute("width"), root.attribute("height")) {
            (Some(value), None) => (true, value),
            (None, Some(value)) => (false, value),
            _ => return None,
        };
        if value.trim_end().ends_with('%') {
            return None;
        }
        Some(OneSide {
            width,
            value,
            view_box: (vw, vh),
            at: root_attributes_at(doc, text),
        })
    }

    /// The given side in points (CSS pixels), for a number in an absolute
    /// unit; `None` for the others (`em`, `ex`), which usvg resolves.
    fn points(&self) -> Option<f32> {
        let value = self.value.trim();
        // Longer ones are no length anyone writes: usvg reads them.
        if value.len() > 32 {
            return None;
        }
        let (number, unit) = (1..=value.len())
            .rev()
            .filter(|&i| value.is_char_boundary(i))
            .find_map(|i| Some((value[..i].parse::<f32>().ok()?, &value[i..])))?;
        let per_unit = match unit {
            "" | "px" => 1.0,
            "in" => 96.0,
            "cm" => 96.0 / 2.54,
            "mm" => 96.0 / 25.4,
            "pt" => 4.0 / 3.0,
            "pc" => 16.0,
            _ => return None,
        };
        Some(number * per_unit).filter(|p| p.is_finite())
    }

    /// The given side of a tree usvg converted with it (and the other at
    /// 100%).
    fn given(&self, size: usvg::Size) -> f32 {
        if self.width {
            size.width()
        } else {
            size.height()
        }
    }

    /// `text` with the missing side added, `given` points being the other.
    fn completed(&self, text: &str, given: f32) -> String {
        let (vw, vh) = self.view_box;
        let added = if self.width {
            format!(" height=\"{}\"", given * vh / vw)
        } else {
            format!(" width=\"{}\"", given * vw / vh)
        };
        let mut fixed = String::with_capacity(text.len() + added.len());
        fixed.push_str(&text[..self.at]);
        fixed.push_str(&added);
        fixed.push_str(&text[self.at..]);
        fixed
    }
}

/// Where an attribute added to the root element goes in `text`, the
/// document `doc` was parsed from: after the root's tag name.
fn root_attributes_at(doc: &roxmltree::Document<'_>, text: &str) -> usize {
    let start = doc.root_element().range().start + 1;
    text[start..]
        .find(|c: char| c.is_ascii_whitespace() || c == '>' || c == '/')
        .map_or(text.len(), |i| start + i)
}

/// Inflates a `.svgz` up to [`MAX_BYTES`].
fn inflate(bytes: &[u8]) -> Result<Vec<u8>, Error> {
    let mut inflated = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut inflated)
        .map_err(|_| Error::Invalid("malformed gzip data".into()))?;
    if inflated.len() > MAX_BYTES {
        return Err(Error::TooLarge);
    }
    Ok(inflated)
}

/// The size of usvg's tree, typed.
fn points(size: usvg::Size) -> Size<Points> {
    Size::new(Points(size.width()), Points(size.height()))
}

/// The intrinsic size of an SVG in points: its root `width` and `height`
/// (percentages of the `viewBox`; one of them alone takes the other from
/// the `viewBox`'s aspect ratio), else the `viewBox`'s size. An SVG with
/// neither a size nor a `viewBox` reaches as far as what it draws.
pub fn size(bytes: &[u8]) -> Result<Size<Points>, Error> {
    guarded(|| Ok(points(parse(bytes)?.size())))
}

/// The size `onLoad` and `Image.getSize` report for an SVG of `size`
/// points: whole points, at least one, carried in [`DevicePixels`] as
/// bitmaps' sizes in pixels are.
pub fn reported_size(size: Size<Points>) -> Size<DevicePixels> {
    let whole = |p: Points| DevicePixels(p.0.round().clamp(1.0, i32::MAX as f32) as i32);
    Size::new(whole(size.width), whole(size.height))
}

/// Draws an SVG with its longest side `max_px` pixels long, keeping its
/// aspect ratio (within [`MAX_SIDE`] and [`MAX_PIXELS`]).
pub fn rasterize(bytes: &[u8], max_px: u32) -> Result<Raster, Error> {
    guarded(|| {
        let tree = parse(bytes)?;
        draw(&tree, max_px as f32, MAX_SIDE)
    })
}

/// Draws an SVG with its shorter side `px` pixels long, keeping its aspect
/// ratio (within [`MAX_SIDE`] and [`MAX_PIXELS`]): the raster of backends
/// that decode per view, where `px` is the view's longer side in pixels.
/// Shown in such a view, an image's shorter side is never longer than
/// that, so the raster is never enlarged, in any resize mode (`cover`
/// included).
pub fn rasterize_covering(bytes: &[u8], px: u32) -> Result<Raster, Error> {
    guarded(|| {
        let tree = parse(bytes)?;
        let size = tree.size();
        let (long, short) = (
            size.width().max(size.height()),
            size.width().min(size.height()),
        );
        draw(&tree, px as f32 * long / short, MAX_SIDE)
    })
}

/// Draws an SVG at its intrinsic size, `scale` pixels per point (a
/// display's scale factor; within [`MAX_SIDE`] and [`MAX_PIXELS`]): the
/// raster of an image shown at its natural size.
pub fn rasterize_scaled(bytes: &[u8], scale: f32) -> Result<Raster, Error> {
    guarded(|| {
        let tree = parse(bytes)?;
        let size = tree.size();
        draw(&tree, size.width().max(size.height()) * scale, MAX_SIDE)
    })
}

/// Draws an SVG at [`OVERSAMPLE`] pixels per point, its longest side at most
/// [`MAX_OVERSAMPLED_SIDE`]: the raster of backends that draw one bitmap at
/// every size the image is shown at.
pub fn rasterize_oversampled(bytes: &[u8]) -> Result<Raster, Error> {
    guarded(|| {
        let tree = parse(bytes)?;
        let size = tree.size();
        let longest = size.width().max(size.height()) * OVERSAMPLE as f32;
        draw(&tree, longest, MAX_OVERSAMPLED_SIDE)
    })
}

/// The raster size of an SVG of `size` drawn with its longest side
/// `longest` pixels long: its aspect ratio kept, each side at least a pixel
/// and at most `max_side`, and at most [`MAX_PIXELS`] in all.
fn raster_size(size: usvg::Size, longest: f32, max_side: u32) -> Result<(u32, u32), Error> {
    if longest.is_nan() || longest <= 0.0 {
        return Err(Error::NoPixels);
    }
    let (w, h) = (f64::from(size.width()), f64::from(size.height()));
    let longest = f64::from(longest).clamp(1.0, f64::from(max_side));
    let scale = longest / w.max(h);
    let side = |v: f64| v.clamp(1.0, f64::from(max_side)) as u32;
    let (width, height) = (side((w * scale).round()), side((h * scale).round()));
    if u64::from(width) * u64::from(height) <= u64::from(MAX_PIXELS) {
        return Ok((width, height));
    }
    // Rounded down, so that the product stays within the budget.
    let scale = scale
        * (f64::from(MAX_PIXELS) / (w * h * scale * scale))
            .sqrt()
            .min(1.0);
    Ok((side((w * scale).floor()), side((h * scale).floor())))
}

/// Draws `tree` with its longest side `longest` pixels long ([`raster_size`]),
/// unless its layers are over [`MAX_LAYER_PIXELS`].
fn draw(tree: &usvg::Tree, longest: f32, max_side: u32) -> Result<Raster, Error> {
    let size = tree.size();
    let (width, height) = raster_size(size, longest, max_side)?;
    let transform = tiny_skia::Transform::from_scale(
        width as f32 / size.width(),
        height as f32 / size.height(),
    );
    let layers = layers::peak(tree, transform, (width, height)).ok_or(Error::TooManyNodes)?;
    if layers > f64::from(MAX_LAYER_PIXELS) {
        return Err(Error::OverBudget {
            pixels: layers as u64,
        });
    }
    // `None` only for a zero side or rows past `i32::MAX` bytes, which
    // `raster_size` never gives.
    let mut pixmap = tiny_skia::Pixmap::new(width, height).ok_or(Error::NoPixels)?;
    resvg::render(tree, transform, &mut pixmap.as_mut());
    Ok(Raster {
        width,
        height,
        pixels: pixmap.take(),
        size: points(size),
    })
}
