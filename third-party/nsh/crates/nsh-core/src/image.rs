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
//! `cache.rs` has the policy and the format).

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

type Bytes = dyn AsRef<[u8]> + Send + Sync;

/// The bytes of an in-memory image, shared: cloning one copies no bytes.
/// Two are equal when they share their bytes (no byte is compared).
#[derive(Clone)]
pub struct ImageData(Arc<Bytes>);

impl ImageData {
    /// Image bytes held in `bytes` (a `Vec<u8>`, an `Arc<[u8]>`, ...), not
    /// copied.
    pub fn new(bytes: impl AsRef<[u8]> + Send + Sync + 'static) -> Self {
        Self(Arc::new(bytes))
    }

    /// The bytes.
    pub fn bytes(&self) -> &[u8] {
        (*self.0).as_ref()
    }

    fn downgrade(&self) -> Weak<Bytes> {
        Arc::downgrade(&self.0)
    }
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
        std::ptr::addr_eq(Arc::as_ptr(&self.0), Arc::as_ptr(&other.0))
    }
}

impl fmt::Debug for ImageData {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ImageData({} bytes)", self.bytes().len())
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
        let ptr = Arc::as_ptr(&data.0);
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
            .map(ImageData)
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
