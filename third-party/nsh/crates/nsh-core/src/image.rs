//! Image bytes that are in memory rather than in a file or behind a URL: a
//! `data:` URI's, decoded once, and the blob a `blob:` URL names
//! (`URL.createObjectURL`), which the JS VM hands over natively.
//!
//! The core decodes a `data:` source when it is set
//! ([`ImageSource::inline`](crate::ImageSource)) and names it by a short key
//! (`data:<type>;nsh-key=<digest>`), so caches keyed by URI hash a few
//! dozen bytes rather than the whole URI, and the shadow tree keeps the bytes
//! once rather than their text too. The bytes travel with the source
//! ([`ImageSource::data`](crate::ImageSource)) to the platforms, which decode
//! them as they do a download's. The backends that cannot take the source
//! itself (Android's Java loader, the browser's `<img>`) look the bytes up by
//! URI in an [`InlineImages`].
//!
//! Downloaded images are kept on disk by a [`DiskCache`] (native backends:
//! `cache.rs` has the policy and the format). The native backends load
//! through one [`loader`] (reads, downloads, decodes, the encoded bytes in
//! memory) and keep what they decode in [`Images`] at display size, in one
//! [`budget`] per process with leases on what views show ([`MemoryCache`]):
//! `docs/dev/images.md`.

use std::{
    fmt,
    ops::Deref,
    sync::{Arc, Weak},
};

use rustc_hash::FxHashMap;

#[cfg(not(target_arch = "wasm32"))]
mod cache;
#[cfg(not(target_arch = "wasm32"))]
pub use cache::{CacheHeaders, DEFAULT_DISK_CACHE_SIZE, DiskCache, Fetched, Lookup, Validators};
#[cfg(not(target_arch = "wasm32"))]
mod decoded;
#[cfg(not(target_arch = "wasm32"))]
pub mod loader;
mod memory;
#[cfg(not(target_arch = "wasm32"))]
pub use decoded::{Decoded, Decoder, Done, Frames, Images, Key, Natural, Request, Target, Want};
pub use memory::{Budget, Lease, MemoryCache, bucket, budget, default_budget, wanted};

type Bytes = dyn AsRef<[u8]> + Send + Sync;

/// The bytes of an in-memory image, shared: cloning one copies no bytes.
/// Two are equal when they share their bytes (no byte is compared).
#[derive(Clone)]
pub struct ImageData {
    bytes: Arc<Bytes>,
    /// Set when the image is a pixel buffer ([`Self::rgba`]): then
    /// [`Self::bytes`] is its PNG, encoded on first use.
    rgba: Option<Arc<Rgba>>,
}

impl ImageData {
    /// Image bytes held in `bytes` (a `Vec<u8>`, an `Arc<[u8]>`, ...), not
    /// copied.
    pub fn new(bytes: impl AsRef<[u8]> + Send + Sync + 'static) -> Self {
        Self {
            bytes: Arc::new(bytes),
            rgba: None,
        }
    }

    /// An image of `width` × `height` pixels held in `pixels`, not copied:
    /// straight (not premultiplied) 8-bit RGBA, rows top to bottom with no
    /// padding. The backends that draw pixels take them as they are; the
    /// others get them as a PNG ([`Self::bytes`]).
    ///
    /// # Panics
    ///
    /// When `pixels` is not `width * height * 4` bytes long, or a side is 0.
    pub(crate) fn from_rgba(
        width: u32,
        height: u32,
        pixels: impl AsRef<[u8]> + Send + Sync + 'static,
    ) -> Self {
        let len = pixels.as_ref().len();
        assert!(
            width > 0 && height > 0 && len as u64 == u64::from(width) * u64::from(height) * 4,
            "an RGBA image of {width}x{height} pixels takes {} bytes, not {len}",
            u64::from(width) * u64::from(height) * 4
        );
        let rgba = Arc::new(Rgba {
            width,
            height,
            pixels: Box::new(pixels),
            png: std::sync::OnceLock::new(),
        });
        Self {
            bytes: rgba.clone(),
            rgba: Some(rgba),
        }
    }

    /// The bytes: a pixel buffer's ([`Self::rgba`]) encoded as a PNG the
    /// first time they are asked for.
    pub fn bytes(&self) -> &[u8] {
        (*self.bytes).as_ref()
    }

    /// The width, height and straight RGBA pixels of a pixel buffer, which
    /// a backend that draws pixels takes without decoding [`Self::bytes`].
    pub fn rgba(&self) -> Option<(u32, u32, &[u8])> {
        self.rgba
            .as_deref()
            .map(|r| (r.width, r.height, (*r.pixels).as_ref()))
    }

    fn downgrade(&self) -> Weak<Bytes> {
        Arc::downgrade(&self.bytes)
    }
}

/// A pixel buffer, and the PNG it is to the backends that load encoded
/// images only (iOS, Android, the browser).
struct Rgba {
    width: u32,
    height: u32,
    pixels: Box<Bytes>,
    png: std::sync::OnceLock<Vec<u8>>,
}

impl AsRef<[u8]> for Rgba {
    fn as_ref(&self) -> &[u8] {
        self.png
            .get_or_init(|| stored_png(self.width, self.height, (*self.pixels).as_ref()))
    }
}

/// `rgba` (straight, `width * height * 4` bytes) as an uncompressed PNG:
/// no compression to wait for, a copy and two checksums.
fn stored_png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    fn crc32(parts: &[&[u8]]) -> u32 {
        static TABLE: std::sync::LazyLock<[u32; 256]> = std::sync::LazyLock::new(|| {
            std::array::from_fn(|n| {
                (0..8).fold(n as u32, |c, _| {
                    if c & 1 == 1 {
                        0xedb8_8320 ^ (c >> 1)
                    } else {
                        c >> 1
                    }
                })
            })
        });
        !parts.iter().flat_map(|p| p.iter()).fold(!0u32, |c, &b| {
            TABLE[((c ^ u32::from(b)) & 0xff) as usize] ^ (c >> 8)
        })
    }
    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        out.extend_from_slice(&crc32(&[kind, data]).to_be_bytes());
    }
    let row = width as usize * 4;
    // Each row is a filter byte (0: none) and its pixels.
    let raw_len = (row + 1) * height as usize;
    let mut zlib = Vec::with_capacity(raw_len + raw_len / 0xffff * 5 + 16);
    zlib.extend_from_slice(&[0x78, 0x01]);
    let (mut a, mut b) = (1u32, 0u32);
    let mut raw = rgba
        .chunks_exact(row)
        .flat_map(|r| std::iter::once(&0u8).chain(r.iter()));
    let mut left = raw_len;
    while left > 0 {
        let n = left.min(0xffff);
        left -= n;
        zlib.push(u8::from(left == 0));
        zlib.extend_from_slice(&(n as u16).to_le_bytes());
        zlib.extend_from_slice(&(!(n as u16)).to_le_bytes());
        for &byte in raw.by_ref().take(n) {
            zlib.push(byte);
            a = (a + u32::from(byte)) % 65521;
            b = (b + a) % 65521;
        }
    }
    zlib.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut out = Vec::with_capacity(zlib.len() + 64);
    out.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    let mut ihdr = [0u8; 13];
    ihdr[..4].copy_from_slice(&width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&height.to_be_bytes());
    ihdr[8..].copy_from_slice(&[8, 6, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &zlib);
    chunk(&mut out, b"IEND", &[]);
    out
}

/// The short URI a pixel buffer goes by: unique to it, and of the form of a
/// decoded `data:` URI's key, which an app cannot write itself
/// ([`crate::ImageSource::inline`]). Every buffer is a new image: the
/// caches drop what no view shows any more, as they do any image's.
pub(crate) fn rgba_key() -> String {
    use std::{
        fmt::Write,
        hash::BuildHasher,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    static SEED: std::sync::LazyLock<std::hash::RandomState> =
        std::sync::LazyLock::new(std::hash::RandomState::new);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let mut key = String::from("data:image/png;nsh-key=");
    let _ = write!(key, "{:016x}{n:016x}", SEED.hash_one(n));
    key
}

impl Default for ImageData {
    /// No bytes.
    fn default() -> Self {
        Self::new(Vec::new())
    }
}

impl Deref for ImageData {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        self.bytes()
    }
}

impl AsRef<[u8]> for ImageData {
    fn as_ref(&self) -> &[u8] {
        self.bytes()
    }
}

impl From<Vec<u8>> for ImageData {
    fn from(bytes: Vec<u8>) -> Self {
        Self::new(bytes)
    }
}

impl PartialEq for ImageData {
    fn eq(&self, other: &Self) -> bool {
        std::ptr::addr_eq(Arc::as_ptr(&self.bytes), Arc::as_ptr(&other.bytes))
    }
}

impl fmt::Debug for ImageData {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.rgba() {
            Some((w, h, _)) => write!(f, "ImageData({w}x{h} RGBA)"),
            None => write!(f, "ImageData({} bytes)", self.bytes().len()),
        }
    }
}

/// The media type and bytes of a `data:` URI: base64 (standard or URL-safe,
/// whitespace and padding ignored) or percent-encoded (`%xx` escapes
/// decoded, invalid ones kept as they are).
pub fn decode_data_uri(uri: &str) -> Result<(&str, Vec<u8>), String> {
    let rest = uri.strip_prefix("data:").ok_or("not a data: URI")?;
    let (meta, data) = rest.split_once(',').ok_or("malformed data: URI")?;
    match meta.strip_suffix(";base64") {
        Some(mime) => Ok((mime, base64(data)?)),
        None => Ok((meta, percent_decode(data))),
    }
}

/// The short URI a decoded `data:` source goes by: its type and a digest of
/// its bytes, so equal URIs share their cache entries and loads. The
/// platforms' caches are shared by every surface of a process, so the key
/// is collision resistant (SHA-256, 128 bits of it): one app cannot make
/// another's image show its bytes. It is the same in every run.
pub(crate) fn data_key(mime: &str, bytes: &[u8]) -> String {
    use std::fmt::Write;

    use sha2::Digest;
    let digest = sha2::Sha256::digest(bytes);
    let mime = mime.split(';').next().unwrap_or_default();
    let mut key = format!("data:{mime};nsh-key=");
    for b in &digest[..16] {
        let _ = write!(key, "{b:02x}");
    }
    key
}

fn base64(s: &str) -> Result<Vec<u8>, String> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    };
    let mut out = Vec::with_capacity(s.len() / 4 * 3 + 2);
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.bytes() {
        if c == b'=' || c.is_ascii_whitespace() {
            continue;
        }
        let v = value(c).ok_or("invalid base64 in a data: URI")?;
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

fn percent_decode(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let hex = |b: u8| (b as char).to_digit(16);
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match (
            bytes[i],
            bytes.get(i + 1).and_then(|&b| hex(b)),
            bytes.get(i + 2).and_then(|&b| hex(b)),
        ) {
            (b'%', Some(h), Some(l)) => {
                out.push((h * 16 + l) as u8);
                i += 3;
            }
            (b, _, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    out
}

/// The in-memory images a backend shows, by URI, for loaders that get the
/// URI only (Android's Java loader, the browser's `<img>`). It holds no
/// bytes: an entry lives as long as the core keeps a source with those
/// bytes, so a source the app replaced (or a revoked `blob:` URL's view
/// that went away) frees them.
#[derive(Default)]
pub struct InlineImages {
    /// Every source's copy of a URI's bytes (sources decoded apart hold
    /// equal bytes apart): the URI stays reachable while one lives.
    map: FxHashMap<Arc<str>, Vec<Weak<Bytes>>>,
}

impl InlineImages {
    /// Makes the bytes of `source` (when it has some) reachable by its URI;
    /// true when the URI was not reachable before.
    pub fn register(&mut self, source: &crate::ImageSource) -> bool {
        let Some(data) = &source.data else {
            return false;
        };
        let held = self.map.entry(source.uri.clone()).or_default();
        let new = !held.iter().any(|w| w.strong_count() > 0);
        let ptr = Arc::as_ptr(&data.bytes);
        if !held.iter().any(|w| std::ptr::addr_eq(w.as_ptr(), ptr)) {
            held.push(data.downgrade());
        }
        new
    }

    /// The bytes of `uri`, while a source the core keeps holds them.
    pub fn get(&self, uri: &str) -> Option<ImageData> {
        self.map
            .get(uri)?
            .iter()
            .find_map(Weak::upgrade)
            .map(|bytes| ImageData { bytes, rgba: None })
    }

    /// Forgets the URIs whose bytes no source keeps any more, and returns
    /// them.
    pub fn prune(&mut self) -> Vec<Arc<str>> {
        let mut gone = Vec::new();
        self.map.retain(|uri, held| {
            held.retain(|w| w.strong_count() > 0);
            if held.is_empty() {
                gone.push(uri.clone());
            }
            !held.is_empty()
        });
        gone
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ImageSource;

    #[test]
    fn decodes_base64_and_percent_encoded_uris() {
        assert_eq!(
            decode_data_uri("data:image/png;base64,aGk=").unwrap(),
            ("image/png", b"hi".to_vec())
        );
        // URL-safe, whitespace, no padding.
        assert_eq!(
            decode_data_uri("data:;base64,_-8 \n").unwrap().1,
            vec![0xff, 0xef]
        );
        assert_eq!(
            decode_data_uri("data:image/svg+xml,%3Csvg%3E%zz").unwrap(),
            ("image/svg+xml", b"<svg>%zz".to_vec())
        );
        assert!(decode_data_uri("data:nocomma").is_err());
        assert!(decode_data_uri("data:;base64,a*b").is_err());
        assert!(decode_data_uri("https://example.com/a.png").is_err());
    }

    #[test]
    fn data_sources_are_decoded_once_under_a_short_key() {
        let uri = format!("data:image/png;charset=x;base64,{}", "QUJD".repeat(1000));
        let source = ImageSource {
            uri: uri.as_str().into(),
            ..ImageSource::default()
        }
        .inline();
        let data = source.data.clone().unwrap();
        assert_eq!(data.len(), 3000);
        assert!(source.uri.starts_with("data:image/png;nsh-key="));
        assert_eq!(source.uri.len(), "data:image/png;nsh-key=".len() + 32);
        // The same URI gets the same key; other bytes another.
        let again = ImageSource {
            uri: uri.as_str().into(),
            ..ImageSource::default()
        }
        .inline();
        assert_eq!(again.uri, source.uri);
        let other = ImageSource {
            uri: "data:image/png;base64,QUJE".into(),
            ..ImageSource::default()
        }
        .inline();
        assert_ne!(other.uri, source.uri);
        // A key the app writes itself names nothing: no cache knows it.
        let forged = ImageSource {
            uri: source.uri.clone(),
            ..ImageSource::default()
        }
        .inline();
        assert_eq!(&*forged.uri, "data:,");
        assert!(forged.data.is_none());
        // Other URIs are left as they are; bad data: URIs show nothing.
        let remote = ImageSource {
            uri: "https://x.org/a.png".into(),
            ..ImageSource::default()
        }
        .inline();
        assert_eq!(&*remote.uri, "https://x.org/a.png");
        assert!(remote.data.is_none());
        let bad = ImageSource {
            uri: "data:nocomma".into(),
            ..ImageSource::default()
        }
        .inline();
        assert_eq!(&*bad.uri, "data:,");
        assert!(bad.data.is_none());
    }

    #[test]
    fn rgba_sources_keep_their_pixels_under_a_unique_key() {
        let pixels: Arc<[u8]> = (0..3 * 2 * 4).map(|i| i as u8).collect();
        let src = crate::element::ImageSrc::rgba(3, 2, pixels.clone());
        let again = crate::element::ImageSrc::rgba(3, 2, pixels.clone());
        // Each buffer is an image of its own, under a key an app cannot
        // write itself.
        assert_ne!(src.uri, again.uri);
        assert!(src.uri.starts_with("data:image/png;nsh-key="));
        assert_eq!(src.size, Some((3.0, 2.0)));
        let data = src.data.clone().unwrap();
        let (w, h, rgba) = data.rgba().unwrap();
        assert_eq!((w, h), (3, 2));
        assert!(std::ptr::eq(rgba, &*pixels));
        assert_eq!(format!("{data:?}"), "ImageData(3x2 RGBA)");
        let forged = ImageSource {
            uri: src.uri.to_arc(),
            ..ImageSource::default()
        }
        .inline();
        assert_eq!(&*forged.uri, "data:,");
        // The backends that load encoded images get a PNG.
        assert_eq!(&data.bytes()[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(
            crate::image::Natural::of(data.bytes()),
            Some(crate::image::Natural::Pixels(3, 2))
        );
    }

    #[test]
    #[should_panic(expected = "takes 24 bytes, not 23")]
    fn rgba_sources_check_their_length() {
        crate::element::ImageSrc::rgba(3, 2, vec![0u8; 23]);
    }

    #[cfg(feature = "svg")]
    #[test]
    fn rgba_sources_encode_to_a_png_that_decodes_to_them() {
        // Over one stored deflate block (65535 bytes).
        let (w, h) = (130u32, 140u32);
        let pixels: Vec<u8> = (0..w * h)
            .flat_map(|i| [(i % 251) as u8, (i % 13) as u8, (i / 256) as u8, 255])
            .collect();
        let data = crate::ImageData::from_rgba(w, h, pixels.clone());
        let png = resvg::tiny_skia::Pixmap::decode_png(data.bytes()).unwrap();
        assert_eq!((png.width(), png.height()), (w, h));
        assert_eq!(png.data(), &pixels[..]);
    }

    #[test]
    fn inline_images_live_as_long_as_their_sources() {
        let mut images = InlineImages::default();
        let source = ImageSource {
            uri: "blob:nsh://app/1".into(),
            data: Some(ImageData::new(vec![1u8, 2, 3])),
            ..ImageSource::default()
        };
        assert!(images.register(&source));
        assert!(!images.register(&source.clone()));
        assert_eq!(images.get("blob:nsh://app/1").unwrap().bytes(), &[1, 2, 3]);
        assert!(images.prune().is_empty());
        drop(source);
        assert!(images.get("blob:nsh://app/1").is_none());
        assert_eq!(images.prune(), vec![Arc::<str>::from("blob:nsh://app/1")]);
        assert!(!images.register(&ImageSource {
            uri: "https://x.org/a.png".into(),
            ..ImageSource::default()
        }));
        // Sources decoded apart hold equal bytes apart: the URI stays while
        // either lives.
        let a = ImageSource::default().with_bytes("image/png", vec![7u8].into());
        let b = ImageSource::default().with_bytes("image/png", vec![7u8].into());
        assert_eq!(a.uri, b.uri);
        assert!(images.register(&a));
        assert!(!images.register(&b));
        drop(a);
        assert!(images.prune().is_empty());
        assert_eq!(images.get(&b.uri).unwrap().bytes(), &[7]);
    }
}
