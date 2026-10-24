//! Complete Kitty image transactions; terminal IO belongs to the embedding host.
//!
//! Write and flush [`KittyFrame::wire`] indivisibly: the complete back-image
//! upload requests errors only (`q=1`) and precedes retirement of the old image.
//! That flush receipt records the completed output transaction; success
//! replies do not gate publication or prove monitor presentation or refresh rate.
//! The embedding host's sole reader must end the graphics session on any
//! negative reply for either owned image slot, including a late error.

use anyhow::{Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};

use crate::{CandidateFrame, FrameToken, wire};
const CHUNK_BYTES: usize = 4096;

/// One fully admitted wire transaction containing upload followed by retirement.
#[derive(Debug, Default)]
#[non_exhaustive]
pub struct KittyFrame {
    token: FrameToken,
    image: u32,
    wire: Vec<u8>,
}

impl KittyFrame {
    /// Compresses actual GPU pixels and admits their complete wire transaction.
    ///
    /// The caller owns two nonzero image slots. `previous` identifies the last
    /// fully written frame's slot; `image` uses the alternate slot. Kitty
    /// removes an image's placements when its id is retransmitted. Dimensions
    /// use real terminal metrics.
    pub fn encode(
        frame: &CandidateFrame,
        image: u32,
        previous: Option<u32>,
        columns: u16,
        rows: u16,
    ) -> Result<Self> {
        ensure!(
            image != 0 && previous != Some(0) && previous != Some(image),
            "invalid Kitty image slots"
        );
        ensure!(
            columns > 0 && rows > 0,
            "terminal cell dimensions must be nonzero"
        );
        let (width, height) = wire::dimensions(frame)?;
        let png = wire::png(frame, width, height)?;
        let encoded_bytes = png
            .len()
            .checked_add(2)
            .and_then(|n| (n / 3).checked_mul(4))
            .ok_or_else(|| anyhow::anyhow!("terminal PNG payload size overflow"))?;
        let chunks = encoded_bytes.div_ceil(CHUNK_BYTES);
        let first = format!(
            "\x1b[H\x1b_Ga=T,t=d,f=100,s={width},v={height},i={image},p=1,C=1,c={columns},r={rows},q=1,m={};",
            u8::from(chunks > 1)
        );
        let retire = previous.map_or_else(Vec::new, |old| {
            format!("\x1b[?2026h\x1b_Ga=d,d=I,i={old},q=2\x1b\\\x1b[?2026l").into_bytes()
        });
        let wire_bytes = first
            .len()
            .checked_add(encoded_bytes)
            .and_then(|n| n.checked_add(2)) // the first APC's ST
            .and_then(|n| {
                (chunks - 1)
                    .checked_mul(9)
                    .and_then(|extra| n.checked_add(extra))
            })
            .and_then(|n| n.checked_add(retire.len()))
            .ok_or_else(|| anyhow::anyhow!("terminal image wire size overflow"))?;
        let payload = STANDARD.encode(&png);
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
        wire.extend_from_slice(&retire);
        debug_assert_eq!(wire.len(), wire_bytes);
        Ok(Self {
            token: frame.token.clone(),
            image,
            wire,
        })
    }

    /// The native frame identity, still awaiting the output receipt.
    pub fn token(&self) -> FrameToken {
        self.token.clone()
    }

    /// The owned back-image id used for this frame's placement `p=1`.
    pub fn image_id(&self) -> u32 {
        self.image
    }

    /// Complete upload and retirement bytes, written and flushed indivisibly.
    ///
    /// Kitty stacks equal-z images by id, so a smaller back id may still be
    /// behind the old image until retirement. Only a successful flush of all
    /// these bytes records completion of this frame's output transaction.
    pub fn wire(&self) -> &[u8] {
        &self.wire
    }

    /// Transfers the complete upload and retirement transaction to its writer.
    pub fn into_wire(self) -> Vec<u8> {
        self.wire
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
    fn rgba_payload_survives_chunking_and_only_the_old_owned_image_is_retired() {
        let frame = frame(192, 192);
        let encoded = KittyFrame::encode(&frame, 41, Some(73), 120, 40).unwrap();
        assert_eq!(encoded.token(), frame.token());
        assert_eq!(encoded.image_id(), 41);
        let bytes = encoded.into_wire();
        let wire = std::str::from_utf8(&bytes)
            .unwrap()
            .strip_prefix("\x1b[H")
            .unwrap()
            .strip_suffix("\x1b[?2026h\x1b_Ga=d,d=I,i=73,q=2\x1b\\\x1b[?2026l")
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
                    "a=T,t=d,f=100,s=192,v=192,i=41,p=1,C=1,c=120,r=40,q=1,m=1"
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
        assert!(KittyFrame::encode(&small, 41, Some(41), 120, 40).is_err());
        assert!(KittyFrame::encode(&small, 0, Some(41), 120, 40).is_err());
        assert!(KittyFrame::encode(&small, 41, Some(0), 120, 40).is_err());
        assert!(KittyFrame::encode(&small, 41, None, 0, 40).is_err());
        assert!(KittyFrame::encode(&small, 41, None, 120, 0).is_err());
        let first = KittyFrame::encode(&small, 41, None, 120, 40).unwrap();
        let first_payload = std::str::from_utf8(first.wire())
            .unwrap()
            .strip_prefix("\x1b[H\x1b_Ga=T,t=d,f=100,s=1,v=1,i=41,p=1,C=1,c=120,r=40,q=1,m=0;")
            .unwrap()
            .strip_suffix("\x1b\\")
            .unwrap();
        let png = STANDARD.decode(first_payload).unwrap();
        let decoded = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
            .unwrap()
            .into_rgba8();
        assert_eq!(decoded.dimensions(), (1, 1));
        assert_eq!(decoded.as_raw(), small.pixels());
        let large = frame(1800, 1200);
        let encoded = KittyFrame::encode(&large, 41, None, 120, 40).unwrap();
        assert!(encoded.wire().len() > 8 * 1024 * 1024);
        let payload: String = std::str::from_utf8(encoded.wire())
            .unwrap()
            .strip_prefix("\x1b[H")
            .unwrap()
            .strip_suffix("\x1b\\")
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
        assert_eq!(encoded.token(), large.token());
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
