use crate::{
    Result, SIXEL_HEIGHT_LIMIT, SIXEL_PALETTE_MAX, SIXEL_WIDTH_LIMIT, SixelError,
    sixel_image::{BackgroundMode, PixelAspectRatio, SixelImage},
};

const SIXEL_CELL_HEIGHT: usize = 6;
const MAX_REPEAT: usize = 0xffff;

#[cfg(target_arch = "x86")]
use core::arch::x86::{__m128i, _mm_loadu_si128, _mm_storeu_si128};
#[cfg(target_arch = "x86_64")]
use core::arch::x86_64::{__m128i, _mm_loadu_si128, _mm_storeu_si128};

/// Internal decode function used by SixelImage::decode
pub(crate) fn decode_sixel(data: &[u8]) -> Result<SixelImage> {
    let parsed = AnsiPayload::parse(data)?;
    let settings = DcsSettings::new(parsed.aspect_ratio, parsed.zero_color, parsed.grid_size);
    let payload = strip_string_terminator(parsed.payload);
    decode_sixel_from_dcs(payload, settings)
}

/// Internal decode function used by SixelImage::decode_from_dcs
pub(crate) fn decode_sixel_from_dcs(payload: &[u8], settings: DcsSettings) -> Result<SixelImage> {
    let mut decoder = SixelDecoder::new(settings)?;
    decoder.process(payload)?;
    let (pixels, width, height) = decoder.finalize()?;

    // Calculate aspect ratio from P1 parameter
    let aspect_ratio = settings
        .aspect_ratio
        .map(PixelAspectRatio::from_p1)
        .unwrap_or_default();

    // Calculate background mode from P2 parameter
    let background_mode = settings
        .zero_color
        .map(BackgroundMode::from_p2)
        .unwrap_or_default();

    Ok(SixelImage {
        pixels,
        width,
        height,
        aspect_ratio,
        background_mode,
    })
}

/// Decodes a complete ANSI SIXEL sequence.
///
/// This is the main entry point for decoding SIXEL graphics. It handles the full
/// ANSI DCS (Device Control String) sequence format.
///
/// # SIXEL Format
///
/// A complete SIXEL sequence has the format:
/// ```text
/// ESC P <params> q <sixel_data> ESC \
/// ```
/// Where:
/// - `ESC P` (0x1B 0x50): DCS introducer
/// - `<params>`: Optional parameters (aspect ratio, background color, etc.)
/// - `q`: SIXEL command
/// - `<sixel_data>`: The actual SIXEL graphics data
/// - `ESC \` (0x1B 0x5C) or 0x9C: String terminator
///
/// # Parameters
///
/// * `data` - Complete SIXEL sequence as bytes, including DCS introducer and terminator
///
/// # Returns
///
/// Returns a [`SixelImage`] on success.
///
/// Pixel data is returned as RGBA (4 bytes per pixel). When the SIXEL stream requests a
/// transparent background (P2=1), undrawn/background pixels may have `A=0`.
/// - `width`: Image width in pixels
/// - `height`: Image height in pixels
///
/// # Pixel Format
///
/// The returned pixel data is in RGBA format with 4 bytes per pixel:
/// ```text
/// [R₀, G₀, B₀, A₀, R₁, G₁, B₁, A₁, R₂, G₂, B₂, A₂, ...]
/// ```
/// - Total size: `width * height * 4` bytes
/// - Alpha channel is typically 0xFF (fully opaque), but may be 0x00 for undrawn pixels when the SIXEL stream requests transparent background (P2=1)
/// - Pixels are stored in row-major order (left to right, top to bottom)
///
/// To convert to other formats:
/// ```rust
/// # use icy_sixel::sixel_decode;
/// # let sixel_data = b"\x1bPq#0;2;100;0;0#0~~~\x1b\\";
/// let image = sixel_decode(sixel_data)?;
///
/// // Extract RGB (dropping alpha channel)
/// let rgb_pixels: Vec<u8> = image
///     .pixels
///     .chunks(4)
///     .flat_map(|rgba| [rgba[0], rgba[1], rgba[2]])
///     .collect();
///
/// // Access individual pixels
/// for y in 0..image.height {
///     for x in 0..image.width {
///         let idx = (y * image.width + x) * 4;
///         let r = image.pixels[idx];
///         let g = image.pixels[idx + 1];
///         let b = image.pixels[idx + 2];
///         let a = image.pixels[idx + 3];
///     }
/// }
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
///
/// # Example
///
/// ```rust
/// use icy_sixel::sixel_decode;
///
/// // Complete SIXEL sequence
/// let sixel_data = b"\x1bPq#0;2;100;0;0#0~~~\x1b\\";
///
/// match sixel_decode(sixel_data) {
///     Ok(image) => {
///         println!("Decoded {}x{} SIXEL image", image.width, image.height);
///         println!("Pixel data: {} bytes (RGBA format)", image.pixels.len());
///         assert_eq!(image.pixels.len(), image.width * image.height * 4);
///
///         // First pixel color
///         println!(
///             "First pixel: R={}, G={}, B={}, A={}",
///             image.pixels[0], image.pixels[1], image.pixels[2], image.pixels[3]
///         );
///     }
///     Err(e) => eprintln!("Failed to decode: {}", e),
/// }
/// ```
///
/// # Saving as PNG
///
/// ```rust,no_run
/// use icy_sixel::sixel_decode;
/// use image;
///
/// let sixel_data = b"\x1bPq#0;2;100;0;0#0~~~\x1b\\";
/// let image_data = sixel_decode(sixel_data)?;
///
/// // Save as RGBA PNG
/// image::save_buffer(
///     "output.png",
///     &image_data.pixels,
///     image_data.width as u32,
///     image_data.height as u32,
///     image::ColorType::Rgba8,
/// )?;
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
///
/// # Errors
///
/// Returns an error if:
/// - The SIXEL sequence is malformed (missing DCS introducer, invalid syntax)
/// - The resulting image dimensions exceed limits (1,000,000 x 1,000,000)
/// - Memory allocation fails
/// - Invalid color definitions or palette operations
/// - Malformed escape sequences
///
/// # Performance
///
/// This decoder is highly optimized with:
/// - SIMD-accelerated pixel filling (SSE2 on x86/x86_64)
/// - Zero-copy parsing where possible
/// - Minimal memory allocations
/// - Efficient palette caching
///
/// Typical performance: ~3ms to decode a 600x450 image on modern hardware.
///
/// # Example
///
/// ```rust
/// use icy_sixel::sixel_decode;
///
/// let sixel_data = b"\x1bPq#0;2;100;0;0#0~~~\x1b\\";
/// let image = sixel_decode(sixel_data)?;
///
/// println!("Image: {}x{}", image.width, image.height);
/// println!(
///     "Aspect ratio: {}:{}",
///     image.aspect_ratio.pan(),
///     image.aspect_ratio.pad()
/// );
///
/// // Access pixels (RGBA format, 4 bytes per pixel)
/// let first_pixel = &image.pixels[0..4];
/// # Ok::<(), icy_sixel::SixelError>(())
/// ```
#[deprecated(since = "0.5.0", note = "use SixelImage::decode() instead")]
#[must_use = "this returns the decoded SixelImage"]
pub fn sixel_decode(data: &[u8]) -> Result<SixelImage> {
    SixelImage::decode(data)
}

#[deprecated(since = "0.5.0", note = "use SixelImage::decode_from_dcs() instead")]
#[must_use = "this returns the decoded SixelImage"]
pub fn sixel_decode_from_dcs(payload: &[u8], settings: DcsSettings) -> Result<SixelImage> {
    SixelImage::decode_from_dcs(payload, settings)
}

struct AnsiPayload<'a> {
    aspect_ratio: Option<u16>,
    zero_color: Option<u16>,
    grid_size: Option<u16>,
    payload: &'a [u8],
}

impl<'a> AnsiPayload<'a> {
    fn parse(bytes: &'a [u8]) -> Result<Self> {
        let mut idx = 0;
        while idx < bytes.len() {
            match bytes[idx] {
                0x90 => {
                    return Self::parse_dcs(bytes, idx + 1);
                }
                0x1b => {
                    if idx + 1 < bytes.len() && bytes[idx + 1] == b'P' {
                        return Self::parse_dcs(bytes, idx + 2);
                    }
                    idx += 1;
                }
                _ => idx += 1,
            }
        }

        Ok(AnsiPayload {
            aspect_ratio: None,
            zero_color: None,
            grid_size: None,
            payload: bytes,
        })
    }

    fn parse_dcs(bytes: &'a [u8], mut idx: usize) -> Result<Self> {
        let mut params: [u16; 16] = [0; 16];
        let mut param_count = 0usize;
        let mut current: u16 = 0;
        let mut has_digit = false;

        while idx < bytes.len() {
            match bytes[idx] {
                b'0'..=b'9' => {
                    let digit = (bytes[idx] - b'0') as u16;
                    current = current.saturating_mul(10).saturating_add(digit);
                    has_digit = true;
                    idx += 1;
                }
                b';' => {
                    if param_count < params.len() {
                        params[param_count] = if has_digit { current } else { 0 };
                        param_count += 1;
                    }
                    current = 0;
                    has_digit = false;
                    idx += 1;
                }
                b'q' => {
                    if param_count < params.len() && (has_digit || param_count > 0) {
                        params[param_count] = if has_digit { current } else { 0 };
                        param_count += 1;
                    }
                    idx += 1;
                    break;
                }
                0x1b | 0x9c => {
                    return Err(SixelError::InvalidData("malformed SIXEL data".to_string()));
                }
                _ => idx += 1,
            }
        }

        if idx > bytes.len() {
            return Err(SixelError::InvalidData("malformed SIXEL data".to_string()));
        }

        let payload_start = idx;
        let mut payload_end = bytes.len();
        let mut cursor = payload_start;
        while cursor < bytes.len() {
            match bytes[cursor] {
                0x9c => {
                    payload_end = cursor;
                    break;
                }
                0x1b => {
                    if cursor + 1 < bytes.len() && bytes[cursor + 1] == b'\\' {
                        payload_end = cursor;
                        break;
                    }
                    cursor += 1;
                }
                _ => cursor += 1,
            }
        }

        let aspect_ratio = if param_count > 0 {
            Some(params[0])
        } else {
            None
        };
        let zero_color = if param_count > 1 {
            Some(params[1])
        } else {
            None
        };
        let grid_size = if param_count > 2 {
            Some(params[2])
        } else {
            None
        };

        Ok(AnsiPayload {
            aspect_ratio,
            zero_color,
            grid_size,
            payload: &bytes[payload_start..payload_end],
        })
    }
}

#[derive(Clone, Copy, Default)]
pub struct DcsSettings {
    aspect_ratio: Option<u16>,
    #[allow(dead_code)]
    zero_color: Option<u16>,
    grid_size: Option<u16>,
}

impl DcsSettings {
    pub fn new(aspect_ratio: Option<u16>, zero_color: Option<u16>, grid_size: Option<u16>) -> Self {
        Self {
            aspect_ratio,
            zero_color,
            grid_size,
        }
    }

    /// Sets the pixel aspect ratio (P1) using the typed enum.
    #[must_use]
    pub fn with_pixel_aspect_ratio(mut self, aspect_ratio: PixelAspectRatio) -> Self {
        self.aspect_ratio = Some(aspect_ratio.to_p1_value() as u16);
        self
    }

    /// Sets the background mode (P2) using the typed enum.
    #[must_use]
    pub fn with_background_mode(mut self, background_mode: BackgroundMode) -> Self {
        self.zero_color = Some(background_mode.to_p2_value() as u16);
        self
    }

    /// Sets the grid size (P3) raw value.
    #[must_use]
    pub fn with_grid_size(mut self, grid_size: u16) -> Self {
        self.grid_size = Some(grid_size);
        self
    }
}

struct SixelDecoder {
    canvas: Canvas,
    palette: Palette,
    color_index: usize,
    current_color: [u8; 4], // RGBA with alpha channel
    repeat: usize,
    pos_x: usize,
    pos_y: usize,
    max_x: usize,
    max_y: usize,
    pan: usize,
    pad: usize,
    target_width: usize,
    target_height: usize,
    background_index: usize,
    /// P2=1 means transparent mode: undrawn pixels remain transparent (alpha=0)
    transparent_mode: bool,
}

impl SixelDecoder {
    fn new(settings: DcsSettings) -> Result<Self> {
        let palette = Palette::new();
        let background_index = 0usize;
        let repeat = 1usize;
        let current_color = palette.rgb_bytes(0);

        // P2=1 means transparent mode
        let transparent_mode = settings.zero_color == Some(1);

        // In transparent mode, background has alpha=0; otherwise alpha=255
        let background = if transparent_mode {
            [0, 0, 0, 0] // Transparent
        } else {
            palette.rgb_bytes(background_index)
        };

        let mut decoder = Self {
            canvas: Canvas::new(background),
            palette,
            color_index: 0,
            current_color,
            repeat,
            pos_x: 0,
            pos_y: 0,
            max_x: 0,
            max_y: 0,
            pan: 2,
            pad: 1,
            target_width: 0,
            target_height: 0,
            background_index,
            transparent_mode,
        };

        decoder.apply_dcs_settings(settings);
        Ok(decoder)
    }

    fn apply_dcs_settings(&mut self, settings: DcsSettings) {
        if let Some(ar) = settings.aspect_ratio {
            self.pad = match ar {
                0 | 1 => 2,
                2 => 5,
                3 | 4 => 4,
                5 | 6 => 3,
                7 | 8 => 2,
                9 => 1,
                _ => self.pad,
            };
        }

        if let Some(mut grid) = settings.grid_size {
            if grid == 0 {
                grid = 10;
            }
            self.pan = (self.pan * grid as usize).max(1) / 10;
            self.pad = (self.pad * grid as usize).max(1) / 10;
            self.pan = self.pan.max(1);
            self.pad = self.pad.max(1);
        }
    }

    fn process(&mut self, data: &[u8]) -> Result<()> {
        let mut idx = 0usize;
        while idx < data.len() {
            match data[idx] {
                b'\n' | b'\r' | b'\t' | b'\x0c' => {
                    idx += 1;
                }
                b'$' => {
                    self.pos_x = 0;
                    idx += 1;
                }
                b'-' => {
                    self.pos_x = 0;
                    self.pos_y = self
                        .pos_y
                        .checked_add(SIXEL_CELL_HEIGHT)
                        .ok_or(SixelError::IntegerOverflow)?;
                    idx += 1;
                }
                b'!' => {
                    let (value, consumed) = read_number(data, idx + 1);
                    let repeat = if value == 0 { 1 } else { value };
                    if repeat > MAX_REPEAT {
                        return Err(SixelError::InvalidData("malformed SIXEL data".to_string()));
                    }
                    self.repeat = repeat;
                    idx += 1 + consumed;
                }
                b'#' => {
                    let consumed = self.handle_color_command(data, idx + 1)?;
                    idx += 1 + consumed;
                }
                b'"' => {
                    let consumed = self.handle_raster_command(data, idx + 1)?;
                    idx += 1 + consumed;
                }
                b'?'..=b'~' => {
                    self.handle_sixel(data[idx])?;
                    idx += 1;
                }
                0x1b | 0x9c => break,
                _ => idx += 1,
            }
        }
        Ok(())
    }

    #[inline]
    fn handle_sixel(&mut self, ch: u8) -> Result<()> {
        let bits = ch - b'?';
        let span = self.repeat.max(1);
        self.repeat = 1;

        let width_needed = self.pos_x + span;
        let height_needed = self.pos_y + SIXEL_CELL_HEIGHT;

        // Quick overflow check
        if width_needed > SIXEL_WIDTH_LIMIT || height_needed > SIXEL_HEIGHT_LIMIT {
            return Err(SixelError::InvalidData("malformed SIXEL data".to_string()));
        }

        let background = self.background_rgb();
        self.canvas
            .ensure_visible(width_needed, height_needed, background)?;

        // Use cached color for performance
        let color = self.current_color;
        let mut touched = false;

        // Unroll loop - process all 6 bits
        if (bits & 0b000001) != 0 {
            self.canvas.paint_span(self.pos_y, self.pos_x, span, color);
            touched = true;
        }
        if (bits & 0b000010) != 0 {
            self.canvas
                .paint_span(self.pos_y + 1, self.pos_x, span, color);
            touched = true;
        }
        if (bits & 0b000100) != 0 {
            self.canvas
                .paint_span(self.pos_y + 2, self.pos_x, span, color);
            touched = true;
        }
        if (bits & 0b001000) != 0 {
            self.canvas
                .paint_span(self.pos_y + 3, self.pos_x, span, color);
            touched = true;
        }
        if (bits & 0b010000) != 0 {
            self.canvas
                .paint_span(self.pos_y + 4, self.pos_x, span, color);
            touched = true;
        }
        if (bits & 0b100000) != 0 {
            self.canvas
                .paint_span(self.pos_y + 5, self.pos_x, span, color);
            touched = true;
        }

        if span > 0 {
            let last_x = self.pos_x + span - 1;
            if last_x > self.max_x {
                self.max_x = last_x;
            }
        }

        if touched {
            let last_y = self.pos_y + SIXEL_CELL_HEIGHT - 1;
            if last_y > self.max_y {
                self.max_y = last_y;
            }
        }

        self.pos_x = width_needed;
        Ok(())
    }

    fn handle_color_command(&mut self, data: &[u8], start: usize) -> Result<usize> {
        let mut storage = [0i32; 5];
        let (consumed, count) = collect_params(data, start, &mut storage);
        let params = &storage[..count];

        if params.is_empty() {
            self.color_index = 0;
            return Ok(consumed);
        }

        let color_idx = params[0].max(0) as usize;
        self.color_index = color_idx.min(SIXEL_PALETTE_MAX - 1);
        self.current_color = self.palette.rgb_bytes(self.color_index);

        if params.len() >= 5 {
            let colorspace = params[1];
            match colorspace {
                1 => {
                    self.palette
                        .set_hls(self.color_index, params[2], params[3], params[4]);
                    self.current_color = self.palette.rgb_bytes(self.color_index);
                }
                2 => {
                    self.palette
                        .set_rgb_percent(self.color_index, params[2], params[3], params[4]);
                    self.current_color = self.palette.rgb_bytes(self.color_index);
                }
                _ => {}
            }
        }

        Ok(consumed)
    }

    fn handle_raster_command(&mut self, data: &[u8], start: usize) -> Result<usize> {
        let mut storage = [0i32; 4];
        let (consumed, count) = collect_params(data, start, &mut storage);
        if count > 0 {
            let pad = storage[0].max(1) as usize;
            self.pad = pad;
        }
        if count > 1 {
            let pan = storage[1].max(1) as usize;
            self.pan = pan;
        }
        if count > 2 {
            let ph = storage[2].max(0) as usize;
            if ph > 0 {
                self.target_width = ph;
            }
        }
        if count > 3 {
            let pv = storage[3].max(0) as usize;
            if pv > 0 {
                self.target_height = pv;
            }
        }

        if self.target_width > 0 || self.target_height > 0 {
            let background = self.background_rgb();
            let width = self.target_width.max(1);
            let height = self.target_height.max(1);
            self.guard_dimensions(width, height)?;
            self.canvas.ensure_visible(width, height, background)?;
        }

        Ok(consumed)
    }

    fn guard_dimensions(&self, width: usize, height: usize) -> Result<()> {
        if width > SIXEL_WIDTH_LIMIT || height > SIXEL_HEIGHT_LIMIT {
            return Err(SixelError::InvalidData("malformed SIXEL data".to_string()));
        }
        // Also guard against total pixel count to prevent memory exhaustion
        // Max 256 MB of pixel data (64 million pixels * 4 bytes)
        const MAX_PIXELS: usize = 64 * 1024 * 1024;
        if width.saturating_mul(height) > MAX_PIXELS {
            return Err(SixelError::InvalidData(
                "image dimensions too large".to_string(),
            ));
        }
        Ok(())
    }

    fn background_rgb(&self) -> [u8; 4] {
        if self.transparent_mode {
            [0, 0, 0, 0] // Transparent background
        } else {
            self.palette
                .rgb_bytes(self.background_index.min(SIXEL_PALETTE_MAX - 1))
        }
    }

    fn finalize(mut self) -> Result<(Vec<u8>, usize, usize)> {
        let width = self.max_x + 1;
        let height = self.max_y + 1;
        let desired_width = width.max(self.target_width.max(1));
        let desired_height = height.max(self.target_height.max(1));
        self.guard_dimensions(desired_width, desired_height)?;
        let background = self.background_rgb();
        self.canvas
            .ensure_visible(desired_width, desired_height, background)?;
        Ok((self.canvas.data, self.canvas.width, self.canvas.height))
    }
}

struct Palette {
    colors: [u32; SIXEL_PALETTE_MAX],
}

impl Palette {
    fn new() -> Self {
        let mut colors = [0u32; SIXEL_PALETTE_MAX];
        const BASE: &[(i32, i32, i32)] = &[
            (0, 0, 0),
            (20, 20, 80),
            (80, 13, 13),
            (20, 80, 20),
            (80, 20, 80),
            (20, 80, 80),
            (80, 80, 20),
            (53, 53, 53),
            (26, 26, 26),
            (33, 33, 60),
            (60, 26, 26),
            (33, 60, 33),
            (60, 33, 60),
            (33, 60, 60),
            (60, 60, 33),
            (80, 80, 80),
        ];

        for (idx, &(r, g, b)) in BASE.iter().enumerate() {
            colors[idx] = pack_rgb(percent_to_byte(r), percent_to_byte(g), percent_to_byte(b));
        }

        let mut cursor = BASE.len();
        for r in 0..6 {
            for g in 0..6 {
                for b in 0..6 {
                    let red = percent_to_byte(r * 20);
                    let green = percent_to_byte(g * 20);
                    let blue = percent_to_byte(b * 20);
                    if cursor < SIXEL_PALETTE_MAX {
                        colors[cursor] = pack_rgb(red, green, blue);
                    }
                    cursor += 1;
                }
            }
        }

        for level in 0..24 {
            if cursor >= SIXEL_PALETTE_MAX {
                break;
            }
            let value = percent_to_byte(level * 100 / 23);
            colors[cursor] = pack_rgb(value, value, value);
            cursor += 1;
        }

        while cursor < SIXEL_PALETTE_MAX {
            colors[cursor] = 0x00ffffff;
            cursor += 1;
        }

        Self { colors }
    }

    fn rgb_bytes(&self, index: usize) -> [u8; 4] {
        let color = self.colors[index.min(SIXEL_PALETTE_MAX - 1)];
        [
            ((color >> 16) & 0xff) as u8,
            ((color >> 8) & 0xff) as u8,
            (color & 0xff) as u8,
            0xFF, // Alpha channel
        ]
    }

    fn set_rgb_percent(&mut self, index: usize, r: i32, g: i32, b: i32) {
        let red = percent_to_byte(r);
        let green = percent_to_byte(g);
        let blue = percent_to_byte(b);
        if index < SIXEL_PALETTE_MAX {
            self.colors[index] = pack_rgb(red, green, blue);
        }
    }

    fn set_hls(&mut self, index: usize, h: i32, l: i32, s: i32) {
        if index >= SIXEL_PALETTE_MAX {
            return;
        }
        let rgb = hls_to_rgb(h, l, s);
        self.colors[index] = pack_rgb(rgb[0], rgb[1], rgb[2]);
    }
}

struct Canvas {
    data: Vec<u8>,
    width: usize,
    height: usize,
}

impl Canvas {
    fn new(background: [u8; 4]) -> Self {
        let mut data = vec![0u8; 4];
        data[..4].copy_from_slice(&background);
        Self {
            data,
            width: 1,
            height: 1,
        }
    }

    fn ensure_visible(&mut self, width: usize, height: usize, background: [u8; 4]) -> Result<()> {
        if width <= self.width && height <= self.height {
            return Ok(());
        }

        let new_width = width.max(self.width);
        let new_height = height.max(self.height);

        // Guard against memory exhaustion - max 256 MB of pixel data
        const MAX_PIXELS: usize = 64 * 1024 * 1024;
        if new_width.saturating_mul(new_height) > MAX_PIXELS {
            return Err(SixelError::InvalidData(
                "image dimensions too large".to_string(),
            ));
        }

        self.resize(new_width.max(1), new_height.max(1), background);
        Ok(())
    }

    fn resize(&mut self, new_width: usize, new_height: usize, background: [u8; 4]) {
        let mut new_data = vec![0u8; new_width * new_height * 4];

        for row in 0..self.height {
            let src_start = row * self.width * 4;
            let src_end = src_start + self.width * 4;
            let dst_start = row * new_width * 4;
            new_data[dst_start..dst_start + self.width * 4]
                .copy_from_slice(&self.data[src_start..src_end]);
            if new_width > self.width {
                let span = &mut new_data[dst_start + self.width * 4..dst_start + new_width * 4];
                fill_rgba_span(span, background);
            }
        }

        if new_height > self.height {
            for row in self.height..new_height {
                let dst_start = row * new_width * 4;
                let dst_end = dst_start + new_width * 4;
                fill_rgba_span(&mut new_data[dst_start..dst_end], background);
            }
        }

        self.data = new_data;
        self.width = new_width;
        self.height = new_height;
    }

    #[inline]
    fn paint_span(&mut self, y: usize, x: usize, len: usize, color: [u8; 4]) {
        if len == 0 || y >= self.height || x >= self.width {
            return;
        }
        // Clip the span to the available width
        let available = self.width - x;
        let actual_len = len.min(available);
        let start = (y * self.width + x) * 4;

        // Fast path for single pixel
        if actual_len == 1 {
            unsafe {
                let ptr = self.data.as_mut_ptr().add(start);
                *ptr = color[0];
                *ptr.add(1) = color[1];
                *ptr.add(2) = color[2];
                *ptr.add(3) = color[3];
            }
            return;
        }

        let end = start + actual_len * 4;
        fill_rgba_span(&mut self.data[start..end], color);
    }
}

fn strip_string_terminator(data: &[u8]) -> &[u8] {
    if data.ends_with(b"\x1b\\") {
        &data[..data.len() - 2]
    } else if data.last() == Some(&0x9c) {
        &data[..data.len() - 1]
    } else {
        data
    }
}

fn read_number(data: &[u8], start: usize) -> (usize, usize) {
    let mut idx = start;
    let mut value: usize = 0;
    let mut consumed = 0;
    while idx < data.len() {
        match data[idx] {
            b'0'..=b'9' => {
                value = value
                    .saturating_mul(10)
                    .saturating_add((data[idx] - b'0') as usize);
                idx += 1;
                consumed += 1;
            }
            _ => break,
        }
    }
    (value, consumed)
}

fn collect_params(data: &[u8], start: usize, storage: &mut [i32]) -> (usize, usize) {
    let mut idx = start;
    let mut consumed = 0usize;
    let mut written = 0usize;
    let mut current = 0i32;
    let mut has_digit = false;
    let mut last_was_separator = false;

    while idx < data.len() {
        match data[idx] {
            b'0'..=b'9' => {
                current = current
                    .saturating_mul(10)
                    .saturating_add((data[idx] - b'0') as i32);
                has_digit = true;
                last_was_separator = false;
                idx += 1;
                consumed += 1;
            }
            b';' => {
                if written < storage.len() {
                    storage[written] = if has_digit { current } else { 0 };
                    written += 1;
                }
                current = 0;
                has_digit = false;
                last_was_separator = true;
                idx += 1;
                consumed += 1;
            }
            _ => break,
        }
    }

    if (has_digit || last_was_separator) && written < storage.len() {
        storage[written] = if has_digit { current } else { 0 };
        written += 1;
    }

    (consumed, written)
}

fn percent_to_byte(value: i32) -> u8 {
    let clamped = value.clamp(0, 100);
    ((clamped * 255 + 50) / 100) as u8
}

fn pack_rgb(r: u8, g: u8, b: u8) -> u32 {
    ((r as u32) << 16) | ((g as u32) << 8) | b as u32
}

fn hls_to_rgb(h: i32, l: i32, s: i32) -> [u8; 3] {
    if s <= 0 {
        let gray = percent_to_byte(l);
        return [gray, gray, gray];
    }

    let mut hue = (h + 240) % 360;
    if hue < 0 {
        hue += 360;
    }
    let hue = hue as f64 / 360.0;
    let lum = (l.clamp(0, 100) as f64) / 100.0;
    let sat = (s.clamp(0, 100) as f64) / 100.0;

    let q = if lum < 0.5 {
        lum * (1.0 + sat)
    } else {
        lum + sat - lum * sat
    };
    let p = 2.0 * lum - q;

    let r = hue_to_rgb(p, q, hue + 1.0 / 3.0);
    let g = hue_to_rgb(p, q, hue);
    let b = hue_to_rgb(p, q, hue - 1.0 / 3.0);

    [
        (r * 255.0 + 0.5).floor().clamp(0.0, 255.0) as u8,
        (g * 255.0 + 0.5).floor().clamp(0.0, 255.0) as u8,
        (b * 255.0 + 0.5).floor().clamp(0.0, 255.0) as u8,
    ]
}

fn hue_to_rgb(p: f64, q: f64, mut t: f64) -> f64 {
    if t < 0.0 {
        t += 1.0;
    }
    if t > 1.0 {
        t -= 1.0;
    }
    if t < 1.0 / 6.0 {
        return p + (q - p) * 6.0 * t;
    }
    if t < 1.0 / 2.0 {
        return q;
    }
    if t < 2.0 / 3.0 {
        return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    }
    p
}

fn fill_rgba_span(buf: &mut [u8], color: [u8; 4]) {
    if buf.is_empty() {
        return;
    }

    #[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
    {
        if try_fill_rgba_span_simd(buf, color) {
            return;
        }
    }

    fill_rgba_span_scalar(buf, color);
}

fn fill_rgba_span_scalar(buf: &mut [u8], color: [u8; 4]) {
    let len = buf.len();
    if len <= 4 {
        for (idx, byte) in buf.iter_mut().enumerate() {
            *byte = color[idx % 4];
        }
        return;
    }

    buf[..4].copy_from_slice(&color);
    let mut written = 4;
    while written < len {
        let copy = (len - written).min(written);
        let src = buf[..copy].as_ptr();
        unsafe {
            std::ptr::copy_nonoverlapping(src, buf[written..].as_mut_ptr(), copy);
        }
        written += copy;
    }
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
fn try_fill_rgba_span_simd(buf: &mut [u8], color: [u8; 4]) -> bool {
    if buf.len() < 64 {
        return false;
    }

    #[cfg(target_arch = "x86")]
    {
        if !std::is_x86_feature_detected!("sse2") {
            return false;
        }
    }

    unsafe { fill_rgba_span_sse(buf, color) };
    true
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
unsafe fn fill_rgba_span_sse(buf: &mut [u8], color: [u8; 4]) {
    let mut pattern = [0u8; 16];
    for idx in 0..16 {
        pattern[idx] = color[idx % 4];
    }

    let vec = _mm_loadu_si128(pattern.as_ptr() as *const __m128i);
    let mut ptr = buf.as_mut_ptr();
    let end = ptr.add(buf.len());
    while ptr.add(16) <= end {
        _mm_storeu_si128(ptr as *mut __m128i, vec);
        ptr = ptr.add(16);
    }
    let remaining = end.offset_from(ptr) as usize;
    if remaining > 0 {
        std::ptr::copy_nonoverlapping(pattern.as_ptr(), ptr, remaining);
    }
}

// RGB fill functions removed - decoder now outputs RGBA only
