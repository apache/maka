//! A drawing rendered offscreen into an image: `OffscreenCanvas`'s
//! `convertToBlob` (TS) and [`Painter::render`](crate::element::Painter::render)
//! (Rust). The core checks the request ([`pixel_size`]) and sends it to the
//! platform as [`Command::RenderCanvas`](crate::Command::RenderCanvas) on
//! the root; the platform replays the drawing as its canvases do on screen,
//! into a bitmap of its own, and answers with the encoded image
//! ([`EventKind::CanvasImage`](crate::EventKind::CanvasImage),
//! [`EventPayload::CanvasImage`](crate::EventPayload::CanvasImage)).
//! Platforms whose [`Environment::canvas_render`](crate::platform::Environment::canvas_render)
//! is set render; elsewhere a request fails at once with
//! `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. A render the platform has not
//! answered within [`TIMEOUT`] fails with `ETIMEDOUT`; its late answer is
//! dropped.

use super::Drawing;
use crate::{
    element::{JsError, codes},
    geometry::{Points, Size},
};

/// The longest side of a rendered image, in pixels.
pub(crate) const MAX_SIDE: u32 = 16_384;

/// The most pixels a rendered image may hold (64 MP, 256 MB of RGBA).
pub(crate) const MAX_PIXELS: u64 = 64 * 1024 * 1024;

/// The renders one engine may wait for at once.
pub(crate) const MAX_PENDING: usize = 16;

/// How long a render may take before it fails with `ETIMEDOUT`.
pub(crate) const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The image formats a drawing renders to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum ImageFormat {
    /// PNG, lossless with transparency.
    #[default]
    Png,
}

impl ImageFormat {
    /// The format of MIME type `mime` (`image/png`; empty: PNG, as
    /// HTML's `convertToBlob`).
    pub fn from_mime(mime: &str) -> Option<Self> {
        match mime.trim().to_ascii_lowercase().as_str() {
            "" | "image/png" => Some(Self::Png),
            _ => None,
        }
    }

    /// Its MIME type.
    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
        }
    }
}

/// A drawing to render: `drawing`, `size` big, at `scale`
/// pixels per point (`None`: the screen's), encoded as `format`. What the
/// JS runtimes hand the core; Rust renders with
/// [`Painter::render`](crate::element::Painter::render).
#[doc(hidden)]
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct RenderRequest {
    /// What to draw, in points.
    pub drawing: Drawing,
    /// The image's size.
    pub size: Size<Points>,
    /// Pixels per point; `None`: the screen's.
    pub scale: Option<f32>,
    /// The encoding.
    pub format: ImageFormat,
}

/// Why a platform rendered no image ([`EventPayload::CanvasImage`](crate::EventPayload::CanvasImage)).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum RenderFailure {
    /// The platform cannot make an image this large (its bitmap or texture
    /// limit, or the memory for it): `ERR_NSH_QUOTA_EXCEEDED`.
    TooLarge(String),
    /// Anything else, with the platform's message.
    Failed(String),
}

impl From<String> for RenderFailure {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

impl From<&str> for RenderFailure {
    fn from(message: &str) -> Self {
        Self::Failed(message.into())
    }
}

impl RenderFailure {
    /// The error JS and Rust get.
    pub(crate) fn into_error(self) -> JsError {
        match self {
            Self::TooLarge(message) => error(codes::QUOTA_EXCEEDED, &message),
            Self::Failed(message) => JsError::Error(message),
        }
    }
}

/// How [`Painter::render`](crate::element::Painter::render) renders.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
#[non_exhaustive]
pub struct RenderOptions {
    /// Pixels per point; `None`: the screen's.
    pub scale: Option<f32>,
    /// The encoding.
    pub format: ImageFormat,
}

/// The size in pixels of a `size` drawing at `scale`
/// pixels per point, or why it cannot be rendered: a size or scale that is
/// not a positive finite number (`RangeError`), or an image past
/// [`MAX_SIDE`] / [`MAX_PIXELS`] (`ERR_NSH_QUOTA_EXCEEDED`).
pub(crate) fn pixel_size(size: Size<Points>, scale: f32) -> Result<(u32, u32), JsError> {
    let (width, height) = (size.width.0, size.height.0);
    for (name, value) in [("width", width), ("height", height), ("scale", scale)] {
        if !value.is_finite() || value <= 0.0 {
            return Err(JsError::Range(format!(
                "the {name} of an offscreen canvas must be a positive number, got {value}"
            )));
        }
    }
    let side = |points: f32| (f64::from(points) * f64::from(scale)).ceil();
    let (w, h) = (side(width), side(height));
    if w > f64::from(MAX_SIDE) || h > f64::from(MAX_SIDE) || w * h > MAX_PIXELS as f64 {
        return Err(error(
            codes::QUOTA_EXCEEDED,
            &format!(
                "a {w}×{h} pixel image is over the limit ({MAX_SIDE} pixels a side, {MAX_PIXELS} pixels)"
            ),
        ));
    }
    Ok((w as u32, h as u32))
}

pub(crate) fn error(code: &str, message: &str) -> JsError {
    JsError::Error(message.into()).with_code(code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::px;

    #[test]
    fn pixel_size_rounds_up_and_checks_limits() {
        assert_eq!(
            pixel_size(Size::new(px(100.0), px(50.5)), 2.0).unwrap(),
            (200, 101)
        );
        assert_eq!(
            pixel_size(Size::new(px(0.3), px(0.3)), 1.0).unwrap(),
            (1, 1)
        );
        let range = pixel_size(Size::new(px(0.0), px(10.0)), 1.0).unwrap_err();
        assert!(matches!(range, JsError::Range(_)));
        assert!(matches!(
            pixel_size(Size::new(px(10.0), px(10.0)), f32::NAN).unwrap_err(),
            JsError::Range(_)
        ));
        let side = pixel_size(Size::new(px(8193.0), px(10.0)), 2.0).unwrap_err();
        assert_eq!(side.code(), Some(codes::QUOTA_EXCEEDED));
        let area = pixel_size(Size::new(px(10_000.0), px(10_000.0)), 1.0).unwrap_err();
        assert_eq!(area.code(), Some(codes::QUOTA_EXCEEDED));
        assert_eq!(
            pixel_size(Size::new(px(8192.0), px(8192.0)), 1.0).unwrap(),
            (8192, 8192)
        );
    }

    #[test]
    fn formats_by_mime() {
        assert_eq!(ImageFormat::from_mime(""), Some(ImageFormat::Png));
        assert_eq!(ImageFormat::from_mime("IMAGE/PNG"), Some(ImageFormat::Png));
        assert_eq!(ImageFormat::from_mime("image/webp"), None);
    }
}
