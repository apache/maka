//! What the shader API (`crate::shader`) gives a backend, with or without the
//! renderer (feature `shader`).

use std::borrow::Cow;

/// The largest side of a frame, in pixels.
pub const MAX_SIDE: u32 = 4096;

/// The pixels a backend shows: 8 bits per channel, premultiplied alpha.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PixelFormat {
    /// Red, green, blue, alpha (GDK's `R8G8B8A8_PREMULTIPLIED`, Core
    /// Graphics' premultiplied last, Android's `ARGB_8888`).
    #[default]
    Rgba,
    /// Blue, green, red, alpha (Direct2D's, GPUI's).
    Bgra,
}

/// A rendered frame: `height` rows of `width` pixels, `stride` bytes apart.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct Frame {
    /// The pixels, row by row.
    pub pixels: Vec<u8>,
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// Bytes from one row to the next (at least `width * 4`).
    pub stride: u32,
    /// Counts the frames shown: a new value is a new picture.
    pub serial: u64,
}

impl Frame {
    /// The rows, without their padding.
    pub fn rows(&self) -> impl Iterator<Item = &[u8]> {
        let row = self.width as usize * 4;
        self.pixels
            .chunks(self.stride.max(1) as usize)
            .take(self.height as usize)
            .map(move |r| &r[..row.min(r.len())])
    }

    /// The pixels with no padding between rows (`width * 4` bytes apart).
    pub fn tight(&self) -> Cow<'_, [u8]> {
        if self.stride == self.width * 4 {
            Cow::Borrowed(&self.pixels)
        } else {
            Cow::Owned(self.rows().flatten().copied().collect())
        }
    }
}
