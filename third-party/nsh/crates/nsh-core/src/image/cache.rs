//! A persistent cache of downloaded image bytes: what the backends'
//! loaders fetch over HTTP(S) is kept on disk, encoded (never decoded
//! bitmaps), so an app shows images it showed before without downloading
//! them again, across launches and while offline.
//!
//! One shared implementation for every native backend: the loaders keep
//! their own networking (ureq on the desktops, `NSURLSession` on Apple's,
//! `HttpURLConnection` on Android) and route each download through
//! [`DiskCache::lookup`] and [`DiskCache::complete`] (or
//! [`DiskCache::load`], which does both around a blocking fetch). Every call
//! does file IO: call them off the main thread.
//!
//! **Policy** (HTTP caching as a private cache, RFC 9111, simplified):
//! - A `200` (or `203`) response is stored unless it says `no-store` or
//!   `Vary: *`, or is larger than an eighth of the cache. Other statuses are
//!   never stored.
//! - It is fresh for `Cache-Control: max-age`, else `Expires` − `Date`, else
//!   a tenth of the time since `Last-Modified` (at most 7 days), less its
//!   age (`Age`, or the time since `Date`); with none of them, or with
//!   `no-cache` (or `Pragma: no-cache`), it is stale at once.
//! - A fresh entry is served without a request. A stale one is revalidated
//!   with `If-None-Match` / `If-Modified-Since` (its `ETag` /
//!   `Last-Modified`): a `304` serves it again, fresh by the `304`'s
//!   headers over the stored ones; a `200` replaces it; a `4xx` drops it.
//! - When the request fails (no network) or the server answers `5xx`, a
//!   stale entry is served anyway, unless it said `must-revalidate` or
//!   `no-cache`.
//!
//! Entries are keyed by URL alone: image sources carry no request headers,
//! and a loader sends the same ones for every image, so whatever a
//! response varies on (`Vary`) is the same for all of its requests.
//!
//! **Storage**: one file per entry in the cache's directory, named by a
//! digest of its URL, holding the URL, the policy's dates and headers, the
//! body and a checksum of all of them. A file is written whole under a
//! temporary name and renamed into place, so readers (other threads,
//! surfaces or processes on the same directory) see a complete entry or
//! none, without locks. An entry that does not read back whole (truncated,
//! a checksum or URL mismatch, an unknown format) is deleted and is a miss.
//! The cache is bounded in bytes: past its limit the least recently used
//! entries (by file modification time, which a hit refreshes) are deleted
//! until it is down to three quarters of it.
//!
//! **Sharing**: a [`DiskCache`] is a handle; surfaces of one app open their
//! own on the app's directory (there is no process-wide registry), and the
//! files are the only state they share. Each handle keeps an estimate of
//! the directory's size, made exact by a scan when it trims.

use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use super::ImageData;
use crate::ByteSize;

/// The size a disk cache is bounded to unless its embedder says otherwise.
pub const DEFAULT_DISK_CACHE_SIZE: ByteSize = ByteSize::mib(256);

/// What a file starts with: the format and its version.
const MAGIC: &[u8; 8] = b"NSHIMG1\n";

/// The longest header read back (an entry with a longer one is corrupt).
const MAX_HEADER: usize = 64 << 10;

/// The longest heuristic freshness (`Last-Modified` without explicit
/// freshness): RFC 9111's suggested tenth of the age, capped as browsers do.
const MAX_HEURISTIC: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// A hit refreshes an entry's modification time (its place in the LRU
/// order) when it is at least this old: not a write per hit.
const TOUCH_AFTER: Duration = Duration::from_secs(10 * 60);

/// Temporary files older than this were left by a writer that died.
const STALE_TEMPORARY: Duration = Duration::from_secs(60 * 60);

/// The response headers the cache reads: [`CacheHeaders::NAMES`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct CacheHeaders {
    /// `Cache-Control`.
    pub cache_control: Option<String>,
    /// `Expires`.
    pub expires: Option<String>,
    /// `Date`.
    pub date: Option<String>,
    /// `Age`.
    pub age: Option<String>,
    /// `ETag`.
    pub etag: Option<String>,
    /// `Last-Modified`.
    pub last_modified: Option<String>,
    /// `Vary`.
    pub vary: Option<String>,
    /// `Pragma` (`no-cache` without a `Cache-Control`).
    pub pragma: Option<String>,
}

impl CacheHeaders {
    /// The names of the headers the cache reads, in lower case: a loader
    /// hands over these (and may hand over more, which are ignored).
    pub const NAMES: [&'static str; 8] = [
        "cache-control",
        "expires",
        "date",
        "age",
        "etag",
        "last-modified",
        "vary",
        "pragma",
    ];

    /// The headers among `pairs` (name, value), names in any case;
    /// repeated ones are joined with `, ` (as HTTP combines field lines).
    pub fn from_pairs<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        let mut headers = Self::default();
        for (name, value) in pairs {
            if let Some(slot) = headers.slot(name) {
                match slot {
                    Some(existing) => {
                        existing.push_str(", ");
                        existing.push_str(value.trim());
                    }
                    None => *slot = Some(value.trim().to_owned()),
                }
            }
        }
        headers
    }

    /// The headers `get` returns for [`CacheHeaders::NAMES`] (it is asked
    /// in lower case).
    pub fn from_lookup(mut get: impl FnMut(&str) -> Option<String>) -> Self {
        let mut headers = Self::default();
        for name in Self::NAMES {
            if let Some(value) = get(name)
                && let Some(slot) = headers.slot(name)
            {
                *slot = Some(value.trim().to_owned());
            }
        }
        headers
    }

    fn slot(&mut self, name: &str) -> Option<&mut Option<String>> {
        let name = name.trim();
        Some(match () {
            _ if name.eq_ignore_ascii_case("cache-control") => &mut self.cache_control,
            _ if name.eq_ignore_ascii_case("expires") => &mut self.expires,
            _ if name.eq_ignore_ascii_case("date") => &mut self.date,
            _ if name.eq_ignore_ascii_case("age") => &mut self.age,
            _ if name.eq_ignore_ascii_case("etag") => &mut self.etag,
            _ if name.eq_ignore_ascii_case("last-modified") => &mut self.last_modified,
            _ if name.eq_ignore_ascii_case("vary") => &mut self.vary,
            _ if name.eq_ignore_ascii_case("pragma") => &mut self.pragma,
            _ => return None,
        })
    }

    /// `self` updated with the headers `newer` has (a `304`'s over the
    /// stored response's).
    fn updated(mut self, newer: &CacheHeaders) -> Self {
        let pick = |old: &mut Option<String>, new: &Option<String>| {
            if new.is_some() {
                old.clone_from(new);
            }
        };
        pick(&mut self.cache_control, &newer.cache_control);
        pick(&mut self.expires, &newer.expires);
        pick(&mut self.date, &newer.date);
        pick(&mut self.age, &newer.age);
        pick(&mut self.etag, &newer.etag);
        pick(&mut self.last_modified, &newer.last_modified);
        pick(&mut self.vary, &newer.vary);
        pick(&mut self.pragma, &newer.pragma);
        self
    }
}

/// A response to an image request, as a loader read it (after following
/// redirects).
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct Fetched {
    /// The HTTP status.
    pub status: u16,
    /// Its caching headers.
    pub headers: CacheHeaders,
    /// The body (empty for a `304`).
    pub body: Vec<u8>,
}

impl Fetched {
    /// A response with `status`, `headers` and `body`.
    pub fn new(status: u16, headers: CacheHeaders, body: Vec<u8>) -> Self {
        Self {
            status,
            headers,
            body,
        }
    }
}

/// What the cache holds for a URL ([`DiskCache::lookup`]).
#[derive(Debug, Clone)]
pub enum Lookup {
    /// A fresh copy: serve it, no request.
    Fresh(ImageData),
    /// A stale copy: request with these validators, then
    /// [`DiskCache::complete`].
    Stale(Validators),
    /// Nothing: request, then [`DiskCache::complete`].
    Miss,
}

impl Lookup {
    /// The conditional request headers to send ([`Validators::headers`]),
    /// none for a miss (or a fresh copy).
    pub fn request_headers(&self) -> Vec<(&'static str, String)> {
        match self {
            Lookup::Stale(validators) => validators.headers(),
            _ => Vec::new(),
        }
    }
}

/// A stale entry's validators.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct Validators {
    /// Its `ETag`.
    pub etag: Option<String>,
    /// Its `Last-Modified`.
    pub last_modified: Option<String>,
}

impl Validators {
    /// The conditional request headers: `If-None-Match` and
    /// `If-Modified-Since`.
    pub fn headers(&self) -> Vec<(&'static str, String)> {
        let mut headers = Vec::new();
        if let Some(etag) = &self.etag {
            headers.push(("If-None-Match", etag.clone()));
        }
        if let Some(date) = &self.last_modified {
            headers.push(("If-Modified-Since", date.clone()));
        }
        headers
    }
}

/// A persistent, size-bounded cache of downloaded image bytes in one
/// directory (the module docs have its policy). Cloning a handle shares it.
#[derive(Clone)]
pub struct DiskCache(Arc<Inner>);

struct Inner {
    dir: PathBuf,
    max_size: ByteSize,
    max_bytes: u64,
    /// The directory's size as this handle knows it: exact after a scan,
    /// plus what it wrote since. `None` until its first write scans.
    size: Mutex<Option<u64>>,
}

impl std::fmt::Debug for DiskCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DiskCache")
            .field("dir", &self.0.dir)
            .field("max_bytes", &self.0.max_bytes)
            .finish()
    }
}

impl DiskCache {
    /// A cache in `dir` (created when it first stores), bounded to
    /// `max_size`; `None` when that is no bytes (no disk cache). Touches
    /// no file.
    pub fn open(dir: impl Into<PathBuf>, max_size: ByteSize) -> Option<Self> {
        let max_bytes = max_size.bytes();
        (max_bytes > 0).then(|| {
            Self(Arc::new(Inner {
                dir: dir.into(),
                max_size,
                max_bytes,
                size: Mutex::new(None),
            }))
        })
    }

    /// Its directory.
    pub fn dir(&self) -> &Path {
        &self.0.dir
    }

    /// The size it is bounded to.
    pub fn max_size(&self) -> ByteSize {
        self.0.max_size
    }

    /// What it holds for `url`. Blocking.
    pub fn lookup(&self, url: &str) -> Lookup {
        self.lookup_at(url, now())
    }

    /// Ends the request for `url` that a [`Lookup`] started: stores, updates
    /// or drops the entry as the policy says, and returns the bytes to show
    /// (the response's, or the cached ones for a `304`, or a stale copy when
    /// the request failed and it may be served), or the error. Blocking.
    pub fn complete(
        &self,
        url: &str,
        response: Result<Fetched, String>,
    ) -> Result<ImageData, String> {
        self.complete_at(url, response, now())
    }

    /// Gets `url`'s bytes through the cache: a fresh entry, or `fetch`
    /// (blocking; given the conditional headers to send, none on a miss)
    /// then [`DiskCache::complete`].
    pub fn load(
        &self,
        url: &str,
        fetch: impl FnOnce(&[(&'static str, String)]) -> Result<Fetched, String>,
    ) -> Result<ImageData, String> {
        let lookup = self.lookup(url);
        if let Lookup::Fresh(bytes) = lookup {
            return Ok(bytes);
        }
        self.complete(url, fetch(&lookup.request_headers()))
    }

    /// Drops `url`'s entry.
    pub fn remove(&self, url: &str) {
        let _ = fs::remove_file(self.path(url));
    }

    /// Drops every entry. Entries another handle is writing at that moment
    /// may survive.
    pub fn clear(&self) {
        if let Ok(entries) = fs::read_dir(&self.0.dir) {
            for entry in entries.flatten() {
                let _ = fs::remove_file(entry.path());
            }
        }
        *self.0.size.lock().unwrap_or_else(|e| e.into_inner()) = Some(0);
    }

    fn lookup_at(&self, url: &str, now: u64) -> Lookup {
        let path = self.path(url);
        let Some(meta) = self.read_meta(&path, url) else {
            return Lookup::Miss;
        };
        if now < meta.fresh_until {
            return match self.read(&path, url) {
                Some((_, body)) => {
                    touch(&path);
                    Lookup::Fresh(body.into())
                }
                None => Lookup::Miss,
            };
        }
        let validators = Validators {
            etag: meta.headers.etag.clone(),
            last_modified: meta.headers.last_modified.clone(),
        };
        if validators.etag.is_none() && validators.last_modified.is_none() {
            // Nothing to revalidate with: requested in full (and served if
            // that fails).
            return Lookup::Stale(Validators::default());
        }
        Lookup::Stale(validators)
    }

    fn complete_at(
        &self,
        url: &str,
        response: Result<Fetched, String>,
        now: u64,
    ) -> Result<ImageData, String> {
        let response = match response {
            Ok(response) => response,
            Err(error) => return self.stale(url).ok_or(error),
        };
        match response.status {
            200 | 203 => {
                let Fetched { headers, body, .. } = response;
                self.store(url, &headers, &body, now);
                Ok(body.into())
            }
            304 => {
                let path = self.path(url);
                let (meta, body) = self
                    .read(&path, url)
                    .ok_or_else(|| "HTTP 304 without a cached copy".to_owned())?;
                let headers = meta.headers.updated(&response.headers);
                let policy = Policy::of(&headers, now);
                if policy.store {
                    self.write(url, &headers, &policy, &body);
                } else {
                    self.remove(url);
                }
                touch(&path);
                Ok(body.into())
            }
            // Shown, never stored (`206`, `204`, ...).
            200..=299 => Ok(response.body.into()),
            status @ 500..=599 => self.stale(url).ok_or_else(|| format!("HTTP {status}")),
            status @ 300..=399 => Err(format!("redirect refused (HTTP {status})")),
            status => {
                self.remove(url);
                Err(format!("HTTP {status}"))
            }
        }
    }

    /// The stored copy of `url` when it may be served stale (the request
    /// failed).
    fn stale(&self, url: &str) -> Option<ImageData> {
        let (meta, body) = self.read(&self.path(url), url)?;
        if meta.strict {
            return None;
        }
        log::debug!("image cache: serving {url} stale");
        Some(body.into())
    }

    fn store(&self, url: &str, headers: &CacheHeaders, body: &[u8], now: u64) {
        let policy = Policy::of(headers, now);
        if !policy.store || body.len() as u64 > self.0.max_bytes / 8 {
            self.remove(url);
            return;
        }
        self.write(url, headers, &policy, body);
    }

    fn write(&self, url: &str, headers: &CacheHeaders, policy: &Policy, body: &[u8]) {
        let header = encode_header(url, headers, policy);
        let mut crc = crc32fast::Hasher::new();
        crc.update(&header);
        crc.update(body);
        let mut file = Vec::with_capacity(MAGIC.len() + 16 + header.len() + body.len());
        file.extend_from_slice(MAGIC);
        file.extend_from_slice(&(header.len() as u32).to_le_bytes());
        file.extend_from_slice(&header);
        file.extend_from_slice(&(body.len() as u64).to_le_bytes());
        file.extend_from_slice(&crc.finalize().to_le_bytes());
        file.extend_from_slice(body);
        let written = file.len() as u64;
        if let Err(e) = self.write_file(&self.path(url), &file) {
            log::debug!("image cache: cannot store {url}: {e}");
            return;
        }
        let over = {
            let mut size = self.0.size.lock().unwrap_or_else(|e| e.into_inner());
            match size.as_mut() {
                Some(size) => {
                    *size += written;
                    *size > self.0.max_bytes
                }
                // A first write: learn the directory's size.
                None => true,
            }
        };
        if over {
            self.trim();
        }
    }

    /// Writes `bytes` to `path` whole: under a temporary name, renamed into
    /// place.
    fn write_file(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        fs::create_dir_all(&self.0.dir)?;
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let temporary = self.0.dir.join(format!(
            ".tmp-{}-{}-{nanos}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let result = fs::File::create(&temporary)
            .and_then(|mut f| f.write_all(bytes))
            .and_then(|()| fs::rename(&temporary, path));
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    /// Scans the directory: deletes temporary files writers left, and the
    /// least recently used entries while it is over its limit (down to
    /// three quarters of it).
    fn trim(&self) {
        let Ok(entries) = fs::read_dir(&self.0.dir) else {
            return;
        };
        let now = SystemTime::now();
        let mut files = Vec::new();
        let mut total = 0;
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let modified = meta.modified().unwrap_or(UNIX_EPOCH);
            if entry.file_name().to_string_lossy().starts_with('.') {
                if now.duration_since(modified).unwrap_or_default() > STALE_TEMPORARY {
                    let _ = fs::remove_file(entry.path());
                }
                continue;
            }
            total += meta.len();
            files.push((modified, meta.len(), entry.path()));
        }
        if total > self.0.max_bytes {
            files.sort_unstable_by_key(|(modified, ..)| *modified);
            let target = self.0.max_bytes / 4 * 3;
            for (_, len, path) in files {
                if total <= target {
                    break;
                }
                // Gone already (another handle trimmed it) counts as gone.
                let _ = fs::remove_file(&path);
                total -= len;
            }
        }
        *self.0.size.lock().unwrap_or_else(|e| e.into_inner()) = Some(total);
    }

    fn path(&self, url: &str) -> PathBuf {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(url.as_bytes());
        let mut name = String::with_capacity(32);
        for byte in &digest[..16] {
            name.push_str(&format!("{byte:02x}"));
        }
        self.0.dir.join(name)
    }

    /// The header of the entry at `path` if it is `url`'s (its body
    /// unread and unchecked: enough to decide what to request).
    fn read_meta(&self, path: &Path, url: &str) -> Option<Meta> {
        let mut file = fs::File::open(path).ok()?;
        let header = read_header(&mut file);
        drop(file);
        match header.as_ref().and_then(|h| decode_header(h)) {
            Some(meta) if meta.url == url => Some(meta),
            Some(_) => None,
            None => {
                corrupt(path);
                None
            }
        }
    }

    /// The entry at `path` if it is `url`'s and reads back whole.
    fn read(&self, path: &Path, url: &str) -> Option<(Meta, Vec<u8>)> {
        let mut file = fs::File::open(path).ok()?;
        let entry = (|| {
            let header = read_header(&mut file)?;
            let mut fixed = [0u8; 12];
            file.read_exact(&mut fixed).ok()?;
            let len = u64::from_le_bytes(fixed[..8].try_into().ok()?);
            let crc = u32::from_le_bytes(fixed[8..].try_into().ok()?);
            let expected = file.metadata().ok()?.len();
            let offset = (MAGIC.len() + 4 + header.len() + 12) as u64;
            if offset.checked_add(len)? != expected {
                return None;
            }
            let mut body = Vec::with_capacity(len as usize);
            file.read_to_end(&mut body).ok()?;
            let mut hasher = crc32fast::Hasher::new();
            hasher.update(&header);
            hasher.update(&body);
            if hasher.finalize() != crc || body.len() as u64 != len {
                return None;
            }
            Some((decode_header(&header)?, body))
        })();
        drop(file);
        match entry {
            Some((meta, body)) if meta.url == url => Some((meta, body)),
            Some(_) => None,
            None => {
                corrupt(path);
                None
            }
        }
    }
}

/// What a response's headers say about storing it.
#[derive(Debug, Clone, PartialEq)]
struct Policy {
    /// It may be stored.
    store: bool,
    /// Until when it is fresh (seconds since the epoch).
    fresh_until: u64,
    /// It may not be served stale (`must-revalidate`, `no-cache`).
    strict: bool,
}

impl Policy {
    fn of(headers: &CacheHeaders, now: u64) -> Self {
        let mut no_store = false;
        let mut no_cache = false;
        let mut must_revalidate = false;
        let mut max_age = None;
        if let Some(value) = &headers.cache_control {
            for directive in value.split(',') {
                let (name, argument) = match directive.split_once('=') {
                    Some((name, argument)) => {
                        (name.trim(), Some(argument.trim().trim_matches('"')))
                    }
                    None => (directive.trim(), None),
                };
                match name.to_ascii_lowercase().as_str() {
                    "no-store" => no_store = true,
                    // `no-cache="field"` only bars those fields.
                    "no-cache" if argument.is_none() => no_cache = true,
                    "must-revalidate" => must_revalidate = true,
                    "max-age" => max_age = argument.and_then(|a| a.parse::<u64>().ok()),
                    _ => {}
                }
            }
        } else if headers
            .pragma
            .as_deref()
            .is_some_and(|p| p.to_ascii_lowercase().contains("no-cache"))
        {
            no_cache = true;
        }
        let vary_all = headers
            .vary
            .as_deref()
            .is_some_and(|v| v.split(',').any(|f| f.trim() == "*"));
        let date = headers.date.as_deref().and_then(http_date);
        // The response's age: what caches before it said, or the time since
        // the server dated it.
        let apparent = date.map_or(0, |date| now.saturating_sub(date));
        let age = headers
            .age
            .as_deref()
            .and_then(|a| a.trim().parse::<u64>().ok())
            .unwrap_or(0)
            .max(apparent);
        let lifetime = if no_cache {
            0
        } else if let Some(max_age) = max_age {
            max_age
        } else if let Some(expires) = &headers.expires {
            // An invalid date (`0`, say) is in the past.
            http_date(expires).map_or(0, |expires| expires.saturating_sub(date.unwrap_or(now)))
        } else if let Some(modified) = headers.last_modified.as_deref().and_then(http_date) {
            (date.unwrap_or(now).saturating_sub(modified) / 10).min(MAX_HEURISTIC.as_secs())
        } else {
            0
        };
        Policy {
            store: !no_store && !vary_all,
            fresh_until: now.saturating_add(lifetime.saturating_sub(age)),
            strict: must_revalidate || no_cache,
        }
    }
}

/// An entry's header, decoded.
#[derive(Debug)]
struct Meta {
    url: String,
    fresh_until: u64,
    strict: bool,
    headers: CacheHeaders,
}

fn encode_header(url: &str, headers: &CacheHeaders, policy: &Policy) -> Vec<u8> {
    let mut text = String::new();
    let mut line = |name: &str, value: &str| {
        // Values never hold line breaks (HTTP forbids them); a URL is one
        // line too.
        if !value.contains(['\n', '\t']) {
            text.push_str(name);
            text.push('\t');
            text.push_str(value);
            text.push('\n');
        }
    };
    line("url", url);
    line("fresh", &policy.fresh_until.to_string());
    line("strict", if policy.strict { "1" } else { "0" });
    for (name, value) in [
        ("cache-control", &headers.cache_control),
        ("expires", &headers.expires),
        ("etag", &headers.etag),
        ("last-modified", &headers.last_modified),
        ("vary", &headers.vary),
        ("pragma", &headers.pragma),
    ] {
        if let Some(value) = value {
            line(name, value);
        }
    }
    text.into_bytes()
}

fn decode_header(bytes: &[u8]) -> Option<Meta> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut url = None;
    let mut fresh_until = None;
    let mut strict = None;
    let mut pairs = Vec::new();
    for line in text.lines() {
        let (name, value) = line.split_once('\t')?;
        match name {
            "url" => url = Some(value.to_owned()),
            "fresh" => fresh_until = Some(value.parse().ok()?),
            "strict" => strict = Some(value == "1"),
            _ => pairs.push((name, value)),
        }
    }
    Some(Meta {
        url: url?,
        fresh_until: fresh_until?,
        strict: strict?,
        headers: CacheHeaders::from_pairs(pairs),
    })
}

/// The header of an entry file, after checking its format.
fn read_header(file: &mut fs::File) -> Option<Vec<u8>> {
    let mut start = [0u8; 12];
    file.read_exact(&mut start).ok()?;
    if &start[..8] != MAGIC {
        return None;
    }
    let len = u32::from_le_bytes(start[8..].try_into().ok()?) as usize;
    if len > MAX_HEADER {
        return None;
    }
    let mut header = vec![0; len];
    file.read_exact(&mut header).ok()?;
    Some(header)
}

/// Drops an entry that did not read back.
fn corrupt(path: &Path) {
    log::debug!("image cache: dropping corrupt entry {}", path.display());
    let _ = fs::remove_file(path);
}

/// Refreshes `path`'s place in the LRU order (not more often than
/// [`TOUCH_AFTER`]).
fn touch(path: &Path) {
    let now = SystemTime::now();
    let old = fs::metadata(path)
        .and_then(|m| m.modified())
        .is_ok_and(|m| now.duration_since(m).unwrap_or_default() >= TOUCH_AFTER);
    if old && let Ok(file) = fs::OpenOptions::new().write(true).open(path) {
        let _ = file.set_modified(now);
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// An HTTP date in seconds since the epoch.
fn http_date(value: &str) -> Option<u64> {
    httpdate::parse_http_date(value.trim())
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

#[cfg(test)]
mod tests;
