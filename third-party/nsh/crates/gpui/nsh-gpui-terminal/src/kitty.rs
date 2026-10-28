//! Complete Kitty image transactions; terminal IO belongs to the embedding host.
//!
//! The host confirms the cursor origin before writing [`KittyFrame::into_wire`]
//! indivisibly. The new image requests a success reply (`q=0`) and sits above
//! the retained previous placement. Reuse a slot only after the complete write
//! and matching success reply. Neither receipt proves monitor presentation.
//! The sole reader ends the graphics session on errors for either owned slot.

use anyhow::{Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};

use crate::{CandidateFrame, FrameToken, wire};
const CHUNK_BYTES: usize = 4096;

/// A complete, lossless snapshot independent of the terminal's image slots.
#[derive(Debug)]
#[non_exhaustive]
pub struct KittyFrame {
    token: FrameToken,
    width: u32,
    height: u32,
    columns: u16,
    rows: u16,
    payload: String,
}

impl KittyFrame {
    /// Compresses actual GPU pixels using their captured terminal dimensions.
    pub fn encode(frame: &CandidateFrame, columns: u16, rows: u16) -> Result<Self> {
        ensure!(
            columns > 0 && rows > 0,
            "terminal cell dimensions must be nonzero"
        );
        let (width, height) = wire::dimensions(frame)?;
        let png = wire::png(frame, width, height)?;
        Ok(Self {
            token: frame.token.clone(),
            width,
            height,
            columns,
            rows,
            payload: STANDARD.encode(&png),
        })
    }

    /// The native frame identity, still awaiting the output receipt.
    pub fn token(&self) -> FrameToken {
        self.token.clone()
    }

    /// Complete base64 PNG size, before binding terminal placement commands.
    pub fn payload_len(&self) -> usize {
        self.payload.len()
    }

    /// Binds the complete transaction to the writer's current acknowledged slots.
    /// `image` must be the alternate slot: retransmission removes its placements.
    pub fn into_wire(self, image: u32, previous: Option<u32>) -> Result<Vec<u8>> {
        ensure!(
            image != 0 && previous != Some(0) && previous != Some(image),
            "invalid Kitty image slots"
        );
        let Self {
            width,
            height,
            columns,
            rows,
            payload,
            ..
        } = self;
        let chunks = payload.len().div_ceil(CHUNK_BYTES);
        let first = format!(
            "\x1b[?2026h\x1b[H\x1b_Ga=T,t=d,f=100,s={width},v={height},i={image},p=1,C=1,z=1,c={columns},r={rows},q=0,m={};",
            u8::from(chunks > 1)
        );
        let mut retain = previous.map_or_else(Vec::new, |old| {
            format!("\x1b_Ga=p,i={old},p=1,C=1,z=0,c={columns},r={rows},q=1\x1b\\").into_bytes()
        });
        retain.extend_from_slice(b"\x1b[?2026l");
        let wire_bytes = first
            .len()
            .checked_add(payload.len())
            .and_then(|n| n.checked_add(2)) // the first APC's ST
            .and_then(|n| {
                (chunks - 1)
                    .checked_mul(9)
                    .and_then(|extra| n.checked_add(extra))
            })
            .and_then(|n| n.checked_add(retain.len()))
            .ok_or_else(|| anyhow::anyhow!("terminal image wire size overflow"))?;
        let mut wire = Vec::new();
        wire.try_reserve_exact(wire_bytes)?;
        for (index, chunk) in payload.as_bytes().chunks(CHUNK_BYTES).enumerate() {
            if index == 0 {
                wire.extend_from_slice(first.as_bytes());
            } else {
                wire.extend_from_slice(if index + 1 < chunks {
                    b"\x1b_Gm=1;"
                } else {
                    b"\x1b_Gm=0;"
                });
            }
            wire.extend_from_slice(chunk);
            wire.extend_from_slice(b"\x1b\\");
        }
        wire.extend_from_slice(&retain);
        debug_assert_eq!(wire.len(), wire_bytes);
        Ok(wire)
    }
}

/// Queries actual Kitty support without creating or displaying an image.
///
/// Consume only the sole reader's successful reply for this nonzero nonce.
/// Keep the nonce distinct from both of the session's owned image slots.
pub fn capability_query(nonce: u32) -> Result<Vec<u8>> {
    ensure!(nonce != 0, "the Kitty query nonce must be nonzero");
    Ok(format!("\x1b_Ga=q,t=d,f=32,s=1,v=1,i={nonce};AAAAAA==\x1b\\").into_bytes())
}

/// Deletes only the caller's two owned image slots during terminal restoration.
pub fn cleanup(first: u32, second: u32) -> Result<Vec<u8>> {
    ensure!(
        first != 0 && second != 0 && first != second,
        "invalid Kitty image slots"
    );
    Ok(format!("\x1b_Ga=d,d=I,i={first},q=2\x1b\\\x1b_Ga=d,d=I,i={second},q=2\x1b\\").into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: i32, height: i32) -> CandidateFrame {
        let mut seed = 177u32;
        let pixels = (0..width * height * 4)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                seed as u8
            })
            .collect();
        CandidateFrame {
            token: FrameToken {
                issuer: Some(std::sync::Arc::new(())),
                sequence: 1,
                viewport_generation: 1,
            },
            size: gpui::size(gpui::DevicePixels(width), gpui::DevicePixels(height)),
            pixels,
        }
    }

    #[test]
    fn rgba_payload_survives_chunking_with_the_previous_image_retained_below() {
        let frame = frame(192, 192);
        let encoded = KittyFrame::encode(&frame, 120, 40).unwrap();
        assert_eq!(encoded.token(), frame.token());
        let bytes = encoded.into_wire(41, Some(73)).unwrap();
        let wire = std::str::from_utf8(&bytes)
            .unwrap()
            .strip_prefix("\x1b[?2026h\x1b[H")
            .unwrap()
            .strip_suffix("\x1b_Ga=p,i=73,p=1,C=1,z=0,c=120,r=40,q=1\x1b\\\x1b[?2026l")
            .unwrap()
            .strip_suffix("\x1b\\")
            .unwrap();
        let packets: Vec<_> = wire.split("\x1b\\").collect();
        assert!(packets.len() > 1);
        let mut payload = String::new();
        for (index, packet) in packets.iter().enumerate() {
            let (control, chunk) = packet
                .strip_prefix("\x1b_G")
                .unwrap()
                .split_once(';')
                .unwrap();
            assert!(chunk.len() <= 4096);
            assert_eq!(chunk.len() % 4, 0);
            if index + 1 < packets.len() {
                assert_eq!(chunk.len(), 4096);
            }
            if index == 0 {
                assert_eq!(
                    control,
                    "a=T,t=d,f=100,s=192,v=192,i=41,p=1,C=1,z=1,c=120,r=40,q=0,m=1"
                );
            } else {
                assert_eq!(
                    control,
                    if index + 1 < packets.len() {
                        "m=1"
                    } else {
                        "m=0"
                    }
                );
            }
            payload.push_str(chunk);
        }
        let png = STANDARD.decode(payload).unwrap();
        let decoded = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
            .unwrap()
            .into_rgba8();
        assert_eq!(decoded.dimensions(), (192, 192));
        assert_eq!(decoded.as_raw(), frame.pixels());
    }

    #[test]
    fn complete_frames_preserve_large_scenes_and_reject_previous_slot_reuse() {
        let small = frame(1, 1);
        for (image, previous) in [(41, Some(41)), (0, Some(41)), (41, Some(0))] {
            assert!(
                KittyFrame::encode(&small, 120, 40)
                    .unwrap()
                    .into_wire(image, previous)
                    .is_err()
            );
        }
        assert!(KittyFrame::encode(&small, 0, 40).is_err());
        assert!(KittyFrame::encode(&small, 120, 0).is_err());
        let first = KittyFrame::encode(&small, 120, 40)
            .unwrap()
            .into_wire(41, None)
            .unwrap();
        let first_payload = std::str::from_utf8(&first)
            .unwrap()
            .strip_prefix(
                "\x1b[?2026h\x1b[H\x1b_Ga=T,t=d,f=100,s=1,v=1,i=41,p=1,C=1,z=1,c=120,r=40,q=0,m=0;",
            )
            .unwrap()
            .strip_suffix("\x1b\\\x1b[?2026l")
            .unwrap();
        let png = STANDARD.decode(first_payload).unwrap();
        let decoded = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
            .unwrap()
            .into_rgba8();
        assert_eq!(decoded.dimensions(), (1, 1));
        assert_eq!(decoded.as_raw(), small.pixels());
        let large = frame(1800, 1200);
        let encoded = KittyFrame::encode(&large, 120, 40).unwrap();
        assert_eq!(encoded.token(), large.token());
        let wire = encoded.into_wire(73, Some(41)).unwrap();
        assert!(wire.len() > 8 * 1024 * 1024);
        let payload: String = std::str::from_utf8(&wire)
            .unwrap()
            .strip_prefix("\x1b[?2026h\x1b[H")
            .unwrap()
            .strip_suffix("\x1b\\\x1b_Ga=p,i=41,p=1,C=1,z=0,c=120,r=40,q=1\x1b\\\x1b[?2026l")
            .unwrap()
            .split("\x1b\\")
            .map(|packet| packet.split_once(';').unwrap().1)
            .collect();
        let png = STANDARD.decode(payload).unwrap();
        let decoded = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
            .unwrap()
            .into_rgba8();
        assert_eq!(decoded.dimensions(), (1800, 1200));
        assert_eq!(decoded.as_raw(), large.pixels());
        assert!(capability_query(0).is_err());
        assert_eq!(
            capability_query(99).unwrap(),
            b"\x1b_Ga=q,t=d,f=32,s=1,v=1,i=99;AAAAAA==\x1b\\"
        );
        assert_eq!(
            cleanup(41, 73).unwrap(),
            b"\x1b_Ga=d,d=I,i=41,q=2\x1b\\\x1b_Ga=d,d=I,i=73,q=2\x1b\\"
        );
        assert!(cleanup(0, 73).is_err());
        assert!(cleanup(41, 0).is_err());
        assert!(cleanup(41, 41).is_err());
    }
}
