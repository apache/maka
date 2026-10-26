//! Full-viewport Sixel and iTerm2 images for an already owned alternate screen.
//!
//! The embedding driver negotiates image support, real viewport geometry and
//! mouse units independently. Sixel additionally needs a verified static display
//! mode (DECSDM 80) that the driver saves and restores through its sole reader
//! and writer. These codecs neither query stdin nor change that session mode.
//!
//! Each transaction replaces the owned alternate viewport's full image and
//! restores the cursor to its top left. An opaque Sixel replacement can retain
//! the previous image until the new DCS is complete. Erase it before leaving
//! that alternate screen; never apply this full-viewport contract to the user's
//! main screen. Neither protocol supplies a per-image success acknowledgement.
//! The sole output owner's complete write and flush receipt is the available
//! publication fact; it does not authorize input or prove scanout.

use std::io::Write;

use anyhow::{Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};

use crate::{CandidateFrame, FrameToken, wire};

/// A negotiated image transport for the same complete native GPUI scene.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InlineProtocol {
    /// Palette-based Sixel; the terminal must clip a final partial six-row band.
    Sixel,
    /// OSC 1337 File-streaming PNG, sized to the actual viewport's character cells.
    /// Its payload may exceed generic OSC limits; the embedder must establish
    /// this protocol's streaming support on its actual terminal transport.
    Iterm2,
}

/// A complete transaction awaiting the sole terminal writer's receipt.
#[derive(Debug, Default)]
#[non_exhaustive]
pub struct InlineFrame {
    token: FrameToken,
    bytes: Vec<u8>,
}

impl InlineFrame {
    /// Encodes the actual GPU readback without rescaling its pixels or reducing
    /// the selected codec's colour palette.
    ///
    /// Run on the existing graphics worker, outside the output owner's IO lock.
    /// `synchronized` is an independently negotiated synchronized-update
    /// capability. The transaction includes all of its matching controls.
    /// `same_viewport_flushed` is the sole writer's proof that a previous whole
    /// image transaction was written and flushed since the last viewport
    /// geometry change. Pass false without that receipt. Only fully opaque
    /// Sixel pixels can replace that image without first erasing the viewport.
    pub fn encode(
        frame: &CandidateFrame,
        protocol: InlineProtocol,
        columns: u16,
        rows: u16,
        synchronized: bool,
        same_viewport_flushed: bool,
    ) -> Result<Self> {
        ensure!(
            columns > 0 && rows > 0,
            "terminal cell dimensions must be nonzero"
        );
        let (width, height) = wire::dimensions(frame)?;
        let mut output = wire::FrameBytes::new();
        if synchronized {
            output.write_all(b"\x1b[?2026h")?;
        }
        output.write_all(b"\x1b[H")?;
        if protocol != InlineProtocol::Sixel
            || !same_viewport_flushed
            || !frame
                .pixels()
                .as_chunks::<4>()
                .0
                .iter()
                .all(|pixel| pixel[3] == 255)
        {
            output.write_all(b"\x1b[2J")?;
        }
        let suffix = if synchronized {
            b"\x1b[H\x1b[?2026l".as_slice()
        } else {
            b"\x1b[H".as_slice()
        };
        match protocol {
            InlineProtocol::Sixel => icy_sixel::sixel_encode_into(
                frame.pixels(),
                usize::try_from(width)?,
                usize::try_from(height)?,
                &icy_sixel::EncodeOptions::default(),
                &mut output,
            )?,
            InlineProtocol::Iterm2 => {
                let png = wire::png(frame, width, height)?;
                // Cell dimensions cover the same viewport even when a terminal
                // has a Retina preference that changes the meaning of "px".
                let header = format!(
                    "\x1b]1337;File=inline=1;size={};width={columns};height={rows};preserveAspectRatio=0:",
                    png.len()
                );
                let total = png
                    .len()
                    .checked_add(2)
                    .and_then(|n| (n / 3).checked_mul(4))
                    .and_then(|n| n.checked_add(header.len()))
                    .and_then(|n| n.checked_add(1 + suffix.len()))
                    .and_then(|n| n.checked_add(output.len()))
                    .ok_or_else(|| anyhow::anyhow!("terminal image wire size overflow"))?;
                output.try_reserve(total - output.len())?;
                output.write_all(header.as_bytes())?;
                output.write_all(STANDARD.encode(&png).as_bytes())?;
                output.write_all(b"\x07")?;
            }
        }
        output.write_all(suffix)?;
        Ok(Self {
            token: frame.token(),
            bytes: output.into_vec(),
        })
    }

    /// The original draw's identity, still awaiting its actual output receipt.
    pub fn token(&self) -> FrameToken {
        self.token.clone()
    }

    /// Complete indivisible bytes, including any synchronized-update controls.
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Transfers the complete inline image transaction to its writer.
    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

/// Clears only the complete alternate viewport already owned by the embedder.
///
/// Flush before leaving the alternate screen, then restore the driver's saved
/// DECSDM and input modes. This neither erases scrollback nor deletes Kitty ids.
pub fn cleanup() -> &'static [u8] {
    b"\x1b[H\x1b[2J"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame() -> CandidateFrame {
        CandidateFrame {
            token: FrameToken {
                issuer: Some(std::sync::Arc::new(())),
                sequence: 7,
                viewport_generation: 2,
            },
            size: gpui::size(gpui::DevicePixels(2), gpui::DevicePixels(6)),
            pixels: [
                255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255,
                0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255,
                0, 0, 255, 255, 255, 255, 255, 255,
            ]
            .to_vec(),
        }
    }

    #[test]
    fn the_same_native_scene_survives_both_inline_transports() {
        let source = frame();
        for protocol in [InlineProtocol::Sixel, InlineProtocol::Iterm2] {
            let encoded = InlineFrame::encode(&source, protocol, 1, 1, false, false).unwrap();
            assert_eq!(encoded.token(), source.token());
            let bytes = encoded.into_bytes();
            let payload = bytes
                .strip_prefix(b"\x1b[H\x1b[2J")
                .unwrap()
                .strip_suffix(b"\x1b[H")
                .unwrap();
            let pixels = match protocol {
                InlineProtocol::Sixel => {
                    let decoded = icy_sixel::SixelImage::decode(payload).unwrap();
                    assert_eq!((decoded.width, decoded.height), (2, 6));
                    decoded.pixels
                }
                InlineProtocol::Iterm2 => {
                    let payload = std::str::from_utf8(payload).unwrap();
                    let (header, png) = payload
                        .strip_suffix('\x07')
                        .unwrap()
                        .split_once(':')
                        .unwrap();
                    let header = header
                        .strip_prefix("\x1b]1337;File=inline=1;size=")
                        .unwrap();
                    let (size, geometry) = header.split_once(';').unwrap();
                    assert_eq!(geometry, "width=1;height=1;preserveAspectRatio=0");
                    let png = STANDARD.decode(png).unwrap();
                    assert_eq!(size.parse::<usize>().unwrap(), png.len());
                    let decoded =
                        image::load_from_memory_with_format(&png, image::ImageFormat::Png)
                            .unwrap()
                            .into_rgba8();
                    assert_eq!(decoded.dimensions(), (2, 6));
                    decoded.into_raw()
                }
            };
            assert_eq!(pixels, source.pixels());
        }
    }

    #[test]
    fn whole_transactions_include_controls_and_reject_inert_frames() {
        let source = frame();
        for protocol in [InlineProtocol::Sixel, InlineProtocol::Iterm2] {
            let encoded = InlineFrame::encode(&source, protocol, 1, 1, true, false).unwrap();
            assert!(encoded.bytes().starts_with(b"\x1b[?2026h\x1b[H\x1b[2J"));
            assert!(encoded.bytes().ends_with(b"\x1b[H\x1b[?2026l"));
            assert!(
                InlineFrame::encode(&CandidateFrame::default(), protocol, 1, 1, false, false)
                    .is_err()
            );
            assert!(InlineFrame::encode(&source, protocol, 0, 1, false, false).is_err());

            let without_sync = InlineFrame::encode(&source, protocol, 1, 1, false, false).unwrap();
            assert_eq!(encoded.bytes().len(), without_sync.bytes().len() + 16);
        }
    }

    #[test]
    fn opaque_sixel_replaces_every_pixel_without_erasing_a_flushed_viewport() {
        let mut source = frame();
        source.size.height = gpui::DevicePixels(7);
        source.pixels = [0, 0, 0, 255, 255, 255, 255, 255].repeat(7);
        let first =
            InlineFrame::encode(&source, InlineProtocol::Sixel, 1, 1, false, false).unwrap();
        assert!(first.bytes().starts_with(b"\x1b[H\x1b[2J\x1bP"));
        let replacement =
            InlineFrame::encode(&source, InlineProtocol::Sixel, 1, 1, false, true).unwrap();
        assert!(
            !replacement
                .bytes()
                .windows(4)
                .any(|bytes| bytes == b"\x1b[2J")
        );
        let payload = replacement
            .bytes()
            .strip_prefix(b"\x1b[H")
            .unwrap()
            .strip_suffix(b"\x1b[H")
            .unwrap();
        let decoded = icy_sixel::SixelImage::decode(payload).unwrap();
        assert_eq!((decoded.width, decoded.height), (2, 12));
        assert_eq!(
            &decoded.pixels[..56],
            [0, 0, 0, 255, 255, 255, 255, 255].repeat(7)
        );
        assert_eq!(&decoded.pixels[56..], [0; 40]);
    }

    #[test]
    fn transparent_sixel_and_iterm_still_erase_the_previous_image() {
        let mut source = frame();
        for alpha in [0, 127, 128, 254] {
            source.pixels[3] = alpha;
            let encoded =
                InlineFrame::encode(&source, InlineProtocol::Sixel, 1, 1, false, true).unwrap();
            assert!(encoded.bytes().starts_with(b"\x1b[H\x1b[2J\x1bP"));
        }
        source.pixels[3] = 255;
        let encoded =
            InlineFrame::encode(&source, InlineProtocol::Iterm2, 1, 1, false, true).unwrap();
        assert!(encoded.bytes().starts_with(b"\x1b[H\x1b[2J\x1b]1337;"));
    }

    #[test]
    fn iterm_file_streaming_roundtrips_a_scene_larger_than_generic_osc_limits() {
        let mut source = frame();
        source.size = gpui::size(gpui::DevicePixels(1920), gpui::DevicePixels(1200));
        let mut seed = 177u32;
        source.pixels = (0..1920 * 1200 * 4)
            .map(|index| {
                if index % 4 == 3 {
                    return 255;
                }
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                seed as u8
            })
            .collect();
        // Keep explicit alpha coverage in an otherwise opaque desktop image.
        source.pixels[3] = 127;
        let last_alpha = source.pixels.len() - 1;
        source.pixels[last_alpha] = 0;
        let encoded =
            InlineFrame::encode(&source, InlineProtocol::Iterm2, 120, 40, true, false).unwrap();
        let payload = encoded
            .bytes()
            .strip_prefix(b"\x1b[?2026h\x1b[H\x1b[2J")
            .unwrap()
            .strip_suffix(b"\x1b[H\x1b[?2026l")
            .unwrap();
        assert!(payload.len() > 1_048_576);
        assert!(encoded.bytes().len() > 8 * 1024 * 1024);
        let payload = std::str::from_utf8(payload).unwrap();
        let (header, png) = payload
            .strip_suffix('\x07')
            .unwrap()
            .split_once(':')
            .unwrap();
        let header = header
            .strip_prefix("\x1b]1337;File=inline=1;size=")
            .unwrap();
        let (size, geometry) = header.split_once(';').unwrap();
        assert_eq!(geometry, "width=120;height=40;preserveAspectRatio=0");
        let png = STANDARD.decode(png).unwrap();
        assert_eq!(size.parse::<usize>().unwrap(), png.len());
        let decoded = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
            .unwrap()
            .into_rgba8();
        assert_eq!(decoded.dimensions(), (1920, 1200));
        assert_eq!(decoded.as_raw(), source.pixels());
    }
}
