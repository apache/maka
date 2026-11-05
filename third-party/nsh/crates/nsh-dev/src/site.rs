//! A static site served as a CDN would serve it: what `nsh package
//! --target web --run` opens in a browser.

use std::{io, net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    Router,
    extract::State,
    http::{HeaderMap, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};

/// Serves the files of a directory over HTTP until dropped. Files with a
/// content digest in their names (`nsh.1a2b3c4d5e.wasm`) are cached for a
/// year; the others (`index.html`, `manifest.webmanifest`) are revalidated
/// on every load, so a new release shows on the next one. A file's
/// precompressed copy (`<file>.br`, `<file>.gz`, which `nsh package`
/// writes) is sent in its place when the browser accepts its encoding.
pub struct SiteServer {
    addr: SocketAddr,
    _runtime: tokio::runtime::Runtime,
}

impl SiteServer {
    /// Serves `dir` on `addr` (`/` is `index.html`).
    pub fn start(addr: SocketAddr, dir: PathBuf) -> io::Result<SiteServer> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("nsh-site-server")
            .enable_all()
            .build()?;
        let root = Arc::new(dunce::canonicalize(dir)?);
        let listener = runtime.block_on(tokio::net::TcpListener::bind(addr))?;
        let addr = listener.local_addr()?;
        let app = Router::new().fallback(file).with_state(root);
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

async fn file(State(root): State<Arc<PathBuf>>, headers: HeaderMap, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() || path.ends_with('/') {
        format!("{path}index.html")
    } else {
        path.to_owned()
    };
    let decoded = percent_decode(&path);
    let Ok(file) = dunce::canonicalize(root.join(&decoded)) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !file.starts_with(&*root) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let cache = if is_hashed(&decoded) {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
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
                    (header::CONTENT_TYPE, crate::server::content_type(&file)),
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
                (header::CONTENT_TYPE, crate::server::content_type(&file)),
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
    fn escapes_are_decoded() {
        assert_eq!(super::percent_decode("a%20b%E4%B8%AD.png"), "a b中.png");
        assert_eq!(super::percent_decode("100%"), "100%");
    }
}
