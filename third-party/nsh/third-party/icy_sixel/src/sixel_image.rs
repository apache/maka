//! The `SixelImage` type and related definitions.

use crate::{Result, SixelError, decoder::DcsSettings};

/// Background color mode for SIXEL (P2 parameter).
///
/// Controls how the terminal handles pixels that are not explicitly drawn.
/// This affects both encoding and decoding of SIXEL images.
///
/// The P2 parameter in the DCS introducer:
/// - P2 = 0 or 2: Opaque - undrawn pixels are set to background color
/// - P2 = 1: Transparent - undrawn pixels keep their current color
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BackgroundMode {
    /// Undrawn pixels are set to the terminal's background color (P2=0 or 2).
    /// This fills the entire image rectangle with the background color first.
    Opaque,
    /// Undrawn pixels remain at their current color (P2=1).
    /// This allows transparency when drawing over existing content.
    #[default]
    Transparent,
}

impl BackgroundMode {
    /// Creates a BackgroundMode from a P2 parameter value.
    pub fn from_p2(p2: u16) -> Self {
        match p2 {
            1 => Self::Transparent,
            _ => Self::Opaque, // 0, 2, or any other value
        }
    }

    /// Returns the P2 parameter value for the DCS introducer.
    pub fn to_p2_value(self) -> u8 {
        match self {
            Self::Opaque => 0,
            Self::Transparent => 1,
        }
    }

    /// Returns true if this mode represents transparent background.
    #[inline]
    pub fn is_transparent(self) -> bool {
        matches!(self, Self::Transparent)
    }
}

/// Pixel aspect ratio from SIXEL DCS parameters (P1 parameter).
///
/// SIXEL images can specify a pixel aspect ratio that indicates how pixels
/// should be displayed. This is a historical feature from when terminals had
/// non-square pixels. Most modern terminals display square pixels and ignore
/// this setting, but the information is preserved for applications that need it.
///
/// The P1 parameter in the DCS introducer maps to these ratios (vertical:horizontal):
/// - P1 = 0, 1: 5:1 - very tall pixels
/// - P1 = 2: 3:1 - tall pixels
/// - P1 = 3, 4, 5, 6: 2:1 - moderately tall pixels
/// - P1 = 7, 8, 9: 1:1 - square pixels (recommended for modern terminals)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PixelAspectRatio {
    /// 5:1 aspect ratio (vertical:horizontal) - very tall pixels (P1=0,1)
    Ratio5To1,
    /// 3:1 aspect ratio - tall pixels (P1=2)
    Ratio3To1,
    /// 2:1 aspect ratio - moderately tall pixels (P1=3,4,5,6)
    Ratio2To1,
    /// 1:1 aspect ratio - square pixels (P1=7,8,9, default for modern terminals)
    #[default]
    Square,
}

impl PixelAspectRatio {
    /// Creates a PixelAspectRatio from a P1 parameter value.
    ///
    /// Maps the DCS P1 parameter to the corresponding aspect ratio.
    pub fn from_p1(p1: u16) -> Self {
        match p1 {
            0 | 1 => Self::Ratio5To1,
            2 => Self::Ratio3To1,
            3..=6 => Self::Ratio2To1,
            7..=9 => Self::Square,
            _ => Self::Square,
        }
    }

    /// Returns the P1 parameter value for the DCS introducer.
    pub fn to_p1_value(self) -> u8 {
        match self {
            Self::Ratio5To1 => 0,
            Self::Ratio3To1 => 2,
            Self::Ratio2To1 => 3,
            Self::Square => 9,
        }
    }

    /// Returns the Pixel Aspect Numerator (horizontal component).
    #[inline]
    pub fn pan(self) -> u16 {
        match self {
            Self::Ratio5To1 => 1,
            Self::Ratio3To1 => 1,
            Self::Ratio2To1 => 1,
            Self::Square => 1,
        }
    }

    /// Returns the Pixel Aspect Denominator (vertical component).
    #[inline]
    pub fn pad(self) -> u16 {
        match self {
            Self::Ratio5To1 => 5,
            Self::Ratio3To1 => 3,
            Self::Ratio2To1 => 2,
            Self::Square => 1,
        }
    }

    /// Returns the aspect ratio as a floating point value (pan/pad).
    /// Values > 1.0 mean pixels are wider than tall.
    /// Values < 1.0 mean pixels are taller than wide.
    /// Value of 1.0 means square pixels.
    #[inline]
    pub fn as_f32(self) -> f32 {
        self.pan() as f32 / self.pad() as f32
    }

    /// Returns true if the aspect ratio represents square pixels.
    #[inline]
    pub fn is_square(self) -> bool {
        matches!(self, Self::Square)
    }
}

/// A decoded SIXEL image with full metadata.
///
/// This struct contains the decoded pixel data along with additional
/// information from the SIXEL stream such as aspect ratio.
#[derive(Debug, Clone)]
pub struct SixelImage {
    /// RGBA pixel data (4 bytes per pixel: R, G, B, A)
    pub pixels: Vec<u8>,
    /// Image width in pixels
    pub width: usize,
    /// Image height in pixels
    pub height: usize,
    /// Pixel aspect ratio from DCS parameters
    pub aspect_ratio: PixelAspectRatio,
    /// Background mode from DCS parameters (P2)
    pub background_mode: BackgroundMode,
}

impl SixelImage {
    /// Decodes a complete ANSI SIXEL sequence.
    ///
    /// This is the main entry point for decoding SIXEL graphics.
    #[must_use = "this returns the decoded SixelImage"]
    pub fn decode(data: &[u8]) -> Result<Self> {
        crate::decoder::decode_sixel(data)
    }

    /// Decodes a SIXEL payload using explicit DCS settings.
    #[must_use = "this returns the decoded SixelImage"]
    pub fn decode_from_dcs(payload: &[u8], settings: DcsSettings) -> Result<Self> {
        crate::decoder::decode_sixel_from_dcs(payload, settings)
    }

    /// Returns the corrected dimensions if aspect ratio is applied.
    ///
    /// For non-square pixels, returns the dimensions that would result
    /// from scaling the image to have square pixels.
    pub fn corrected_dimensions(&self) -> (usize, usize) {
        if self.aspect_ratio.is_square() {
            (self.width, self.height)
        } else if self.aspect_ratio.pan() > self.aspect_ratio.pad() {
            // Wider pixels: stretch horizontally
            let new_width =
                (self.width * self.aspect_ratio.pan() as usize) / self.aspect_ratio.pad() as usize;
            (new_width, self.height)
        } else {
            // Taller pixels: stretch vertically
            let new_height =
                (self.height * self.aspect_ratio.pad() as usize) / self.aspect_ratio.pan() as usize;
            (self.width, new_height)
        }
    }

    /// Creates a new `SixelImage` from raw RGBA pixel data.
    ///
    /// # Arguments
    /// * `pixels` - RGBA pixel data (4 bytes per pixel)
    /// * `width` - Image width in pixels
    /// * `height` - Image height in pixels
    ///
    /// # Example
    /// ```rust
    /// use icy_sixel::SixelImage;
    ///
    /// let pixels = vec![255, 0, 0, 255, 0, 255, 0, 255]; // 2 pixels: red, green
    /// let image = SixelImage::from_rgba(pixels, 2, 1);
    /// ```
    pub fn from_rgba(pixels: Vec<u8>, width: usize, height: usize) -> Self {
        Self {
            pixels,
            width,
            height,
            aspect_ratio: PixelAspectRatio::default(),
            background_mode: BackgroundMode::default(),
        }
    }

    /// Creates a new `SixelImage` from raw RGBA pixel data, validating dimensions and buffer size.
    ///
    /// This is a fallible variant of [`SixelImage::from_rgba`]. It returns an error if:
    /// - `width == 0` or `height == 0`
    /// - `pixels.len() != width * height * 4`
    /// - the size computation overflows
    pub fn try_from_rgba(pixels: Vec<u8>, width: usize, height: usize) -> Result<Self> {
        if width == 0 || height == 0 {
            return Err(SixelError::InvalidDimensions { width, height });
        }

        let expected = width
            .checked_mul(height)
            .and_then(|v| v.checked_mul(4))
            .ok_or(SixelError::IntegerOverflow)?;

        if pixels.len() != expected {
            return Err(SixelError::BufferSizeMismatch {
                expected,
                actual: pixels.len(),
            });
        }

        Ok(Self::from_rgba(pixels, width, height))
    }

    /// Sets the pixel aspect ratio for encoding.
    ///
    /// # Example
    /// ```rust
    /// use icy_sixel::{PixelAspectRatio, SixelImage};
    ///
    /// let image =
    ///     SixelImage::from_rgba(vec![255; 4], 1, 1).with_aspect_ratio(PixelAspectRatio::Ratio2To1);
    /// ```
    #[must_use]
    pub fn with_aspect_ratio(mut self, aspect_ratio: PixelAspectRatio) -> Self {
        self.aspect_ratio = aspect_ratio;
        self
    }

    /// Sets the background mode for encoding.
    ///
    /// # Example
    /// ```rust
    /// use icy_sixel::{BackgroundMode, SixelImage};
    ///
    /// let image =
    ///     SixelImage::from_rgba(vec![255; 4], 1, 1).with_background_mode(BackgroundMode::Opaque);
    /// ```
    #[must_use]
    pub fn with_background_mode(mut self, background_mode: BackgroundMode) -> Self {
        self.background_mode = background_mode;
        self
    }

    /// Encodes this image to a SIXEL string with default options.
    ///
    /// # Example
    /// ```rust
    /// use icy_sixel::SixelImage;
    ///
    /// let pixels = vec![255, 0, 0, 255]; // 1 red pixel
    /// let image = SixelImage::from_rgba(pixels, 1, 1);
    /// let sixel = image.encode()?;
    /// # Ok::<(), icy_sixel::SixelError>(())
    /// ```
    #[must_use = "this returns the encoded SIXEL string"]
    pub fn encode(&self) -> Result<String> {
        crate::encoder::sixel_encode_impl(
            &self.pixels,
            self.width,
            self.height,
            &Default::default(),
            self.aspect_ratio,
            self.background_mode,
        )
    }

    /// Encodes this image to a SIXEL string with custom options.
    ///
    /// # Example
    /// ```rust
    /// use icy_sixel::{EncodeOptions, SixelImage};
    ///
    /// let pixels = vec![255, 0, 0, 255]; // 1 red pixel
    /// let image = SixelImage::from_rgba(pixels, 1, 1);
    /// let opts = EncodeOptions {
    ///     max_colors: 16,
    ///     ..Default::default()
    /// };
    /// let sixel = image.encode_with(&opts)?;
    /// # Ok::<(), icy_sixel::SixelError>(())
    /// ```
    #[must_use = "this returns the encoded SIXEL string"]
    pub fn encode_with(&self, opts: &crate::encoder::EncodeOptions) -> Result<String> {
        crate::encoder::sixel_encode_impl(
            &self.pixels,
            self.width,
            self.height,
            opts,
            self.aspect_ratio,
            self.background_mode,
        )
    }

    /// Returns the image dimensions as a tuple (width, height).
    #[inline]
    pub fn dimensions(&self) -> (usize, usize) {
        (self.width, self.height)
    }

    /// Returns true if the image contains any transparent pixels (alpha < 128).
    pub fn has_transparency(&self) -> bool {
        self.pixels.chunks_exact(4).any(|c| c[3] < 128)
    }
}

impl core::fmt::Display for SixelImage {
    /// Formats the image as a SIXEL string for direct terminal output.
    ///
    /// Uses default encoding options. For custom options, use `encode_with()`.
    ///
    /// # Example
    /// ```rust,ignore
    /// use icy_sixel::SixelImage;
    ///
    /// let image = SixelImage::from_rgba(vec![255, 0, 0, 255], 1, 1);
    /// print!("{}", image); // Prints SIXEL directly to terminal
    /// ```
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self.encode() {
            Ok(sixel) => f.write_str(&sixel),
            Err(_) => Err(core::fmt::Error),
        }
    }
}

impl core::str::FromStr for SixelImage {
    type Err = SixelError;

    /// Parses a SIXEL string into a `SixelImage`.
    ///
    /// This treats the string as raw bytes, allowing convenient parsing
    /// from string sources.
    ///
    /// # Example
    /// ```rust
    /// use icy_sixel::SixelImage;
    ///
    /// let sixel = "\x1bPq#0;2;100;0;0#0~~~\x1b\\";
    /// let image: SixelImage = sixel.parse()?;
    /// # Ok::<(), icy_sixel::SixelError>(())
    /// ```
    fn from_str(s: &str) -> Result<Self> {
        Self::decode(s.as_bytes())
    }
}
