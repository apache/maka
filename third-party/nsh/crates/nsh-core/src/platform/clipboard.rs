//! What platforms answer clipboard reads with: the root's
//! [`EventKind::Clipboard`](crate::EventKind::Clipboard) payloads for images and files
//! ([`Command::ReadClipboardImage`](crate::Command::ReadClipboardImage),
//! [`Command::ReadClipboardFiles`](crate::Command::ReadClipboardFiles)), and
//! the `data:` and `file:` URIs they carry, so every backend writes them
//! the same way.

mod path_list;

pub use path_list::files_from_text;

use crate::{EventPayload, PayloadValue};

/// The largest image a clipboard read gives, in encoded bytes (48 MiB).
/// Its `data:` URI (a third larger) becomes a JS string the VM's heap holds
/// (256 MB for an embedded app), with whatever the app makes of it, such as
/// a `Blob`; running out of heap stops the VM, so a larger image is left
/// out of the answer, which carries its size instead (`tooLarge`; `has`
/// stays true): `Clipboard.readImage` rejects with
/// `ERR_NSH_QUOTA_EXCEEDED`, the Rust API reads it as none.
pub const MAX_IMAGE_BYTES: usize = 48 << 20;

/// The number of bytes base64 `data:` URI `uri` encodes, from its length
/// (nothing is decoded).
pub(crate) fn data_uri_len(uri: &str) -> usize {
    let data = uri.split_once(',').map_or("", |(_, data)| data);
    let padding = data.bytes().rev().take_while(|&b| b == b'=').count();
    (data.len() / 4 * 3 + data.len() % 4 * 3 / 4).saturating_sub(padding)
}

/// An image read from the clipboard, as the platform found it.
#[derive(Debug, Clone, Copy)]
pub struct Image<'a> {
    /// The encoded bytes (PNG, JPEG, ...).
    pub bytes: &'a [u8],
    /// Their MIME type (`image/png`).
    pub mime: &'a str,
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
}

impl<'a> Image<'a> {
    /// The image of encoded `bytes`, with the type and size read from their
    /// header (PNG, JPEG, GIF, BMP, WebP); `None` for other formats.
    pub fn sniff(bytes: &'a [u8]) -> Option<Image<'a>> {
        let mime = image_mime(bytes)?;
        let (width, height) = image_size(bytes)?;
        Some(Image {
            bytes,
            mime,
            width,
            height,
        })
    }
}

/// The answer to image read `id`: whether the clipboard holds an image and,
/// unless only that was asked (`image` is `None` then), the image as a
/// `data:` URI and its size. An image over [`MAX_IMAGE_BYTES`] is left
/// out, unencoded: `tooLarge` carries its size in bytes instead.
pub fn image_answer(id: u32, has: bool, image: Option<Image<'_>>) -> EventPayload {
    let mut fields = vec![
        ("id", PayloadValue::Number(id as f64)),
        ("has", PayloadValue::Bool(has || image.is_some())),
    ];
    match image {
        Some(image) if image.bytes.len() > MAX_IMAGE_BYTES => {
            fields.push(("tooLarge", PayloadValue::Number(image.bytes.len() as f64)));
        }
        Some(image) => {
            fields.push(("uri", PayloadValue::Str(data_uri(image.mime, image.bytes))));
            fields.push(("width", PayloadValue::Number(image.width as f64)));
            fields.push(("height", PayloadValue::Number(image.height as f64)));
        }
        None => {}
    }
    EventPayload::Map(fields)
}

/// The answer to files read `id`: the files' `file:` URLs (see
/// [`file_url`]), in the clipboard's order.
pub fn files_answer(id: u32, files: &[String]) -> EventPayload {
    EventPayload::Map(vec![
        ("id", PayloadValue::Number(id as f64)),
        ("has", PayloadValue::Bool(!files.is_empty())),
        ("files", PayloadValue::Str(files.join("\n"))),
    ])
}

/// A `data:` URI of `bytes` of type `mime`, base64 encoded.
pub fn data_uri(mime: &str, bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(13 + mime.len() + bytes.len().div_ceil(3) * 4);
    out.push_str("data:");
    out.push_str(mime);
    out.push_str(";base64,");
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        let sextets = [n >> 18, n >> 12, n >> 6, n];
        for (i, s) in sextets.iter().enumerate() {
            if i <= chunk.len() {
                out.push(TABLE[(*s & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The type and bytes of a base64 `data:` URI (`Clipboard.writeImage`'s
/// argument); `None` when it is not one.
pub fn decode_data_uri(uri: &str) -> Option<(&str, Vec<u8>)> {
    let rest = uri.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let mime = meta.strip_suffix(";base64")?;
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    };
    let mut out = Vec::with_capacity(data.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0);
    for c in data.bytes() {
        if c == b'=' || c.is_ascii_whitespace() {
            continue;
        }
        acc = (acc << 6) | u32::from(value(c)?);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some((mime, out))
}

/// The `file:` URL of an absolute path (`/tmp/a b.png` is
/// `file:///tmp/a%20b.png`; on Windows `C:\a.png` is `file:///C:/a.png` and
/// `\\server\share\a` is `file://server/share/a`), its bytes outside the
/// unreserved ones and `/` percent-encoded as UTF-8.
pub fn file_url(path: &str) -> String {
    let windows = path.starts_with("\\\\")
        || path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic();
    let path = if windows {
        path.replace('\\', "/")
    } else {
        path.to_owned()
    };
    let (host, path) = match path.strip_prefix("//") {
        Some(unc) => unc.split_once('/').unwrap_or((unc, "")),
        None => ("", path.as_str()),
    };
    let mut out = String::from("file://");
    out.push_str(host);
    if !path.starts_with('/') {
        out.push('/');
    }
    for b in path.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The MIME type of encoded image `bytes`, from their signature.
pub fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    Some(match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [b'B', b'M', ..] => "image/bmp",
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => "image/webp",
        [b'I', b'I', 42, 0, ..] | [b'M', b'M', 0, 42, ..] => "image/tiff",
        _ => return None,
    })
}

/// The size in pixels of encoded image `bytes`, from their header (PNG,
/// JPEG, GIF, BMP, WebP).
pub fn image_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let be16 = |i: usize| {
        Some(u32::from(u16::from_be_bytes(
            bytes.get(i..i + 2)?.try_into().ok()?,
        )))
    };
    let le16 = |i: usize| {
        Some(u32::from(u16::from_le_bytes(
            bytes.get(i..i + 2)?.try_into().ok()?,
        )))
    };
    let be32 = |i: usize| Some(u32::from_be_bytes(bytes.get(i..i + 4)?.try_into().ok()?));
    let le32 = |i: usize| Some(i32::from_le_bytes(bytes.get(i..i + 4)?.try_into().ok()?));
    let le24 = |i: usize| {
        let b = bytes.get(i..i + 3)?;
        Some(u32::from(b[0]) | (u32::from(b[1]) << 8) | (u32::from(b[2]) << 16))
    };
    match image_mime(bytes)? {
        "image/png" => Some((be32(16)?, be32(20)?)),
        "image/gif" => Some((le16(6)?, le16(8)?)),
        "image/bmp" => Some((le32(18)?.unsigned_abs(), le32(22)?.unsigned_abs())),
        "image/webp" => match bytes.get(12..16)? {
            b"VP8 " => Some((le16(26)? & 0x3FFF, le16(28)? & 0x3FFF)),
            b"VP8L" => {
                let b = u32::from_le_bytes(bytes.get(21..25)?.try_into().ok()?);
                Some(((b & 0x3FFF) + 1, ((b >> 14) & 0x3FFF) + 1))
            }
            b"VP8X" => Some((le24(24)? + 1, le24(27)? + 1)),
            _ => None,
        },
        "image/jpeg" => {
            // The first start-of-frame marker holds the size.
            let mut i = 2;
            while i + 9 < bytes.len() {
                if bytes[i] != 0xFF {
                    return None;
                }
                let marker = bytes[i + 1];
                let len = be16(i + 2)? as usize;
                let sof = matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
                if sof {
                    return Some((be16(i + 7)?, be16(i + 5)?));
                }
                i += 2 + len;
            }
            None
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 3×2 PNG's signature and header.
    const PNG: &[u8] = &[
        0x89, b'P', b'N', b'G', 13, 10, 26, 10, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0, 0, 0, 3, 0,
        0, 0, 2, 8, 6, 0, 0, 0,
    ];

    #[test]
    fn data_uris_round_trip() {
        for bytes in [&b""[..], b"h", b"hi", b"hi!", b"hi!!", PNG] {
            let uri = data_uri("image/png", bytes);
            let (mime, back) = decode_data_uri(&uri).unwrap();
            assert_eq!((mime, &back[..]), ("image/png", bytes));
        }
        assert_eq!(data_uri("text/plain", b"hi"), "data:text/plain;base64,aGk=");
        assert!(decode_data_uri("data:text/plain,hi").is_none());
        assert!(decode_data_uri("data:;base64,a*b").is_none());
        assert!(decode_data_uri("https://example.com/a.png").is_none());
    }

    #[test]
    fn file_urls_escape_paths() {
        assert_eq!(file_url("/tmp/a b#1.png"), "file:///tmp/a%20b%231.png");
        assert_eq!(file_url(r"/tmp/a\b.png"), "file:///tmp/a%5Cb.png");
        assert_eq!(file_url("/tmp/中/"), "file:///tmp/%E4%B8%AD/");
        assert_eq!(file_url(r"C:\Users\a b.txt"), "file:///C:/Users/a%20b.txt");
        assert_eq!(
            file_url(r"\\server\share\a.txt"),
            "file://server/share/a.txt"
        );
    }

    #[test]
    fn image_headers_give_type_and_size() {
        let image = Image::sniff(PNG).unwrap();
        assert_eq!((image.mime, image.width, image.height), ("image/png", 3, 2));
        let gif = b"GIF89a\x05\x00\x04\x00";
        assert_eq!(image_size(gif), Some((5, 4)));
        let mut bmp = vec![b'B', b'M'];
        bmp.resize(18, 0);
        bmp.extend(7i32.to_le_bytes());
        bmp.extend((-6i32).to_le_bytes());
        assert_eq!(image_size(&bmp), Some((7, 6)));
        // SOI, an APP0 segment, then SOF0 (height 9, width 10).
        let jpeg = [
            0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC0, 0, 11, 8, 0, 9, 0, 10, 3, 0, 0, 0,
        ];
        assert_eq!(image_mime(&jpeg), Some("image/jpeg"));
        assert_eq!(image_size(&jpeg), Some((10, 9)));
        assert_eq!(image_mime(b"II*\0rest"), Some("image/tiff"));
        assert_eq!(image_size(b"II*\0rest"), None);
        assert!(Image::sniff(b"plain text").is_none());
    }

    #[test]
    fn images_over_the_limit_answer_their_size() {
        let mut bytes = PNG.to_vec();
        bytes.resize(MAX_IMAGE_BYTES + 1, 0);
        let image = Image::sniff(&bytes).unwrap();
        assert_eq!(
            image_answer(1, true, Some(image)),
            EventPayload::Map(vec![
                ("id", PayloadValue::Number(1.0)),
                ("has", PayloadValue::Bool(true)),
                (
                    "tooLarge",
                    PayloadValue::Number((MAX_IMAGE_BYTES + 1) as f64)
                ),
            ])
        );
        bytes.truncate(MAX_IMAGE_BYTES);
        let EventPayload::Map(fields) = image_answer(1, true, Image::sniff(&bytes)) else {
            panic!()
        };
        assert!(
            matches!(&fields[2], ("uri", PayloadValue::Str(u)) if data_uri_len(u) == MAX_IMAGE_BYTES)
        );
    }

    #[test]
    fn data_uri_lengths_count_the_bytes() {
        for len in [0, 1, 2, 3, 4, 5, 100, 101, 102] {
            assert_eq!(data_uri_len(&data_uri("image/png", &vec![7; len])), len);
        }
        // Without its padding.
        assert_eq!(data_uri_len("data:text/plain;base64,aGk"), 2);
        assert_eq!(data_uri_len("https://example.com/a.png"), 0);
    }

    #[test]
    fn answers_carry_images_and_files() {
        let image = Image::sniff(PNG).unwrap();
        let EventPayload::Map(fields) = image_answer(4, true, Some(image)) else {
            panic!()
        };
        assert_eq!(fields[0], ("id", PayloadValue::Number(4.0)));
        assert_eq!(fields[1], ("has", PayloadValue::Bool(true)));
        assert!(
            matches!(&fields[2], ("uri", PayloadValue::Str(u)) if u.starts_with("data:image/png;base64,") && data_uri_len(u) == PNG.len())
        );
        assert_eq!(
            fields[3..],
            [
                ("width", PayloadValue::Number(3.0)),
                ("height", PayloadValue::Number(2.0))
            ]
        );
        assert_eq!(
            files_answer(5, &["file:///a".into(), "file:///b/".into()]),
            EventPayload::Map(vec![
                ("id", PayloadValue::Number(5.0)),
                ("has", PayloadValue::Bool(true)),
                ("files", PayloadValue::Str("file:///a\nfile:///b/".into())),
            ])
        );
    }
}
