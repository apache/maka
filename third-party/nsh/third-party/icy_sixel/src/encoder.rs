//! Clean-room SIXEL encoder using quantette for high-quality color quantization.
//!
//! This encoder uses the quantette library (MIT/Apache licensed) for optimal
//! color palette generation and dithering, then encodes the result to SIXEL format.

use std::io::{self, Write};

// Re-export QuantizeMethod for public API
pub use quantette::QuantizeMethod;
use quantette::{ImageRef, PaletteSize, Pipeline, deps::palette::Srgb, dither::FloydSteinberg};

use crate::{BackgroundMode, PixelAspectRatio, Result, SixelError};

/// Color type for palette entries (RGB).
#[derive(Clone, Copy, Debug)]
struct Rgb {
    r: u8,
    g: u8,
    b: u8,
}

/// A compact 1-bit-per-element mask backed by `u64` words.
///
/// Uses 1/8 the memory of a `Vec<bool>`, which improves cache behavior in the
/// per-color band-encoding loop that re-reads the opacity mask many times.
struct BitMask {
    words: Vec<u64>,
}

impl BitMask {
    /// Create a mask with `len` bits, all cleared.
    fn zeros(len: usize) -> Self {
        Self {
            words: vec![0; len.div_ceil(64)],
        }
    }

    /// Set the bit at `index` to 1.
    #[inline]
    fn set(&mut self, index: usize) {
        self.words[index >> 6] |= 1u64 << (index & 63);
    }

    /// Return whether the bit at `index` is set.
    #[inline]
    fn get(&self, index: usize) -> bool {
        (self.words[index >> 6] >> (index & 63)) & 1 != 0
    }
}

/// Options for the quantette-based SIXEL encoder.
#[derive(Clone, Debug)]
pub struct EncodeOptions {
    /// Maximum number of colors in the palette (2-256).
    /// Fewer colors = smaller SIXEL output but less accurate colors.
    pub max_colors: u16,

    /// Floyd-Steinberg error diffusion strength (0.0-1.0).
    ///
    /// Controls how much quantization error is spread to neighboring pixels:
    /// - **0.875**: Default (7/8), best for photographs with smooth gradients
    /// - **0.5**: Reduced dithering, less noise, good for graphics
    /// - **0.0**: No dithering, sharp edges but may show color banding
    ///
    /// Higher values produce smoother gradients but may introduce noise.
    /// Lower values preserve sharp edges but may show color banding.
    /// Values are clamped to the range 0.0-1.0.
    pub diffusion: f32,

    /// Color quantization method.
    ///
    /// Available methods:
    /// - [`QuantizeMethod::Wu`]: Wu's color quantizer (default, fast and high quality)
    /// - [`QuantizeMethod::Kmeans`]: K-means clustering (slower but may be more accurate)
    ///
    /// For most use cases, Wu's method provides excellent results.
    pub quantize_method: QuantizeMethod,
}

impl Default for EncodeOptions {
    fn default() -> Self {
        Self {
            max_colors: 256,
            diffusion: FloydSteinberg::DEFAULT_ERROR_DIFFUSION,
            quantize_method: QuantizeMethod::Wu,
        }
    }
}

/// Encode RGBA image data into a SIXEL string using quantette.
///
/// # Arguments
/// * `rgba` - Raw RGBA pixel data (4 bytes per pixel: R, G, B, A)
/// * `width` - Image width in pixels
/// * `height` - Image height in pixels
/// * `opts` - Encoding options
///
/// # Returns
/// A SIXEL-encoded string that can be displayed on compatible terminals.
/// Transparent pixels (alpha=0) are preserved using SIXEL's P2=1 mode.
///
/// # Example
/// ```ignore
/// use icy_sixel::{SixelImage, EncodeOptions};
///
/// let rgba = vec![255u8, 0, 0, 255, 0, 255, 0, 255]; // 2 pixels: red, green
/// let image = SixelImage::from_rgba(rgba, 2, 1);
/// let sixel = image.encode_with(&EncodeOptions::default())?;
/// println!("{}", sixel);
/// ```
#[must_use = "this returns the encoded SIXEL string"]
pub fn sixel_encode(
    rgba: &[u8],
    width: usize,
    height: usize,
    opts: &EncodeOptions,
) -> Result<String> {
    sixel_encode_impl(
        rgba,
        width,
        height,
        opts,
        PixelAspectRatio::default(),
        BackgroundMode::default(),
    )
}

/// Encodes the same SIXEL image into a fallible output writer.
///
/// Quantization and colour selection are identical to [`sixel_encode`]. Output
/// is produced incrementally, without constructing an intermediate SIXEL
/// string. The first writer error aborts encoding and is returned immediately;
/// the writer may already contain a partial image. To admit a complete terminal
/// transaction, encode to a bounded memory writer before writing to the terminal.
pub fn sixel_encode_into<W: Write + ?Sized>(
    rgba: &[u8],
    width: usize,
    height: usize,
    opts: &EncodeOptions,
    output: &mut W,
) -> Result<()> {
    sixel_encode_impl_into(
        rgba,
        width,
        height,
        opts,
        PixelAspectRatio::default(),
        BackgroundMode::default(),
        output,
    )
}

pub(crate) fn sixel_encode_impl(
    rgba: &[u8],
    width: usize,
    height: usize,
    opts: &EncodeOptions,
    pixel_aspect_ratio: PixelAspectRatio,
    background_mode: BackgroundMode,
) -> Result<String> {
    let mut output = Vec::new();
    sixel_encode_impl_into(
        rgba,
        width,
        height,
        opts,
        pixel_aspect_ratio,
        background_mode,
        &mut output,
    )?;
    Ok(String::from_utf8(output).expect("the SIXEL encoder emits ASCII"))
}

fn sixel_encode_impl_into<W: Write + ?Sized>(
    rgba: &[u8],
    width: usize,
    height: usize,
    opts: &EncodeOptions,
    pixel_aspect_ratio: PixelAspectRatio,
    background_mode: BackgroundMode,
    output: &mut W,
) -> Result<()> {
    if width == 0 || height == 0 {
        return Err(SixelError::InvalidDimensions { width, height });
    }
    let expected = width * height * 4;
    if rgba.len() != expected {
        return Err(SixelError::BufferSizeMismatch {
            expected,
            actual: rgba.len(),
        });
    }

    // Single pass over the RGBA buffer building both the transparency mask
    // (set bit = opaque) and the Srgb<u8> pixels used for quantization
    // (quantette uses palette crate types).
    let pixel_count = width * height;
    let mut opacity_mask = BitMask::zeros(pixel_count);
    let mut rgb_pixels: Vec<Srgb<u8>> = Vec::with_capacity(pixel_count);
    for (i, c) in rgba.chunks_exact(4).enumerate() {
        if c[3] >= 128 {
            opacity_mask.set(i);
        }
        rgb_pixels.push(Srgb::new(c[0], c[1], c[2]));
    }

    // Set up quantette pipeline
    let max_colors = opts.max_colors.clamp(2, 256) as u8;
    let palette_size = PaletteSize::try_from(max_colors).unwrap_or(PaletteSize::MAX);

    // Create image reference for quantette
    let image = ImageRef::new(width as u32, height as u32, &rgb_pixels)
        .map_err(|e| SixelError::Quantization(e.to_string()))?;

    // Use configured quantization method with diffusion-based dithering
    let diffusion = opts.diffusion.clamp(0.0, 1.0);
    let pipeline = Pipeline::new()
        .palette_size(palette_size)
        .quantize_method(opts.quantize_method.clone());

    // Apply dithering based on diffusion setting
    let indexed_image = if diffusion <= 0.0 {
        // No dithering - sharp edges, may show banding
        pipeline
            .ditherer(None)
            .input_image(image)
            .output_srgb8_indexed_image()
    } else {
        // Use Floyd-Steinberg dithering with specified diffusion strength
        let ditherer = FloydSteinberg::with_error_diffusion(diffusion).unwrap_or_default();
        pipeline
            .ditherer(ditherer)
            .input_image(image)
            .output_srgb8_indexed_image()
    };

    // Extract palette and indices
    let palette: Vec<Rgb> = indexed_image
        .palette()
        .iter()
        .map(|c| Rgb {
            r: c.red,
            g: c.green,
            b: c.blue,
        })
        .collect();

    let indices: Vec<u8> = indexed_image.indices().to_vec();

    // Encode to SIXEL with transparency support
    encode_indexed_to_sixel(
        &palette,
        &indices,
        &opacity_mask,
        (width, height),
        pixel_aspect_ratio,
        background_mode,
        output,
    )
}

/// Encode RGBA with default options.
#[inline]
#[deprecated(since = "0.5.0", note = "use SixelImage::from_rgba().encode() instead")]
#[must_use = "this returns the encoded SIXEL string"]
pub fn sixel_encode_default(rgba: &[u8], width: usize, height: usize) -> Result<String> {
    #[allow(deprecated)]
    sixel_encode(rgba, width, height, &EncodeOptions::default())
}

fn encode_indexed_to_sixel<W: Write + ?Sized>(
    palette: &[Rgb],
    indices: &[u8],
    opacity_mask: &BitMask,
    size: (usize, usize),
    aspect_ratio: PixelAspectRatio,
    background_mode: BackgroundMode,
    out: &mut W,
) -> Result<()> {
    let (width, height) = size;
    // DCS introducer for SIXEL: ESC P p1 ; p2 ; p3 q
    // p1=aspect ratio, p2=background mode, p3=0 (grid size default)
    out.write_all(b"\x1bP")?;
    write_number(out, aspect_ratio.to_p1_value() as usize)?;
    out.write_all(b";")?;
    write_number(out, background_mode.to_p2_value() as usize)?;
    out.write_all(b";0q")?;

    // Set raster attributes: " Pan ; Pad ; Ph ; Pv
    // Pan:Pad is vertical:horizontal, so it mirrors the P1 macro parameter.
    // Emitting this is required for terminals and multiplexers (e.g. tmux) that
    // drop or rewrite P1 but forward the raster attributes.
    out.write_all(b"\"")?;
    write_number(out, aspect_ratio.pad() as usize)?;
    out.write_all(b";")?;
    write_number(out, aspect_ratio.pan() as usize)?;
    out.write_all(b";")?;
    write_number(out, width)?;
    out.write_all(b";")?;
    write_number(out, height)?;

    // Define palette in RGB percent (0-100)
    for (i, c) in palette.iter().enumerate() {
        let r = (c.r as u32 * 100) / 255;
        let g = (c.g as u32 * 100) / 255;
        let b = (c.b as u32 * 100) / 255;
        out.write_all(b"#")?;
        write_number(out, i)?;
        out.write_all(b";")?;
        out.write_all(b"2")?;
        out.write_all(b";")?;
        write_number(out, r as usize)?;
        out.write_all(b";")?;
        write_number(out, g as usize)?;
        out.write_all(b";")?;
        write_number(out, b as usize)?;
    }

    let bands = height.div_ceil(6);
    let palette_len = palette.len();

    // Scratch buffer holding the 6-bit sixel value for every (color, column)
    // pair in the current band. Reused across bands; only the rows of colors
    // actually used in a band are cleared, so this stays cheap.
    let mut sixels = vec![0u8; palette_len * width];
    let mut colors_used = vec![false; palette_len];

    for band in 0..bands {
        let y0 = band * 6;
        let y_max = usize::min(y0 + 6, height);

        // Reset only the rows touched by the previous band.
        for (color_index, used) in colors_used.iter_mut().enumerate() {
            if *used {
                sixels[color_index * width..(color_index + 1) * width].fill(0);
                *used = false;
            }
        }

        // Single pass over the band: scatter each opaque pixel's bit into the
        // scratch buffer keyed by its color. This replaces the previous
        // O(colors x pixels) re-scan with a single O(pixels) pass.
        for y in y0..y_max {
            let bit = 1u8 << (y - y0);
            let row = y * width;
            for x in 0..width {
                let pixel_idx = row + x;
                if opacity_mask.get(pixel_idx) {
                    let color_index = indices[pixel_idx] as usize;
                    sixels[color_index * width + x] |= bit;
                    colors_used[color_index] = true;
                }
            }
        }

        // Emit each used color, run-length encoding consecutive identical sixels.
        for color_index in 0..palette_len {
            if !colors_used[color_index] {
                continue; // Skip colors not used in this band
            }

            // Select color map register
            out.write_all(b"#")?;
            write_number(out, color_index)?;

            let row = &sixels[color_index * width..(color_index + 1) * width];
            let mut x = 0;
            while x < width {
                let bits = row[x];

                // Run-length encode consecutive identical sixel values
                let mut run_len = 1usize;
                while x + run_len < width && row[x + run_len] == bits {
                    run_len += 1;
                }

                // Zero-bit tails draw nothing, and '$' resets x for the next color.
                if bits == 0 && x + run_len == width {
                    break;
                }

                // Write RLE or raw sixels
                if run_len > 3 {
                    out.write_all(b"!")?;
                    write_number(out, run_len)?;
                    out.write_all(&[63 + bits])?;
                } else {
                    let ch = 63 + bits;
                    for _ in 0..run_len {
                        out.write_all(&[ch])?;
                    }
                }
                x += run_len;
            }

            // Carriage return to start of band for next color overlay
            out.write_all(b"$")?;
        }

        // Move to next band
        out.write_all(b"-")?;
    }

    // String terminator: ESC \
    out.write_all(b"\x1b")?;
    out.write_all(b"\\")?;

    Ok(())
}

/// Fast number to string without allocation
#[inline]
fn write_number<W: Write + ?Sized>(out: &mut W, mut n: usize) -> io::Result<()> {
    if n == 0 {
        return out.write_all(b"0");
    }

    let mut buf = [0u8; 20];
    let mut i = buf.len();

    while n > 0 {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
    }

    out.write_all(&buf[i..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writer_output_preserves_the_string_api_and_image_colours() {
        let rgba = [
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ];
        let opts = EncodeOptions {
            diffusion: 0.0,
            ..EncodeOptions::default()
        };
        let original = sixel_encode(&rgba, 2, 2, &opts).unwrap();
        let mut output = Vec::new();
        sixel_encode_into(&rgba, 2, 2, &opts, &mut output).unwrap();
        assert_eq!(output, original.as_bytes());
        let decoded = crate::SixelImage::decode(&output).unwrap();
        // SIXEL bands have six rows; the original two rows retain their exact
        // colours and the remaining rows stay transparent.
        assert_eq!((decoded.width, decoded.height), (2, 6));
        assert_eq!(
            decoded.pixels,
            [
                255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ]
        );
    }

    #[test]
    fn empty_color_tails_preserve_pixels_raster_and_band_positions() {
        let palette = [Rgb { r: 255, g: 0, b: 0 }, Rgb { r: 0, g: 255, b: 0 }];
        let mut indices = [0; 12 * 7];
        let mut opacity = BitMask::zeros(indices.len());
        for (x, y, color) in [(0, 0, 0), (8, 0, 0), (4, 0, 1), (2, 6, 1)] {
            let index = y * 12 + x;
            indices[index] = color;
            opacity.set(index);
        }
        for mode in [BackgroundMode::Transparent, BackgroundMode::Opaque] {
            let mut output = Vec::new();
            encode_indexed_to_sixel(
                &palette,
                &indices,
                &opacity,
                (12, 7),
                PixelAspectRatio::default(),
                mode,
                &mut output,
            )
            .unwrap();
            let header = format!(
                "\x1bP9;{};0q\"1;1;12;7#0;2;100;0;0#1;2;0;100;0",
                mode.to_p2_value()
            );
            assert_eq!(
                output,
                format!("{header}#0@!7?@$#1!4?@$-#1??@$-\x1b\\").as_bytes()
            );

            // The full-width stream exercises the same image with explicit empty
            // tails. Leading gaps, interior gaps and the final partial band stay.
            let full_width = format!("{header}#0@!7?@???$#1!4?@!7?$-#1??@!9?$-\x1b\\");
            let decoded = crate::SixelImage::decode(&output).unwrap();
            let original = crate::SixelImage::decode(full_width.as_bytes()).unwrap();
            assert_eq!((decoded.width, decoded.height), (12, 12));
            assert_eq!(
                (decoded.width, decoded.height),
                (original.width, original.height)
            );
            assert_eq!(decoded.pixels, original.pixels);
            if mode == BackgroundMode::Transparent {
                let mut pixels = vec![0; 12 * 12 * 4];
                for (x, y, rgba) in [
                    (0, 0, [255, 0, 0, 255]),
                    (8, 0, [255, 0, 0, 255]),
                    (4, 0, [0, 255, 0, 255]),
                    (2, 6, [0, 255, 0, 255]),
                ] {
                    let offset = (y * 12 + x) * 4;
                    pixels[offset..offset + 4].copy_from_slice(&rgba);
                }
                assert_eq!(decoded.pixels, pixels);
            }
        }
    }

    #[test]
    fn a_small_writer_limit_aborts_at_the_first_output_error() {
        struct Limited {
            bytes: Vec<u8>,
            rejected: bool,
        }
        impl Write for Limited {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                assert!(!self.rejected, "encoding continued after a writer failure");
                if bytes.len() > 3 - self.bytes.len() {
                    self.rejected = true;
                    return Err(io::Error::other("budget exhausted"));
                }
                self.bytes.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut output = Limited {
            bytes: Vec::new(),
            rejected: false,
        };
        let error = sixel_encode_into(
            &[255, 0, 0, 255],
            1,
            1,
            &EncodeOptions::default(),
            &mut output,
        )
        .unwrap_err();
        let SixelError::Output(error) = error else {
            panic!("unexpected error: {error}")
        };
        assert_eq!(error.to_string(), "budget exhausted");
        assert_eq!(output.bytes, b"\x1bP9");
    }

    #[test]
    #[allow(deprecated)]
    fn test_encode_simple() {
        let rgba = vec![255u8, 0, 0, 255]; // 1x1 red pixel
        let result = sixel_encode(&rgba, 1, 1, &EncodeOptions::default());
        assert!(result.is_ok());
        let sixel = result.unwrap();
        assert!(sixel.starts_with("\x1bP9;1;0q\"1;1;1;1"));
        assert!(sixel.ends_with("\x1b\\"));
    }

    #[test]
    #[allow(deprecated)]
    fn test_encode_2x2() {
        let rgba = vec![
            255, 0, 0, 255, // red
            0, 255, 0, 255, // green
            0, 0, 255, 255, // blue
            255, 255, 0, 255, // yellow
        ];
        let result = sixel_encode(&rgba, 2, 2, &EncodeOptions::default());
        assert!(result.is_ok());
    }

    //This test is a compatibility test, the P1 value needs to be 7-9 in order to have square pixels. If it is set to a different value
    //like 0 (default) then most terminals will do things correctly but the Windows Terminal will default to a non-square sixel making the
    //image print out with an incorrect aspect ratio.
    #[test]
    #[allow(deprecated)]
    fn test_encode_is_set_to_square_pixels() {
        let rgba = vec![
            255, 0, 0, 255, // red
            0, 0, 255, 255, // blue
        ];
        let sixel = sixel_encode(&rgba, 2, 1, &EncodeOptions::default()).unwrap();
        assert!(sixel.contains("\x1bP9;"));
        // Raster attributes must also state a 1:1 ratio: multiplexers such as tmux
        // rewrite P1 but pass the raster attributes through unchanged.
        assert!(sixel.contains("\"1;1;2;1"));
    }

    #[test]
    #[allow(deprecated)]
    fn test_invalid_dimensions() {
        let rgba = vec![0u8; 16];

        assert!(sixel_encode(&rgba, 0, 4, &EncodeOptions::default()).is_err());
        assert!(sixel_encode(&rgba, 4, 0, &EncodeOptions::default()).is_err());
        assert!(sixel_encode(&rgba, 10, 10, &EncodeOptions::default()).is_err());
    }
}
