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

/// Windows: the texture of a view's frame, shared with the backend's
/// Direct3D 11 device (`ShaderView::surface`).
#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct SharedTexture {
    /// The view's textures and fence for one frame size, unique in the
    /// process: handles of another set are other objects, even when equal.
    pub set: u64,
    /// The texture's NT handle (`ID3D11Device1::OpenSharedResource1`), valid
    /// while the view keeps frames of this size.
    pub texture: windows_sys::Win32::Foundation::HANDLE,
    /// The NT handle of the view's fence (`ID3D11Device5::OpenSharedFence`),
    /// valid while the view keeps frames of this size.
    pub fence: windows_sys::Win32::Foundation::HANDLE,
    /// What to signal on the fence once the frame that draws the texture is
    /// submitted: until then the view renders into none of its others.
    pub value: u64,
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
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
            // Row by row: a backend takes this every frame of every shader
            // view, megabytes each, so it copies whole rows into one
            // allocation rather than collecting bytes into a growing one.
            let mut tight = Vec::with_capacity(self.width as usize * 4 * self.height as usize);
            for row in self.rows() {
                tight.extend_from_slice(row);
            }
            Cow::Owned(tight)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tight_drops_the_padding_between_rows() {
        // 2×3 pixels, rows 12 bytes apart: 8 bytes of pixels, 4 of padding.
        let pixels: Vec<u8> = (0..36).collect();
        let frame = Frame {
            pixels,
            width: 2,
            height: 3,
            stride: 12,
            serial: 1,
        };
        let tight = frame.tight();
        assert!(matches!(tight, Cow::Owned(_)));
        let want: Vec<u8> = [0..8, 12..20, 24..32].into_iter().flatten().collect();
        assert_eq!(&*tight, &want[..]);
    }

    #[test]
    fn tight_rows_are_borrowed() {
        let frame = Frame {
            pixels: (0..24).collect(),
            width: 2,
            height: 3,
            stride: 8,
            serial: 1,
        };
        assert!(matches!(frame.tight(), Cow::Borrowed(p) if p.len() == 24));
    }
}
