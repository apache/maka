//! # icy_sixel
//!
//! A 100% Rust SIXEL library for encoding and decoding SIXEL graphics.
//!
//! ## Features
//!
//! - **Decoder**: High-performance SIXEL decoder with SIMD optimization (SSE2)
//! - **Encoder**: High-quality SIXEL encoder using quantette for color quantization
//!
//! ## Quick Start
//!
//! ### Encoding an image to SIXEL
//!
//! ```ignore
//! use icy_sixel::SixelImage;
//!
//! // RGBA image data (4 bytes per pixel)
//! let rgba = vec![255u8, 0, 0, 255, 0, 255, 0, 255]; // 2 red and green pixels
//! let image = SixelImage::from_rgba(rgba, 2, 1);
//! let sixel = image.encode()?;
//! print!("{}", sixel);
//! ```
//!
//! ### Decoding SIXEL to image data
//!
//! ```ignore
//! use icy_sixel::SixelImage;
//!
//! let sixel_data = b"\x1bPq#0;2;100;0;0#0~-\x1b\\";
//! let image = SixelImage::decode(sixel_data)?;
//! // image.pixels contains RGBA pixel data (4 bytes per pixel)
//! println!("{}x{}", image.width, image.height);
//! ```

use thiserror::Error;

pub mod decoder;
pub mod encoder;
pub mod sixel_image;

pub use decoder::DcsSettings;
#[allow(deprecated)]
pub use decoder::{sixel_decode, sixel_decode_from_dcs};
pub use encoder::{EncodeOptions, QuantizeMethod, sixel_encode_into};
#[allow(deprecated)]
pub use encoder::{sixel_encode, sixel_encode_default};
pub use sixel_image::{BackgroundMode, PixelAspectRatio, SixelImage};

/// Errors that can occur during SIXEL encoding or decoding.
#[derive(Debug, Error)]
pub enum SixelError {
    /// Invalid image dimensions (width or height is zero or too large)
    #[error("invalid dimensions: {width}x{height}")]
    InvalidDimensions { width: usize, height: usize },

    /// Buffer size doesn't match expected size for dimensions
    #[error("buffer size mismatch: expected {expected} bytes, got {actual}")]
    BufferSizeMismatch { expected: usize, actual: usize },

    /// Invalid SIXEL data format
    #[error("invalid SIXEL data: {0}")]
    InvalidData(String),

    /// No SIXEL data found in input
    #[error("no SIXEL data found (missing DCS introducer)")]
    NoSixelData,

    /// Color quantization failed
    #[error("quantization error: {0}")]
    Quantization(String),

    /// Integer overflow during processing
    #[error("integer overflow")]
    IntegerOverflow,

    /// The caller's output writer rejected part of the encoded image.
    #[error("SIXEL output failed: {0}")]
    Output(#[from] std::io::Error),
}

/// Result type for SIXEL operations.
pub type Result<T> = core::result::Result<T, SixelError>;

// Internal constants used by the decoder
pub(crate) const SIXEL_PALETTE_MAX: usize = 256;
pub(crate) const SIXEL_WIDTH_LIMIT: usize = 1000000;
pub(crate) const SIXEL_HEIGHT_LIMIT: usize = 1000000;
