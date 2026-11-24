//! Patches between two versions of an app ([`crate::Delta`]).
//!
//! A release offers, beside each archive, a zstd patch from the previous
//! version (`nsh update-manifest --previous`). Its reference is the old
//! app's files written by [`base`]: a `.tar` that depends only on paths,
//! file contents and symbolic links, so the publisher (from the old
//! archive) and the installed app (from its directory) write the same
//! bytes. Its result is a `.tar` of the new app, which installs as the
//! archive does. Both ends are checked by hash; a mismatch means the full
//! archive.

use std::{
    fs,
    io::{self, Read, Write},
    path::Path,
};

use sha2::{Digest as _, Sha256};

use crate::Error;

/// The level patches are made at: slow (a minute for a 100 MB app, made
/// once in the release's CI), small.
const LEVEL: i32 = 19;
/// The largest window a patch may need, 2 GiB (`--long=31`).
const WINDOW_LOG_MAX: u32 = 31;

/// Writes `app` (a directory or `.app`) into `out` as a patch's reference
/// and returns its SHA-256: entries in byte order under `app/`, every mode,
/// owner and time the same. Skips AppleDouble files (`._<name>`) and what
/// the updater leaves in an app (`.nsh-updater-…`).
pub fn base(app: &Path, out: impl Write) -> Result<String, Error> {
    let mut out = Hashing::new(out);
    write_tree(app, "app", false, &mut out)?;
    Ok(out.finish()?)
}

/// Writes `app` into `out` as a `.tar` to install, under its own name, with
/// its executable bits, and returns its SHA-256: the result of a patch
/// when the new archive is a `.zip`.
pub fn tree(app: &Path, out: impl Write) -> Result<String, Error> {
    let name = app
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| Error::Install(format!("{}: no file name", app.display())))?;
    let mut out = Hashing::new(out);
    write_tree(app, name, true, &mut out)?;
    Ok(out.finish()?)
}

/// Writes into `out` the patch that makes `result` from `base`.
pub fn make(base: &[u8], result: &[u8], out: impl Write) -> Result<(), Error> {
    let span = (base.len() + result.len()).max(1) as u64;
    let window_log = (64 - (span - 1).leading_zeros()).clamp(20, WINDOW_LOG_MAX);
    let mut encoder = zstd::stream::write::Encoder::with_ref_prefix(out, LEVEL, base)?;
    encoder.long_distance_matching(true)?;
    encoder.window_log(window_log)?;
    encoder.set_pledged_src_size(Some(result.len() as u64))?;
    encoder.write_all(result)?;
    encoder.finish()?;
    Ok(())
}

/// Applies `patch` to `base` into `out`; fails unless what it wrote has the
/// SHA-256 `result`.
pub fn apply(base: &[u8], patch: impl Read, out: impl Write, result: &str) -> Result<(), Error> {
    let bad = |e: io::Error| Error::Download(format!("the patch does not apply: {e}"));
    let mut decoder = zstd::stream::read::Decoder::with_ref_prefix(io::BufReader::new(patch), base)
        .map_err(bad)?;
    decoder.window_log_max(WINDOW_LOG_MAX).map_err(bad)?;
    let mut out = Hashing::new(out);
    io::copy(&mut decoder, &mut out).map_err(bad)?;
    let actual = out.finish()?;
    if actual != result.to_ascii_lowercase() {
        return Err(Error::Download(format!(
            "the patched app has SHA-256 {actual}, the manifest says {result}"
        )));
    }
    Ok(())
}

fn write_tree(root: &Path, name: &str, modes: bool, out: impl Write) -> Result<(), Error> {
    let mut tar = tar::Builder::new(out);
    tar.follow_symlinks(false);
    append(&mut tar, root, name, modes)?;
    tar.into_inner()?.flush()?;
    Ok(())
}

fn header(kind: tar::EntryType, mode: u32, size: u64) -> tar::Header {
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(kind);
    header.set_mode(mode);
    header.set_size(size);
    header.set_mtime(0);
    header.set_uid(0);
    header.set_gid(0);
    header
}

fn append<W: Write>(
    tar: &mut tar::Builder<W>,
    path: &Path,
    name: &str,
    modes: bool,
) -> Result<(), Error> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        let target = fs::read_link(path)?;
        let mut header = header(tar::EntryType::Symlink, 0o777, 0);
        tar.append_link(&mut header, name, target)?;
    } else if meta.is_dir() {
        let mut header = header(tar::EntryType::Directory, 0o755, 0);
        tar.append_data(&mut header, format!("{name}/"), io::empty())?;
        let mut entries = fs::read_dir(path)?
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect::<Result<Vec<_>, _>>()?;
        entries.sort_by(|a, b| a.as_encoded_bytes().cmp(b.as_encoded_bytes()));
        for entry in entries {
            let Some(child) = entry.to_str() else {
                return Err(Error::Install(format!(
                    "{}: a file name that is not UTF-8",
                    path.display()
                )));
            };
            if child.starts_with("._") || child.starts_with(crate::install::STAGING) {
                continue;
            }
            append(tar, &path.join(child), &format!("{name}/{child}"), modes)?;
        }
    } else {
        let mode = if modes && executable(&meta) {
            0o755
        } else {
            0o644
        };
        let mut header = header(tar::EntryType::Regular, mode, meta.len());
        tar.append_data(&mut header, name, fs::File::open(path)?)?;
    }
    Ok(())
}

#[cfg(unix)]
fn executable(meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable(_: &fs::Metadata) -> bool {
    false
}

/// A writer that hashes what it passes on.
struct Hashing<W> {
    inner: W,
    hash: Sha256,
}

impl<W: Write> Hashing<W> {
    fn new(inner: W) -> Self {
        Hashing {
            inner,
            hash: Sha256::new(),
        }
    }

    fn finish(mut self) -> io::Result<String> {
        self.inner.flush()?;
        Ok(crate::hex(&self.hash.finalize()))
    }
}

impl<W: Write> Write for Hashing<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.hash.update(&buf[..n]);
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(dir: &Path, main: &[u8], extra: Option<&[u8]>) -> std::path::PathBuf {
        let root = dir.join("Pal");
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::write(root.join("pal"), main).unwrap();
        fs::write(root.join("assets/app.js"), b"console.log(1)").unwrap();
        if let Some(extra) = extra {
            fs::write(root.join("assets/new.txt"), extra).unwrap();
        }
        root
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nsh-delta-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_base_depends_only_on_contents() {
        let dir = scratch("base");
        let one = app(&dir.join("one"), b"main v1", None);
        let two = app(&dir.join("two"), b"main v1", None);
        fs::rename(&two, dir.join("two/Renamed")).unwrap();
        let two = dir.join("two/Renamed");
        // What the updater and macOS leave in an app does not count.
        fs::write(two.join(".nsh-updater-old-pal"), b"x").unwrap();
        fs::write(two.join("assets/._app.js"), b"x").unwrap();
        let (mut a, mut b) = (Vec::new(), Vec::new());
        assert_eq!(base(&one, &mut a).unwrap(), base(&two, &mut b).unwrap());
        assert_eq!(a, b);
        fs::write(two.join("pal"), b"main v2").unwrap();
        assert_ne!(
            base(&one, io::sink()).unwrap(),
            base(&two, io::sink()).unwrap()
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_patch_rebuilds_the_new_app_or_fails() {
        let dir = scratch("patch");
        let big: Vec<u8> = (0..200_000u32)
            .flat_map(|i| (i * 7919).to_le_bytes())
            .collect();
        let old = app(&dir.join("old"), &big, None);
        let mut newer = big.clone();
        newer[1000..1010].copy_from_slice(b"0123456789");
        let new = app(&dir.join("new"), &newer, Some(b"added"));
        let mut reference = Vec::new();
        base(&old, &mut reference).unwrap();
        let mut result = Vec::new();
        let result_sha = tree(&new, &mut result).unwrap();
        let mut patch = Vec::new();
        make(&reference, &result, &mut patch).unwrap();
        assert!(
            patch.len() * 20 < result.len(),
            "patch {} bytes",
            patch.len()
        );

        let mut out = Vec::new();
        apply(&reference, &patch[..], &mut out, &result_sha).unwrap();
        assert_eq!(out, result);
        let mut entries = tar::Archive::new(&out[..]);
        let names: Vec<String> = entries
            .entries()
            .unwrap()
            .map(|e| e.unwrap().path().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(
            names.contains(&"Pal/assets/new.txt".to_owned()),
            "{names:?}"
        );

        // Another reference, or another result, is refused.
        let mut other = Vec::new();
        base(&new, &mut other).unwrap();
        assert!(apply(&other, &patch[..], io::sink(), &result_sha).is_err());
        assert!(apply(&reference, &patch[..], io::sink(), "00").is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
