//! Keeps a generated workspace's `Cargo.lock` on the nsh it builds with.
//!
//! Built against a checkout or a nightly, the generated workspace patches
//! nsh's crates.io crates to it (`[patch.crates-io]`). A `Cargo.lock` written
//! before, by an nsh release or by an nsh that patched fewer crates, still
//! locks some of them at crates.io versions. Cargo then leaves the patches
//! out, or fails to select a version when a crates.io crate asks for a newer
//! `nsh-base` than the patched one. Updating just those packages lets Cargo
//! pick the patches again; nothing else in the lock moves.

use std::{
    path::Path,
    process::{Command, Stdio},
};

/// The packages named in `names` that `lock` takes from a registry, as
/// `name@version` (what `cargo update -p` takes).
pub(crate) fn registry_packages(lock: &str, names: &[&str]) -> Vec<String> {
    let mut found = Vec::new();
    for entry in lock.split("[[package]]") {
        let value = |key: &str| {
            entry.lines().find_map(|line| {
                line.strip_prefix(key)?
                    .trim_start()
                    .strip_prefix('=')?
                    .trim()
                    .strip_prefix('"')?
                    .strip_suffix('"')
            })
        };
        let (Some(name), Some(version), Some(source)) =
            (value("name"), value("version"), value("source"))
        else {
            continue;
        };
        let registry = source.starts_with("registry+") || source.starts_with("sparse+");
        if registry && names.contains(&name) {
            found.push(format!("{name}@{version}"));
        }
    }
    found
}

/// Moves the packages of `names` that the workspace `ws`'s lock still takes
/// from crates.io onto the patches its manifest has for them, then warns
/// about any Cargo keeps on crates.io: an app crate asks for a version the
/// patched nsh (`version`) does not satisfy, and the build would mix two
/// nsh cores.
pub(crate) fn follow_patches(ws: &Path, names: &[&str], version: &str) {
    let lock = ws.join("Cargo.lock");
    let read = || std::fs::read_to_string(&lock).unwrap_or_default();
    let stale = registry_packages(&read(), names);
    if stale.is_empty() {
        return;
    }
    let mut cmd = Command::new(crate::rust_app::cargo());
    cmd.arg("update")
        .arg("--manifest-path")
        .arg(ws.join("Cargo.toml"));
    for spec in &stale {
        cmd.args(["-p", spec]);
    }
    // Cargo's own output names every package it moves; a failure shows
    // again, with the reason, when the build resolves the workspace.
    let _ = cmd.stdout(Stdio::null()).stderr(Stdio::null()).status();
    let left = registry_packages(&read(), names);
    if !left.is_empty() {
        eprintln!(
            "warning: {} still come from crates.io, not from nsh {version} that builds the app: \
             a crate of the app asks for a newer version. Lower its requirement on nsh's crates \
             to one nsh {version} meets (\"{}\"), or build with a newer nsh.",
            left.join(", "),
            minor(version),
        );
    }
}

/// `0.7` of `0.7.1`: the requirement any patch release of the series meets.
fn minor(version: &str) -> String {
    version.splitn(3, '.').take(2).collect::<Vec<_>>().join(".")
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCK: &str = r#"
[[package]]
name = "nsh-base"
version = "0.7.0"
source = "git+https://github.com/longbridge/nsh?rev=7d701ea6#7d701ea6"

[[package]]
name = "nsh-platform-tui"
version = "0.7.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "00"

[[package]]
name = "nsh-tui-host"
version = "0.7.1"
source = "sparse+https://index.crates.io/"

[[package]]
name = "serde"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "nsh-core"
version = "0.7.0"
"#;

    #[test]
    fn only_nsh_crates_from_a_registry_are_stale() {
        let names = ["nsh-base", "nsh-core", "nsh-platform-tui", "nsh-tui-host"];
        assert_eq!(
            registry_packages(LOCK, &names),
            ["nsh-platform-tui@0.7.1", "nsh-tui-host@0.7.1"]
        );
        assert!(registry_packages("", &names).is_empty());
    }

    #[test]
    fn the_hint_asks_for_the_series() {
        assert_eq!(minor("0.7.1"), "0.7");
        assert_eq!(minor("1.2.3-nightly"), "1.2");
    }
}
