//! A static site served as a CDN would serve it: what `nsh package
//! --target web --run` opens in a browser.

use std::{io, net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    Router,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri, header},
    response::{IntoResponse, Redirect, Response},
};

/// Serves the files of a directory over HTTP until dropped. Files with a
/// content digest in their names (`nsh.1a2b3c4d5e.wasm`) are cached for a
/// year; the others (`index.html`, `manifest.webmanifest`) are revalidated
/// on every load, so a new release shows on the next one. A file's
/// precompressed copy (`<file>.br`, `<file>.gz`, which `nsh package`
/// writes) is sent in its place when the browser accepts its encoding. A
/// browser loading one of the app's own paths (`/sports/football`) gets
/// `index.html`, as a host's rewrite rule for single-page apps gives it.
pub struct SiteServer {
    addr: SocketAddr,
    _runtime: tokio::runtime::Runtime,
}

/// The site a [`SiteServer`] serves: its directory, under its base path.
struct Site {
    root: PathBuf,
    base: String,
}

/// `base` as a path from the root ending in `/`, without empty segments:
/// `/apps/counter/` for `apps/counter`, `/apps//counter` or
/// `/apps/counter/`, and `/` for an empty path or `//`.
fn mount_path(base: &str) -> String {
    let mut path = String::from("/");
    for segment in base.split('/').filter(|segment| !segment.is_empty()) {
        path.push_str(segment);
        path.push('/');
    }
    path
}

impl SiteServer {
    /// Serves `dir` on `addr` (`/` is `index.html`).
    pub fn start(addr: SocketAddr, dir: PathBuf) -> io::Result<SiteServer> {
        Self::start_at(addr, dir, "/")
    }

    /// Serves `dir` on `addr` under the path `base` (`/apps/counter/`, as a
    /// page with that `<base href>` is deployed): `<base>index.html` is
    /// `dir/index.html`, and `/` goes there. The path is taken from the
    /// root with a `/` at its end and no empty segments (`apps//counter`
    /// is `/apps/counter/`), the form the page's `<base href>` must have.
    /// Requests match it as browsers send paths, percent-encoded
    /// (`/%E5%BA%94%E7%94%A8/` for `/应用/`), the form `nsh.json`
    /// `web.base` takes.
    pub fn start_at(addr: SocketAddr, dir: PathBuf, base: &str) -> io::Result<SiteServer> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("nsh-site-server")
            .enable_all()
            .build()?;
        let site = Arc::new(Site {
            root: dunce::canonicalize(dir)?,
            base: mount_path(base),
        });
        let listener = runtime.block_on(tokio::net::TcpListener::bind(addr))?;
        let addr = listener.local_addr()?;
        let app = Router::new().fallback(file).with_state(site);
        runtime.spawn(async move {
            if let Err(err) = axum::serve(listener, app).await {
                log::error!("site server stopped: {err}");
            }
        });
        Ok(SiteServer {
            addr,
            _runtime: runtime,
        })
    }

    /// The bound address (useful with port 0).
    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }
}

async fn file(
    State(site): State<Arc<Site>>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let Some(path) = uri.path().strip_prefix(&site.base) else {
        // The site's address without its base, or without its last slash.
        if uri.path() == "/" || format!("{}/", uri.path()) == site.base {
            return Redirect::temporary(&site.base).into_response();
        }
        return StatusCode::NOT_FOUND.into_response();
    };
    let root = &site.root;
    let path = if path.is_empty() || path.ends_with('/') {
        format!("{path}index.html")
    } else {
        path.to_owned()
    };
    let mut decoded = percent_decode(&path);
    let file = match dunce::canonicalize(root.join(&decoded)) {
        Ok(file) => file,
        Err(_) if crate::server::wants_page(&method, &uri, &headers) => {
            decoded = "index.html".to_owned();
            root.join(&decoded)
        }
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    if !file.starts_with(root) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let cache = if is_hashed(&decoded) {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let content_type = nsh_core::platform::content_type(&file.to_string_lossy());
    let accepted = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    for encoding in ["br", "gzip"] {
        if !accepts(accepted, encoding) {
            continue;
        }
        let ext = if encoding == "br" { "br" } else { "gz" };
        let mut copy = file.clone().into_os_string();
        copy.push(".");
        copy.push(ext);
        if let Ok(bytes) = tokio::fs::read(&copy).await {
            return (
                [
                    (header::CONTENT_TYPE, content_type),
                    (header::CACHE_CONTROL, cache),
                    (header::CONTENT_ENCODING, encoding),
                    (header::VARY, "Accept-Encoding"),
                ],
                bytes,
            )
                .into_response();
        }
    }
    match tokio::fs::read(&file).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, content_type),
                (header::CACHE_CONTROL, cache),
                (header::VARY, "Accept-Encoding"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Whether an `Accept-Encoding` value accepts `encoding` (named, with a
/// weight above 0).
fn accepts(accepted: &str, encoding: &str) -> bool {
    accepted.split(',').any(|item| {
        let mut parts = item.split(';');
        let name = parts.next().unwrap_or_default().trim();
        let refused = parts.any(|p| {
            p.trim()
                .strip_prefix("q=")
                .and_then(|q| q.trim().parse::<f32>().ok())
                .is_some_and(|q| q <= 0.0)
        });
        name.eq_ignore_ascii_case(encoding) && !refused
    })
}

/// Whether a file's name holds a content digest: `<stem>.<hex>.<ext>`,
/// as `nsh package --target web` names everything but the pages.
fn is_hashed(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    let mut parts = name.rsplit('.');
    let (Some(_ext), Some(digest), Some(_stem)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    digest.len() >= 8 && digest.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `%XX` escapes decoded (asset names with spaces or non-ASCII letters).
fn percent_decode(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%'
            && let (Some(h), Some(l)) = (
                bytes.get(i + 1).copied().and_then(hex),
                bytes.get(i + 2).copied().and_then(hex),
            )
        {
            out.push((h * 16 + l) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_files_with_a_digest_are_cached_for_good() {
        assert!(super::is_hashed("nsh.1a2b3c4d5e.wasm"));
        assert!(super::is_hashed("assets/img/a.0123456789.png"));
        assert!(!super::is_hashed("index.html"));
        assert!(!super::is_hashed("manifest.webmanifest"));
        assert!(!super::is_hashed("assets/logo.final.png"));
    }

    #[test]
    fn encodings_are_accepted_by_name_and_weight() {
        assert!(super::accepts("gzip, deflate, br, zstd", "br"));
        assert!(super::accepts("gzip;q=1.0, br;q=0.5", "br"));
        assert!(!super::accepts("gzip, br;q=0", "br"));
        assert!(!super::accepts("", "gzip"));
        assert!(!super::accepts("brotli", "br"));
    }

    #[test]
    fn the_base_is_one_path_from_the_root() {
        for (base, path) in [
            ("/", "/"),
            ("", "/"),
            ("//", "/"),
            ("/apps/counter/", "/apps/counter/"),
            ("apps/counter", "/apps/counter/"),
            ("/apps//counter", "/apps/counter/"),
            ("/apps///counter//", "/apps/counter/"),
        ] {
            assert_eq!(super::mount_path(base), path, "{base:?}");
        }
    }

    #[test]
    fn escapes_are_decoded() {
        assert_eq!(super::percent_decode("a%20b%E4%B8%AD.png"), "a b中.png");
        assert_eq!(super::percent_decode("100%"), "100%");
    }
}
