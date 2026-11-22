use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime},
};

use super::*;
use crate::{ByteSize, access::Capabilities};

/// A fresh directory under the system's temporary one, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "nsh-image-cache-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const T0: u64 = 1_800_000_000;
const URL: &str = "https://img.example.com/avatar/42.png";

fn date(secs: u64) -> String {
    httpdate::fmt_http_date(UNIX_EPOCH + Duration::from_secs(secs))
}

fn headers(pairs: &[(&str, &str)]) -> CacheHeaders {
    CacheHeaders::from_pairs(pairs.iter().copied())
}

fn ok(pairs: &[(&str, &str)], body: &[u8]) -> Result<Fetched, String> {
    Ok(Fetched::new(200, headers(pairs), body.to_vec()))
}

fn status(code: u16, pairs: &[(&str, &str)]) -> Result<Fetched, String> {
    Ok(Fetched::new(code, headers(pairs), Vec::new()))
}

fn fresh(lookup: Lookup) -> Option<Vec<u8>> {
    match lookup {
        Lookup::Fresh(bytes) => Some(bytes.to_vec()),
        _ => None,
    }
}

#[test]
fn stores_and_serves_fresh_entries() {
    let dir = TempDir::new();
    let cache = DiskCache::open(&dir.0, ByteSize::from_bytes(1 << 20)).unwrap();
    assert!(matches!(
        cache.lookup_at(URL, &Access::all(), T0),
        Lookup::Miss
    ));
    let shown = cache
        .complete_at(
            URL,
            &Access::all(),
            ok(&[("Cache-Control", "public, max-age=600")], b"png"),
            T0,
        )
        .unwrap();
    assert_eq!(&*shown, b"png");
    assert_eq!(
        fresh(cache.lookup_at(URL, &Access::all(), T0 + 599)).as_deref(),
        Some(&b"png"[..])
    );
    // Another handle on the directory (another surface) sees it.
    let other = DiskCache::open(&dir.0, ByteSize::from_bytes(1 << 20)).unwrap();
    assert_eq!(
        fresh(other.lookup_at(URL, &Access::all(), T0 + 1)).as_deref(),
        Some(&b"png"[..])
    );
    assert!(matches!(
        cache.lookup_at(URL, &Access::all(), T0 + 600),
        Lookup::Stale(_)
    ));
    assert!(matches!(
        cache.lookup_at("https://img.example.com/other.png", &Access::all(), T0),
        Lookup::Miss
    ));
}

#[test]
fn no_disk_cache_without_bytes() {
    assert!(DiskCache::open("/nowhere", ByteSize::from_bytes(0)).is_none());
}

#[test]
fn freshness_follows_the_headers() {
    let policy = |pairs: &[(&str, &str)]| Policy::of(&headers(pairs), T0);
    assert_eq!(
        policy(&[("Cache-Control", "max-age=60")]).fresh_until,
        T0 + 60
    );
    // Its age counts against it: `Age`, or the time since `Date`.
    assert_eq!(
        policy(&[("Cache-Control", "max-age=60"), ("Age", "20")]).fresh_until,
        T0 + 40
    );
    assert_eq!(
        policy(&[("Cache-Control", "max-age=60"), ("Date", &date(T0 - 30))]).fresh_until,
        T0 + 30
    );
    // `max-age` wins over `Expires`.
    assert_eq!(
        policy(&[
            ("Cache-Control", "max-age=60"),
            ("Expires", &date(T0 + 9999))
        ])
        .fresh_until,
        T0 + 60
    );
    assert_eq!(
        policy(&[("Expires", &date(T0 + 300)), ("Date", &date(T0))]).fresh_until,
        T0 + 300
    );
    // An invalid `Expires` is in the past.
    assert_eq!(policy(&[("Expires", "0")]).fresh_until, T0);
    // Heuristic: a tenth of the time since it changed, at most a week.
    assert_eq!(
        policy(&[("Last-Modified", &date(T0 - 1000)), ("Date", &date(T0))]).fresh_until,
        T0 + 100
    );
    assert_eq!(
        policy(&[("Last-Modified", &date(T0 - 1000 * 24 * 3600))]).fresh_until,
        T0 + MAX_HEURISTIC.as_secs()
    );
    // Nothing said: stale at once (still stored, for revalidation and
    // offline use).
    let silent = policy(&[]);
    assert_eq!(
        (silent.store, silent.fresh_until, silent.strict),
        (true, T0, false)
    );
    let no_cache = policy(&[("Cache-Control", "no-cache, max-age=600")]);
    assert_eq!(
        (no_cache.store, no_cache.fresh_until, no_cache.strict),
        (true, T0, true)
    );
    assert_eq!(policy(&[("Pragma", "no-cache")]).fresh_until, T0);
    // `no-cache="Set-Cookie"` only bars a field.
    assert_eq!(
        policy(&[("Cache-Control", "no-cache=\"Set-Cookie\", max-age=5")]).fresh_until,
        T0 + 5
    );
    assert!(policy(&[("Cache-Control", "must-revalidate, max-age=5")]).strict);
    assert!(!policy(&[("Cache-Control", "private, No-Store")]).store);
    assert!(!policy(&[("Vary", "Accept, *")]).store);
    assert!(policy(&[("Vary", "Accept-Encoding")]).store);
}

#[test]
fn honors_no_store() {
    let dir = TempDir::new();
    let cache = DiskCache::open(&dir.0, ByteSize::from_bytes(1 << 20)).unwrap();
    cache
        .complete_at(
            URL,
            &Access::all(),
            ok(&[("Cache-Control", "max-age=60")], b"old"),
            T0,
        )
        .unwrap();
    // A later `no-store` response is shown and drops what was kept.
    let shown = cache
        .complete_at(
            URL,
            &Access::all(),
            ok(&[("Cache-Control", "no-store")], b"new"),
            T0 + 61,
        )
        .unwrap();
    assert_eq!(&*shown, b"new");
    assert!(matches!(
        cache.lookup_at(URL, &Access::all(), T0 + 61),
        Lookup::Miss
    ));
    // Neither are other statuses kept.
    let partial = Fetched::new(
        206,
        headers(&[("Cache-Control", "max-age=60")]),
        b"pa".to_vec(),
    );
    assert_eq!(
        &*cache
            .complete_at(URL, &Access::all(), Ok(partial), T0)
            .unwrap(),
        b"pa"
    );
    assert!(matches!(
        cache.lookup_at(URL, &Access::all(), T0),
        Lookup::Miss
    ));
}

#[test]
fn revalidates_stale_entries() {
    let dir = TempDir::new();
    let cache = DiskCache::open(&dir.0, ByteSize::from_bytes(1 << 20)).unwrap();
    let response = ok(
        &[
            ("Cache-Control", "max-age=60"),
            ("ETag", "\"v1\""),
            ("Last-Modified", &date(T0 - 3600)),
        ],
        b"png",
    );
    cache
        .complete_at(URL, &Access::all(), response, T0)
        .unwrap();
    let lookup = cache.lookup_at(URL, &Access::all(), T0 + 61);
    let Lookup::Stale(validators) = &lookup else {
        panic!("stale");
    };
    assert_eq!(validators.etag.as_deref(), Some("\"v1\""));
    assert_eq!(
        lookup.request_headers(),
        vec![
            ("If-None-Match", "\"v1\"".to_owned()),
            ("If-Modified-Since", date(T0 - 3600))
        ]
    );
    // 304: the copy serves again, fresh by the stored `max-age` from now
    // (the 304 says nothing new).
    let shown = cache
        .complete_at(URL, &Access::all(), status(304, &[]), T0 + 61)
        .unwrap();
    assert_eq!(&*shown, b"png");
    assert_eq!(
        fresh(cache.lookup_at(URL, &Access::all(), T0 + 120)).as_deref(),
        Some(&b"png"[..])
    );
    // A 304's headers win over the stored ones.
    cache
        .complete_at(
            URL,
            &Access::all(),
            status(
                304,
                &[("Cache-Control", "max-age=3600"), ("ETag", "\"v2\"")],
            ),
            T0 + 200,
        )
        .unwrap();
    assert!(fresh(cache.lookup_at(URL, &Access::all(), T0 + 3000)).is_some());
    let Lookup::Stale(validators) = cache.lookup_at(URL, &Access::all(), T0 + 4000) else {
        panic!("stale");
    };
    assert_eq!(validators.etag.as_deref(), Some("\"v2\""));
    // 200: replaced.
    cache
        .complete_at(
            URL,
            &Access::all(),
            ok(&[("Cache-Control", "max-age=60")], b"new"),
            T0 + 4000,
        )
        .unwrap();
    assert_eq!(
        fresh(cache.lookup_at(URL, &Access::all(), T0 + 4001)).as_deref(),
        Some(&b"new"[..])
    );
    // A 304 for an entry that went away is an error, not empty bytes.
    cache.remove(URL);
    assert!(
        cache
            .complete_at(URL, &Access::all(), status(304, &[]), T0)
            .is_err()
    );
}

#[test]
fn serves_stale_copies_when_offline() {
    let dir = TempDir::new();
    let cache = DiskCache::open(&dir.0, ByteSize::from_bytes(1 << 20)).unwrap();
    cache
        .complete_at(URL, &Access::all(), ok(&[], b"png"), T0)
        .unwrap();
    // Nothing said about freshness: stale, without validators.
    let Lookup::Stale(validators) = cache.lookup_at(URL, &Access::all(), T0) else {
        panic!("stale");
    };
    assert_eq!(validators, Validators::default());
    let offline = cache.complete_at(URL, &Access::all(), Err("offline".into()), T0 + 1);
    assert_eq!(&*offline.unwrap(), b"png");
    let unavailable = cache.complete_at(URL, &Access::all(), status(503, &[]), T0 + 1);
    assert_eq!(&*unavailable.unwrap(), b"png");
    // Gone (404): dropped.
    assert_eq!(
        cache
            .complete_at(URL, &Access::all(), status(404, &[]), T0 + 2)
            .unwrap_err(),
        "HTTP 404"
    );
    assert!(matches!(
        cache.lookup_at(URL, &Access::all(), T0 + 2),
        Lookup::Miss
    ));
    assert_eq!(
        cache
            .complete_at(URL, &Access::all(), Err("offline".into()), T0 + 3)
            .unwrap_err(),
        "offline"
    );
    // `must-revalidate` is never served stale.
    cache
        .complete_at(
            URL,
            &Access::all(),
            ok(&[("Cache-Control", "max-age=1, must-revalidate")], b"png"),
            T0,
        )
        .unwrap();
    assert_eq!(
        cache
            .complete_at(URL, &Access::all(), Err("offline".into()), T0 + 5)
            .unwrap_err(),
        "offline"
    );
    assert_eq!(
        cache
            .complete_at(URL, &Access::all(), status(502, &[]), T0 + 5)
            .unwrap_err(),
        "HTTP 502"
    );
    assert!(
        cache
            .complete_at(URL, &Access::all(), status(302, &[]), T0)
            .unwrap_err()
            .contains("302")
    );
}

/// A redirect the app may not load ends a download without being followed
/// (`Fetched::refused`, or the 3xx a backend leaves unfollowed). The copy
/// kept for the URL came through that redirect too, so it goes: it is not
/// served then, nor later when the network fails.
#[test]
fn a_refused_redirect_drops_the_cached_copy() {
    let refusals = [
        (
            Ok(Fetched::refused(
                302,
                "redirect to `http://b.example/x.png` is not granted by capabilities.network",
            )),
            "is not granted",
        ),
        (status(302, &[]), "302"),
    ];
    for (refused, says) in refusals {
        let dir = TempDir::new();
        let cache = DiskCache::open(&dir.0, ByteSize::from_bytes(1 << 20)).unwrap();
        // A copy with nothing said about freshness: served stale when offline.
        cache
            .complete_at(URL, &Access::all(), ok(&[], b"png"), T0)
            .unwrap();
        assert!(matches!(
            cache.lookup_at(URL, &Access::all(), T0),
            Lookup::Stale(_)
        ));
        let error = cache
            .complete_at(URL, &Access::all(), refused, T0 + 1)
            .unwrap_err();
        assert!(error.contains(says), "{error}");
        assert!(matches!(
            cache.lookup_at(URL, &Access::all(), T0 + 1),
            Lookup::Miss
        ));
        assert_eq!(
            cache
                .complete_at(URL, &Access::all(), Err("offline".into()), T0 + 2)
                .unwrap_err(),
            "offline"
        );
    }
}

#[test]
fn drops_corrupt_entries() {
    let dir = TempDir::new();
    let cache = DiskCache::open(&dir.0, ByteSize::from_bytes(1 << 20)).unwrap();
    let store = || {
        cache
            .complete_at(
                URL,
                &Access::all(),
                ok(&[("Cache-Control", "max-age=600")], b"0123456789"),
                T0,
            )
            .unwrap();
    };
    let path = cache.path(URL);
    type Damage = dyn Fn(&mut Vec<u8>);
    let damage: [&Damage; 5] = [
        // Truncated (a writer that died, a full disk).
        &|bytes| bytes.truncate(bytes.len() - 3),
        // A flipped body byte.
        &|bytes| {
            let last = bytes.len() - 1;
            bytes[last] ^= 1;
        },
        // A flipped digit of its freshness (parses, fails the checksum).
        &|bytes| {
            let at = bytes.windows(7).position(|w| w == b"\nstrict").unwrap() - 1;
            bytes[at] ^= 1;
        },
        // Another format.
        &|bytes| bytes[..8].copy_from_slice(b"GARBAGE!"),
        // An absurd header length.
        &|bytes| bytes[8..12].copy_from_slice(&u32::MAX.to_le_bytes()),
    ];
    for damage in damage {
        store();
        let mut bytes = fs::read(&path).unwrap();
        damage(&mut bytes);
        fs::write(&path, &bytes).unwrap();
        assert!(fresh(cache.lookup_at(URL, &Access::all(), T0)).is_none());
        assert!(!path.exists(), "a corrupt entry is deleted");
    }
    // An empty file, and a file of another URL under this name (a digest
    // collision, or a renamed file), are misses.
    fs::write(&path, b"").unwrap();
    assert!(matches!(
        cache.lookup_at(URL, &Access::all(), T0),
        Lookup::Miss
    ));
    store();
    fs::rename(&path, cache.path("https://other.example/a.png")).unwrap();
    assert!(matches!(
        cache.lookup_at("https://other.example/a.png", &Access::all(), T0),
        Lookup::Miss
    ));
    // A stale entry's damaged body fails its 304, not silently.
    cache
        .complete_at(
            URL,
            &Access::all(),
            ok(&[("ETag", "\"e\"")], b"0123456789"),
            T0,
        )
        .unwrap();
    let mut bytes = fs::read(&path).unwrap();
    bytes.pop();
    fs::write(&path, &bytes).unwrap();
    assert!(matches!(
        cache.lookup_at(URL, &Access::all(), T0),
        Lookup::Stale(_)
    ));
    assert!(
        cache
            .complete_at(URL, &Access::all(), status(304, &[]), T0)
            .is_err()
    );
}

#[test]
fn evicts_the_least_recently_used() {
    let dir = TempDir::new();
    let body = vec![7u8; 1000];
    // Room for twelve entries (of about 1130 bytes).
    let cache = DiskCache::open(&dir.0, ByteSize::from_bytes(12 * 1200)).unwrap();
    let url = |i: usize| format!("https://img.example.com/{i}.png");
    let age = |i: usize, secs: u64| {
        let file = fs::OpenOptions::new()
            .write(true)
            .open(cache.path(&url(i)))
            .unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(secs))
            .unwrap();
    };
    for i in 0..10 {
        cache
            .complete_at(
                &url(i),
                &Access::all(),
                ok(&[("Cache-Control", "max-age=600")], &body),
                T0,
            )
            .unwrap();
        // Older first: entry 0 was used longest ago...
        age(i, 10_000 - i as u64 * 100);
    }
    // ...but a hit makes it the most recent.
    assert!(fresh(cache.lookup_at(&url(0), &Access::all(), T0)).is_some());
    for i in 10..13 {
        cache
            .complete_at(
                &url(i),
                &Access::all(),
                ok(&[("Cache-Control", "max-age=600")], &body),
                T0,
            )
            .unwrap();
    }
    let kept: Vec<usize> = (0..13)
        .filter(|&i| fresh(cache.lookup_at(&url(i), &Access::all(), T0)).is_some())
        .collect();
    let total: u64 = fs::read_dir(&dir.0)
        .unwrap()
        .map(|e| e.unwrap().metadata().unwrap().len())
        .sum();
    assert!(total <= cache.max_size().bytes(), "{total} bytes kept");
    assert!(kept.contains(&0), "the entry just used stays: {kept:?}");
    assert!(
        !kept.contains(&1) && !kept.contains(&2),
        "the oldest go: {kept:?}"
    );
    assert!(kept.contains(&12));
    // Bodies over an eighth of the cache are not kept.
    let big = vec![0u8; 2000];
    cache
        .complete_at(
            "https://img.example.com/big.png",
            &Access::all(),
            ok(&[], &big),
            T0,
        )
        .unwrap();
    assert!(matches!(
        cache.lookup_at("https://img.example.com/big.png", &Access::all(), T0),
        Lookup::Miss
    ));
    cache.clear();
    assert!(matches!(
        cache.lookup_at(&url(12), &Access::all(), T0),
        Lookup::Miss
    ));
}

#[test]
fn trims_what_dead_writers_left() {
    let dir = TempDir::new();
    let cache = DiskCache::open(&dir.0, ByteSize::from_bytes(1 << 20)).unwrap();
    fs::create_dir_all(&dir.0).unwrap();
    let left = dir.0.join(".tmp-1-2-3");
    fs::write(&left, b"half").unwrap();
    let file = fs::OpenOptions::new().write(true).open(&left).unwrap();
    file.set_modified(SystemTime::now() - Duration::from_secs(2 * 3600))
        .unwrap();
    let fresh_tmp = dir.0.join(".tmp-1-2-4");
    fs::write(&fresh_tmp, b"busy").unwrap();
    // The first write scans.
    cache
        .complete_at(URL, &Access::all(), ok(&[], b"png"), T0)
        .unwrap();
    assert!(!left.exists());
    assert!(fresh_tmp.exists(), "a writer may still be writing it");
}

#[test]
fn surfaces_share_a_directory_safely() {
    let dir = TempDir::new();
    let body = |i: usize, round: usize| vec![(i * 31 + round) as u8; 600 + i * 10];
    std::thread::scope(|scope| {
        for worker in 0..8 {
            let path = dir.0.clone();
            scope.spawn(move || {
                // A handle per thread, as surfaces open their own.
                let cache = DiskCache::open(path, ByteSize::from_bytes(40 * 1024)).unwrap();
                for round in 0..40 {
                    let i = (worker + round) % 24;
                    let url = format!("https://img.example.com/{i}.png");
                    match cache.lookup_at(&url, &Access::all(), T0) {
                        // Whatever is read back is whole: one writer's
                        // body for this URL.
                        Lookup::Fresh(bytes) => {
                            assert_eq!(bytes.len(), 600 + i * 10);
                            assert!(bytes.iter().all(|&b| b == bytes[0]));
                        }
                        Lookup::Stale(_) | Lookup::Miss => {
                            let response = ok(&[("Cache-Control", "max-age=600")], &body(i, round));
                            let shown = cache
                                .complete_at(&url, &Access::all(), response, T0)
                                .unwrap();
                            assert_eq!(shown.len(), 600 + i * 10);
                        }
                    }
                }
            });
        }
    });
    let cache = DiskCache::open(&dir.0, ByteSize::from_bytes(40 * 1024)).unwrap();
    cache.trim();
    let names: Vec<String> = fs::read_dir(&dir.0)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        names.iter().all(|n| !n.starts_with('.')),
        "no temporary file left: {names:?}"
    );
    let total: u64 = fs::read_dir(&dir.0)
        .unwrap()
        .map(|e| e.unwrap().metadata().unwrap().len())
        .sum();
    assert!(total <= 40 * 1024);
}

#[test]
fn loads_through_a_fetch() {
    let dir = TempDir::new();
    let cache = DiskCache::open(&dir.0, ByteSize::from_bytes(1 << 20)).unwrap();
    let mut requests = 0;
    let mut get = |sent: &[(&'static str, String)]| {
        requests += 1;
        if sent.iter().any(|(name, _)| *name == "If-None-Match") {
            return status(304, &[("Cache-Control", "max-age=600")]);
        }
        ok(&[("Cache-Control", "max-age=0"), ("ETag", "\"a\"")], b"png")
    };
    assert_eq!(&*cache.load(URL, &Access::all(), &mut get).unwrap(), b"png");
    // Stale at once: revalidated, then fresh for ten minutes.
    assert_eq!(&*cache.load(URL, &Access::all(), &mut get).unwrap(), b"png");
    assert_eq!(&*cache.load(URL, &Access::all(), &mut get).unwrap(), b"png");
    assert_eq!(requests, 2);
}

#[test]
fn reads_headers_in_any_case() {
    let h = CacheHeaders::from_pairs([
        ("CACHE-CONTROL", " max-age=5 "),
        ("x-other", "1"),
        ("Cache-Control", "public"),
        ("etag", "\"x\""),
    ]);
    assert_eq!(h.cache_control.as_deref(), Some("max-age=5, public"));
    assert_eq!(h.etag.as_deref(), Some("\"x\""));
    let h = CacheHeaders::from_lookup(|name| (name == "last-modified").then(|| date(T0)));
    assert_eq!(h.last_modified, Some(date(T0)));
    assert_eq!(h.cache_control, None);
}

const CDN: &str = "https://cdn.example.net/42.png";
const ORIGIN: &str = "https://origin.example.org/42.png";

/// An app that may load from `hosts` only.
fn only(hosts: &[&str]) -> Access {
    let http: Vec<_> = hosts
        .iter()
        .map(|host| serde_json::json!({ "host": host }))
        .collect();
    Access {
        declared: Capabilities::from_json(&serde_json::json!({ "network": { "http": http } }))
            .unwrap(),
        granted: None,
    }
}

fn via(pairs: &[(&str, &str)], body: &[u8], redirects: &[&str]) -> Result<Fetched, String> {
    let redirects = redirects.iter().map(|hop| (*hop).to_owned()).collect();
    Ok(Fetched::new(200, headers(pairs), body.to_vec()).redirected(redirects))
}

/// A fresh copy is served without a request, so nothing checks where it
/// came from but the cache: it keeps the redirects of the download and
/// drops the copy when the app may no longer follow one of them.
#[test]
fn a_fresh_copy_is_served_only_while_its_redirects_are_granted() {
    let dir = TempDir::new();
    let cache = DiskCache::open(&dir.0, ByteSize::from_bytes(1 << 20)).unwrap();
    let store = || {
        cache
            .complete_at(
                URL,
                &Access::all(),
                via(&[("Cache-Control", "max-age=600")], b"png", &[CDN, ORIGIN]),
                T0,
            )
            .unwrap();
    };
    store();
    let everywhere = only(&["img.example.com", "cdn.example.net", "origin.example.org"]);
    for access in [Access::all(), everywhere] {
        assert_eq!(
            fresh(cache.lookup_at(URL, &access, T0 + 1)).as_deref(),
            Some(&b"png"[..])
        );
    }
    // Refused at the first hop, or at a later one: the copy is dropped, so
    // nothing of it is left for a later lookup, whatever it may load.
    for hosts in [
        &["img.example.com"][..],
        &["img.example.com", "cdn.example.net"],
        &["img.example.com", "origin.example.org"],
    ] {
        store();
        assert!(matches!(
            cache.lookup_at(URL, &only(hosts), T0 + 1),
            Lookup::Miss
        ));
        assert!(!cache.path(URL).exists(), "{hosts:?}");
        assert!(matches!(
            cache.lookup_at(URL, &Access::all(), T0 + 1),
            Lookup::Miss
        ));
    }
    // A copy that came straight from its URL has nothing to check.
    cache
        .complete_at(
            URL,
            &Access::all(),
            ok(&[("Cache-Control", "max-age=600")], b"png"),
            T0,
        )
        .unwrap();
    assert!(fresh(cache.lookup_at(URL, &only(&["img.example.com"]), T0 + 1)).is_some());
}

/// A stale copy is not revalidated when a redirect it came through is
/// refused (a `304` would serve its body), nor served when the request
/// fails.
#[test]
fn a_stale_copy_is_served_only_while_its_redirects_are_granted() {
    let dir = TempDir::new();
    let cache = DiskCache::open(&dir.0, ByteSize::from_bytes(1 << 20)).unwrap();
    let narrow = only(&["img.example.com"]);
    let store = || {
        cache
            .complete_at(
                URL,
                &Access::all(),
                via(&[("ETag", "\"v1\"")], b"png", &[CDN]),
                T0,
            )
            .unwrap();
    };
    store();
    assert!(matches!(
        cache.lookup_at(URL, &Access::all(), T0),
        Lookup::Stale(_)
    ));
    assert!(matches!(cache.lookup_at(URL, &narrow, T0), Lookup::Miss));
    assert!(!cache.path(URL).exists());
    // The access narrowed between the lookup and the request's failure.
    for failure in [Err("offline".to_owned()), status(503, &[])] {
        store();
        let served = cache.complete_at(URL, &Access::all(), failure.clone(), T0 + 1);
        assert_eq!(&*served.unwrap(), b"png");
        let error = cache
            .complete_at(URL, &narrow, failure, T0 + 1)
            .unwrap_err();
        assert!(error == "offline" || error == "HTTP 503", "{error}");
        assert!(!cache.path(URL).exists());
    }
}

/// A revalidation's redirects replace the stored ones: the copy is checked
/// against the way it was last reached.
#[test]
fn a_revalidation_keeps_its_own_redirects() {
    let dir = TempDir::new();
    let cache = DiskCache::open(&dir.0, ByteSize::from_bytes(1 << 20)).unwrap();
    cache
        .complete_at(
            URL,
            &Access::all(),
            via(&[("ETag", "\"v1\"")], b"png", &[CDN]),
            T0,
        )
        .unwrap();
    let not_modified = Fetched::new(
        304,
        headers(&[("Cache-Control", "max-age=600")]),
        Vec::new(),
    )
    .redirected(vec![ORIGIN.to_owned()]);
    cache
        .complete_at(URL, &Access::all(), Ok(not_modified), T0 + 1)
        .unwrap();
    let origin = only(&["img.example.com", "origin.example.org"]);
    assert!(fresh(cache.lookup_at(URL, &origin, T0 + 2)).is_some());
    let cdn = only(&["img.example.com", "cdn.example.net"]);
    assert!(matches!(cache.lookup_at(URL, &cdn, T0 + 2), Lookup::Miss));
}

/// Entries of the format before redirects were kept say nothing of where
/// they came from: they are an unknown format, deleted when read.
#[test]
fn drops_entries_that_kept_no_redirects() {
    let dir = TempDir::new();
    let cache = DiskCache::open(&dir.0, ByteSize::from_bytes(1 << 20)).unwrap();
    cache
        .complete_at(
            URL,
            &Access::all(),
            ok(&[("Cache-Control", "max-age=600")], b"png"),
            T0,
        )
        .unwrap();
    let path = cache.path(URL);
    let mut bytes = fs::read(&path).unwrap();
    assert_eq!(&bytes[..8], b"NSHIMG2\n");
    // The same entry as version 1 wrote it (a header without `via` lines
    // is the same in both).
    bytes[..8].copy_from_slice(b"NSHIMG1\n");
    fs::write(&path, &bytes).unwrap();
    assert!(matches!(
        cache.lookup_at(URL, &Access::all(), T0),
        Lookup::Miss
    ));
    assert!(!path.exists());
    fs::write(&path, &bytes).unwrap();
    assert_eq!(
        cache
            .complete_at(URL, &Access::all(), Err("offline".into()), T0)
            .unwrap_err(),
        "offline"
    );
    assert!(!path.exists());
}

/// A copy whose redirects cannot all be kept (a hop that would not read
/// back as written, a header too long to read back) is not stored, and
/// replaces nothing: the entry it would have replaced goes.
#[test]
fn stores_nothing_reached_through_redirects_it_cannot_keep() {
    let dir = TempDir::new();
    let cache = DiskCache::open(&dir.0, ByteSize::from_bytes(1 << 20)).unwrap();
    let long: Vec<String> = (0..20)
        .map(|i| format!("https://cdn.example.net/{i}/{}", "a".repeat(4 << 10)))
        .collect();
    let long: Vec<&str> = long.iter().map(String::as_str).collect();
    let unkept: [&[&str]; 4] = [
        &["https://cdn.example.net/a\tb.png"],
        &[
            CDN,
            "https://cdn.example.net/a\nvia\thttps://img.example.com/",
        ],
        &["https://cdn.example.net/a.png\r"],
        &long,
    ];
    for redirects in unkept {
        cache
            .complete_at(
                URL,
                &Access::all(),
                ok(&[("Cache-Control", "max-age=600")], b"old"),
                T0,
            )
            .unwrap();
        assert!(cache.path(URL).exists());
        let shown = cache
            .complete_at(
                URL,
                &Access::all(),
                via(&[("Cache-Control", "max-age=600")], b"png", redirects),
                T0,
            )
            .unwrap();
        assert_eq!(&*shown, b"png");
        assert!(!cache.path(URL).exists());
        assert!(matches!(
            cache.lookup_at(URL, &Access::all(), T0),
            Lookup::Miss
        ));
    }
}

/// A `304` answers for the copy on disk when it arrives, which another
/// handle on the directory may have stored since the lookup: it is served
/// only if it came a way this app may load.
#[test]
fn a_304_serves_no_copy_that_came_through_a_refused_redirect() {
    let dir = TempDir::new();
    let cache = DiskCache::open(&dir.0, ByteSize::from_bytes(1 << 20)).unwrap();
    cache
        .complete_at(
            URL,
            &Access::all(),
            via(&[("ETag", "\"v1\"")], b"png", &[CDN]),
            T0,
        )
        .unwrap();
    let error = cache
        .complete_at(
            URL,
            &only(&["img.example.com"]),
            status(304, &[("Cache-Control", "max-age=600")]),
            T0 + 1,
        )
        .unwrap_err();
    assert!(error.contains("is not granted"), "{error}");
    assert!(!cache.path(URL).exists());
}

/// What the embedding app grants narrows what the app may load as its own
/// declaration does.
#[test]
fn an_embedders_grant_that_narrows_drops_the_copy() {
    let dir = TempDir::new();
    let cache = DiskCache::open(&dir.0, ByteSize::from_bytes(1 << 20)).unwrap();
    let granted = |hosts: &[&str]| Access {
        declared: Capabilities::all(),
        granted: Some(only(hosts).declared),
    };
    cache
        .complete_at(
            URL,
            &Access::all(),
            via(&[("Cache-Control", "max-age=600")], b"png", &[CDN]),
            T0,
        )
        .unwrap();
    let wide = granted(&["img.example.com", "cdn.example.net"]);
    assert!(fresh(cache.lookup_at(URL, &wide, T0 + 1)).is_some());
    let narrow = granted(&["img.example.com"]);
    assert!(matches!(
        cache.lookup_at(URL, &narrow, T0 + 1),
        Lookup::Miss
    ));
    assert!(!cache.path(URL).exists());
}

/// `load` asks for a refused copy's URL as a first request would: no
/// conditions, so no `304` can answer for the copy, and the response is
/// what is shown and kept.
#[test]
fn a_load_requests_a_refused_copy_in_full() {
    let dir = TempDir::new();
    let cache = DiskCache::open(&dir.0, ByteSize::from_bytes(1 << 20)).unwrap();
    cache
        .complete_at(
            URL,
            &Access::all(),
            via(&[("ETag", "\"v1\"")], b"old", &[CDN]),
            T0,
        )
        .unwrap();
    let narrow = only(&["img.example.com"]);
    let mut sent = None;
    let shown = cache
        .load(URL, &narrow, |headers| {
            sent = Some(headers.to_vec());
            ok(&[("Cache-Control", "max-age=600")], b"new")
        })
        .unwrap();
    assert_eq!(&*shown, b"new");
    assert_eq!(sent, Some(Vec::new()));
    assert_eq!(
        fresh(cache.lookup(URL, &narrow)).as_deref(),
        Some(&b"new"[..])
    );
}
