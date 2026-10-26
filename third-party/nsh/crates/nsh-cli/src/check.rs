//! `nsh check`: type checks an app with TypeScript's native compiler
//! (TypeScript 7, written in Go: a single executable with its `lib.*.d.ts`
//! files, no Node). A pinned release is downloaded once from the npm
//! registry, its tarball checked against the integrity recorded here, and
//! kept in nsh's cache; `--tsc` (or `NSH_TSC`) uses another `tsc` instead.
//!
//! An app with Rust crates of its own (`nsh.json` `"rust"`) has its crates
//! checked first, each with `cargo check --all-targets` in its directory
//! ([`cargo_check`]): a Rust app (`"root"`) only that, unless it has a
//! `tsconfig.json` (for its TypeScript tests), a mixed app both.

use std::{
    env,
    io::Read as _,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context as _, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use sha2::{Digest as _, Sha512};

use crate::rust_app::RustApp;

/// The TypeScript release `nsh check` uses.
const TYPESCRIPT: &str = "7.0.2";

/// The npm package of [`TYPESCRIPT`]'s compiler for each host
/// (`@typescript/typescript-<name>`), and its tarball's `dist.integrity`.
const BUILDS: &[(&str, &str, &str, &str)] = &[
    (
        "macos",
        "aarch64",
        "darwin-arm64",
        "sha512-gowzar9MwS/aRWp6f3a4KUqzRjAZjOsmGNCM6LcTgXum+dBfgsBVMN+AgvOCCbguXyick6LJhpBszxMebJ8syA==",
    ),
    (
        "macos",
        "x86_64",
        "darwin-x64",
        "sha512-SZ9xZInqApNlNGc9s0W1VSsktYSOe9cFqNOIqmN1Gs8SmkjKZYFt017G4VwPxASInODuAdbTW7sXiFUf893RgA==",
    ),
    (
        "linux",
        "x86_64",
        "linux-x64",
        "sha512-EYdf2cNg7rgCWJnxCdJ+F3V39O8ihb37eHAu1LK8oAFizgTQbPOK7zHHXbPt8rX24COqODXeI3sIf0fCXG7H/A==",
    ),
    (
        "linux",
        "aarch64",
        "linux-arm64",
        "sha512-Qh4eU4/y3yDjnfjjyPYihMj5/ODIlmt+Bzu17OI+fiSRDW57QmU5SiN63exPRNJPKUzcc1INa1NXdrJ+MqHjUQ==",
    ),
    (
        "windows",
        "x86_64",
        "win32-x64",
        "sha512-0BQ3HkAHHlKLSp1qRvf3SUhGpGsDuhB/jgFw75guyqbxJqEaS0Cw/VFO8i2nHglJUzQCRtMMR/IBAKE3ETMC4g==",
    ),
    (
        "windows",
        "aarch64",
        "win32-arm64",
        "sha512-Gyl1Vy6OsWesLzmq+EP0Fb7b4Nid5232AvcA2SFcdYreldpNtYFFofPjnt62y9hQy7VTaZp65ICJjuAQRaVcIQ==",
    ),
];

/// The compiler's file in the package (`tsc.exe` on Windows).
const TSC: &str = if cfg!(windows) {
    "package/lib/tsc.exe"
} else {
    "package/lib/tsc"
};

/// Type checks the app of `entry` (its directory's `tsconfig.json`, with
/// the `.nsh/types` and `.nsh/tsconfig.json` the command line wrote
/// before) and fails on errors; warns when the `tsconfig.json` does not
/// extend `.nsh/tsconfig.json` (one the app changed, from before it did).
pub(crate) fn check(entry: &Path, tsc: Option<&Path>, args: &[String]) -> anyhow::Result<()> {
    let dir = dunce::canonicalize(entry)?
        .parent()
        .context("entry has no directory")?
        .to_path_buf();
    if !dir.join("tsconfig.json").exists() {
        bail!(
            "{} has no tsconfig.json: `nsh init {}` adds one",
            dir.display(),
            dir.display()
        );
    }
    if !crate::init::tsconfig_extends_nsh(&dir) {
        crate::ui::warn(format!(
            "{} does not extend ./.nsh/tsconfig.json, where nsh keeps its TypeScript settings \
             (`lib`, the paths of `nsh` and the app's crates, the globals) current: add \
             `\"extends\": \"./.nsh/tsconfig.json\"` and drop the options it sets, as the \
             tsconfig.json of `nsh init` does",
            crate::ui::path(&dir.join("tsconfig.json"))
        ));
    }
    let tsc = match tsc {
        Some(tsc) => tsc.to_path_buf(),
        None => typescript()?,
    };
    let status = Command::new(&tsc)
        .arg("-p")
        .arg(&dir)
        .arg("--noEmit")
        .args(args)
        .status()
        .with_context(|| format!("run {}", tsc.display()))?;
    if !status.success() {
        bail!("type check failed ({status})");
    }
    log::info!("no type errors in {}", dir.display());
    Ok(())
}

/// Checks the crates of `app` with `cargo check --all-targets` (their
/// tests and examples too), each in its own directory, so it builds in the
/// workspace and target directory `cargo` there uses; fails on the first
/// with errors, showing cargo's output.
pub(crate) fn cargo_check(app: &RustApp) -> anyhow::Result<()> {
    for krate in app.crates() {
        let mut cmd = krate.cargo("check");
        cmd.arg("--all-targets");
        crate::ui::cargo_as(&mut cmd, ["checking", "checked"], krate.package())?;
    }
    Ok(())
}

/// Whether the app of `entry` has TypeScript to check: a TSX entry's app,
/// or a Rust app (`nsh.json` `"root"`) with a `tsconfig.json` for its test
/// files.
pub(crate) fn has_typescript(entry: &Path) -> bool {
    !crate::rust_app::is_root(entry)
        || entry
            .parent()
            .is_some_and(|dir| dir.join("tsconfig.json").is_file())
}

/// The `tsc` of [`TYPESCRIPT`], downloaded into the cache the first time.
fn typescript() -> anyhow::Result<PathBuf> {
    let Some(&(_, _, name, integrity)) = BUILDS
        .iter()
        .find(|(os, arch, ..)| *os == env::consts::OS && *arch == env::consts::ARCH)
    else {
        bail!(
            "no TypeScript {TYPESCRIPT} build for {}-{}: pass --tsc <path to tsc>",
            env::consts::OS,
            env::consts::ARCH
        );
    };
    let dir = cache()?.join(format!("typescript-{TYPESCRIPT}-{name}"));
    let tsc = dir.join(TSC);
    if tsc.exists() {
        return Ok(tsc);
    }
    let url = format!(
        "https://registry.npmjs.org/@typescript/typescript-{name}/-/typescript-{name}-{TYPESCRIPT}.tgz"
    );
    log::info!("downloading TypeScript {TYPESCRIPT} ({url})");
    let mut tarball = Vec::new();
    ureq::get(&url)
        .call()
        .with_context(|| format!("download {url}"))?
        .into_body()
        .into_reader()
        .read_to_end(&mut tarball)
        .with_context(|| format!("download {url}"))?;
    verify(&tarball, integrity).with_context(|| url.clone())?;
    // Unpacked next to its final place, then moved there: a run stopped
    // halfway leaves no partial compiler behind.
    let partial = dir.with_extension(format!("partial-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&partial);
    std::fs::create_dir_all(&partial)?;
    tar::Archive::new(flate2::read::GzDecoder::new(tarball.as_slice()))
        .unpack(&partial)
        .context("unpack TypeScript")?;
    if !partial.join(TSC).exists() {
        bail!("{url} has no {TSC}");
    }
    if std::fs::rename(&partial, &dir).is_err() {
        // Another run installed it meanwhile.
        let _ = std::fs::remove_dir_all(&partial);
    }
    Ok(tsc)
}

/// Checks `data` against an npm `dist.integrity` (`sha512-<base64>`).
fn verify(data: &[u8], integrity: &str) -> anyhow::Result<()> {
    let expected = integrity
        .strip_prefix("sha512-")
        .context("not a sha512 integrity")?;
    let actual = B64.encode(Sha512::digest(data));
    if actual != expected {
        bail!("integrity mismatch: expected {integrity}, got sha512-{actual}");
    }
    Ok(())
}

/// nsh's cache: `NSH_CACHE`, else the platform's cache directory.
fn cache() -> anyhow::Result<PathBuf> {
    if let Some(dir) = env::var_os("NSH_CACHE") {
        return Ok(PathBuf::from(dir));
    }
    let home = env::var_os("HOME").map(PathBuf::from);
    let base = if cfg!(windows) {
        env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        home.map(|h| h.join("Library/Caches"))
    } else {
        env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| home.map(|h| h.join(".cache")))
    };
    Ok(base
        .context("no cache directory: set NSH_CACHE")?
        .join("nsh"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn integrity_is_checked() {
        // `printf hello | openssl dgst -sha512 -binary | base64`
        let hello = "sha512-m3HSJL1i83hdltRq0+o9czGb+8KJDKra4t/3JRlnPKcjI8PZm6XBHXx6zG4UuMXaDEZjR1wuXDre9G9zvN7AQw==";
        assert!(super::verify(b"hello", hello).is_ok());
        assert!(super::verify(b"hellO", hello).is_err());
    }

    #[test]
    fn every_build_has_an_integrity() {
        for (.., integrity) in super::BUILDS {
            assert!(
                integrity.starts_with("sha512-") && integrity.len() == 95,
                "{integrity}"
            );
        }
    }
}
