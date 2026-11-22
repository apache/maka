//! Precompressed copies of a published site's files.
//!
//! Static hosts serve a file's `.br` or `.gz` copy when the browser accepts
//! it (nginx `brotli_static` / `gzip_static`, Caddy `precompressed`, most
//! CDNs): compressed once at the highest levels, where a server compressing
//! each response uses fast ones. The runtime is nearly all of a first
//! load, and Brotli 11 makes it about a quarter smaller than gzip.

use std::{
    fs,
    io::Write as _,
    path::{Path, PathBuf},
};

use anyhow::Context as _;

/// The extensions of the files worth compressing: text and the runtime.
/// Images, fonts (WOFF2 is compressed already) and media are left alone.
const COMPRESSIBLE: &[&str] = &[
    "wasm",
    "js",
    "mjs",
    "css",
    "html",
    "json",
    "webmanifest",
    "svg",
    "txt",
    "map",
    "bin",
];

/// Files smaller than this are sent as they are.
const MIN_BYTES: u64 = 1024;

/// Writes `<file>.br` and `<file>.gz` next to each compressible file in
/// `dir`, each only when it is smaller than the file.
pub(crate) fn precompress(dir: &Path) -> anyhow::Result<()> {
    let mut files = Vec::new();
    collect(dir, &mut files)?;
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    // The largest first: the runtime takes most of the time.
    files.sort_by_key(|(_, len)| std::cmp::Reverse(*len));
    let next = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|scope| -> anyhow::Result<()> {
        let workers: Vec<_> = (0..threads)
            .map(|_| {
                scope.spawn(|| -> anyhow::Result<()> {
                    loop {
                        let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let Some((path, _)) = files.get(i) else {
                            return Ok(());
                        };
                        compress(path)?;
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().expect("a compression thread panicked")?;
        }
        Ok(())
    })
}

fn collect(dir: &Path, out: &mut Vec<(PathBuf, u64)>) -> anyhow::Result<()> {
    for entry in fs::read_dir(dir).with_context(|| format!("read {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            collect(&path, out)?;
            continue;
        }
        let len = entry.metadata()?.len();
        let compressible = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| COMPRESSIBLE.contains(&e));
        if compressible && len >= MIN_BYTES {
            out.push((path, len));
        }
    }
    Ok(())
}

fn compress(path: &Path) -> anyhow::Result<()> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let mut br = Vec::with_capacity(bytes.len() / 3);
    {
        let params = brotli::enc::BrotliEncoderParams {
            quality: 11,
            lgwin: 24,
            size_hint: bytes.len(),
            ..Default::default()
        };
        brotli::BrotliCompress(&mut &bytes[..], &mut br, &params)?;
    }
    let mut gz = flate2::write::GzEncoder::new(
        Vec::with_capacity(bytes.len() / 2),
        flate2::Compression::best(),
    );
    gz.write_all(&bytes)?;
    let gz = gz.finish()?;
    for (ext, out) in [("br", br), ("gz", gz)] {
        if out.len() < bytes.len() {
            let mut name = path.as_os_str().to_owned();
            name.push(".");
            name.push(ext);
            fs::write(&name, out).with_context(|| format!("write {}", path.display()))?;
        }
    }
    Ok(())
}

/// Whether `path` is a precompressed copy [`precompress`] wrote.
pub(crate) fn is_copy(path: &Path) -> bool {
    matches!(path.extension().and_then(|e| e.to_str()), Some("br" | "gz"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compressible_files_get_smaller_copies() {
        let dir = std::env::temp_dir().join(format!("nsh-precompress-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        let text = "const answer = 42;\n".repeat(200);
        fs::write(dir.join("app.js"), &text).unwrap();
        fs::write(dir.join("sub/nsh.wasm"), text.as_bytes()).unwrap();
        fs::write(dir.join("small.js"), "x").unwrap();
        fs::write(dir.join("photo.png"), text.as_bytes()).unwrap();
        precompress(&dir).unwrap();
        for file in ["app.js", "sub/nsh.wasm"] {
            let br = fs::read(dir.join(format!("{file}.br"))).unwrap();
            let mut back = Vec::new();
            brotli::BrotliDecompress(&mut &br[..], &mut back).unwrap();
            assert_eq!(back, text.as_bytes());
            assert!(dir.join(format!("{file}.gz")).exists());
        }
        assert!(!dir.join("small.js.br").exists());
        assert!(!dir.join("photo.png.br").exists());
        assert!(is_copy(&dir.join("app.js.br")));
        fs::remove_dir_all(&dir).unwrap();
    }
}
