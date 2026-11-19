//! SVG images without the renderer (feature `svg` off): an SVG is still
//! recognized by its bytes, so a backend reports why it draws nothing
//! instead of handing the document to a bitmap decoder.

use std::fmt;

use crate::geometry::{DevicePixels, Points, Size};

#[path = "svg/sniff.rs"]
mod sniff;

/// A drawn SVG: premultiplied RGBA, row by row without padding. Without
/// the renderer, never made.
#[derive(Debug, Clone, PartialEq, Default)]
#[non_exhaustive]
pub struct Raster {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// `width * height * 4` bytes of premultiplied RGBA.
    pub pixels: Vec<u8>,
    /// The SVG's intrinsic size.
    pub size: Size<Points>,
}

/// Why an SVG could not be read or drawn.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Error {
    /// The runtime was built without the feature `svg`.
    Unsupported,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "SVG images need the feature `svg`, which this runtime was built without"
        )
    }
}

impl std::error::Error for Error {}

/// Whether `bytes` are an SVG document (a `.svgz` is not recognized: there
/// is no gzip without the renderer).
pub fn sniff(bytes: &[u8]) -> bool {
    sniff::sniff_text(bytes)
}

/// See the renderer's `reported_size`.
pub fn reported_size(size: Size<Points>) -> Size<DevicePixels> {
    let whole = |p: Points| DevicePixels(p.0.round().clamp(1.0, i32::MAX as f32) as i32);
    Size::new(whole(size.width), whole(size.height))
}

/// Always [`Error::Unsupported`].
pub fn size(_bytes: &[u8]) -> Result<Size<Points>, Error> {
    Err(Error::Unsupported)
}

/// Always [`Error::Unsupported`].
pub fn rasterize(_bytes: &[u8], _max_px: u32) -> Result<Raster, Error> {
    Err(Error::Unsupported)
}

/// Always [`Error::Unsupported`].
pub fn rasterize_covering(_bytes: &[u8], _px: u32) -> Result<Raster, Error> {
    Err(Error::Unsupported)
}

/// Always [`Error::Unsupported`].
pub fn rasterize_scaled(_bytes: &[u8], _scale: f32) -> Result<Raster, Error> {
    Err(Error::Unsupported)
}

/// Always [`Error::Unsupported`].
pub fn rasterize_oversampled(_bytes: &[u8]) -> Result<Raster, Error> {
    Err(Error::Unsupported)
}
