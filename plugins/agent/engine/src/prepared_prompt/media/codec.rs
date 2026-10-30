/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use image::{ColorType, GenericImageView, ImageDecoder, ImageFormat, ImageReader, Limits, Rgb};
use miniz_oxide::deflate::core::{
    CompressorOxide, TDEFLFlush, TDEFLStatus, compress_to_output, create_comp_flags_from_zip_params,
};
use std::io::{Cursor, Write};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Geometry {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct ImageProbe {
    pub geometry: Geometry,
    pub format: ImageFormat,
    bytes_per_pixel: usize,
    jpeg_samples: usize,
}

#[derive(Clone, Debug)]
pub(super) struct CodecPlan {
    pub input_bytes: usize,
    pub decoded_bytes: usize,
    pub decoder_scratch_bytes: usize,
    pub output_format: ImageFormat,
    // Streamed output lives in the existing file arena and is not resident memory.
    pub peak_bytes: usize,
    probe: ImageProbe,
}

pub(super) fn probe(encoded: &[u8]) -> Result<ImageProbe, String> {
    let format = image::guess_format(encoded).map_err(|error| error.to_string())?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP
    ) {
        return Err("image format cannot be prepared".into());
    }
    let size = imagesize::blob_size(encoded).map_err(|error| error.to_string())?;
    let width = u32::try_from(size.width).map_err(|_| "image width overflows u32")?;
    let height = u32::try_from(size.height).map_err(|_| "image height overflows u32")?;
    if width == 0 || height == 0 {
        return Err("image dimensions must be nonzero".into());
    }
    let bytes_per_pixel = if format == ImageFormat::Png {
        let depth = *encoded
            .get(24)
            .ok_or("PNG probe requires the 26-byte header")?;
        let color = *encoded
            .get(25)
            .ok_or("PNG probe requires the 26-byte header")?;
        // EXPAND resolves packed samples/palettes and tRNS. A header-only probe
        // reserves a possible transparency channel for grayscale/RGB originals.
        let samples = match color {
            0 | 4 => 2,
            2 | 6 | 3 => 4,
            _ => return Err("invalid PNG color type".into()),
        };
        let sample_bytes = match depth {
            1 | 2 | 4 | 8 => 1,
            16 if color != 3 => 2,
            _ => return Err("invalid PNG sample depth".into()),
        };
        samples * sample_bytes
    } else {
        4
    };
    let jpeg_samples = if format == ImageFormat::Jpeg {
        jpeg_samples(encoded)?
    } else {
        0
    };
    Ok(ImageProbe {
        geometry: Geometry { width, height },
        format,
        bytes_per_pixel,
        jpeg_samples,
    })
}

// SOF component sampling factors determine the progressive coefficient allocation.
fn jpeg_samples(encoded: &[u8]) -> Result<usize, String> {
    let mut position = 2usize;
    while position < encoded.len() {
        if encoded[position] != 0xff {
            return Err("invalid JPEG marker".into());
        }
        while encoded.get(position) == Some(&0xff) {
            position += 1;
        }
        let marker = *encoded.get(position).ok_or("incomplete JPEG header")?;
        position += 1;
        if matches!(marker, 0x01 | 0xd0..=0xd9) {
            continue;
        }
        let bytes = encoded
            .get(position..position + 2)
            .ok_or("incomplete JPEG header")?;
        let length = usize::from(u16::from_be_bytes([bytes[0], bytes[1]]));
        if length < 2 {
            return Err("invalid JPEG segment length".into());
        }
        let end = position
            .checked_add(length)
            .ok_or("JPEG header length overflow")?;
        let segment = encoded
            .get(position..end)
            .ok_or("JPEG probe prefix does not include the SOF segment")?;
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            let components = usize::from(*segment.get(7).ok_or("incomplete JPEG SOF")?);
            if !(1..=4).contains(&components) {
                return Err("unsupported JPEG component count".into());
            }
            let mut samples = 0;
            for index in 0..components {
                let factor = *segment
                    .get(9 + index * 3)
                    .ok_or("incomplete JPEG component")?;
                let (horizontal, vertical) = (usize::from(factor >> 4), usize::from(factor & 15));
                if !(1..=4).contains(&horizontal) || !(1..=4).contains(&vertical) {
                    return Err("invalid JPEG sampling factor".into());
                }
                samples += horizontal * vertical;
            }
            return Ok(samples);
        }
        position = end;
    }
    Err("JPEG probe prefix does not include the SOF segment".into())
}

pub(super) fn plan_format(
    probe: &ImageProbe,
    input_bytes: usize,
    output: Geometry,
    output_format: ImageFormat,
) -> Result<CodecPlan, String> {
    if !matches!(output_format, ImageFormat::Png | ImageFormat::Jpeg) {
        return Err("image preparation supports PNG or JPEG output".into());
    }
    let Geometry { width, height } = probe.geometry;
    let pixels = checked_mul(width as usize, height as usize)?;
    let decoded_bytes = checked_mul(pixels, probe.bytes_per_pixel)?;
    let padded_width = checked_mul((width as usize).div_ceil(32), 32)?;
    let padded_height = checked_mul((height as usize).div_ceil(32), 32)?;
    let padded_pixels = checked_mul(padded_width, padded_height)?;
    let decoder_scratch_bytes = match probe.format {
        ImageFormat::Png => {
            // Limits are installed before metadata parsing; text/ICC is ignored.
            checked_add(
                checked_add(decoded_bytes, checked_mul(width as usize, 32)?)?,
                checked_add(input_bytes, 128 * 1024)?,
            )?
        }
        ImageFormat::Jpeg => {
            // zune-jpeg mcu_prog/mcu retain i16 coefficients per SOF sample;
            // use 8x8/noninterleaved MCU padding even for interleaved scans.
            // Component row/upsampler arrays and image's owned compressed-input
            // copy (including Vec growth and retained APP metadata) are separate.
            let coefficients = checked_mul(checked_mul(padded_pixels, probe.jpeg_samples)?, 2)?;
            let rows = checked_mul(checked_mul(padded_width, probe.jpeg_samples)?, 512)?;
            checked_add(
                checked_add(coefficients, rows)?,
                checked_add(checked_mul(input_bytes, 8)?, 1024 * 1024)?,
            )?
        }
        ImageFormat::Gif => {
            // One RGBA frame can coexist with the caller's logical-screen output.
            // GIF's LZW tables, palettes and parser buffers do not scale with frames.
            checked_add(
                checked_mul(pixels, 4)?,
                checked_add(checked_mul(input_bytes, 2)?, 256 * 1024)?,
            )?
        }
        ImageFormat::WebP => {
            // VP8 planes use 16x16 padded geometry; VP8L transforms/entropy maps,
            // animated frame/canvas and ALPH expansion fit eight canvas bytes/pixel.
            // Compressed partition Vec growth is covered independently. Huffman
            // allocation is input-driven and is checked by the vendored decoder.
            checked_add(
                checked_add(checked_mul(pixels, 8)?, checked_mul(padded_pixels, 2)?)?,
                checked_add(
                    checked_mul(input_bytes, 8)?,
                    checked_add(webp_huffman_bytes(pixels, input_bytes)?, 512 * 1024)?,
                )?,
            )?
        }
        _ => return Err("unsupported image codec".into()),
    };
    // miniz_oxide 0.9 uses fixed arrays: hash chains/dictionary < 165 KiB,
    // local output < 86 KiB, Huffman tables < 5 KiB, and inline state < 70 KiB.
    // Include construction temporaries plus our 65535-byte filter buffer.
    let encoder_scratch_bytes = if output_format == ImageFormat::Jpeg {
        // image's JPEG encoder retains three 8x8 byte blocks and i32 DCT blocks,
        // two quantization tables, component descriptors and a reused header Vec.
        // Neither its pixel view nor its scratch grows with image dimensions.
        16 * 1024
    } else {
        512 * 1024
    };
    validate_output(probe.geometry, output, output_format)?;
    let resize_row_bytes = if output != probe.geometry && output_format == ImageFormat::Png {
        checked_mul(output.width as usize, probe.bytes_per_pixel)?
    } else {
        0
    };
    let encoder_scratch_bytes = checked_add(encoder_scratch_bytes, resize_row_bytes)?;
    let peak_bytes = [decoded_bytes, decoder_scratch_bytes, encoder_scratch_bytes]
        .into_iter()
        .try_fold(input_bytes, checked_add)?;
    Ok(CodecPlan {
        input_bytes,
        decoded_bytes,
        decoder_scratch_bytes,
        output_format,
        peak_bytes,
        probe: *probe,
    })
}

pub(super) struct DecodedImage {
    geometry: Geometry,
    depth: u8,
    color: u8,
    bytes_per_pixel: usize,
    pixels: Vec<u8>,
}

/// Runs synchronously; the owner must promote the plan and join its blocking worker.
pub(super) fn decode(encoded: &[u8], plan: &CodecPlan) -> Result<DecodedImage, String> {
    if encoded.len() != plan.input_bytes || probe(encoded)?.geometry != plan.probe.geometry {
        return Err("image changed after preparation planning".into());
    }
    if plan.probe.format != ImageFormat::Png {
        return decode_other(encoded, plan);
    }
    let mut decoder = png::Decoder::new_with_limits(
        Cursor::new(encoded),
        png::Limits {
            bytes: plan.decoder_scratch_bytes,
        },
    );
    decoder.set_ignore_text_chunk(true);
    decoder.set_ignore_iccp_chunk(true);
    decoder.set_transformations(png::Transformations::EXPAND);
    let mut reader = decoder.read_info().map_err(|error| error.to_string())?;
    if (reader.info().width, reader.info().height)
        != (plan.probe.geometry.width, plan.probe.geometry.height)
    {
        return Err("decoder geometry differs from image header".into());
    }
    let (color, depth) = reader.output_color_type();
    let (depth, color, bytes_per_pixel) = png_color(color, depth)?;
    let length = reader
        .output_buffer_size()
        .ok_or("decoded image exceeds address space")?;
    if length > plan.decoded_bytes {
        return Err("decoded image exceeds its preparation plan".into());
    }
    let mut pixels = Vec::new();
    pixels
        .try_reserve_exact(length)
        .map_err(|error| error.to_string())?;
    pixels.resize(length, 0);
    let frame = reader
        .next_frame(&mut pixels)
        .map_err(|error| error.to_string())?;
    if (frame.width, frame.height) != (plan.probe.geometry.width, plan.probe.geometry.height) {
        return Err("PNG first frame does not cover the original canvas".into());
    }
    Ok(DecodedImage {
        geometry: plan.probe.geometry,
        depth,
        color,
        bytes_per_pixel,
        pixels,
    })
}

fn webp_huffman_bytes(pixels: usize, input_bytes: usize) -> Result<usize, String> {
    checked_add(
        checked_mul(pixels, 2)?,
        checked_add(checked_mul(input_bytes, 2)?, 512 * 1024)?,
    )
}

fn decode_other(encoded: &[u8], plan: &CodecPlan) -> Result<DecodedImage, String> {
    let geometry = plan.probe.geometry;
    if plan.probe.format == ImageFormat::WebP {
        let mut decoder = image_webp::WebPDecoder::new(Cursor::new(encoded))
            .map_err(|error| error.to_string())?;
        if decoder.dimensions() != (geometry.width, geometry.height) {
            return Err("WebP decoder geometry differs from its preparation plan".into());
        }
        let pixels = checked_mul(geometry.width as usize, geometry.height as usize)?;
        decoder.set_memory_limit(webp_huffman_bytes(pixels, encoded.len())?);
        let length = decoder
            .output_buffer_size()
            .ok_or("WebP output exceeds address space")?;
        let mut output = allocate_pixels(length, plan.decoded_bytes)?;
        decoder
            .read_image(&mut output)
            .map_err(|error| error.to_string())?;
        let bytes_per_pixel = if decoder.has_alpha() { 4 } else { 3 };
        return Ok(DecodedImage {
            geometry,
            depth: 8,
            color: if bytes_per_pixel == 4 { 6 } else { 2 },
            bytes_per_pixel,
            pixels: output,
        });
    }
    if plan.probe.format == ImageFormat::Gif {
        let mut options = gif::DecodeOptions::new();
        options.set_color_output(gif::ColorOutput::RGBA);
        options.check_frame_consistency(true);
        options.set_memory_limit(gif::MemoryLimit::Bytes(
            std::num::NonZeroU64::new(plan.decoder_scratch_bytes as u64)
                .ok_or("empty GIF allocation plan")?,
        ));
        let mut reader = options
            .read_info(Cursor::new(encoded))
            .map_err(|error| error.to_string())?;
        if (u32::from(reader.width()), u32::from(reader.height()))
            != (geometry.width, geometry.height)
        {
            return Err("GIF decoder geometry differs from its preparation plan".into());
        }
        let (left, top, width, height) = {
            let frame = reader
                .next_frame_info()
                .map_err(|error| error.to_string())?
                .ok_or("GIF contains no frame")?;
            (
                u32::from(frame.left),
                u32::from(frame.top),
                u32::from(frame.width),
                u32::from(frame.height),
            )
        };
        if left
            .checked_add(width)
            .is_none_or(|end| end > geometry.width)
            || top
                .checked_add(height)
                .is_none_or(|end| end > geometry.height)
        {
            return Err("GIF frame lies outside its logical screen".into());
        }
        let frame_bytes = checked_mul(checked_mul(width as usize, height as usize)?, 4)?;
        let mut frame = allocate_pixels(frame_bytes, plan.decoded_bytes)?;
        reader
            .read_into_buffer(&mut frame)
            .map_err(|error| error.to_string())?;
        let mut pixels = allocate_pixels(plan.decoded_bytes, plan.decoded_bytes)?;
        let stride = geometry.width as usize * 4;
        let row_bytes = width as usize * 4;
        for row in 0..height as usize {
            let offset = (top as usize + row) * stride + left as usize * 4;
            pixels[offset..offset + row_bytes]
                .copy_from_slice(&frame[row * row_bytes..(row + 1) * row_bytes]);
        }
        return Ok(DecodedImage {
            geometry,
            depth: 8,
            color: 6,
            bytes_per_pixel: 4,
            pixels,
        });
    }
    let mut limits = Limits::no_limits();
    limits.max_image_width = Some(geometry.width);
    limits.max_image_height = Some(geometry.height);
    // JPEG memory is accounted from SOF sampling/input above; its backend
    // does not enforce image::Limits.max_alloc.
    limits.max_alloc = Some(plan.decoder_scratch_bytes as u64);
    let mut reader = ImageReader::with_format(Cursor::new(encoded), plan.probe.format);
    reader.limits(limits);
    let decoder = reader.into_decoder().map_err(|error| error.to_string())?;
    if decoder.dimensions() != (geometry.width, geometry.height) {
        return Err("image decoder geometry differs from its preparation plan".into());
    }
    let (color, bytes_per_pixel) = match decoder.color_type() {
        ColorType::L8 => (0, 1),
        ColorType::La8 => (4, 2),
        ColorType::Rgb8 => (2, 3),
        ColorType::Rgba8 => (6, 4),
        _ => return Err("image decoder returned unsupported samples".into()),
    };
    let length =
        usize::try_from(decoder.total_bytes()).map_err(|_| "image output exceeds address space")?;
    let mut pixels = allocate_pixels(length, plan.decoded_bytes)?;
    decoder
        .read_image(&mut pixels)
        .map_err(|error| error.to_string())?;
    Ok(DecodedImage {
        geometry,
        depth: 8,
        color,
        bytes_per_pixel,
        pixels,
    })
}

fn allocate_pixels(length: usize, maximum: usize) -> Result<Vec<u8>, String> {
    if length > maximum {
        return Err("image output exceeds its preparation plan".into());
    }
    let mut pixels = Vec::new();
    pixels
        .try_reserve_exact(length)
        .map_err(|error| error.to_string())?;
    pixels.resize(length, 0);
    Ok(pixels)
}

fn validate_output(
    original: Geometry,
    output: Geometry,
    format: ImageFormat,
) -> Result<(), String> {
    if output.width == 0
        || output.height == 0
        || output.width > original.width
        || output.height > original.height
    {
        return Err(
            "image output must have nonzero dimensions within the original geometry".into(),
        );
    }
    if format == ImageFormat::Jpeg
        && (output.width > u32::from(u16::MAX) || output.height > u32::from(u16::MAX))
    {
        return Err("JPEG output dimensions exceed its 16-bit representation".into());
    }
    Ok(())
}

impl DecodedImage {
    pub(super) fn write_image(
        &self,
        output: Geometry,
        format: ImageFormat,
        writer: &mut dyn Write,
    ) -> std::io::Result<()> {
        validate_output(self.geometry, output, format).map_err(std::io::Error::other)?;
        match format {
            ImageFormat::Png => self.write_png(output, writer),
            ImageFormat::Jpeg => {
                // JPEG uses an on-demand view: no full resized or RGB image is allocated.
                image::codecs::jpeg::JpegEncoder::new_with_quality(writer, 90)
                    .encode_image(&JpegView {
                        image: self,
                        output,
                    })
                    .map_err(|error| match error {
                        image::ImageError::IoError(error) => error,
                        error => std::io::Error::other(error),
                    })
            }
            _ => Err(std::io::Error::other(
                "image preparation supports PNG or JPEG output",
            )),
        }
    }

    fn write_png(&self, output: Geometry, writer: &mut dyn Write) -> std::io::Result<()> {
        let bpp = self.bytes_per_pixel;
        writer.write_all(b"\x89PNG\r\n\x1a\n")?;
        let mut header = [0; 13];
        header[..4].copy_from_slice(&output.width.to_be_bytes());
        header[4..8].copy_from_slice(&output.height.to_be_bytes());
        header[8] = self.depth;
        header[9] = self.color;
        chunk(writer, b"IHDR", &[&header])?;
        let mut compressor = CompressorOxide::new(create_comp_flags_from_zip_params(1, 15, 0));
        let row_bytes = output.width as usize * bpp;
        let stride = self.geometry.width as usize * bpp;
        let mut resized_row = if output != self.geometry {
            vec![0; row_bytes]
        } else {
            Vec::new()
        };
        let mut scratch = [0u8; 65_535];
        for y in 0..output.height {
            let row = if output == self.geometry {
                &self.pixels[y as usize * stride..y as usize * stride + row_bytes]
            } else {
                for x in 0..output.width {
                    let pixel = self.sample_pixel(x, y, output);
                    let gray_alpha = [pixel[0], pixel[3]];
                    let channels: &[u16] = match self.color {
                        0 => &pixel[..1],
                        2 => &pixel[..3],
                        4 => &gray_alpha,
                        6 => &pixel,
                        _ => unreachable!("decoded PNG color type was validated"),
                    };
                    let destination = &mut resized_row[x as usize * bpp..(x as usize + 1) * bpp];
                    if self.depth == 16 {
                        for (sample, bytes) in
                            channels.iter().zip(destination.as_chunks_mut::<2>().0)
                        {
                            bytes.copy_from_slice(&sample.to_be_bytes());
                        }
                    } else {
                        for (sample, byte) in channels.iter().zip(destination) {
                            *byte = *sample as u8;
                        }
                    }
                }
                &resized_row
            };
            compress_png(&mut compressor, &[1], TDEFLFlush::None, writer)?;
            let mut offset = 0;
            while offset < row.len() {
                let count = (row.len() - offset).min(scratch.len());
                for (index, out) in scratch[..count].iter_mut().enumerate() {
                    let source = offset + index;
                    *out =
                        row[source].wrapping_sub(if source < bpp { 0 } else { row[source - bpp] });
                }
                compress_png(&mut compressor, &scratch[..count], TDEFLFlush::None, writer)?;
                offset += count;
            }
        }
        compress_png(&mut compressor, &[], TDEFLFlush::Finish, writer)?;
        chunk(writer, b"IEND", &[])
    }

    fn pixel(&self, x: u32, y: u32) -> [u16; 4] {
        let offset =
            (y as usize * self.geometry.width as usize + x as usize) * self.bytes_per_pixel;
        let sample = |channel: usize| {
            if self.depth == 16 {
                let offset = offset + channel * 2;
                u16::from_be_bytes([self.pixels[offset], self.pixels[offset + 1]])
            } else {
                u16::from(self.pixels[offset + channel])
            }
        };
        let maximum = if self.depth == 16 { u16::MAX } else { 255 };
        match self.color {
            0 => [sample(0), sample(0), sample(0), maximum],
            4 => [sample(0), sample(0), sample(0), sample(1)],
            2 => [sample(0), sample(1), sample(2), maximum],
            6 => [sample(0), sample(1), sample(2), sample(3)],
            _ => unreachable!("decoded pixel type was validated"),
        }
    }

    // Integrate the whole source footprint of each output pixel. Premultiplied
    // alpha avoids halos; only four accumulators are live, independent of geometry.
    fn sample_pixel(&self, x: u32, y: u32, output: Geometry) -> [u16; 4] {
        if output == self.geometry {
            return self.pixel(x, y);
        }
        let scale_x = f64::from(self.geometry.width) / f64::from(output.width);
        let scale_y = f64::from(self.geometry.height) / f64::from(output.height);
        let left = f64::from(x) * scale_x;
        let right = (f64::from(x) + 1.0) * scale_x;
        let top = f64::from(y) * scale_y;
        let bottom = (f64::from(y) + 1.0) * scale_y;
        let mut sums = [0.0; 4];
        for source_y in top.floor() as u32..(bottom.ceil() as u32).min(self.geometry.height) {
            let weight_y = bottom.min(f64::from(source_y) + 1.0) - top.max(f64::from(source_y));
            for source_x in left.floor() as u32..(right.ceil() as u32).min(self.geometry.width) {
                let weight = weight_y
                    * (right.min(f64::from(source_x) + 1.0) - left.max(f64::from(source_x)));
                let pixel = self.pixel(source_x, source_y);
                let alpha = f64::from(pixel[3]) * weight;
                for channel in 0..3 {
                    sums[channel] += f64::from(pixel[channel]) * alpha;
                }
                sums[3] += alpha;
            }
        }
        let mut pixel = [0; 4];
        if sums[3] > 0.0 {
            for channel in 0..3 {
                pixel[channel] = (sums[channel] / sums[3]).round() as u16;
            }
        }
        pixel[3] = (sums[3] / (scale_x * scale_y)).round() as u16;
        pixel
    }
}

struct JpegView<'a> {
    image: &'a DecodedImage,
    output: Geometry,
}
impl GenericImageView for JpegView<'_> {
    type Pixel = Rgb<u8>;
    fn dimensions(&self) -> (u32, u32) {
        (self.output.width, self.output.height)
    }
    fn get_pixel(&self, x: u32, y: u32) -> Self::Pixel {
        let pixel = self.image.sample_pixel(x, y, self.output);
        let to_byte = |value: u16| {
            if self.image.depth == 16 {
                ((u32::from(value) + 128) / 257) as u8
            } else {
                value as u8
            }
        };
        let alpha = to_byte(pixel[3]);
        let mut rgb = [to_byte(pixel[0]), to_byte(pixel[1]), to_byte(pixel[2])];
        for channel in &mut rgb {
            *channel =
                ((u16::from(*channel) * u16::from(alpha) + 255 * u16::from(255 - alpha) + 127)
                    / 255) as u8;
        }
        Rgb(rgb)
    }
}

fn png_color(color: png::ColorType, depth: png::BitDepth) -> Result<(u8, u8, usize), String> {
    let depth = match depth {
        png::BitDepth::Eight => 8,
        png::BitDepth::Sixteen => 16,
        _ => return Err("PNG decoder returned unexpanded samples".into()),
    };
    let color_code = match color {
        png::ColorType::Grayscale => 0,
        png::ColorType::Rgb => 2,
        png::ColorType::GrayscaleAlpha => 4,
        png::ColorType::Rgba => 6,
        png::ColorType::Indexed => return Err("PNG decoder returned unexpanded palette".into()),
    };
    Ok((depth, color_code, color.samples() * usize::from(depth / 8)))
}

fn compress_png(
    compressor: &mut CompressorOxide,
    input: &[u8],
    flush: TDEFLFlush,
    writer: &mut dyn Write,
) -> std::io::Result<()> {
    let mut write_error = None;
    let (status, consumed) = compress_to_output(compressor, input, flush, |bytes| {
        match chunk(writer, b"IDAT", &[bytes]) {
            Ok(()) => true,
            Err(error) => {
                write_error = Some(error);
                false
            }
        }
    });
    if let Some(error) = write_error {
        return Err(error);
    }
    let expected = if flush == TDEFLFlush::Finish {
        TDEFLStatus::Done
    } else {
        TDEFLStatus::Okay
    };
    if consumed != input.len() || status != expected {
        return Err(std::io::Error::other(
            "PNG compression did not consume its planned input",
        ));
    }
    Ok(())
}

fn chunk(writer: &mut dyn Write, kind: &[u8; 4], parts: &[&[u8]]) -> std::io::Result<()> {
    let length: usize = parts.iter().map(|part| part.len()).sum();
    let length = u32::try_from(length).map_err(std::io::Error::other)?;
    writer.write_all(&length.to_be_bytes())?;
    writer.write_all(kind)?;
    let mut crc = crc32fast::Hasher::new();
    crc.update(kind);
    for part in parts {
        writer.write_all(part)?;
        crc.update(part);
    }
    writer.write_all(&crc.finalize().to_be_bytes())
}
fn checked_mul(left: usize, right: usize) -> Result<usize, String> {
    left.checked_mul(right)
        .ok_or_else(|| "image preparation allocation overflows address space".into())
}
fn checked_add(left: usize, right: usize) -> Result<usize, String> {
    left.checked_add(right)
        .ok_or_else(|| "image preparation allocation overflows address space".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageEncoder, RgbImage};

    fn encoded(image: &RgbImage) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(
                image.as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
        bytes
    }

    #[test]
    fn whole_long_image_shrink_keeps_both_ends_and_area_average() {
        let original = RgbImage::from_fn(390, 45_480, |_, y| {
            if y < 22_740 {
                Rgb([240, 20, 30])
            } else {
                Rgb([10, 30, 230])
            }
        });
        let input = encoded(&original);
        let header = probe(&input[..26]).unwrap();
        let output = Geometry {
            width: 17,
            height: 2000,
        };
        let plan = plan_format(&header, input.len(), output, ImageFormat::Png).unwrap();
        assert!(plan.decoded_bytes >= 390 * 45_480 * 3);
        let decoded = decode(&input, &plan).unwrap();
        let mut bytes = Vec::new();
        decoded
            .write_image(output, ImageFormat::Png, &mut bytes)
            .unwrap();
        let image = image::load_from_memory(&bytes).unwrap().to_rgb8();
        assert_eq!(image.dimensions(), (17, 2000));
        assert_eq!(*image.get_pixel(8, 0), Rgb([240, 20, 30]));
        assert_eq!(*image.get_pixel(8, 1999), Rgb([10, 30, 230]));
    }

    #[test]
    fn area_shrink_includes_all_source_pixels_instead_of_subsampling() {
        let original = RgbImage::from_fn(4, 4, |x, y| {
            if (x + y) % 2 == 0 {
                Rgb([0; 3])
            } else {
                Rgb([200; 3])
            }
        });
        let input = encoded(&original);
        let output = Geometry {
            width: 1,
            height: 1,
        };
        let plan = plan_format(
            &probe(&input).unwrap(),
            input.len(),
            output,
            ImageFormat::Png,
        )
        .unwrap();
        let decoded = decode(&input, &plan).unwrap();
        let mut bytes = Vec::new();
        decoded
            .write_image(output, ImageFormat::Png, &mut bytes)
            .unwrap();
        assert_eq!(
            *image::load_from_memory(&bytes)
                .unwrap()
                .to_rgb8()
                .get_pixel(0, 0),
            Rgb([100; 3])
        );
    }

    #[test]
    fn area_shrink_weights_colors_by_alpha() {
        let mut input = Vec::new();
        image::codecs::png::PngEncoder::new(&mut input)
            .write_image(
                &[255, 0, 0, 255, 0, 0, 255, 0],
                2,
                1,
                image::ExtendedColorType::Rgba8,
            )
            .unwrap();
        let output = Geometry {
            width: 1,
            height: 1,
        };
        let plan = plan_format(
            &probe(&input).unwrap(),
            input.len(),
            output,
            ImageFormat::Png,
        )
        .unwrap();
        let decoded = decode(&input, &plan).unwrap();
        let mut bytes = Vec::new();
        decoded
            .write_image(output, ImageFormat::Png, &mut bytes)
            .unwrap();
        assert_eq!(
            image::load_from_memory(&bytes)
                .unwrap()
                .to_rgba8()
                .get_pixel(0, 0)
                .0,
            [255, 0, 0, 128]
        );
    }

    #[test]
    fn sixteen_bit_png_samples_remain_exact_without_resize() {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 2, 1);
            encoder.set_color(png::ColorType::GrayscaleAlpha);
            encoder.set_depth(png::BitDepth::Sixteen);
            encoder
                .write_header()
                .unwrap()
                .write_image_data(&[0x12, 0x34, 0x56, 0x78, 0xab, 0xcd, 0xef, 0x01])
                .unwrap();
        }
        let geometry = Geometry {
            width: 2,
            height: 1,
        };
        let plan = plan_format(
            &probe(&bytes).unwrap(),
            bytes.len(),
            geometry,
            ImageFormat::Png,
        )
        .unwrap();
        let decoded = decode(&bytes, &plan).unwrap();
        let mut output = Vec::new();
        decoded
            .write_image(geometry, ImageFormat::Png, &mut output)
            .unwrap();
        let mut reader = png::Decoder::new(Cursor::new(output)).read_info().unwrap();
        let mut samples = [0; 8];
        reader.next_frame(&mut samples).unwrap();
        assert_eq!(samples, [0x12, 0x34, 0x56, 0x78, 0xab, 0xcd, 0xef, 0x01]);
    }

    #[test]
    fn jpeg_webp_and_gif_whole_images_match_original_decoded_pixels() {
        let original = RgbImage::from_fn(17, 13, |x, y| Rgb([(x * 13) as u8, (y * 17) as u8, 111]));
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut jpeg)
            .encode_image(&original)
            .unwrap();
        let mut webp = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut webp)
            .write_image(original.as_raw(), 17, 13, image::ExtendedColorType::Rgb8)
            .unwrap();
        let mut gif = Vec::new();
        image::codecs::gif::GifEncoder::new(&mut gif)
            .encode_frame(image::Frame::new(
                image::DynamicImage::ImageRgb8(original).to_rgba8(),
            ))
            .unwrap();
        let output = Geometry {
            width: 17,
            height: 13,
        };
        for input in [jpeg, webp, gif] {
            let expected = image::load_from_memory(&input).unwrap().to_rgba8();
            let plan = plan_format(
                &probe(&input).unwrap(),
                input.len(),
                output,
                ImageFormat::Png,
            )
            .unwrap();
            let decoded = decode(&input, &plan).unwrap();
            let mut bytes = Vec::new();
            decoded
                .write_image(output, ImageFormat::Png, &mut bytes)
                .unwrap();
            assert_eq!(
                image::load_from_memory(&bytes).unwrap().to_rgba8(),
                expected
            );
        }
    }

    #[test]
    fn jpeg_resize_matches_its_wire_type_and_preserves_colors() {
        let original = RgbImage::from_pixel(19, 13, Rgb([40, 120, 200]));
        let input = encoded(&original);
        let output = Geometry {
            width: 9,
            height: 6,
        };
        let plan = plan_format(
            &probe(&input).unwrap(),
            input.len(),
            output,
            ImageFormat::Jpeg,
        )
        .unwrap();
        let decoded = decode(&input, &plan).unwrap();
        let mut bytes = Vec::new();
        decoded
            .write_image(output, ImageFormat::Jpeg, &mut bytes)
            .unwrap();
        assert_eq!(image::guess_format(&bytes).unwrap(), ImageFormat::Jpeg);
        let actual = image::load_from_memory(&bytes).unwrap().to_rgb8();
        assert_eq!(actual.dimensions(), (9, 6));
        for pixel in actual.pixels() {
            for (actual, expected) in pixel.0.into_iter().zip([40u8, 120, 200]) {
                assert!(actual.abs_diff(expected) <= 4);
            }
        }
    }

    #[test]
    fn webp_huffman_budget_is_enforced_before_building_tables() {
        let mut input = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut input)
            .write_image(&[19, 23, 31], 1, 1, image::ExtendedColorType::Rgb8)
            .unwrap();
        let mut decoder = image_webp::WebPDecoder::new(Cursor::new(input)).unwrap();
        decoder.set_memory_limit(0);
        assert!(matches!(
            decoder.read_image(&mut [0; 3]),
            Err(image_webp::DecodingError::MemoryLimitExceeded)
        ));
    }
}
